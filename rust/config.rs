use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub modules: BTreeMap<String, ModuleInstance>,
    pub filesystems: Vec<Filesystem>,
    #[serde(default, skip_serializing_if = "Container::empty")]
    pub container: Container,
}

/// Configuration the host generates for the container runtime.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    pub filesystems: Vec<Filesystem>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub modules: BTreeMap<String, crate::module::RuntimeModule>,
}
impl RuntimeConfig {
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let config: Self =
            serde_json::from_slice(bytes).context("Invalid ScriptFS runtime configuration")?;
        for rule in config.filesystems.iter().flat_map(|f| &f.rules) {
            if let Some(module) = rule.provider.as_ref().and_then(|p| p.module.as_ref()) {
                if !config.modules.contains_key(module) {
                    bail!("Rule {} uses unknown module {module:?}", rule.pattern);
                }
            }
        }
        Ok(config)
    }
}

/// A configured module instance: which manifest to load and how to bind the
/// capabilities that manifest declares.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleInstance {
    pub manifest: String,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub settings: serde_json::Map<String, Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub secrets: BTreeMap<String, SecretSource>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub ports: BTreeMap<String, PortBinding>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub paths: BTreeMap<String, PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<PathBuf>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SecretSource {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<PathBuf>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortBinding {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_port: Option<u16>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub rebuild: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub smb_host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub smb_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_level: Option<String>,
}
impl Container {
    fn empty(&self) -> bool {
        self.image.is_none()
            && !self.rebuild
            && self.smb_host.is_none()
            && self.smb_port.is_none()
            && self.log_level.is_none()
    }
}
fn is_false(value: &bool) -> bool {
    !value
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Filesystem {
    pub name: String,
    pub source: PathBuf,
    pub mount_point: PathBuf,
    #[serde(default, skip_serializing_if = "is_false")]
    pub read_only: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<Rule>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    #[serde(rename = "match")]
    pub pattern: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub hide: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<Provider>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub opaque: bool,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub file: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Provider {
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<PathBuf>,
    #[serde(
        default,
        deserialize_with = "present_value",
        skip_serializing_if = "Option::is_none"
    )]
    pub options: Option<Value>,
}

fn present_value<'de, D>(deserializer: D) -> std::result::Result<Option<Value>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Value::deserialize(deserializer).map(Some)
}

impl Config {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let raw: Value = serde_json::from_slice(bytes).context("Invalid ScriptFS configuration")?;
        validate_shape(&raw)?;
        let config: Self = serde_json::from_value(raw).context("Invalid ScriptFS configuration")?;
        if config.filesystems.is_empty() {
            bail!("At least one filesystem is required");
        }
        let mut names = HashSet::new();
        let mut mounts = HashSet::new();
        for fs in &config.filesystems {
            let name = fs.name.to_lowercase();
            if name.is_empty()
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                || ["global", "homes", "printers"].contains(&name.as_str())
            {
                bail!(
                    "Invalid filesystem name (must contain only letters, numbers, _ or - and must not be a reserved Samba section name): {}",
                    fs.name
                );
            }
            if !names.insert(name) {
                bail!("Each filesystem must use a unique name");
            }
            let mount = fs.mount_point.to_string_lossy();
            let key = if cfg!(windows) {
                mount.to_uppercase()
            } else {
                mount.into_owned()
            };
            if !mounts.insert(key) {
                bail!("Each filesystem must use a unique mountPoint");
            }
            if fs.source.as_os_str().is_empty() || fs.mount_point.as_os_str().is_empty() {
                bail!("source and mountPoint must not be empty");
            }
            for rule in &fs.rules {
                if rule.pattern.is_empty() {
                    bail!("Rule match must not be empty");
                }
                normalize(&rule.pattern)?;
                if let Some(root) = &rule.root {
                    normalize(root)?;
                }
                match (&rule.provider, rule.hide) {
                    (None, true) => (),
                    (Some(provider), false) => {
                        match provider.kind.as_deref().unwrap_or("module") {
                            "module"
                                if provider.module.as_ref().is_some_and(|m| !m.is_empty())
                                    && provider.path.is_none() => {}
                            "file" | "directory"
                                if provider
                                    .path
                                    .as_ref()
                                    .is_some_and(|p| !p.as_os_str().is_empty())
                                    && provider.module.is_none() => {}
                            _ => bail!("Invalid provider reference for {}", rule.pattern),
                        }
                        if let Some(module) = &provider.module {
                            if !config.modules.contains_key(module) {
                                bail!(
                                    "Rule {} uses module {module:?}, which is not declared under modules",
                                    rule.pattern
                                );
                            }
                        }
                        if !rule.file.is_null() {
                            let defaults = rule
                                .file
                                .as_object()
                                .context("file defaults must be an object")?;
                            for key in ["mode", "size"] {
                                if defaults.get(key).is_some_and(|v| v.as_u64().is_none()) {
                                    bail!("{key} must be a non-negative integer");
                                }
                            }
                            if defaults.get("sizeMode").is_some_and(|v| {
                                !["content", "explicit", "zero", "unbounded"]
                                    .iter()
                                    .any(|m| v.as_str() == Some(m))
                            }) {
                                bail!("Invalid sizeMode");
                            }
                            if defaults.get("seekable").is_some_and(|v| !v.is_boolean()) {
                                bail!("seekable must be boolean");
                            }
                        }
                    }
                    _ => bail!("A rule must contain either hide: true or a provider"),
                }
            }
        }
        for (name, instance) in &config.modules {
            validate_instance(name, instance)?;
        }
        if config.container.smb_port == Some(0) {
            bail!("smbPort must be between 1 and 65535");
        }
        if config
            .container
            .log_level
            .as_ref()
            .is_some_and(|s| !["silent", "info", "debug"].contains(&s.as_str()))
        {
            bail!("Invalid logLevel");
        }
        if config
            .container
            .image
            .as_ref()
            .is_some_and(|s| s.is_empty())
            || config
                .container
                .smb_host
                .as_ref()
                .is_some_and(|s| s.is_empty())
        {
            bail!("Container image and smbHost must not be empty");
        }
        Ok(config)
    }
}

pub(crate) fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn validate_instance(name: &str, instance: &ModuleInstance) -> Result<()> {
    if !identifier(name) {
        bail!("Invalid module name (must contain only letters, numbers, _ or -): {name:?}");
    }
    if instance.manifest.is_empty() {
        bail!("modules.{name}.manifest must not be empty");
    }
    for (key, source) in &instance.secrets {
        match (&source.env, &source.file) {
            (Some(env), None) if crate::module::environment_name(env) => (),
            (None, Some(file)) if !file.as_os_str().is_empty() => (),
            _ => bail!(
                "modules.{name}.secrets.{key} must be either {{\"env\": \"VARIABLE\"}} or {{\"file\": \"path\"}}"
            ),
        }
    }
    for (key, binding) in &instance.ports {
        match (&binding.target, binding.host_port) {
            (Some(target), None) => {
                crate::module::parse_target(target)
                    .with_context(|| format!("modules.{name}.ports.{key}.target"))?;
            }
            (None, Some(port)) if port != 0 => (),
            _ => bail!(
                "modules.{name}.ports.{key} must be either {{\"target\": \"host:port\"}} or {{\"hostPort\": 1-65535}}"
            ),
        }
    }
    for (key, path) in &instance.paths {
        if path.as_os_str().is_empty() {
            bail!("modules.{name}.paths.{key} must not be empty");
        }
    }
    if instance
        .state
        .as_ref()
        .is_some_and(|p| p.as_os_str().is_empty())
    {
        bail!("modules.{name}.state must not be empty");
    }
    Ok(())
}

/// Accepted object fields, shared with `scriptfs.schema.json`. The
/// `config_schema_matches_validator` test keeps both in sync so an
/// editor cannot report a configuration as valid that the binary then rejects.
pub(crate) const CONFIG_KEYS: &[&str] = &["$schema", "modules", "filesystems", "container"];
pub(crate) const MODULE_KEYS: &[&str] =
    &["manifest", "settings", "secrets", "ports", "paths", "state"];
pub(crate) const SECRET_SOURCE_KEYS: &[&str] = &["env", "file"];
pub(crate) const PORT_BINDING_KEYS: &[&str] = &["target", "hostPort"];
pub(crate) const CONTAINER_KEYS: &[&str] = &["image", "rebuild", "smbHost", "smbPort", "logLevel"];
pub(crate) const FILESYSTEM_KEYS: &[&str] = &["name", "source", "mountPoint", "readOnly", "rules"];
pub(crate) const RULE_KEYS: &[&str] = &["match", "root", "hide", "provider", "opaque", "file"];
pub(crate) const HIDE_RULE_KEYS: &[&str] = &["match", "hide"];
pub(crate) const MODULE_PROVIDER_KEYS: &[&str] = &["type", "module", "options"];
pub(crate) const PROXY_PROVIDER_KEYS: &[&str] = &["type", "path"];
pub(crate) const FILE_KEYS: &[&str] = &["mode", "size", "sizeMode", "seekable"];

pub(crate) fn object_keys(value: &Value, allowed: &[&str], label: &str) -> Result<()> {
    let object = value
        .as_object()
        .with_context(|| format!("{label} must be an object"))?;
    for (key, value) in object {
        if !allowed.contains(&key.as_str()) {
            bail!("Unknown {label} field: {key}");
        }
        if value.is_null() && key != "options" {
            bail!("{label}.{key} must not be null");
        }
    }
    Ok(())
}

fn validate_shape(value: &Value) -> Result<()> {
    object_keys(value, CONFIG_KEYS, "config")?;
    let filesystems = value["filesystems"]
        .as_array()
        .context("filesystems must be an array")?;
    if let Some(container) = value.get("container") {
        object_keys(container, CONTAINER_KEYS, "container")?;
    }
    if let Some(modules) = value.get("modules") {
        for (name, module) in modules.as_object().context("modules must be an object")? {
            object_keys(module, MODULE_KEYS, &format!("modules.{name}"))?;
            if let Some(settings) = module.get("settings") {
                settings
                    .as_object()
                    .with_context(|| format!("modules.{name}.settings must be an object"))?;
            }
            for (field, allowed) in [
                ("secrets", SECRET_SOURCE_KEYS),
                ("ports", PORT_BINDING_KEYS),
            ] {
                if let Some(entries) = module.get(field) {
                    for (key, entry) in entries
                        .as_object()
                        .with_context(|| format!("modules.{name}.{field} must be an object"))?
                    {
                        object_keys(entry, allowed, &format!("modules.{name}.{field}.{key}"))?;
                    }
                }
            }
            if let Some(paths) = module.get("paths") {
                for (key, path) in paths
                    .as_object()
                    .with_context(|| format!("modules.{name}.paths must be an object"))?
                {
                    if !path.is_string() {
                        bail!("modules.{name}.paths.{key} must be a host path string");
                    }
                }
            }
        }
    }
    for filesystem in filesystems {
        object_keys(filesystem, FILESYSTEM_KEYS, "filesystem")?;
        if let Some(rules) = filesystem.get("rules") {
            for rule in rules.as_array().context("rules must be an array")? {
                object_keys(rule, RULE_KEYS, "rule")?;
                if rule.get("hide") == Some(&Value::Bool(true)) {
                    if rule
                        .as_object()
                        .unwrap()
                        .keys()
                        .any(|key| !HIDE_RULE_KEYS.contains(&key.as_str()))
                    {
                        bail!(
                            "A hide rule cannot also contain provider, root, opaque or file fields"
                        );
                    }
                } else if let Some(provider) = rule.get("provider") {
                    let module = provider
                        .get("type")
                        .and_then(Value::as_str)
                        .is_none_or(|kind| kind == "module");
                    object_keys(
                        provider,
                        if module {
                            MODULE_PROVIDER_KEYS
                        } else {
                            PROXY_PROVIDER_KEYS
                        },
                        "provider",
                    )?;
                    if let Some(file) = rule.get("file") {
                        object_keys(file, FILE_KEYS, "file")?;
                    }
                }
            }
        }
    }
    Ok(())
}

pub fn public_config(raw: &Value, config: &Config) -> Value {
    let mut output = raw.clone();
    if let Some(object) = output.as_object_mut() {
        object.remove("$schema");
    }
    for (name, instance) in &config.modules {
        let value = &mut output["modules"][name];
        value["manifest"] = serde_json::json!(instance.manifest);
        for (key, path) in &instance.paths {
            value["paths"][key] = serde_json::json!(path);
        }
        for (key, source) in &instance.secrets {
            if let Some(file) = &source.file {
                value["secrets"][key]["file"] = serde_json::json!(file);
            }
        }
        if let Some(state) = &instance.state {
            value["state"] = serde_json::json!(state);
        }
    }
    for (value, filesystem) in output["filesystems"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .zip(&config.filesystems)
    {
        value["source"] = serde_json::json!(filesystem.source);
        value["mountPoint"] = serde_json::json!(filesystem.mount_point);
        if let Some(rules) = value.get_mut("rules").and_then(Value::as_array_mut) {
            for (value, rule) in rules.iter_mut().zip(&filesystem.rules) {
                if value.get("hide") == Some(&Value::Bool(false)) {
                    value.as_object_mut().unwrap().remove("hide");
                }
                if let Some(provider) = &rule.provider {
                    if let Some(module) = &provider.module {
                        value["provider"]["module"] = serde_json::json!(module);
                    }
                    if let Some(path) = &provider.path {
                        value["provider"]["path"] = serde_json::json!(path);
                    }
                }
            }
        }
    }
    output
}

pub fn normalize(input: &str) -> Result<String> {
    if input.split('/').any(|s| s == "..") || input.contains('\0') {
        bail!("Invalid virtual path: {input}");
    }
    Ok(input
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .collect::<Vec<_>>()
        .join("/"))
}

pub fn absolute(base: &Path, path: &Path) -> PathBuf {
    let input = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    let mut result = PathBuf::new();
    for part in input.components() {
        match part {
            std::path::Component::CurDir => (),
            std::path::Component::ParentDir => {
                result.pop();
            }
            part => result.push(part),
        }
    }
    result
}

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;
