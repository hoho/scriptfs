//! Module manifests (`scriptfs.module.json`) and their binding to configured
//! module instances.
//!
//! The host resolves every configured instance against its manifest: it
//! validates settings, locates host paths, chooses container mount targets and
//! ports, and reads secrets when a session starts. The container receives the
//! resulting [`RuntimeModule`] descriptions and turns them into the runtime
//! object handed to the module code.
#![cfg_attr(not(any(test, target_os = "linux")), allow(dead_code))]
use crate::config::{Config, ModuleInstance, absolute, identifier, object_keys};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

pub const MANIFEST_FILE: &str = "scriptfs.module.json";
/// Container port of the ScriptFS tunnel that carries outbound module traffic.
pub const TUNNEL_PORT: u16 = 7445;
const SMB_PORT: u16 = 445;

pub(crate) const MANIFEST_KEYS: &[&str] = &[
    "$schema",
    "name",
    "version",
    "description",
    "entry",
    "export",
    "settings",
    "secrets",
    "ports",
    "paths",
    "state",
    "dependencies",
];
pub(crate) const SETTING_KEYS: &[&str] = &["type", "description", "default", "required", "enum"];
pub(crate) const SETTING_TYPES: &[&str] =
    &["string", "number", "integer", "boolean", "array", "object"];
pub(crate) const SECRET_KEYS: &[&str] = &["description", "required", "env"];
pub(crate) const OUTBOUND_PORT_KEYS: &[&str] = &["direction", "description", "target"];
pub(crate) const INBOUND_PORT_KEYS: &[&str] = &["direction", "description", "port", "hostPort"];
pub(crate) const PATH_KEYS: &[&str] = &[
    "description",
    "type",
    "access",
    "required",
    "default",
    "target",
];
/// Container locations a module path must not replace or shadow.
pub(crate) const RESERVED_TARGETS: &[&str] = &[
    "/bin",
    "/boot",
    "/dev",
    "/etc",
    "/lib",
    "/lib32",
    "/lib64",
    "/libx32",
    "/node_modules",
    "/opt",
    "/proc",
    "/root",
    "/run",
    "/sbin",
    "/scriptfs",
    "/sys",
    "/tmp",
    "/usr",
    "/var",
];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub name: String,
    pub version: Option<String>,
    pub entry: String,
    #[serde(default = "default_export")]
    pub export: String,
    #[serde(default)]
    pub settings: BTreeMap<String, SettingSpec>,
    #[serde(default)]
    pub secrets: BTreeMap<String, SecretSpec>,
    #[serde(default)]
    pub ports: BTreeMap<String, PortSpec>,
    #[serde(default)]
    pub paths: BTreeMap<String, PathSpec>,
    #[serde(default)]
    pub state: bool,
    #[serde(default)]
    pub dependencies: Dependencies,
}
/// How a module's npm dependencies reach the container.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Dependencies {
    /// The module directory already contains everything it imports.
    #[default]
    Bundled,
    /// ScriptFS installs the locked production dependencies inside the runtime
    /// image, so native addons match the container's platform and Node.js.
    Install,
}
/// Lockfiles accepted for installed dependencies, in order of preference.
pub const LOCKFILES: &[&str] = &["npm-shrinkwrap.json", "package-lock.json"];

/// The lockfile `npm ci` uses for a module directory.
pub fn lockfile(directory: &Path) -> Result<PathBuf> {
    if !directory.join("package.json").is_file() {
        bail!(
            "dependencies is \"install\", but {} has no package.json",
            directory.display()
        );
    }
    LOCKFILES
        .iter()
        .map(|name| directory.join(name))
        .find(|path| path.is_file())
        .with_context(|| {
            format!(
                "dependencies is \"install\", but {} has no npm-shrinkwrap.json or package-lock.json; run `npm install --package-lock-only` there (published modules ship `npm shrinkwrap` output)",
                directory.display()
            )
        })
}
fn default_export() -> String {
    "default".into()
}
fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize)]
pub struct SettingSpec {
    #[serde(rename = "type")]
    pub kind: String,
    pub default: Option<Value>,
    #[serde(default)]
    pub required: bool,
    #[serde(rename = "enum")]
    pub choices: Option<Vec<Value>>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SecretSpec {
    #[serde(default = "yes")]
    pub required: bool,
    pub env: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "direction", rename_all = "lowercase")]
pub enum PortSpec {
    Outbound {
        target: Option<String>,
    },
    Inbound {
        port: u16,
        #[serde(rename = "hostPort")]
        host_port: Option<u16>,
    },
}

#[derive(Clone, Debug, Deserialize)]
pub struct PathSpec {
    #[serde(rename = "type", default)]
    pub kind: PathKind,
    #[serde(default)]
    pub access: Access,
    #[serde(default = "yes")]
    pub required: bool,
    pub default: Option<String>,
    pub target: Option<String>,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PathKind {
    #[default]
    Directory,
    File,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Access {
    #[default]
    ReadOnly,
    ReadWrite,
}

/// A configured instance bound to its manifest on the host.
#[derive(Clone, Debug)]
pub struct Resolved {
    pub instance: String,
    pub manifest_path: PathBuf,
    pub manifest: Manifest,
    pub settings: Map<String, Value>,
    pub ports: BTreeMap<String, Port>,
    pub paths: BTreeMap<String, BoundPath>,
    pub state: Option<PathBuf>,
    pub secrets: BTreeMap<String, SecretBinding>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Port {
    Outbound { target: String },
    Inbound { port: u16, host_port: u16 },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoundPath {
    pub host: PathBuf,
    pub target: String,
    pub writable: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SecretSource {
    Env(String),
    File(PathBuf),
}
#[derive(Clone, Debug)]
pub struct SecretBinding {
    pub source: Option<SecretSource>,
    pub required: bool,
}

/// What the container needs to know about a module instance.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeModule {
    pub entry: String,
    pub export: String,
    pub manifest: Value,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub settings: Map<String, Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub ports: BTreeMap<String, RuntimePort>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub paths: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_dir: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "direction", rename_all = "lowercase")]
pub enum RuntimePort {
    Outbound {},
    Inbound {
        port: u16,
        #[serde(rename = "hostPort")]
        host_port: u16,
    },
}

/// Values the host hands to the container out of band, in a private file.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct Secrets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tunnel: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub modules: BTreeMap<String, BTreeMap<String, String>>,
}

pub fn environment_name(value: &str) -> bool {
    value
        .bytes()
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
}
fn capability_name(value: &str) -> bool {
    value
        .bytes()
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic())
        && identifier(value)
}

/// Parses an outbound `host:port` target. IPv6 hosts use brackets.
pub fn parse_target(target: &str) -> Result<(String, u16)> {
    let (host, port) = target
        .rsplit_once(':')
        .with_context(|| format!("Invalid target {target:?}: expected host:port"))?;
    let host = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    let port: u16 = port
        .parse()
        .ok()
        .filter(|p| *p != 0)
        .with_context(|| format!("Invalid target {target:?}: port must be 1-65535"))?;
    if host.is_empty() || host.contains(|c: char| c.is_whitespace() || c == '/') {
        bail!("Invalid target {target:?}: expected host:port");
    }
    Ok((host.into(), port))
}

pub fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// Resolves a host path written in a configuration or manifest: `~` expands to
/// the home directory and relative paths are relative to `base`.
pub fn host_path(base: &Path, value: &Path, home: Option<&Path>) -> Result<PathBuf> {
    let text = value.to_string_lossy();
    let rest = if text == "~" {
        Some("")
    } else {
        text.strip_prefix("~/")
            .or_else(|| cfg!(windows).then(|| text.strip_prefix("~\\")).flatten())
    };
    if let Some(rest) = rest {
        let home = home.context("Cannot expand ~: the home directory is unknown")?;
        return Ok(absolute(home, Path::new(rest)));
    }
    Ok(absolute(base, value))
}

fn path_reference(reference: &str) -> bool {
    reference.starts_with(['.', '/', '\\', '~']) || Path::new(reference).is_absolute()
}

/// Finds the manifest file for a configured `manifest` reference: a manifest
/// file, a directory containing `scriptfs.module.json`, or an installed npm
/// package name looked up in `node_modules` directories above `base`.
pub fn locate(reference: &str, base: &Path, home: Option<&Path>) -> Result<PathBuf> {
    let found = |path: &Path| -> Result<PathBuf> {
        if path.is_dir() {
            let file = path.join(MANIFEST_FILE);
            if file.is_file() {
                return Ok(file);
            }
            bail!("{} does not contain {MANIFEST_FILE}", path.display());
        }
        if path.is_file() {
            return Ok(path.to_path_buf());
        }
        bail!("Module manifest not found: {}", path.display());
    };
    if path_reference(reference) {
        return found(&host_path(base, Path::new(reference), home)?);
    }
    let segments: Vec<&str> = reference.split('/').collect();
    let scoped = reference.starts_with('@');
    if segments.len() < if scoped { 2 } else { 1 }
        || segments
            .iter()
            .any(|s| s.is_empty() || *s == "." || *s == ".." || s.contains(['\\', ':']))
    {
        bail!("Invalid module manifest reference: {reference:?}");
    }
    for directory in base.ancestors() {
        let candidate = directory.join("node_modules").join(reference);
        if candidate.exists() {
            return found(&candidate);
        }
    }
    bail!(
        "Cannot find module package {reference:?}: no node_modules/{reference} above {}",
        base.display()
    );
}

fn type_matches(kind: &str, value: &Value) -> bool {
    match kind {
        "string" => value.is_string(),
        "number" => value.is_number(),
        "integer" => value.is_i64() || value.is_u64(),
        "boolean" => value.is_boolean(),
        "array" => value.is_array(),
        "object" => value.is_object(),
        _ => false,
    }
}
fn check_setting(spec: &SettingSpec, value: &Value, label: &str) -> Result<()> {
    if !type_matches(&spec.kind, value) {
        bail!("{label} must be of type {}", spec.kind);
    }
    if let Some(choices) = &spec.choices {
        if !choices.contains(value) {
            bail!(
                "{label} must be one of {}",
                serde_json::to_string(choices).unwrap_or_default()
            );
        }
    }
    Ok(())
}

/// Validates a container mount target chosen by a manifest.
pub fn container_target(target: &str) -> Result<()> {
    let invalid = !target.starts_with('/')
        || target.len() < 2
        || target.ends_with('/')
        || target.contains(['\0', '\\', ':', ',', '\n'])
        || target
            .split('/')
            .skip(1)
            .any(|s| s.is_empty() || s == "." || s == "..");
    if invalid {
        bail!("Invalid container target {target:?}: expected a normalized absolute path");
    }
    if let Some(reserved) = RESERVED_TARGETS
        .iter()
        .find(|r| target == **r || target.starts_with(&format!("{r}/")))
    {
        bail!("Container target {target:?} is reserved ({reserved} belongs to the runtime)");
    }
    Ok(())
}

/// Reads and validates a manifest file, also returning its JSON document.
pub(crate) fn read_manifest(path: &Path) -> Result<(Manifest, Value)> {
    let label = format!("Invalid module manifest {}", path.display());
    let raw: Value = serde_json::from_slice(
        &fs::read(path).with_context(|| format!("Could not read {}", path.display()))?,
    )
    .with_context(|| label.clone())?;
    validate_manifest(&raw).with_context(|| label.clone())?;
    let manifest = serde_json::from_value(raw.clone()).with_context(|| label.clone())?;
    Ok((manifest, raw))
}

/// A located module whose manifest, entry, and dependency inputs are valid.
pub struct Inspected {
    pub manifest_path: PathBuf,
    pub manifest: Manifest,
    pub raw: Value,
}

/// Locates a module and checks everything that does not depend on an
/// instance's configuration.
pub fn inspect(reference: &str, base: &Path, home: Option<&Path>) -> Result<Inspected> {
    let manifest_path = locate(reference, base, home)?;
    let (manifest, raw) = read_manifest(&manifest_path)?;
    let directory = manifest_path
        .parent()
        .context("Manifest has no directory")?;
    let entry = directory.join(&manifest.entry);
    if !entry.is_file() {
        bail!("Module entry not found: {}", entry.display());
    }
    if manifest.dependencies == Dependencies::Install {
        lockfile(directory)?;
    }
    Ok(Inspected {
        manifest_path,
        manifest,
        raw,
    })
}

/// The SDK description of a module: its manifest file and validated manifest.
pub fn describe(reference: &str, base: &Path) -> Result<Value> {
    let inspected = inspect(reference, base, home().as_deref())?;
    Ok(json!({
        "manifestPath": utf8(&inspected.manifest_path)?,
        "manifest": inspected.raw,
    }))
}

fn entries<'a>(raw: &'a Value, field: &str) -> Result<Vec<(&'a String, &'a Value)>> {
    let Some(value) = raw.get(field) else {
        return Ok(Vec::new());
    };
    let object = value
        .as_object()
        .with_context(|| format!("{field} must be an object"))?;
    for key in object.keys() {
        if !capability_name(key) {
            bail!(
                "Invalid {field} name {key:?}: use a letter followed by letters, numbers, _ or -"
            );
        }
    }
    Ok(object.iter().collect())
}

fn validate_manifest(raw: &Value) -> Result<()> {
    object_keys(raw, MANIFEST_KEYS, "manifest")?;
    let name = raw["name"].as_str().context("name must be a string")?;
    if name.is_empty() || name.contains(|c: char| c.is_control() || c.is_whitespace()) {
        bail!("name must be a non-empty string without whitespace");
    }
    for field in ["version", "description", "$schema"] {
        if raw.get(field).is_some_and(|v| !v.is_string()) {
            bail!("{field} must be a string");
        }
    }
    let entry = raw["entry"].as_str().context("entry must be a string")?;
    if entry.is_empty()
        || entry.starts_with('/')
        || entry.contains(['\\', '\0', ':'])
        || entry.split('/').any(|s| s == "..")
        || crate::config::normalize(entry).is_ok_and(|e| e.is_empty())
    {
        bail!("entry must be a relative path inside the module directory: {entry:?}");
    }
    if raw
        .get("export")
        .is_some_and(|v| v.as_str().is_none_or(str::is_empty))
    {
        bail!("export must be a non-empty string");
    }
    if raw.get("state").is_some_and(|v| !v.is_boolean()) {
        bail!("state must be a boolean");
    }
    if raw
        .get("dependencies")
        .is_some_and(|v| !matches!(v.as_str(), Some("bundled" | "install")))
    {
        bail!("dependencies must be \"bundled\" or \"install\"");
    }
    for (key, setting) in entries(raw, "settings")? {
        object_keys(setting, SETTING_KEYS, &format!("settings.{key}"))?;
        let kind = setting["type"].as_str().unwrap_or_default();
        if !SETTING_TYPES.contains(&kind) {
            bail!(
                "settings.{key}.type must be one of {}",
                SETTING_TYPES.join(", ")
            );
        }
        let spec: SettingSpec =
            serde_json::from_value(setting.clone()).with_context(|| format!("settings.{key}"))?;
        if let Some(choices) = &spec.choices {
            if choices.is_empty() || choices.iter().any(|c| !type_matches(kind, c)) {
                bail!("settings.{key}.enum must be a non-empty list of {kind} values");
            }
        }
        if let Some(default) = &spec.default {
            check_setting(&spec, default, &format!("settings.{key}.default"))?;
        }
    }
    for (key, secret) in entries(raw, "secrets")? {
        object_keys(secret, SECRET_KEYS, &format!("secrets.{key}"))?;
        if secret
            .get("env")
            .is_some_and(|v| v.as_str().is_none_or(|v| !environment_name(v)))
        {
            bail!("secrets.{key}.env must be an environment variable name");
        }
    }
    for (key, port) in entries(raw, "ports")? {
        let label = format!("ports.{key}");
        match port.get("direction").and_then(Value::as_str) {
            Some("outbound") => {
                object_keys(port, OUTBOUND_PORT_KEYS, &label)?;
                if let Some(target) = port.get("target") {
                    parse_target(
                        target
                            .as_str()
                            .with_context(|| format!("{label}.target must be a string"))?,
                    )
                    .with_context(|| format!("{label}.target"))?;
                }
            }
            Some("inbound") => {
                object_keys(port, INBOUND_PORT_KEYS, &label)?;
                for field in ["port", "hostPort"] {
                    if let Some(value) = port.get(field) {
                        if !value.as_u64().is_some_and(|p| (1..=65535).contains(&p)) {
                            bail!("{label}.{field} must be between 1 and 65535");
                        }
                    }
                }
                if port.get("port").is_none() {
                    bail!("{label}.port is required for inbound ports");
                }
            }
            _ => bail!("{label}.direction must be \"outbound\" or \"inbound\""),
        }
    }
    for (key, path) in entries(raw, "paths")? {
        let label = format!("paths.{key}");
        object_keys(path, PATH_KEYS, &label)?;
        let spec: PathSpec = serde_json::from_value(path.clone()).with_context(|| label.clone())?;
        if let Some(default) = &spec.default {
            if !(default == "~" || default.starts_with("~/") || Path::new(default).is_absolute()) {
                bail!("{label}.default must be an absolute path or start with ~/");
            }
        }
        if let Some(target) = &spec.target {
            container_target(target).with_context(|| format!("{label}.target"))?;
        }
    }
    Ok(())
}

fn utf8(path: &Path) -> Result<String> {
    path.to_str()
        .map(String::from)
        .with_context(|| format!("Path must be valid UTF-8: {}", path.display()))
}

/// Binds every configured module instance to its manifest. Host paths in the
/// configuration are made absolute in place so that the effective configuration
/// can be reported and replayed.
pub fn resolve(config: &mut Config, base: &Path) -> Result<Vec<Resolved>> {
    resolve_with(config, base, home().as_deref())
}

pub fn resolve_with(
    config: &mut Config,
    base: &Path,
    home: Option<&Path>,
) -> Result<Vec<Resolved>> {
    let mut resolved = Vec::new();
    for (name, instance) in &mut config.modules {
        resolved.push(
            bind(name, instance, base, home)
                .with_context(|| format!("Module {name:?} could not be configured"))?,
        );
    }
    check_conflicts(&resolved, config.container.smb_port)?;
    Ok(resolved)
}

fn bind(
    name: &str,
    instance: &mut ModuleInstance,
    base: &Path,
    home: Option<&Path>,
) -> Result<Resolved> {
    let Inspected {
        manifest_path,
        manifest,
        ..
    } = inspect(&instance.manifest, base, home)?;
    instance.manifest = utf8(&manifest_path)?;
    let mut settings = Map::new();
    for key in instance.settings.keys() {
        if !manifest.settings.contains_key(key) {
            bail!("The manifest declares no setting {key:?}");
        }
    }
    for (key, spec) in &manifest.settings {
        let label = format!("modules.{name}.settings.{key}");
        match instance.settings.get(key).or(spec.default.as_ref()) {
            Some(value) => {
                check_setting(spec, value, &label)?;
                settings.insert(key.clone(), value.clone());
            }
            None if spec.required => bail!("{label} is required"),
            None => (),
        }
    }
    for key in instance.secrets.keys() {
        if !manifest.secrets.contains_key(key) {
            bail!("The manifest declares no secret {key:?}");
        }
    }
    let mut secrets = BTreeMap::new();
    for (key, spec) in &manifest.secrets {
        let source = match instance.secrets.get_mut(key) {
            Some(source) => Some(match (&source.env, &mut source.file) {
                (Some(env), _) => SecretSource::Env(env.clone()),
                (None, Some(file)) => {
                    *file = host_path(base, file, home)?;
                    SecretSource::File(file.clone())
                }
                _ => bail!("modules.{name}.secrets.{key} needs env or file"),
            }),
            None => spec.env.clone().map(SecretSource::Env),
        };
        secrets.insert(
            key.clone(),
            SecretBinding {
                source,
                required: spec.required,
            },
        );
    }
    for key in instance.ports.keys() {
        if !manifest.ports.contains_key(key) {
            bail!("The manifest declares no port {key:?}");
        }
    }
    let mut ports = BTreeMap::new();
    for (key, spec) in &manifest.ports {
        let binding = instance.ports.get(key);
        let port = match spec {
            PortSpec::Outbound { target } => {
                if binding.is_some_and(|b| b.host_port.is_some()) {
                    bail!("modules.{name}.ports.{key} is outbound; configure it with target");
                }
                let target = binding
                    .and_then(|b| b.target.clone())
                    .or_else(|| target.clone())
                    .with_context(|| {
                        format!(
                            "modules.{name}.ports.{key} needs a target: {{\"target\": \"host:port\"}}"
                        )
                    })?;
                parse_target(&target)?;
                Port::Outbound { target }
            }
            PortSpec::Inbound { port, host_port } => {
                if binding.is_some_and(|b| b.target.is_some()) {
                    bail!("modules.{name}.ports.{key} is inbound; configure it with hostPort");
                }
                Port::Inbound {
                    port: *port,
                    host_port: binding
                        .and_then(|b| b.host_port)
                        .or(*host_port)
                        .unwrap_or(*port),
                }
            }
        };
        ports.insert(key.clone(), port);
    }
    for key in instance.paths.keys() {
        if !manifest.paths.contains_key(key) {
            bail!("The manifest declares no path {key:?}");
        }
    }
    let mut paths = BTreeMap::new();
    for (key, spec) in &manifest.paths {
        let label = format!("modules.{name}.paths.{key}");
        let configured = instance.paths.get_mut(key);
        let explicit = configured.is_some();
        let host = match configured {
            Some(path) => {
                *path = host_path(base, path, home)?;
                Some(path.clone())
            }
            None => spec
                .default
                .as_ref()
                .map(|d| host_path(base, Path::new(d), home))
                .transpose()?,
        };
        let Some(host) = host else {
            if spec.required {
                bail!("{label} is required: set it to a host path");
            }
            continue;
        };
        let expected = match spec.kind {
            PathKind::Directory => "directory",
            PathKind::File => "file",
        };
        match fs::metadata(&host) {
            Ok(meta) if meta.is_dir() == (spec.kind == PathKind::Directory) => (),
            Ok(_) => bail!("{label} must be a {expected}: {}", host.display()),
            Err(_) if !explicit && !spec.required => continue,
            Err(error) => bail!(
                "{label} ({expected}) is not accessible: {}: {error}",
                host.display()
            ),
        }
        utf8(&host)?;
        paths.insert(
            key.clone(),
            BoundPath {
                host,
                target: spec
                    .target
                    .clone()
                    .unwrap_or_else(|| format!("/scriptfs/paths/{name}/{key}")),
                writable: spec.access == Access::ReadWrite,
            },
        );
    }
    let state = match (&mut instance.state, manifest.state) {
        (Some(_), false) => {
            bail!("modules.{name}.state is set, but the manifest does not use state")
        }
        (Some(path), true) => {
            *path = host_path(base, path, home)?;
            Some(path.clone())
        }
        (None, true) => {
            let path = base.join(".scriptfs").join("state").join(name);
            instance.state = Some(path.clone());
            Some(path)
        }
        (None, false) => None,
    };
    if let Some(state) = &state {
        utf8(state)?;
        if state.exists() && !state.is_dir() {
            bail!(
                "modules.{name}.state must be a directory: {}",
                state.display()
            );
        }
    }
    Ok(Resolved {
        instance: name.into(),
        manifest_path,
        manifest,
        settings,
        ports,
        paths,
        state,
        secrets,
    })
}

fn check_conflicts(modules: &[Resolved], smb_port: Option<u16>) -> Result<()> {
    let mut targets: Vec<(&str, String)> = Vec::new();
    let mut container_ports = BTreeMap::new();
    let mut host_ports = BTreeMap::new();
    for module in modules {
        for (key, path) in &module.paths {
            let label = format!("modules.{}.paths.{key}", module.instance);
            for (target, other) in &targets {
                let nested = |a: &str, b: &str| a.starts_with(&format!("{b}/"));
                if *target == path.target
                    || nested(target, &path.target)
                    || nested(&path.target, target)
                {
                    bail!(
                        "{label} and {other} use overlapping container targets ({} and {target})",
                        path.target
                    );
                }
            }
            targets.push((&path.target, label));
        }
        for (key, port) in &module.ports {
            if let Port::Inbound { port, host_port } = port {
                let label = format!("modules.{}.ports.{key}", module.instance);
                if [SMB_PORT, TUNNEL_PORT].contains(port) {
                    bail!("{label} cannot listen on container port {port}: it is used by ScriptFS");
                }
                if smb_port == Some(*host_port) {
                    bail!("{label} host port {host_port} is already used by container.smbPort");
                }
                if let Some(other) = container_ports.insert(*port, label.clone()) {
                    bail!("{label} and {other} both listen on container port {port}");
                }
                if let Some(other) = host_ports.insert(*host_port, label.clone()) {
                    bail!("{label} and {other} both publish host port {host_port}");
                }
            }
        }
    }
    Ok(())
}

/// Reads secret values. Missing optional secrets are omitted.
pub fn read_secrets(
    modules: &[Resolved],
    environment: &dyn Fn(&str) -> Option<String>,
) -> Result<BTreeMap<String, BTreeMap<String, String>>> {
    let mut output = BTreeMap::new();
    for module in modules {
        let mut values = BTreeMap::new();
        for (key, binding) in &module.secrets {
            let label = format!("Module {:?} secret {key:?}", module.instance);
            let value = match &binding.source {
                Some(SecretSource::Env(name)) => {
                    let value = environment(name).filter(|v| !v.is_empty());
                    if value.is_none() && binding.required {
                        bail!(
                            "{label} is required: set the {name} environment variable or configure modules.{}.secrets.{key}",
                            module.instance
                        );
                    }
                    value
                }
                Some(SecretSource::File(path)) => {
                    let mut value = fs::read_to_string(path)
                        .with_context(|| format!("{label}: could not read {}", path.display()))?;
                    if value.ends_with('\n') {
                        value.pop();
                        if value.ends_with('\r') {
                            value.pop();
                        }
                    }
                    Some(value)
                }
                None if binding.required => bail!(
                    "{label} is required: configure modules.{}.secrets.{key} as {{\"env\": \"VARIABLE\"}} or {{\"file\": \"path\"}}",
                    module.instance
                ),
                None => None,
            };
            if let Some(value) = value {
                values.insert(key.clone(), value);
            }
        }
        if !values.is_empty() {
            output.insert(module.instance.clone(), values);
        }
    }
    Ok(output)
}

/// Tunnel route name for an outbound port.
pub fn route(instance: &str, port: &str) -> String {
    format!("{instance}.{port}")
}

/// Outbound routes declared by the runtime configuration.
pub fn outbound_routes(modules: &BTreeMap<String, RuntimeModule>) -> Vec<String> {
    modules
        .iter()
        .flat_map(|(name, module)| {
            module
                .ports
                .iter()
                .filter(|(_, port)| matches!(port, RuntimePort::Outbound {}))
                .map(|(key, _)| route(name, key))
        })
        .collect()
}

/// Builds the worker `load` request. `outbound` maps tunnel routes to the
/// container-local ports their listeners are bound to.
pub fn load_request(
    modules: &BTreeMap<String, RuntimeModule>,
    secrets: &Secrets,
    outbound: &BTreeMap<String, u16>,
) -> Result<Value> {
    let mut output = Map::new();
    for (name, module) in modules {
        let mut ports = Map::new();
        for (key, port) in &module.ports {
            ports.insert(
                key.clone(),
                match port {
                    RuntimePort::Outbound {} => {
                        let port = outbound
                            .get(&route(name, key))
                            .with_context(|| format!("No tunnel listener for {name}.{key}"))?;
                        json!({"direction":"outbound","host":"127.0.0.1","port":port})
                    }
                    RuntimePort::Inbound { port, host_port } => {
                        json!({"direction":"inbound","host":"0.0.0.0","port":port,"hostPort":host_port})
                    }
                },
            );
        }
        let mut runtime = json!({
            "version": 1,
            "name": name,
            "manifest": module.manifest,
            "settings": module.settings,
            "secrets": secrets.modules.get(name).cloned().unwrap_or_default(),
            "ports": ports,
            "paths": module.paths,
        });
        if let Some(state) = &module.state_dir {
            runtime["stateDir"] = json!(state);
        }
        output.insert(
            name.clone(),
            json!({"entry":module.entry,"export":module.export,"runtime":runtime}),
        );
    }
    Ok(json!({"op":"load","modules":output}))
}

/// Container-side description of a resolved module. `entry` is the container
/// path of the module entry point.
pub fn runtime_module(module: &Resolved, entry: String) -> RuntimeModule {
    let mut manifest = json!({"name": module.manifest.name});
    if let Some(version) = &module.manifest.version {
        manifest["version"] = json!(version);
    }
    RuntimeModule {
        entry,
        export: module.manifest.export.clone(),
        manifest,
        settings: module.settings.clone(),
        ports: module
            .ports
            .iter()
            .map(|(key, port)| {
                (
                    key.clone(),
                    match port {
                        Port::Outbound { .. } => RuntimePort::Outbound {},
                        Port::Inbound { port, host_port } => RuntimePort::Inbound {
                            port: *port,
                            host_port: *host_port,
                        },
                    },
                )
            })
            .collect(),
        paths: module
            .paths
            .iter()
            .map(|(key, path)| (key.clone(), path.target.clone()))
            .collect(),
        state_dir: module
            .state
            .as_ref()
            .map(|_| format!("/scriptfs/state/{}", module.instance)),
    }
}

#[cfg(test)]
#[path = "module_tests.rs"]
mod tests;
