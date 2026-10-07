#![cfg_attr(not(any(test, target_os = "linux")), allow(dead_code))]
use anyhow::{Result, bail};
use std::{
    net::{SocketAddr, TcpStream},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

pub fn wait_for_tcp(
    address: SocketAddr,
    timeout: Duration,
    retry: Duration,
    stop: &AtomicBool,
    mut is_alive: impl FnMut() -> Result<bool>,
) -> Result<()> {
    let deadline = Instant::now() + timeout;
    let mut last_error = None;
    while Instant::now() < deadline {
        if stop.load(Ordering::SeqCst) {
            bail!("Server startup was interrupted");
        }
        if !is_alive()? {
            bail!("Server process exited before {address} was ready");
        }
        match TcpStream::connect_timeout(
            &address,
            deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(100)),
        ) {
            Ok(_) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
        thread::sleep(retry.min(deadline.saturating_duration_since(Instant::now())));
    }
    bail!(
        "Timed out waiting for {address}: {}",
        last_error.map(|e| e.to_string()).unwrap_or_default()
    )
}

pub fn unmount_with(unmount: impl FnOnce() -> Result<()>) -> Result<()> {
    unmount()
}

pub fn unmount_and_join_with<T>(
    session: T,
    unmount: impl FnOnce() -> Result<()>,
    join: impl FnOnce(T) -> Result<()>,
) -> Result<()> {
    unmount_with(unmount)?;
    join(session)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::commands::terminate_after;
    use crate::test_support::{eventually, fixture, process_request};
    use std::{
        net::TcpListener,
        process::{Command, Stdio},
        sync::Arc,
    };

    #[test]
    fn failed_unmount_does_not_join_a_live_session() {
        let (release, blocked) = std::sync::mpsc::channel();
        let finished = Arc::new(AtomicBool::new(false));
        let completion = finished.clone();
        let session = thread::spawn(move || {
            let _ = blocked.recv_timeout(Duration::from_secs(1));
            completion.store(true, Ordering::SeqCst);
        });
        let joined = AtomicBool::new(false);
        let error = unmount_and_join_with(
            session,
            || Err(std::io::Error::other("busy mount").into()),
            |session| {
                joined.store(true, Ordering::SeqCst);
                session.join().unwrap();
                Ok(())
            },
        )
        .unwrap_err();
        assert!(!joined.load(Ordering::SeqCst));
        assert_eq!(
            error.downcast_ref::<std::io::Error>().unwrap().to_string(),
            "busy mount"
        );
        let _ = release.send(());
        eventually(|| finished.load(Ordering::SeqCst));
    }

    #[test]
    fn successful_unmount_joins_and_propagates_session_failure() {
        for failed_session in [false, true] {
            let order = std::cell::RefCell::new(Vec::new());
            let session = thread::spawn(move || {
                if failed_session {
                    panic!("native session failure");
                }
            });
            let result = unmount_and_join_with(
                session,
                || {
                    order.borrow_mut().push("unmount");
                    Ok(())
                },
                |session| {
                    order.borrow_mut().push("join");
                    session
                        .join()
                        .map_err(|_| anyhow::anyhow!("native session failure"))
                },
            );
            assert_eq!(*order.borrow(), ["unmount", "join"]);
            if failed_session {
                assert!(
                    result
                        .unwrap_err()
                        .to_string()
                        .contains("native session failure")
                );
            } else {
                result.unwrap();
            }
        }
    }
    #[test]
    fn delayed_tcp() {
        let reservation = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = reservation.local_addr().unwrap();
        drop(reservation);
        let listener = thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            let server = TcpListener::bind(address).unwrap();
            server.accept().unwrap();
        });
        let start = Instant::now();
        wait_for_tcp(
            address,
            Duration::from_secs(2),
            Duration::from_millis(10),
            &AtomicBool::new(false),
            || Ok(true),
        )
        .unwrap();
        assert!(start.elapsed() >= Duration::from_millis(40));
        listener.join().unwrap();
    }
    #[test]
    fn server_exited() {
        let start = Instant::now();
        let error = wait_for_tcp(
            "127.0.0.1:1".parse().unwrap(),
            Duration::from_secs(2),
            Duration::from_millis(10),
            &AtomicBool::new(false),
            || Ok(false),
        )
        .unwrap_err();
        assert!(error.to_string().contains("exited before"));
        assert!(start.elapsed() < Duration::from_millis(100));
    }
    #[test]
    fn unmount_error() {
        let error = unmount_with(|| Err(std::io::Error::from_raw_os_error(16).into())).unwrap_err();
        assert_eq!(
            error
                .downcast_ref::<std::io::Error>()
                .unwrap()
                .raw_os_error(),
            Some(16)
        );
    }
    fn child(ignore: bool, root: &std::path::Path) -> std::process::Child {
        let request = process_request(if ignore { "ignore" } else { "graceful" }, root);
        let mut command = Command::new(request.program);
        command
            .args(request.args)
            .envs(request.env)
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
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
        let child = command.spawn().unwrap();
        eventually(|| root.join("pid").exists());
        child
    }
    #[test]
    fn reaps_child() {
        let root = fixture("native-lifecycle-graceful-");
        let mut child = child(false, root.path());
        terminate_after(&mut child, Duration::from_secs(1)).unwrap();
        assert!(child.try_wait().unwrap().is_some());
        #[cfg(unix)]
        assert_eq!(unsafe { libc::kill(child.id() as i32, 0) }, -1);
        #[cfg(windows)]
        assert!(!crate::host::commands::process_running(child.id()));
    }
    #[test]
    #[cfg(unix)]
    fn force_kill() {
        let root = fixture("native-lifecycle-force-");
        let mut child = child(true, root.path());
        let start = Instant::now();
        terminate_after(&mut child, Duration::from_millis(50)).unwrap();
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(child.wait().unwrap().signal(), Some(libc::SIGKILL));
        assert!(start.elapsed() >= Duration::from_millis(50));
        assert_eq!(unsafe { libc::kill(child.id() as i32, 0) }, -1);
    }
}
