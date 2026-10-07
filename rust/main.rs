mod config;
mod dependencies;
#[cfg(target_os = "linux")]
mod fuse;
mod host;
mod lifecycle;
mod module;
#[cfg(any(target_os = "linux", all(test, unix)))]
mod overlay;
#[cfg(target_os = "linux")]
mod runtime;
mod samba;
#[cfg(test)]
mod test_support;
mod tunnel;
#[cfg(any(target_os = "linux", test))]
mod worker;

use anyhow::Result;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    run_args(args)
}

fn run_args(args: Vec<String>) -> Result<()> {
    if args == ["--sdk-config"] {
        return host::sdk_config();
    }
    if args.is_empty() || args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "Usage: scriptfs /path/to/config.json\n       scriptfs --check\n       scriptfs --sdk\n       scriptfs --sdk-config"
        );
        if args.is_empty() {
            anyhow::bail!("A configuration path is required");
        }
        return Ok(());
    }
    let stop = Arc::new(AtomicBool::new(false));
    install_stop_handler(stop.clone())?;
    if args == ["--sdk"] {
        return host::sdk(stop);
    }
    if args == ["--check"] {
        return host::cli_check(stop);
    }
    #[cfg(target_os = "linux")]
    if args == ["--container"] {
        return runtime::run(stop);
    }
    if args.len() != 1 {
        anyhow::bail!("Expected one configuration path");
    }
    host::run(&args[0], stop)
}

fn install_stop_handler(signal: Arc<AtomicBool>) -> Result<()> {
    ctrlc::set_handler(move || {
        signal.store(true, Ordering::SeqCst);
    })?;
    Ok(())
}
