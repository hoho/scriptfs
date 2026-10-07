#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use crate::{
    config::{Filesystem, Provider, Rule, normalize},
    worker::{ProviderError, Worker},
};
use anyhow::{Context, Result, bail};
use regress::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    ffi::CString,
    fs::{self, File, Metadata as Stat, OpenOptions},
    os::unix::{
        ffi::OsStrExt,
        fs::{FileExt, MetadataExt, OpenOptionsExt},
        io::AsRawFd,
    },
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

pub fn errno(code: i32) -> anyhow::Error {
    std::io::Error::from_raw_os_error(code).into()
}
pub fn error_code(error: &anyhow::Error) -> i32 {
    for cause in error.chain() {
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            return io.raw_os_error().unwrap_or(libc::EIO);
        }
        if let Some(provider) = cause.downcast_ref::<ProviderError>() {
            return match provider.code.as_deref() {
                Some("ENOENT") => libc::ENOENT,
                Some("ENOTDIR") => libc::ENOTDIR,
                Some("EISDIR") => libc::EISDIR,
                Some("EROFS") => libc::EROFS,
                Some("EACCES") => libc::EACCES,
                Some("EPERM") => libc::EPERM,
                Some("EEXIST") => libc::EEXIST,
                Some("EINVAL") => libc::EINVAL,
                Some("EBADF") => libc::EBADF,
                Some("EXDEV") => libc::EXDEV,
                Some("ENOTEMPTY") => libc::ENOTEMPTY,
                Some("ESTALE") => libc::ESTALE,
                Some("EBUSY") => libc::EBUSY,
                Some("ESPIPE") => libc::ESPIPE,
                Some("ENOSPC") => libc::ENOSPC,
                Some("EFBIG") => libc::EFBIG,
                Some("ELOOP") => libc::ELOOP,
                Some("EMFILE") => libc::EMFILE,
                Some("EDQUOT") => libc::EDQUOT,
                Some("ENFILE") => libc::ENFILE,
                Some("ENOMEM") => libc::ENOMEM,
                Some("EINTR") => libc::EINTR,
                Some("EAGAIN" | "EWOULDBLOCK") => libc::EAGAIN,
                Some("ENAMETOOLONG") => libc::ENAMETOOLONG,
                Some("ERANGE") => libc::ERANGE,
                Some("ETIMEDOUT") => libc::ETIMEDOUT,
                Some("ENOSYS" | "EOPNOTSUPP" | "ENOTSUP") => libc::EOPNOTSUPP,
                _ => libc::EIO,
            };
        }
    }
    libc::EIO
}
fn missing(error: &anyhow::Error) -> bool {
    [libc::ENOENT, libc::ENOTDIR].contains(&error_code(error))
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    File,
    Directory,
    Symlink,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Date {
    #[serde(rename = "$date")]
    pub millis: i64,
}
impl Date {
    pub fn now() -> Self {
        Self {
            millis: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64,
        }
    }
    pub fn time(&self) -> SystemTime {
        if self.millis >= 0 {
            UNIX_EPOCH + std::time::Duration::from_millis(self.millis as u64)
        } else {
            UNIX_EPOCH - std::time::Duration::from_millis(self.millis.unsigned_abs())
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub kind: Kind,
    pub identity: Option<String>,
    pub nlink: Option<u32>,
    pub size: Option<u64>,
    pub size_mode: Option<String>,
    pub seekable: Option<bool>,
    pub mode: Option<u32>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub atime: Option<Date>,
    pub mtime: Option<Date>,
    pub ctime: Option<Date>,
    pub birthtime: Option<Date>,
    pub target: Option<String>,
    #[serde(skip)]
    content_times: Option<[Option<i64>; 3]>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContentRevision {
    size: Option<u64>,
    times: [Option<i64>; 3],
}
impl Metadata {
    pub fn content_revision(&self) -> ContentRevision {
        ContentRevision {
            size: self.size,
            times: self.content_times.unwrap_or_else(|| self.revision_times()),
        }
    }
    fn revision_times(&self) -> [Option<i64>; 3] {
        [&self.mtime, &self.ctime, &self.birthtime].map(|date| date.as_ref().map(|d| d.millis))
    }
    pub fn from_value(value: Value) -> Result<Option<Self>> {
        if value.is_null() {
            return Ok(None);
        }
        let metadata: Self = serde_json::from_value(value).context("Invalid provider metadata")?;
        if metadata
            .size_mode
            .as_ref()
            .is_some_and(|m| !["content", "explicit", "zero", "unbounded"].contains(&m.as_str()))
        {
            bail!("Invalid provider sizeMode");
        }
        Ok(Some(metadata))
    }
    pub fn directory() -> Self {
        serde_json::from_value(json!({"kind":"directory","mode":493})).expect("constant metadata")
    }
    pub fn normalized(mut self) -> Self {
        // Display-time defaults are not provider content revisions.
        if self.content_times.is_none() {
            self.content_times = Some(self.revision_times());
        }
        self.mode.get_or_insert(if self.kind == Kind::Directory {
            0o755
        } else {
            0o644
        });
        self.size.get_or_insert(if self.kind == Kind::Directory {
            4096
        } else {
            0
        });
        self.uid.get_or_insert(unsafe { libc::getuid() });
        self.gid.get_or_insert(unsafe { libc::getgid() });
        let now = Date::now();
        self.atime.get_or_insert(now.clone());
        self.mtime.get_or_insert(now.clone());
        self.ctime.get_or_insert(now.clone());
        self.birthtime.get_or_insert(now);
        self
    }
    pub fn resize(&mut self, size: u64) {
        if self.kind == Kind::File
            && !matches!(self.size_mode.as_deref(), Some("zero" | "unbounded"))
        {
            self.size = Some(size);
        }
    }
}
pub fn native_metadata(stat: &Stat) -> Result<Metadata> {
    let kind = if stat.is_file() {
        Kind::File
    } else if stat.is_dir() {
        Kind::Directory
    } else if stat.file_type().is_symlink() {
        Kind::Symlink
    } else {
        return Err(errno(libc::EOPNOTSUPP));
    };
    let date = |sec: i64, ns: i64| Date {
        millis: sec.saturating_mul(1000) + ns / 1_000_000,
    };
    Ok(Metadata {
        kind,
        identity: Some(format!("native:{}:{}", stat.dev(), stat.ino())),
        nlink: Some(stat.nlink().min(u32::MAX as u64) as u32),
        size: Some(stat.len()),
        size_mode: Some("explicit".into()),
        seekable: Some(true),
        mode: Some(stat.mode() & 0o7777),
        uid: Some(stat.uid()),
        gid: Some(stat.gid()),
        atime: Some(date(stat.atime(), stat.atime_nsec())),
        mtime: Some(date(stat.mtime(), stat.mtime_nsec())),
        ctime: Some(date(stat.ctime(), stat.ctime_nsec())),
        birthtime: Some(
            stat.created()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|t| Date {
                    millis: t.as_millis() as i64,
                })
                .unwrap_or_else(|| date(stat.ctime(), stat.ctime_nsec())),
        ),
        target: None,
        content_times: None,
    })
}
fn merge(mut base: Value, overrides: &Value) -> Value {
    if !base.is_object() {
        base = json!({});
    }
    if let Some(fields) = overrides.as_object() {
        for (key, value) in fields {
            if !value.is_null() {
                base[key] = value.clone();
            }
        }
    }
    base
}

struct Compiled {
    rule: Rule,
    regex: Regex,
    root: String,
    expose: bool,
    explicit: bool,
    child: Option<String>,
    parent_regex: Regex,
    parent_root: bool,
    methods: Option<HashSet<String>>,
}
impl Compiled {
    fn matches(&self, path: &str) -> bool {
        self.regex.find(path).is_some() || (self.explicit && self.root == path)
    }
    fn provider(&self) -> &Provider {
        self.rule.provider.as_ref().expect("provider rule")
    }
}
pub struct Handle {
    pub binding: Option<usize>,
    pub value: Option<u64>,
    pub resource: Option<u64>,
    pub native: Option<File>,
    pub flags: i32,
    pub captured: Option<Metadata>,
    pub directory: bool,
}
pub struct Overlay {
    pub config: Filesystem,
    worker: Arc<Worker>,
    rules: Vec<Compiled>,
    hidden: Vec<Regex>,
}
impl Overlay {
    pub fn new(config: Filesystem, worker: Arc<Worker>) -> Result<Self> {
        let patterns = worker
            .request(json!({"op":"patterns","rules":config.rules}), &[])?
            .value;
        let patterns = patterns
            .as_array()
            .context("Invalid compiled provider rules")?;
        let mut rules = Vec::new();
        let mut hidden = Vec::new();
        for (rule, compiled) in config.rules.iter().zip(patterns) {
            let regex = Regex::new(compiled["regex"].as_str().context("Missing rule regex")?)
                .map_err(|e| anyhow::anyhow!("Invalid glob {}: {e}", rule.pattern))?;
            if rule.hide {
                hidden.push(regex);
                continue;
            }
            rules.push(Compiled {
                rule: rule.clone(),
                regex,
                root: compiled["root"]
                    .as_str()
                    .context("Missing rule root")?
                    .into(),
                expose: compiled["exposeRoot"].as_bool().unwrap_or(false),
                explicit: compiled["explicitRoot"].as_bool().unwrap_or(false),
                child: compiled["child"].as_str().map(String::from),
                parent_regex: Regex::new(
                    compiled["parentRegex"]
                        .as_str()
                        .context("Missing parent regex")?,
                )
                .map_err(|e| anyhow::anyhow!("{e}"))?,
                parent_root: compiled["parentIsRoot"].as_bool().unwrap_or(false),
                methods: None,
            });
        }
        Ok(Self {
            config,
            worker,
            rules,
            hidden,
        })
    }
    fn visible(&self, path: &str) -> Result<()> {
        if self.hidden.iter().any(|m| m.find(path).is_some()) {
            Err(errno(libc::ENOENT))
        } else {
            Ok(())
        }
    }
    pub fn writable(&self) -> Result<()> {
        if self.config.read_only {
            Err(errno(libc::EROFS))
        } else {
            Ok(())
        }
    }
    fn source(&self, path: &str) -> PathBuf {
        self.config.source.join(path)
    }
    fn context(&self, index: usize, path: &str) -> Value {
        let rule = &self.rules[index];
        let mut context = json!({"path":path,"relativePath":relative(&rule.root,path),"ruleRoot":rule.root,"sourcePath":self.source(path)});
        if let Some(options) = &rule.provider().options {
            context["options"] = options.clone();
        }
        context
    }
    fn describe(&mut self, index: usize) -> Result<()> {
        if self.rules[index].methods.is_some() {
            return Ok(());
        }
        let provider = self.rules[index].provider();
        let methods = if provider.module.is_some() {
            serde_json::from_value::<Vec<String>>(
                self.worker
                    .request(json!({"op":"describe","provider":provider}), &[])?
                    .value,
            )?
            .into_iter()
            .collect()
        } else {
            [
                "getattr",
                "readdir",
                "readlink",
                "readFile",
                "writeFile",
                "create",
                "truncate",
                "access",
                "chmod",
                "chown",
                "utimens",
                "mkdir",
                "unlink",
                "rmdir",
                "rename",
            ]
            .iter()
            .map(|m| m.to_string())
            .collect()
        };
        self.rules[index].methods = Some(methods);
        Ok(())
    }
    pub fn supports(&self, index: Option<usize>, op: &str) -> bool {
        index.is_some_and(|i| {
            self.rules[i]
                .methods
                .as_ref()
                .is_some_and(|m| m.contains(op))
        })
    }
    pub fn module(&self, index: Option<usize>) -> bool {
        index.is_some_and(|i| self.rules[i].provider().module.is_some())
    }
    #[allow(clippy::too_many_arguments)]
    fn call(
        &self,
        index: usize,
        path: &str,
        op: &str,
        args: Value,
        handle: Option<&Handle>,
        body: &[u8],
        extra: Value,
    ) -> Result<crate::worker::Response> {
        let mut header = json!({"op":op,"provider":self.rules[index].provider(),"context":self.context(index,path),"args":args});
        if let Some(handle) = handle {
            header["flags"] = json!(handle.flags);
            if let Some(value) = handle.value {
                header["handle"] = json!(value);
            }
        }
        if let Some(fields) = extra.as_object() {
            for (k, v) in fields {
                header[k] = v.clone();
            }
        }
        self.worker.request(header, body)
    }
    fn target(&self, index: usize, path: &str) -> Result<PathBuf> {
        let rule = &self.rules[index];
        let provider = rule.provider();
        let root = provider.path.as_ref().context("Missing proxy path")?;
        if provider.kind.as_deref() == Some("file") {
            return Ok(root.clone());
        }
        let rel = relative(&rule.root, path);
        normalize(&rel).map_err(|_| errno(libc::EINVAL))?;
        Ok(root.join(rel))
    }
    fn provider_metadata(&self, index: usize, path: &str) -> Result<Option<Metadata>> {
        let provider = self.rules[index].provider();
        if provider.module.is_some() {
            if !self.supports(Some(index), "getattr") {
                return Ok(None);
            }
            Metadata::from_value(
                self.call(index, path, "getattr", json!([]), None, &[], Value::Null)?
                    .value,
            )
        } else {
            let target = self.target(index, path)?;
            #[cfg(test)]
            metadata_test_hooks::before_lookup(&target)?;
            match fs::symlink_metadata(&target) {
                Ok(stat) => {
                    if provider.kind.as_deref() == Some("file") && !stat.is_file() {
                        return Err(errno(libc::EOPNOTSUPP));
                    }
                    Ok(Some(native_metadata(&stat)?))
                }
                Err(e) if [Some(libc::ENOENT), Some(libc::ENOTDIR)].contains(&e.raw_os_error()) => {
                    Ok(None)
                }
                Err(e) => Err(e.into()),
            }
        }
    }
    fn selected(&mut self, path: &str, creating: bool) -> Result<Option<usize>> {
        let mut index = self.rules.iter().rposition(|r| r.matches(path));
        if index.is_none() {
            index = self
                .rules
                .iter()
                .rposition(|r| r.expose && !r.root.is_empty() && r.root == path);
            if index.is_some()
                && fs::metadata(self.source(path))
                    .map(|s| s.is_dir())
                    .unwrap_or(false)
            {
                return Ok(None);
            }
        }
        let Some(i) = index else {
            return Ok(None);
        };
        self.describe(i)?;
        if !self.rules[i].rule.opaque
            && self.supports(Some(i), "getattr")
            && (creating || self.provider_metadata(i, path)?.is_none())
        {
            match fs::symlink_metadata(self.source(path)) {
                Ok(_) => return Ok(None),
                Err(e)
                    if ![Some(libc::ENOENT), Some(libc::ENOTDIR)].contains(&e.raw_os_error()) =>
                {
                    return Err(e.into());
                }
                _ => (),
            }
            let parent = parent(path);
            let r = &self.rules[i];
            let scoped = r.provider().kind.as_deref() == Some("directory")
                || (r.provider().module.is_some()
                    && r.matches(&parent)
                    && self.static_child(i, &parent).is_none());
            if scoped && within(&parent, &r.root) && self.provider_metadata(i, &parent)?.is_none() {
                match fs::metadata(self.source(&parent)) {
                    Ok(s) if s.is_dir() => return Ok(None),
                    Err(e)
                        if ![Some(libc::ENOENT), Some(libc::ENOTDIR)]
                            .contains(&e.raw_os_error()) =>
                    {
                        return Err(e.into());
                    }
                    _ => (),
                }
            }
        }
        Ok(index)
    }
    fn native_path(
        &self,
        path: &str,
        index: Option<usize>,
        directory: bool,
    ) -> Result<Option<PathBuf>> {
        let Some(i) = index else {
            return Ok(Some(self.source(path)));
        };
        let r = &self.rules[i];
        if r.provider().module.is_none() {
            return Ok(Some(self.target(i, path)?));
        }
        if !r.rule.opaque
            && (directory
                || !["read", "write", "readFile", "writeFile"]
                    .iter()
                    .any(|op| self.supports(index, op)))
        {
            Ok(Some(self.source(path)))
        } else {
            Ok(None)
        }
    }
    fn ancestor(&self, path: &str, index: Option<usize>) -> bool {
        self.rules.iter().enumerate().any(|(i, r)| {
            index.is_none_or(|selected| i >= selected)
                && r.expose
                && r.root.starts_with(&format!("{path}/"))
        })
    }
    fn scope(&self, mut metadata: Metadata, index: Option<usize>) -> Metadata {
        if let Some(i) = index {
            if metadata.kind == Kind::File && self.rules[i].provider().module.is_some() {
                if let Some(identity) = metadata.identity.as_mut() {
                    identity.push_str(&format!(":rule:{i}"));
                }
            }
        }
        metadata
    }
    fn provider_normalized(
        &self,
        metadata: Metadata,
        index: usize,
        path: &str,
        declared: Option<u64>,
    ) -> Result<Metadata> {
        let size_mode = metadata.size_mode.clone().unwrap_or_else(|| {
            if metadata.size.is_some() {
                "explicit".into()
            } else {
                "content".into()
            }
        });
        let mut metadata = metadata.normalized();
        metadata.size_mode = Some(size_mode.clone());
        metadata.seekable.get_or_insert(true);
        if metadata.kind == Kind::File
            && declared.is_none()
            && size_mode == "content"
            && self.supports(Some(index), "readFile")
        {
            metadata.size = Some(
                self.call(index, path, "readFile", json!([]), None, &[], Value::Null)?
                    .body
                    .len() as u64,
            );
        } else if size_mode == "zero" {
            metadata.size = Some(0);
        } else if size_mode == "unbounded" {
            metadata.size = Some(declared.unwrap_or(0x7fffffffffff));
        }
        Ok(self.scope(metadata, Some(index)))
    }
    pub fn getattr(
        &mut self,
        path: &str,
        binding: Option<Option<usize>>,
    ) -> Result<Option<Metadata>> {
        self.getattr_with_metadata(path, binding, None)
    }
    fn getattr_with_metadata(
        &mut self,
        path: &str,
        binding: Option<Option<usize>>,
        supplied: Option<Option<Metadata>>,
    ) -> Result<Option<Metadata>> {
        let path = normalize(path).map_err(|_| errno(libc::EINVAL))?;
        if path.is_empty() {
            return Ok(Some(native_metadata(&fs::symlink_metadata(
                &self.config.source,
            )?)?));
        }
        if binding.is_none() && self.visible(&path).is_err() {
            return Ok(None);
        }
        let index = match binding {
            Some(i) => i,
            None => self.selected(&path, false)?,
        };
        if self.ancestor(&path, index) {
            if let Some(native) = self.native_path(&path, index, true)? {
                match fs::metadata(native) {
                    Ok(stat) if stat.is_dir() => return Ok(Some(native_metadata(&stat)?)),
                    Err(e)
                        if ![Some(libc::ENOENT), Some(libc::ENOTDIR)]
                            .contains(&e.raw_os_error()) =>
                    {
                        return Err(e.into());
                    }
                    _ => (),
                }
            }
            return Ok(Some(Metadata::directory().normalized()));
        }
        if let Some(i) = index {
            let metadata = match supplied {
                Some(metadata) => metadata,
                None => self.provider_metadata(i, &path)?,
            };
            if let Some(mut metadata) = metadata {
                if metadata.kind == Kind::File
                    && self.rules[i]
                        .rule
                        .file
                        .as_object()
                        .is_some_and(|fields| !fields.is_empty())
                {
                    metadata = Metadata::from_value(merge(
                        self.rules[i].rule.file.clone(),
                        &serde_json::to_value(metadata)?,
                    ))?
                    .context("Missing metadata")?;
                }
                let declared = metadata.size;
                if self.rules[i].provider().module.is_some() {
                    if let Some(native) =
                        self.native_path(&path, index, metadata.kind == Kind::Directory)?
                    {
                        match fs::metadata(native) {
                            Ok(stat) => {
                                let native = native_metadata(&stat)?;
                                if native.kind == metadata.kind {
                                    let identity = native.identity.clone();
                                    metadata = Metadata::from_value(merge(
                                        serde_json::to_value(native)?,
                                        &serde_json::to_value(metadata)?,
                                    ))?
                                    .context("Missing metadata")?;
                                    metadata.identity = identity;
                                }
                            }
                            Err(e)
                                if ![Some(libc::ENOENT), Some(libc::ENOTDIR)]
                                    .contains(&e.raw_os_error()) =>
                            {
                                return Err(e.into());
                            }
                            _ => (),
                        }
                    }
                }
                return Ok(Some(
                    self.provider_normalized(metadata, i, &path, declared)?,
                ));
            }
            if self.rules[i].rule.opaque {
                return Ok(None);
            }
        }
        let mut metadata = match fs::symlink_metadata(self.source(&path)) {
            Ok(stat) => native_metadata(&stat)?,
            Err(e) if [Some(libc::ENOENT), Some(libc::ENOTDIR)].contains(&e.raw_os_error()) => {
                return Ok(None);
            }
            Err(e) => return Err(e.into()),
        };
        if let Some(i) = index {
            if metadata.kind == Kind::File
                && !self.supports(index, "getattr")
                && self.native_path(&path, index, false)?.is_none()
            {
                let mut value = merge(serde_json::to_value(&metadata)?, &self.rules[i].rule.file);
                if self.rules[i].rule.file.get("size").is_none() && self.supports(index, "readFile")
                {
                    value["size"] = Value::Null;
                    if self.rules[i].rule.file.get("sizeMode").is_none() {
                        value["sizeMode"] = json!("content");
                    }
                }
                metadata = Metadata::from_value(value)?.context("Missing metadata")?;
                let declared = self.rules[i].rule.file["size"].as_u64();
                return Ok(Some(
                    self.provider_normalized(metadata, i, &path, declared)?,
                ));
            }
        }
        Ok(Some(self.scope(metadata, index)))
    }
    fn static_child(&self, index: usize, path: &str) -> Option<String> {
        let r = &self.rules[index];
        if (r.parent_root && path.is_empty())
            || (!r.parent_root && r.parent_regex.find(path).is_some())
        {
            r.child.clone()
        } else {
            None
        }
    }
    fn listing_metadata(&mut self, path: &str) -> Result<Option<Metadata>> {
        match self.getattr(path, None) {
            Err(e) if error_code(&e) == libc::EOPNOTSUPP => Ok(None),
            result => result,
        }
    }
    pub fn readdir(&mut self, path: &str) -> Result<Option<Vec<(String, Metadata)>>> {
        if self.visible(path).is_err() {
            return Ok(None);
        }
        let selected = self.selected(path, false)?;
        let selected_index = selected.or_else(|| self.rules.iter().rposition(|r| r.matches(path)));
        let mut entries = Vec::new();
        let mut names = HashSet::new();
        let mut exists = false;
        if !selected.is_some_and(|i| self.rules[i].rule.opaque) {
            match fs::read_dir(self.source(path)) {
                Ok(list) => {
                    exists = true;
                    let mut native_names = list
                        .map(|entry| {
                            entry.map_err(anyhow::Error::from).and_then(|entry| {
                                entry
                                    .file_name()
                                    .into_string()
                                    .map_err(|_| errno(libc::EILSEQ))
                            })
                        })
                        .collect::<Result<Vec<_>>>()?;
                    native_names.sort();
                    for name in native_names {
                        if self.visible(&join(path, &name)).is_ok() && names.insert(name.clone()) {
                            entries.push(name);
                        }
                    }
                }
                Err(e)
                    if ![Some(libc::ENOENT), Some(libc::ENOTDIR)].contains(&e.raw_os_error()) =>
                {
                    return Err(e.into());
                }
                _ => (),
            }
        }
        for i in 0..self.rules.len() {
            self.describe(i)?;
            if self.supports(Some(i), "readdir")
                && within(path, &self.rules[i].root)
                && selected_index.is_none_or(|s| i >= s)
            {
                let generated = if self.rules[i].provider().module.is_some() {
                    let value = self
                        .call(i, path, "readdir", json!([]), None, &[], Value::Null)?
                        .value;
                    if value.is_null() {
                        None
                    } else {
                        Some(
                            value
                                .as_array()
                                .context("Provider readdir must return an array")?
                                .iter()
                                .map(|v| {
                                    v.as_str()
                                        .or_else(|| v["name"].as_str())
                                        .map(String::from)
                                        .context("Invalid directory entry")
                                })
                                .collect::<Result<Vec<_>>>()?,
                        )
                    }
                } else if self.rules[i].provider().kind.as_deref() == Some("file") {
                    None
                } else {
                    match fs::read_dir(self.target(i, path)?) {
                        Ok(list) => {
                            let mut names = list
                                .map(|entry| {
                                    entry.map_err(anyhow::Error::from).and_then(|e| {
                                        e.file_name().into_string().map_err(|_| errno(libc::EILSEQ))
                                    })
                                })
                                .collect::<Result<Vec<_>>>()?;
                            names.sort();
                            Some(names)
                        }
                        Err(e)
                            if [Some(libc::ENOENT), Some(libc::ENOTDIR)]
                                .contains(&e.raw_os_error()) =>
                        {
                            None
                        }
                        Err(e) => return Err(e.into()),
                    }
                };
                if let Some(generated) = generated {
                    exists = true;
                    for name in generated {
                        if name.is_empty()
                            || name == "."
                            || name == ".."
                            || name.contains('/')
                            || name.contains('\0')
                        {
                            return Err(errno(libc::EINVAL));
                        }
                        let child = join(path, &name);
                        if self.visible(&child).is_ok()
                            && (selected.is_none_or(|s| s == i) || self.rules[i].matches(&child))
                            && names.insert(name.clone())
                        {
                            entries.push(name);
                        }
                    }
                }
            }
            if let Some(name) = self.static_child(i, path) {
                let child = join(path, &name);
                let metadata = (|| {
                    if self.visible(&child).is_err()
                        || !self.supports(Some(i), "getattr")
                        || self.selected(&child, false)? != Some(i)
                    {
                        return Ok(None);
                    }
                    self.provider_metadata(i, &child)
                })();
                let metadata = match metadata {
                    Err(error) if error_code(&error) == libc::EOPNOTSUPP => None,
                    result => result?,
                };
                if metadata.is_some() {
                    exists = true;
                    if names.insert(name.clone()) {
                        entries.push(name);
                    }
                }
            }
            if self.rules[i].expose {
                if let Some(name) = root_child(&self.rules[i].root, path) {
                    let child = join(path, &name);
                    if self.visible(&child).is_ok() && self.listing_metadata(&child)?.is_some() {
                        exists = true;
                        if names.insert(name.clone()) {
                            entries.push(name);
                        }
                    }
                }
            }
        }
        if !exists {
            return Ok(None);
        }
        let mut pending = Vec::new();
        for name in &entries {
            let child = join(path, name);
            if let Some(i) = self.rules.iter().rposition(|r| r.matches(&child)) {
                if self.rules[i].rule.opaque
                    && self.module(Some(i))
                    && !self.ancestor(&child, Some(i))
                {
                    self.describe(i)?;
                    if self.supports(Some(i), "getattr") {
                        pending.push((child, i));
                    }
                }
            }
        }
        let mut prefetched = HashMap::new();
        let mut provider_sizes = HashMap::new();
        let mut start = 0;
        while start < pending.len() {
            let mut end = start;
            let mut budget = 0;
            while end < pending.len() && end - start < 256 {
                let (child, i) = &pending[end];
                if let std::collections::hash_map::Entry::Vacant(entry) = provider_sizes.entry(*i) {
                    entry.insert(serde_json::to_vec(self.rules[*i].provider())?.len());
                }
                // Bound option cloning and JSON escaping before allocating a batch.
                let estimate = 2 * provider_sizes[i]
                    + 18 * child.len()
                    + 6 * self.config.source.as_os_str().len()
                    + 6 * self.rules[*i].root.len()
                    + 256;
                if end > start && budget + estimate > 1024 * 1024 {
                    break;
                }
                budget += estimate;
                end += 1;
            }
            let batch = &pending[start..end];
            let headers = batch
                .iter()
                .map(|(child, i)| {
                    json!({"op":"getattr","provider":self.rules[*i].provider(),"context":self.context(*i,child)})
                })
                .collect();
            let responses = self.worker.metadata_batch(headers)?;
            for ((child, i), response) in batch.iter().zip(responses) {
                prefetched.insert(
                    child.clone(),
                    (*i, response.and_then(|r| Metadata::from_value(r.value))),
                );
            }
            start = end;
        }
        let mut visible = Vec::new();
        for name in entries {
            let child = join(path, &name);
            let result = match prefetched.remove(&child) {
                Some((i, metadata)) => metadata
                    .and_then(|m| self.getattr_with_metadata(&child, Some(Some(i)), Some(m))),
                None => self.getattr(&child, None),
            };
            let metadata = match result {
                Err(e) if error_code(&e) == libc::EOPNOTSUPP => None,
                result => result?,
            };
            if let Some(metadata) = metadata {
                visible.push((name, metadata));
            }
        }
        Ok(Some(visible))
    }
    pub fn readlink(&mut self, path: &str) -> Result<String> {
        self.visible(path)?;
        let index = self.selected(path, false)?;
        if let Some(i) = index {
            if self.supports(index, "readlink") {
                if self.rules[i].provider().module.is_some() {
                    return Ok(self
                        .call(i, path, "readlink", json!([]), None, &[], Value::Null)?
                        .value
                        .as_str()
                        .context("Invalid symlink target")?
                        .into());
                }
                return Ok(fs::read_link(self.target(i, path)?)?
                    .to_string_lossy()
                    .into_owned());
            }
        }
        if let Some(metadata) = self.getattr(path, None)? {
            if let Some(target) = metadata.target {
                return Ok(target);
            }
        }
        if index.is_some_and(|i| self.rules[i].rule.opaque) {
            return Err(errno(libc::ENOENT));
        }
        Ok(fs::read_link(self.source(path))?
            .to_string_lossy()
            .into_owned())
    }
    pub fn open(
        &mut self,
        path: &str,
        flags: i32,
        creating: Option<u32>,
        directory: bool,
    ) -> Result<Handle> {
        let path = normalize(path).map_err(|_| errno(libc::EINVAL))?;
        let path = path.as_str();
        let creating = creating.map(|mode| mode & 0o7777);
        self.visible(path)?;
        if creating.is_some()
            || (flags & libc::O_ACCMODE) != libc::O_RDONLY
            || flags & libc::O_TRUNC != 0
        {
            self.writable()?;
        }
        let binding = if path.is_empty() {
            None
        } else {
            self.selected(path, creating.is_some())?
        };
        let native = self.native_path(path, binding, directory)?;
        let mut handle = Handle {
            binding,
            value: None,
            resource: None,
            native: None,
            flags,
            captured: None,
            directory,
        };
        if creating.is_some()
            && binding.is_some_and(|i| self.rules[i].provider().kind.as_deref() == Some("file"))
        {
            return Err(errno(libc::EROFS));
        }
        let custom_create = creating.is_some()
            && binding.is_some_and(|i| self.rules[i].provider().module.is_some())
            && self.supports(binding, "create");
        let op = if custom_create {
            "create"
        } else if directory {
            "opendir"
        } else {
            "open"
        };
        let mut acquired = false;
        let result = (|| {
            if let Some(i) = binding {
                if custom_create {
                    let response = self.call(i,path,"create",json!([{"kind":"file","mode":creating.unwrap_or(0o644),"size":0,"sizeMode":"explicit"}]),Some(&handle),&[],Value::Null)?;
                    handle.value = response.value.as_u64();
                    handle.resource = response.resource;
                    acquired = true;
                }
                if creating.is_some()
                    && native.is_none()
                    && !custom_create
                    && self.supports(binding, "writeFile")
                {
                    self.write_file(path, &[], Some(binding), true)?;
                }
            }
            if creating.is_none() && self.supports(binding, op) {
                let response = self.call(
                    binding.expect("binding"),
                    path,
                    op,
                    json!([]),
                    Some(&handle),
                    &[],
                    Value::Null,
                )?;
                handle.value = response.value.as_u64();
                handle.resource = response.resource;
                acquired = true;
            }
            if let Some(target) = native {
                let flags = if directory {
                    libc::O_RDONLY | libc::O_DIRECTORY
                } else if creating.is_some() {
                    (flags & !(libc::O_CREAT | libc::O_EXCL | libc::O_TRUNC))
                        | if custom_create {
                            0
                        } else {
                            libc::O_CREAT | libc::O_EXCL
                        }
                } else {
                    flags & !libc::O_TRUNC
                };
                let flags = flags
                    | if binding
                        .is_some_and(|i| self.rules[i].provider().kind.as_deref() == Some("file"))
                    {
                        libc::O_NOFOLLOW
                    } else {
                        0
                    };
                match open_native(&target, flags, creating.unwrap_or(0o644), directory) {
                    Ok(file) => handle.native = Some(file),
                    Err(e)
                        if directory
                            && missing(&e)
                            && self
                                .getattr(path, None)?
                                .is_some_and(|m| m.kind == Kind::Directory) => {}
                    Err(e) => return Err(e),
                }
            }
            if creating.is_some() && !custom_create && self.supports(binding, op) {
                let response = self.call(
                    binding.expect("binding"),
                    path,
                    op,
                    json!([]),
                    Some(&handle),
                    &[],
                    Value::Null,
                )?;
                handle.value = response.value.as_u64();
                handle.resource = response.resource;
                acquired = true;
            }
            if creating.is_some()
                && handle.native.is_none()
                && !custom_create
                && !self.supports(binding, "writeFile")
                && !self.supports(binding, "open")
            {
                return Err(errno(if self.supports(binding, "write") {
                    libc::EOPNOTSUPP
                } else {
                    libc::EROFS
                }));
            }
            if handle.native.is_some()
                && binding.is_some_and(|i| self.rules[i].provider().module.is_some())
                && !self.supports(binding, "fgetattr")
                && !path.is_empty()
                && !self.ancestor(path, binding)
            {
                let i = binding.expect("binding");
                handle.captured = self
                    .provider_metadata(i, path)?
                    .map(|m| {
                        Metadata::from_value(merge(
                            self.rules[i].rule.file.clone(),
                            &serde_json::to_value(m).expect("metadata"),
                        ))
                    })
                    .transpose()?
                    .flatten();
            }
            Ok(())
        })();
        if let Err(error) = result {
            if acquired {
                if let Err(cleanup) = self.release(path, handle) {
                    return Err(ResourceRollbackError {
                        primary: error,
                        cleanup,
                    }
                    .into());
                }
            }
            return Err(error);
        }
        Ok(handle)
    }
    pub fn fgetattr(
        &mut self,
        path: &str,
        handle: &Handle,
        opened: &Metadata,
    ) -> Result<Option<Metadata>> {
        let binding = handle.binding;
        let supplied = if self.supports(binding, "fgetattr") {
            Metadata::from_value(
                self.call(
                    binding.expect("binding"),
                    path,
                    "fgetattr",
                    json!([]),
                    Some(handle),
                    &[],
                    Value::Null,
                )?
                .value,
            )?
        } else {
            handle.captured.clone()
        };
        if self.supports(binding, "fgetattr") && supplied.is_none() {
            return Ok(None);
        }
        let native = handle
            .native
            .as_ref()
            .map(|f| {
                f.metadata()
                    .map_err(anyhow::Error::from)
                    .and_then(|s| native_metadata(&s))
            })
            .transpose()?;
        if supplied.is_some() || native.is_some() {
            let mut value = native
                .as_ref()
                .map(serde_json::to_value)
                .transpose()?
                .unwrap_or(json!({}));
            if let Some(i) = binding {
                if supplied
                    .as_ref()
                    .or(native.as_ref())
                    .is_some_and(|m| m.kind == Kind::File)
                {
                    value = merge(value, &self.rules[i].rule.file);
                }
            }
            if let Some(metadata) = supplied {
                value = merge(value, &serde_json::to_value(metadata)?);
            }
            if let Some(native) = native {
                value["identity"] = json!(native.identity);
                if !self.supports(binding, "fgetattr") {
                    if let Some(captured) = &handle.captured {
                        let captured = serde_json::to_value(captured)?;
                        let opened = serde_json::to_value(opened)?;
                        for key in ["size", "mode", "uid", "gid", "atime", "mtime"] {
                            if !captured[key].is_null() {
                                value[key] = opened[key].clone();
                            }
                        }
                    }
                }
            }
            let mut metadata = Metadata::from_value(value)?
                .context("Missing handle metadata")?
                .normalized();
            if metadata.size_mode.as_deref() == Some("zero") {
                metadata.size = Some(0);
            } else if metadata.size_mode.as_deref() == Some("unbounded") {
                metadata.size = Some(opened.size.unwrap_or(0x7fffffffffff));
            }
            let mut metadata = self.scope(metadata, binding);
            if metadata.identity.is_none() {
                metadata.identity = opened.identity.clone();
            }
            return Ok(Some(metadata));
        }
        if handle.value.is_some() {
            Ok(Some(opened.clone()))
        } else {
            self.getattr(path, Some(binding))
        }
    }
    pub fn check_identity(
        &mut self,
        path: &str,
        handle: &Handle,
        metadata: &Metadata,
        operation: &str,
    ) -> Result<()> {
        if handle.value.is_none()
            && metadata.identity.is_some()
            && self.supports(handle.binding, operation)
            && (handle.native.is_none() || matches!(operation, "ftruncate" | "fsetattr"))
        {
            let current = self.getattr(path, Some(handle.binding))?;
            if current.is_none_or(|m| m.identity != metadata.identity || m.kind != metadata.kind) {
                return Err(errno(libc::ESTALE));
            }
        }
        Ok(())
    }
    pub fn read_chunk(
        &self,
        path: &str,
        position: u64,
        length: usize,
        handle: &Handle,
    ) -> Result<Option<Vec<u8>>> {
        if let Some(file) = &handle.native {
            let mut bytes = vec![0; length];
            let read = file.read_at(&mut bytes, position)?;
            bytes.truncate(read);
            return Ok(Some(bytes));
        }
        if self.supports(handle.binding, "read") {
            return Ok(Some(
                self.call(
                    handle.binding.expect("binding"),
                    path,
                    "read",
                    json!([position, length]),
                    Some(handle),
                    &[],
                    Value::Null,
                )?
                .body,
            ));
        }
        Ok(None)
    }
    pub fn write_chunk(
        &self,
        path: &str,
        bytes: &[u8],
        position: u64,
        handle: &Handle,
    ) -> Result<Option<usize>> {
        self.writable()?;
        if let Some(file) = &handle.native {
            return Ok(Some(file.write_at(bytes, position)?));
        }
        if self.supports(handle.binding, "write") {
            let written = self
                .call(
                    handle.binding.expect("binding"),
                    path,
                    "write",
                    json!([position]),
                    Some(handle),
                    bytes,
                    Value::Null,
                )?
                .value;
            let length = if written.is_null() {
                bytes.len()
            } else {
                usize::try_from(written.as_u64().context("Invalid provider write result")?)?
            };
            if length > bytes.len() {
                return Err(errno(libc::EIO));
            }
            return Ok(Some(length));
        }
        Ok(None)
    }
    pub fn read_file(
        &mut self,
        path: &str,
        handle: &Handle,
        metadata: &Metadata,
    ) -> Result<Vec<u8>> {
        if let Some(i) = handle.binding {
            if self.supports(handle.binding, "readFile")
                && self.rules[i].provider().module.is_some()
            {
                return Ok(self
                    .call(i, path, "readFile", json!([]), None, &[], Value::Null)?
                    .body);
            }
        }
        if handle.native.is_some() || self.supports(handle.binding, "read") {
            if metadata.size_mode.as_deref() == Some("unbounded")
                || metadata.size.is_none()
                || (metadata.seekable == Some(false) && metadata.size != Some(0))
            {
                return Err(errno(libc::EOPNOTSUPP));
            }
            let mut bytes = Vec::new();
            let length =
                usize::try_from(metadata.size.unwrap_or(0)).map_err(|_| errno(libc::EFBIG))?;
            bytes
                .try_reserve_exact(length)
                .map_err(|_| errno(libc::ENOMEM))?;
            let mut temporary = None;
            if (handle.flags & libc::O_ACCMODE) == libc::O_WRONLY {
                temporary = Some(self.open(path, libc::O_RDONLY, None, false)?);
            }
            let read_handle = temporary.as_ref().unwrap_or(handle);
            let result = (|| {
                while bytes.len() < length {
                    self.check_identity(path, read_handle, metadata, "read")?;
                    let chunk = self
                        .read_chunk(
                            path,
                            bytes.len() as u64,
                            (length - bytes.len()).min(65536),
                            read_handle,
                        )?
                        .ok_or_else(|| errno(libc::EIO))?;
                    if chunk.is_empty() {
                        break;
                    }
                    bytes.extend_from_slice(&chunk[..chunk.len().min(length - bytes.len())]);
                }
                Ok(bytes)
            })();
            if let Some(temporary) = temporary {
                self.release(path, temporary)?;
            }
            return result;
        }
        if handle.binding.is_some_and(|i| self.rules[i].rule.opaque) {
            return Err(errno(libc::ENOENT));
        }
        let file = open_native(&self.source(path), libc::O_RDONLY, 0, false)?;
        use std::io::Read;
        let mut bytes = Vec::new();
        (&file).read_to_end(&mut bytes)?;
        Ok(bytes)
    }
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn read_all(&mut self, path: &str) -> Result<Vec<u8>> {
        let path = normalize(path).map_err(|_| errno(libc::EINVAL))?;
        self.visible(&path)?;
        let binding = self.selected(&path, false)?;
        if let Some(i) = binding {
            if self.supports(binding, "readFile") && self.module(binding) {
                return Ok(self
                    .call(i, &path, "readFile", json!([]), None, &[], Value::Null)?
                    .body);
            }
        }
        let handle = self.open(&path, libc::O_RDONLY, None, false)?;
        let result = (|| {
            let metadata = self
                .getattr(&path, Some(handle.binding))?
                .ok_or_else(|| errno(libc::ENOENT))?;
            let metadata = self
                .fgetattr(&path, &handle, &metadata)?
                .ok_or_else(|| errno(libc::ENOENT))?;
            self.read_file(&path, &handle, &metadata)
        })();
        match (result, self.release(&path, handle)) {
            (Err(primary), Err(cleanup)) => Err(ResourceRollbackError { primary, cleanup }.into()),
            (Err(error), _) | (_, Err(error)) => Err(error),
            (Ok(bytes), Ok(())) => Ok(bytes),
        }
    }
    pub fn write_file(
        &mut self,
        path: &str,
        bytes: &[u8],
        binding: Option<Option<usize>>,
        new: bool,
    ) -> Result<()> {
        self.writable()?;
        let index = match binding {
            Some(i) => i,
            None => {
                self.visible(path)?;
                self.selected(path, false)?
            }
        };
        if let Some(i) = index {
            if self.supports(index, "writeFile") && self.rules[i].provider().module.is_some() {
                let previous = if new {
                    None
                } else {
                    match self.getattr(path, Some(index))? {
                        Some(metadata)
                            if metadata.size == Some(0)
                                && metadata.size_mode.as_deref() != Some("unbounded") =>
                        {
                            Some(Vec::new())
                        }
                        Some(metadata) => {
                            let result = if self.supports(index, "readFile") {
                                self.call(i, path, "readFile", json!([]), None, &[], Value::Null)
                                    .map(|response| response.body)
                            } else {
                                let handle = self.open(path, libc::O_RDONLY, None, false)?;
                                let result = self.read_file(path, &handle, &metadata);
                                self.release(path, handle)?;
                                result
                            };
                            match result {
                                Ok(contents) => Some(contents),
                                Err(e) if missing(&e) => None,
                                Err(e) => return Err(e),
                            }
                        }
                        None => None,
                    }
                };
                let mut body = bytes.to_vec();
                if let Some(previous) = &previous {
                    body.extend_from_slice(previous);
                }
                self.call(
                    i,
                    path,
                    "writeFile",
                    json!([]),
                    None,
                    &body,
                    json!({"contentsLength":bytes.len(),"previousMissing":previous.is_none()}),
                )?;
                return Ok(());
            }
        }
        let target = self
            .native_path(path, index, false)?
            .ok_or_else(|| errno(libc::EROFS))?;
        use std::io::Write;
        let mut file = open_native(
            &target,
            libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC,
            0o644,
            false,
        )?;
        file.write_all(bytes)?;
        Ok(())
    }
    pub fn truncate(&mut self, path: &str, size: u64, handle: Option<&Handle>) -> Result<bool> {
        self.writable()?;
        let index = match handle {
            Some(h) => h.binding,
            None => {
                self.visible(path)?;
                self.selected(path, false)?
            }
        };
        if let Some(h) = handle {
            if self.supports(index, "ftruncate") {
                self.call(
                    index.expect("binding"),
                    path,
                    "ftruncate",
                    json!([size]),
                    Some(h),
                    &[],
                    Value::Null,
                )?;
                return Ok(true);
            }
            if let Some(file) = &h.native {
                file.set_len(size)?;
                return Ok(true);
            }
            if h.value.is_some() && (self.supports(index, "read") || self.supports(index, "write"))
            {
                if self.supports(index, "writeFile") && !self.supports(index, "write") {
                    return Ok(false);
                }
                return Err(errno(libc::EOPNOTSUPP));
            }
        }
        if let Some(i) = index {
            if self.supports(index, "truncate") && self.rules[i].provider().module.is_some() {
                self.call(i, path, "truncate", json!([size]), None, &[], Value::Null)?;
                return Ok(true);
            }
            if self.supports(index, "writeFile") && self.rules[i].provider().module.is_some() {
                return Ok(false);
            }
        }
        let target = self
            .native_path(path, index, false)?
            .ok_or_else(|| errno(libc::EROFS))?;
        open_native(&target, libc::O_WRONLY, 0, false)?.set_len(size)?;
        Ok(true)
    }
    pub fn sync(&self, path: &str, handle: &Handle, op: &str, datasync: bool) -> Result<()> {
        if let Some(file) = &handle.native {
            if op != "flush" {
                #[cfg(test)]
                native_test_hooks::before_sync(file, datasync)?;
                if datasync {
                    file.sync_data()?;
                } else {
                    file.sync_all()?;
                }
            }
        }
        if self.supports(handle.binding, op) {
            self.call(
                handle.binding.expect("binding"),
                path,
                op,
                if op == "flush" {
                    json!([])
                } else {
                    json!([datasync])
                },
                Some(handle),
                &[],
                Value::Null,
            )?;
        } else if op == "fsyncdir" && handle.native.is_none() {
            return Err(errno(libc::EOPNOTSUPP));
        }
        Ok(())
    }
    pub fn release(&self, path: &str, handle: Handle) -> Result<()> {
        let op = if handle.directory {
            "releasedir"
        } else {
            "release"
        };
        if self.supports(handle.binding, op) {
            self.call(
                handle.binding.expect("binding"),
                path,
                op,
                json!([]),
                Some(&handle),
                &[],
                Value::Null,
            )?;
        } else if let Some(value) = handle.value {
            self.worker
                .request(json!({"op":"discard","handle":value}), &[])?;
        }
        Ok(())
    }
    pub fn snapshot_needed(&self, handle: &Handle) -> bool {
        let buffered_writes =
            self.supports(handle.binding, "writeFile") && !self.supports(handle.binding, "write");
        let retained_reader =
            handle.value.is_some() && self.supports(handle.binding, "read") && !buffered_writes;
        handle.native.is_none() && !retained_reader
    }

    pub fn access(&mut self, path: &str, mode: i32) -> Result<()> {
        self.visible(path)?;
        if mode & libc::W_OK != 0 {
            self.writable()?;
        }
        let index = self.selected(path, false)?;
        if let Some(i) = index {
            if self.supports(index, "access") && self.rules[i].provider().module.is_some() {
                self.call(i, path, "access", json!([mode]), None, &[], Value::Null)?;
                return Ok(());
            }
        }
        let generated = if self.ancestor(path, index) {
            self.getattr(path, None)?
        } else {
            index
                .map(|i| self.provider_metadata(i, path))
                .transpose()?
                .flatten()
        };
        if index.is_some_and(|i| self.rules[i].provider().module.is_some())
            || self.ancestor(path, index)
        {
            if let Some(metadata) = generated {
                let metadata = metadata.normalized();
                let bits = metadata.mode.unwrap_or(0);
                let uid = unsafe { libc::getuid() };
                if uid == 0 {
                    if mode & libc::X_OK == 0
                        || metadata.kind == Kind::Directory
                        || bits & 0o111 != 0
                    {
                        return Ok(());
                    }
                } else {
                    let count = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
                    if count < 0 {
                        return Err(std::io::Error::last_os_error().into());
                    }
                    let mut groups = vec![0; count as usize];
                    if unsafe { libc::getgroups(count, groups.as_mut_ptr()) } < 0 {
                        return Err(std::io::Error::last_os_error().into());
                    }
                    let shift = if metadata.uid == Some(uid) {
                        6
                    } else if metadata.gid == Some(unsafe { libc::getgid() })
                        || metadata.gid.is_some_and(|g| groups.contains(&g))
                    {
                        3
                    } else {
                        0
                    };
                    if ((bits >> shift) & mode as u32) == mode as u32 {
                        return Ok(());
                    }
                }
                return Err(errno(libc::EACCES));
            }
        }
        let target = self
            .native_path(path, index, false)?
            .ok_or_else(|| errno(libc::ENOENT))?;
        syscall(unsafe { libc::access(cpath(&target)?.as_ptr(), mode) })?;
        Ok(())
    }
    pub fn setattr(
        &mut self,
        path: &str,
        changes: &Value,
        handle: Option<&Handle>,
        detached: bool,
    ) -> Result<()> {
        self.writable()?;
        let index = match handle {
            Some(h) => h.binding,
            None => {
                self.visible(path)?;
                self.selected(path, false)?
            }
        };
        if let Some(handle) = handle {
            if self.supports(index, "fsetattr") {
                self.call(
                    index.expect("binding"),
                    path,
                    "fsetattr",
                    json!([changes]),
                    Some(handle),
                    &[],
                    Value::Null,
                )?;
                return Ok(());
            }
            if let Some(file) = &handle.native {
                return set_native(None, Some(file), changes);
            }
            if detached {
                return Err(errno(libc::EOPNOTSUPP));
            }
        }
        let owner = |field: &str| match changes.get(field) {
            Some(value) if value.as_u64() == Some(u64::from(u32::MAX)) => json!(-1),
            Some(value) => value.clone(),
            None => json!(-1),
        };
        for (op, args) in [
            ("chmod", changes.get("mode").map(|v| json!([v]))),
            (
                "chown",
                if changes.get("uid").is_some() || changes.get("gid").is_some() {
                    Some(json!([owner("uid"), owner("gid")]))
                } else {
                    None
                },
            ),
            (
                "utimens",
                if changes.get("atime").is_some() || changes.get("mtime").is_some() {
                    let current = self
                        .getattr(path, None)?
                        .ok_or_else(|| errno(libc::ENOENT))?;
                    Some(json!([
                        changes
                            .get("atime")
                            .cloned()
                            .unwrap_or(serde_json::to_value(current.atime)?),
                        changes
                            .get("mtime")
                            .cloned()
                            .unwrap_or(serde_json::to_value(current.mtime)?)
                    ]))
                } else {
                    None
                },
            ),
        ] {
            if let Some(args) = args {
                if let Some(i) = index {
                    if self.supports(index, op) && self.rules[i].provider().module.is_some() {
                        self.call(i, path, op, args, None, &[], Value::Null)?;
                        continue;
                    }
                    if self.rules[i].provider().module.is_some() && self.rules[i].rule.opaque {
                        return Err(errno(libc::EROFS));
                    }
                }
                let target = if index.is_some_and(|i| self.rules[i].provider().module.is_none()) {
                    self.target(index.expect("binding"), path)?
                } else {
                    self.source(path)
                };
                let fields = match op {
                    "chmod" => json!({"mode":changes["mode"]}),
                    "chown" => json!({"uid":args[0],"gid":args[1]}),
                    _ => json!({"atime":args[0],"mtime":args[1]}),
                };
                set_native(Some(&target), None, &fields)?;
            }
        }
        Ok(())
    }
    pub fn mkdir(&mut self, path: &str, mode: u32) -> Result<()> {
        self.writable()?;
        self.visible(path)?;
        let index = self.selected(path, true)?;
        if let Some(i) = index {
            if self.supports(index, "mkdir") && self.rules[i].provider().module.is_some() {
                self.call(
                    i,
                    path,
                    "mkdir",
                    json!([{"kind":"directory","mode":mode}]),
                    None,
                    &[],
                    Value::Null,
                )?;
                return Ok(());
            }
        }
        let target = self
            .native_path(path, index, true)?
            .ok_or_else(|| errno(libc::EROFS))?;
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(mode).create(target)?;
        Ok(())
    }
    fn multiple_backings(&self, path: &str, index: Option<usize>, op: &str) -> Result<bool> {
        let Some(i) = index else {
            return Ok(false);
        };
        let r = &self.rules[i];
        if r.rule.opaque {
            return Ok(false);
        }
        if r.provider().module.is_some() {
            if (self.native_path(path, index, false)?.is_some() && !self.supports(index, op))
                || self.provider_metadata(i, path)?.is_none()
            {
                return Ok(false);
            }
            return match fs::symlink_metadata(self.source(path)) {
                Ok(_) => Ok(true),
                Err(e) if [Some(libc::ENOENT), Some(libc::ENOTDIR)].contains(&e.raw_os_error()) => {
                    Ok(false)
                }
                Err(e) => Err(e.into()),
            };
        }
        if r.provider().kind.as_deref() != Some("directory") {
            return Ok(false);
        }
        let result = (|| {
            let target = self.target(i, path)?;
            let source = self.source(path);
            let from = fs::symlink_metadata(&source)?;
            let to = fs::symlink_metadata(&target)?;
            if from.dev() != to.dev() || from.ino() != to.ino() {
                return Ok(true);
            }
            if to.is_dir() {
                return Ok(false);
            }
            if source.file_name() != target.file_name() {
                return Ok(true);
            }
            let from = fs::metadata(source.parent().context("Missing parent")?)?;
            let to = fs::metadata(target.parent().context("Missing parent")?)?;
            Ok(from.dev() != to.dev() || from.ino() != to.ino())
        })();
        match result {
            Err(e) if missing(&e) => Ok(false),
            result => result,
        }
    }
    pub fn remove(&mut self, path: &str, directory: bool) -> Result<()> {
        self.writable()?;
        self.visible(path)?;
        let index = self.selected(path, false)?;
        let op = if directory { "rmdir" } else { "unlink" };
        if directory && self.readdir(path)?.is_some_and(|e| !e.is_empty()) {
            return Err(errno(libc::ENOTEMPTY));
        }
        if self.multiple_backings(path, index, op)? {
            return Err(errno(libc::EOPNOTSUPP));
        }
        if let Some(i) = index {
            if self.rules[i].provider().kind.as_deref() == Some("file") && !directory {
                return Err(errno(libc::EROFS));
            }
            if self.supports(index, op) && self.rules[i].provider().module.is_some() {
                self.call(i, path, op, json!([]), None, &[], Value::Null)?;
                return Ok(());
            }
        }
        let target = self
            .namespace_path(path, index)?
            .ok_or_else(|| errno(libc::EROFS))?;
        if directory {
            fs::remove_dir(target)?;
        } else {
            fs::remove_file(target)?;
        }
        Ok(())
    }
    pub fn same_provider(&mut self, source: &str, destination: &str) -> Result<()> {
        let from = self.selected(source, false)?;
        let mut to = self.selected(destination, false)?;
        if from.is_none()
            && self.getattr(source, None)?.is_some()
            && to.is_some_and(|i| !self.rules[i].rule.opaque && self.supports(to, "getattr"))
            && self
                .provider_metadata(to.expect("provider"), destination)?
                .is_none()
        {
            to = None;
        }
        if from != to {
            Err(errno(libc::EXDEV))
        } else {
            Ok(())
        }
    }
    fn namespace_path(&self, path: &str, index: Option<usize>) -> Result<Option<PathBuf>> {
        if let Some(i) = index {
            if self.module(index) {
                return Ok((!self.rules[i].rule.opaque).then(|| self.source(path)));
            }
            return Ok(Some(self.target(i, path)?));
        }
        Ok(Some(self.source(path)))
    }
    fn rename_ownership(
        &mut self,
        path: &str,
        destination: &str,
        owner: Option<usize>,
    ) -> Result<()> {
        if self.ancestor(path, owner) {
            return Err(errno(libc::EXDEV));
        }
        if !self.rules.iter().any(|r| {
            within(path, &r.root)
                || within(&r.root, path)
                || within(destination, &r.root)
                || within(&r.root, destination)
        }) {
            return Ok(());
        }
        for (name, metadata) in self.readdir(path)?.unwrap_or_default() {
            let child = join(path, &name);
            let target = join(destination, &name);
            if self.selected(&child, false)? != owner {
                return Err(errno(libc::EXDEV));
            }
            self.same_provider(&child, &target)?;
            if metadata.kind == Kind::Directory {
                self.rename_ownership(&child, &target, owner)?;
            }
        }
        Ok(())
    }
    pub fn rename(&mut self, source: &str, destination: &str) -> Result<()> {
        self.writable()?;
        self.visible(source)?;
        self.visible(destination)?;
        self.same_provider(source, destination)?;
        let index = self.selected(source, false)?;
        if index.is_some_and(|i| self.rules[i].provider().kind.as_deref() == Some("file"))
            && source != destination
        {
            return Err(errno(libc::EXDEV));
        }
        let from = self
            .getattr(source, None)?
            .ok_or_else(|| errno(libc::ENOENT))?;
        let to = self.getattr(destination, None)?;
        let same = source == destination
            || from.identity.is_some() && to.as_ref().is_some_and(|t| from.identity == t.identity);
        if !same {
            if self.multiple_backings(source, index, "rename")?
                || (to.as_ref().is_some_and(|m| m.kind == Kind::Directory)
                    && self.multiple_backings(destination, index, "rename")?)
            {
                return Err(errno(libc::EXDEV));
            }
            if to.as_ref().is_some_and(|m| m.kind == Kind::Directory)
                && self.readdir(destination)?.is_some_and(|e| !e.is_empty())
            {
                return Err(errno(libc::ENOTEMPTY));
            }
            if from.kind == Kind::Directory {
                self.rename_ownership(source, destination, index)?;
            }
        }
        if let Some(i) = index {
            if self.supports(index, "rename") && self.rules[i].provider().module.is_some() {
                let mut context = self.context(i, source);
                context["destinationPath"] = json!(destination);
                context["destinationRelativePath"] =
                    json!(relative(&self.rules[i].root, destination));
                self.call(
                    i,
                    source,
                    "rename",
                    json!([]),
                    None,
                    &[],
                    json!({"context":context}),
                )?;
                return Ok(());
            }
        }
        let from = self
            .namespace_path(source, index)?
            .ok_or_else(|| errno(libc::EROFS))?;
        let to = self
            .namespace_path(destination, index)?
            .ok_or_else(|| errno(libc::EROFS))?;
        fs::rename(from, to)?;
        Ok(())
    }
    pub fn statfs(&mut self, path: &str) -> Result<libc::statvfs> {
        let index = self.selected(path, false)?;
        let backing = index
            .and_then(|i| self.rules[i].provider().path.as_ref())
            .unwrap_or(&self.config.source);
        let mut stat = std::mem::MaybeUninit::uninit();
        syscall(unsafe { libc::statvfs(cpath(backing)?.as_ptr(), stat.as_mut_ptr()) })?;
        let mut stat = unsafe { stat.assume_init() };
        if self.config.read_only {
            stat.f_flag |= libc::ST_RDONLY;
        }
        Ok(stat)
    }
}
pub fn join(parent: &str, child: &str) -> String {
    if parent.is_empty() {
        child.into()
    } else {
        format!("{parent}/{child}")
    }
}
pub fn within(path: &str, root: &str) -> bool {
    root.is_empty() || path == root || path.starts_with(&format!("{root}/"))
}
fn parent(path: &str) -> String {
    path.rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("")
        .into()
}
fn relative(root: &str, path: &str) -> String {
    if root.is_empty() {
        return path.into();
    }
    let a: Vec<_> = root.split('/').collect();
    let b: Vec<_> = path.split('/').filter(|s| !s.is_empty()).collect();
    let common = a.iter().zip(&b).take_while(|(a, b)| a == b).count();
    std::iter::repeat_n("..", a.len() - common)
        .chain(b[common..].iter().copied())
        .collect::<Vec<_>>()
        .join("/")
}
fn root_child(root: &str, path: &str) -> Option<String> {
    let rel = relative(path, root);
    if rel.is_empty() || rel == ".." || rel.starts_with("../") {
        None
    } else {
        rel.split('/').next().map(String::from)
    }
}
fn cpath(path: &Path) -> Result<CString> {
    CString::new(path.as_os_str().as_bytes()).map_err(|_| errno(libc::EINVAL))
}
fn syscall(result: i32) -> Result<()> {
    if result < 0 {
        Err(std::io::Error::last_os_error().into())
    } else {
        Ok(())
    }
}
pub fn open_native(path: &Path, flags: i32, mode: u32, directory: bool) -> Result<File> {
    let exclusive = flags & (libc::O_CREAT | libc::O_EXCL) == (libc::O_CREAT | libc::O_EXCL);
    if !exclusive && !directory {
        match fs::metadata(path) {
            Ok(stat) if !stat.is_file() => {
                return Err(errno(if stat.is_dir() {
                    libc::EISDIR
                } else {
                    libc::EOPNOTSUPP
                }));
            }
            Err(e) if flags & libc::O_CREAT == 0 || e.raw_os_error() != Some(libc::ENOENT) => {
                return Err(e.into());
            }
            _ => (),
        }
    }
    #[cfg(test)]
    native_test_hooks::before_open(path, flags | libc::O_NONBLOCK)?;
    let access = flags & libc::O_ACCMODE;
    let file = OpenOptions::new()
        .read(access != libc::O_WRONLY)
        .write(access != libc::O_RDONLY)
        .custom_flags((flags & !libc::O_ACCMODE) | libc::O_NONBLOCK)
        .mode(mode)
        .open(path)?;
    #[cfg(test)]
    native_test_hooks::after_open(&file);
    let stat = file.metadata()?;
    if !directory && !stat.is_file() {
        return Err(errno(if stat.is_dir() {
            libc::EISDIR
        } else {
            libc::EOPNOTSUPP
        }));
    }
    Ok(file)
}
fn set_native(path: Option<&Path>, file: Option<&File>, changes: &Value) -> Result<()> {
    let fd = file.map(AsRawFd::as_raw_fd);
    let path = path.map(cpath).transpose()?;
    if let Some(mode) = changes["mode"].as_u64() {
        syscall(unsafe {
            if let Some(fd) = fd {
                libc::fchmod(fd, (mode & 0o7777) as libc::mode_t)
            } else {
                libc::chmod(
                    path.as_ref().context("Missing attribute path")?.as_ptr(),
                    (mode & 0o7777) as libc::mode_t,
                )
            }
        })?;
    }
    if changes.get("uid").is_some() || changes.get("gid").is_some() {
        let uid = changes["uid"].as_i64().unwrap_or(-1) as u32;
        let gid = changes["gid"].as_i64().unwrap_or(-1) as u32;
        syscall(unsafe {
            if let Some(fd) = fd {
                libc::fchown(fd, uid, gid)
            } else {
                libc::lchown(
                    path.as_ref().context("Missing attribute path")?.as_ptr(),
                    uid,
                    gid,
                )
            }
        })?;
    }
    if changes.get("atime").is_some() || changes.get("mtime").is_some() {
        let date = |value: &Value| -> Result<libc::timespec> {
            if value.is_null() {
                return Ok(libc::timespec {
                    tv_sec: 0,
                    tv_nsec: libc::UTIME_OMIT,
                });
            }
            let date: Date = serde_json::from_value(value.clone())?;
            Ok(libc::timespec {
                tv_sec: date.millis.div_euclid(1000) as _,
                tv_nsec: (date.millis.rem_euclid(1000) * 1_000_000) as libc::c_long,
            })
        };
        let times = [date(&changes["atime"])?, date(&changes["mtime"])?];
        syscall(unsafe {
            if let Some(fd) = fd {
                libc::futimens(fd, times.as_ptr())
            } else {
                libc::utimensat(
                    libc::AT_FDCWD,
                    path.as_ref().context("Missing attribute path")?.as_ptr(),
                    times.as_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            }
        })?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "overlay_tests.rs"]
pub(crate) mod tests;

#[derive(Debug)]
pub struct ResourceRollbackError {
    pub primary: anyhow::Error,
    pub cleanup: anyhow::Error,
}
impl std::fmt::Display for ResourceRollbackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{:#}; resource rollback failed: {:#}",
            self.primary, self.cleanup
        )
    }
}
impl std::error::Error for ResourceRollbackError {}

#[cfg(test)]
mod native_test_hooks {
    use super::*;
    type OpenHook = Box<dyn FnMut(&Path, i32) -> Result<()>>;
    type SyncHook = Box<dyn FnMut(&File, bool) -> Result<()>>;
    type AcquiredHook = Box<dyn FnMut(&File)>;
    thread_local! {
        pub static OPEN: std::cell::RefCell<Option<OpenHook>> = const { std::cell::RefCell::new(None) };
        pub static SYNC: std::cell::RefCell<Option<SyncHook>> = const { std::cell::RefCell::new(None) };
        pub static ACQUIRED: std::cell::RefCell<Option<AcquiredHook>> = const { std::cell::RefCell::new(None) };
        pub static IDENTITIES: std::cell::RefCell<std::collections::HashMap<i32, (libc::dev_t, libc::ino_t)>> =
            std::cell::RefCell::new(std::collections::HashMap::new());
    }
    pub fn before_open(path: &Path, flags: i32) -> Result<()> {
        OPEN.with_borrow_mut(|hook| hook.as_mut().map_or(Ok(()), |hook| hook(path, flags)))
    }
    pub fn before_sync(file: &File, datasync: bool) -> Result<()> {
        SYNC.with_borrow_mut(|hook| hook.as_mut().map_or(Ok(()), |hook| hook(file, datasync)))
    }
    pub fn after_open(file: &File) {
        let mut stat = std::mem::MaybeUninit::uninit();
        assert_eq!(
            unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) },
            0
        );
        let stat = unsafe { stat.assume_init() };
        IDENTITIES.with_borrow_mut(|identities| {
            identities.insert(file.as_raw_fd(), (stat.st_dev, stat.st_ino));
        });
        ACQUIRED.with_borrow_mut(|hook| {
            if let Some(hook) = hook {
                hook(file);
            }
        });
    }
}

#[cfg(test)]
mod metadata_test_hooks {
    use super::*;
    type LookupHook = Box<dyn FnMut(&Path) -> Result<()>>;
    thread_local! {
        pub static LOOKUP: std::cell::RefCell<Option<LookupHook>> = const { std::cell::RefCell::new(None) };
    }
    pub fn before_lookup(path: &Path) -> Result<()> {
        LOOKUP.with_borrow_mut(|hook| hook.as_mut().map_or(Ok(()), |hook| hook(path)))
    }
}

#[cfg(test)]
#[path = "overlay_operation_tests.rs"]
mod operation_tests;
