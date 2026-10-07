use super::*;
use crate::{
    config::public_config,
    test_support::{fixture, write},
};

struct Project {
    root: tempfile::TempDir,
}
impl Project {
    fn new() -> Self {
        let project = Self {
            root: fixture("scriptfs-module-"),
        };
        fs::create_dir_all(project.path("source")).unwrap();
        project
    }
    fn path(&self, relative: &str) -> PathBuf {
        self.root.path().join(relative)
    }
    fn module(&self, directory: &str, manifest: Value) {
        write(
            self.path(directory).join(MANIFEST_FILE),
            serde_json::to_vec(&manifest).unwrap(),
        );
        if let Some(entry) = manifest["entry"].as_str() {
            write(self.path(directory).join(entry), "export default {};");
        }
    }
    fn config(&self, modules: Value) -> Config {
        Config::parse(
            &serde_json::to_vec(&json!({
                "modules": modules,
                "filesystems": [{"name":"code","source":"source","mountPoint":"mount"}]
            }))
            .unwrap(),
        )
        .unwrap()
    }
    fn resolve(&self, modules: Value) -> Result<(Config, Vec<Resolved>)> {
        let mut config = self.config(modules);
        let home = self.path("home");
        let resolved = resolve_with(&mut config, self.root.path(), Some(&home))?;
        Ok((config, resolved))
    }
    fn error(&self, modules: Value) -> String {
        format!("{:#}", self.resolve(modules).unwrap_err())
    }
}

fn manifest(extra: Value) -> Value {
    let mut manifest = json!({"name":"demo","entry":"index.mjs"});
    for (key, value) in extra.as_object().unwrap() {
        manifest[key] = value.clone();
    }
    manifest
}

#[test]
fn manifests_are_found_by_file_directory_and_package_name() {
    let project = Project::new();
    project.module("modules/dir", manifest(json!({})));
    project.module("modules/file", manifest(json!({})));
    fs::rename(
        project.path("modules/file").join(MANIFEST_FILE),
        project.path("modules/file/custom.json"),
    )
    .unwrap();
    project.module("node_modules/plain", manifest(json!({})));
    project.module("node_modules/@scope/pkg", manifest(json!({})));
    project.module("home/mods/tilde", manifest(json!({})));
    let nested = project.path("nested/deeper");
    fs::create_dir_all(&nested).unwrap();
    let home = project.path("home");
    let find = |reference: &str, base: &Path| locate(reference, base, Some(&home));
    let base = project.root.path();
    assert_eq!(
        find("./modules/dir", base).unwrap(),
        project.path("modules/dir").join(MANIFEST_FILE)
    );
    assert_eq!(
        find("modules/file/custom.json", base).unwrap_err().to_string(),
        "Cannot find module package \"modules/file/custom.json\": no node_modules/modules/file/custom.json above ".to_string()
            + &base.display().to_string()
    );
    assert_eq!(
        find("./modules/file/custom.json", base).unwrap(),
        project.path("modules/file/custom.json")
    );
    assert_eq!(
        find(project.path("modules/dir").to_str().unwrap(), &nested).unwrap(),
        project.path("modules/dir").join(MANIFEST_FILE)
    );
    assert_eq!(
        find("plain", &nested).unwrap(),
        project.path("node_modules/plain").join(MANIFEST_FILE)
    );
    assert_eq!(
        find("@scope/pkg", &nested).unwrap(),
        project.path("node_modules/@scope/pkg").join(MANIFEST_FILE)
    );
    assert_eq!(
        find("~/mods/tilde", base).unwrap(),
        project.path("home/mods/tilde").join(MANIFEST_FILE)
    );
    assert!(
        find("./modules", base)
            .unwrap_err()
            .to_string()
            .contains("does not contain scriptfs.module.json")
    );
    assert!(
        find("./missing.json", base)
            .unwrap_err()
            .to_string()
            .starts_with("Module manifest not found")
    );
    for invalid in ["@scope", "a//b", "a/../b", "C:x"] {
        assert!(
            find(invalid, base)
                .unwrap_err()
                .to_string()
                .starts_with("Invalid module manifest reference"),
            "{invalid}"
        );
    }
    assert!(locate("~/x", base, None).is_err());
}

#[test]
fn manifest_validation_reports_the_offending_field() {
    let project = Project::new();
    let cases = [
        (json!({"extra":1}), "Unknown manifest field: extra"),
        (json!({"name":""}), "name must be a non-empty string"),
        (
            json!({"entry":"../index.mjs"}),
            "entry must be a relative path",
        ),
        (
            json!({"entry":"/index.mjs"}),
            "entry must be a relative path",
        ),
        (json!({"entry":"."}), "entry must be a relative path"),
        (json!({"export":""}), "export must be a non-empty string"),
        (json!({"state":"yes"}), "state must be a boolean"),
        (
            json!({"dependencies":"npm"}),
            "dependencies must be \"bundled\" or \"install\"",
        ),
        (json!({"version":1}), "version must be a string"),
        (
            json!({"settings":{"1x":{"type":"string"}}}),
            "Invalid settings name \"1x\"",
        ),
        (
            json!({"settings":{"x":{"type":"date"}}}),
            "settings.x.type must be one of",
        ),
        (
            json!({"settings":{"x":{"type":"string","default":1}}}),
            "settings.x.default must be of type string",
        ),
        (
            json!({"settings":{"x":{"type":"string","enum":[]}}}),
            "settings.x.enum must be a non-empty list",
        ),
        (
            json!({"settings":{"x":{"type":"string","enum":["a"],"default":"b"}}}),
            "settings.x.default must be one of [\"a\"]",
        ),
        (
            json!({"settings":{"x":{"type":"string","min":1}}}),
            "Unknown settings.x field: min",
        ),
        (
            json!({"secrets":{"x":{"env":"1BAD"}}}),
            "secrets.x.env must be an environment variable name",
        ),
        (json!({"ports":{"x":{}}}), "ports.x.direction must be"),
        (
            json!({"ports":{"x":{"direction":"outbound","port":1}}}),
            "Unknown ports.x field: port",
        ),
        (
            json!({"ports":{"x":{"direction":"outbound","target":"nohost"}}}),
            "expected host:port",
        ),
        (
            json!({"ports":{"x":{"direction":"inbound"}}}),
            "ports.x.port is required",
        ),
        (
            json!({"ports":{"x":{"direction":"inbound","port":0}}}),
            "ports.x.port must be between 1 and 65535",
        ),
        (
            json!({"ports":{"x":{"direction":"inbound","port":80,"target":"a:1"}}}),
            "Unknown ports.x field: target",
        ),
        (
            json!({"paths":{"x":{"default":"relative"}}}),
            "paths.x.default must be an absolute path",
        ),
        (json!({"paths":{"x":{"access":"write"}}}), "paths.x"),
        (
            json!({"paths":{"x":{"target":"/etc/x"}}}),
            "is reserved (/etc belongs to the runtime)",
        ),
        (
            json!({"paths":{"x":{"target":"relative"}}}),
            "expected a normalized absolute path",
        ),
        (
            json!({"paths":{"x":{"target":"/data/../x"}}}),
            "expected a normalized absolute path",
        ),
        (
            json!({"paths":{"x":{"target":"/data:ro"}}}),
            "expected a normalized absolute path",
        ),
    ];
    for (index, (extra, expected)) in cases.into_iter().enumerate() {
        let directory = format!("modules/case{index}");
        let mut value = manifest(json!({}));
        for (key, field) in extra.as_object().unwrap() {
            value[key] = field.clone();
        }
        write(
            project.path(&directory).join(MANIFEST_FILE),
            serde_json::to_vec(&value).unwrap(),
        );
        let error = format!(
            "{:#}",
            read_manifest(&project.path(&directory).join(MANIFEST_FILE)).unwrap_err()
        );
        assert!(error.contains(expected), "{index}: {error}");
        assert!(error.starts_with("Invalid module manifest"), "{error}");
    }
}

#[test]
fn settings_apply_defaults_and_validate_configured_values() {
    let project = Project::new();
    project.module(
        "m",
        manifest(json!({"settings":{
            "title":{"type":"string","default":"Notes"},
            "limit":{"type":"integer","required":true},
            "ratio":{"type":"number"},
            "mode":{"type":"string","enum":["fast","safe"],"default":"safe"},
            "tags":{"type":"array","default":[]}
        }})),
    );
    let (_, resolved) = project
        .resolve(json!({"m":{"manifest":"./m","settings":{"limit":5,"ratio":0.5}}}))
        .unwrap();
    assert_eq!(
        Value::Object(resolved[0].settings.clone()),
        json!({"title":"Notes","limit":5,"ratio":0.5,"mode":"safe","tags":[]})
    );
    assert!(
        project
            .error(json!({"m":{"manifest":"./m"}}))
            .contains("modules.m.settings.limit is required")
    );
    assert!(
        project
            .error(json!({"m":{"manifest":"./m","settings":{"limit":1.5}}}))
            .contains("modules.m.settings.limit must be of type integer")
    );
    assert!(
        project
            .error(json!({"m":{"manifest":"./m","settings":{"limit":1,"mode":"slow"}}}))
            .contains("modules.m.settings.mode must be one of [\"fast\",\"safe\"]")
    );
    let error = project.error(json!({"m":{"manifest":"./m","settings":{"limit":1,"other":1}}}));
    assert!(
        error.starts_with("Module \"m\" could not be configured"),
        "{error}"
    );
    assert!(
        error.contains("The manifest declares no setting \"other\""),
        "{error}"
    );
}

#[test]
fn secrets_come_from_the_environment_or_files_at_session_start() {
    let project = Project::new();
    project.module(
        "m",
        manifest(json!({"secrets":{
            "token":{"env":"DEMO_TOKEN"},
            "key":{"required":false},
            "file":{},
            "optional":{"env":"DEMO_OPTIONAL","required":false}
        }})),
    );
    write(project.path("secret.txt"), "from-file\r\n");
    let (config, resolved) = project
        .resolve(json!({"m":{"manifest":"./m","secrets":{"file":{"file":"secret.txt"}}}}))
        .unwrap();
    assert_eq!(
        config.modules["m"].secrets["file"].file.as_deref(),
        Some(project.path("secret.txt").as_path())
    );
    let environment = |name: &str| (name == "DEMO_TOKEN").then(|| "from-env".to_string());
    assert_eq!(
        serde_json::to_value(read_secrets(&resolved, &environment).unwrap()).unwrap(),
        json!({"m":{"token":"from-env","file":"from-file"}})
    );
    let error = format!("{:#}", read_secrets(&resolved, &|_| None).unwrap_err());
    assert_eq!(
        error,
        "Module \"m\" secret \"token\" is required: set the DEMO_TOKEN environment variable or configure modules.m.secrets.token"
    );
    let empty = |name: &str| (name == "DEMO_TOKEN").then(String::new);
    assert!(read_secrets(&resolved, &empty).is_err());

    let (_, renamed) = project
        .resolve(json!({"m":{"manifest":"./m","secrets":{
            "token":{"env":"OTHER_TOKEN"},
            "file":{"file":"missing.txt"}
        }}}))
        .unwrap();
    let environment = |name: &str| (name == "OTHER_TOKEN").then(|| "other".to_string());
    let error = format!("{:#}", read_secrets(&renamed, &environment).unwrap_err());
    assert!(
        error.starts_with("Module \"m\" secret \"file\": could not read"),
        "{error}"
    );

    project.module("required", manifest(json!({"secrets":{"key":{}}})));
    let (_, resolved) = project
        .resolve(json!({"required":{"manifest":"./required"}}))
        .unwrap();
    assert_eq!(
        format!("{:#}", read_secrets(&resolved, &|_| None).unwrap_err()),
        "Module \"required\" secret \"key\" is required: configure modules.required.secrets.key as {\"env\": \"VARIABLE\"} or {\"file\": \"path\"}"
    );
    assert!(
        project
            .error(json!({"m":{"manifest":"./m","secrets":{"unknown":{"env":"X"}}}}))
            .contains("The manifest declares no secret \"unknown\"")
    );
}

#[test]
fn paths_bind_host_locations_to_container_targets() {
    let project = Project::new();
    fs::create_dir_all(project.path("home/Notes")).unwrap();
    fs::create_dir_all(project.path("data")).unwrap();
    write(project.path("settings.json"), "{}");
    project.module(
        "m",
        manifest(json!({"paths":{
            "notes":{"default":"~/Notes","target":"/notes"},
            "data":{"access":"read-write"},
            "config":{"type":"file"},
            "cache":{"required":false,"default":"~/missing"},
            "extra":{"required":false}
        }})),
    );
    let (config, resolved) = project
        .resolve(json!({"m":{"manifest":"./m","paths":{"data":"data","config":"./settings.json"}}}))
        .unwrap();
    let paths = &resolved[0].paths;
    assert_eq!(
        paths["notes"],
        BoundPath {
            host: project.path("home/Notes"),
            target: "/notes".into(),
            writable: false
        }
    );
    assert_eq!(
        paths["data"],
        BoundPath {
            host: project.path("data"),
            target: "/scriptfs/paths/m/data".into(),
            writable: true
        }
    );
    assert_eq!(paths["config"].host, project.path("settings.json"));
    assert!(!paths.contains_key("cache") && !paths.contains_key("extra"));
    assert_eq!(config.modules["m"].paths["data"], project.path("data"));

    assert!(
        project
            .error(json!({"m":{"manifest":"./m","paths":{"config":"settings.json"}}}))
            .contains("modules.m.paths.data is required: set it to a host path")
    );
    assert!(
        project
            .error(json!({"m":{"manifest":"./m","paths":{"data":"settings.json","config":"settings.json"}}}))
            .contains("modules.m.paths.data must be a directory")
    );
    assert!(
        project
            .error(json!({"m":{"manifest":"./m","paths":{"data":"data","config":"data"}}}))
            .contains("modules.m.paths.config must be a file")
    );
    assert!(
        project
            .error(json!({"m":{"manifest":"./m","paths":{"data":"data","config":"settings.json","extra":"nope"}}}))
            .contains("modules.m.paths.extra (directory) is not accessible")
    );
    fs::remove_dir(project.path("home/Notes")).unwrap();
    assert!(
        project
            .error(json!({"m":{"manifest":"./m","paths":{"data":"data","config":"settings.json"}}}))
            .contains("modules.m.paths.notes (directory) is not accessible")
    );
}

#[test]
fn container_targets_and_inbound_ports_must_not_collide() {
    let project = Project::new();
    fs::create_dir_all(project.path("data")).unwrap();
    project.module(
        "a",
        manifest(json!({"paths":{"x":{"target":"/data","default":"/"}},"ports":{"web":{"direction":"inbound","port":8080}}})),
    );
    project.module(
        "b",
        manifest(json!({"paths":{"x":{"target":"/data/inner","default":"/"}}})),
    );
    project.module(
        "c",
        manifest(json!({"ports":{"web":{"direction":"inbound","port":8080,"hostPort":9000}}})),
    );
    project.module(
        "d",
        manifest(json!({"ports":{"web":{"direction":"inbound","port":445}}})),
    );
    project.module(
        "e",
        manifest(json!({"ports":{"web":{"direction":"inbound","port":7445}}})),
    );
    assert!(
        project
            .error(json!({"a":{"manifest":"./a"},"b":{"manifest":"./b"}}))
            .contains("modules.b.paths.x and modules.a.paths.x use overlapping container targets")
    );
    assert!(
        project
            .error(json!({"a":{"manifest":"./a"},"c":{"manifest":"./c"}}))
            .contains("both listen on container port 8080")
    );
    assert!(
        project
            .error(json!({"a":{"manifest":"./a"},"c":{"manifest":"./c","ports":{"web":{"hostPort":8080}}}}))
            .contains("both listen on container port 8080")
    );
    assert!(
        project
            .error(json!({"d":{"manifest":"./d"}}))
            .contains("cannot listen on container port 445")
    );
    assert!(
        project
            .error(json!({"e":{"manifest":"./e"}}))
            .contains("cannot listen on container port 7445")
    );
    let mut config = project.config(json!({"a":{"manifest":"./a"}}));
    config.container.smb_port = Some(8080);
    assert!(
        format!(
            "{:#}",
            resolve_with(&mut config, project.root.path(), None).unwrap_err()
        )
        .contains("host port 8080 is already used by container.smbPort")
    );
}

#[test]
fn ports_take_targets_and_host_ports_from_the_config() {
    let project = Project::new();
    project.module(
        "m",
        manifest(json!({"ports":{
            "api":{"direction":"outbound","target":"localhost:4310"},
            "db":{"direction":"outbound"},
            "hook":{"direction":"inbound","port":8787}
        }})),
    );
    let error = project.error(json!({"m":{"manifest":"./m"}}));
    assert!(
        error.contains("modules.m.ports.db needs a target"),
        "{error}"
    );
    let (_, resolved) = project
        .resolve(json!({"m":{"manifest":"./m","ports":{"db":{"target":"[::1]:5432"},"hook":{"hostPort":18787}}}}))
        .unwrap();
    assert_eq!(
        resolved[0].ports,
        BTreeMap::from([
            (
                "api".into(),
                Port::Outbound {
                    target: "localhost:4310".into()
                }
            ),
            (
                "db".into(),
                Port::Outbound {
                    target: "[::1]:5432".into()
                }
            ),
            (
                "hook".into(),
                Port::Inbound {
                    port: 8787,
                    host_port: 18787
                }
            ),
        ])
    );
    assert!(
        project
            .error(json!({"m":{"manifest":"./m","ports":{"db":{"hostPort":1}}}}))
            .contains("modules.m.ports.db is outbound; configure it with target")
    );
    assert!(
        project
            .error(json!({"m":{"manifest":"./m","ports":{"db":{"target":"a:1"},"hook":{"target":"a:1"}}}}))
            .contains("modules.m.ports.hook is inbound; configure it with hostPort")
    );
    assert_eq!(parse_target("[::1]:80").unwrap(), ("::1".into(), 80));
    assert_eq!(
        parse_target("host.example:443").unwrap(),
        ("host.example".into(), 443)
    );
    for invalid in [
        "",
        "host",
        ":80",
        "host:0",
        "host:70000",
        "a b:1",
        "host:http",
    ] {
        assert!(parse_target(invalid).is_err(), "{invalid}");
    }
}

#[test]
fn state_defaults_next_to_the_configuration() {
    let project = Project::new();
    project.module("stateful", manifest(json!({"state":true})));
    project.module("stateless", manifest(json!({})));
    let (config, resolved) = project
        .resolve(
            json!({"stateful":{"manifest":"./stateful"},"stateless":{"manifest":"./stateless"}}),
        )
        .unwrap();
    let expected = project.path(".scriptfs/state/stateful");
    assert_eq!(resolved[0].state.as_deref(), Some(expected.as_path()));
    assert_eq!(
        config.modules["stateful"].state.as_deref(),
        Some(expected.as_path())
    );
    assert_eq!(resolved[1].state, None);
    let (_, overridden) = project
        .resolve(json!({"stateful":{"manifest":"./stateful","state":"~/state"}}))
        .unwrap();
    assert_eq!(overridden[0].state, Some(project.path("home/state")));
    assert!(
        project
            .error(json!({"stateless":{"manifest":"./stateless","state":"x"}}))
            .contains("modules.stateless.state is set, but the manifest does not use state")
    );
    write(project.path("file"), "");
    assert!(
        project
            .error(json!({"stateful":{"manifest":"./stateful","state":"file"}}))
            .contains("modules.stateful.state must be a directory")
    );
}

#[test]
fn installed_dependencies_need_a_package_and_lockfile() {
    let project = Project::new();
    project.module("m", manifest(json!({"dependencies":"install"})));
    let modules = json!({"m":{"manifest":"./m"}});
    assert!(
        project
            .error(modules.clone())
            .contains("has no package.json")
    );
    write(project.path("m/package.json"), "{}");
    assert!(
        project
            .error(modules.clone())
            .contains("has no npm-shrinkwrap.json or package-lock.json")
    );
    write(project.path("m/package-lock.json"), "{}");
    let (_, resolved) = project.resolve(modules).unwrap();
    assert_eq!(resolved[0].manifest.dependencies, Dependencies::Install);
    project.module("b", manifest(json!({})));
    let (_, bundled) = project.resolve(json!({"b":{"manifest":"./b"}})).unwrap();
    assert_eq!(bundled[0].manifest.dependencies, Dependencies::Bundled);
}

#[test]
fn describe_reports_the_validated_manifest() {
    let project = Project::new();
    project.module("m", manifest(json!({"state":true})));
    let described = describe("./m", project.root.path()).unwrap();
    assert_eq!(
        described["manifestPath"],
        utf8(&project.path("m").join(MANIFEST_FILE)).unwrap()
    );
    assert_eq!(described["manifest"]["state"], true);
    assert_eq!(described["manifest"]["name"], "demo");
    project.module("bad", manifest(json!({"state":"yes"})));
    assert!(
        format!("{:#}", describe("./bad", project.root.path()).unwrap_err())
            .contains("state must be a boolean")
    );
    write(
        project.path("e").join(MANIFEST_FILE),
        serde_json::to_vec(&manifest(json!({}))).unwrap(),
    );
    assert!(
        describe("./e", project.root.path())
            .unwrap_err()
            .to_string()
            .contains("Module entry not found")
    );
}

#[test]
fn entry_files_must_exist() {
    let project = Project::new();
    write(
        project.path("m").join(MANIFEST_FILE),
        serde_json::to_vec(&manifest(json!({}))).unwrap(),
    );
    assert!(
        project
            .error(json!({"m":{"manifest":"./m"}}))
            .contains("Module entry not found")
    );
}

#[test]
fn resolution_is_idempotent_and_reported_as_absolute_paths() {
    let project = Project::new();
    fs::create_dir_all(project.path("data")).unwrap();
    write(project.path("token"), "t");
    project.module(
        "m",
        manifest(json!({"state":true,"paths":{"data":{}},"secrets":{"token":{}}})),
    );
    let raw = json!({
        "modules":{"m":{"manifest":"./m","paths":{"data":"data"},"secrets":{"token":{"file":"token"}}}},
        "filesystems":[{"name":"code","source":"source","mountPoint":"mount"}]
    });
    let mut config = Config::parse(&serde_json::to_vec(&raw).unwrap()).unwrap();
    resolve_with(&mut config, project.root.path(), None).unwrap();
    let output = public_config(&raw, &config);
    assert_eq!(
        output["modules"]["m"],
        json!({
            "manifest": project.path("m").join(MANIFEST_FILE),
            "paths": {"data": project.path("data")},
            "secrets": {"token": {"file": project.path("token")}},
            "state": project.path(".scriptfs/state/m")
        })
    );
    let mut again = Config::parse(&serde_json::to_vec(&output).unwrap()).unwrap();
    let elsewhere = project.path("source");
    resolve_with(&mut again, &elsewhere, None).unwrap();
    assert_eq!(public_config(&output, &again), output);
}

#[test]
fn load_requests_describe_the_module_runtime() {
    let modules = BTreeMap::from([(
        "api".to_string(),
        RuntimeModule {
            entry: "/scriptfs/modules/0/index.mjs".into(),
            export: "Api".into(),
            manifest: json!({"name":"api","version":"1.0.0"}),
            settings: json!({"limit":5}).as_object().unwrap().clone(),
            ports: BTreeMap::from([
                ("http".into(), RuntimePort::Outbound {}),
                (
                    "hook".into(),
                    RuntimePort::Inbound {
                        port: 8787,
                        host_port: 18787,
                    },
                ),
            ]),
            paths: BTreeMap::from([("notes".into(), "/notes".into())]),
            state_dir: Some("/scriptfs/state/api".into()),
        },
    )]);
    assert_eq!(outbound_routes(&modules), ["api.http"]);
    let secrets = Secrets {
        tunnel: Some("t".into()),
        modules: BTreeMap::from([(
            "api".into(),
            BTreeMap::from([("token".into(), "secret".into())]),
        )]),
    };
    let request = load_request(
        &modules,
        &secrets,
        &BTreeMap::from([("api.http".into(), 40000)]),
    )
    .unwrap();
    assert_eq!(
        request,
        json!({"op":"load","modules":{"api":{
            "entry":"/scriptfs/modules/0/index.mjs",
            "export":"Api",
            "runtime":{
                "version":1,
                "name":"api",
                "manifest":{"name":"api","version":"1.0.0"},
                "settings":{"limit":5},
                "secrets":{"token":"secret"},
                "ports":{
                    "http":{"direction":"outbound","host":"127.0.0.1","port":40000},
                    "hook":{"direction":"inbound","host":"0.0.0.0","port":8787,"hostPort":18787}
                },
                "paths":{"notes":"/notes"},
                "stateDir":"/scriptfs/state/api"
            }
        }}})
    );
    assert!(load_request(&modules, &secrets, &BTreeMap::new()).is_err());
    let encoded = serde_json::to_value(&modules["api"]).unwrap();
    assert_eq!(
        encoded["ports"],
        json!({"http":{"direction":"outbound"},"hook":{"direction":"inbound","port":8787,"hostPort":18787}})
    );
    assert_eq!(
        serde_json::from_value::<RuntimeModule>(encoded).unwrap(),
        modules["api"]
    );
}

#[test]
fn home_relative_paths_expand() {
    let home = Path::new("/home/user");
    let base = Path::new("/project");
    assert_eq!(
        host_path(base, Path::new("~"), Some(home)).unwrap(),
        PathBuf::from("/home/user")
    );
    assert_eq!(
        host_path(base, Path::new("~/a/../b"), Some(home)).unwrap(),
        PathBuf::from("/home/user/b")
    );
    assert_eq!(
        host_path(base, Path::new("~other"), Some(home)).unwrap(),
        PathBuf::from("/project/~other")
    );
    assert_eq!(
        host_path(base, Path::new("rel"), None).unwrap(),
        PathBuf::from("/project/rel")
    );
    assert!(host_path(base, Path::new("~/x"), None).is_err());
    assert!(environment_name("_A1") && !environment_name("1A") && !environment_name(""));
}

#[test]
fn manifest_schema_matches_validator() {
    let schema: Value = serde_json::from_slice(
        &fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("scriptfs-module.schema.json"))
            .unwrap(),
    )
    .unwrap();
    fn keys(node: &Value, path: &str) -> Vec<String> {
        assert_eq!(
            node["additionalProperties"],
            json!(false),
            "{path} must be sealed"
        );
        let mut keys: Vec<String> = node["properties"]
            .as_object()
            .unwrap_or_else(|| panic!("{path} must declare properties"))
            .keys()
            .cloned()
            .collect();
        keys.sort();
        keys
    }
    fn sorted(allowed: &[&str]) -> Vec<String> {
        let mut allowed: Vec<String> = allowed.iter().map(|key| (*key).to_owned()).collect();
        allowed.sort();
        allowed
    }
    let properties = &schema["properties"];
    let ports = &properties["ports"]["additionalProperties"]["oneOf"];
    for (node, allowed, path) in [
        (&schema, MANIFEST_KEYS, "manifest"),
        (
            &properties["settings"]["additionalProperties"],
            SETTING_KEYS,
            "setting",
        ),
        (
            &properties["secrets"]["additionalProperties"],
            SECRET_KEYS,
            "secret",
        ),
        (&ports[0], OUTBOUND_PORT_KEYS, "outbound port"),
        (&ports[1], INBOUND_PORT_KEYS, "inbound port"),
        (
            &properties["paths"]["additionalProperties"],
            PATH_KEYS,
            "path",
        ),
    ] {
        assert_eq!(keys(node, path), sorted(allowed), "{path} fields drifted");
    }
    assert_eq!(
        properties["settings"]["additionalProperties"]["properties"]["type"]["enum"],
        json!(SETTING_TYPES)
    );
}
