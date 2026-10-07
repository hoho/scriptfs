use crate::overlay::{Date, Handle, Kind, Metadata, Overlay, errno, error_code, join, within};
use anyhow::{Context, Result};
use fuser::*;
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, HashMap},
    ffi::OsStr,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const TTL: Duration = Duration::ZERO;
#[cfg(test)]
#[path = "fuse_operation_tests.rs"]
mod operation_tests;
#[cfg(test)]
#[path = "fuse_tests.rs"]
mod tests;
struct Node {
    path: String,
    paths: BTreeSet<String>,
    metadata: Metadata,
    binding: Option<Option<usize>>,
    contents: Option<Vec<u8>>,
    dirty: bool,
    truncated: bool,
    detached: bool,
    revision: Option<crate::overlay::ContentRevision>,
    lookups: u64,
    dirty_at: Option<Instant>,
    changes: Value,
}
struct OpenHandle {
    ino: u64,
    provider: Handle,
    metadata: Metadata,
    next_read: u64,
    next_write: u64,
    entries: Option<Vec<(String, FileType, u64)>>,
}
pub struct Core {
    overlay: Overlay,
    nodes: HashMap<u64, Node>,
    paths: HashMap<String, u64>,
    identities: HashMap<String, u64>,
    handles: HashMap<u64, OpenHandle>,
    next_ino: u64,
    next_handle: u64,
}
impl Core {
    pub fn new(mut overlay: Overlay) -> Result<Self> {
        let metadata = overlay
            .getattr("", None)?
            .context("Source root is missing")?;
        let mut core = Self {
            overlay,
            nodes: HashMap::new(),
            paths: HashMap::new(),
            identities: HashMap::new(),
            handles: HashMap::new(),
            next_ino: 2,
            next_handle: 1,
        };
        core.paths.insert("".into(), 1);
        core.nodes.insert(
            1,
            Node {
                path: "".into(),
                paths: BTreeSet::from(["".into()]),
                metadata,
                binding: None,
                contents: None,
                dirty: false,
                truncated: false,
                detached: false,
                revision: None,
                lookups: 1,
                dirty_at: None,
                changes: json!({}),
            },
        );
        Ok(core)
    }
    fn lookup_node(&mut self, path: &str) -> Result<u64> {
        let mut metadata = self
            .overlay
            .getattr(path, None)?
            .ok_or_else(|| errno(libc::ENOENT))?;
        if metadata.kind == Kind::Symlink {
            let target = self.overlay.readlink(path)?;
            metadata.size = Some(target.len() as u64);
            if metadata.identity.is_none() {
                metadata.identity = Some(format!("symlink:{path}:{target}"));
            }
            metadata.target = Some(target);
        }
        Ok(self.observe(path, metadata, true))
    }
    fn open_file(&mut self, ino: u64, flags: i32) -> Result<u64> {
        if self.metadata(ino)?.kind == Kind::Directory {
            return Err(errno(libc::EISDIR));
        }
        let fh = self.open(ino, flags, None, false)?;
        if flags & libc::O_TRUNC != 0 {
            if let Err(e) = self.with_handle(fh, |c, h| c.truncate(ino, 0, Some(h))) {
                if let Some(h) = self.handles.remove(&fh) {
                    self.overlay.release(&self.path(ino)?, h.provider)?;
                }
                return Err(e);
            }
        }
        Ok(fh)
    }
    fn direct_io(&self, fh: u64) -> bool {
        self.handles[&fh].metadata.seekable == Some(false)
    }
    fn link_target(&self, ino: u64) -> Result<String> {
        self.nodes
            .get(&ino)
            .ok_or_else(|| errno(libc::ESTALE))?
            .metadata
            .target
            .clone()
            .ok_or_else(|| errno(libc::EINVAL))
    }
    fn create_file(&mut self, path: &str, mode: u32, flags: i32) -> Result<(u64, u64)> {
        if self.overlay.getattr(path, None)?.is_some() {
            return Err(errno(libc::EEXIST));
        }
        let provider = self.overlay.open(path, flags, Some(mode & 0o7777), false)?;
        let metadata = match self.overlay.getattr(path, None) {
            Ok(Some(m)) => m,
            result => {
                self.overlay.release(path, provider)?;
                return Err(result.err().unwrap_or_else(|| errno(libc::ENOENT)));
            }
        };
        let ino = self.observe(path, metadata.clone(), true);
        let fh = self.next_handle;
        self.next_handle += 1;
        let buffered = provider.native.is_none()
            && !self.overlay.supports(provider.binding, "read")
            && !self.overlay.supports(provider.binding, "write");
        let node = self.nodes.get_mut(&ino).expect("node");
        node.binding = Some(provider.binding);
        if buffered {
            node.contents = Some(Vec::new());
            node.truncated = true;
        }
        self.handles.insert(
            fh,
            OpenHandle {
                ino,
                provider,
                metadata,
                next_read: 0,
                next_write: 0,
                entries: None,
            },
        );
        Ok((ino, fh))
    }
    fn attributes(&mut self, ino: u64, fh: Option<u64>) -> Result<Metadata> {
        let fh = fh.or_else(|| {
            self.handles
                .iter()
                .filter(|(_, h)| h.ino == ino)
                .map(|(fh, _)| *fh)
                .max()
        });
        if let Some(fh) = fh {
            self.with_handle(fh, |c, h| c.handle_metadata(h))
        } else {
            match self.metadata(ino) {
                Err(e) if [libc::ENOENT, libc::ESTALE].contains(&error_code(&e)) => {
                    self.retained_metadata(ino)
                }
                result => result,
            }
        }
    }
    fn set_attributes(
        &mut self,
        ino: u64,
        fh: Option<u64>,
        size: Option<u64>,
        changes: &Value,
    ) -> Result<Metadata> {
        let perform = |c: &mut Core, h: Option<&mut OpenHandle>| -> Result<Metadata> {
            if let Some(h) = h {
                if size.is_some() && h.provider.flags & libc::O_ACCMODE == libc::O_RDONLY {
                    return Err(errno(libc::EBADF));
                }
                if let Some(size) = size {
                    c.truncate(ino, size, Some(h))?;
                }
                if !changes
                    .as_object()
                    .context("Invalid metadata changes")?
                    .is_empty()
                {
                    let path = c.handle_path(h, "fsetattr")?;
                    c.overlay
                        .check_identity(&path, &h.provider, &h.metadata, "fsetattr")?;
                    c.overlay
                        .setattr(&path, changes, Some(&h.provider), c.nodes[&ino].detached)?;
                    h.metadata = apply_changes(h.metadata.clone(), changes)?;
                    for (key, value) in changes.as_object().expect("changes") {
                        c.nodes.get_mut(&ino).expect("node").changes[key] = value.clone();
                    }
                    let shared = c.shares_inode_metadata(h, false);
                    for other in c
                        .handles
                        .values_mut()
                        .filter(|other| other.ino == ino && (shared || same_resource(h, other)))
                    {
                        other.metadata = apply_changes(other.metadata.clone(), changes)?;
                    }
                }
                c.handle_metadata(h)
            } else {
                c.current(ino)?;
                let path = c.path(ino)?;
                if let Some(size) = size {
                    c.truncate(ino, size, None)?;
                }
                if !changes
                    .as_object()
                    .context("Invalid metadata changes")?
                    .is_empty()
                {
                    c.overlay.setattr(&path, changes, None, false)?;
                    for (key, value) in changes.as_object().expect("changes") {
                        c.nodes.get_mut(&ino).expect("node").changes[key] = value.clone();
                    }
                }
                c.metadata(ino)
            }
        };
        if let Some(fh) = fh {
            self.with_handle(fh, |c, h| perform(c, Some(h)))
        } else {
            perform(self, None)
        }
    }
    fn sync_handle(&mut self, fh: u64, operation: &str, datasync: bool) -> Result<()> {
        self.with_handle(fh, |c, h| {
            if operation != "fsyncdir" {
                c.flush_node(h.ino)?;
            }
            c.overlay
                .sync(&c.path(h.ino)?, &h.provider, operation, datasync)
        })
    }
    fn release_handle(&mut self, fh: u64, directory: bool) -> Result<()> {
        let h = self.handles.remove(&fh).ok_or_else(|| errno(libc::EBADF))?;
        let flush = if directory {
            Ok(())
        } else {
            self.flush_node(h.ino)
        };
        let metadata = if directory {
            Ok(())
        } else {
            self.handle_metadata(&h).map(|_| ())
        };
        let release = self.overlay.release(&self.path(h.ino)?, h.provider);
        if let Some(entries) = h.entries {
            for (_, _, ino) in entries {
                self.discard(ino);
            }
        }
        self.discard(h.ino);
        flush.and(metadata).and(release)
    }
    fn directory_entries(
        &mut self,
        ino: u64,
        fh: u64,
        offset: i64,
    ) -> Result<Vec<(String, FileType, u64)>> {
        if offset < 0 {
            return Err(errno(libc::EINVAL));
        }
        self.with_handle(fh, |c, h| {
            if h.entries.is_none() {
                c.current(ino)?;
                let path = c.path(ino)?;
                let entries = c
                    .overlay
                    .readdir(&path)?
                    .ok_or_else(|| errno(libc::ENOENT))?;
                h.entries = Some(
                    entries
                        .into_iter()
                        .map(|(n, m)| {
                            let child = join(&path, &n);
                            let kind = kind(&m);
                            let ino = c.observe(&child, m, false);
                            (n, kind, ino)
                        })
                        .collect(),
                );
            }
            Ok(h.entries
                .as_ref()
                .expect("entries")
                .iter()
                .skip(offset as usize)
                .cloned()
                .collect())
        })
    }
    fn path(&self, ino: u64) -> Result<String> {
        Ok(self
            .nodes
            .get(&ino)
            .ok_or_else(|| errno(libc::ESTALE))?
            .path
            .clone())
    }
    fn child(&mut self, ino: u64, name: &OsStr) -> Result<String> {
        let name = name.to_str().ok_or_else(|| errno(libc::EILSEQ))?;
        if name.is_empty() || name.contains('/') || name == "." || name == ".." {
            return Err(errno(libc::EINVAL));
        }
        let path = self.path(ino)?;
        if ino != 1 {
            if self.nodes[&ino].detached {
                return Err(errno(libc::ESTALE));
            }
            let current = self.overlay.getattr(&path, None)?;
            if current.is_none_or(|m| {
                m.kind != Kind::Directory || m.identity != self.nodes[&ino].metadata.identity
            }) {
                return Err(errno(libc::ESTALE));
            }
        }
        Ok(join(&path, name))
    }
    fn observe(&mut self, path: &str, metadata: Metadata, lookup: bool) -> u64 {
        let existing = self.paths.get(path).copied();
        let existing = existing.filter(|ino| {
            self.nodes.get(ino).is_some_and(|node| {
                node.metadata.kind == metadata.kind
                    && node.metadata.identity == metadata.identity
                    && (metadata.kind != Kind::Symlink || node.metadata.target == metadata.target)
            })
        });
        if existing.is_none() {
            if let Some(old) = self.paths.remove(path) {
                if let Some(node) = self.nodes.get_mut(&old) {
                    node.paths.remove(path);
                }
                self.discard(old);
            }
        }
        let identity = metadata.identity.clone();
        let ino = existing
            .or_else(|| {
                if metadata.kind == Kind::File {
                    identity
                        .as_ref()
                        .and_then(|id| self.identities.get(id).copied())
                        .filter(|ino| {
                            !self.nodes[ino].detached && self.nodes[ino].metadata.nlink != Some(0)
                        })
                } else {
                    None
                }
            })
            .unwrap_or_else(|| {
                let ino = self.next_ino;
                self.next_ino += 1;
                ino
            });
        let node = self.nodes.entry(ino).or_insert_with(|| Node {
            path: path.into(),
            paths: BTreeSet::new(),
            metadata: metadata.clone(),
            binding: None,
            contents: None,
            dirty: false,
            truncated: false,
            detached: false,
            revision: None,
            lookups: 0,
            dirty_at: None,
            changes: json!({}),
        });
        if node.paths.is_empty() {
            node.path = path.into();
        }
        node.paths.insert(path.into());
        node.detached = false;
        if !node.dirty && !node.truncated {
            node.metadata = metadata;
        }
        if lookup {
            node.lookups += 1;
        }
        self.paths.insert(path.into(), ino);
        if node.metadata.kind == Kind::File {
            if let Some(id) = identity {
                self.identities.insert(id, ino);
            }
        }
        ino
    }
    fn discard(&mut self, ino: u64) {
        if ino == 1 {
            return;
        }
        if self
            .nodes
            .get(&ino)
            .is_some_and(|node| node.lookups == 0 && !node.dirty)
            && !self.handles.values().any(|h| {
                h.ino == ino
                    || h.entries
                        .as_ref()
                        .is_some_and(|entries| entries.iter().any(|(_, _, child)| *child == ino))
            })
        {
            if let Some(node) = self.nodes.remove(&ino) {
                for path in node.paths {
                    if self.paths.get(&path) == Some(&ino) {
                        self.paths.remove(&path);
                    }
                }
                if let Some(id) = node.metadata.identity {
                    if self.identities.get(&id) == Some(&ino) {
                        self.identities.remove(&id);
                    }
                }
            }
        }
    }
    fn metadata(&mut self, ino: u64) -> Result<Metadata> {
        let node = self.nodes.get(&ino).ok_or_else(|| errno(libc::ESTALE))?;
        if node.detached || node.metadata.kind == Kind::Symlink {
            return self.retained_metadata(ino);
        }
        let metadata = self.current(ino)?;
        let node = self.nodes.get_mut(&ino).expect("node");
        if node.metadata.identity.is_some() && metadata.identity != node.metadata.identity {
            return self.retained_metadata(ino);
        }
        let metadata = if self.overlay.module(node.binding.flatten()) {
            apply_changes(metadata, &node.changes)?
        } else {
            metadata
        };
        let mut metadata = metadata;
        if node.dirty || node.truncated {
            if let Some(bytes) = &node.contents {
                metadata.resize(bytes.len() as u64);
            }
        }
        node.metadata = metadata.clone();
        Ok(metadata)
    }

    fn retained_metadata(&mut self, ino: u64) -> Result<Metadata> {
        let fh = self
            .handles
            .iter()
            .find(|(_, h)| h.ino == ino)
            .map(|(fh, _)| *fh);
        if let Some(fh) = fh {
            return self.with_handle(fh, |c, h| c.handle_metadata(h));
        }
        let node = self.nodes.get(&ino).ok_or_else(|| errno(libc::ESTALE))?;
        let paths = node.paths.clone();
        let identity = node.metadata.identity.clone();
        let binding = node.binding;
        let mut links = None;
        for path in &paths {
            if let Some(metadata) = self.overlay.getattr(path, binding)? {
                if metadata.identity == identity {
                    links = metadata.nlink;
                    break;
                }
            }
        }
        let node = self.nodes.get_mut(&ino).expect("node");
        if let Some(links) = links {
            node.metadata.nlink = Some(links);
        } else if !paths.is_empty() {
            node.metadata.nlink = Some(0);
        }
        Ok(node.metadata.clone())
    }
    fn current(&mut self, ino: u64) -> Result<Metadata> {
        let node = self.nodes.get(&ino).ok_or_else(|| errno(libc::ESTALE))?;
        if node.detached {
            return Err(errno(libc::ESTALE));
        }
        let paths = std::iter::once(node.path.clone())
            .chain(node.paths.iter().cloned())
            .collect::<BTreeSet<_>>();
        let binding = node.binding;
        let identity = node.metadata.identity.clone();
        let kind = node.metadata.kind.clone();
        for path in paths {
            let metadata = match self.overlay.getattr(&path, binding) {
                Err(e) if [libc::ENOENT, libc::ENOTDIR].contains(&error_code(&e)) => None,
                result => result?,
            };
            if let Some(metadata) = metadata {
                if identity.is_none() || (metadata.identity == identity && metadata.kind == kind) {
                    self.nodes.get_mut(&ino).expect("node").path = path;
                    return Ok(metadata);
                }
            }
        }
        Err(errno(libc::ESTALE))
    }
    fn buffered(&self, ino: u64) -> bool {
        self.nodes
            .get(&ino)
            .is_some_and(|n| n.contents.is_some() && (n.dirty || n.truncated || n.detached))
    }
    fn contents(&mut self, handle: &OpenHandle, for_write: bool) -> Result<&[u8]> {
        let ino = handle.ino;
        if !self.buffered(ino) {
            let metadata = self.current(ino)?;
            let revision = metadata.content_revision();
            let node = self.nodes.get_mut(&ino).expect("node");
            if node.revision.as_ref() != Some(&revision) {
                node.contents = None;
            }
            node.revision = Some(revision);
            if for_write
                && metadata.size == Some(0)
                && metadata.size_mode.as_deref() != Some("unbounded")
            {
                node.contents = Some(Vec::new());
            }
        }
        if self.nodes[&ino].contents.is_none() {
            let path = self.path(ino)?;
            let contents = self
                .overlay
                .read_file(&path, &handle.provider, &handle.metadata)?;
            self.nodes.get_mut(&ino).expect("node").contents = Some(contents);
        }
        Ok(self.nodes[&ino].contents.as_deref().expect("contents"))
    }
    fn flush_node(&mut self, ino: u64) -> Result<()> {
        let node = self.nodes.get(&ino).ok_or_else(|| errno(libc::ESTALE))?;
        if !node.dirty {
            return Ok(());
        }
        if !node.detached {
            self.current(ino)?;
            let node = &self.nodes[&ino];
            let contents = node
                .contents
                .as_ref()
                .context("Dirty file has no contents")?;
            let path = node.path.clone();
            let binding = node.binding;
            self.overlay.write_file(&path, contents, binding, false)?;
        }
        let node = self.nodes.get_mut(&ino).expect("node");
        if !node.detached {
            node.contents = None;
            node.revision = None;
        }
        node.dirty = false;
        node.truncated = false;
        node.dirty_at = None;
        Ok(())
    }
    pub fn flush_due(&mut self) {
        let due: Vec<_> = self
            .nodes
            .iter()
            .filter(|(_, n)| {
                n.dirty_at
                    .is_some_and(|t| t.elapsed() >= Duration::from_millis(500))
            })
            .map(|(i, _)| *i)
            .collect();
        for ino in due {
            if let Err(e) = self.flush_node(ino) {
                eprintln!("Buffered provider write failed: {e:#}");
                self.nodes.get_mut(&ino).expect("node").dirty_at = None;
            }
        }
    }
    fn with_handle<T>(
        &mut self,
        fh: u64,
        operation: impl FnOnce(&mut Self, &mut OpenHandle) -> Result<T>,
    ) -> Result<T> {
        let mut handle = self.handles.remove(&fh).ok_or_else(|| errno(libc::EBADF))?;
        let result = operation(self, &mut handle);
        self.handles.insert(fh, handle);
        result
    }
    fn shares_inode_metadata(&self, handle: &OpenHandle, buffered_sizes: bool) -> bool {
        handle.metadata.identity.is_some()
            || handle.provider.native.is_some()
            || (buffered_sizes
                && self.overlay.supports(handle.provider.binding, "writeFile")
                && !self.overlay.supports(handle.provider.binding, "write"))
    }
    fn handle_path(&mut self, handle: &OpenHandle, operation: &str) -> Result<String> {
        if !self.nodes[&handle.ino].detached
            && handle.metadata.identity.is_some()
            && handle.provider.value.is_none()
            && (handle.provider.native.is_none()
                || (matches!(operation, "ftruncate" | "fsetattr")
                    && self.overlay.supports(handle.provider.binding, operation)))
        {
            self.current(handle.ino)?;
        }
        self.path(handle.ino)
    }
    fn open(&mut self, ino: u64, flags: i32, create: Option<u32>, directory: bool) -> Result<u64> {
        self.current(ino)?;
        let path = self.path(ino)?;
        let metadata = self.nodes[&ino].metadata.clone();
        let provider = self.overlay.open(&path, flags, create, directory)?;
        let observed = self.overlay.fgetattr(&path, &provider, &metadata);
        let current = self.overlay.getattr(&path, None);
        match observed {
            Ok(Some(observed))
                if observed.kind == metadata.kind
                    && current.as_ref().is_ok_and(|m| {
                        metadata.identity.is_none()
                            || m.as_ref().is_some_and(|m| m.identity == metadata.identity)
                    })
                    && (metadata.identity.is_none() || observed.identity == metadata.identity) => {}
            result => {
                let failure = result
                    .err()
                    .or_else(|| current.err())
                    .unwrap_or_else(|| errno(libc::ESTALE));
                self.overlay.release(&path, provider)?;
                return Err(failure);
            }
        }
        let node = self.nodes.get_mut(&ino).expect("node");
        node.binding.get_or_insert(provider.binding);
        if !node.dirty && !node.truncated {
            node.contents = None;
        }
        if create.is_some()
            && provider.native.is_none()
            && !self.overlay.supports(provider.binding, "read")
            && !self.overlay.supports(provider.binding, "write")
        {
            node.contents = Some(Vec::new());
            node.truncated = true;
        }
        let metadata = if let Some(captured) = &provider.captured {
            let mut value = serde_json::to_value(&metadata)?;
            for (k, v) in serde_json::to_value(captured)?
                .as_object()
                .context("Invalid captured metadata")?
            {
                if !v.is_null() && k != "identity" {
                    value[k] = v.clone();
                }
            }
            Metadata::from_value(value)?
                .context("Missing captured metadata")?
                .normalized()
        } else {
            metadata
        };
        node.metadata = metadata.clone();
        let fh = self.next_handle;
        self.next_handle += 1;
        self.handles.insert(
            fh,
            OpenHandle {
                ino,
                provider,
                metadata,
                next_read: 0,
                next_write: 0,
                entries: None,
            },
        );
        Ok(fh)
    }
    fn handle_metadata(&mut self, handle: &OpenHandle) -> Result<Metadata> {
        let node = &self.nodes[&handle.ino];
        let mut metadata = if node.detached
            && (node.contents.is_some()
                || (handle.provider.native.is_none()
                    && node.metadata.kind == Kind::Directory
                    && !self.overlay.supports(handle.provider.binding, "fgetattr")))
        {
            handle.metadata.clone()
        } else {
            self.overlay
                .fgetattr(&node.path, &handle.provider, &handle.metadata)?
                .or_else(|| {
                    (!self.overlay.supports(handle.provider.binding, "fgetattr")
                        && handle.metadata.identity.is_some())
                    .then(|| handle.metadata.clone())
                })
                .ok_or_else(|| errno(libc::ENOENT))?
        };
        if handle.provider.native.is_none()
            && handle.provider.value.is_none()
            && !self.overlay.supports(handle.provider.binding, "fgetattr")
            && handle.metadata.identity.is_some()
            && metadata.identity != handle.metadata.identity
        {
            metadata = handle.metadata.clone();
        }
        if node.detached && (metadata.kind == Kind::Directory || handle.provider.native.is_none()) {
            metadata.nlink = Some(0);
        }
        if self.buffered(handle.ino) {
            if let Some(contents) = &node.contents {
                metadata.resize(contents.len() as u64);
            }
        }
        self.nodes.get_mut(&handle.ino).expect("node").metadata = metadata.clone();
        Ok(metadata)
    }
    fn truncate(&mut self, ino: u64, size: u64, mut handle: Option<&mut OpenHandle>) -> Result<()> {
        let detached = self.nodes[&ino].detached;
        let retained = handle.as_ref().is_some_and(|h| {
            h.provider.native.is_some()
                || (h.provider.value.is_some()
                    && self.overlay.supports(h.provider.binding, "ftruncate"))
        });
        let retain_snapshot = detached
            && self.nodes[&ino].contents.is_some()
            && handle.as_ref().is_some_and(|h| {
                h.provider.native.is_some()
                    || (h.provider.value.is_some()
                        && self.overlay.supports(h.provider.binding, "write"))
            });
        if !detached && !retained {
            self.current(ino)?;
        }
        let path = if let Some(h) = handle.as_ref() {
            self.handle_path(h, "ftruncate")?
        } else {
            self.path(ino)?
        };
        if let Some(h) = handle
            .as_ref()
            .filter(|_| !detached || self.nodes[&ino].contents.is_none() || retain_snapshot)
        {
            self.overlay
                .check_identity(&path, &h.provider, &h.metadata, "ftruncate")?;
        }
        let metadata = if let Some(h) = handle.as_ref() {
            self.handle_metadata(h)?
        } else {
            self.metadata(ino)?
        };
        let persisted = if !detached || self.nodes[&ino].contents.is_none() || retain_snapshot {
            self.overlay
                .truncate(&path, size, handle.as_ref().map(|h| &h.provider))?
        } else {
            false
        };
        let unchanged = !detached
            && size == 0
            && metadata.size == Some(0)
            && metadata.size_mode.as_deref() != Some("unbounded");
        if (persisted || unchanged) && !self.nodes[&ino].dirty && !retain_snapshot {
            let node = self.nodes.get_mut(&ino).expect("node");
            node.contents = None;
            node.truncated = false;
            node.revision = None;
        } else {
            let mut previous = if size == 0 {
                Vec::new()
            } else if let Some(h) = handle.as_ref() {
                self.contents(h, false)?.to_vec()
            } else {
                let h = self.overlay.open(&path, libc::O_RDONLY, None, false)?;
                let result = self.overlay.read_file(&path, &h, &metadata);
                self.overlay.release(&path, h)?;
                result?
            };
            let size = usize::try_from(size).map_err(|_| errno(libc::EFBIG))?;
            if size > previous.len() {
                previous
                    .try_reserve_exact(size - previous.len())
                    .map_err(|_| errno(libc::ENOMEM))?;
            }
            previous.resize(size, 0);
            let node = self.nodes.get_mut(&ino).expect("node");
            node.contents = Some(previous);
            node.truncated = !persisted;
            node.revision = None;
            if !persisted
                && !matches!(metadata.size_mode.as_deref(), Some("zero" | "unbounded"))
                && (size > 0 || metadata.size.unwrap_or(0) > 0)
            {
                node.dirty = true;
                node.dirty_at = Some(Instant::now());
            }
        }
        self.nodes
            .get_mut(&ino)
            .expect("node")
            .metadata
            .resize(size);
        self.nodes.get_mut(&ino).expect("node").changes["size"] = json!(size);
        if let Some(h) = handle.as_mut() {
            h.metadata.resize(size);
        }
        let shared = handle
            .as_ref()
            .is_none_or(|h| self.shares_inode_metadata(h, true));
        for h in self.handles.values_mut().filter(|h| {
            h.ino == ino && (shared || handle.as_ref().is_some_and(|other| same_resource(h, other)))
        }) {
            h.metadata.resize(size);
        }
        Ok(())
    }
    fn read(&mut self, fh: u64, offset: i64, size: u32) -> Result<Vec<u8>> {
        if offset < 0 {
            return Err(errno(libc::EINVAL));
        }
        self.with_handle(fh, |core, handle| {
            if handle.provider.flags & libc::O_ACCMODE == libc::O_WRONLY {
                return Err(errno(libc::EBADF));
            }
            let position = offset as u64;
            let seekable = handle.metadata.seekable != Some(false);
            if !seekable && position != handle.next_read {
                return Err(errno(libc::ESPIPE));
            }
            let mut result = None;
            if !core.buffered(handle.ino) {
                let path = core.handle_path(handle, "read")?;
                let mut bytes = Vec::new();
                loop {
                    core.overlay.check_identity(
                        &path,
                        &handle.provider,
                        &handle.metadata,
                        "read",
                    )?;
                    let chunk = core.overlay.read_chunk(
                        &path,
                        position + bytes.len() as u64,
                        size as usize - bytes.len(),
                        &handle.provider,
                    )?;
                    match chunk {
                        Some(mut chunk) => {
                            chunk.truncate(size as usize - bytes.len());
                            let empty = chunk.is_empty();
                            if bytes.is_empty() {
                                bytes = chunk;
                            } else {
                                bytes.extend_from_slice(&chunk);
                            }
                            if !seekable || empty || bytes.len() == size as usize {
                                result = Some(bytes);
                                break;
                            }
                        }
                        None if bytes.is_empty() => break,
                        None => return Err(errno(libc::EIO)),
                    }
                }
            }
            let bytes = if let Some(bytes) = result {
                bytes
            } else {
                let contents = core.contents(handle, false)?;
                let start = usize::try_from(position)
                    .unwrap_or(usize::MAX)
                    .min(contents.len());
                contents[start..start.saturating_add(size as usize).min(contents.len())].to_vec()
            };
            handle.next_read = position + bytes.len() as u64;
            Ok(bytes)
        })
    }
    fn write(&mut self, fh: u64, offset: i64, bytes: &[u8]) -> Result<u32> {
        if offset < 0 {
            return Err(errno(libc::EINVAL));
        }
        self.with_handle(fh, |core, handle| {
            core.overlay.writable()?;
            if handle.provider.flags & libc::O_ACCMODE == libc::O_RDONLY {
                return Err(errno(libc::EBADF));
            }
            let position = offset as u64;
            let seekable = handle.metadata.seekable != Some(false);
            if !seekable && position != handle.next_write {
                return Err(errno(libc::ESPIPE));
            }
            let ino = handle.ino;
            let snapshot = core.nodes[&ino].detached
                && core.nodes[&ino].contents.is_some()
                && (handle.provider.native.is_some()
                    || handle.provider.value.is_some()
                        && core.overlay.supports(handle.provider.binding, "write"));
            if !core.buffered(ino) || snapshot {
                let path = core.handle_path(handle, "write")?;
                core.overlay
                    .check_identity(&path, &handle.provider, &handle.metadata, "write")?;
                if let Some(written) =
                    core.overlay
                        .write_chunk(&path, bytes, position, &handle.provider)?
                {
                    let node = core.nodes.get_mut(&ino).expect("node");
                    if snapshot {
                        write_buffer(
                            node.contents
                                .as_mut()
                                .context("Missing detached snapshot")?,
                            &bytes[..written],
                            position,
                        )?;
                    } else {
                        node.contents = None;
                    }
                    node.truncated = false;
                    if written > 0 {
                        handle.metadata.resize(
                            handle
                                .metadata
                                .size
                                .unwrap_or(0)
                                .max(position + written as u64),
                        );
                        node.metadata.resize(handle.metadata.size.unwrap_or(0));
                        node.changes["size"] = json!(handle.metadata.size);
                        let shared = core.shares_inode_metadata(handle, true);
                        for h in core
                            .handles
                            .values_mut()
                            .filter(|h| h.ino == ino && (shared || same_resource(handle, h)))
                        {
                            h.metadata.resize(handle.metadata.size.unwrap_or(0));
                        }
                    }
                    handle.next_write = position + written as u64;
                    return Ok(written as u32);
                }
            }
            core.contents(handle, true)?;
            let node = core.nodes.get_mut(&ino).expect("node");
            let contents = node.contents.as_mut().expect("contents");
            let buffer_position =
                if !seekable && handle.metadata.size_mode.as_deref() == Some("zero") {
                    contents.len() as u64
                } else {
                    position
                };
            write_buffer(contents, bytes, buffer_position)?;
            node.metadata.resize(contents.len() as u64);
            handle.metadata.resize(contents.len() as u64);
            node.changes["size"] = json!(node.metadata.size);
            for other in core.handles.values_mut().filter(|h| h.ino == ino) {
                other.metadata.resize(contents.len() as u64);
            }
            node.dirty = true;
            node.dirty_at = Some(Instant::now());
            handle.next_write = position + bytes.len() as u64;
            Ok(bytes.len() as u32)
        })
    }
    fn snapshot(&mut self, ino: u64) -> Result<()> {
        self.flush_node(ino)?;
        let identity = self.nodes[&ino].metadata.identity.clone();
        if identity.is_some() {
            let paths = self.nodes[&ino].paths.clone();
            for path in paths {
                let metadata = self.overlay.getattr(&path, self.nodes[&ino].binding)?;
                if metadata.is_none_or(|m| m.identity != identity) {
                    self.paths.remove(&path);
                    self.nodes.get_mut(&ino).expect("node").paths.remove(&path);
                }
            }
        }
        let fh = self
            .handles
            .iter()
            .filter(|(_, h)| h.ino == ino && !h.provider.directory)
            .map(|(fh, _)| *fh)
            .min();
        if let Some(fh) = fh {
            self.with_handle(fh, |core, h| {
                core.current(ino)?;
                if core.overlay.snapshot_needed(&h.provider) {
                    let metadata = core.handle_metadata(h)?;
                    let contents =
                        core.overlay
                            .read_file(&core.path(ino)?, &h.provider, &metadata)?;
                    core.nodes.get_mut(&ino).expect("node").contents = Some(contents);
                }
                Ok(())
            })?;
        }
        Ok(())
    }
    fn forget_path(&mut self, path: &str) {
        if let Some(ino) = self.paths.remove(path) {
            let node = self.nodes.get_mut(&ino).expect("node");
            node.paths.remove(path);
            if node.paths.is_empty() {
                node.detached =
                    node.metadata.kind != Kind::File || node.metadata.nlink.unwrap_or(1) <= 1;
                if node.detached {
                    node.metadata.nlink = Some(0);
                }
            } else if node.path == path {
                node.path = node.paths.first().expect("path").clone();
            }
        }
    }
    fn remove(&mut self, path: &str, directory: bool) -> Result<()> {
        let ino = self.paths.get(path).copied();
        let metadata = self.overlay.getattr(path, None)?;
        if let Some(ino) = ino {
            if !directory {
                self.snapshot(ino)?;
            }
        }
        self.overlay.remove(path, directory)?;
        self.forget_path(path);
        if let Some(ino) = ino {
            if let Some(metadata) = metadata {
                let node = self.nodes.get_mut(&ino).expect("node");
                node.metadata.nlink = Some(if directory {
                    0
                } else {
                    metadata.nlink.unwrap_or(1).saturating_sub(1)
                });
                if node.paths.is_empty() {
                    node.detached = node.metadata.nlink == Some(0);
                }
            }
        }
        Ok(())
    }
    fn rename(&mut self, source: &str, destination: &str, flags: u32) -> Result<()> {
        if flags & !libc::RENAME_NOREPLACE != 0 {
            return Err(errno(libc::EOPNOTSUPP));
        }
        let from = self
            .overlay
            .getattr(source, None)?
            .ok_or_else(|| errno(libc::ENOENT))?;
        let to = self.overlay.getattr(destination, None)?;
        if flags != 0 && to.is_some() {
            return Err(errno(libc::EEXIST));
        }
        if from.identity.is_some() && to.as_ref().is_some_and(|m| m.identity == from.identity) {
            return self.overlay.rename(source, destination);
        }
        let moved: Vec<_> = self
            .paths
            .iter()
            .filter(|(p, _)| within(p, source))
            .map(|(p, i)| (p.clone(), *i))
            .collect();
        let replaced: Vec<_> = self
            .paths
            .iter()
            .filter(|(p, _)| within(p, destination) && !within(p, source))
            .map(|(p, i)| (p.clone(), *i))
            .collect();
        for (path, _) in &moved {
            self.overlay
                .same_provider(path, &format!("{destination}{}", &path[source.len()..]))?;
        }
        for (_, ino) in &moved {
            self.flush_node(*ino)?;
        }
        for (_, ino) in &replaced {
            self.snapshot(*ino)?;
        }
        self.overlay.rename(source, destination)?;
        for (path, _) in replaced {
            self.forget_path(&path);
        }
        for (path, _) in &moved {
            self.forget_path(path);
        }
        for (path, ino) in moved {
            let target = format!("{destination}{}", &path[source.len()..]);
            self.paths.insert(target.clone(), ino);
            let node = self.nodes.get_mut(&ino).expect("node");
            if node.paths.is_empty() {
                node.path = target.clone();
            }
            node.paths.insert(target);
            node.detached = false;
        }
        Ok(())
    }
    pub fn shutdown(&mut self) -> Result<()> {
        let mut errors = Vec::new();
        for ino in self.nodes.keys().copied().collect::<Vec<_>>() {
            if let Err(e) = self.flush_node(ino) {
                errors.push(format!("{e:#}"));
            }
        }
        for (_, h) in self.handles.drain() {
            let path = self
                .nodes
                .get(&h.ino)
                .map(|n| n.path.as_str())
                .unwrap_or("");
            if let Err(e) = self.overlay.release(path, h.provider) {
                errors.push(format!("{e:#}"));
            }
        }
        if !errors.is_empty() {
            anyhow::bail!("Filesystem shutdown failed: {}", errors.join("; "));
        }
        Ok(())
    }
}
fn same_resource(first: &OpenHandle, second: &OpenHandle) -> bool {
    first.provider.binding == second.provider.binding
        && first.provider.resource.is_some()
        && first.provider.resource == second.provider.resource
}
fn apply_changes(metadata: Metadata, changes: &Value) -> Result<Metadata> {
    let mut value = serde_json::to_value(metadata)?;
    for (key, change) in changes
        .as_object()
        .context("Invalid acknowledged metadata")?
    {
        value[key] = change.clone();
    }
    Metadata::from_value(value)?.context("Missing acknowledged metadata")
}
fn write_buffer(contents: &mut Vec<u8>, bytes: &[u8], position: u64) -> Result<()> {
    if bytes.is_empty() {
        return Ok(());
    }
    let start = usize::try_from(position).map_err(|_| errno(libc::EFBIG))?;
    let end = start
        .checked_add(bytes.len())
        .ok_or_else(|| errno(libc::EFBIG))?;
    if end > contents.len() {
        contents
            .try_reserve_exact(end - contents.len())
            .map_err(|_| errno(libc::ENOMEM))?;
        contents.resize(end, 0);
    }
    contents[start..end].copy_from_slice(bytes);
    Ok(())
}
fn kind(metadata: &Metadata) -> FileType {
    match metadata.kind {
        Kind::File => FileType::RegularFile,
        Kind::Directory => FileType::Directory,
        Kind::Symlink => FileType::Symlink,
    }
}
fn attr(ino: u64, metadata: &Metadata) -> FileAttr {
    let now = SystemTime::now();
    let size = metadata.size.unwrap_or(0);
    FileAttr {
        ino,
        size,
        blocks: size.div_ceil(512),
        atime: metadata.atime.as_ref().map(Date::time).unwrap_or(now),
        mtime: metadata.mtime.as_ref().map(Date::time).unwrap_or(now),
        ctime: metadata.ctime.as_ref().map(Date::time).unwrap_or(now),
        crtime: metadata.birthtime.as_ref().map(Date::time).unwrap_or(now),
        kind: kind(metadata),
        perm: (metadata.mode.unwrap_or(0o644) & 0o7777) as u16,
        nlink: metadata
            .nlink
            .unwrap_or(if metadata.kind == Kind::Directory {
                2
            } else {
                1
            }),
        uid: metadata.uid.unwrap_or(0),
        gid: metadata.gid.unwrap_or(0),
        rdev: 0,
        blksize: 4096,
        flags: 0,
    }
}
fn failure(error: anyhow::Error) -> i32 {
    failure_report(error, |error| {
        eprintln!("Filesystem operation failed: {error:#}")
    })
}
fn failure_report(error: anyhow::Error, report: impl FnOnce(&anyhow::Error)) -> i32 {
    let code = error_code(&error);
    if code == libc::EIO {
        report(&error);
    }
    if code == libc::ENOSYS {
        libc::EOPNOTSUPP
    } else {
        code
    }
}
fn change_date(t: TimeOrNow) -> Date {
    let t = match t {
        TimeOrNow::SpecificTime(t) => t,
        TimeOrNow::Now => SystemTime::now(),
    };
    Date {
        millis: match t.duration_since(UNIX_EPOCH) {
            Ok(t) => t.as_millis() as i64,
            Err(e) => -(e.duration().as_millis() as i64),
        },
    }
}
fn kernel_initialization(result: std::result::Result<(), u64>) -> std::result::Result<(), i32> {
    result.map_err(|_| libc::EOPNOTSUPP)
}
/// The FUSE reply reports these fields as 32 bit. Saturate instead of letting a
/// large value wrap to a nonsensical one such as a zero block size.
fn narrow(value: impl TryInto<u32>) -> u32 {
    value.try_into().unwrap_or(u32::MAX)
}
fn storage_counts(stats: &libc::statvfs) -> [u64; 5] {
    [
        stats.f_blocks,
        stats.f_bfree,
        stats.f_bavail,
        stats.f_files,
        stats.f_ffree,
    ]
}
/// Converts a panic inside a FUSE callback into an I/O error. Unwinding through
/// the session loop would drop the pending reply and tear the mount down, so a
/// single broken operation must not take the whole filesystem with it.
fn guard<T>(body: impl FnOnce() -> Result<T>) -> Result<T> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(body))
        .unwrap_or_else(|_| Err(errno(libc::EIO)))
}

pub struct Mount(pub Arc<Mutex<Core>>);
impl Mount {
    fn core(&self) -> Result<std::sync::MutexGuard<'_, Core>> {
        self.0.lock().map_err(|_| errno(libc::EIO))
    }
}
impl Filesystem for Mount {
    fn init(&mut self, _: &Request<'_>, config: &mut KernelConfig) -> std::result::Result<(), i32> {
        kernel_initialization(config.add_capabilities(fuser::consts::FUSE_ATOMIC_O_TRUNC))
    }
    fn lookup(&mut self, _: &Request<'_>, parent: u64, name: &OsStr, reply: ReplyEntry) {
        let result = guard(|| {
            let mut c = self.core()?;
            let path = c.child(parent, name)?;
            let ino = c.lookup_node(&path)?;
            Ok(attr(ino, &c.nodes[&ino].metadata))
        });
        match result {
            Ok(a) => reply.entry(&TTL, &a, 0),
            Err(e) => reply.error(failure(e)),
        }
    }
    fn forget(&mut self, _: &Request<'_>, ino: u64, nlookup: u64) {
        if let Ok(mut c) = self.core() {
            if let Some(n) = c.nodes.get_mut(&ino) {
                n.lookups = n.lookups.saturating_sub(nlookup);
            }
            c.discard(ino);
        }
    }
    fn getattr(&mut self, _: &Request<'_>, ino: u64, fh: Option<u64>, reply: ReplyAttr) {
        let result = guard(|| {
            let mut c = self.core()?;
            let metadata = c.attributes(ino, fh)?;
            Ok(attr(ino, &metadata))
        });
        match result {
            Ok(a) => reply.attr(&TTL, &a),
            Err(e) => reply.error(failure(e)),
        }
    }
    fn setattr(
        &mut self,
        _: &Request<'_>,
        ino: u64,
        mode: Option<u32>,
        uid: Option<u32>,
        gid: Option<u32>,
        size: Option<u64>,
        atime: Option<TimeOrNow>,
        mtime: Option<TimeOrNow>,
        _: Option<SystemTime>,
        fh: Option<u64>,
        _: Option<SystemTime>,
        _: Option<SystemTime>,
        _: Option<SystemTime>,
        _: Option<u32>,
        reply: ReplyAttr,
    ) {
        let result = guard(|| {
            let mut c = self.core()?;
            let fh = fh.or_else(|| {
                c.handles
                    .iter()
                    .filter(|(_, h)| h.ino == ino)
                    .map(|(fh, _)| *fh)
                    .max()
            });
            let mut changes = json!({});
            if let Some(mode) = mode {
                changes["mode"] = json!(mode & 0o7777);
            }
            if let Some(uid) = uid {
                changes["uid"] = json!(uid);
            }
            if let Some(gid) = gid {
                changes["gid"] = json!(gid);
            }
            if let Some(t) = atime {
                changes["atime"] = serde_json::to_value(change_date(t))?;
            }
            if let Some(t) = mtime {
                changes["mtime"] = serde_json::to_value(change_date(t))?;
            }
            let metadata = c.set_attributes(ino, fh, size, &changes)?;
            Ok(attr(ino, &metadata))
        });
        match result {
            Ok(a) => reply.attr(&TTL, &a),
            Err(e) => reply.error(failure(e)),
        }
    }
    fn readlink(&mut self, _: &Request<'_>, ino: u64, reply: ReplyData) {
        let result = guard(|| self.core().and_then(|c| c.link_target(ino)));
        match result {
            Ok(target) => reply.data(target.as_bytes()),
            Err(e) => reply.error(failure(e)),
        }
    }
    fn open(&mut self, _: &Request<'_>, ino: u64, flags: i32, reply: ReplyOpen) {
        let result = guard(|| {
            let mut c = self.core()?;
            c.open_file(ino, flags)
        });
        match result {
            Ok(fh) => {
                let direct = self.core().map(|c| c.direct_io(fh)).unwrap_or(true);
                reply.opened(fh, u32::from(direct));
            }
            Err(e) => reply.error(failure(e)),
        }
    }
    fn create(
        &mut self,
        _: &Request<'_>,
        parent: u64,
        name: &OsStr,
        mode: u32,
        umask: u32,
        flags: i32,
        reply: ReplyCreate,
    ) {
        let result = guard(|| {
            let mut c = self.core()?;
            let path = c.child(parent, name)?;
            let (ino, fh) = c.create_file(&path, mode & !umask, flags)?;
            Ok((attr(ino, &c.nodes[&ino].metadata), fh, c.direct_io(fh)))
        });
        match result {
            Ok((a, fh, direct)) => reply.created(&TTL, &a, 0, fh, u32::from(direct)),
            Err(e) => reply.error(failure(e)),
        }
    }
    fn read(
        &mut self,
        _: &Request<'_>,
        _: u64,
        fh: u64,
        offset: i64,
        size: u32,
        _: i32,
        _: Option<u64>,
        reply: ReplyData,
    ) {
        let result = guard(|| self.core().and_then(|mut c| c.read(fh, offset, size)));
        match result {
            Ok(data) => reply.data(&data),
            Err(e) => reply.error(failure(e)),
        }
    }
    fn write(
        &mut self,
        _: &Request<'_>,
        _: u64,
        fh: u64,
        offset: i64,
        data: &[u8],
        _: u32,
        _: i32,
        _: Option<u64>,
        reply: ReplyWrite,
    ) {
        let result = guard(|| self.core().and_then(|mut c| c.write(fh, offset, data)));
        match result {
            Ok(n) => reply.written(n),
            Err(e) => reply.error(failure(e)),
        }
    }
    fn flush(&mut self, _: &Request<'_>, _: u64, fh: u64, _: u64, reply: ReplyEmpty) {
        empty(
            reply,
            guard(|| {
                self.core()
                    .and_then(|mut c| c.sync_handle(fh, "flush", false))
            }),
        );
    }
    fn fsync(&mut self, _: &Request<'_>, _: u64, fh: u64, datasync: bool, reply: ReplyEmpty) {
        empty(
            reply,
            guard(|| {
                self.core()
                    .and_then(|mut c| c.sync_handle(fh, "fsync", datasync))
            }),
        );
    }
    fn release(
        &mut self,
        _: &Request<'_>,
        _: u64,
        fh: u64,
        _: i32,
        _: Option<u64>,
        _: bool,
        reply: ReplyEmpty,
    ) {
        let result = guard(|| self.core().and_then(|mut c| c.release_handle(fh, false)));
        empty(reply, result);
    }
    fn opendir(&mut self, _: &Request<'_>, ino: u64, flags: i32, reply: ReplyOpen) {
        let result = guard(|| {
            let mut c = self.core()?;
            if c.metadata(ino)?.kind != Kind::Directory {
                return Err(errno(libc::ENOTDIR));
            }
            c.open(ino, flags, None, true)
        });
        match result {
            Ok(fh) => reply.opened(fh, 0),
            Err(e) => reply.error(failure(e)),
        }
    }
    fn readdir(
        &mut self,
        _: &Request<'_>,
        ino: u64,
        fh: u64,
        offset: i64,
        mut reply: ReplyDirectory,
    ) {
        let result = guard(|| {
            let mut c = self.core()?;
            for (index, (name, kind, child)) in
                c.directory_entries(ino, fh, offset)?.iter().enumerate()
            {
                if reply.add(*child, offset + (index + 1) as i64, *kind, name) {
                    break;
                }
            }
            Ok(())
        });
        match result {
            Ok(()) => reply.ok(),
            Err(e) => reply.error(failure(e)),
        }
    }
    fn releasedir(&mut self, _: &Request<'_>, _: u64, fh: u64, _: i32, reply: ReplyEmpty) {
        let result = guard(|| self.core().and_then(|mut c| c.release_handle(fh, true)));
        empty(reply, result);
    }
    fn fsyncdir(&mut self, _: &Request<'_>, _: u64, fh: u64, datasync: bool, reply: ReplyEmpty) {
        empty(
            reply,
            guard(|| {
                self.core()
                    .and_then(|mut c| c.sync_handle(fh, "fsyncdir", datasync))
            }),
        );
    }
    fn mkdir(
        &mut self,
        _: &Request<'_>,
        parent: u64,
        name: &OsStr,
        mode: u32,
        umask: u32,
        reply: ReplyEntry,
    ) {
        let result = guard(|| {
            let mut c = self.core()?;
            let path = c.child(parent, name)?;
            c.overlay.mkdir(&path, mode & !umask & 0o7777)?;
            let metadata = c
                .overlay
                .getattr(&path, None)?
                .ok_or_else(|| errno(libc::ENOENT))?;
            let ino = c.observe(&path, metadata.clone(), true);
            Ok(attr(ino, &metadata))
        });
        match result {
            Ok(a) => reply.entry(&TTL, &a, 0),
            Err(e) => reply.error(failure(e)),
        }
    }
    fn unlink(&mut self, _: &Request<'_>, parent: u64, name: &OsStr, reply: ReplyEmpty) {
        let result = guard(|| {
            let mut c = self.core()?;
            let path = c.child(parent, name)?;
            c.remove(&path, false)
        });
        empty(reply, result);
    }
    fn rmdir(&mut self, _: &Request<'_>, parent: u64, name: &OsStr, reply: ReplyEmpty) {
        let result = guard(|| {
            let mut c = self.core()?;
            let path = c.child(parent, name)?;
            c.remove(&path, true)
        });
        empty(reply, result);
    }
    fn rename(
        &mut self,
        _: &Request<'_>,
        parent: u64,
        name: &OsStr,
        newparent: u64,
        newname: &OsStr,
        flags: u32,
        reply: ReplyEmpty,
    ) {
        let result = guard(|| {
            let mut c = self.core()?;
            let source = c.child(parent, name)?;
            let destination = c.child(newparent, newname)?;
            c.rename(&source, &destination, flags)
        });
        empty(reply, result);
    }
    fn access(&mut self, _: &Request<'_>, ino: u64, mask: i32, reply: ReplyEmpty) {
        let result = guard(|| {
            let mut c = self.core()?;
            c.current(ino)?;
            let path = c.path(ino)?;
            c.overlay.access(&path, mask)
        });
        empty(reply, result);
    }
    fn statfs(&mut self, _: &Request<'_>, ino: u64, reply: ReplyStatfs) {
        let result = guard(|| {
            let mut c = self.core()?;
            let path = c.path(ino)?;
            c.overlay.statfs(&path)
        });
        match result {
            Ok(s) => {
                let [blocks, bfree, bavail, files, ffree] = storage_counts(&s);
                reply.statfs(
                    blocks,
                    bfree,
                    bavail,
                    files,
                    ffree,
                    narrow(s.f_bsize),
                    narrow(s.f_namemax),
                    narrow(s.f_frsize),
                );
            }
            Err(e) => reply.error(failure(e)),
        }
    }
    fn getxattr(&mut self, _: &Request<'_>, _: u64, _: &OsStr, _: u32, reply: ReplyXattr) {
        reply.error(libc::ENODATA);
    }
    fn listxattr(&mut self, _: &Request<'_>, _: u64, size: u32, reply: ReplyXattr) {
        if size == 0 {
            reply.size(0);
        } else {
            reply.data(&[]);
        }
    }
    fn setxattr(
        &mut self,
        _: &Request<'_>,
        _: u64,
        _: &OsStr,
        _: &[u8],
        _: i32,
        _: u32,
        reply: ReplyEmpty,
    ) {
        reply.error(libc::EOPNOTSUPP);
    }
    fn removexattr(&mut self, _: &Request<'_>, _: u64, _: &OsStr, reply: ReplyEmpty) {
        reply.error(libc::EOPNOTSUPP);
    }
}
fn empty(reply: ReplyEmpty, result: Result<()>) {
    match result {
        Ok(()) => reply.ok(),
        Err(e) => reply.error(failure(e)),
    }
}
