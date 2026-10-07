#![cfg_attr(not(any(test, target_os = "linux")), allow(dead_code))]
use crate::{
    config::Filesystem,
    host::commands::{Request, Runner},
};
use anyhow::{Result, bail};
use serde_json::Value;

pub fn configure_credentials(
    runner: &dyn Runner,
    credentials: &Value,
    config_path: &str,
) -> Result<()> {
    let password = credentials["password"].as_str().unwrap_or("");
    if credentials["username"] != "scriptfs"
        || password.len() != 64
        || !password
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        bail!("Invalid generated ScriptFS SMB credentials");
    }
    runner.run(Request::new(
        "useradd",
        &[
            "--no-create-home",
            "--shell",
            "/usr/sbin/nologin",
            "scriptfs",
        ]
        .map(String::from),
    ))?;
    let mut request = Request::new(
        "smbpasswd",
        &["-s", "-a", "-c", config_path, "scriptfs"].map(String::from),
    );
    request.input = Some(format!("{password}\n{password}\n").into_bytes());
    runner.run(request)?;
    Ok(())
}

pub fn config(filesystems: &[Filesystem], authenticated: bool) -> String {
    let mut value = format!(
        "[global]\nserver role = standalone server\nsecurity = user\nmap to guest = {}\nguest account = nobody\nserver min protocol = SMB2\nsmb ports = 445\nload printers = no\nprinting = bsd\ndisable spoolss = yes\nstat cache = no\ngetwd cache = no\nsmb2 leases = no\noplocks = no\nlevel2 oplocks = no\nkernel change notify = no\nchange notify = no\ndirectory name cache size = 0\n",
        if authenticated { "Never" } else { "Bad User" }
    );
    for filesystem in filesystems {
        value.push_str(&format!("\n[{}]\npath = {}\nbrowseable = yes\nguest ok = {}\n{}read only = {}\nforce user = root\ncreate mask = 0666\nforce create mode = 0000\nveto files = /._*/.DS_Store/\ndelete veto files = yes\n",
            filesystem.name,filesystem.mount_point.display(),if authenticated{"no"}else{"yes"},if authenticated{"valid users = scriptfs\n"}else{""},if filesystem.read_only{"yes"}else{"no"}));
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::Config, host::commands::Output};
    use serde_json::json;
    use std::sync::Mutex;
    #[derive(Default)]
    struct Recorder(Mutex<Vec<Request>>);
    impl Runner for Recorder {
        fn run(&self, request: Request) -> Result<Output> {
            self.0.lock().unwrap().push(request);
            Ok(Output::default())
        }
    }
    fn check_config(authenticated: bool) {
        let input = Config::parse(&serde_json::to_vec(&json!({"filesystems":[{"name":"test","source":"/source","mountPoint":"/overlay","readOnly":true}]})).unwrap()).unwrap();
        let output = config(&input.filesystems, authenticated);
        for expected in [
            "path = /overlay",
            "read only = yes",
            "server min protocol = SMB2",
            "smb ports = 445",
            "stat cache = no",
            "getwd cache = no",
            "smb2 leases = no",
            "oplocks = no",
            "level2 oplocks = no",
            "kernel change notify = no",
            "change notify = no",
            "directory name cache size = 0",
            "force user = root",
            "create mask = 0666",
            "force create mode = 0000",
            "veto files = /._*/.DS_Store/",
        ] {
            assert!(output.contains(expected), "{expected}: {output}");
        }
        assert!(output.contains(if authenticated {
            "guest ok = no"
        } else {
            "guest ok = yes"
        }));
        assert!(output.contains(if authenticated {
            "map to guest = Never"
        } else {
            "map to guest = Bad User"
        }));
        assert_eq!(output.contains("valid users = scriptfs"), authenticated);
    }
    #[test]
    fn guest_config() {
        check_config(false);
    }
    #[test]
    fn authenticated_config() {
        check_config(true);
    }
    #[test]
    fn password_stdin() {
        let recorder = Recorder::default();
        let password = "a".repeat(64);
        configure_credentials(
            &recorder,
            &json!({"username":"scriptfs","password":password}),
            "/run/smb.conf",
        )
        .unwrap();
        let commands = recorder.0.lock().unwrap();
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0].program, "useradd");
        assert_eq!(
            commands[0].args,
            [
                "--no-create-home",
                "--shell",
                "/usr/sbin/nologin",
                "scriptfs"
            ]
        );
        assert_eq!(commands[1].program, "smbpasswd");
        assert_eq!(
            commands[1].args,
            ["-s", "-a", "-c", "/run/smb.conf", "scriptfs"]
        );
        assert_eq!(
            commands[1].input.as_deref(),
            Some(format!("{password}\n{password}\n").as_bytes())
        );
        assert!(!commands[1].args.join(" ").contains(&password));
    }
    #[test]
    fn invalid_credentials() {
        let recorder = Recorder::default();
        for credentials in [
            json!({"username":"scriptfs","password":"invalid\ninput"}),
            json!({"username":"other","password":"a".repeat(64)}),
            json!({"username":"scriptfs","password":"A".repeat(64)}),
            json!({"username":"scriptfs","password":"a".repeat(63)}),
        ] {
            assert!(
                configure_credentials(&recorder, &credentials, "/run/smb.conf")
                    .unwrap_err()
                    .to_string()
                    .contains("Invalid generated")
            );
        }
        assert!(recorder.0.lock().unwrap().is_empty());
    }
}
