use anyhow::{Context, Result, bail};
use std::{
    io::{Read, Write},
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Default)]
pub struct Output {
    pub stdout: String,
    pub stderr: String,
}

#[derive(Clone, Debug)]
pub struct Request {
    pub program: String,
    pub args: Vec<String>,
    pub signal: Option<Arc<AtomicBool>>,
    pub timeout: Option<Duration>,
    pub inherit: bool,
    pub stderr_only: bool,
    pub input: Option<Vec<u8>>,
    pub allow_failure: bool,
    pub env: Vec<(String, String)>,
}

impl Request {
    pub fn new(program: &str, args: &[String]) -> Self {
        Self {
            program: program.into(),
            args: args.to_vec(),
            signal: None,
            timeout: Some(Duration::from_secs(60)),
            inherit: false,
            stderr_only: false,
            input: None,
            allow_failure: false,
            env: Vec::new(),
        }
    }
}

fn stderr_stdio() -> std::io::Result<Stdio> {
    #[cfg(unix)]
    {
        use std::os::fd::{FromRawFd, OwnedFd};
        let fd = unsafe { libc::dup(libc::STDERR_FILENO) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Stdio::from(unsafe { OwnedFd::from_raw_fd(fd) }))
    }
    #[cfg(windows)]
    {
        windows::stderr_stdio()
    }
}

pub trait Runner: Send + Sync {
    fn run(&self, request: Request) -> Result<Output>;
}

pub struct NativeRunner;
impl Runner for NativeRunner {
    fn run(&self, request: Request) -> Result<Output> {
        execute(&request, || {
            request
                .signal
                .as_ref()
                .is_some_and(|s| s.load(Ordering::SeqCst))
        })
    }
}

pub fn timeout_ms(value: f64) -> Result<Duration> {
    if !value.is_finite() || value.fract() != 0.0 || !(1.0..=2_147_483_647.0).contains(&value) {
        bail!("Command timeout must be an integer between 1 and 2147483647");
    }
    Ok(Duration::from_millis(value as u64))
}

pub fn execute(request: &Request, aborted: impl Fn() -> bool) -> Result<Output> {
    if aborted() {
        bail!("Command interrupted");
    }
    if let Some(timeout) = request.timeout {
        if timeout.is_zero() {
            timeout_ms(0.0)?;
        }
        timeout_ms(timeout.as_millis().max(1) as f64)?;
    }
    let mut command = Command::new(&request.program);
    command
        .args(&request.args)
        .envs(request.env.iter().cloned())
        .stdin(if request.input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(if request.inherit && request.stderr_only {
            stderr_stdio()?
        } else if request.inherit {
            Stdio::inherit()
        } else {
            Stdio::piped()
        })
        .stderr(if request.inherit {
            Stdio::inherit()
        } else {
            Stdio::piped()
        });
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }

                Ok(())
            });
        }
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("Could not run {}", request.program))?;
    #[cfg(windows)]
    let job = windows::Job::assign(&mut child)?;
    let drain_stop = Arc::new(AtomicBool::new(false));
    let stdout = reader(child.stdout.take(), drain_stop.clone());
    let stderr = reader(child.stderr.take(), drain_stop.clone());
    let input = request.input.as_ref().map(|input| {
        let input = input.clone();
        let mut stream = child.stdin.take().expect("piped stdin");
        let stop = drain_stop.clone();
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let result = (|| {
                stream.nonblocking()?;
                let mut offset = 0;
                while offset < input.len() {
                    if stop.load(Ordering::SeqCst) {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::Interrupted,
                            "Command input interrupted",
                        ));
                    }
                    match stream.write(&input[offset..]) {
                        Ok(0) => return Err(std::io::ErrorKind::WriteZero.into()),
                        Ok(count) => offset += count,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(5))
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => (),
                        Err(error) => return Err(error),
                    }
                }
                Ok(())
            })();
            let _ = sender.send(result);
        });
        receiver
    });
    let start = Instant::now();
    let mut interruption = None;
    let status = loop {
        if aborted() {
            interruption = Some("interrupted");
        } else if request
            .timeout
            .is_some_and(|timeout| start.elapsed() >= timeout)
        {
            interruption = Some("timed out");
        }
        if interruption.is_some() {
            drain_stop.store(true, Ordering::SeqCst);
            terminate(&mut child)?;
            break child.wait()?;
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        thread::sleep(Duration::from_millis(5));
    };
    // An exited process can leave inherited pipes open in grandchildren. Keep
    // draining ordinary output, but cancellation/deadlines must still apply.
    let mut bytes = [None, None];
    let mut input_result = if input.is_none() { Some(Ok(())) } else { None };
    while bytes.iter().any(Option::is_none) || input_result.is_none() {
        for (index, receiver) in [&stdout, &stderr].iter().enumerate() {
            if bytes[index].is_none() {
                match receiver.try_recv() {
                    Ok(result) => bytes[index] = Some(result?),
                    Err(mpsc::TryRecvError::Disconnected) => bail!("Command output reader failed"),
                    Err(mpsc::TryRecvError::Empty) => (),
                }
            }
        }
        if input_result.is_none() {
            match input.as_ref().unwrap().try_recv() {
                Ok(result) => input_result = Some(result),
                Err(mpsc::TryRecvError::Disconnected) => bail!("Command input writer failed"),
                Err(mpsc::TryRecvError::Empty) => (),
            }
        }
        if bytes.iter().all(Option::is_some) && input_result.is_some() {
            break;
        }
        if aborted() {
            interruption.get_or_insert("interrupted");
        }
        if request
            .timeout
            .is_some_and(|timeout| start.elapsed() >= timeout)
        {
            interruption.get_or_insert("timed out");
        }
        if interruption.is_some() {
            kill_group(child.id(), 9);
            #[cfg(windows)]
            job.terminate()?;
            drain_stop.store(true, Ordering::SeqCst);
        }
        thread::sleep(Duration::from_millis(5));
    }
    let output = Output {
        stdout: String::from_utf8_lossy(&bytes[0].take().unwrap()).into_owned(),
        stderr: String::from_utf8_lossy(&bytes[1].take().unwrap()).into_owned(),
    };
    if aborted() {
        interruption.get_or_insert("interrupted");
        kill_group(child.id(), 9);
        #[cfg(windows)]
        job.terminate()?;
    }
    // Inherited streams leave no captured output to append.
    let details = |output: String| {
        if output.is_empty() {
            output
        } else {
            format!("\n{output}")
        }
    };
    if let Some(reason) = interruption {
        bail!(
            "{} {} {reason}{}",
            request.program,
            request.args.join(" "),
            details(output.stderr)
        );
    }
    input_result.unwrap()?;
    if !status.success() && !request.allow_failure {
        bail!(
            "{} {} failed with exit code {}{}",
            request.program,
            request.args.join(" "),
            status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| status.to_string()),
            details(output.stdout + &output.stderr)
        );
    }
    Ok(output)
}

fn reader<R: Read + Send + Pipe + 'static>(
    stream: Option<R>,
    stop: Arc<AtomicBool>,
) -> mpsc::Receiver<std::io::Result<Vec<u8>>> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let result = (|| {
            let Some(mut stream) = stream else {
                return Ok(Vec::new());
            };
            stream.nonblocking()?;
            let mut bytes = Vec::new();
            let mut buffer = [0; 8192];
            loop {
                match stream.ready()? {
                    Ready::Eof => break,
                    Ready::Pending => {
                        if stop.load(Ordering::SeqCst) {
                            break;
                        }
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Ready::Data => (),
                }
                match stream.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => bytes.extend_from_slice(&buffer[..count]),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if stop.load(Ordering::SeqCst) {
                            break;
                        }
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => (),
                    Err(error) => return Err(error),
                }
            }
            Ok(bytes)
        })();
        let _ = sender.send(result);
    });
    receiver
}

trait Pipe {
    fn nonblocking(&self) -> std::io::Result<()>;
    fn ready(&self) -> std::io::Result<Ready>;
}
enum Ready {
    Data,
    #[cfg_attr(unix, allow(dead_code))]
    Pending,
    #[cfg_attr(unix, allow(dead_code))]
    Eof,
}
#[cfg(unix)]
impl<T: std::os::fd::AsRawFd> Pipe for T {
    fn nonblocking(&self) -> std::io::Result<()> {
        let fd = self.as_raw_fd();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    fn ready(&self) -> std::io::Result<Ready> {
        Ok(Ready::Data)
    }
}
#[cfg(windows)]
impl<T: std::os::windows::io::AsRawHandle> Pipe for T {
    fn nonblocking(&self) -> std::io::Result<()> {
        Ok(())
    }
    fn ready(&self) -> std::io::Result<Ready> {
        windows::pipe_ready(self.as_raw_handle())
    }
}

fn kill_group(pid: u32, signal: i32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), signal);
    }
    #[cfg(not(unix))]
    let _ = (pid, signal);
}

pub fn terminate(child: &mut Child) -> Result<()> {
    terminate_after(child, Duration::from_secs(1))
}
#[cfg(all(test, windows))]
pub fn process_running(pid: u32) -> bool {
    windows::process_running(pid)
}

pub fn terminate_after(child: &mut Child, grace: Duration) -> Result<()> {
    if child.try_wait()?.is_some() {
        return Ok(());
    }
    #[cfg(unix)]
    unsafe {
        if libc::kill(-(child.id() as i32), libc::SIGTERM) < 0
            && libc::kill(child.id() as i32, libc::SIGTERM) < 0
        {
            if child.try_wait()?.is_some() {
                return Ok(());
            }
            return Err(std::io::Error::last_os_error().into());
        }
    }
    #[cfg(windows)]
    {
        let status = Command::new("taskkill.exe")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        if !status.success() && child.try_wait()?.is_none() {
            child.kill()?;
        }
    }
    let start = Instant::now();
    while start.elapsed() < grace {
        if child.try_wait()?.is_some() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(5));
    }
    kill_group(child.id(), 9);
    if child.try_wait()?.is_none() {
        child.kill()?;
    }
    child.wait()?;
    Ok(())
}

#[cfg(windows)]
mod windows {
    use super::Ready;
    use std::{ffi::c_void, os::windows::io::AsRawHandle, process::Child};
    type Handle = *mut c_void;
    #[repr(C)]
    #[derive(Default)]
    struct BasicLimit {
        process_time: i64,
        job_time: i64,
        flags: u32,
        minimum_working_set: usize,
        maximum_working_set: usize,
        active_process_limit: u32,
        affinity: usize,
        priority: u32,
        scheduling: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimit {
        basic: BasicLimit,
        io: [u64; 6],
        process_memory: usize,
        job_memory: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            class: i32,
            info: *const c_void,
            length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn TerminateJobObject(job: Handle, code: u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
        fn GetStdHandle(kind: u32) -> Handle;
        fn GetCurrentProcess() -> Handle;
        fn DuplicateHandle(
            source_process: Handle,
            source: Handle,
            target_process: Handle,
            target: *mut Handle,
            access: u32,
            inherit: i32,
            options: u32,
        ) -> i32;
        #[cfg(test)]
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        #[cfg(test)]
        fn GetExitCodeProcess(process: Handle, code: *mut u32) -> i32;
        fn PeekNamedPipe(
            pipe: Handle,
            buffer: *mut c_void,
            size: u32,
            read: *mut u32,
            available: *mut u32,
            left: *mut u32,
        ) -> i32;
    }
    pub(super) struct Job(Handle);
    impl Job {
        pub(super) fn assign(child: &mut Child) -> std::io::Result<Self> {
            let result = (|| {
                let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
                if handle.is_null() {
                    return Err(std::io::Error::last_os_error());
                }
                let job = Self(handle);
                let mut limit = ExtendedLimit::default();
                limit.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                if unsafe {
                    SetInformationJobObject(
                        handle,
                        9,
                        &limit as *const _ as *const c_void,
                        std::mem::size_of_val(&limit) as u32,
                    )
                } == 0
                    || unsafe { AssignProcessToJobObject(handle, child.as_raw_handle()) } == 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(job)
            })();
            if result.is_err() {
                let _ = child.kill();
                let _ = child.wait();
            }
            result
        }
        pub(super) fn terminate(&self) -> std::io::Result<()> {
            if unsafe { TerminateJobObject(self.0, 1) } == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    pub(super) fn stderr_stdio() -> std::io::Result<std::process::Stdio> {
        use std::os::windows::io::{FromRawHandle, OwnedHandle};
        let process = unsafe { GetCurrentProcess() };
        let stderr = unsafe { GetStdHandle((-12_i32) as u32) };
        let mut duplicate = std::ptr::null_mut();
        if unsafe { DuplicateHandle(process, stderr, process, &mut duplicate, 0, 1, 2) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(std::process::Stdio::from(unsafe {
            OwnedHandle::from_raw_handle(duplicate)
        }))
    }
    #[cfg(test)]
    pub(super) fn process_running(pid: u32) -> bool {
        let process = unsafe { OpenProcess(0x1000, 0, pid) };
        if process.is_null() {
            return false;
        }
        let mut code = 0;
        let queried = unsafe { GetExitCodeProcess(process, &mut code) };
        unsafe {
            CloseHandle(process);
        }
        queried != 0 && code == 259
    }
    pub(super) fn pipe_ready(pipe: Handle) -> std::io::Result<Ready> {
        let mut available = 0;
        if unsafe {
            PeekNamedPipe(
                pipe,
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        } == 0
        {
            let error = std::io::Error::last_os_error();
            if matches!(error.raw_os_error(), Some(109 | 232)) {
                return Ok(Ready::Eof);
            }
            return Err(error);
        }
        Ok(if available == 0 {
            Ready::Pending
        } else {
            Ready::Data
        })
    }
}
