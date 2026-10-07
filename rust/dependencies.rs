//! Installs the npm dependencies of modules whose manifest sets
//! `"dependencies": "install"`.
//!
//! `npm ci` runs in a short-lived container from the runtime image, so native
//! addons are built for the container's platform and Node.js rather than the
//! host's. Results are cached on the host by content: the runtime image ID and
//! the module's `package.json`, lockfile, and `.npmrc`. A cache entry is
//! complete once it exists, because installs happen in a temporary directory
//! that is renamed into place.
use crate::host::commands::{Request, Runner};
use crate::module::LOCKFILES;
use anyhow::{Context, Result, bail};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
    time::{Duration, SystemTime},
};

/// Container directory the install runs in.
const WORKDIR: &str = "/scriptfs/install";
/// npm user configuration holding the host's registry. User configuration
/// takes precedence over the image's and yields to the module's `.npmrc`.
const HOST_NPMRC: &str = ".scriptfs-host-npmrc";
/// Host environment variables forwarded to `npm ci`.
pub const FORWARDED_ENV: &[&str] = &[
    "npm_config_registry",
    "NPM_CONFIG_REGISTRY",
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
];
/// Entries unused for this long are removed when another install runs.
const RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);
const USED: &str = ".used";

/// The host cache directory: `SCRIPTFS_CACHE_DIR`, or the platform's user
/// cache directory.
pub fn default_cache_root() -> Result<PathBuf> {
    if let Some(root) = std::env::var_os("SCRIPTFS_CACHE_DIR").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(root));
    }
    let env = |name: &str| {
        std::env::var_os(name)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    let home = || crate::module::home().context("Cannot locate the user cache directory");
    Ok(if cfg!(windows) {
        env("LOCALAPPDATA")
            .map_or_else(|| home().map(|h| h.join("AppData/Local")), Ok)?
            .join("scriptfs")
            .join("cache")
    } else if cfg!(target_os = "macos") {
        home()?.join("Library/Caches/scriptfs")
    } else {
        env("XDG_CACHE_HOME")
            .map_or_else(|| home().map(|h| h.join(".cache")), Ok)?
            .join("scriptfs")
    })
}

/// The inputs that determine an installation.
struct Inputs {
    package: Vec<u8>,
    lockfile_name: &'static str,
    lockfile: Vec<u8>,
    npmrc: Option<Vec<u8>>,
}
impl Inputs {
    fn read(directory: &Path) -> Result<Self> {
        let read = |name: &str| {
            fs::read(directory.join(name))
                .with_context(|| format!("Could not read {}", directory.join(name).display()))
        };
        let lockfile_name = LOCKFILES
            .iter()
            .copied()
            .find(|name| directory.join(name).is_file())
            .with_context(|| format!("{} has no npm lockfile", directory.display()))?;
        Ok(Self {
            package: read("package.json")?,
            lockfile_name,
            lockfile: read(lockfile_name)?,
            npmrc: directory
                .join(".npmrc")
                .is_file()
                .then(|| read(".npmrc"))
                .transpose()?,
        })
    }
    /// A stable 64-bit FNV-1a digest. Entries also store their inputs, so a
    /// collision is detected rather than trusted.
    fn key(&self, image_id: &str) -> String {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        let mut feed = |bytes: &[u8]| {
            for byte in (bytes.len() as u64)
                .to_le_bytes()
                .iter()
                .chain(bytes.iter())
            {
                hash ^= u64::from(*byte);
                hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
            }
        };
        feed(image_id.as_bytes());
        feed(&self.package);
        feed(self.lockfile_name.as_bytes());
        feed(&self.lockfile);
        feed(self.npmrc.as_deref().unwrap_or(b"\0none"));
        format!("{hash:016x}")
    }
    fn matches(&self, entry: &Path, image_id: &str) -> bool {
        fs::read(entry.join("image")).is_ok_and(|id| id == image_id.as_bytes())
            && fs::read(entry.join("package.json")).is_ok_and(|b| b == self.package)
            && fs::read(entry.join(self.lockfile_name)).is_ok_and(|b| b == self.lockfile)
            && entry.join("node_modules").is_dir()
    }
}

pub struct Installer<'a> {
    pub runner: &'a dyn Runner,
    pub stop: &'a Arc<AtomicBool>,
    pub image: &'a str,
    pub image_id: &'a str,
    pub cache_root: &'a Path,
    /// The host's npm registry, if it can be determined.
    pub registry: &'a dyn Fn() -> Result<Option<String>>,
}
impl Installer<'_> {
    /// Returns the host `node_modules` directory holding the installed
    /// production dependencies of the module package in `directory`.
    pub fn ensure(&self, instance: &str, directory: &Path) -> Result<PathBuf> {
        let inputs = Inputs::read(directory)?;
        let root = self.cache_root.join("dependencies");
        let key = inputs.key(self.image_id);
        let entry = root.join(&key);
        if entry.exists() {
            if inputs.matches(&entry, self.image_id) {
                touch(&entry);
                return Ok(entry.join("node_modules"));
            }
            fs::remove_dir_all(&entry)
                .with_context(|| format!("Could not replace {}", entry.display()))?;
        }
        fs::create_dir_all(&root)
            .with_context(|| format!("Could not create {}", root.display()))?;
        prune(&root);
        let staging = tempfile::Builder::new()
            .prefix(&format!(".{key}-"))
            .tempdir_in(&root)
            .with_context(|| format!("Could not create a directory in {}", root.display()))?;
        let work = staging.path();
        fs::write(work.join("package.json"), &inputs.package)?;
        fs::write(work.join(inputs.lockfile_name), &inputs.lockfile)?;
        if let Some(npmrc) = &inputs.npmrc {
            fs::write(work.join(".npmrc"), npmrc)?;
        }
        let registry = (self.registry)()?;
        if let Some(registry) = &registry {
            fs::write(work.join(HOST_NPMRC), format!("registry={registry}\n"))?;
        }
        eprintln!(
            "Installing dependencies of module {instance:?} from {}",
            directory.display()
        );
        let mut request = Request::new("podman", &self.arguments(work, registry.is_some())?);
        request.signal = Some(self.stop.clone());
        request.timeout = Some(INSTALL_TIMEOUT);
        request.inherit = true;
        request.stderr_only = true;
        self.runner.run(request).with_context(|| {
            format!("Could not install the dependencies of module {instance:?}")
        })?;
        for name in [".npmrc", HOST_NPMRC] {
            if work.join(name).exists() {
                fs::remove_file(work.join(name))?;
            }
        }
        // `npm ci` creates no node_modules for a package without dependencies.
        fs::create_dir_all(work.join("node_modules"))?;
        fs::write(work.join("image"), self.image_id)?;
        touch(work);
        let staging = staging.keep();
        if let Err(error) = fs::rename(&staging, &entry) {
            let _ = fs::remove_dir_all(&staging);
            // A concurrent session may have installed the same inputs first.
            if !inputs.matches(&entry, self.image_id) {
                return Err(error).with_context(|| format!("Could not store {}", entry.display()));
            }
        }
        Ok(entry.join("node_modules"))
    }
    fn arguments(&self, work: &Path, host_registry: bool) -> Result<Vec<String>> {
        let host = work
            .to_str()
            .context("The dependency cache path must be valid UTF-8")?;
        if host.contains(['\n', '\0']) {
            bail!("Invalid dependency cache path");
        }
        let mut arguments: Vec<String> = [
            "run",
            "--rm",
            "--security-opt",
            "label=disable",
            "--volume",
            &format!("{host}:{WORKDIR}"),
            "--workdir",
            WORKDIR,
        ]
        .iter()
        .map(|v| v.to_string())
        .collect();
        if host_registry {
            arguments.extend([
                "--env".into(),
                format!("npm_config_userconfig={WORKDIR}/{HOST_NPMRC}"),
            ]);
        }
        for name in FORWARDED_ENV {
            if std::env::var_os(name).is_some() {
                arguments.extend(["--env".into(), (*name).into()]);
            }
        }
        arguments.extend(
            [
                self.image,
                "npm",
                "ci",
                "--omit=dev",
                "--omit=peer",
                "--no-audit",
                "--no-fund",
                "--no-update-notifier",
            ]
            .iter()
            .map(|v| v.to_string()),
        );
        Ok(arguments)
    }
}

fn touch(entry: &Path) {
    let _ = fs::write(entry.join(USED), "");
}

/// Removes entries and abandoned staging directories that have not been used
/// for the retention period. Failures only leave stale entries behind.
fn prune(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        let used = fs::metadata(path.join(USED))
            .or_else(|_| fs::metadata(&path))
            .and_then(|m| m.modified());
        if used.is_ok_and(|used| now.duration_since(used).unwrap_or_default() > RETENTION) {
            let _ = fs::remove_dir_all(&path);
        }
    }
}

#[cfg(test)]
#[path = "dependencies_tests.rs"]
mod tests;
