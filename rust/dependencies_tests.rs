use super::*;
use crate::test_support::{fixture, write};

fn package(directory: &Path, lockfile: &str) {
    write(
        directory.join("package.json"),
        r#"{"dependencies":{"ms":"2.1.3"}}"#,
    );
    write(directory.join(lockfile), r#"{"lockfileVersion":3}"#);
}

#[test]
fn keys_cover_every_input() {
    let root = fixture("dependency-key-");
    let directory = root.path();
    package(directory, "package-lock.json");
    let base = Inputs::read(directory).unwrap();
    let key = base.key("image-a");
    assert_eq!(key.len(), 16);
    assert_eq!(key, Inputs::read(directory).unwrap().key("image-a"));
    assert_ne!(key, base.key("image-b"));
    write(
        directory.join(".npmrc"),
        "registry=https://registry.example.invalid/\n",
    );
    let with_npmrc = Inputs::read(directory).unwrap();
    assert_ne!(key, with_npmrc.key("image-a"));
    write(
        directory.join("package-lock.json"),
        r#"{"lockfileVersion":2}"#,
    );
    assert_ne!(
        with_npmrc.key("image-a"),
        Inputs::read(directory).unwrap().key("image-a")
    );
}

#[test]
fn prefers_the_published_shrinkwrap() {
    let root = fixture("dependency-shrinkwrap-");
    package(root.path(), "package-lock.json");
    write(root.path().join("npm-shrinkwrap.json"), "{}");
    let inputs = Inputs::read(root.path()).unwrap();
    assert_eq!(inputs.lockfile_name, "npm-shrinkwrap.json");
    assert_eq!(inputs.lockfile, b"{}");
}

#[test]
fn verifies_entries_by_content() {
    let root = fixture("dependency-verify-");
    let directory = root.path().join("module");
    package(&directory, "package-lock.json");
    let inputs = Inputs::read(&directory).unwrap();
    let entry = root.path().join("entry");
    assert!(!inputs.matches(&entry, "image"));
    fs::create_dir_all(entry.join("node_modules")).unwrap();
    fs::copy(directory.join("package.json"), entry.join("package.json")).unwrap();
    fs::copy(
        directory.join("package-lock.json"),
        entry.join("package-lock.json"),
    )
    .unwrap();
    write(entry.join("image"), "image");
    assert!(inputs.matches(&entry, "image"));
    assert!(!inputs.matches(&entry, "other-image"));
    write(entry.join("package-lock.json"), "{}");
    assert!(!inputs.matches(&entry, "image"));
}

#[test]
fn prunes_only_entries_unused_for_the_retention_period() {
    let root = fixture("dependency-prune-");
    let old = root.path().join("old");
    let recent = root.path().join("recent");
    for entry in [&old, &recent] {
        fs::create_dir_all(entry.join("node_modules")).unwrap();
        touch(entry);
    }
    fs::File::options()
        .write(true)
        .open(old.join(USED))
        .unwrap()
        .set_modified(SystemTime::now() - RETENTION - Duration::from_secs(60))
        .unwrap();
    prune(root.path());
    assert!(!old.exists());
    assert!(recent.join("node_modules").is_dir());
}

#[test]
fn forwards_only_registry_settings() {
    let root = fixture("dependency-args-");
    let stop = Arc::new(AtomicBool::new(false));
    struct Unused;
    impl Runner for Unused {
        fn run(&self, _: Request) -> Result<crate::host::commands::Output> {
            unreachable!()
        }
    }
    let installer = Installer {
        runner: &Unused,
        stop: &stop,
        image: "localhost/image:1",
        image_id: "id",
        cache_root: root.path(),
        registry: &|| unreachable!(),
    };
    let user_config = format!("npm_config_userconfig={WORKDIR}/{HOST_NPMRC}");
    assert!(
        !installer
            .arguments(root.path(), false)
            .unwrap()
            .contains(&user_config)
    );
    let arguments = installer.arguments(root.path(), true).unwrap();
    assert!(arguments.contains(&user_config));
    assert_eq!(
        &arguments[..4],
        ["run", "--rm", "--security-opt", "label=disable"]
    );
    for (index, value) in arguments.iter().enumerate() {
        if value == "--env" {
            let value = &arguments[index + 1];
            assert!(FORWARDED_ENV.contains(&value.as_str()) || *value == user_config);
        }
    }
    assert!(arguments.contains(&format!("{}:{WORKDIR}", root.path().display())));
    assert!(installer.arguments(Path::new("bad\npath"), true).is_err());
}
