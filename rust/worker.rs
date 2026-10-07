use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
#[cfg(target_os = "linux")]
use std::os::fd::AsRawFd;
#[cfg(unix)]
use std::sync::{Arc, Condvar};
#[cfg(unix)]
use std::time::{Duration, Instant};
use std::{
    io::{BufReader, IoSlice, Read, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

pub struct Worker {
    io: Mutex<WorkerIo>,
    next_id: AtomicU64,
    #[cfg(unix)]
    pid: u32,
    #[cfg(unix)]
    watchdog: Option<Watchdog>,
    #[cfg(test)]
    _stderr: crate::test_support::CapturedStderr,
}
struct WorkerIo {
    child: Child,
    input: Option<ChildStdin>,
    output: BufReader<ChildStdout>,
    /// Set once a frame boundary is lost. Every later call fails instead of
    /// pairing a request with whatever bytes happen to arrive next.
    desynchronized: bool,
}

/// Marks an error whose frame was still consumed in full, so the stream stays
/// aligned and the worker can keep serving later requests.
#[derive(Debug)]
struct Resynchronized;
impl std::fmt::Display for Resynchronized {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("provider response was discarded")
    }
}
impl std::error::Error for Resynchronized {}
pub struct Response {
    pub value: Value,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub resource: Option<u64>,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub body: Vec<u8>,
}
#[derive(serde::Serialize)]
struct MetadataBatch<'a> {
    op: &'static str,
    id: u64,
    requests: &'a [Value],
    #[serde(rename = "bodyLength")]
    body_length: usize,
}
#[derive(Debug)]
pub struct ProviderError {
    pub message: String,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub code: Option<String>,
}
impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for ProviderError {}

impl Worker {
    pub fn start() -> Result<Self> {
        Self::start_with(
            #[cfg(unix)]
            provider_timeout()?,
        )
    }

    fn start_with(#[cfg(unix)] timeout: Option<Duration>) -> Result<Self> {
        let root = match std::env::var_os("SCRIPTFS_JS_ROOT") {
            Some(root) => std::path::PathBuf::from(root),
            None => crate::host::package_root()?,
        };
        #[cfg(test)]
        let captured_stderr = crate::test_support::CapturedStderr::new()?;
        #[cfg(test)]
        let stderr = captured_stderr.stdio()?;
        #[cfg(not(test))]
        let stderr = Stdio::inherit();
        let mut child =
            Command::new(std::env::var_os("SCRIPTFS_NODE").unwrap_or_else(|| "node".into()))
                .env("SCRIPTFS_JS_ROOT", root)
                .args(["--input-type=module", "-e", include_str!("worker.mjs")])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(stderr)
                .spawn()
                .context(
                    "Could not start the JavaScript module worker (Node.js 22+ is required)",
                )?;
        let input = child.stdin.take().context("Provider stdin unavailable")?;
        let output = BufReader::new(child.stdout.take().context("Provider stdout unavailable")?);
        #[cfg(unix)]
        let pid = child.id();
        let worker = Self {
            next_id: AtomicU64::new(1),
            #[cfg(unix)]
            pid,
            #[cfg(unix)]
            watchdog: timeout.map(|timeout| Watchdog::start(pid, timeout)),
            io: Mutex::new(WorkerIo {
                child,
                input: Some(input),
                output,
                desynchronized: false,
            }),
            #[cfg(test)]
            _stderr: captured_stderr,
        };
        #[cfg(target_os = "linux")]
        {
            let io = worker
                .io
                .lock()
                .map_err(|_| anyhow::anyhow!("Module worker lock poisoned"))?;
            Self::reserve_pipe(
                io.input.as_ref().context("Provider stdin unavailable")?,
                "request",
            )?;
            Self::reserve_pipe(io.output.get_ref(), "response")?;
        }
        Ok(worker)
    }

    #[cfg(target_os = "linux")]
    fn reserve_pipe(pipe: &impl AsRawFd, direction: &str) -> Result<()> {
        const CAPACITY: i32 = 1024 * 1024;
        let current = unsafe { libc::fcntl(pipe.as_raw_fd(), libc::F_GETPIPE_SZ) };
        if current < 0 {
            return Err(std::io::Error::last_os_error()).context("Could not inspect provider pipe");
        }
        if current < CAPACITY
            && unsafe { libc::fcntl(pipe.as_raw_fd(), libc::F_SETPIPE_SZ, CAPACITY) } < 0
        {
            let error = std::io::Error::last_os_error();
            if matches!(error.raw_os_error(), Some(libc::EPERM) | Some(libc::EINVAL)) {
                eprintln!(
                    "JavaScript module worker {direction} pipe remains at {current} bytes: could not reserve {CAPACITY} bytes ({error})"
                );
            } else {
                return Err(error).context("Could not reserve provider pipe capacity");
            }
        }
        Ok(())
    }

    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    #[cfg(unix)]
    pub fn abort(&self) -> Result<()> {
        if unsafe { libc::kill(self.pid as i32, libc::SIGTERM) } < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error.into());
            }
        }
        Ok(())
    }

    /// Marks a provider call as in flight for the optional watchdog, which
    /// cancels and finally kills a worker that never answers.
    #[cfg(unix)]
    fn watch(&self) -> Pending<'_> {
        if let Some(watchdog) = &self.watchdog {
            watchdog.begin();
        }
        Pending(self.watchdog.as_ref())
    }
    fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn request(&self, header: Value, body: &[u8]) -> Result<Response> {
        let id = self.next_id();
        let mut io = self
            .io
            .lock()
            .map_err(|_| anyhow::anyhow!("Module worker lock poisoned"))?;
        #[cfg(unix)]
        let _pending = self.watch();
        io.send(id, header, body)?;
        io.receive(id)
    }

    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub fn metadata_batch(&self, headers: Vec<Value>) -> Result<Vec<Result<Response>>> {
        for header in &headers {
            if header["op"] != "getattr" {
                bail!("Metadata batch contains a non-getattr request");
            }
        }
        if headers.is_empty() {
            return Ok(Vec::new());
        }
        let id = self.next_id();
        let encoded = serde_json::to_vec(&MetadataBatch {
            op: "metadataBatch",
            id,
            requests: &headers,
            body_length: 0,
        })?;
        if encoded.len() > 1024 * 1024 {
            let mut responses = Vec::with_capacity(headers.len());
            for header in headers {
                responses.push(match self.request(header, &[]) {
                    Ok(response) => Ok(response),
                    Err(error) if error.downcast_ref::<ProviderError>().is_some() => Err(error),
                    Err(error) => return Err(error),
                });
            }
            return Ok(responses);
        }
        let mut io = self
            .io
            .lock()
            .map_err(|_| anyhow::anyhow!("Module worker lock poisoned"))?;
        #[cfg(unix)]
        let _pending = self.watch();
        let count = headers.len();
        io.send_encoded(&encoded, &[])?;
        let mut responses = Vec::with_capacity(count);
        while responses.len() < count {
            let response = io.receive(id)?;
            let Value::Array(values) = response.value else {
                // Frames for the rest of the batch are still queued, and this
                // call cannot tell how many, so refuse to reuse the stream.
                io.desynchronized = true;
                bail!("Invalid metadata batch response");
            };
            if values.is_empty()
                || values.len() > count - responses.len()
                || !response.body.is_empty()
            {
                io.desynchronized = true;
                bail!("Invalid metadata batch response count or body");
            }
            for mut value in values {
                // Drain callback errors too, so later calls cannot receive stale frames.
                responses.push(if let Some(error) = value.get("error") {
                    Err(ProviderError::from_value(error).into())
                } else {
                    Ok(Response {
                        value: value
                            .get_mut("value")
                            .map(Value::take)
                            .unwrap_or(Value::Null),
                        resource: None,
                        body: Vec::new(),
                    })
                });
            }
        }
        Ok(responses)
    }
}

/// Reads the optional provider watchdog budget. ScriptFS waits indefinitely by
/// default so that slow acquisitions keep their handles; setting this variable
/// trades that guarantee for a bound on how long a stuck provider can block a
/// mount.
#[cfg(unix)]
fn provider_timeout() -> Result<Option<Duration>> {
    let Some(value) = std::env::var_os("SCRIPTFS_PROVIDER_TIMEOUT") else {
        return Ok(None);
    };
    provider_timeout_value(Some(
        value
            .to_str()
            .context("SCRIPTFS_PROVIDER_TIMEOUT must be valid UTF-8")?,
    ))
}

#[cfg(unix)]
fn provider_timeout_value(value: Option<&str>) -> Result<Option<Duration>> {
    let Some(text) = value.map(str::trim) else {
        return Ok(None);
    };
    let seconds: f64 = text
        .parse()
        .with_context(|| format!("Invalid SCRIPTFS_PROVIDER_TIMEOUT value: {text}"))?;
    if !seconds.is_finite() || seconds < 0.0 {
        bail!("SCRIPTFS_PROVIDER_TIMEOUT must be a non-negative number of seconds");
    }
    Ok((seconds > 0.0).then(|| Duration::from_secs_f64(seconds)))
}

#[cfg(unix)]
struct Watchdog {
    state: Arc<(Mutex<WatchState>, Condvar)>,
    thread: Option<std::thread::JoinHandle<()>>,
}
#[cfg(unix)]
#[derive(Default)]
struct WatchState {
    started: Option<Instant>,
    /// Changes on every transition, so an escalation can never be attributed
    /// to a later call that happens to start at the same instant.
    generation: u64,
    stopped: bool,
}
#[cfg(unix)]
struct Pending<'a>(Option<&'a Watchdog>);
#[cfg(unix)]
impl Drop for Pending<'_> {
    fn drop(&mut self) {
        if let Some(watchdog) = self.0 {
            watchdog.update(None);
        }
    }
}

#[cfg(unix)]
impl Watchdog {
    /// Cancellation is cooperative first: the worker turns `SIGTERM` into an
    /// abort signal for in-flight module callbacks. A module that ignores
    /// it is killed afterwards so the mount fails instead of hanging forever.
    const GRACE: Duration = Duration::from_secs(5);

    fn start(pid: u32, timeout: Duration) -> Self {
        let state = Arc::new((Mutex::new(WatchState::default()), Condvar::new()));
        let watched = Arc::clone(&state);
        // A short budget deserves an equally short grace period, so the escape
        // hatch stays responsive instead of adding a fixed five second stall.
        let grace = Self::GRACE.min(timeout);
        let thread = std::thread::Builder::new()
            .name("scriptfs-provider-watchdog".into())
            .spawn(move || Self::watch(pid, timeout, grace, &watched))
            .ok();
        Self { state, thread }
    }

    fn begin(&self) {
        self.update(Some(Instant::now()));
    }

    fn update(&self, started: Option<Instant>) {
        let (state, signal) = &*self.state;
        let mut state = state.lock().unwrap_or_else(|error| error.into_inner());
        state.started = started;
        state.generation = state.generation.wrapping_add(1);
        signal.notify_all();
    }

    fn signal(pid: u32, number: i32) {
        if unsafe { libc::kill(pid as i32, number) } < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                eprintln!("Could not signal the JavaScript module worker: {error}");
            }
        }
    }

    fn watch(pid: u32, timeout: Duration, grace: Duration, state: &(Mutex<WatchState>, Condvar)) {
        let (lock, signal) = state;
        let mut guard = lock.lock().unwrap_or_else(|error| error.into_inner());
        let (mut aborted, mut killed) = (None, None);
        loop {
            if guard.stopped {
                return;
            }
            let Some(started) = guard.started else {
                guard = signal
                    .wait(guard)
                    .unwrap_or_else(|error| error.into_inner());
                continue;
            };
            let generation = guard.generation;
            let elapsed = started.elapsed();
            let remaining = if elapsed < timeout {
                timeout - elapsed
            } else if aborted != Some(generation) {
                aborted = Some(generation);
                drop(guard);
                eprintln!(
                    "Module callback exceeded {:.3}s: cancelling",
                    timeout.as_secs_f64()
                );
                Self::signal(pid, libc::SIGTERM);
                guard = lock.lock().unwrap_or_else(|error| error.into_inner());
                continue;
            } else if elapsed < timeout + grace {
                timeout + grace - elapsed
            } else if killed != Some(generation) {
                killed = Some(generation);
                drop(guard);
                eprintln!(
                    "Module callback ignored cancellation for {:.3}s: stopping the worker",
                    grace.as_secs_f64()
                );
                Self::signal(pid, libc::SIGKILL);
                guard = lock.lock().unwrap_or_else(|error| error.into_inner());
                continue;
            } else {
                guard = signal
                    .wait(guard)
                    .unwrap_or_else(|error| error.into_inner());
                continue;
            };
            guard = signal
                .wait_timeout(guard, remaining)
                .unwrap_or_else(|error| error.into_inner())
                .0;
        }
    }
}

#[cfg(unix)]
impl Drop for Watchdog {
    fn drop(&mut self) {
        {
            let (state, signal) = &*self.state;
            let mut state = state.lock().unwrap_or_else(|error| error.into_inner());
            state.stopped = true;
            signal.notify_all();
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl WorkerIo {
    fn check(&self) -> Result<()> {
        if self.desynchronized {
            bail!("JavaScript module worker protocol desynchronized");
        }
        Ok(())
    }

    fn send(&mut self, id: u64, mut header: Value, body: &[u8]) -> Result<()> {
        header["id"] = json!(id);
        header["bodyLength"] = json!(body.len());
        let header = serde_json::to_vec(&header)?;
        self.send_encoded(&header, body)
    }

    fn send_encoded(&mut self, header: &[u8], body: &[u8]) -> Result<()> {
        self.check()?;
        let result = (|| {
            let input = self.input.as_mut().context("Module worker is stopped")?;
            let size = u32::try_from(header.len())?.to_le_bytes();
            Self::write_frame(input, &size, header, body)?;
            input.flush()?;
            Ok(())
        })();
        if result.is_err() {
            // A partially written request leaves the worker waiting on bytes
            // that will never arrive.
            self.desynchronized = true;
        }
        result
    }

    fn write_frame(
        output: &mut impl Write,
        size: &[u8],
        header: &[u8],
        body: &[u8],
    ) -> std::io::Result<()> {
        let mut buffers = &mut [IoSlice::new(size), IoSlice::new(header), IoSlice::new(body)][..];
        while buffers.iter().any(|buffer| !buffer.is_empty()) {
            match output.write_vectored(buffers) {
                Ok(0) => return Err(std::io::ErrorKind::WriteZero.into()),
                Ok(written) => IoSlice::advance_slices(&mut buffers, written),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    /// Reads one frame, always consuming it in full. Any failure that leaves
    /// unread bytes behind marks the stream unusable rather than letting the
    /// next request adopt them.
    fn read_frame(&mut self) -> Result<(Value, Vec<u8>)> {
        self.check()?;
        match self.read_frame_inner() {
            Ok(frame) => Ok(frame),
            Err(error) => {
                if error.downcast_ref::<Resynchronized>().is_none() {
                    self.desynchronized = true;
                }
                Err(error)
            }
        }
    }

    fn read_frame_inner(&mut self) -> Result<(Value, Vec<u8>)> {
        let mut length = [0; 4];
        self.output
            .read_exact(&mut length)
            .context("JavaScript module worker exited or broke the protocol")?;
        let length = u32::from_le_bytes(length) as usize;
        if length > 16 * 1024 * 1024 {
            bail!("Provider response header is too large");
        }
        let mut bytes = vec![0; length];
        self.output.read_exact(&mut bytes)?;
        // The body length is only known once the header parses, so a malformed
        // header is unrecoverable by construction.
        let response: Value = serde_json::from_slice(&bytes)?;
        let body_len = usize::try_from(
            response["bodyLength"]
                .as_u64()
                .context("Invalid provider body length")?,
        )?;
        let mut body = Vec::new();
        if body_len != 0 && body.try_reserve_exact(body_len).is_err() {
            // The frame is known, so discard it and keep the worker usable.
            std::io::copy(
                &mut Read::by_ref(&mut self.output).take(body_len as u64),
                &mut std::io::sink(),
            )?;
            return Err(anyhow::Error::new(Resynchronized)
                .context("Could not allocate a provider response body"));
        }
        body.resize(body_len, 0);
        self.output.read_exact(&mut body)?;
        Ok((response, body))
    }

    fn receive(&mut self, id: u64) -> Result<Response> {
        loop {
            let (mut response, body) = self.read_frame()?;
            if let Some(event) = response.get("event") {
                if event != "stdout" {
                    self.desynchronized = true;
                    bail!("Invalid provider event: {event}");
                }
                #[cfg(test)]
                print!("{}", String::from_utf8_lossy(&body));
                #[cfg(not(test))]
                std::io::stdout().lock().write_all(&body)?;
                continue;
            }
            if response["id"].as_u64() != Some(id) {
                self.desynchronized = true;
                bail!("Provider response does not answer the pending request");
            }
            if let Some(error) = response.get("error") {
                return Err(ProviderError::from_value(error).into());
            }
            return Ok(Response {
                value: response
                    .get_mut("value")
                    .map(Value::take)
                    .unwrap_or(Value::Null),
                resource: response
                    .get("resource")
                    .map(|value| {
                        value
                            .as_u64()
                            .filter(|id| *id != 0)
                            .context("Invalid provider resource identity")
                    })
                    .transpose()?,
                body,
            });
        }
    }
}

impl ProviderError {
    fn from_value(value: &Value) -> Self {
        Self {
            message: value["message"]
                .as_str()
                .unwrap_or("Provider operation failed")
                .into(),
            code: value["code"].as_str().map(String::from),
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        // Join the watchdog first: once the child is reaped its identifier can
        // be reused, and a late signal must never reach an unrelated process.
        #[cfg(unix)]
        drop(self.watchdog.take());
        if let Ok(io) = self.io.get_mut() {
            io.input.take();
            for _ in 0..50 {
                match io.child.try_wait() {
                    Ok(Some(_)) => return,
                    Ok(None) => std::thread::sleep(std::time::Duration::from_millis(10)),
                    Err(error) => {
                        eprintln!("Module worker cleanup failed: {error}");
                        break;
                    }
                }
            }
            if let Err(error) = io.child.kill() {
                eprintln!("Module worker termination failed: {error}");
            }
            if let Err(error) = io.child.wait() {
                eprintln!("Module worker reap failed: {error}");
            }
        }
    }
}

#[cfg(all(test, unix))]
#[path = "worker_tests.rs"]
mod tests;
