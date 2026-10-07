#[path = "host_command.rs"]
pub mod commands;
use crate::{
    config::{Config, RuntimeConfig, absolute, public_config},
    module::{self, Port, Resolved},
};
use anyhow::{Context, Result, bail};
#[cfg(target_os = "linux")]
pub use commands::terminate;
use commands::{NativeRunner, Output, Request, Runner};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

/// Tag of runtime images built locally from the distribution's Containerfile.
const IMAGE: &str = "localhost/scriptfs-runtime:0.1.0";
/// Written into published packages by the release workflow; it pins the
/// runtime image pushed for that release. Checkouts have none.
const RELEASE_IMAGE_FILE: &str = "container/runtime-image.json";
fn is_package_root(root: &Path) -> bool {
    root.join("container/Containerfile").is_file() && root.join("package.json").is_file()
}
/// The npm launcher passes its package root because published binaries live in
/// separate platform packages; checkouts find it next to the executable or cwd.
pub fn package_root() -> Result<PathBuf> {
    package_root_from(std::env::var_os("SCRIPTFS_JS_ROOT"))
}
fn package_root_from(launcher_root: Option<std::ffi::OsString>) -> Result<PathBuf> {
    if let Some(root) = launcher_root {
        let root = PathBuf::from(root);
        if is_package_root(&root) {
            return Ok(root);
        }
        bail!(
            "SCRIPTFS_JS_ROOT {} is not a ScriptFS distribution (container/Containerfile is missing)",
            root.display()
        );
    }
    find_package_root([
        std::env::current_exe()?
            .parent()
            .context("Executable has no parent")?
            .to_path_buf(),
        std::env::current_dir()?,
    ])
}
fn find_package_root(starts: impl IntoIterator<Item = PathBuf>) -> Result<PathBuf> {
    for start in starts {
        if let Some(root) = start.ancestors().find(|root| is_package_root(root)) {
            return Ok(root.to_path_buf());
        }
    }
    bail!("Cannot find the ScriptFS distribution (container/Containerfile is missing)");
}
fn cancelled(stop: &AtomicBool) -> Result<()> {
    if stop.load(Ordering::SeqCst) {
        bail!("ScriptFS startup was interrupted");
    }
    Ok(())
}
fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| v.to_string()).collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Linux,
    Mac,
    Windows,
}
impl Platform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Mac
        } else {
            Self::Linux
        }
    }
}

fn execute(
    runner: &dyn Runner,
    program: &str,
    arguments: &[&str],
    signal: Option<&Arc<AtomicBool>>,
    timeout: Duration,
    allow_failure: bool,
) -> Result<Output> {
    if let Some(signal) = signal {
        cancelled(signal)?;
    }
    let mut request = Request::new(program, &args(arguments));
    request.signal = signal.cloned();
    request.timeout = Some(timeout);
    request.allow_failure = allow_failure;
    runner.run(request)
}
fn podman(
    runner: &dyn Runner,
    values: &[&str],
    signal: Option<&Arc<AtomicBool>>,
    allow_failure: bool,
) -> Result<Output> {
    execute(
        runner,
        "podman",
        values,
        signal,
        Duration::from_secs(60),
        allow_failure,
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Machine {
    name: String,
    running: bool,
    starting: Option<bool>,
    default: Option<bool>,
    port: Option<u16>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Connection {
    name: String,
    #[serde(rename = "URI")]
    uri: String,
    default: bool,
}

pub fn check_with(
    runner: &dyn Runner,
    platform: Platform,
    signal: Arc<AtomicBool>,
    connection_name: Option<String>,
    connection_uri: Option<String>,
) -> Result<()> {
    cancelled(&signal)?;
    if let Err(error) = execute(
        runner,
        "podman",
        &["--version"],
        Some(&signal),
        Duration::from_secs(10),
        false,
    ) {
        cancelled(&signal)?;
        let missing = error.chain().any(|e| {
            e.downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
        });
        let guidance = match platform {
            Platform::Windows => {
                "Install Podman using the Windows installer, or run `winget install --id RedHat.Podman --exact`, then open a new terminal."
            }
            Platform::Mac => {
                "Install the Podman macOS installer, or run `brew install podman`, then open a new terminal."
            }
            Platform::Linux => {
                "Install Podman using your distribution's package manager (for example, `sudo apt-get install podman` on Debian/Ubuntu)."
            }
        };
        if missing {
            bail!("Podman executable was not found on PATH. {guidance}");
        }
        bail!(
            "Could not run the Podman CLI. Check its installation and executable permissions.\n{error:#}"
        );
    }
    if platform != Platform::Linux {
        let machines = (|| -> Result<Vec<Machine>> {
            let output = execute(runner, "podman", &["machine", "list", "--format", "json"], Some(&signal), Duration::from_secs(10), false)?;
            let machines: Vec<Machine> = serde_json::from_str(&output.stdout)?;
            if machines.iter().any(|m| m.name.is_empty() || m.port == Some(0)) { bail!("Invalid Podman machine status"); }
            Ok(machines)
        })().map_err(|error| {
            if signal.load(Ordering::SeqCst) { anyhow::anyhow!("ScriptFS startup was interrupted") }
            else { anyhow::anyhow!("Could not determine Podman machine status. Run `podman machine list` and `podman system connection list`.\n{error:#}") }
        })?;
        if machines.is_empty() {
            bail!(
                "No Podman machine exists. Run `podman machine init`, then `podman machine start`."
            );
        }
        let overridden = connection_name.is_some() || connection_uri.is_some();
        let mut selected = if overridden {
            None
        } else {
            machines
                .iter()
                .find(|m| m.default == Some(true))
                .or_else(|| (machines.len() == 1).then(|| &machines[0]))
        };
        if overridden || (selected.is_none() && machines.iter().any(|m| m.running)) {
            let connections = (|| -> Result<Vec<Connection>> {
                let output = execute(runner, "podman", &["system", "connection", "list", "--format", "json"], Some(&signal), Duration::from_secs(10), false)?;
                let connections: Vec<Connection> = serde_json::from_str(&output.stdout)?;
                if connections.iter().any(|c| c.name.is_empty() || c.uri.is_empty()) { bail!("Invalid Podman connection"); }
                Ok(connections)
            })().map_err(|error| {
                if signal.load(Ordering::SeqCst) { anyhow::anyhow!("ScriptFS startup was interrupted") }
                else { anyhow::anyhow!("Could not determine the selected Podman connection. Run `podman system connection list`.\n{error:#}") }
            })?;
            if let Some(connection) = connections.iter().find(|c| {
                if let Some(name) = &connection_name {
                    c.name == *name
                } else if let Some(uri) = &connection_uri {
                    c.uri == *uri
                } else {
                    c.default
                }
            }) {
                let port = url::Url::parse(&connection.uri)
                    .context("Could not determine the selected Podman connection")?
                    .port();
                let candidates: Vec<_> = machines
                    .iter()
                    .filter(|m| {
                        (m.name == connection.name || format!("{}-root", m.name) == connection.name)
                            && (m.port.is_none() || m.port == port)
                    })
                    .collect();
                if candidates.len() == 1 {
                    selected = Some(candidates[0]);
                }
            }
        }
        let available = machines
            .iter()
            .map(|m| format!("{:?}", m.name))
            .collect::<Vec<_>>()
            .join(", ");
        if let Some(selected) = selected {
            if selected.starting == Some(true) {
                bail!(
                    "Podman machine {:?} is still starting. Wait for `podman machine start` to finish, then rerun ScriptFS.",
                    selected.name
                );
            }
            if !selected.running {
                bail!(
                    "Podman machine {:?} is stopped. Run `podman machine start --update-connection {:?}`.",
                    selected.name,
                    selected.name
                );
            }
        } else if !machines.iter().any(|m| m.running) {
            bail!(
                "No Podman machine is running. Available machines: {available}. Run `podman machine start --update-connection <name>`."
            );
        } else {
            bail!(
                "Cannot identify the selected Podman machine. Available machines: {available}. Check `podman system connection list` and select the correct connection with `podman system connection default <name>`."
            );
        }
    }
    let output = execute(runner, "podman", &["info", "--format", "{{.Host.OS}}"], Some(&signal), Duration::from_secs(10), false)
        .map_err(|error| {
            if signal.load(Ordering::SeqCst) { anyhow::anyhow!("ScriptFS startup was interrupted") }
            else {
                let guidance = if platform == Platform::Linux {
                    "Run `podman info` to diagnose runtime permissions and configuration. If using remote Podman, check `podman system connection list` and the selected connection."
                } else { "The Podman VM is running, but the active connection is not reachable. Check `podman system connection list` and select the correct connection with `podman system connection default <name>`." };
                anyhow::anyhow!("Podman is installed, but its runtime is unavailable. {guidance}\n{error:#}")
            }
        })?;
    if output.stdout.trim() != "linux" {
        bail!(
            "ScriptFS requires a Linux Podman backend; podman info reported {:?}. Check the selected Podman connection.",
            output.stdout.trim()
        );
    }
    Ok(())
}

pub fn load_config(config_path: &Path) -> Result<(Config, Value)> {
    let path = absolute(&std::env::current_dir()?, config_path);
    let raw: Value = serde_json::from_slice(
        &fs::read(&path).with_context(|| format!("Could not read {}", path.display()))?,
    )?;
    let mut config = Config::parse(&serde_json::to_vec(&raw)?)?;
    resolve_config(
        &mut config,
        path.parent().context("Configuration has no parent")?,
        Platform::current(),
    )?;
    let output = public_config(&raw, &config);
    Ok((config, output))
}
/// Makes every host path absolute relative to `base` and binds module
/// instances to their manifests.
fn resolve_config(config: &mut Config, base: &Path, platform: Platform) -> Result<Vec<Resolved>> {
    for filesystem in &mut config.filesystems {
        filesystem.source = absolute(base, &filesystem.source);
        filesystem.mount_point = if platform == Platform::Windows && drive(&filesystem.mount_point)
        {
            filesystem
                .mount_point
                .to_string_lossy()
                .to_uppercase()
                .into()
        } else {
            absolute(base, &filesystem.mount_point)
        };
        for rule in &mut filesystem.rules {
            if let Some(provider) = &mut rule.provider {
                if provider.module.is_none() {
                    let target = absolute(
                        base,
                        provider.path.as_ref().context("Missing proxy target")?,
                    );
                    let file = provider.kind.as_deref() == Some("file");
                    let stat = if file {
                        fs::symlink_metadata(&target)?
                    } else {
                        fs::metadata(&target)?
                    };
                    if (file && !stat.is_file()) || (!file && !stat.is_dir()) {
                        bail!(
                            "{} provider target has the wrong type (expected {}): {}",
                            if file { "file" } else { "directory" },
                            if file {
                                "a regular file, not a symbolic link"
                            } else {
                                "a directory"
                            },
                            target.display()
                        );
                    }
                    provider.path = Some(target);
                }
            }
        }
    }
    let mut mounts = std::collections::HashSet::new();
    for filesystem in &config.filesystems {
        let key = if platform == Platform::Windows {
            filesystem.mount_point.to_string_lossy().to_uppercase()
        } else {
            filesystem.mount_point.to_string_lossy().into_owned()
        };
        if !mounts.insert(key) {
            bail!("Each filesystem must use a unique mountPoint");
        }
    }
    module::resolve(config, base)
}
fn volume(
    arguments: &mut Vec<String>,
    host: &Path,
    container: &str,
    read_only: bool,
) -> Result<()> {
    let host = host
        .to_str()
        .context("Bind mount paths must be valid UTF-8")?;
    if host.contains(['\n', '\0']) {
        bail!("Invalid bind mount path");
    }
    arguments.extend([
        "--volume".into(),
        format!("{host}:{container}{}", if read_only { ":ro" } else { "" }),
    ]);
    Ok(())
}
struct Prepared {
    runtime: RuntimeConfig,
    mounts: Vec<String>,
    publish: Vec<String>,
    /// Outbound tunnel routes and their host targets.
    routes: BTreeMap<String, String>,
}
/// The canonical host directory of a module package.
fn module_directory(resolved: &Resolved) -> Result<PathBuf> {
    let directory = resolved
        .manifest_path
        .parent()
        .context("Module manifest has no directory")?;
    fs::canonicalize(directory)
        .with_context(|| format!("Could not resolve {}", directory.display()))
}
/// Each module directory is mounted read-only at
/// `/scriptfs/modules/<n>/package`. Installed dependencies are mounted as the
/// package's `node_modules`, shadowing a host `node_modules` directory, or as
/// the sibling `/scriptfs/modules/<n>/node_modules` that Node.js resolves next.
fn prepare_config(
    config: &Config,
    modules: &[Resolved],
    dependencies: &BTreeMap<PathBuf, PathBuf>,
) -> Result<Prepared> {
    let mut filesystems = config.filesystems.clone();
    let mut mounts = Vec::new();
    let mut proxy = 0;
    for (index, filesystem) in filesystems.iter_mut().enumerate() {
        let source = format!("/scriptfs/sources/{index}");
        volume(
            &mut mounts,
            &filesystem.source,
            &source,
            filesystem.read_only,
        )?;
        filesystem.source = source.into();
        filesystem.mount_point = format!("/scriptfs/overlays/{index}").into();
        for rule in &mut filesystem.rules {
            let Some(provider) = &mut rule.provider else {
                continue;
            };
            let Some(target) = &provider.path else {
                continue;
            };
            let container = format!("/scriptfs/proxies/{proxy}");
            proxy += 1;
            let file = provider.kind.as_deref() == Some("file");
            volume(
                &mut mounts,
                if file {
                    target.parent().context("Proxy file has no parent")?
                } else {
                    target
                },
                &container,
                filesystem.read_only,
            )?;
            provider.path = Some(if file {
                PathBuf::from(container).join(target.file_name().context("Proxy has no name")?)
            } else {
                container.into()
            });
        }
    }
    let mut packages = BTreeMap::new();
    let mut runtime_modules = BTreeMap::new();
    let mut publish = Vec::new();
    let mut routes = BTreeMap::new();
    for resolved in modules {
        let directory = module_directory(resolved)?;
        let package = if let Some(package) = packages.get(&directory) {
            String::clone(package)
        } else {
            let root = format!("/scriptfs/modules/{}", packages.len());
            let package = format!("{root}/package");
            volume(&mut mounts, &directory, &package, true)?;
            if let Some(installed) = dependencies.get(&directory) {
                let target = if directory.join("node_modules").is_dir() {
                    format!("{package}/node_modules")
                } else {
                    format!("{root}/node_modules")
                };
                volume(&mut mounts, installed, &target, true)?;
            }
            packages.insert(directory, package.clone());
            package
        };
        let entry = format!(
            "{package}/{}",
            crate::config::normalize(&resolved.manifest.entry)?
        );
        for path in resolved.paths.values() {
            volume(&mut mounts, &path.host, &path.target, !path.writable)?;
        }
        if let Some(state) = &resolved.state {
            fs::create_dir_all(state)
                .with_context(|| format!("Could not create {}", state.display()))?;
            volume(
                &mut mounts,
                state,
                &format!("/scriptfs/state/{}", resolved.instance),
                false,
            )?;
        }
        for (key, port) in &resolved.ports {
            match port {
                Port::Outbound { target } => {
                    routes.insert(module::route(&resolved.instance, key), target.clone());
                }
                Port::Inbound { port, host_port } => {
                    publish.push(format!("127.0.0.1:{host_port}:{port}"));
                }
            }
        }
        runtime_modules.insert(
            resolved.instance.clone(),
            module::runtime_module(resolved, entry),
        );
    }
    if !routes.is_empty() {
        publish.push(format!("127.0.0.1::{}", module::TUNNEL_PORT));
    }
    Ok(Prepared {
        runtime: RuntimeConfig {
            filesystems,
            modules: runtime_modules,
        },
        mounts,
        publish,
        routes,
    })
}

fn drive(path: &Path) -> bool {
    let value = path.to_string_lossy();
    value.len() == 2 && value.as_bytes()[0].is_ascii_alphabetic() && value.ends_with(':')
}
fn mount_request(
    platform: Platform,
    host: &str,
    port: u16,
    name: &str,
    mount: &Path,
    credentials: Option<&Path>,
) -> Result<(PathBuf, Request)> {
    let mount_text = mount.to_str().context("Mount path must be valid UTF-8")?;
    let mut resolved = mount.to_path_buf();
    let (program, arguments) = if platform == Platform::Windows {
        if !drive(mount) {
            bail!(
                "Windows mount points must currently be drive letters such as \"S:\", received {mount_text}"
            );
        }
        resolved = mount_text.to_uppercase().into();
        let quote = |value: &str| format!("'{}'", value.replace('\'', "''"));
        let mut script = format!(
            "$ErrorActionPreference = 'Stop'\n$mapping = @{{\nLocalPath = {}\nRemotePath = {}\nPersistent = $false\n}}\n",
            quote(&resolved.to_string_lossy()),
            quote(&format!("\\\\{host}\\{name}"))
        );
        if let Some(path) = credentials {
            script.push_str(&format!("$credentials = Get-Content -LiteralPath {} -Raw | ConvertFrom-Json\n$mapping.UserName = $credentials.username\n$mapping.Password = $credentials.password\n", quote(&path.to_string_lossy())));
        } else {
            script.push_str("$mapping.UserName = 'guest'\n$mapping.Password = ''\n");
        }
        if port != 445 {
            script.push_str("if (-not (Get-Command New-SmbMapping).Parameters.ContainsKey('TcpPort')) { throw 'Alternative SMB ports require Windows 11 24H2 or Windows Server 2025 or later. Older clients require smbPort: 445 on a dedicated SMB host.' }\n");
            script.push_str(&format!("$mapping.TcpPort = {port}\n"));
        }
        script.push_str("New-SmbMapping @mapping | Out-Null");
        (
            "powershell.exe",
            args(&["-NoProfile", "-NonInteractive", "-Command", &script]),
        )
    } else if platform == Platform::Mac {
        (
            "/sbin/mount_smbfs",
            args(&[
                "-N",
                "-o",
                "nomdatacache,nodatacache",
                &format!("//guest:@{host}:{port}/{name}"),
                mount_text,
            ]),
        )
    } else {
        (
            "mount",
            args(&[
                "-t",
                "cifs",
                &format!("//{host}/{name}"),
                mount_text,
                "-o",
                &format!("guest,port={port},vers=3.0"),
            ]),
        )
    };
    Ok((resolved, Request::new(program, &arguments)))
}
fn unmount_request(platform: Platform, mount: &Path) -> Result<Request> {
    let mount = mount.to_str().context("Invalid mount path")?;
    Ok(if platform == Platform::Windows {
        Request::new("net", &args(&["use", mount, "/delete", "/yes"]))
    } else {
        Request::new(
            if platform == Platform::Mac {
                "/sbin/umount"
            } else {
                "umount"
            },
            &args(&[mount]),
        )
    })
}
fn already_unmounted(error: &str) -> bool {
    let line = error
        .trim_end()
        .lines()
        .last()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    matches!(
        line.as_str(),
        "the network connection could not be found."
            | "the network connection could not be found"
            | "network connection could not be found."
            | "network connection could not be found"
            | "system error 2250 has occurred."
            | "system error 2250"
            | "more help is available by typing net helpmsg 2250."
    ) || ["not mounted", "not currently mounted"]
        .iter()
        .any(|message| {
            let line = line.trim_end_matches('.');
            line == *message
                || line
                    .strip_suffix(message)
                    .is_some_and(|prefix| prefix.ends_with(": "))
        })
}

struct Monitor {
    signal: Arc<AtomicBool>,
    outcome: Arc<Mutex<Option<std::result::Result<String, String>>>>,
    thread: Option<thread::JoinHandle<()>>,
}

struct LogFollower {
    signal: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<Result<Output>>>,
}
impl LogFollower {
    /// Follows container output from `since`, a Unix time on the container's clock.
    fn start(runner: Arc<dyn Runner>, container: &str, since: &str, protocol: bool) -> Self {
        let signal = Arc::new(AtomicBool::new(false));
        let mut request = Request::new(
            "podman",
            &args(&["logs", "--follow", "--since", since, container]),
        );
        request.signal = Some(signal.clone());
        request.timeout = None;
        request.inherit = true;
        request.stderr_only = protocol;
        let thread = thread::spawn(move || {
            let result = runner.run(request);
            if let Err(error) = &result {
                if !error.to_string().contains("interrupted") {
                    eprintln!("Failed to follow scriptfs container logs: {error:#}");
                }
            }
            result
        });
        Self {
            signal,
            thread: Some(thread),
        }
    }
    fn stop(&mut self) -> Result<()> {
        self.signal.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            match thread
                .join()
                .map_err(|_| anyhow::anyhow!("Log follower thread failed"))?
            {
                Err(error) if !error.to_string().contains("interrupted") => return Err(error),
                _ => (),
            }
        }
        Ok(())
    }
}
impl Monitor {
    fn start(runner: Arc<dyn Runner>, container: String) -> Self {
        let signal = Arc::new(AtomicBool::new(false));
        let outcome = Arc::new(Mutex::new(None));
        let worker_signal = signal.clone();
        let worker_outcome = outcome.clone();
        let thread = thread::spawn(move || {
            let mut request = Request::new("podman", &args(&["wait", &container]));
            request.timeout = None;
            request.signal = Some(worker_signal);
            let result = runner
                .run(request)
                .map(|o| o.stdout.trim().to_string())
                .map_err(|e| format!("{e:#}"));
            *worker_outcome.lock().unwrap() = Some(result);
        });
        Self {
            signal,
            outcome,
            thread: Some(thread),
        }
    }
    fn stop(&mut self) -> Result<()> {
        self.signal.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            thread
                .join()
                .map_err(|_| anyhow::anyhow!("Container monitor thread failed"))?;
        }
        Ok(())
    }
}

pub struct Session {
    config: Config,
    runner: Arc<dyn Runner>,
    platform: Platform,
    pub container_id: String,
    mounted: Vec<(String, PathBuf)>,
    temporary: Option<tempfile::TempDir>,
    follower: Option<LogFollower>,
    monitor: Option<Monitor>,
    tunnel: Option<crate::tunnel::Client>,
    stopped: bool,
    removed: bool,
    stopping: bool,
}
impl Drop for Session {
    fn drop(&mut self) {
        if let Err(error) = self.stop() {
            eprintln!("ScriptFS cleanup failed: {error:#}");
            if let Some(temporary) = self.temporary.take() {
                eprintln!(
                    "Runtime configuration retained at {}",
                    temporary.keep().display()
                );
            }
        }
        if let Some(monitor) = &mut self.monitor {
            if let Err(error) = monitor.stop() {
                eprintln!("Container monitor cleanup failed: {error:#}");
            }
        }
    }
}
impl Session {
    pub fn mounts(&self) -> Value {
        json!(self.mounted)
    }
    pub fn retryable(&self) -> bool {
        self.temporary.is_some()
    }
    fn exit_error(&self) -> Option<String> {
        if self.stopping {
            return None;
        }
        self.monitor
            .as_ref()?
            .outcome
            .lock()
            .unwrap()
            .as_ref()
            .map(|outcome| match outcome {
                Ok(status) if !status.is_empty() => format!(
                    "scriptfs container {} exited with status {status}",
                    self.container_id
                ),
                Ok(_) => format!("scriptfs container {} exited", self.container_id),
                Err(error) => format!("scriptfs container {} exited: {error}", self.container_id),
            })
    }
    pub fn stop(&mut self) -> Result<()> {
        if self.temporary.is_none() {
            return Ok(());
        }
        self.stopping = true;
        let mut errors = Vec::new();
        if let Some(follower) = &mut self.follower {
            match follower.stop() {
                Ok(()) => self.follower = None,
                Err(error) => errors.push(format!("Log follower cleanup failed: {error:#}")),
            }
        }
        let mut remaining = Vec::new();
        for (name, mount) in self.mounted.iter().rev() {
            if let Err(error) = self.runner.run(unmount_request(self.platform, mount)?) {
                if !already_unmounted(&format!("{error:#}")) {
                    errors.push(format!("{error:#}"));
                    remaining.push((name.clone(), mount.clone()));
                }
            }
        }
        remaining.reverse();
        self.mounted = remaining;
        if self.mounted.is_empty() && !self.container_id.is_empty() && !self.removed {
            if !self.stopped {
                match podman(
                    self.runner.as_ref(),
                    &["stop", "--ignore", "--time", "5", &self.container_id],
                    None,
                    false,
                ) {
                    Ok(_) => self.stopped = true,
                    Err(error) => errors.push(format!("{error:#}")),
                }
            }
            match podman(
                self.runner.as_ref(),
                &["rm", "--ignore", "--force", &self.container_id],
                None,
                false,
            ) {
                Ok(_) => {
                    self.removed = true;
                    // Modules may still reach host services while the
                    // container flushes and stops, so the tunnel goes last.
                    if let Some(mut tunnel) = self.tunnel.take() {
                        tunnel.stop();
                    }
                    if let Some(monitor) = &mut self.monitor {
                        if let Err(error) = monitor.stop() {
                            errors.push(format!("{error:#}"));
                        }
                    }
                }
                Err(error) => errors.push(format!("{error:#}")),
            }
        }
        if !errors.is_empty() {
            return Err(CleanupFailure {
                container_id: self.container_id.clone(),
                errors,
            }
            .into());
        }
        if let Some(temporary) = &self.temporary {
            fs::remove_dir_all(temporary.path())?;
        }
        self.temporary.take();
        Ok(())
    }
    fn frame(&self, event: &str) -> Value {
        json!({"event":event,"containerId":self.container_id,"mounts":self.mounts()})
    }
}

#[derive(Debug)]
struct CleanupFailure {
    container_id: String,
    errors: Vec<String>,
}
impl std::fmt::Display for CleanupFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Failed to completely stop scriptfs ({}): {}",
            if self.container_id.is_empty() {
                "no container"
            } else {
                &self.container_id
            },
            self.errors.join("; ")
        )
    }
}
impl std::error::Error for CleanupFailure {}
fn error_causes(error: &anyhow::Error) -> Vec<String> {
    error.downcast_ref::<CleanupFailure>().map_or_else(
        || vec![format!("{error:#}")],
        |failure| failure.errors.clone(),
    )
}

pub struct StartupFailure {
    pub errors: Vec<String>,
    pub session: Option<Box<Session>>,
}
impl StartupFailure {
    fn early(error: anyhow::Error) -> Self {
        Self {
            errors: vec![format!("{error:#}")],
            session: None,
        }
    }
    fn frame(&self, phase: &str) -> Value {
        let mut frame = self
            .session
            .as_ref()
            .map(|s| s.frame("error"))
            .unwrap_or_else(|| json!({"event":"error","containerId":"","mounts":[]}));
        frame["message"] = json!(self.errors.join("; "));
        frame["errors"] = json!(self.errors);
        let retryable = self
            .session
            .as_ref()
            .is_some_and(|session| session.retryable());
        frame["retryable"] = json!(retryable);
        frame["startupError"] = json!(retryable);
        frame["phase"] = json!(phase);
        frame
    }
}
pub struct StartSettings {
    pub platform: Platform,
    pub base: PathBuf,
    pub state_root: PathBuf,
    pub readiness_timeout: Duration,
    pub readiness_retry: Duration,
    pub distribution_root: Option<PathBuf>,
    pub protocol: bool,
    /// Host cache for installed module dependencies; defaults to
    /// [`dependencies::default_cache_root`].
    pub cache_root: Option<PathBuf>,
}
impl StartSettings {
    pub fn native() -> Result<Self> {
        let base = std::env::current_dir()?;
        Ok(Self {
            platform: Platform::current(),
            state_root: base.clone(),
            base,
            readiness_timeout: Duration::from_secs(60),
            readiness_retry: Duration::from_millis(250),
            distribution_root: None,
            protocol: false,
            cache_root: None,
        })
    }
}

/// Reads the digest-pinned image reference a published package was released with.
fn release_image(root: &Path) -> Result<Option<String>> {
    #[derive(Deserialize)]
    struct ReleaseImage {
        image: String,
    }
    let path = root.join(RELEASE_IMAGE_FILE);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("Cannot read {}", path.display()));
        }
    };
    let ReleaseImage { image } =
        serde_json::from_slice(&bytes).with_context(|| format!("Invalid {}", path.display()))?;
    let pinned = image.split_once("@sha256:").is_some_and(|(name, digest)| {
        // Podman cannot pull a reference with both a tag and a digest.
        let repository = name.rsplit('/').next().unwrap_or(name);
        !repository.is_empty()
            && !repository.contains(':')
            && !name.contains(|c: char| c.is_whitespace() || c == '@')
            && digest.len() == 64
            && digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    });
    if !pinned {
        bail!(
            "{} must pin the runtime image as <name>@sha256:<digest>, not {image:?}",
            path.display()
        );
    }
    Ok(Some(image))
}
fn image_exists(runner: &dyn Runner, stop: &Arc<AtomicBool>, image: &str) -> Result<bool> {
    Ok(!podman(
        runner,
        &["image", "inspect", "--format", "{{.Id}}", image],
        Some(stop),
        true,
    )?
    .stdout
    .trim()
    .is_empty())
}
/// Long-running image commands stream progress to stderr, which keeps stdout
/// free for SDK protocol frames.
fn image_request(arguments: &[&str], stop: &Arc<AtomicBool>) -> Request {
    let mut request = Request::new("podman", &args(arguments));
    request.signal = Some(stop.clone());
    request.timeout = Some(Duration::from_secs(600));
    request.inherit = true;
    request.stderr_only = true;
    request
}
/// Selects the runtime image. An explicit `container.image` is used as is.
/// Otherwise an installed release uses the image it pins, pulling it when
/// missing; checkouts, `rebuild`, and releases whose image cannot be pulled
/// use [`IMAGE`]. Missing images and `rebuild` build from the distribution.
fn runtime_image(
    runner: &dyn Runner,
    stop: &Arc<AtomicBool>,
    container: &crate::config::Container,
    settings: &StartSettings,
) -> Result<String> {
    let root = || {
        settings
            .distribution_root
            .as_ref()
            .map_or_else(package_root, |root| Ok(root.clone()))
    };
    let image = match &container.image {
        Some(image) => image.clone(),
        None if container.rebuild => IMAGE.into(),
        None => match root()
            .ok()
            .map(|root| release_image(&root))
            .transpose()?
            .flatten()
        {
            Some(release) if image_exists(runner, stop, &release)? => return Ok(release),
            Some(release) => {
                eprintln!("Pulling the ScriptFS runtime image {release}");
                match runner.run(image_request(&["pull", &release], stop)) {
                    Ok(_) => return Ok(release),
                    Err(error) => {
                        cancelled(stop)?;
                        eprintln!(
                            "Could not pull {release}: {error:#}\nUsing a local build of the runtime image instead; set container.image to {IMAGE} to skip the pull."
                        );
                        IMAGE.into()
                    }
                }
            }
            None => IMAGE.into(),
        },
    };
    if container.rebuild || !image_exists(runner, stop, &image)? {
        let root = root()?;
        if !root.join("container/Containerfile").is_file() {
            bail!("Cannot find the ScriptFS distribution (container/Containerfile is missing)");
        }
        if !root.join("packages/module/dist/index.js").is_file() {
            bail!(
                "The ScriptFS distribution at {} has no built @scriptfs/module package; run make build",
                root.display()
            );
        }
        let registry = host_registry(runner, stop, settings.platform)?;
        runner.run(image_request(
            &[
                "build",
                "--build-arg",
                &format!("NPM_REGISTRY={registry}"),
                "--tag",
                &image,
                "--file",
                &root.join("container/Containerfile").to_string_lossy(),
                &root.to_string_lossy(),
            ],
            stop,
        ))?;
    }
    Ok(image)
}
/// The npm registry the host's npm configuration selects.
fn host_registry(
    runner: &dyn Runner,
    stop: &Arc<AtomicBool>,
    platform: Platform,
) -> Result<String> {
    let (program, args): (&str, &[&str]) = if platform == Platform::Windows {
        ("cmd.exe", &["/d", "/s", "/c", "npm config get registry"])
    } else {
        ("npm", &["config", "get", "registry"])
    };
    Ok(execute(
        runner,
        program,
        args,
        Some(stop),
        Duration::from_secs(60),
        false,
    )?
    .stdout
    .trim()
    .to_owned())
}
/// Installs the dependencies of every module package that requests it, keyed
/// by canonical module directory.
fn install_dependencies(
    runner: &dyn Runner,
    stop: &Arc<AtomicBool>,
    image: &str,
    modules: &[Resolved],
    settings: &StartSettings,
) -> Result<BTreeMap<PathBuf, PathBuf>> {
    let mut installed = BTreeMap::new();
    let wanted: Vec<_> = modules
        .iter()
        .filter(|m| m.manifest.dependencies == module::Dependencies::Install)
        .collect();
    if wanted.is_empty() {
        return Ok(installed);
    }
    let image_id = podman(
        runner,
        &["image", "inspect", "--format", "{{.Id}}", image],
        Some(stop),
        false,
    )?
    .stdout
    .trim()
    .to_owned();
    let cache_root = match &settings.cache_root {
        Some(root) => root.clone(),
        None => crate::dependencies::default_cache_root()?,
    };
    // Looked up once, and only when an install is not cached. Without npm on
    // the host, installs use the registry the runtime image was built with.
    let registry = std::cell::OnceCell::new();
    let registry = || -> Result<Option<String>> {
        if let Some(value) = registry.get() {
            return Ok(Clone::clone(value));
        }
        let value = match host_registry(runner, stop, settings.platform) {
            Ok(value) => Some(value).filter(|v| !v.is_empty() && !v.contains(['\n', '\r', '\0'])),
            Err(error) => {
                cancelled(stop)?;
                eprintln!(
                    "Could not read the host's npm registry ({error:#}); installing module dependencies from the runtime image's registry."
                );
                None
            }
        };
        Ok(registry.get_or_init(|| value).clone())
    };
    let installer = crate::dependencies::Installer {
        runner,
        stop,
        image,
        image_id: &image_id,
        cache_root: &cache_root,
        registry: &registry,
    };
    for resolved in wanted {
        let directory = module_directory(resolved)?;
        if let std::collections::btree_map::Entry::Vacant(slot) = installed.entry(directory) {
            cancelled(stop)?;
            let node_modules = installer.ensure(&resolved.instance, slot.key())?;
            slot.insert(node_modules);
        }
    }
    Ok(installed)
}

pub fn start_session(
    input: &Value,
    stop: Arc<AtomicBool>,
    runner: Arc<dyn Runner>,
    settings: StartSettings,
) -> std::result::Result<Session, StartupFailure> {
    let prepared = (|| -> Result<(Config, Prepared, module::Secrets, String)> {
        cancelled(&stop)?;
        let mut config = Config::parse(&serde_json::to_vec(input)?)?;
        let modules = resolve_config(&mut config, &settings.base, settings.platform)?;
        let mut secrets = module::Secrets {
            tunnel: None,
            modules: module::read_secrets(&modules, &|name| std::env::var(name).ok())?,
        };
        for filesystem in &config.filesystems {
            if !fs::metadata(&filesystem.source)?.is_dir() {
                bail!(
                    "Filesystem source must be a directory: {}",
                    filesystem.source.display()
                );
            }
        }
        let image = runtime_image(runner.as_ref(), &stop, &config.container, &settings)?;
        cancelled(&stop)?;
        let dependencies =
            install_dependencies(runner.as_ref(), &stop, &image, &modules, &settings)?;
        cancelled(&stop)?;
        let prepared = prepare_config(&config, &modules, &dependencies)?;
        if !prepared.routes.is_empty() {
            secrets.tunnel = Some(format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ));
        }
        Ok((config, prepared, secrets, image))
    })()
    .map_err(StartupFailure::early)?;
    let (config, prepared, secrets, image) = prepared;
    let temporary = tempfile::Builder::new()
        .prefix(".scriptfs-runtime-")
        .tempdir_in(&settings.state_root)
        .map_err(|e| StartupFailure::early(e.into()))?;
    let mut session = Session {
        config,
        runner,
        platform: settings.platform,
        container_id: String::new(),
        mounted: Vec::new(),
        temporary: Some(temporary),
        follower: None,
        monitor: None,
        tunnel: None,
        stopped: false,
        removed: false,
        stopping: false,
    };
    let result = (|| -> Result<()> {
        let temporary = session.temporary.as_ref().unwrap().path();
        fs::write(
            temporary.join("config.json"),
            serde_json::to_vec(&prepared.runtime)?,
        )?;
        let credentials = if settings.platform == Platform::Windows {
            let password = format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            let path = temporary.join("smb-credentials.json");
            write_private(
                &path,
                &serde_json::to_vec(&json!({"username":"scriptfs","password":password}))?,
            )?;
            Some(path)
        } else {
            None
        };
        let secrets_file = if secrets == module::Secrets::default() {
            None
        } else {
            let path = temporary.join("secrets.json");
            write_private(&path, &serde_json::to_vec(&secrets)?)?;
            Some(path)
        };
        let name = format!("scriptfs-{}", uuid::Uuid::new_v4());
        let publish = session
            .config
            .container
            .smb_port
            .map(|p| format!("127.0.0.1:{p}:445"))
            .unwrap_or_else(|| "127.0.0.1::445".into());
        let mut create = args(&[
            "create",
            "--name",
            &name,
            "--device",
            "/dev/fuse",
            "--cap-add",
            "SYS_ADMIN",
            "--security-opt",
            "label=disable",
            "--security-opt",
            "apparmor=unconfined",
            "--publish",
            &publish,
        ]);
        volume(
            &mut create,
            &temporary.join("config.json"),
            "/scriptfs/config.json",
            true,
        )?;
        if let Some(credentials) = &credentials {
            create.extend(args(&[
                "--env",
                "SCRIPTFS_SMB_CREDENTIALS=/scriptfs/smb-credentials.json",
            ]));
            volume(
                &mut create,
                credentials,
                "/scriptfs/smb-credentials.json",
                true,
            )?;
        }
        if let Some(secrets_file) = &secrets_file {
            volume(&mut create, secrets_file, "/scriptfs/secrets.json", true)?;
        }
        for publish in &prepared.publish {
            create.extend(["--publish".into(), publish.clone()]);
        }
        create.extend(prepared.mounts.iter().cloned());
        create.push(image);
        // Assign the name before create: cancellation can lose create's stdout
        // after the engine has already committed the resource.
        session.container_id = name;
        let mut request = Request::new("podman", &create);
        request.signal = Some(stop.clone());
        let id = session.runner.run(request)?;
        if id.stdout.trim().is_empty() {
            bail!("Podman returned no container ID");
        }
        session.container_id = id.stdout.trim().into();
        cancelled(&stop)?;
        podman(
            session.runner.as_ref(),
            &["start", &session.container_id],
            Some(&stop),
            false,
        )?;
        session.monitor = Some(Monitor::start(
            session.runner.clone(),
            session.container_id.clone(),
        ));
        if let Some(token) = &secrets.tunnel {
            let output = podman(
                session.runner.as_ref(),
                &[
                    "port",
                    &session.container_id,
                    &format!("{}/tcp", module::TUNNEL_PORT),
                ],
                Some(&stop),
                false,
            )?;
            let port = published_port(&output.stdout, "tunnel")?;
            session.tunnel = Some(crate::tunnel::Client::start(
                ([127, 0, 0, 1], port).into(),
                token.clone(),
                prepared.routes.clone(),
            ));
        }
        let ready_at = wait_until_ready(
            &session,
            &stop,
            settings.readiness_timeout,
            settings.readiness_retry,
        )?;
        if session.config.container.log_level.as_deref() != Some("silent") {
            session.follower = Some(LogFollower::start(
                session.runner.clone(),
                &session.container_id,
                &ready_at,
                settings.protocol,
            ));
        }
        let output = podman(
            session.runner.as_ref(),
            &["port", &session.container_id, "445/tcp"],
            Some(&stop),
            false,
        )?;
        let port = published_port(&output.stdout, "SMB")?;
        for filesystem in &session.config.filesystems {
            cancelled(&stop)?;
            let (mount, request) = mount_request(
                settings.platform,
                session
                    .config
                    .container
                    .smb_host
                    .as_deref()
                    .unwrap_or("127.0.0.1"),
                port,
                &filesystem.name,
                &filesystem.mount_point,
                credentials.as_deref(),
            )?;
            if settings.platform != Platform::Windows {
                fs::create_dir_all(&mount)?;
            }
            session.runner.run(request)?;
            session.mounted.push((filesystem.name.clone(), mount));
            cancelled(&stop)?;
        }
        cancelled(&stop)?;
        Ok(())
    })();
    if let Err(error) = result {
        let mut errors = vec![format!("{error:#}")];
        if !session.container_id.is_empty() && !stop.load(Ordering::SeqCst) {
            match execute(
                session.runner.as_ref(),
                "podman",
                &["logs", "--tail", "1000", &session.container_id],
                None,
                Duration::from_secs(10),
                true,
            ) {
                Ok(logs) => {
                    if !logs.stdout.is_empty() || !logs.stderr.is_empty() {
                        errors[0].push_str(&format!(
                            "\nContainer logs:\n{}{}",
                            logs.stdout, logs.stderr
                        ));
                    }
                }
                Err(error) => errors.push(format!("{error:#}")),
            }
        }
        if let Err(error) = session.stop() {
            errors.extend(error_causes(&error));
        }
        return Err(StartupFailure {
            errors,
            session: Some(Box::new(session)),
        });
    }
    Ok(session)
}
/// The container clock reading in a readiness marker (`ready <seconds>.<nanoseconds>`).
fn readiness_time(marker: &str) -> Result<Option<String>> {
    let marker = marker.trim();
    if marker.is_empty() {
        return Ok(None);
    }
    match marker
        .strip_prefix("ready ")
        .and_then(|time| time.split_once('.'))
    {
        Some((seconds, nanos))
            if !seconds.is_empty()
                && nanos.len() == 9
                && (seconds.bytes().chain(nanos.bytes())).all(|byte| byte.is_ascii_digit()) =>
        {
            Ok(Some(format!("{seconds}.{nanos}")))
        }
        _ => bail!("Unexpected scriptfs readiness marker {marker:?}"),
    }
}
fn published_port(output: &str, label: &str) -> Result<u16> {
    let port = output
        .trim()
        .rsplit_once(':')
        .map(|(_, port)| port)
        .with_context(|| format!("Could not determine {label} port"))?;
    let port: u16 = port
        .parse()
        .with_context(|| format!("Could not determine {label} port from: {output}"))?;
    if port == 0 {
        bail!("Could not determine {label} port from: {output}");
    }
    Ok(port)
}
fn write_private(path: &Path, contents: &[u8]) -> Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(contents)?;
    Ok(())
}
fn wait_until_ready(
    session: &Session,
    stop: &Arc<AtomicBool>,
    timeout: Duration,
    retry: Duration,
) -> Result<String> {
    let signal = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(AtomicBool::new(false));
    let watchdog_signal = signal.clone();
    let watchdog_finished = finished.clone();
    let user_signal = stop.clone();
    let monitor = session.monitor.as_ref().unwrap().outcome.clone();
    let deadline = Instant::now() + timeout;
    let watchdog = thread::spawn(move || {
        while !watchdog_finished.load(Ordering::SeqCst) {
            if user_signal.load(Ordering::SeqCst)
                || Instant::now() >= deadline
                || monitor.lock().unwrap().is_some()
            {
                watchdog_signal.store(true, Ordering::SeqCst);
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
    });
    let result = (|| {
        loop {
            cancelled(stop)?;
            if let Some(error) = session.exit_error() {
                bail!("{error}");
            }
            if Instant::now() >= deadline {
                bail!("Timed out waiting for the scriptfs container");
            }
            let remaining = deadline
                .saturating_duration_since(Instant::now())
                .max(Duration::from_millis(1));
            let state = execute(
                session.runner.as_ref(),
                "podman",
                &[
                    "inspect",
                    "--format",
                    "{{.State.Status}}",
                    &session.container_id,
                ],
                Some(&signal),
                remaining,
                true,
            )?;
            if state.stdout.trim() != "running" {
                bail!("scriptfs container stopped during startup");
            }
            let ready = execute(
                session.runner.as_ref(),
                "podman",
                &["exec", &session.container_id, "cat", "/tmp/scriptfs-ready"],
                Some(&signal),
                deadline
                    .saturating_duration_since(Instant::now())
                    .max(Duration::from_millis(1)),
                true,
            )?;
            cancelled(stop)?;
            if let Some(time) = readiness_time(&ready.stdout)? {
                return Ok(time);
            }
            thread::sleep(retry.min(deadline.saturating_duration_since(Instant::now())));
        }
    })();
    finished.store(true, Ordering::SeqCst);
    let _ = watchdog.join();
    if let Some(error) = session.exit_error() {
        bail!("{error}");
    }
    if stop.load(Ordering::SeqCst) {
        bail!("ScriptFS startup was interrupted");
    }
    if result.is_err() && Instant::now() >= deadline {
        bail!("Timed out waiting for the scriptfs container");
    }
    result
}

pub fn emit(value: &Value) -> Result<()> {
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(format!("\nSCRIPTFS_SDK:{}\n", serde_json::to_string(value)?).as_bytes())?;
    stdout.flush()?;
    Ok(())
}
pub fn sdk_config() -> Result<()> {
    let result = (|| {
        let mut line = String::new();
        use std::io::Read;
        std::io::stdin().lock().read_to_string(&mut line)?;
        let request: Value = serde_json::from_str(&line)?;
        match request["op"].as_str() {
            Some("validate") => {
                let config = Config::parse(&serde_json::to_vec(&request["config"])?)?;
                Ok(public_config(&request["config"], &config))
            }
            Some("load") => load_config(Path::new(
                request["configPath"]
                    .as_str()
                    .context("configPath must be a string")?,
            ))
            .map(|(_, output)| output),
            Some("module") => {
                let base = std::env::current_dir()?;
                let described = crate::module::describe(
                    request["manifest"]
                        .as_str()
                        .context("manifest must be a string")?,
                    &base,
                )?;
                return Ok(json!({"event":"module","module":described}));
            }
            _ => bail!("Unknown SDK configuration operation"),
        }
        .map(|config| json!({"event":"config","config":config}))
    })();
    match result {
        Ok(response) => emit(&response),
        Err(error) => {
            emit(&json!({"event":"error","message":format!("{error:#}")}))?;
            Err(error)
        }
    }
}

pub fn sdk(stop: Arc<AtomicBool>) -> Result<()> {
    sdk_with(stop, Arc::new(NativeRunner), StartSettings::native()?)
}
fn emit_empty_stopped() -> Result<()> {
    emit(&json!({"event":"stopped","containerId":"","mounts":[]}))
}
fn sdk_with(
    stop: Arc<AtomicBool>,
    runner: Arc<dyn Runner>,
    mut settings: StartSettings,
) -> Result<()> {
    settings.protocol = true;
    let mut input = std::io::stdin().lock();
    let mut line = String::new();
    if let Err(error) = input.read_line(&mut line) {
        emit(
            &json!({"event":"error","message":error.to_string(),"phase":"startup","retryable":false,"startupError":false}),
        )?;
        emit_empty_stopped()?;
        return Err(error.into());
    }
    let request: Value = match serde_json::from_str(&line) {
        Ok(request) => request,
        Err(error) => {
            emit(
                &json!({"event":"error","message":error.to_string(),"phase":"startup","retryable":false,"startupError":false}),
            )?;
            emit_empty_stopped()?;
            return Err(error.into());
        }
    };
    if request["op"] != "start" {
        let error = anyhow::anyhow!("The first SDK request must be start");
        emit(
            &json!({"event":"error","message":error.to_string(),"phase":"startup","retryable":false,"startupError":false}),
        )?;
        emit_empty_stopped()?;
        return Err(error);
    }
    drop(input);
    let (sender, receiver) = mpsc::channel();
    let eof = Arc::new(AtomicBool::new(false));
    let eof_reader = eof.clone();
    let startup_stop = Arc::new(AtomicBool::new(stop.load(Ordering::SeqCst)));
    let reader_stop = startup_stop.clone();
    thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            match line.and_then(|line| {
                serde_json::from_str::<Value>(&line).map_err(std::io::Error::other)
            }) {
                Ok(request) if request["op"] == "stop" => {
                    let _ = sender.send(());
                    reader_stop.store(true, Ordering::SeqCst);
                }
                Ok(_) => {
                    let _ = emit(
                        &json!({"event":"error","message":"Unknown SDK operation","phase":"protocol","retryable":false}),
                    );
                }
                Err(error) => {
                    let _ = emit(
                        &json!({"event":"error","message":error.to_string(),"phase":"protocol","retryable":false}),
                    );
                }
            }
        }
        eof_reader.store(true, Ordering::SeqCst);
        reader_stop.store(true, Ordering::SeqCst);
        let _ = sender.send(());
    });
    let startup_finished = Arc::new(AtomicBool::new(false));
    let finished = startup_finished.clone();
    let signal = stop.clone();
    let forwarded_stop = startup_stop.clone();
    let forwarding = thread::spawn(move || {
        while !finished.load(Ordering::SeqCst) {
            if signal.load(Ordering::SeqCst) {
                forwarded_stop.store(true, Ordering::SeqCst);
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
    });
    let result = (|| {
        check_with(
            runner.as_ref(),
            settings.platform,
            startup_stop.clone(),
            std::env::var("CONTAINER_CONNECTION")
                .ok()
                .filter(|s| !s.is_empty()),
            std::env::var("CONTAINER_HOST")
                .ok()
                .filter(|s| !s.is_empty()),
        )
        .map_err(StartupFailure::early)?;
        start_session(&request["config"], startup_stop, runner, settings)
    })();
    startup_finished.store(true, Ordering::SeqCst);
    let _ = forwarding.join();
    let (mut session, failure) = match result {
        Ok(session) => {
            let failure = emit(&session.frame("ready")).err().map(|error| {
                stop.store(true, Ordering::SeqCst);
                format!("SDK output failed: {error:#}")
            });
            (session, failure)
        }
        Err(mut failure) => {
            while receiver.try_recv().is_ok() {}
            if let Err(error) = emit(&failure.frame("startup")) {
                stop.store(true, Ordering::SeqCst);
                eprintln!("SDK output failed: {error:#}");
            }
            let error = failure.errors.join("; ");
            let Some(session) = failure.session.take() else {
                emit_empty_stopped()?;
                bail!("{error}");
            };
            if !session.retryable() {
                emit(&session.frame("stopped"))?;
                bail!("{error}");
            }
            (*session, Some(error))
        }
    };
    let mut failure = failure;
    let mut auto_cleanup = failure.is_some() && !session.stopping;
    loop {
        let requested = receiver.try_recv().is_ok();
        let shutdown = eof.load(Ordering::SeqCst) || stop.load(Ordering::SeqCst);
        if failure.is_none() {
            if let Some(error) = session.exit_error() {
                let mut frame = session.frame("error");
                frame["message"] = json!(error);
                frame["errors"] = json!([error]);
                frame["phase"] = json!("runtime");
                frame["retryable"] = json!(true);
                if let Err(error) = emit(&frame) {
                    stop.store(true, Ordering::SeqCst);
                    eprintln!("SDK output failed: {error:#}");
                }
                failure = Some(error);
                auto_cleanup = true;
            }
        }
        if requested || shutdown || auto_cleanup {
            auto_cleanup = false;
            match session.stop() {
                Ok(()) => {
                    emit(&session.frame("stopped"))?;
                    if let Some(error) = failure {
                        bail!("{error}");
                    }
                    return Ok(());
                }
                Err(error) => {
                    let mut frame = session.frame("error");
                    frame["message"] = json!(format!("{error:#}"));
                    frame["errors"] = json!(error_causes(&error));
                    frame["phase"] = json!("stop");
                    frame["retryable"] = json!(true);
                    if let Err(error) = emit(&frame) {
                        stop.store(true, Ordering::SeqCst);
                        eprintln!("SDK output failed: {error:#}");
                    }
                    if shutdown {
                        thread::sleep(Duration::from_secs(1));
                    }
                }
            }
        }
        thread::sleep(Duration::from_millis(20));
    }
}

pub fn run(config_path: &str, stop: Arc<AtomicBool>) -> Result<()> {
    run_with(
        Some(config_path),
        stop,
        Arc::new(NativeRunner),
        StartSettings::native()?,
    )
}
pub fn cli_check(stop: Arc<AtomicBool>) -> Result<()> {
    run_with(None, stop, Arc::new(NativeRunner), StartSettings::native()?)
}
fn run_with(
    config_path: Option<&str>,
    stop: Arc<AtomicBool>,
    runner: Arc<dyn Runner>,
    settings: StartSettings,
) -> Result<()> {
    check_with(
        runner.as_ref(),
        settings.platform,
        stop.clone(),
        std::env::var("CONTAINER_CONNECTION")
            .ok()
            .filter(|s| !s.is_empty()),
        std::env::var("CONTAINER_HOST")
            .ok()
            .filter(|s| !s.is_empty()),
    )?;
    let Some(config_path) = config_path else {
        println!("Podman is installed and its Linux runtime is ready.");
        return Ok(());
    };
    let (_, input) = load_config(Path::new(config_path))?;
    let mut session = match start_session(&input, stop.clone(), runner, settings) {
        Ok(session) => session,
        Err(mut failure) => {
            if let Some(session) = &mut failure.session {
                stop_session(session);
            }
            bail!("{}", failure.errors.join("; "));
        }
    };
    run_until_stopped(&mut session, &stop)
}
/// Stopping is best effort during cleanup. Retrying forever would trap the CLI
/// in an endless loop when the container can never be removed, so give up with
/// an actionable message instead.
fn stop_session(session: &mut Session) {
    const ATTEMPTS: usize = 10;
    for attempt in 1..=ATTEMPTS {
        let Err(error) = session.stop() else {
            return;
        };
        eprintln!("{error:#}");
        if attempt == ATTEMPTS {
            eprintln!(
                "Could not stop the ScriptFS container after {ATTEMPTS} attempts; remove it with `podman rm -f {}`",
                session.container_id
            );
            return;
        }
        thread::sleep(Duration::from_secs(1));
    }
}

fn run_until_stopped(session: &mut Session, stop: &AtomicBool) -> Result<()> {
    for (name, mount) in &session.mounted {
        println!("{name}: {}", mount.display());
    }
    println!("scriptfs is running; press Ctrl+C to stop");
    let outcome = wait_session(session, stop);
    stop_session(session);
    outcome
}
fn wait_session(session: &Session, stop: &AtomicBool) -> Result<()> {
    while !stop.load(Ordering::SeqCst) {
        if session.removed && session.stopping {
            return Ok(());
        }
        if let Some(error) = session.exit_error() {
            bail!("{error}");
        }
        thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}

#[cfg(test)]
#[path = "host_tests.rs"]
mod tests;
