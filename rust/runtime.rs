use crate::{
    config::RuntimeConfig,
    fuse::{Core, Mount},
    host,
    module::{self, Secrets},
    overlay::Overlay,
    tunnel,
    worker::Worker,
};
use anyhow::{Context, Result, bail};
use fuser::{BackgroundSession, MountOption};
use serde_json::Value;
use std::{
    fs,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

struct MountedFilesystem {
    session: BackgroundSession,
    path: PathBuf,
    core: Arc<Mutex<Core>>,
}

pub fn run(stop: Arc<AtomicBool>) -> Result<()> {
    unsafe {
        libc::umask(0);
    }
    let config = RuntimeConfig::parse(&fs::read("/scriptfs/config.json")?)?;
    let secrets: Secrets = match fs::read("/scriptfs/secrets.json") {
        Ok(bytes) => serde_json::from_slice(&bytes).context("Invalid ScriptFS secrets")?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Secrets::default(),
        Err(error) => return Err(error.into()),
    };
    let routes = module::outbound_routes(&config.modules);
    let (tunnel, ports) = if routes.is_empty() {
        (None, Default::default())
    } else {
        let (server, ports) = tunnel::Server::start(
            ([0, 0, 0, 0], module::TUNNEL_PORT).into(),
            secrets.tunnel.clone().context("Missing tunnel token")?,
            &routes,
            tunnel::PENDING_TTL,
        )
        .context("Could not start the ScriptFS tunnel")?;
        (Some(server), ports)
    };
    let worker = Arc::new(Worker::start()?);
    let mut mounts = Vec::new();
    let mut loaded = false;
    let outcome = (|| {
        if !config.modules.is_empty() {
            worker.request(
                module::load_request(&config.modules, &secrets, &ports)?,
                &[],
            )?;
            loaded = true;
        }
        for filesystem in &config.filesystems {
            fs::create_dir_all(&filesystem.mount_point)?;
            let core = Arc::new(Mutex::new(Core::new(Overlay::new(
                filesystem.clone(),
                worker.clone(),
            )?)?));
            let mut options = vec![
                MountOption::FSName("scriptfs".into()),
                MountOption::AllowOther,
                MountOption::AutoUnmount,
            ];
            if filesystem.read_only {
                options.push(MountOption::RO);
            }
            let mount =
                fuser::spawn_mount2(Mount(core.clone()), &filesystem.mount_point, &options)?;
            mounts.push(MountedFilesystem {
                session: mount,
                path: filesystem.mount_point.clone(),
                core,
            });
        }
        let authenticated = std::env::var_os("SCRIPTFS_SMB_CREDENTIALS");
        let smb_config = crate::samba::config(&config.filesystems, authenticated.is_some());
        fs::write("/tmp/scriptfs-smb.conf", smb_config)?;
        if let Some(path) = authenticated {
            let credentials: Value = serde_json::from_slice(&fs::read(path)?)?;
            crate::samba::configure_credentials(
                &host::commands::NativeRunner,
                &credentials,
                "/tmp/scriptfs-smb.conf",
            )?;
        }
        let mut samba = Command::new("smbd")
            .args([
                "--foreground",
                "--no-process-group",
                "--configfile",
                "/tmp/scriptfs-smb.conf",
            ])
            .stdin(Stdio::null())
            .spawn()?;
        let result = (|| {
            crate::lifecycle::wait_for_tcp(
                "127.0.0.1:445".parse()?,
                Duration::from_secs(60),
                Duration::from_millis(100),
                &stop,
                || Ok(samba.try_wait()?.is_none()),
            )?;
            // The host follows logs from this instant, measured on the clock
            // that stamps them: a Podman VM's clock can lag the host's.
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?;
            fs::write(
                "/tmp/scriptfs-ready.partial",
                format!("ready {}.{:09}\n", now.as_secs(), now.subsec_nanos()),
            )?;
            fs::rename("/tmp/scriptfs-ready.partial", "/tmp/scriptfs-ready")?;
            println!("SCRIPTFS_READY");
            while !stop.load(Ordering::SeqCst) {
                if let Some(status) = samba.try_wait()? {
                    bail!("Samba exited unexpectedly: {status}");
                }
                for mount in &mounts {
                    match mount.core.try_lock() {
                        Ok(mut core) => core.flush_due(),
                        Err(std::sync::TryLockError::WouldBlock) => (),
                        Err(error) => bail!("Filesystem lock poisoned: {error}"),
                    }
                }
                thread::sleep(Duration::from_millis(100));
            }
            Ok(())
        })();
        let cleanup = host::terminate(&mut samba);
        match (result, cleanup) {
            (Err(error), Err(cleanup)) => bail!("{error:#}; Samba cleanup failed: {cleanup:#}"),
            (Err(error), _) | (_, Err(error)) => Err(error),
            _ => Ok(()),
        }
    })();
    let mut errors = Vec::new();
    if let Err(error) = outcome {
        errors.push(format!("{error:#}"));
    }
    if let Err(error) = worker.abort() {
        errors.push(format!("Provider cancellation failed: {error:#}"));
    }
    // Unmount first so the FUSE request threads cannot race handle cleanup.
    let mut joined_cores = Vec::new();
    while let Some(MountedFilesystem {
        session,
        path,
        core,
    }) = mounts.pop()
    {
        let mut joined = false;
        let result = crate::lifecycle::unmount_and_join_with(
            session,
            || {
                crate::lifecycle::unmount_with(|| {
                    use std::os::unix::ffi::OsStrExt;
                    let path = std::ffi::CString::new(path.as_os_str().as_bytes())?;
                    if unsafe { libc::umount2(path.as_ptr(), 0) } < 0 {
                        let error = std::io::Error::last_os_error();
                        if !matches!(error.raw_os_error(), Some(libc::EINVAL | libc::ENOENT)) {
                            return Err(error.into());
                        }
                    }
                    Ok(())
                })
                .with_context(|| format!("FUSE unmount failed for {}", path.display()))
            },
            |session| {
                let result =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| session.join()));
                joined = true;
                result.map_err(|panic| {
                    let message = panic
                        .downcast_ref::<String>()
                        .map(String::as_str)
                        .or_else(|| panic.downcast_ref::<&str>().copied())
                        .unwrap_or("FUSE session thread panicked");
                    anyhow::anyhow!("FUSE session cleanup failed: {message}")
                })
            },
        );
        if joined {
            joined_cores.push(core);
        }
        if let Err(error) = result {
            errors.push(format!("{error:#}"));
        }
    }
    for core in joined_cores {
        match core.lock() {
            Ok(mut core) => {
                if let Err(e) = core.shutdown() {
                    errors.push(format!("{e:#}"));
                }
            }
            Err(e) => errors.push(e.to_string()),
        }
    }
    // Modules stop after the filesystems are gone, so no callback can race them.
    if loaded {
        if let Err(error) = worker.request(serde_json::json!({"op":"unload"}), &[]) {
            errors.push(format!("{error:#}"));
        }
    }
    if let Some(tunnel) = tunnel {
        tunnel.stop();
    }
    if !errors.is_empty() {
        bail!("ScriptFS container failed: {}", errors.join("; "));
    }
    Ok(())
}
