use super::*;
use crate::{
    host,
    test_support::{fixture, write},
    worker::Worker,
};
use serde_json::json;

/// Resolves a repository asset independently of the working directory the test
/// binary happens to be started from.
fn repo(path: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(path)
}

fn raw(name: &str) -> Value {
    json!({"filesystems":[{"name":name,"source":".","mountPoint":"mount"}]})
}
fn config_file(root: &Path, value: &Value) -> PathBuf {
    let path = root.join("config.json");
    write(&path, serde_json::to_vec(value).unwrap());
    path
}
fn reserved(name: &str) {
    let input = raw(name);
    let error = Config::parse(&serde_json::to_vec(&input).unwrap()).unwrap_err();
    assert!(error.to_string().contains("reserved Samba"), "{error:#}");
    let root = fixture("config-reserved-");
    assert!(
        host::load_config(&config_file(root.path(), &input))
            .unwrap_err()
            .to_string()
            .contains("reserved Samba")
    );
    let schema: Value =
        serde_json::from_slice(&std::fs::read(repo("scriptfs.schema.json")).unwrap()).unwrap();
    let pattern =
        schema["properties"]["filesystems"]["items"]["properties"]["name"]["not"]["pattern"]
            .as_str()
            .unwrap();
    assert!(regress::Regex::new(pattern).unwrap().find(name).is_some());
}
#[test]
fn reserved_global() {
    reserved("global");
}
#[test]
fn reserved_upper_global() {
    reserved("GLOBAL");
}
#[test]
fn reserved_mixed_global() {
    reserved("gLoBaL");
}
#[test]
fn reserved_homes() {
    reserved("homes");
}
#[test]
fn reserved_upper_homes() {
    reserved("HOMES");
}
#[test]
fn reserved_printers() {
    reserved("printers");
}
#[test]
fn reserved_mixed_printers() {
    reserved("Printers");
}
#[test]
fn global_substring() {
    assert!(Config::parse(&serde_json::to_vec(&raw("global-data")).unwrap()).is_ok());
}
#[test]
fn homes_substring() {
    assert!(Config::parse(&serde_json::to_vec(&raw("my-homes")).unwrap()).is_ok());
}
#[test]
fn printers_substring() {
    assert!(Config::parse(&serde_json::to_vec(&raw("printers_1")).unwrap()).is_ok());
}
fn module_config(module: &str) -> Value {
    json!({
        "modules":{module:{"manifest":"./module"}},
        "filesystems":[{"name":"test","source":".","mountPoint":"mount","rules":[{"match":"file","provider":{"module":module}}]}]
    })
}
fn manifest(directory: &Path) {
    write(
        directory.join(crate::module::MANIFEST_FILE),
        r#"{"name":"demo","entry":"index.mjs"}"#,
    );
    write(directory.join("index.mjs"), "export default {}");
}
fn manifest_path(config: &Config, instance: &str) -> PathBuf {
    std::fs::canonicalize(&config.modules[instance].manifest).unwrap()
}
#[test]
fn installed_module_manifest() {
    let root = fixture("config-package-");
    let package = root.path().join("node_modules/@scope/notes");
    manifest(&package);
    let mut input = module_config("notes");
    input["modules"]["notes"]["manifest"] = json!("@scope/notes");
    let (config, public) = host::load_config(&config_file(root.path(), &input)).unwrap();
    let expected = package.join(crate::module::MANIFEST_FILE);
    assert_eq!(
        manifest_path(&config, "notes"),
        std::fs::canonicalize(&expected).unwrap()
    );
    assert_eq!(
        public["modules"]["notes"]["manifest"],
        json!(config.modules["notes"].manifest)
    );
}
#[test]
fn manifest_paths_with_spaces() {
    let root = fixture("config-spaces-");
    manifest(&root.path().join("my modules/notes"));
    let mut input = module_config("notes");
    input["modules"]["notes"]["manifest"] = json!("./my modules/notes");
    let (config, _) = host::load_config(&config_file(root.path(), &input)).unwrap();
    assert_eq!(
        config.modules["notes"].manifest,
        root.path()
            .join("my modules/notes")
            .join(crate::module::MANIFEST_FILE)
    );
}
#[test]
fn manifest_files_relative_to_config() {
    let root = fixture("config-manifest-file-");
    manifest(&root.path().join("modules"));
    std::fs::rename(
        root.path()
            .join("modules")
            .join(crate::module::MANIFEST_FILE),
        root.path().join("modules/notes.module.json"),
    )
    .unwrap();
    let nested = root.path().join("config");
    let mut input = module_config("notes");
    input["modules"]["notes"]["manifest"] = json!("../modules/notes.module.json");
    let (config, _) = host::load_config(&config_file(&nested, &input)).unwrap();
    assert_eq!(
        manifest_path(&config, "notes"),
        std::fs::canonicalize(root.path().join("modules/notes.module.json")).unwrap()
    );
}
#[test]
fn exhaustive_example() {
    let (config, public) = host::load_config(&repo("examples/showcase/config.json")).unwrap();
    assert_eq!(config.filesystems.len(), 2);
    assert_eq!(
        config
            .filesystems
            .iter()
            .map(|f| f.read_only)
            .collect::<Vec<_>>(),
        [false, true]
    );
    assert_eq!(
        public["container"],
        json!({"image":"localhost/scriptfs-runtime:0.1.1","rebuild":false,"smbHost":"127.0.0.1","smbPort":14445,"logLevel":"info"})
    );
    assert_eq!(
        config.modules.keys().collect::<Vec<_>>(),
        ["catalog", "components", "hooks", "memory", "positional"]
    );
    let rules = &config.filesystems[0].rules;
    for mode in ["content", "explicit", "zero", "unbounded"] {
        assert!(rules.iter().any(|r| r.file["sizeMode"] == mode));
    }
    for kind in ["module", "file", "directory"] {
        assert!(rules.iter().any(|r| {
            r.provider
                .as_ref()
                .is_some_and(|p| p.kind.as_deref() == Some(kind))
        }));
    }
    for instance in config.modules.keys() {
        assert!(rules.iter().any(|r| {
            r.provider.as_ref().and_then(|p| p.module.as_deref()) == Some(instance.as_str())
        }));
    }
    assert!(rules.iter().any(|r| r.hide));
    for example in ["local-api", "notes", "inbox"] {
        let (config, _) =
            host::load_config(&repo(&format!("examples/{example}/config.json"))).unwrap();
        assert!(!config.modules.is_empty(), "{example}");
    }
}
#[test]
fn resolves_relative_paths() {
    let root = fixture("config-relative-");
    manifest(&root.path().join("modules/catalog"));
    let mut input = module_config("catalog");
    input["modules"]["catalog"]["manifest"] = json!("./modules/catalog");
    input["filesystems"][0]["source"] = json!("./source");
    input["filesystems"][0]["mountPoint"] = json!("./mount");
    input["filesystems"][0]["rules"][0]["match"] = json!("GeneratedCatalog/**");
    let (config, _) = host::load_config(&config_file(root.path(), &input)).unwrap();
    assert_eq!(config.filesystems[0].source, root.path().join("source"));
    assert_eq!(config.filesystems[0].mount_point, root.path().join("mount"));
    assert_eq!(
        config.modules["catalog"].manifest,
        root.path()
            .join("modules/catalog")
            .join(crate::module::MANIFEST_FILE)
    );
    assert_eq!(
        config.filesystems[0].rules[0]
            .provider
            .as_ref()
            .unwrap()
            .module
            .as_deref(),
        Some("catalog")
    );
}
#[test]
fn posix_not_backslash() {
    assert_eq!(
        normalize("/GeneratedCatalog//Datasets/./Batch1").unwrap(),
        "GeneratedCatalog/Datasets/Batch1"
    );
    for input in [
        r"\GeneratedCatalog\Datasets\Batch1",
        r"..\secret",
        r"directory\..\secret",
    ] {
        assert_eq!(normalize(input).unwrap(), input);
    }
}
#[test]
fn parent_traversal() {
    for input in [
        "../secret",
        "directory/../secret",
        r"directory\name/../secret",
        "directory/..",
    ] {
        assert!(
            normalize(input)
                .unwrap_err()
                .to_string()
                .contains("Invalid virtual path")
        );
    }
    for input in ["..notes", "directory/..notes"] {
        assert_eq!(normalize(input).unwrap(), input);
    }
}
fn pattern(pattern: &str) -> Value {
    Worker::start()
        .unwrap()
        .request(
            json!({"op":"patterns","rules":[{"match":pattern,"provider":{"module":"memory"}}]}),
            &[],
        )
        .unwrap()
        .value[0]
        .clone()
}
fn inferred(pattern_text: &str, root: &str) {
    assert_eq!(pattern(pattern_text)["root"], json!(root));
}
#[test]
fn cpp_root() {
    inferred("C++/**", "C++");
}
#[test]
fn at_root() {
    inferred("team@host/*.txt", "team@host");
}
#[test]
fn bang_root() {
    inferred("wow!/file.txt", "wow!");
}
#[test]
fn literal_braces_root() {
    inferred("literal{tag}/**", "literal{tag}");
}
#[test]
fn escaped_star_root() {
    inferred(r"escaped\*/**", "escaped*");
}
#[test]
fn escaped_backslash_root() {
    inferred(r"back\\slash/**", r"back\slash");
}
#[test]
fn extglob_root() {
    inferred("@(one|two)/**", "");
}
#[test]
fn plus_extglob_root() {
    inferred("root/+(one|two)/**", "root");
}
#[test]
fn character_class_root() {
    inferred("root/[ab]/*.txt", "root");
}
#[test]
fn brace_choices_root() {
    inferred("root/{one,two}/*.txt", "root");
}
#[test]
fn negation_root() {
    inferred("!ignored.txt", "");
}
fn no_child(glob: &str) {
    assert!(pattern(&format!("root/{glob}"))["child"].is_null());
}
#[test]
fn star_not_literal() {
    no_child("*");
}
#[test]
fn question_not_literal() {
    no_child("?");
}
#[test]
fn class_not_literal() {
    no_child("[ab]");
}
#[test]
fn choices_not_literal() {
    no_child("{one,two}");
}
#[test]
fn at_extglob_not_literal() {
    no_child("@(one|two)");
}
#[test]
fn plus_extglob_not_literal() {
    no_child("+(one|two)");
}
#[test]
fn not_extglob_not_literal() {
    no_child("!(one)");
}
#[test]
fn negation_and_literal_bang() {
    assert!(pattern("!ignored.txt")["child"].is_null());
    let literal = pattern("root/!literal.txt");
    assert_eq!(literal["child"], "!literal.txt");
    assert!(
        regress::Regex::new(literal["parentRegex"].as_str().unwrap())
            .unwrap()
            .find("root")
            .is_some()
    );
    let choices = pattern("@(one|two)/data.txt");
    assert_eq!(choices["child"], "data.txt");
    let matcher = regress::Regex::new(choices["parentRegex"].as_str().unwrap()).unwrap();
    assert!(matcher.find("one").is_some());
    assert!(matcher.find("three").is_none());
}
#[test]
fn proxy_type_validation() {
    let root = fixture("config-proxy-");
    write(root.path().join("target.txt"), "target");
    std::fs::create_dir(root.path().join("target-directory")).unwrap();
    let input = json!({"filesystems":[{"name":"proxy","source":".","mountPoint":"./mount","rules":[
        {"match":"ProxyFile.txt","provider":{"type":"file","path":"./target.txt"}},
        {"match":"ProxyDirectory/**","root":"ProxyDirectory","provider":{"type":"directory","path":"./target-directory"}}]}]});
    let (_, public) = host::load_config(&config_file(root.path(), &input)).unwrap();
    assert_eq!(
        public["filesystems"][0]["rules"][0]["provider"],
        json!({"type":"file","path":root.path().join("target.txt")})
    );
    assert_eq!(
        public["filesystems"][0]["rules"][1]["provider"],
        json!({"type":"directory","path":root.path().join("target-directory")})
    );
    for (kind, target) in [
        ("file", "./target-directory"),
        ("directory", "./target.txt"),
    ] {
        let mut invalid = input.clone();
        invalid["filesystems"][0]["rules"] =
            json!([{"match":"Wrong","provider":{"type":kind,"path":target}}]);
        assert!(
            host::load_config(&config_file(root.path(), &invalid))
                .unwrap_err()
                .to_string()
                .contains(&format!("{kind} provider target has the wrong type"))
        );
    }
}
fn proxy_symlink(kind: &str) {
    let root = fixture("config-proxy-symlink-");
    if kind == "file" {
        write(root.path().join("target"), "target");
    } else {
        std::fs::create_dir(root.path().join("target")).unwrap();
    }
    crate::test_support::symlink("target", root.path().join("alias"), kind == "directory");
    let input = json!({"filesystems":[{"name":"proxy","source":".","mountPoint":"mount","rules":[{"match":"Proxy","provider":{"type":kind,"path":"./alias"}}]}]});
    let result = host::load_config(&config_file(root.path(), &input));
    if kind == "file" {
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("a regular file, not a symbolic link")
        );
    } else {
        assert_eq!(
            result.unwrap().1["filesystems"][0]["rules"][0]["provider"],
            json!({"type":"directory","path":root.path().join("alias")})
        );
    }
}
#[test]
fn file_symlink_rejected() {
    proxy_symlink("file");
}
#[test]
fn directory_symlink_valid() {
    proxy_symlink("directory");
}

#[test]
fn invalid_and_contradictory_fields_are_not_silently_accepted() {
    for rule in [
        json!({"match":"a","provider":{"module":"memory","path":"x"}}),
        json!({"match":"a","provider":{"type":"file","path":"x","options":{}}}),
        json!({"match":"a","provider":{"module":"memory"},"hide":true}),
        json!({"match":"a","provider":{"module":"memory"},"file":{"size":-1}}),
        json!({"match":"a","provider":{"module":"memory"},"file":{"seekable":"yes"}}),
        json!({"match":"a","hide":false}),
        json!({"match":"a","provider":{"module":"memory"},"unknown":1}),
    ] {
        let mut input = raw("test");
        input["filesystems"][0]["rules"] = json!([rule]);
        assert!(
            Config::parse(&serde_json::to_vec(&input).unwrap()).is_err(),
            "{input}"
        );
    }
    let input = raw("test");
    let config = Config::parse(&serde_json::to_vec(&input).unwrap()).unwrap();
    assert_eq!(public_config(&input, &config), input);
}

#[test]
fn serialization_preserves_optional_field_absence_and_removes_false_hide() {
    let mut input = module_config("memory");
    input["filesystems"][0]["rules"][0]["hide"] = json!(false);
    let config = Config::parse(&serde_json::to_vec(&input).unwrap()).unwrap();
    let serialized = serde_json::to_value(&config).unwrap();
    let filesystem = &serialized["filesystems"][0];
    let rule = &filesystem["rules"][0];
    assert_eq!(rule["provider"], json!({"module":"memory"}));
    assert!(rule.get("hide").is_none());
    assert!(rule.get("root").is_none());
    assert!(rule.get("opaque").is_none());
    assert!(rule.get("file").is_none());
    assert!(filesystem.get("readOnly").is_none());
    assert!(serialized.get("container").is_none());
    let public = public_config(&input, &config);
    input["filesystems"][0]["rules"][0]
        .as_object_mut()
        .unwrap()
        .remove("hide");
    assert_eq!(public, input);
}

#[test]
fn provider_options_preserve_absence_null_and_json_values_in_config() {
    for options in [
        None,
        Some(Value::Null),
        Some(json!(false)),
        Some(json!(0)),
        Some(json!("")),
        Some(json!({"$date":1234,"nested":{"$date":5678}})),
    ] {
        let mut input = module_config("memory");
        if let Some(options) = &options {
            input["filesystems"][0]["rules"][0]["provider"]["options"] = options.clone();
        }
        let config = Config::parse(&serde_json::to_vec(&input).unwrap()).unwrap();
        let provider = config.filesystems[0].rules[0].provider.as_ref().unwrap();
        assert_eq!(provider.options.as_ref(), options.as_ref());
        let serialized = serde_json::to_value(provider).unwrap();
        assert_eq!(serialized.get("options"), options.as_ref());
        assert_eq!(public_config(&input, &config), input);
    }
}

#[test]
#[cfg(unix)]
fn provider_options_reach_real_worker_as_undefined_null_and_literal_json() {
    let root = fixture("native-config-provider-options-");
    let module = root.path().join("module.mjs");
    write(
        &module,
        r#"export default {
            readFile(context) {
                const { options = "destructured-default" } = context;
                return Buffer.from(JSON.stringify({
                    undefined: context.options === undefined,
                    null: context.options === null,
                    defaultApplied: options === "destructured-default",
                    received: context.options,
                    revived: context.options instanceof Date,
                    nestedRevived: context.options?.nested instanceof Date
                }));
            }
        };"#,
    );
    let worker = Worker::start().unwrap();
    worker
        .request(
            json!({"op":"load","modules":{"options":{"entry":module,"export":"default","runtime":{"version":1,"name":"options"}}}}),
            &[],
        )
        .unwrap();
    let worker = std::sync::Arc::new(worker);
    for options in [
        None,
        Some(Value::Null),
        Some(json!(false)),
        Some(json!(0)),
        Some(json!("")),
        Some(json!({"$date":1234,"nested":{"$date":5678}})),
    ] {
        let mut input = module_config("options");
        input["filesystems"][0]["source"] = json!(root.path());
        if let Some(options) = &options {
            input["filesystems"][0]["rules"][0]["provider"]["options"] = options.clone();
        }
        let config = Config::parse(&serde_json::to_vec(&input).unwrap()).unwrap();
        let mut overlay =
            crate::overlay::Overlay::new(config.filesystems[0].clone(), worker.clone()).unwrap();
        let result: Value = serde_json::from_slice(&overlay.read_all("file").unwrap()).unwrap();
        assert_eq!(result["undefined"], options.is_none());
        assert_eq!(result["null"], options.as_ref().is_some_and(Value::is_null));
        assert_eq!(result["defaultApplied"], options.is_none());
        assert_eq!(result.get("received"), options.as_ref());
        assert_eq!(result["revived"], false);
        assert_eq!(result["nestedRevived"], false);
    }
}

#[test]
fn config_schema_matches_validator() {
    // scriptfs.schema.json drives editor completion and validation. If it drifts
    // from validate_shape, an editor reports a configuration as valid that the
    // binary then refuses to run, so assert the two agree field by field.
    let schema: Value =
        serde_json::from_slice(&std::fs::read(repo("scriptfs.schema.json")).unwrap()).unwrap();
    fn keys(node: &Value, path: &str) -> Vec<String> {
        assert_eq!(
            node["additionalProperties"],
            json!(false),
            "{path} must forbid additional properties, like the validator does"
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
    fn expected(allowed: &[&str]) -> Vec<String> {
        let mut allowed: Vec<String> = allowed.iter().map(|key| (*key).to_owned()).collect();
        allowed.sort();
        allowed
    }
    let filesystem = &schema["properties"]["filesystems"]["items"];
    let rules = &filesystem["properties"]["rules"]["items"]["oneOf"];
    let provider_rule = &rules[1];
    let providers = &provider_rule["properties"]["provider"]["oneOf"];
    for (node, allowed, path) in [
        (&schema, CONFIG_KEYS, "config"),
        (
            &schema["properties"]["container"],
            CONTAINER_KEYS,
            "container",
        ),
        (filesystem, FILESYSTEM_KEYS, "filesystem"),
        (&rules[0], HIDE_RULE_KEYS, "hide rule"),
        (&providers[0], MODULE_PROVIDER_KEYS, "module provider"),
        (&providers[1], PROXY_PROVIDER_KEYS, "file provider"),
        (&providers[2], PROXY_PROVIDER_KEYS, "directory provider"),
        (
            &provider_rule["properties"]["file"],
            FILE_KEYS,
            "file defaults",
        ),
        (
            &schema["properties"]["modules"]["additionalProperties"],
            MODULE_KEYS,
            "module instance",
        ),
    ] {
        assert_eq!(keys(node, path), expected(allowed), "{path} fields drifted");
    }
    // Every rule field the validator accepts must be reachable through exactly
    // one of the two rule branches, and neither branch may invent new fields.
    let instance = &schema["properties"]["modules"]["additionalProperties"]["properties"];
    for (sources, label) in [
        (&instance["secrets"], "secret source"),
        (&instance["ports"], "port binding"),
    ] {
        let mut fields: Vec<String> = sources["additionalProperties"]["oneOf"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|branch| keys(branch, label))
            .collect();
        fields.sort();
        let allowed = if label == "secret source" {
            SECRET_SOURCE_KEYS
        } else {
            PORT_BINDING_KEYS
        };
        assert_eq!(fields, expected(allowed), "{label} fields drifted");
    }
    let mut branches = keys(&rules[0], "hide rule");
    branches.extend(keys(provider_rule, "provider rule"));
    branches.sort();
    branches.dedup();
    assert_eq!(branches, expected(RULE_KEYS), "rule fields drifted");
}

#[test]
fn posix_paths_and_traversal() {
    assert_eq!(normalize("//a/./b\\c").unwrap(), "a/b\\c");
    assert!(normalize("a/../b").is_err());
}
#[test]
fn validates_config() {
    let valid = br#"{"filesystems":[{"name":"code","source":".","mountPoint":"mount"}]}"#;
    assert!(Config::parse(valid).is_ok());
    assert!(Config::parse(br#"{"filesystems":[]}"#).is_err());
    assert!(
        Config::parse(br#"{"filesystems":[{"name":"GLOBAL","source":".","mountPoint":"m"}]}"#)
            .is_err()
    );
}
