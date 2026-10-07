use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::Path,
    process::Stdio,
    thread,
    time::{Duration, Instant},
};

/// Subprocess output bypasses libtest's capture. Replay it from the test thread
/// after cleanup so successful tests stay quiet and failures retain diagnostics.
pub struct CapturedStderr(fs::File);

impl CapturedStderr {
    pub fn new() -> std::io::Result<Self> {
        tempfile::tempfile().map(Self)
    }

    pub fn stdio(&self) -> std::io::Result<Stdio> {
        self.0.try_clone().map(Stdio::from)
    }
}

impl Drop for CapturedStderr {
    fn drop(&mut self) {
        let mut output = Vec::new();
        match self
            .0
            .seek(SeekFrom::Start(0))
            .and_then(|_| self.0.read_to_end(&mut output))
        {
            Ok(_) => eprint!("{}", String::from_utf8_lossy(&output)),
            Err(error) => eprintln!("Could not read worker test diagnostics: {error}"),
        }
    }
}

pub fn fixture(prefix: &str) -> tempfile::TempDir {
    let root = std::env::current_dir().unwrap().join("target");
    fs::create_dir_all(&root).unwrap();
    tempfile::Builder::new()
        .prefix(prefix)
        .tempdir_in(root)
        .unwrap()
}
pub fn write(path: impl AsRef<Path>, contents: impl AsRef<[u8]>) {
    let path = path.as_ref();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}
pub fn eventually(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !condition() {
        assert!(
            Instant::now() < deadline,
            "Timed out waiting for native fixture"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

pub fn process_request(kind: &str, root: &Path) -> crate::host::commands::Request {
    let mut request = crate::host::commands::Request::new(
        std::env::current_exe().unwrap().to_str().unwrap(),
        &[
            "--exact",
            "host::tests::native_process_fixture",
            "--nocapture",
            "--test-threads=1",
        ]
        .map(String::from),
    );
    request.env = vec![
        ("SCRIPTFS_TEST_PROCESS".into(), kind.into()),
        ("SCRIPTFS_TEST_ROOT".into(), root.to_str().unwrap().into()),
    ];
    request
}

pub fn symlink(target: impl AsRef<Path>, link: impl AsRef<Path>, directory: bool) {
    #[cfg(unix)]
    {
        let _ = directory;
        std::os::unix::fs::symlink(target, link).unwrap();
    }
    #[cfg(windows)]
    {
        if directory {
            std::os::windows::fs::symlink_dir(target, link).unwrap();
        } else {
            std::os::windows::fs::symlink_file(target, link).unwrap();
        }
    }
}
