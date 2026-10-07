use super::*;
use crate::test_support::{eventually, fixture, write};
use std::collections::VecDeque;
use std::process::{Child, Command, Stdio};

type Outcome = std::result::Result<String, String>;
#[derive(Clone)]
enum Action {
    Output(String),
    Error(String),
    Cancel(Arc<AtomicBool>, String),
    Stall,
}
struct Override {
    key: String,
    action: Action,
    remaining: Option<usize>,
}
#[derive(Default)]
struct Mock {
    calls: Mutex<Vec<Request>>,
    overrides: Mutex<Vec<Override>>,
    exit: Mutex<Option<Outcome>>,
    config_path: Mutex<Option<PathBuf>>,
}
fn operation(request: &Request) -> &str {
    if request.program == "podman" {
        request.args.first().map(String::as_str).unwrap_or("")
    } else if ["npm", "cmd.exe"].contains(&request.program.as_str()) {
        "registry"
    } else if ["/sbin/mount_smbfs", "mount", "powershell.exe"].contains(&request.program.as_str()) {
        "mount"
    } else if ["/sbin/umount", "umount", "net"].contains(&request.program.as_str()) {
        "unmount"
    } else {
        &request.program
    }
}
impl Mock {
    fn action(&self, key: &str, action: Action, count: Option<usize>) {
        self.overrides.lock().unwrap().push(Override {
            key: key.into(),
            action,
            remaining: count,
        });
    }
    fn fail_once(&self, key: &str, error: &str) {
        self.action(key, Action::Error(error.into()), Some(1));
    }
    fn output(&self, key: &str, output: &str) {
        self.action(key, Action::Output(output.into()), None);
    }
    fn calls(&self, key: &str) -> Vec<Request> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|r| operation(r) == key)
            .cloned()
            .collect()
    }
    fn path(&self) -> PathBuf {
        self.config_path
            .lock()
            .unwrap()
            .clone()
            .expect("runtime config path")
    }
    fn created(&self) -> Vec<String> {
        self.calls("create")[0].args.clone()
    }
    fn runtime(&self) -> Value {
        serde_json::from_slice(&fs::read(self.path()).unwrap()).unwrap()
    }
}
impl Runner for Mock {
    fn run(&self, request: Request) -> Result<Output> {
        if let Some(signal) = &request.signal {
            cancelled(signal)?;
        }
        let key = operation(&request).to_string();
        self.calls.lock().unwrap().push(request.clone());
        if key == "create" {
            let config_mount = request
                .args
                .iter()
                .find(|arg| arg.ends_with(":/scriptfs/config.json:ro"))
                .expect("configuration volume");
            let path = PathBuf::from(
                config_mount
                    .strip_suffix(":/scriptfs/config.json:ro")
                    .unwrap(),
            );
            assert!(path.is_file());
            *self.config_path.lock().unwrap() = Some(path);
        }
        let action = {
            let mut overrides = self.overrides.lock().unwrap();
            overrides
                .iter_mut()
                .find(|rule| rule.key == key && rule.remaining != Some(0))
                .map(|rule| {
                    if let Some(remaining) = &mut rule.remaining {
                        *remaining -= 1;
                    }
                    rule.action.clone()
                })
        };
        if let Some(action) = action {
            match action {
                Action::Output(stdout) => {
                    return Ok(Output {
                        stdout,
                        stderr: String::new(),
                    });
                }
                Action::Error(error) => bail!("{error}"),
                Action::Cancel(signal, stdout) => {
                    signal.store(true, Ordering::SeqCst);
                    return Ok(Output {
                        stdout,
                        stderr: String::new(),
                    });
                }
                Action::Stall => {
                    let signal = request
                        .signal
                        .as_ref()
                        .expect("stalled command must be cancellable");
                    while !signal.load(Ordering::SeqCst) {
                        thread::sleep(Duration::from_millis(2));
                    }
                    bail!("Command interrupted");
                }
            }
        }
        let stdout = match key.as_str() {
            "--version" => "podman version 5.8.3\n",
            "machine" => r#"[{"Name":"my-vm","Running":true,"Default":true}]"#,
            "info" => "linux\n",
            "image" => "exists\n",
            "create" => "test-container\n",
            "inspect" => "running\n",
            "exec" => "ready 1791377608.085646000\n",
            "port" => "127.0.0.1:14445\n",
            "registry" => "https://registry.example.invalid/\n",
            "wait" => {
                let signal = request.signal.as_ref().expect("monitor cancellation");
                assert!(request.timeout.is_none());
                loop {
                    if signal.load(Ordering::SeqCst) {
                        bail!("Monitor interrupted");
                    }
                    if let Some(result) = self.exit.lock().unwrap().clone() {
                        return result
                            .map(|stdout| Output {
                                stdout,
                                stderr: String::new(),
                            })
                            .map_err(anyhow::Error::msg);
                    }
                    thread::sleep(Duration::from_millis(2));
                }
            }
            "stop" => {
                *self.exit.lock().unwrap() = Some(Ok("0\n".into()));
                ""
            }
            "start" => {
                *self.exit.lock().unwrap() = None;
                ""
            }
            "rm" | "logs" | "build" | "pull" | "mount" | "unmount" | "run" => "",
            _ => panic!("Unexpected command {} {:?}", request.program, request.args),
        };
        Ok(Output {
            stdout: stdout.into(),
            stderr: String::new(),
        })
    }
}
struct Fixture {
    root: tempfile::TempDir,
    input: Value,
    mock: Arc<Mock>,
    stop: Arc<AtomicBool>,
}
impl Fixture {
    fn new() -> Self {
        let root = fixture("native-host-");
        write(root.path().join("package.json"), "{}");
        write(
            root.path().join("container/Containerfile"),
            "FROM scratch\n",
        );
        write(root.path().join("packages/module/dist/index.js"), "");
        let input = json!({"filesystems":[{"name":"test","source":root.path(),"mountPoint":root.path().join("mount")}],"container":{"logLevel":"silent"}});
        Self {
            root,
            input,
            mock: Arc::new(Mock::default()),
            stop: Arc::new(AtomicBool::new(false)),
        }
    }
    fn settings(&self, platform: Platform) -> StartSettings {
        StartSettings {
            platform,
            base: self.root.path().to_path_buf(),
            state_root: self.root.path().to_path_buf(),
            readiness_timeout: Duration::from_secs(2),
            readiness_retry: Duration::from_millis(5),
            distribution_root: Some(self.root.path().to_path_buf()),
            protocol: false,
            cache_root: Some(self.root.path().join("cache")),
        }
    }
    /// Writes a module manifest (plus its entry) under `directory` and declares
    /// an instance of it in the session input.
    fn module(
        &mut self,
        instance: &str,
        directory: &str,
        manifest: Value,
        config: Value,
    ) -> PathBuf {
        let directory = self.root.path().join(directory);
        let mut manifest = manifest;
        manifest["name"] = json!(instance);
        manifest["entry"] = json!("index.mjs");
        write(
            directory.join(module::MANIFEST_FILE),
            serde_json::to_vec(&manifest).unwrap(),
        );
        write(directory.join("index.mjs"), "export default {}");
        let mut config = config;
        config["manifest"] = json!(directory);
        self.input["modules"][instance] = config;
        directory
    }
    /// Marks the distribution as a published package pinned to `image`.
    fn release(&self, image: &str) {
        write(
            self.root.path().join(RELEASE_IMAGE_FILE),
            serde_json::to_vec(&json!({"image": image, "version": "0.0.2"})).unwrap(),
        );
    }
    fn start(&self) -> Session {
        self.start_on(Platform::Linux)
    }
    fn start_on(&self, platform: Platform) -> Session {
        start_session(
            &self.input,
            self.stop.clone(),
            self.mock.clone(),
            self.settings(platform),
        )
        .unwrap_or_else(|e| panic!("Startup failed: {:?}", e.errors))
    }
    fn failure(&self) -> StartupFailure {
        match start_session(
            &self.input,
            self.stop.clone(),
            self.mock.clone(),
            self.settings(Platform::Linux),
        ) {
            Err(failure) => failure,
            Ok(mut session) => {
                session.stop().unwrap();
                panic!("Expected startup failure");
            }
        }
    }
}
fn cleanup_error(message: &str, accepted: bool) {
    let fixture = Fixture::new();
    let mut session = fixture.start();
    fixture.mock.fail_once("unmount", message);
    let result = session.stop();
    if accepted {
        result.unwrap();
        assert_eq!(session.mounts(), json!([]));
        assert_eq!(fixture.mock.calls("rm").len(), 1);
        assert!(!fixture.mock.path().exists());
    } else {
        assert!(result.unwrap_err().to_string().contains(message));
        assert_eq!(session.mounts().as_array().unwrap().len(), 1);
        assert!(fixture.mock.calls("stop").is_empty());
        assert!(fixture.mock.calls("rm").is_empty());
        assert!(fixture.mock.path().is_file());
        session.stop().unwrap();
        assert_eq!(session.mounts(), json!([]));
    }
}
#[test]
fn busy_unmount_retry() {
    let fixture = Fixture::new();
    let mut session = fixture.start();
    fixture.mock.fail_once("unmount", "Resource busy");
    assert!(
        session
            .stop()
            .unwrap_err()
            .to_string()
            .contains("Resource busy")
    );
    assert!(fixture.mock.calls("stop").is_empty());
    assert!(fixture.mock.path().is_file());
    session.stop().unwrap();
    assert_eq!(fixture.mock.calls("unmount").len(), 2);
    assert!(!fixture.mock.path().exists());
    let count = fixture.mock.calls.lock().unwrap().len();
    session.stop().unwrap();
    assert_eq!(fixture.mock.calls.lock().unwrap().len(), count);
}
#[test]
fn already_unmounted() {
    cleanup_error("umount: mount: not mounted", true);
}
#[test]
fn not_currently_mounted() {
    cleanup_error("umount: mount: not currently mounted", true);
}
#[test]
fn missing_network_connection() {
    cleanup_error("The network connection could not be found.", true);
}
#[test]
fn network_2250() {
    cleanup_error("System error 2250 has occurred.", true);
}
#[test]
fn network_help_2250() {
    cleanup_error(
        "The network connection could not be found.\r\n\r\nMore help is available by typing NET HELPMSG 2250.\r\n",
        true,
    );
}
#[test]
fn busy_not_mounted_path() {
    cleanup_error(
        "/sbin/umount /tmp/not mounted/mount failed with exit code 1\numount: /tmp/not mounted/mount: Resource busy",
        false,
    );
}
#[test]
fn busy_not_currently_mounted_path() {
    cleanup_error("umount: /tmp/not currently mounted: target is busy.", false);
}
#[test]
fn busy_network_connection_path() {
    cleanup_error(
        "umount: /tmp/network connection could not be found: Resource busy",
        false,
    );
}
#[test]
fn busy_2250_path() {
    cleanup_error("umount: /tmp/system error 2250: Resource busy", false);
}
#[test]
fn busy_multiline_not_mounted_path() {
    cleanup_error("umount: /tmp/\nnot mounted\n/mount: Resource busy", false);
}
#[test]
fn busy_multiline_network_path() {
    cleanup_error(
        "umount: /tmp/\nThe network connection could not be found.\n/mount: Resource busy",
        false,
    );
}
#[test]
fn removal_retry() {
    let fixture = Fixture::new();
    let mut session = fixture.start();
    fixture.mock.fail_once("rm", "remove failed");
    assert!(
        session
            .stop()
            .unwrap_err()
            .to_string()
            .contains("remove failed")
    );
    assert!(fixture.mock.path().is_file());
    session.stop().unwrap();
    assert_eq!(fixture.mock.calls("unmount").len(), 1);
    assert_eq!(fixture.mock.calls("rm").len(), 2);
    assert_eq!(fixture.mock.calls("stop").len(), 1);
    assert!(!fixture.mock.path().exists());
}
#[test]
fn already_cancelled() {
    let fixture = Fixture::new();
    fixture.stop.store(true, Ordering::SeqCst);
    assert!(fixture.failure().errors[0].contains("interrupted"));
    assert!(fixture.mock.calls.lock().unwrap().is_empty());
}
#[test]
fn file_proxy_symlink() {
    let mut fixture = Fixture::new();
    write(fixture.root.path().join("target"), "target");
    crate::test_support::symlink("target", fixture.root.path().join("alias"), false);
    fixture.input["filesystems"][0]["rules"] = json!([{"match":"Proxy","provider":{"type":"file","path":fixture.root.path().join("alias")}}]);
    assert!(fixture.failure().errors[0].contains("a regular file, not a symbolic link"));
    assert!(fixture.mock.calls.lock().unwrap().is_empty());
}
fn failed_start(fail_removal: bool) {
    let fixture = Fixture::new();
    fixture.mock.fail_once("start", "SMB port already in use");
    if fail_removal {
        fixture.mock.fail_once("rm", "remove failed");
    }
    let mut failure = fixture.failure();
    assert!(failure.errors[0].contains("SMB port already in use"));
    assert_eq!(
        fixture.mock.calls("start")[0].args,
        ["start", "test-container"]
    );
    assert_eq!(
        fixture.mock.calls("rm")[0].args,
        ["rm", "--ignore", "--force", "test-container"]
    );
    assert!(fixture.mock.calls("wait").is_empty());
    assert!(fixture.mock.calls("mount").is_empty());
    let frame = failure.frame("startup");
    assert_eq!(frame["startupError"], fail_removal);
    assert_eq!(
        frame["errors"].as_array().unwrap().len(),
        if fail_removal { 2 } else { 1 }
    );
    let session = failure.session.as_mut().unwrap();
    assert_eq!(session.container_id, "test-container");
    assert_eq!(session.mounts(), json!([]));
    assert_eq!(session.retryable(), fail_removal);
    assert_eq!(fixture.mock.path().exists(), fail_removal);
    if fail_removal {
        assert!(failure.errors.iter().any(|e| e.contains("remove failed")));
        session.stop().unwrap();
    }
    assert!(!fixture.mock.path().exists());
}
#[test]
fn failed_start_clean_rollback() {
    failed_start(false);
}
#[test]
fn failed_start_retry_removal() {
    failed_start(true);
}
#[test]
fn cancel_after_create() {
    let fixture = Fixture::new();
    fixture.mock.action(
        "create",
        Action::Cancel(fixture.stop.clone(), "test-container\n".into()),
        Some(1),
    );
    let failure = fixture.failure();
    assert!(failure.errors[0].contains("interrupted"));
    assert!(fixture.mock.calls("start").is_empty());
    assert_eq!(
        fixture.mock.calls("rm")[0].args,
        ["rm", "--ignore", "--force", "test-container"]
    );
    assert!(fixture.mock.calls("mount").is_empty());
    assert!(!fixture.mock.path().exists());
}
#[test]
fn case_insensitive_names() {
    let mut fixture = Fixture::new();
    fixture.input["filesystems"] = json!([
        {"name":"Work","source":fixture.root.path(),"mountPoint":fixture.root.path().join("upper")},
        {"name":"work","source":fixture.root.path(),"mountPoint":fixture.root.path().join("lower")}]);
    assert!(fixture.failure().errors[0].contains("unique name"));
    assert!(fixture.mock.calls.lock().unwrap().is_empty());
}
fn unsafe_name(name: &str) {
    let mut fixture = Fixture::new();
    fixture.input["filesystems"][0]["name"] = json!(name);
    assert!(fixture.failure().errors[0].contains("Invalid filesystem name"));
    assert!(fixture.mock.calls.lock().unwrap().is_empty());
}
#[test]
fn share_injection() {
    unsafe_name("bad\n[extra]");
}
#[test]
fn share_space() {
    unsafe_name("bad name");
}
#[test]
fn share_slash() {
    unsafe_name("bad/path");
}
#[test]
fn share_global() {
    unsafe_name("global");
}
#[test]
fn share_upper_global() {
    unsafe_name("GLOBAL");
}
#[test]
fn share_homes() {
    unsafe_name("Homes");
}
#[test]
fn share_printers() {
    unsafe_name("pRiNtErS");
}
#[test]
fn last_mount_cancel() {
    let fixture = Fixture::new();
    fixture.mock.action(
        "mount",
        Action::Cancel(fixture.stop.clone(), String::new()),
        Some(1),
    );
    assert!(fixture.failure().errors[0].contains("interrupted"));
    assert_eq!(fixture.mock.calls("unmount").len(), 1);
    assert_eq!(fixture.mock.calls("rm").len(), 1);
    assert!(!fixture.mock.path().exists());
}
#[test]
fn signal_session_cleanup() {
    let fixture = Fixture::new();
    let mut session = fixture.start();
    fixture.stop.store(true, Ordering::SeqCst);
    wait_session(&session, &fixture.stop).unwrap();
    session.stop().unwrap();
    assert_eq!(fixture.mock.calls("unmount").len(), 1);
    assert!(!fixture.mock.path().exists());
    assert!(fixture.mock.calls("stop")[0].signal.is_none());
}
#[test]
fn unexpected_container_exit() {
    let fixture = Fixture::new();
    let mut session = fixture.start();
    *fixture.mock.exit.lock().unwrap() = Some(Ok("137\n".into()));
    eventually(|| session.exit_error().is_some());
    assert_eq!(
        session.exit_error().as_deref(),
        Some("scriptfs container test-container exited with status 137")
    );
    assert!(
        wait_session(&session, &fixture.stop)
            .unwrap_err()
            .to_string()
            .contains("status 137")
    );
    session.stop().unwrap();
}
#[test]
fn startup_and_logs_failure() {
    let fixture = Fixture::new();
    fixture.mock.output("inspect", "exited");
    fixture.mock.fail_once("logs", "logs failed");
    let failure = fixture.failure();
    assert!(failure.errors[0].contains("container stopped during startup"));
    assert!(failure.errors[1].contains("logs failed"));
    let logs = &fixture.mock.calls("logs")[0];
    assert_eq!(logs.args, ["logs", "--tail", "1000", "test-container"]);
    assert!(logs.allow_failure);
    assert_eq!(logs.timeout, Some(Duration::from_secs(10)));
    assert!(logs.signal.is_none());
    assert_eq!(fixture.mock.calls("rm").len(), 1);
}
#[test]
fn busy_startup_rollback_session() {
    let mut fixture = Fixture::new();
    fixture.input["filesystems"].as_array_mut().unwrap().push(json!({"name":"second","source":fixture.root.path(),"mountPoint":fixture.root.path().join("second")}));
    fixture
        .mock
        .action("mount", Action::Output(String::new()), Some(1));
    fixture.mock.fail_once("mount", "second mount failed");
    fixture.mock.fail_once("unmount", "Resource busy");
    let mut failure = fixture.failure();
    assert!(failure.errors[0].contains("second mount failed"));
    assert!(failure.errors[1].contains("Resource busy"));
    let session = failure.session.as_mut().unwrap();
    assert_eq!(session.mounts().as_array().unwrap().len(), 1);
    assert!(session.retryable());
    assert!(fixture.mock.calls("stop").is_empty());
    session.stop().unwrap();
    assert_eq!(session.mounts(), json!([]));
    assert!(!fixture.mock.path().exists());
}
#[test]
fn installed_module_package() {
    let mut fixture = Fixture::new();
    let root = fixture.root.path().to_path_buf();
    fixture.module("provider", "node_modules/provider", json!({}), json!({}));
    fixture.input["modules"]["provider"]["manifest"] = json!("provider");
    fixture.input["filesystems"][0]["rules"] =
        json!([{"match":"file","provider":{"module":"provider"}}]);
    let mut session = fixture.start();
    assert!(fixture.mock.created().contains(&format!(
        "{}:/scriptfs/modules/0/package:ro",
        fs::canonicalize(root.join("node_modules/provider"))
            .unwrap()
            .display()
    )));
    assert_eq!(
        fixture.mock.runtime()["modules"]["provider"]["entry"],
        "/scriptfs/modules/0/package/index.mjs"
    );
    session.stop().unwrap();
}
#[test]
fn explicit_readiness() {
    let fixture = Fixture::new();
    let mut session = fixture.start();
    assert_eq!(
        fixture.mock.calls("exec")[0].args,
        ["exec", "test-container", "cat", "/tmp/scriptfs-ready"]
    );
    assert!(fixture.mock.calls("logs").is_empty());
    session.stop().unwrap();
}
#[test]
fn follows_logs_from_the_container_readiness_time() {
    let mut fixture = Fixture::new();
    fixture.input["container"]["logLevel"] = json!("info");
    fixture.mock.output("exec", "ready 1700000000.000000042\n");
    let mut session = fixture.start();
    eventually(|| !fixture.mock.calls("logs").is_empty());
    assert_eq!(
        fixture.mock.calls("logs")[0].args,
        [
            "logs",
            "--follow",
            "--since",
            "1700000000.000000042",
            "test-container"
        ]
    );
    session.stop().unwrap();
}
#[test]
fn package_root_prefers_the_launcher_root() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("scriptfs");
    write(root.join("container/Containerfile"), "FROM scratch\n");
    write(root.join("package.json"), "{}\n");
    assert_eq!(package_root_from(Some(root.clone().into())).unwrap(), root);
    let error = package_root_from(Some(directory.path().into()))
        .unwrap_err()
        .to_string();
    assert!(error.contains("is not a ScriptFS distribution"), "{error}");
    let nested = root.join("target/release");
    std::fs::create_dir_all(&nested).unwrap();
    assert_eq!(
        find_package_root([directory.path().into(), nested]).unwrap(),
        root
    );
    let error = find_package_root([directory.path().into()])
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("Cannot find the ScriptFS distribution"),
        "{error}"
    );
}
#[test]
fn readiness_markers() {
    assert_eq!(readiness_time("").unwrap(), None);
    assert_eq!(
        readiness_time("ready 12.000000345\n").unwrap().as_deref(),
        Some("12.000000345")
    );
    for marker in [
        "ready",
        "ready 12",
        "ready 12.5",
        "ready x.000000000",
        "ready .000000000",
    ] {
        assert!(readiness_time(marker).is_err(), "{marker}");
    }
}
#[test]
fn container_security() {
    let fixture = Fixture::new();
    let mut session = fixture.start();
    let create = fixture.mock.created();
    let security: Vec<_> = create
        .windows(2)
        .filter(|pair| pair[0] == "--security-opt")
        .map(|pair| pair[1].as_str())
        .collect();
    assert_eq!(security, ["label=disable", "apparmor=unconfined"]);
    assert!(create.contains(&"SYS_ADMIN".into()));
    assert!(!create.contains(&"--privileged".into()));
    session.stop().unwrap();
}
fn windows_credentials(platform: Platform) {
    let mut fixture = Fixture::new();
    if platform == Platform::Windows {
        fixture.input["filesystems"][0]["mountPoint"] = json!("s:");
    }
    let mut session = fixture.start_on(platform);
    let create = fixture.mock.created();
    let credentials = create
        .iter()
        .find_map(|arg| arg.strip_suffix(":/scriptfs/smb-credentials.json:ro"));
    if platform == Platform::Windows {
        let path = PathBuf::from(credentials.expect("credentials mount"));
        assert!(create.contains(&"SCRIPTFS_SMB_CREDENTIALS=/scriptfs/smb-credentials.json".into()));
        let credentials: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(credentials["username"], "scriptfs");
        let password = credentials["password"].as_str().unwrap();
        assert_eq!(password.len(), 64);
        assert!(
            password
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        );
        assert!(!create.join(" ").contains(password));
        assert!(fixture.mock.calls("mount")[0].args[3].contains(path.to_str().unwrap()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        session.stop().unwrap();
        assert!(!path.exists());
    } else {
        assert!(credentials.is_none());
        assert!(
            !fixture.mock.calls("mount")[0]
                .args
                .join(" ")
                .contains("credentials")
        );
        session.stop().unwrap();
    }
}
#[test]
fn linux_no_credentials() {
    windows_credentials(Platform::Linux);
}
#[test]
fn uses_temporary_smb_credentials_only_for_windows_win32() {
    windows_credentials(Platform::Windows);
}
fn registry(platform: Platform) {
    let mut fixture = Fixture::new();
    fixture.input["container"]["rebuild"] = json!(true);
    if platform == Platform::Windows {
        fixture.input["filesystems"][0]["mountPoint"] = json!("S:");
    }
    let mut session = fixture.start_on(platform);
    let registry = &fixture.mock.calls("registry")[0];
    assert_eq!(
        registry.program,
        if platform == Platform::Windows {
            "cmd.exe"
        } else {
            "npm"
        }
    );
    assert_eq!(
        registry.args,
        if platform == Platform::Windows {
            args(&["/d", "/s", "/c", "npm config get registry"])
        } else {
            args(&["config", "get", "registry"])
        }
    );
    assert!(Arc::ptr_eq(
        registry.signal.as_ref().unwrap(),
        &fixture.stop
    ));
    assert_eq!(registry.timeout, Some(Duration::from_secs(60)));
    let build = &fixture.mock.calls("build")[0];
    assert!(
        build
            .args
            .contains(&"NPM_REGISTRY=https://registry.example.invalid/".into())
    );
    assert!(!build.args.iter().any(|arg| arg.starts_with("RUN_NATIVE")));
    assert!(build.inherit);
    assert!(build.stderr_only);
    assert!(Arc::ptr_eq(build.signal.as_ref().unwrap(), &fixture.stop));
    assert_eq!(build.timeout, Some(Duration::from_secs(600)));
    assert!(fixture.mock.calls("image").is_empty());
    session.stop().unwrap();
}
const RELEASE: &str = "ghcr.io/hoho/scriptfs-runtime@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
fn image_ref(fixture: &Fixture) -> String {
    fixture.mock.created().last().unwrap().clone()
}
#[test]
fn checkouts_use_the_local_runtime_image() {
    let fixture = Fixture::new();
    let mut session = fixture.start();
    assert_eq!(image_ref(&fixture), IMAGE);
    assert!(fixture.mock.calls("pull").is_empty());
    assert!(fixture.mock.calls("build").is_empty());
    session.stop().unwrap();
}
#[test]
fn releases_reuse_their_pulled_image() {
    let fixture = Fixture::new();
    fixture.release(RELEASE);
    let mut session = fixture.start();
    assert_eq!(
        fixture.mock.calls("image")[0].args,
        args(&["image", "inspect", "--format", "{{.Id}}", RELEASE])
    );
    assert_eq!(image_ref(&fixture), RELEASE);
    assert!(fixture.mock.calls("pull").is_empty());
    assert!(fixture.mock.calls("build").is_empty());
    session.stop().unwrap();
}
#[test]
fn releases_pull_their_pinned_image() {
    let fixture = Fixture::new();
    fixture.release(RELEASE);
    fixture
        .mock
        .action("image", Action::Output(String::new()), Some(1));
    let mut session = fixture.start();
    let pull = &fixture.mock.calls("pull")[0];
    assert_eq!(pull.args, args(&["pull", RELEASE]));
    assert!(pull.inherit && pull.stderr_only);
    assert!(Arc::ptr_eq(pull.signal.as_ref().unwrap(), &fixture.stop));
    assert_eq!(pull.timeout, Some(Duration::from_secs(600)));
    assert_eq!(fixture.mock.calls("image").len(), 1);
    assert!(fixture.mock.calls("build").is_empty());
    assert_eq!(image_ref(&fixture), RELEASE);
    session.stop().unwrap();
}
#[test]
fn releases_fall_back_to_a_local_build_when_the_pull_fails() {
    let fixture = Fixture::new();
    fixture.release(RELEASE);
    fixture
        .mock
        .action("image", Action::Output(String::new()), Some(2));
    fixture.mock.fail_once("pull", "network is unreachable");
    let mut session = fixture.start();
    assert_eq!(
        fixture.mock.calls("image")[1].args,
        args(&["image", "inspect", "--format", "{{.Id}}", IMAGE])
    );
    let build = &fixture.mock.calls("build")[0];
    let tag = build.args.iter().position(|arg| arg == "--tag").unwrap();
    assert_eq!(build.args[tag + 1], IMAGE);
    assert_eq!(image_ref(&fixture), IMAGE);
    session.stop().unwrap();
}
#[test]
fn releases_reuse_a_local_build_when_the_pull_fails() {
    let fixture = Fixture::new();
    fixture.release(RELEASE);
    fixture
        .mock
        .action("image", Action::Output(String::new()), Some(1));
    fixture.mock.fail_once("pull", "network is unreachable");
    let mut session = fixture.start();
    assert!(fixture.mock.calls("build").is_empty());
    assert_eq!(image_ref(&fixture), IMAGE);
    session.stop().unwrap();
}
#[test]
fn explicit_images_and_rebuilds_ignore_the_release_image() {
    let mut fixture = Fixture::new();
    fixture.release(RELEASE);
    fixture.input["container"]["image"] = json!("localhost/custom:1");
    let mut session = fixture.start();
    assert_eq!(image_ref(&fixture), "localhost/custom:1");
    session.stop().unwrap();
    let mut fixture = Fixture::new();
    fixture.release(RELEASE);
    fixture.input["container"]["rebuild"] = json!(true);
    let mut session = fixture.start();
    assert!(fixture.mock.calls("image").is_empty());
    assert!(fixture.mock.calls("pull").is_empty());
    assert_eq!(fixture.mock.calls("build").len(), 1);
    assert_eq!(image_ref(&fixture), IMAGE);
    session.stop().unwrap();
}
#[test]
fn release_images_must_be_pinned_by_digest() {
    for image in [
        "ghcr.io/hoho/scriptfs-runtime:0.1.0",
        "ghcr.io/hoho/scriptfs-runtime@sha256:0123",
        "ghcr.io/hoho/scriptfs-runtime:0.1.0@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "ghcr.io/@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "ghcr.io/hoho/scriptfs-runtime@sha256:0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef",
    ] {
        let fixture = Fixture::new();
        fixture.release(image);
        let failure = fixture.failure();
        assert!(
            failure.errors[0].contains("must pin the runtime image as <name>@sha256:<digest>"),
            "{image}: {:?}",
            failure.errors
        );
        assert!(fixture.mock.calls("pull").is_empty());
    }
    let fixture = Fixture::new();
    write(fixture.root.path().join(RELEASE_IMAGE_FILE), "{}");
    assert!(fixture.failure().errors[0].contains("Invalid"));
    let fixture = Fixture::new();
    let local = "localhost:5000/scriptfs-runtime@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    fixture.release(local);
    let mut session = fixture.start();
    assert_eq!(image_ref(&fixture), local);
    session.stop().unwrap();
}
#[test]
fn rebuild_requires_the_built_module_package() {
    let mut fixture = Fixture::new();
    fixture.input["container"]["rebuild"] = json!(true);
    fs::remove_file(fixture.root.path().join("packages/module/dist/index.js")).unwrap();
    let failure = start_session(
        &fixture.input,
        fixture.stop.clone(),
        fixture.mock.clone(),
        fixture.settings(Platform::Linux),
    )
    .err()
    .unwrap();
    assert!(
        format!("{:?}", failure.errors)
            .contains("no built @scriptfs/module package; run make build"),
        "{:?}",
        failure.errors
    );
    assert!(fixture.mock.calls("build").is_empty());
}
#[test]
fn mac_registry_build() {
    registry(Platform::Mac);
}
#[test]
fn linux_registry_build() {
    registry(Platform::Linux);
}
#[test]
fn windows_registry_build() {
    registry(Platform::Windows);
}
fn cancel_stalled(operation: &str, fail_rollback: bool) {
    let mut fixture = Fixture::new();
    if ["registry", "build"].contains(&operation) {
        fixture.input["container"]["rebuild"] = json!(true);
    }
    if operation == "pull" {
        fixture.release(RELEASE);
        fixture
            .mock
            .action("image", Action::Output(String::new()), Some(1));
    }
    fixture.mock.action(operation, Action::Stall, Some(1));
    if fail_rollback {
        fixture.mock.fail_once("rm", "cleanup timed out");
    }
    let input = fixture.input.clone();
    let stop = fixture.stop.clone();
    let mock = fixture.mock.clone();
    let settings = fixture.settings(Platform::Linux);
    let running = thread::spawn(move || start_session(&input, stop, mock, settings));
    eventually(|| !fixture.mock.calls(operation).is_empty());
    let request = fixture.mock.calls(operation)[0].clone();
    assert!(request.signal.is_some());
    if ["build", "pull"].contains(&operation) {
        assert_eq!(request.timeout, Some(Duration::from_secs(600)));
    } else if ["image", "create", "start", "port", "registry"].contains(&operation) {
        assert_eq!(request.timeout, Some(Duration::from_secs(60)));
    }
    fixture.stop.store(true, Ordering::SeqCst);
    let mut failure = match running.join().unwrap() {
        Err(error) => error,
        Ok(mut session) => {
            session.stop().unwrap();
            panic!("Cancelled startup succeeded");
        }
    };
    assert!(failure.errors[0].contains("interrupted"));
    assert!(request.signal.unwrap().load(Ordering::SeqCst));
    assert!(fixture.mock.calls("mount").is_empty());
    assert!(fixture.mock.calls("logs").is_empty());
    if ["image", "registry", "build", "pull"].contains(&operation) {
        assert!(fixture.mock.calls("build").is_empty() || operation == "build");
        assert!(fixture.mock.calls("create").is_empty());
        assert!(failure.session.is_none());
    } else {
        let target = if operation == "create" {
            let create = fixture.mock.created();
            let name = create[create.iter().position(|arg| arg == "--name").unwrap() + 1].clone();
            assert!(name.starts_with("scriptfs-"));
            name
        } else {
            "test-container".into()
        };
        assert_eq!(
            fixture.mock.calls("rm")[0].args,
            args(&["rm", "--ignore", "--force", &target])
        );
        assert_eq!(fixture.mock.path().exists(), fail_rollback);
        let session = failure.session.as_mut().unwrap();
        if fail_rollback {
            assert!(
                failure
                    .errors
                    .iter()
                    .any(|error| error.contains("cleanup timed out"))
            );
            assert!(session.retryable());
            session.stop().unwrap();
        }
        assert!(!fixture.mock.path().exists());
        for request in fixture
            .mock
            .calls("stop")
            .into_iter()
            .chain(fixture.mock.calls("rm"))
        {
            assert!(request.signal.is_none());
            assert_eq!(request.timeout, Some(Duration::from_secs(60)));
        }
    }
}
#[test]
fn cancel_registry() {
    cancel_stalled("registry", false);
}
#[test]
fn cancel_build() {
    cancel_stalled("build", false);
}
#[test]
fn cancels_a_stalled_release_image_pull() {
    cancel_stalled("pull", false);
}
#[test]
fn create_empty_id_name_rollback() {
    let fixture = Fixture::new();
    fixture.mock.output("create", "");
    let failure = fixture.failure();
    assert!(failure.errors[0].contains("Podman returned no container ID"));
    let create = fixture.mock.created();
    let name = &create[create.iter().position(|arg| arg == "--name").unwrap() + 1];
    assert!(name.starts_with("scriptfs-"));
    assert_eq!(
        fixture.mock.calls("rm")[0].args,
        args(&["rm", "--ignore", "--force", name])
    );
    assert!(fixture.mock.calls("mount").is_empty());
}
#[test]
fn cancel_image() {
    cancel_stalled("image", false);
}
#[test]
fn cancel_create() {
    cancel_stalled("create", false);
}
#[test]
fn cancel_start() {
    cancel_stalled("start", false);
}
#[test]
fn cancel_inspect() {
    cancel_stalled("inspect", false);
}
#[test]
fn cancel_exec() {
    cancel_stalled("exec", false);
}
#[test]
fn cancel_port() {
    cancel_stalled("port", false);
}
fn readiness_deadline(operation: &str) {
    let fixture = Fixture::new();
    fixture.mock.action(operation, Action::Stall, Some(1));
    let input = fixture.input.clone();
    let stop = fixture.stop.clone();
    let mock = fixture.mock.clone();
    let mut settings = fixture.settings(Platform::Linux);
    settings.readiness_timeout = Duration::from_millis(150);
    let start = Instant::now();
    let running = thread::spawn(move || start_session(&input, stop, mock, settings));
    eventually(|| !fixture.mock.calls(operation).is_empty());
    let signal = fixture.mock.calls(operation)[0].signal.clone().unwrap();
    assert!(!signal.load(Ordering::SeqCst));
    assert!(fixture.mock.calls("stop").is_empty());
    let failure = match running.join().unwrap() {
        Err(error) => error,
        Ok(mut session) => {
            session.stop().unwrap();
            panic!("Expected readiness timeout");
        }
    };
    assert!(start.elapsed() >= Duration::from_millis(140));
    assert!(start.elapsed() < Duration::from_secs(1));
    assert!(failure.errors[0].contains("Timed out waiting for the scriptfs container"));
    assert!(signal.load(Ordering::SeqCst));
    assert_eq!(
        fixture.mock.calls("rm")[0].args,
        ["rm", "--ignore", "--force", "test-container"]
    );
    assert!(!fixture.mock.path().exists());
}
#[test]
fn inspect_readiness_deadline() {
    readiness_deadline("inspect");
}
#[test]
fn exec_readiness_deadline() {
    readiness_deadline("exec");
}
#[test]
fn container_exit_interrupts_readiness() {
    let fixture = Fixture::new();
    fixture.mock.action("exec", Action::Stall, Some(1));
    let input = fixture.input.clone();
    let stop = fixture.stop.clone();
    let mock = fixture.mock.clone();
    let settings = fixture.settings(Platform::Linux);
    let running = thread::spawn(move || start_session(&input, stop, mock, settings));
    eventually(|| !fixture.mock.calls("exec").is_empty());
    let signal = fixture.mock.calls("exec")[0].signal.clone().unwrap();
    *fixture.mock.exit.lock().unwrap() = Some(Ok("42\n".into()));
    let failure = match running.join().unwrap() {
        Err(error) => error,
        Ok(mut session) => {
            session.stop().unwrap();
            panic!("Expected startup exit");
        }
    };
    assert_eq!(
        failure.errors[0],
        "scriptfs container test-container exited with status 42"
    );
    assert!(signal.load(Ordering::SeqCst));
    assert!(!fixture.mock.path().exists());
}
#[test]
fn monitor_cancel_after_removal() {
    let fixture = Fixture::new();
    fixture.mock.action("wait", Action::Stall, Some(1));
    let mut session = fixture.start();
    eventually(|| !fixture.mock.calls("wait").is_empty());
    let signal = fixture.mock.calls("wait")[0].signal.clone().unwrap();
    session.stop().unwrap();
    assert!(signal.load(Ordering::SeqCst));
    assert!(session.exit_error().is_none());
    wait_session(&session, &AtomicBool::new(true)).unwrap();
}
#[test]
fn failed_cancel_rollback_retry() {
    cancel_stalled("exec", true);
}
#[test]
fn readonly_file_proxy_parent() {
    let mut fixture = Fixture::new();
    let target = fixture.root.path().join("target");
    write(&target, "value");
    fixture.input["filesystems"][0]["readOnly"] = json!(true);
    fixture.input["filesystems"][0]["rules"] =
        json!([{"match":"file","provider":{"type":"file","path":target}}]);
    let mut session = fixture.start();
    assert!(fixture.mock.created().contains(&format!(
        "{}:/scriptfs/proxies/0:ro",
        fixture.root.path().display()
    )));
    assert_eq!(
        fixture.mock.runtime()["filesystems"][0]["rules"][0]["provider"]["path"],
        "/scriptfs/proxies/0/target"
    );
    session.stop().unwrap();
}
#[test]
fn programmatic_paths_no_mutation() {
    let mut fixture = Fixture::new();
    fs::create_dir(fixture.root.path().join("source")).unwrap();
    fs::create_dir(fixture.root.path().join("directory")).unwrap();
    write(fixture.root.path().join("target"), "value");
    fixture.input["filesystems"] = json!([{"name":"test","source":"source","mountPoint":"mount","rules":[
        {"match":"File","provider":{"type":"file","path":"target"}},
        {"match":"Directory/**","root":"Directory","provider":{"type":"directory","path":"directory"}}]}]);
    let original = fixture.input.clone();
    let mut session = fixture.start();
    assert_eq!(fixture.input, original);
    let create = fixture.mock.created();
    assert!(create.contains(&format!(
        "{}:/scriptfs/sources/0",
        fixture.root.path().join("source").display()
    )));
    assert!(create.contains(&format!(
        "{}:/scriptfs/proxies/0",
        fixture.root.path().display()
    )));
    assert!(create.contains(&format!(
        "{}:/scriptfs/proxies/1",
        fixture.root.path().join("directory").display()
    )));
    let mount = &fixture.mock.calls("mount")[0];
    assert_eq!(
        mount.args,
        args(&[
            "-t",
            "cifs",
            "//127.0.0.1/test",
            fixture.root.path().join("mount").to_str().unwrap(),
            "-o",
            "guest,port=14445,vers=3.0"
        ])
    );
    assert_eq!(
        session.mounts(),
        json!([["test", fixture.root.path().join("mount")]])
    );
    session.stop().unwrap();
}
#[test]
fn schema_normalized_direct_and_loaded() {
    let mut fixture = Fixture::new();
    fixture.module(
        "virtual",
        "virtual",
        json!({"settings":{"title":{"type":"string","default":"x"}}}),
        json!({}),
    );
    fixture.input["modules"]["virtual"]["manifest"] = json!("./virtual");
    fixture.input["filesystems"][0]["rules"] =
        json!([{"match":"Virtual","provider":{"module":"virtual"},"hide":false}]);
    let original = fixture.input.clone();
    let path = fixture.root.path().join("config.json");
    write(&path, serde_json::to_vec(&fixture.input).unwrap());
    let mut direct = fixture.start();
    let direct_config = fixture.mock.runtime();
    assert_eq!(fixture.input, original);
    direct.stop().unwrap();
    fixture.input = load_config(&path).unwrap().1;
    let mut loaded = fixture.start();
    assert_eq!(fixture.mock.runtime(), direct_config);
    assert_eq!(
        direct_config["filesystems"][0]["rules"][0],
        json!({"match":"Virtual","provider":{"module":"virtual"}})
    );
    assert_eq!(
        direct_config["modules"]["virtual"],
        json!({"entry":"/scriptfs/modules/0/package/index.mjs","export":"default","manifest":{"name":"virtual"},"settings":{"title":"x"}})
    );
    loaded.stop().unwrap();
}
#[test]
fn validate_modules_before_resources() {
    let mut fixture = Fixture::new();
    fixture.module(
        "broken",
        "broken",
        json!({"settings":{"limit":{"type":"integer","required":true}}}),
        json!({}),
    );
    fixture.input["filesystems"].as_array_mut().unwrap().push(json!({"name":"second","source":fixture.root.path(),"mountPoint":fixture.root.path().join("second"),
        "rules":[{"match":"Virtual","provider":{"module":"broken"}}]}));
    assert!(fixture.failure().errors[0].contains("modules.broken.settings.limit is required"));
    fixture.input["filesystems"][1]["rules"][0]["provider"]["module"] = json!("missing");
    assert!(
        fixture.failure().errors[0]
            .contains("Rule Virtual uses module \"missing\", which is not declared under modules")
    );
    assert!(fixture.mock.calls.lock().unwrap().is_empty());
}
#[test]
fn modules_mount_paths_and_state_and_publish_ports() {
    let mut fixture = Fixture::new();
    let root = fixture.root.path().to_path_buf();
    fs::create_dir_all(root.join("notes")).unwrap();
    fs::create_dir_all(root.join("data")).unwrap();
    write(root.join("token.txt"), "secret\n");
    fixture.module(
        "api",
        "api",
        json!({
            "state": true,
            "secrets": {"token": {}},
            "paths": {
                "notes": {"target": "/notes"},
                "data": {"access": "read-write"}
            },
            "ports": {
                "http": {"direction": "outbound", "target": "127.0.0.1:4310"},
                "hook": {"direction": "inbound", "port": 8787, "hostPort": 18787}
            }
        }),
        json!({
            "secrets": {"token": {"file": "token.txt"}},
            "paths": {"notes": "notes", "data": "data"}
        }),
    );
    let mut session = fixture.start();
    let create = fixture.mock.created();
    let canonical = |path: &Path| fs::canonicalize(path).unwrap().display().to_string();
    for expected in [
        format!(
            "{}:/scriptfs/modules/0/package:ro",
            canonical(&root.join("api"))
        ),
        format!("{}:/notes:ro", root.join("notes").display()),
        format!("{}:/scriptfs/paths/api/data", root.join("data").display()),
        format!(
            "{}:/scriptfs/state/api",
            root.join(".scriptfs").join("state").join("api").display()
        ),
    ] {
        assert!(create.contains(&expected), "{expected} not in {create:?}");
    }
    assert!(root.join(".scriptfs/state/api").is_dir());
    let published: Vec<_> = create
        .windows(2)
        .filter(|pair| pair[0] == "--publish")
        .map(|pair| pair[1].as_str())
        .collect();
    assert!(published.contains(&"127.0.0.1:18787:8787"), "{published:?}");
    assert!(published.contains(&"127.0.0.1::7445"), "{published:?}");
    let secrets_mount = create
        .iter()
        .find(|arg| arg.ends_with(":/scriptfs/secrets.json:ro"))
        .expect("secrets volume");
    let secrets_path = PathBuf::from(
        secrets_mount
            .strip_suffix(":/scriptfs/secrets.json:ro")
            .unwrap(),
    );
    let secrets: Value = serde_json::from_slice(&fs::read(&secrets_path).unwrap()).unwrap();
    assert_eq!(secrets["modules"], json!({"api":{"token":"secret"}}));
    assert_eq!(secrets["tunnel"].as_str().unwrap().len(), 64);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&secrets_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let runtime = fixture.mock.runtime();
    assert!(
        !serde_json::to_string(&runtime)
            .unwrap()
            .contains("secret\""),
        "secrets must stay out of the runtime configuration"
    );
    assert_eq!(
        runtime["modules"]["api"],
        json!({
            "entry": "/scriptfs/modules/0/package/index.mjs",
            "export": "default",
            "manifest": {"name": "api"},
            "ports": {
                "http": {"direction": "outbound"},
                "hook": {"direction": "inbound", "port": 8787, "hostPort": 18787}
            },
            "paths": {"data": "/scriptfs/paths/api/data", "notes": "/notes"},
            "stateDir": "/scriptfs/state/api"
        })
    );
    assert!(
        fixture
            .mock
            .calls("port")
            .iter()
            .any(|call| call.args.last().unwrap() == "7445/tcp")
    );
    session.stop().unwrap();
    assert!(!secrets_path.exists());
}
#[test]
fn modules_without_secrets_or_outbound_ports_skip_the_tunnel() {
    let mut fixture = Fixture::new();
    fixture.module("plain", "plain", json!({}), json!({}));
    let mut session = fixture.start();
    let create = fixture.mock.created();
    assert!(!create.iter().any(|arg| arg.contains("secrets.json")));
    assert!(!create.iter().any(|arg| arg.contains("7445")));
    assert!(
        !fixture
            .mock
            .calls("port")
            .iter()
            .any(|call| call.args.last().unwrap() == "7445/tcp")
    );
    session.stop().unwrap();
}
#[test]
fn missing_module_secrets_fail_before_podman() {
    let mut fixture = Fixture::new();
    fixture.module(
        "api",
        "api",
        json!({"secrets": {"token": {"env": "SCRIPTFS_TEST_UNSET_SECRET"}}}),
        json!({}),
    );
    let failure = fixture.failure();
    assert!(
        failure.errors[0].contains("set the SCRIPTFS_TEST_UNSET_SECRET environment variable"),
        "{:?}",
        failure.errors
    );
    assert!(fixture.mock.calls.lock().unwrap().is_empty());
}
/// Mounts of a session, without the `--volume` flags.
fn volumes(fixture: &Fixture) -> Vec<String> {
    fixture
        .mock
        .created()
        .windows(2)
        .filter(|pair| pair[0] == "--volume")
        .map(|pair| pair[1].clone())
        .collect()
}
fn module_volumes(fixture: &Fixture) -> Vec<String> {
    volumes(fixture)
        .into_iter()
        .filter(|v| v.contains(":/scriptfs/modules/"))
        .collect()
}
/// A module package with `"dependencies": "install"` and a lockfile.
fn installing_module(fixture: &mut Fixture, instance: &str, directory: &str) -> PathBuf {
    let directory = fixture.module(
        instance,
        directory,
        json!({"dependencies": "install"}),
        json!({}),
    );
    write(
        directory.join("package.json"),
        r#"{"dependencies":{"ms":"2.1.3"}}"#,
    );
    write(
        directory.join("package-lock.json"),
        r#"{"lockfileVersion":3}"#,
    );
    directory
}
#[test]
fn bundled_modules_mount_only_their_directory() {
    let mut fixture = Fixture::new();
    let project = fixture.root.path().join("project");
    write(project.join("package.json"), "{}");
    write(project.join("node_modules/dependency/package.json"), "{}");
    let provider = fixture.module(
        "provider",
        "project/packages/provider",
        json!({}),
        json!({}),
    );
    fixture.module(
        "other",
        "project/packages/provider/nested",
        json!({}),
        json!({}),
    );
    let mut session = fixture.start();
    assert_eq!(
        module_volumes(&fixture),
        [
            format!(
                "{}:/scriptfs/modules/0/package:ro",
                canonical(&provider.join("nested"))
            ),
            format!("{}:/scriptfs/modules/1/package:ro", canonical(&provider)),
        ]
    );
    assert!(fixture.mock.calls("run").is_empty());
    session.stop().unwrap();
}
fn canonical(path: &Path) -> String {
    fs::canonicalize(path).unwrap().display().to_string()
}
#[test]
fn instances_of_one_package_share_its_mount() {
    let mut fixture = Fixture::new();
    let provider = fixture.module("first", "provider", json!({}), json!({}));
    write(
        provider.join("second.module.json"),
        r#"{"name":"second","entry":"index.mjs","export":"other"}"#,
    );
    fixture.input["modules"]["second"] = json!({"manifest": provider.join("second.module.json")});
    let mut session = fixture.start();
    assert_eq!(
        module_volumes(&fixture),
        [format!(
            "{}:/scriptfs/modules/0/package:ro",
            canonical(&provider)
        )]
    );
    let runtime = fixture.mock.runtime();
    assert_eq!(
        runtime["modules"]["first"]["entry"],
        "/scriptfs/modules/0/package/index.mjs"
    );
    assert_eq!(
        runtime["modules"]["second"]["entry"],
        "/scriptfs/modules/0/package/index.mjs"
    );
    assert_eq!(runtime["modules"]["second"]["export"], "other");
    session.stop().unwrap();
}
#[test]
fn installs_dependencies_in_the_runtime_image_once() {
    let mut fixture = Fixture::new();
    let provider = installing_module(&mut fixture, "first", "provider");
    write(
        provider.join(".npmrc"),
        "registry=https://registry.example.invalid/\n",
    );
    write(
        provider.join("second.module.json"),
        r#"{"name":"second","entry":"index.mjs","dependencies":"install"}"#,
    );
    fixture.input["modules"]["second"] = json!({"manifest": provider.join("second.module.json")});
    let mut session = fixture.start();
    let runs = fixture.mock.calls("run");
    assert_eq!(runs.len(), 1, "one install per package");
    assert_eq!(
        fixture.mock.calls("registry").len(),
        1,
        "the host registry is read once"
    );
    let run = &runs[0];
    assert!(
        run.inherit && run.stderr_only,
        "npm output must not reach stdout"
    );
    let work = run
        .args
        .iter()
        .find_map(|a| a.strip_suffix(":/scriptfs/install"))
        .expect("install volume");
    assert!(
        run.args.windows(2).any(|pair| pair[0] == "--env"
            && pair[1] == "npm_config_userconfig=/scriptfs/install/.scriptfs-host-npmrc"),
        "{:?}",
        run.args
    );
    let tail: Vec<&str> = run
        .args
        .iter()
        .map(String::as_str)
        .skip_while(|a| *a != IMAGE)
        .collect();
    assert_eq!(
        tail,
        [
            IMAGE,
            "npm",
            "ci",
            "--omit=dev",
            "--omit=peer",
            "--no-audit",
            "--no-fund",
            "--no-update-notifier"
        ]
    );
    let cache = fixture.root.path().join("cache").join("dependencies");
    let entries: Vec<_> = fs::read_dir(&cache)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(entries.len(), 1, "{entries:?}");
    let entry = &entries[0];
    assert!(
        !Path::new(work).exists(),
        "staging directory is renamed into place"
    );
    assert!(entry.join("node_modules").is_dir());
    assert!(entry.join("package-lock.json").is_file());
    assert!(
        !entry.join(".npmrc").exists() && !entry.join(".scriptfs-host-npmrc").exists(),
        "registry configuration is not cached"
    );
    assert_eq!(fs::read_to_string(entry.join("image")).unwrap(), "exists");
    assert_eq!(
        module_volumes(&fixture),
        [
            format!("{}:/scriptfs/modules/0/package:ro", canonical(&provider)),
            format!(
                "{}:/scriptfs/modules/0/node_modules:ro",
                entry.join("node_modules").display()
            ),
        ]
    );
    session.stop().unwrap();

    let mut session = fixture.start();
    assert_eq!(fixture.mock.calls("run").len(), 1, "the cache is reused");
    assert_eq!(
        fixture.mock.calls("registry").len(),
        1,
        "cached installs do not need the registry"
    );
    session.stop().unwrap();

    write(
        provider.join("package-lock.json"),
        r#"{"lockfileVersion":3,"changed":true}"#,
    );
    let mut session = fixture.start();
    assert_eq!(
        fixture.mock.calls("run").len(),
        2,
        "a lockfile change reinstalls"
    );
    session.stop().unwrap();
}
#[test]
fn dependency_installs_without_host_npm_use_the_image_registry() {
    let mut fixture = Fixture::new();
    installing_module(&mut fixture, "provider", "provider");
    fixture.mock.action(
        "registry",
        Action::Error("npm: command not found".into()),
        None,
    );
    let mut session = fixture.start();
    let run = &fixture.mock.calls("run")[0];
    assert!(
        !run.args
            .iter()
            .any(|a| a.starts_with("npm_config_userconfig=")),
        "{:?}",
        run.args
    );
    session.stop().unwrap();
}
#[test]
fn installed_dependencies_shadow_host_node_modules() {
    let mut fixture = Fixture::new();
    let provider = installing_module(&mut fixture, "provider", "provider");
    fs::create_dir_all(provider.join("node_modules/ms")).unwrap();
    let mut session = fixture.start();
    let volumes = module_volumes(&fixture);
    assert_eq!(volumes.len(), 2);
    assert!(
        volumes[1].ends_with(&format!(
            "{}node_modules:/scriptfs/modules/0/package/node_modules:ro",
            std::path::MAIN_SEPARATOR
        )),
        "{volumes:?}"
    );
    session.stop().unwrap();
}
#[test]
fn dependency_installs_fail_before_the_container_is_created() {
    let mut fixture = Fixture::new();
    installing_module(&mut fixture, "provider", "provider");
    fixture.mock.fail_once("run", "npm ERR! 404 Not Found");
    let failure = fixture.failure();
    assert!(
        failure.errors[0].contains("Could not install the dependencies of module \"provider\""),
        "{:?}",
        failure.errors
    );
    assert!(fixture.mock.calls("create").is_empty());
    let cache = fixture.root.path().join("cache/dependencies");
    assert_eq!(
        fs::read_dir(cache).unwrap().count(),
        0,
        "no partial entry is kept"
    );
}
#[test]
fn dependency_installs_require_a_lockfile() {
    let mut fixture = Fixture::new();
    let provider = installing_module(&mut fixture, "provider", "provider");
    fs::remove_file(provider.join("package-lock.json")).unwrap();
    let failure = fixture.failure();
    assert!(
        failure.errors[0].contains("npm install --package-lock-only"),
        "{:?}",
        failure.errors
    );
    assert!(fixture.mock.calls.lock().unwrap().is_empty());
}

#[test]
fn native_process_fixture() {
    let Ok(kind) = std::env::var("SCRIPTFS_TEST_PROCESS") else {
        return;
    };
    let root = PathBuf::from(std::env::var("SCRIPTFS_TEST_ROOT").unwrap());
    println!();
    #[cfg(unix)]
    if kind == "graceful" {
        unsafe {
            libc::signal(
                libc::SIGTERM,
                fixture_terminated as *const () as libc::sighandler_t,
            );
        }
    } else if kind == "ignore" {
        unsafe {
            libc::signal(libc::SIGTERM, libc::SIG_IGN);
        }
    }
    fs::write(root.join("pid.pending"), std::process::id().to_string()).unwrap();
    fs::rename(root.join("pid.pending"), root.join("pid")).unwrap();
    match kind.as_str() {
        "large-output" => {
            std::io::stdout()
                .write_all(&vec![b'a'; 4 * 1024 * 1024])
                .unwrap();
            std::io::stderr()
                .write_all(&vec![b'b'; 4 * 1024 * 1024])
                .unwrap();
            std::io::stdout().flush().unwrap();
            std::io::stderr().flush().unwrap();
            std::process::exit(0);
        }
        "pipe-parent" => {
            let descendant = root.join("descendant");
            fs::create_dir(&descendant).unwrap();
            let request = fixture_request("ignore", &descendant);
            let _child = Command::new(request.program)
                .args(request.args)
                .envs(request.env)
                .stdin(Stdio::null())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap();
            eventually(|| descendant.join("pid").exists());
            std::process::exit(0);
        }
        "cli-failure" | "cli-stopped" | "cli-signal" => {
            let fixture = Fixture::new();
            let mut session = fixture.start();
            if kind == "cli-failure" {
                *fixture.mock.exit.lock().unwrap() = Some(Ok("137\n".into()));
            }
            if kind == "cli-stopped" {
                session.stop().unwrap();
            }
            crate::install_stop_handler(fixture.stop.clone()).unwrap();
            let result = run_until_stopped(&mut session, &fixture.stop);
            assert!(!fixture.mock.path().exists());
            println!("cleanup completed");
            if let Err(error) = &result {
                eprintln!("{error:#}");
            }
            let code = i32::from(result.is_err());
            drop(session);
            drop(fixture);
            std::io::stdout().flush().unwrap();
            std::process::exit(code);
        }
        "sdk-config" => {
            let result = crate::run_args(args(&["--sdk-config"]));
            std::io::stdout().flush().unwrap();
            std::process::exit(i32::from(result.is_err()));
        }
        "sdk-session"
        | "sdk-session-busy"
        | "sdk-session-stop-remove-busy"
        | "sdk-session-exit"
        | "sdk-session-preflight-error"
        | "sdk-session-create-empty-busy"
        | "sdk-session-create-cancel-busy"
        | "sdk-session-start-clean"
        | "sdk-session-start-clean-aggregate"
        | "sdk-session-start-busy" => {
            let mock = Arc::new(Mock::default());
            if kind == "sdk-session-preflight-error" {
                mock.fail_once("--version", "Podman unavailable");
            }
            if kind == "sdk-session-busy" {
                mock.fail_once("unmount", "Resource busy");
            }
            if kind == "sdk-session-start-busy" {
                mock.fail_once("start", "SMB port already in use");
                mock.fail_once("rm", "remove failed");
            }
            if kind.starts_with("sdk-session-start-clean") {
                mock.fail_once("start", "SMB port already in use");
                if kind == "sdk-session-start-clean-aggregate" {
                    mock.fail_once("logs", "Unable to capture startup diagnostics");
                }
            }
            if kind == "sdk-session-stop-remove-busy" {
                mock.fail_once("stop", "stop failed");
                mock.fail_once("rm", "remove failed");
            }
            if matches!(
                kind.as_str(),
                "sdk-session-create-empty-busy" | "sdk-session-create-cancel-busy"
            ) {
                if kind == "sdk-session-create-empty-busy" {
                    mock.output("create", "");
                } else {
                    mock.action("create", Action::Stall, Some(1));
                }
                mock.fail_once("rm", "remove failed");
                let observer = mock.clone();
                let root = root.clone();
                thread::spawn(move || {
                    eventually(|| !observer.calls("create").is_empty());
                    let create = observer.created();
                    let name = &create[create.iter().position(|arg| arg == "--name").unwrap() + 1];
                    write(root.join("create-name.pending"), name);
                    fs::rename(root.join("create-name.pending"), root.join("create-name")).unwrap();
                });
            }
            if kind == "sdk-session-exit" {
                let mock = mock.clone();
                thread::spawn(move || {
                    eventually(|| !mock.calls("mount").is_empty());
                    thread::sleep(Duration::from_millis(100));
                    *mock.exit.lock().unwrap() = Some(Ok("42\n".into()));
                });
            }
            let stop = Arc::new(AtomicBool::new(false));
            crate::install_stop_handler(stop.clone()).unwrap();
            print!("provider log without a trailing newline");
            let result = sdk_with(
                stop,
                mock,
                StartSettings {
                    platform: Platform::Linux,
                    base: root.clone(),
                    state_root: root,
                    readiness_timeout: Duration::from_secs(2),
                    readiness_retry: Duration::from_millis(5),
                    distribution_root: None,
                    protocol: false,
                    cache_root: None,
                },
            );
            std::io::stdout().flush().unwrap();
            std::process::exit(i32::from(result.is_err()));
        }
        "capture" => {
            print!("output");
            eprint!("error");
            std::io::stdout().flush().unwrap();
            std::io::stderr().flush().unwrap();
            std::process::exit(3);
        }
        "input" | "input-failure" => {
            use std::io::Read;
            let mut bytes = Vec::new();
            std::io::stdin().read_to_end(&mut bytes).unwrap();
            if kind == "input" {
                std::io::stdout().write_all(&bytes).unwrap();
            }
            std::io::stdout().flush().unwrap();
            std::process::exit(if kind == "input" { 0 } else { 3 });
        }
        "success" => std::process::exit(0),
        "graceful" | "ignore" => loop {
            if FIXTURE_TERMINATED.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(50));
                fs::write(root.join("cleaned"), "cleaned").unwrap();
                std::process::exit(0);
            }
            thread::sleep(Duration::from_millis(5));
        },
        _ => panic!("Unknown fixture {kind}"),
    }
}
static FIXTURE_TERMINATED: AtomicBool = AtomicBool::new(false);
#[cfg(unix)]
extern "C" fn fixture_terminated(_: libc::c_int) {
    FIXTURE_TERMINATED.store(true, Ordering::SeqCst);
}
fn fixture_request(kind: &str, root: &Path) -> Request {
    crate::test_support::process_request(kind, root)
}
#[test]
fn capture_failure_policy() {
    let root = fixture("native-command-capture-");
    let mut request = fixture_request("capture", root.path());
    request.allow_failure = true;
    let output = NativeRunner.run(request.clone()).unwrap();
    assert!(output.stdout.ends_with("output"), "{output:?}");
    assert_eq!(output.stderr, "error");
    request.allow_failure = false;
    let error = NativeRunner.run(request).unwrap_err();
    assert!(error.to_string().contains("failed with exit code 3"));
    assert!(error.to_string().ends_with("outputerror"));
    let mut missing = Request::new(root.path().join("missing-command").to_str().unwrap(), &[]);
    missing.allow_failure = true;
    let error = NativeRunner.run(missing).unwrap_err();
    assert_eq!(
        error
            .root_cause()
            .downcast_ref::<std::io::Error>()
            .unwrap()
            .kind(),
        std::io::ErrorKind::NotFound
    );
}
#[test]
fn private_stdin() {
    let root = fixture("native-command-input-");
    let input = b"private command input\n";
    let mut request = fixture_request("input", root.path());
    request.input = Some(input.to_vec());
    let output = NativeRunner.run(request).unwrap();
    assert!(output.stdout.ends_with(std::str::from_utf8(input).unwrap()));
    let mut request = fixture_request("input-failure", root.path());
    request.input = Some(input.to_vec());
    let error = NativeRunner.run(request).unwrap_err();
    assert!(error.to_string().contains("failed with exit code 3"));
    assert!(!error.to_string().contains("private command input"));
}
#[test]
fn pre_cancel_no_spawn() {
    let root = fixture("native-command-prespawn-");
    let mut request = fixture_request("success", root.path());
    request.signal = Some(Arc::new(AtomicBool::new(true)));
    request.allow_failure = true;
    assert!(
        NativeRunner
            .run(request)
            .unwrap_err()
            .to_string()
            .contains("interrupted")
    );
    assert!(!root.path().join("pid").exists());
}
fn invalid_timeout(timeout: f64) {
    assert!(
        commands::timeout_ms(timeout)
            .unwrap_err()
            .to_string()
            .contains("integer between 1 and 2147483647")
    );
}
#[test]
fn zero_timeout() {
    invalid_timeout(0.0);
}
#[test]
fn negative_timeout() {
    invalid_timeout(-1.0);
}
#[test]
fn fractional_timeout() {
    invalid_timeout(1.5);
}
#[test]
fn nan_timeout() {
    invalid_timeout(f64::NAN);
}
#[test]
fn infinite_timeout() {
    invalid_timeout(f64::INFINITY);
}
#[test]
fn overflow_timeout() {
    invalid_timeout(2_147_483_648.0);
}
fn cancelled_fixture(kind: &str, timeout: bool) {
    let root = fixture("native-command-cancel-");
    let signal = Arc::new(AtomicBool::new(false));
    let mut request = fixture_request(kind, root.path());
    request.signal = Some(signal.clone());
    request.allow_failure = true;
    request.timeout = Some(if timeout {
        Duration::from_secs(1)
    } else {
        Duration::from_secs(5)
    });
    let running = thread::spawn(move || NativeRunner.run(request));
    eventually(|| root.path().join("pid").exists());
    let pid: i32 = fs::read_to_string(root.path().join("pid"))
        .unwrap()
        .parse()
        .unwrap();
    if !timeout {
        signal.store(true, Ordering::SeqCst);
    }
    let error = running.join().unwrap().unwrap_err();
    assert!(
        error
            .to_string()
            .contains(if timeout { "timed out" } else { "interrupted" })
    );
    if kind == "graceful" {
        assert_eq!(
            fs::read_to_string(root.path().join("cleaned")).unwrap(),
            "cleaned"
        );
    }
    #[cfg(unix)]
    {
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }
    #[cfg(windows)]
    assert!(!commands::process_running(pid as u32));
    assert_eq!(Arc::strong_count(&signal), 1);
}
#[test]
#[cfg(unix)]
fn graceful_cleanup_success_still_cancelled() {
    cancelled_fixture("graceful", false);
}
#[test]
fn abort_sigterm_ignored() {
    cancelled_fixture("ignore", false);
}
#[test]
fn timeout_sigterm_ignored() {
    cancelled_fixture("ignore", true);
}
#[test]
fn releases_cancellation_after_exit() {
    let root = fixture("native-command-cancellation-release-");
    let signal = Arc::new(AtomicBool::new(false));
    let mut request = fixture_request("success", root.path());
    request.signal = Some(signal.clone());
    request.timeout = Some(Duration::from_secs(1));
    NativeRunner.run(request).unwrap();
    assert_eq!(Arc::strong_count(&signal), 1);
    signal.store(true, Ordering::SeqCst);
    assert!(root.path().join("pid").is_file());
    #[cfg(unix)]
    {
        let pid: i32 = fs::read_to_string(root.path().join("pid"))
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    }
}

enum CheckAnswer {
    Text(String),
    Error(String),
    Io(std::io::ErrorKind),
    Cancel,
}
struct CheckMock {
    answers: Mutex<VecDeque<CheckAnswer>>,
    calls: Mutex<Vec<Request>>,
}
impl CheckMock {
    fn new(answers: Vec<CheckAnswer>) -> Self {
        Self {
            answers: Mutex::new(answers.into()),
            calls: Mutex::new(Vec::new()),
        }
    }
    fn requests(&self) -> Vec<Request> {
        self.calls.lock().unwrap().clone()
    }
}
impl Runner for CheckMock {
    fn run(&self, request: Request) -> Result<Output> {
        assert_eq!(request.program, "podman");
        assert_eq!(request.timeout, Some(Duration::from_secs(10)));
        assert!(request.signal.is_some());
        assert!(!request.allow_failure);
        self.calls.lock().unwrap().push(request.clone());
        match self
            .answers
            .lock()
            .unwrap()
            .pop_front()
            .expect("Unexpected check command")
        {
            CheckAnswer::Text(stdout) => Ok(Output {
                stdout,
                stderr: String::new(),
            }),
            CheckAnswer::Error(error) => bail!("{error}"),
            CheckAnswer::Io(kind) => Err(std::io::Error::from(kind).into()),
            CheckAnswer::Cancel => {
                request.signal.unwrap().store(true, Ordering::SeqCst);
                bail!("Command interrupted");
            }
        }
    }
}
fn text(value: impl Into<String>) -> CheckAnswer {
    CheckAnswer::Text(value.into())
}
fn machines(value: Value) -> CheckAnswer {
    text(serde_json::to_string(&value).unwrap())
}
fn check(mock: &CheckMock, platform: Platform) -> Result<()> {
    check_with(mock, platform, Arc::new(AtomicBool::new(false)), None, None)
}
fn missing(platform: Platform, guidance: &str) {
    for _ in 0..2 {
        let mock = CheckMock::new(vec![CheckAnswer::Io(std::io::ErrorKind::NotFound)]);
        let error = check(&mock, platform).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Podman executable was not found on PATH")
        );
        assert!(error.to_string().contains(guidance));
        assert_eq!(mock.requests()[0].args, ["--version"]);
        assert_eq!(mock.requests().len(), 1);
    }
}
#[test]
fn windows_missing() {
    missing(
        Platform::Windows,
        "winget install --id RedHat.Podman --exact",
    );
}
#[test]
fn mac_missing() {
    missing(Platform::Mac, "brew install podman");
}
#[test]
fn linux_missing() {
    missing(Platform::Linux, "sudo apt-get install podman");
}
#[test]
fn permission_not_missing() {
    let mock = CheckMock::new(vec![CheckAnswer::Io(std::io::ErrorKind::PermissionDenied)]);
    let error = check(&mock, Platform::Linux).unwrap_err().to_string();
    assert!(error.contains("executable permissions"));
    assert!(!error.contains("not found"));
}
fn vm_before_backend(platform: Platform) {
    let mut answers = vec![text("podman version 5.8.3\n")];
    if platform != Platform::Linux {
        answers.push(machines(
            json!([{"Name":"my-vm","Running":true,"Default":true}]),
        ));
    }
    answers.push(text("linux\n"));
    let mock = CheckMock::new(answers);
    check(&mock, platform).unwrap();
    let requests = mock.requests();
    assert_eq!(requests[0].args, ["--version"]);
    if platform != Platform::Linux {
        assert_eq!(requests[1].args, ["machine", "list", "--format", "json"]);
    }
    assert_eq!(
        requests.last().unwrap().args,
        ["info", "--format", "{{.Host.OS}}"]
    );
    assert_eq!(
        requests.len(),
        if platform == Platform::Linux { 2 } else { 3 }
    );
}
#[test]
fn linux_backend() {
    vm_before_backend(Platform::Linux);
}
#[test]
fn mac_vm_before_backend() {
    vm_before_backend(Platform::Mac);
}
#[test]
fn windows_vm_before_backend() {
    vm_before_backend(Platform::Windows);
}
#[test]
fn non_linux_backend() {
    let mock = CheckMock::new(vec![text("version"), text("freebsd\n")]);
    let error = check(&mock, Platform::Linux).unwrap_err().to_string();
    assert!(error.contains("requires a Linux Podman backend"));
    assert!(error.contains("\"freebsd\""));
}
#[test]
fn linux_diagnostic() {
    let mock = CheckMock::new(vec![
        text("version"),
        CheckAnswer::Error("rootless permissions failure".into()),
    ]);
    let error = check(&mock, Platform::Linux).unwrap_err().to_string();
    assert!(error.contains("runtime is unavailable"));
    assert!(error.contains("rootless permissions failure"));
    assert!(!error.contains("machine init"));
    assert_eq!(mock.requests().len(), 2);
}
fn machine_diagnoses(platform: Platform) {
    for (status, message, connection, unreachable) in [
        (json!([]), "No Podman machine exists", false, false),
        (
            json!([{"Name":"my-vm","Running":false}]),
            "start --update-connection \"my-vm\"",
            false,
            false,
        ),
        (
            json!([{"Name":"other","Running":false},{"Name":"default","Running":false,"Default":true}]),
            "start --update-connection \"default\"",
            false,
            false,
        ),
        (
            json!([{"Name":"unrelated","Running":true},{"Name":"required","Running":false,"Default":true}]),
            "start --update-connection \"required\"",
            false,
            false,
        ),
        (
            json!([{"Name":"my-vm","Running":false,"Starting":true}]),
            "is still starting",
            false,
            false,
        ),
        (
            json!([{"Name":"my-vm","Running":true,"Starting":true}]),
            "is still starting",
            false,
            false,
        ),
        (
            json!([{"Name":"one","Running":true},{"Name":"two","Running":false}]),
            "Cannot identify the selected Podman machine",
            true,
            false,
        ),
        (
            json!([{"Name":"one","Running":false},{"Name":"two","Running":false}]),
            "Available machines",
            false,
            false,
        ),
        (
            json!([{"Name":"my-vm","Running":true}]),
            "active connection is not reachable",
            false,
            true,
        ),
    ] {
        let mut answers = vec![text("version"), machines(status)];
        if connection {
            answers.push(text("[]"));
        }
        if unreachable {
            answers.push(CheckAnswer::Error("connection refused".into()));
        }
        let mock = CheckMock::new(answers);
        assert!(
            check(&mock, platform)
                .unwrap_err()
                .to_string()
                .contains(message),
            "{message}"
        );
        if !unreachable {
            assert!(!mock.requests().iter().any(|r| r.args[0] == "info"));
        }
    }
}
#[test]
fn mac_machine_diagnoses() {
    machine_diagnoses(Platform::Mac);
}
#[test]
fn windows_machine_diagnoses() {
    machine_diagnoses(Platform::Windows);
}
fn rootful(platform: Platform) {
    for running in [false, true] {
        let mut answers = vec![
            text("version"),
            machines(
                json!([{"Name":"unrelated","Running":true,"Default":false,"Port":50001},{"Name":"required","Running":running,"Default":false,"Port":50002}]),
            ),
            machines(
                json!([{"Name":"required-root","URI":"ssh://root@127.0.0.1:50002/run/podman/podman.sock","Default":true}]),
            ),
        ];
        if running {
            answers.push(text("linux"));
        }
        let mock = CheckMock::new(answers);
        let result = check(&mock, platform);
        if running {
            result.unwrap();
        } else {
            assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("Podman machine \"required\" is stopped")
            );
        }
        assert_eq!(
            mock.requests()[2].args,
            ["system", "connection", "list", "--format", "json"]
        );
        assert_eq!(mock.requests().len(), if running { 4 } else { 3 });
    }
}
#[test]
fn mac_selected_rootful() {
    rootful(Platform::Mac);
}
#[test]
fn windows_selected_rootful() {
    rootful(Platform::Windows);
}
fn overridden(platform: Platform, override_kind: &str) {
    let uri = "ssh://root@127.0.0.1:50002/run/podman/podman.sock";
    for running in [false, true] {
        let mut answers = vec![
            text("version"),
            machines(
                json!([{"Name":"default","Running":!running,"Default":true,"Port":50001},{"Name":"required","Running":running,"Default":false,"Port":50002}]),
            ),
            machines(
                json!([{"Name":"default","URI":"ssh://root@127.0.0.1:50001/run/podman/podman.sock","Default":true},{"Name":"required-root","URI":uri,"Default":false}]),
            ),
        ];
        if running {
            answers.push(text("linux"));
        }
        let mock = CheckMock::new(answers);
        let connection = (override_kind != "host").then(|| "required-root".into());
        let host = (override_kind != "connection").then(|| {
            if override_kind == "both" {
                "ssh://root@127.0.0.1:50001/run/podman/podman.sock".into()
            } else {
                uri.into()
            }
        });
        let result = check_with(
            &mock,
            platform,
            Arc::new(AtomicBool::new(false)),
            connection,
            host,
        );
        if running {
            result.unwrap();
        } else {
            assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("Podman machine \"required\" is stopped")
            );
            assert_eq!(mock.requests().len(), 3);
        }
    }
}
#[test]
fn mac_connection_override() {
    overridden(Platform::Mac, "connection");
}
#[test]
fn mac_host_override() {
    overridden(Platform::Mac, "host");
}
#[test]
fn mac_connection_precedes_host() {
    overridden(Platform::Mac, "both");
}
#[test]
fn windows_connection_override() {
    overridden(Platform::Windows, "connection");
}
#[test]
fn windows_host_override() {
    overridden(Platform::Windows, "host");
}
#[test]
fn windows_connection_precedes_host() {
    overridden(Platform::Windows, "both");
}
fn unknown_override(connection: bool) {
    let mock = CheckMock::new(vec![
        text("version"),
        machines(json!([{"Name":"default","Running":true,"Default":true,"Port":50001}])),
        machines(
            json!([{"Name":"default","URI":"ssh://root@127.0.0.1:50001/run/podman/podman.sock","Default":true}]),
        ),
    ]);
    let result = check_with(
        &mock,
        Platform::Windows,
        Arc::new(AtomicBool::new(false)),
        connection.then(|| "unknown".into()),
        (!connection).then(|| "ssh://root@127.0.0.1:50002/run/podman/podman.sock".into()),
    );
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("Cannot identify the selected Podman machine")
    );
    assert_eq!(mock.requests().len(), 3);
}
#[test]
fn unknown_connection_no_fallback() {
    unknown_override(true);
}
#[test]
fn unknown_host_no_fallback() {
    unknown_override(false);
}
#[test]
fn connection_listing_failure() {
    let mock = CheckMock::new(vec![
        text("version"),
        machines(
            json!([{"Name":"one","Running":true,"Default":false},{"Name":"two","Running":false,"Default":false}]),
        ),
        CheckAnswer::Error("connection listing failed".into()),
    ]);
    let error = check(&mock, Platform::Windows).unwrap_err().to_string();
    assert!(error.contains("connection listing failed"));
    assert!(error.contains("Could not determine the selected Podman connection"));
    assert_eq!(mock.requests().len(), 3);
}
fn stopped_before_backend(platform: Platform) {
    let mock = CheckMock::new(vec![
        text("version"),
        machines(json!([{"Name":"required-vm","Running":false,"Default":true}])),
        text("linux\n"),
    ]);
    assert!(
        check(&mock, platform)
            .unwrap_err()
            .to_string()
            .contains("Podman machine \"required-vm\" is stopped")
    );
    assert_eq!(mock.requests().len(), 2);
    assert_eq!(mock.answers.lock().unwrap().len(), 1);
}
#[test]
fn mac_stopped_before_backend() {
    stopped_before_backend(Platform::Mac);
}
#[test]
fn windows_stopped_before_backend() {
    stopped_before_backend(Platform::Windows);
}
fn malformed_machine(output: &str) {
    let mock = CheckMock::new(vec![text("version"), text(output)]);
    assert!(
        check(&mock, Platform::Windows)
            .unwrap_err()
            .to_string()
            .contains("Could not determine Podman machine status")
    );
    assert_eq!(mock.requests().len(), 2);
}
#[test]
fn machine_invalid_json() {
    malformed_machine("invalid json");
}
#[test]
fn machine_not_array() {
    malformed_machine("{}");
}
#[test]
fn machine_missing_status() {
    malformed_machine("[{\"Name\":\"bad-status\"}]");
}
#[test]
fn machine_listing_failure() {
    let mock = CheckMock::new(vec![
        text("version"),
        CheckAnswer::Error("machine listing failed".into()),
    ]);
    let error = check(&mock, Platform::Mac).unwrap_err().to_string();
    assert!(error.contains("Could not determine Podman machine status"));
    assert!(error.contains("machine listing failed"));
}
#[test]
fn precancel_no_spawn() {
    let mock = CheckMock::new(vec![]);
    assert!(
        check_with(
            &mock,
            Platform::Windows,
            Arc::new(AtomicBool::new(true)),
            None,
            None
        )
        .unwrap_err()
        .to_string()
        .contains("interrupted")
    );
    assert!(mock.requests().is_empty());
}
#[test]
fn cancel_vm_diagnosis() {
    let mock = CheckMock::new(vec![text("version"), CheckAnswer::Cancel]);
    let error = check(&mock, Platform::Windows).unwrap_err().to_string();
    assert_eq!(error, "ScriptFS startup was interrupted");
    assert_eq!(mock.requests().len(), 2);
}
#[test]
fn cancel_backend_diagnosis() {
    let mock = CheckMock::new(vec![
        text("version"),
        machines(json!([{"Name":"my-vm","Running":true,"Default":true}])),
        CheckAnswer::Cancel,
    ]);
    assert_eq!(
        check(&mock, Platform::Windows).unwrap_err().to_string(),
        "ScriptFS startup was interrupted"
    );
    assert_eq!(mock.requests().len(), 3);
}

fn mount_unmount_failure(platform: Platform) {
    let mut fixture = Fixture::new();
    if platform == Platform::Windows {
        fixture.input["filesystems"][0]["mountPoint"] = json!("S:");
    }
    let mut session = fixture.start_on(platform);
    let mounted = fixture.mock.calls("mount");
    assert_eq!(mounted.len(), 1);
    match platform {
        Platform::Mac => {
            assert_eq!(mounted[0].program, "/sbin/mount_smbfs");
            assert_eq!(
                mounted[0].args,
                args(&[
                    "-N",
                    "-o",
                    "nomdatacache,nodatacache",
                    "//guest:@127.0.0.1:14445/test",
                    fixture.root.path().join("mount").to_str().unwrap()
                ])
            );
        }
        Platform::Linux => assert_eq!(
            mounted[0].args,
            args(&[
                "-t",
                "cifs",
                "//127.0.0.1/test",
                fixture.root.path().join("mount").to_str().unwrap(),
                "-o",
                "guest,port=14445,vers=3.0"
            ])
        ),
        Platform::Windows => assert_eq!(mounted[0].program, "powershell.exe"),
    }
    fixture.mock.fail_once("unmount", "Resource busy");
    assert!(
        session
            .stop()
            .unwrap_err()
            .to_string()
            .contains("Resource busy")
    );
    let unmount = &fixture.mock.calls("unmount")[0];
    assert!(unmount.signal.is_none());
    match platform {
        Platform::Windows => {
            assert_eq!(unmount.program, "net");
            assert_eq!(unmount.args, ["use", "S:", "/delete", "/yes"]);
        }
        Platform::Mac => assert_eq!(unmount.program, "/sbin/umount"),
        Platform::Linux => assert_eq!(unmount.program, "umount"),
    }
    session.stop().unwrap();
}
#[test]
fn mac_unmount_failure() {
    mount_unmount_failure(Platform::Mac);
}
#[test]
fn linux_unmount_failure() {
    mount_unmount_failure(Platform::Linux);
}
#[test]
fn windows_unmount_failure() {
    mount_unmount_failure(Platform::Windows);
}
fn authenticated_mapping(port: u16) {
    let (mount, request) = mount_request(
        Platform::Windows,
        "127.0.0.1",
        port,
        "test",
        Path::new("s:"),
        Some(Path::new("C:\\User's temp\\credentials.json")),
    )
    .unwrap();
    assert_eq!(mount, Path::new("S:"));
    assert_eq!(request.program, "powershell.exe");
    assert_eq!(
        &request.args[..3],
        ["-NoProfile", "-NonInteractive", "-Command"]
    );
    let script = &request.args[3];
    assert!(script.contains("C:\\User''s temp\\credentials.json"));
    assert!(script.contains("$mapping.Password = $credentials.password"));
    assert!(script.contains("New-SmbMapping @mapping"));
    if port != 445 {
        assert!(script.contains("Parameters.ContainsKey('TcpPort')"));
        assert!(script.contains("$mapping.TcpPort = 14445"));
    } else {
        assert!(!script.contains("$mapping.TcpPort"));
    }
    let unmount = unmount_request(Platform::Windows, &mount).unwrap();
    assert_eq!(unmount.program, "net");
    assert_eq!(unmount.args, ["use", "S:", "/delete", "/yes"]);
    assert!(unmount.signal.is_none());
}
#[test]
fn windows_auth_standard_port() {
    authenticated_mapping(445);
}
#[test]
fn windows_auth_alternate_port() {
    authenticated_mapping(14445);
}

fn cli_exit(kind: &str, code: i32) {
    let root = fixture("native-cli-");
    let mut request = fixture_request(kind, root.path());
    request.timeout = Some(Duration::from_secs(3));
    if code == 1 {
        let error = NativeRunner.run(request).unwrap_err().to_string();
        assert!(error.contains("failed with exit code 1"));
        assert!(error.contains("cleanup completed"));
        assert!(error.contains("scriptfs container test-container exited with status 137"));
    } else {
        let output = NativeRunner.run(request).unwrap();
        assert!(output.stdout.contains("cleanup completed"));
        assert_eq!(output.stderr, "");
    }
}
#[test]
fn runtime_failure_exits_without_signal() {
    cli_exit("cli-failure", 1);
}
#[test]
fn stopped_exits_without_signal() {
    cli_exit("cli-stopped", 0);
}
#[test]
#[cfg(unix)]
fn pending_session_sigterm() {
    let root = fixture("native-cli-signal-");
    let request = fixture_request("cli-signal", root.path());
    let mut command = Command::new(&request.program);
    command
        .args(&request.args)
        .envs(request.env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    let mut reader = std::io::BufReader::new(child.stdout.take().unwrap());
    let mut output = String::new();
    loop {
        let mut line = String::new();
        assert!(reader.read_line(&mut line).unwrap() > 0);
        output.push_str(&line);
        if line.contains("scriptfs is running") {
            break;
        }
    }
    assert!(child.try_wait().unwrap().is_none());
    assert_eq!(unsafe { libc::kill(child.id() as i32, libc::SIGTERM) }, 0);
    use std::io::Read;
    reader.read_to_string(&mut output).unwrap();
    let status = child.wait().unwrap();
    assert!(status.success(), "{status}: {output}");
    assert!(output.contains("cleanup completed"));
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    assert_eq!(stderr, "");
}
#[test]
fn check_only_no_mount_configuration() {
    let fixture = Fixture::new();
    let mock = Arc::new(CheckMock::new(vec![text("version"), text("linux\n")]));
    run_with(
        None,
        fixture.stop.clone(),
        mock.clone(),
        fixture.settings(Platform::Linux),
    )
    .unwrap();
    assert_eq!(
        mock.requests()
            .iter()
            .map(|r| r.args[0].as_str())
            .collect::<Vec<_>>(),
        ["--version", "info"]
    );
    assert!(fixture.mock.config_path.lock().unwrap().is_none());
}
fn cli_missing(argument: Option<&str>) {
    let fixture = Fixture::new();
    let mock = Arc::new(CheckMock::new(vec![CheckAnswer::Io(
        std::io::ErrorKind::NotFound,
    )]));
    let error = run_with(
        argument,
        fixture.stop.clone(),
        mock.clone(),
        fixture.settings(Platform::Linux),
    )
    .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("Podman executable was not found on PATH")
    );
    assert_eq!(mock.requests().len(), 1);
    assert!(fixture.mock.config_path.lock().unwrap().is_none());
}
#[test]
fn missing_podman_before_config_mount_resources() {
    cli_missing(Some("nonexistent-config-to-prove-no-load.json"));
}
#[test]
fn missing_podman_check_only() {
    cli_missing(None);
}

#[test]
fn sdk_config_protocol_validates_without_path_resolution_or_podman() {
    let root = fixture("native-sdk-config-");
    let config = json!({"modules":{"data":{"manifest":"not-installed-module","secrets":{"token":{"env":"UNSET_TOKEN"}}}},
        "filesystems":[{"name":"test","source":"nonexistent-source","mountPoint":"relative","rules":[
            {"match":"data","provider":{"module":"data"}}]}]});
    let mut request = fixture_request("sdk-config", root.path());
    request.input = Some(format!("{}\n", json!({"op":"validate","config":config})).into_bytes());
    let output = NativeRunner.run(request).unwrap();
    let frame = protocol_frame(&output.stdout, "config");
    assert_eq!(frame["config"], config);
}

#[test]
fn sdk_config_provider_options_preserve_absence_null_and_literal_json() {
    let root = fixture("native-sdk-validate-provider-options-");
    for options in [
        None,
        Some(Value::Null),
        Some(json!(false)),
        Some(json!(0)),
        Some(json!({"$date":1234,"nested":{"$date":5678}})),
    ] {
        let mut config = json!({"modules":{"data":{"manifest":"not-installed-module"}},"filesystems":[{"name":"test","source":"nonexistent-source","mountPoint":"relative","rules":[{"match":"data","provider":{"module":"data"}}]}]});
        if let Some(options) = &options {
            config["filesystems"][0]["rules"][0]["provider"]["options"] = options.clone();
        }
        let mut request = fixture_request("sdk-config", root.path());
        request.input =
            Some(format!("{}\n", json!({"op":"validate","config":config})).into_bytes());
        let output = NativeRunner.run(request).unwrap();
        let frame = protocol_frame(&output.stdout, "config");
        assert_eq!(frame["config"], config);
        assert_eq!(
            frame["config"]["filesystems"][0]["rules"][0]["provider"].get("options"),
            options.as_ref()
        );
    }
}

#[test]
fn sdk_config_loaded_provider_options_preserve_absence_and_explicit_null() {
    let root = fixture("native-sdk-load-provider-options-");
    write(
        root.path().join("module").join(module::MANIFEST_FILE),
        r#"{"name":"data","entry":"index.mjs"}"#,
    );
    write(root.path().join("module/index.mjs"), "export default {};");
    let path = root.path().join("config.json");
    for options in [
        None,
        Some(Value::Null),
        Some(json!({"$date":1234,"nested":{"$date":5678}})),
    ] {
        let mut config = json!({"modules":{"data":{"manifest":"./module"}},"filesystems":[{"name":"test","source":root.path(),"mountPoint":"mount","rules":[{"match":"data","provider":{"module":"data"}}]}]});
        if let Some(options) = &options {
            config["filesystems"][0]["rules"][0]["provider"]["options"] = options.clone();
        }
        write(&path, serde_json::to_vec(&config).unwrap());
        let mut request = fixture_request("sdk-config", root.path());
        request.input = Some(format!("{}\n", json!({"op":"load","configPath":path})).into_bytes());
        let output = NativeRunner.run(request).unwrap();
        let frame = protocol_frame(&output.stdout, "config");
        let provider = &frame["config"]["filesystems"][0]["rules"][0]["provider"];
        assert_eq!(provider["module"], "data");
        assert_eq!(provider.get("options"), options.as_ref());
        assert_eq!(
            frame["config"]["modules"]["data"]["manifest"],
            json!(root.path().join("module").join(module::MANIFEST_FILE))
        );
    }
}

#[test]
fn sdk_config_protocol_load_uses_real_module_resolution() {
    let root = fixture("native-sdk-load-");
    write(
        root.path()
            .join("node_modules/provider")
            .join(module::MANIFEST_FILE),
        r#"{"name":"provider","entry":"index.mjs","state":true}"#,
    );
    write(
        root.path().join("node_modules/provider/index.mjs"),
        "export default {}",
    );
    let path = root.path().join("config.json");
    write(&path, serde_json::to_vec(&json!({"modules":{"provider":{"manifest":"provider"}},"filesystems":[{"name":"test","source":".","mountPoint":"mount","rules":[{"match":"data","provider":{"module":"provider"}}]}]})).unwrap());
    let mut request = fixture_request("sdk-config", root.path());
    request.input = Some(format!("{}\n", json!({"op":"load","configPath":path})).into_bytes());
    let output = NativeRunner.run(request).unwrap();
    let frame = protocol_frame(&output.stdout, "config");
    assert_eq!(
        frame["config"]["filesystems"][0]["source"],
        json!(root.path())
    );
    assert_eq!(
        frame["config"]["modules"]["provider"],
        json!({
            "manifest": root.path().join("node_modules").join("provider").join(module::MANIFEST_FILE),
            "state": root.path().join(".scriptfs").join("state").join("provider")
        })
    );
}
#[test]
fn sdk_config_protocol_validation_error_is_nonzero() {
    let root = fixture("native-sdk-invalid-");
    let mut request = fixture_request("sdk-config", root.path());
    request.input =
        Some(format!("{}\n", json!({"op":"validate","config":{"filesystems":[]}})).into_bytes());
    let error = NativeRunner.run(request).unwrap_err().to_string();
    assert!(error.contains("failed with exit code 1"));
    let frame = protocol_frame(&error, "error");
    assert!(
        frame["message"]
            .as_str()
            .unwrap()
            .contains("At least one filesystem")
    );
}
fn protocol_frame(output: &str, event: &str) -> Value {
    output
        .lines()
        .filter_map(|line| line.strip_prefix("SCRIPTFS_SDK:"))
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|frame| frame["event"] == event)
        .unwrap_or_else(|| panic!("No {event} frame: {output}"))
}
struct Bridge {
    child: Child,
    reader: std::io::BufReader<std::process::ChildStdout>,
    input: Option<std::process::ChildStdin>,
}
impl Bridge {
    fn start(kind: &str, root: &Path) -> Self {
        let request = fixture_request(kind, root);
        let mut child = Command::new(request.program)
            .args(request.args)
            .envs(request.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let reader = std::io::BufReader::new(child.stdout.take().unwrap());
        let mut input = child.stdin.take().unwrap();
        writeln!(input, "{}", json!({"op":"start","config":{"filesystems":[{"name":"test","source":root,"mountPoint":root.join("mount")}],"container":{"logLevel":"silent"}}})).unwrap();
        input.flush().unwrap();
        Self {
            child,
            reader,
            input: Some(input),
        }
    }
    fn frame(&mut self) -> Value {
        loop {
            let mut line = String::new();
            assert!(
                self.reader.read_line(&mut line).unwrap() > 0,
                "Bridge exited before a frame"
            );
            if let Some(json) = line.strip_prefix("SCRIPTFS_SDK:") {
                return serde_json::from_str(json).unwrap();
            }
        }
    }
    fn stop(&mut self) {
        let input = self.input.as_mut().unwrap();
        writeln!(input, "{}", json!({"op":"stop"})).unwrap();
        input.flush().unwrap();
    }
}
impl Drop for Bridge {
    fn drop(&mut self) {
        self.input.take();
        if self.child.try_wait().unwrap().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}
#[test]
fn sdk_bridge_ready_stop_and_eof_use_native_lifecycle() {
    for eof in [false, true] {
        let root = fixture("native-sdk-session-");
        let mut bridge = Bridge::start("sdk-session", root.path());
        let ready = bridge.frame();
        assert_eq!(ready["event"], "ready");
        assert_eq!(ready["containerId"], "test-container");
        assert_eq!(
            ready["mounts"],
            json!([["test", root.path().join("mount")]])
        );
        if eof {
            bridge.input.take();
        } else {
            bridge.stop();
        }
        let stopped = bridge.frame();
        assert_eq!(stopped["event"], "stopped");
        assert_eq!(stopped["mounts"], json!([]));
        assert!(bridge.child.wait().unwrap().success());
        assert!(!fs::read_dir(root.path()).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".scriptfs-runtime-")
        }));
    }
}
#[test]
fn sdk_bridge_failed_stop_exposes_retryable_session() {
    let root = fixture("native-sdk-busy-");
    let mut bridge = Bridge::start("sdk-session-busy", root.path());
    assert_eq!(bridge.frame()["event"], "ready");
    bridge.stop();
    let error = bridge.frame();
    assert_eq!(error["event"], "error");
    assert_eq!(error["phase"], "stop");
    assert_eq!(error["retryable"], true);
    assert_eq!(error["containerId"], "test-container");
    assert_eq!(error["mounts"].as_array().unwrap().len(), 1);
    assert!(error["message"].as_str().unwrap().contains("Resource busy"));
    assert!(bridge.child.try_wait().unwrap().is_none());
    bridge.stop();
    assert_eq!(bridge.frame()["event"], "stopped");
    assert!(bridge.child.wait().unwrap().success());
}
#[test]
fn sdk_bridge_cleanup_errors_preserve_each_cause_and_retry_state() {
    let root = fixture("native-sdk-stop-remove-busy-");
    let mut bridge = Bridge::start("sdk-session-stop-remove-busy", root.path());
    assert_eq!(bridge.frame()["event"], "ready");
    bridge.stop();
    let error = bridge.frame();
    assert_eq!(error["event"], "error");
    assert_eq!(error["phase"], "stop");
    assert_eq!(error["retryable"], true);
    assert_eq!(error["containerId"], "test-container");
    assert_eq!(error["mounts"], json!([]));
    let errors = error["errors"].as_array().unwrap();
    assert_eq!(errors.len(), 2);
    assert!(errors[0].as_str().unwrap().contains("stop failed"));
    assert!(errors[1].as_str().unwrap().contains("remove failed"));
    assert!(error["message"].as_str().unwrap().contains("stop failed"));
    assert!(error["message"].as_str().unwrap().contains("remove failed"));
    assert!(bridge.child.try_wait().unwrap().is_none());
    bridge.stop();
    assert_eq!(bridge.frame()["event"], "stopped");
    assert!(bridge.child.wait().unwrap().success());
}
#[test]
fn sdk_bridge_unexpected_exit_reports_runtime_error_and_cleanup() {
    let root = fixture("native-sdk-exit-");
    let mut bridge = Bridge::start("sdk-session-exit", root.path());
    assert_eq!(bridge.frame()["event"], "ready");
    let error = bridge.frame();
    assert_eq!(error["event"], "error");
    assert_eq!(error["phase"], "runtime");
    assert!(error["message"].as_str().unwrap().contains("status 42"));
    assert_eq!(bridge.frame()["event"], "stopped");
    assert_eq!(bridge.child.wait().unwrap().code(), Some(1));
}

#[test]
#[cfg(unix)]
fn sdk_bridge_signal_stops_the_real_native_session_service() {
    let root = fixture("native-sdk-signal-");
    let mut bridge = Bridge::start("sdk-session", root.path());
    assert_eq!(bridge.frame()["event"], "ready");
    assert_eq!(
        unsafe { libc::kill(bridge.child.id() as i32, libc::SIGTERM) },
        0
    );
    assert_eq!(bridge.frame()["event"], "stopped");
    assert!(bridge.child.wait().unwrap().success());
}

#[test]
fn sdk_bridge_preflight_failure_reports_empty_stopped_without_recovery() {
    let root = fixture("native-sdk-preflight-failure-");
    let mut bridge = Bridge::start("sdk-session-preflight-error", root.path());
    let error = bridge.frame();
    assert_eq!(error["event"], "error");
    assert_eq!(error["phase"], "startup");
    assert_eq!(error["startupError"], false);
    assert_eq!(error["retryable"], false);
    assert_eq!(error["containerId"], "");
    assert_eq!(error["mounts"], json!([]));
    assert!(
        error["message"]
            .as_str()
            .unwrap()
            .contains("Podman unavailable")
    );
    assert_eq!(
        bridge.frame(),
        json!({"event":"stopped","containerId":"","mounts":[]})
    );
    assert!(!bridge.child.wait().unwrap().success());
}

#[test]
fn sdk_bridge_missing_create_id_preserves_preassigned_name_for_recovery() {
    let root = fixture("native-sdk-create-empty-busy-");
    let mut bridge = Bridge::start("sdk-session-create-empty-busy", root.path());
    let error = bridge.frame();
    eventually(|| root.path().join("create-name").is_file());
    let name = fs::read_to_string(root.path().join("create-name")).unwrap();
    assert!(name.starts_with("scriptfs-"));
    assert_eq!(error["event"], "error");
    assert_eq!(error["phase"], "startup");
    assert_eq!(error["containerId"], name);
    assert_eq!(error["startupError"], true);
    assert_eq!(error["retryable"], true);
    assert_eq!(error["mounts"], json!([]));
    assert!(
        error["errors"][0]
            .as_str()
            .unwrap()
            .contains("Podman returned no container ID")
    );
    assert!(
        error["errors"][1]
            .as_str()
            .unwrap()
            .contains("remove failed")
    );
    assert!(bridge.child.try_wait().unwrap().is_none());
    bridge.stop();
    let stopped = bridge.frame();
    assert_eq!(stopped["event"], "stopped");
    assert_eq!(stopped["containerId"], name);
    assert_eq!(stopped["mounts"], json!([]));
    assert!(!bridge.child.wait().unwrap().success());
}

#[test]
fn sdk_bridge_cancelled_create_retains_name_until_explicit_cleanup_retry() {
    let root = fixture("native-sdk-create-cancel-busy-");
    let mut bridge = Bridge::start("sdk-session-create-cancel-busy", root.path());
    eventually(|| root.path().join("create-name").is_file());
    let name = fs::read_to_string(root.path().join("create-name")).unwrap();
    bridge.stop();
    let error = bridge.frame();
    assert_eq!(error["event"], "error");
    assert_eq!(error["phase"], "startup");
    assert_eq!(error["containerId"], name);
    assert!(name.starts_with("scriptfs-"));
    assert_eq!(error["startupError"], true);
    assert_eq!(error["retryable"], true);
    assert_eq!(error["mounts"], json!([]));
    assert!(error["errors"][0].as_str().unwrap().contains("interrupted"));
    assert!(
        error["errors"][1]
            .as_str()
            .unwrap()
            .contains("remove failed")
    );
    thread::sleep(Duration::from_millis(50));
    assert!(bridge.child.try_wait().unwrap().is_none());
    assert!(fs::read_dir(root.path()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".scriptfs-runtime-")
    }));
    bridge.stop();
    let stopped = bridge.frame();
    assert_eq!(stopped["event"], "stopped");
    assert_eq!(stopped["containerId"], name);
    assert_eq!(stopped["mounts"], json!([]));
    assert!(!bridge.child.wait().unwrap().success());
}

#[test]
fn sdk_bridge_completed_startup_rollback_reports_stopped_before_nonzero_exit() {
    for aggregate in [false, true] {
        let root = fixture("native-sdk-startup-clean-");
        let mut bridge = Bridge::start(
            if aggregate {
                "sdk-session-start-clean-aggregate"
            } else {
                "sdk-session-start-clean"
            },
            root.path(),
        );
        let error = bridge.frame();
        assert_eq!(error["event"], "error");
        assert_eq!(error["phase"], "startup");
        assert_eq!(error["startupError"], false);
        assert_eq!(error["retryable"], false);
        assert_eq!(error["containerId"], "test-container");
        assert_eq!(error["mounts"], json!([]));
        assert_eq!(
            error["errors"].as_array().unwrap().len(),
            if aggregate { 2 } else { 1 }
        );
        assert!(
            error["message"]
                .as_str()
                .unwrap()
                .contains("SMB port already in use")
        );
        if aggregate {
            assert!(
                error["errors"][1]
                    .as_str()
                    .unwrap()
                    .contains("Unable to capture startup diagnostics")
            );
        }
        let stopped = bridge.frame();
        assert_eq!(stopped["event"], "stopped");
        assert_eq!(stopped["containerId"], "test-container");
        assert_eq!(stopped["mounts"], json!([]));
        assert!(!bridge.child.wait().unwrap().success());
        assert!(!fs::read_dir(root.path()).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".scriptfs-runtime-")
        }));
    }
}
#[test]
fn sdk_bridge_startup_and_cleanup_errors_preserve_recovery_state() {
    let root = fixture("native-sdk-startup-busy-");
    let mut bridge = Bridge::start("sdk-session-start-busy", root.path());
    let error = bridge.frame();
    assert_eq!(error["event"], "error");
    assert_eq!(error["phase"], "startup");
    assert_eq!(error["startupError"], true);
    assert_eq!(error["containerId"], "test-container");
    assert_eq!(error["mounts"], json!([]));
    assert_eq!(error["retryable"], true);
    assert_eq!(error["errors"].as_array().unwrap().len(), 2);
    assert!(
        error["message"]
            .as_str()
            .unwrap()
            .contains("SMB port already in use")
    );
    assert!(error["message"].as_str().unwrap().contains("remove failed"));
    assert!(bridge.child.try_wait().unwrap().is_none());
    bridge.stop();
    assert_eq!(bridge.frame()["event"], "stopped");
    assert_eq!(bridge.child.wait().unwrap().code(), Some(1));
}

#[test]
fn native_command_drains_both_pipes_beyond_kernel_capacity() {
    let root = fixture("native-command-large-output-");
    let output = NativeRunner
        .run(fixture_request("large-output", root.path()))
        .unwrap();
    assert!(output.stdout.ends_with(&"a".repeat(4 * 1024 * 1024)));
    assert_eq!(output.stderr, "b".repeat(4 * 1024 * 1024));
}

#[test]
#[cfg(unix)]
fn native_command_cancels_inherited_descendant_pipes_after_parent_exits() {
    let root = fixture("native-command-descendant-");
    let signal = Arc::new(AtomicBool::new(false));
    let mut request = fixture_request("pipe-parent", root.path());
    request.signal = Some(signal.clone());
    request.timeout = Some(Duration::from_secs(5));
    request.allow_failure = true;
    let running = thread::spawn(move || NativeRunner.run(request));
    eventually(|| root.path().join("descendant/pid").exists());
    let parent: i32 = fs::read_to_string(root.path().join("pid"))
        .unwrap()
        .parse()
        .unwrap();
    let descendant: i32 = fs::read_to_string(root.path().join("descendant/pid"))
        .unwrap()
        .parse()
        .unwrap();
    eventually(|| unsafe { libc::kill(parent, 0) } < 0);
    let start = Instant::now();
    signal.store(true, Ordering::SeqCst);
    assert!(
        running
            .join()
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("interrupted")
    );
    assert!(start.elapsed() < Duration::from_secs(1));
    eventually(|| {
        if unsafe { libc::kill(descendant, 0) } < 0 {
            return true;
        }
        cfg!(target_os = "linux")
            && fs::read_to_string(format!("/proc/{descendant}/stat"))
                .is_ok_and(|stat| stat.split_whitespace().nth(2) == Some("Z"))
    });
}

#[test]
#[cfg(unix)]
fn native_command_timeout_cancels_a_blocked_large_stdin_writer() {
    let root = fixture("native-command-blocked-input-");
    let mut request = fixture_request("ignore", root.path());
    request.input = Some(vec![b'p'; 8 * 1024 * 1024]);
    request.timeout = Some(Duration::from_millis(100));
    request.allow_failure = true;
    let start = Instant::now();
    let error = NativeRunner.run(request).unwrap_err().to_string();
    assert!(error.contains("timed out"));
    assert!(!error.contains(&"p".repeat(64)));
    assert!(start.elapsed() < Duration::from_secs(3));
    let pid: i32 = fs::read_to_string(root.path().join("pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(unsafe { libc::kill(pid, 0) } < 0);
}
