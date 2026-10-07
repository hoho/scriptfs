use super::tests::fixture;
use super::*;
use std::os::unix::fs::PermissionsExt;

const TRACE: &str = r#"
import * as nodefs from "node:fs";
import * as nodeio from "node:fs/promises";
const tracePath = new URL("./trace.json", import.meta.url);
let events=[];
function record(op, args, c) {
  events.push({op,args,context:{path:c.path,relativePath:c.relativePath,ruleRoot:c.ruleRoot,
    sourcePath:c.sourcePath,options:c.options,flags:c.flags,signal:c.signal instanceof AbortSignal,
    handle:c.handle?.marker ?? (c.handle && typeof c.handle.fd === "number" ? {fd:c.handle.fd} : c.handle),
    previousContents:c.previousContents?.toString()}});
  nodefs.writeFileSync(tracePath, JSON.stringify(events));
}
function tracked(p) {
  return new Proxy(p,{get(p,k) {const v=p[k]; if(typeof v!=="function")return v;
    return function(...args) {record(k,args.slice(0,-1).map(v=>Buffer.isBuffer(v)?v.toString():v),args.at(-1));
      return v.apply(p,args);};}});
}
function fail(code,message=code) {throw Object.assign(new Error(message),{code});}
"#;

fn module_fixture(rules: Value, module: &str) -> (tempfile::TempDir, Overlay) {
    fixture(rules, Some(&format!("{TRACE}\n{module}")))
}
fn rule(pattern: &str) -> Value {
    json!({"match":pattern,"provider":{"module":"default"}})
}
fn opaque(pattern: &str, root: &str) -> Value {
    json!({"match":pattern,"root":root,"opaque":true,"provider":{"module":"default"}})
}
fn trace(root: &tempfile::TempDir) -> Vec<Value> {
    fs::read(root.path().join("trace.json"))
        .map(|bytes| serde_json::from_slice(&bytes).unwrap())
        .unwrap_or_default()
}
fn calls(root: &tempfile::TempDir, op: &str) -> Vec<Value> {
    trace(root).into_iter().filter(|v| v["op"] == op).collect()
}
fn source(root: &tempfile::TempDir) -> PathBuf {
    root.path().join("source")
}
fn put(path: impl AsRef<Path>, bytes: impl AsRef<[u8]>) {
    let path = path.as_ref();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}
fn names(overlay: &mut Overlay, path: &str) -> Vec<String> {
    overlay
        .readdir(path)
        .unwrap()
        .unwrap()
        .into_iter()
        .map(|(n, _)| n)
        .collect()
}
fn sorted_names(overlay: &mut Overlay, path: &str) -> Vec<String> {
    let mut entries = names(overlay, path);
    entries.sort();
    entries
}
fn metadata(overlay: &mut Overlay, path: &str) -> Metadata {
    overlay.getattr(path, None).unwrap().unwrap()
}
fn assert_errno<T>(result: Result<T>, code: i32) {
    match result {
        Err(error) => assert_eq!(error_code(&error), code, "{error:#}"),
        Ok(_) => panic!("Expected errno {code}, operation succeeded"),
    }
}
fn native_identity(path: &Path) -> String {
    native_metadata(&fs::symlink_metadata(path).unwrap())
        .unwrap()
        .identity
        .unwrap()
}
fn assert_closed(fd: i32) {
    let mut stat = std::mem::MaybeUninit::uninit();
    let result = unsafe { libc::fstat(fd, stat.as_mut_ptr()) };
    if result == -1 {
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::EBADF)
        );
    } else {
        assert_eq!(result, 0);
        let stat = unsafe { stat.assume_init() };
        // Concurrent tests can reuse the process-wide descriptor number after close.
        native_test_hooks::IDENTITIES.with_borrow(|identities| {
            assert_ne!(
                identities.get(&fd).unwrap(),
                &(stat.st_dev, stat.st_ino),
                "Original native descriptor {fd} was not closed"
            );
        });
    }
}

#[test]
fn checks_generated_files_and_synthetic_ancestors_without_requiring_source_counterparts() {
    let (root, mut overlay) = module_fixture(
        json!([opaque("Nested/Deep/**", "Nested/Deep"), rule("generated")]),
        r#"export default tracked({getattr({relativePath}) {
          return relativePath===""?{kind:"directory"}:relativePath==="generated"?{kind:"file",size:0}:undefined;}});"#,
    );
    for (path, mode) in [("generated", 0), ("Nested", 1), ("Nested/Deep", 1)] {
        overlay.access(path, mode).unwrap();
    }
    assert_errno(overlay.access("generated", 1), libc::EACCES);
    assert_errno(overlay.access("missing", 0), libc::ENOENT);
    assert_errno(overlay.access("Nested/Deep/missing", 0), libc::ENOENT);
    put(source(&root).join("source-only"), "");
    overlay.access("source-only", 4).unwrap();
}

#[test]
fn reports_real_source_and_proxy_storage_statistics_with_a_source_fallback_for_virtual_nodes() {
    let (root, mut overlay) = module_fixture(
        json!([
        {"match":"Proxy/**","root":"Proxy","provider":{"type":"directory","path":"proxy"}},
        opaque("Virtual/**","Virtual")]),
        "export default {};",
    );
    fs::create_dir(root.path().join("proxy")).unwrap();
    for (path, backing) in [
        ("/", source(&root)),
        ("Virtual", source(&root)),
        ("Proxy", root.path().join("proxy")),
    ] {
        let mut expected = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        syscall(unsafe { libc::statvfs(cpath(&backing).unwrap().as_ptr(), expected.as_mut_ptr()) })
            .unwrap();
        let expected = unsafe { expected.assume_init() };
        let actual = overlay.statfs(path).unwrap();
        assert_eq!(actual.f_bsize, expected.f_bsize);
        assert_eq!(actual.f_frsize, expected.f_frsize);
        assert_eq!(actual.f_blocks, expected.f_blocks);
        assert!(actual.f_files > 0);
    }
    fs::remove_dir_all(source(&root)).unwrap();
    assert_errno(overlay.statfs("/"), libc::ENOENT);
}

#[test]
fn adds_generated_files_to_matching_real_directories() {
    let (root, mut overlay) = module_fixture(
        json!([rule("components/*/AGENTS.md")]),
        r#"export default tracked({getattr({path}){if(path.endsWith("/AGENTS.md"))return {kind:"file",size:18};},
        readFile({path}){return `Instructions for ${path}`;}});"#,
    );
    fs::create_dir_all(source(&root).join("components/Button")).unwrap();
    assert!(names(&mut overlay, "components/Button").contains(&"AGENTS.md".into()));
    assert_eq!(
        overlay.read_all("components/Button/AGENTS.md").unwrap(),
        b"Instructions for components/Button/AGENTS.md"
    );
}
#[test]
fn adds_exact_root_level_provider_files_to_the_root_directory() {
    let (_root, mut overlay) = module_fixture(
        json!([rule("ProxiedFile.txt")]),
        r#"export default {getattr({path}){if(path==="ProxiedFile.txt")return {kind:"file",size:7};}};"#,
    );
    assert_eq!(names(&mut overlay, ""), ["ProxiedFile.txt"]);
}
fn literal_exact(pattern: &str, name: &str) {
    let module = format!(
        "export default tracked({{getattr({{path}}){{if(path==={})return {{kind:'file',size:1}};}},readFile(){{return 'X';}}}});",
        json!(name)
    );
    let (_root, mut overlay) = module_fixture(json!([rule(pattern)]), &module);
    assert_eq!(names(&mut overlay, ""), [name]);
    assert_eq!(metadata(&mut overlay, name).kind, Kind::File);
    assert_eq!(overlay.read_all(name).unwrap(), b"X");
}
#[test]
fn enumerates_the_literal_exact_rule_hello_world_txt() {
    literal_exact("hello+world.txt", "hello+world.txt");
}
#[test]
fn enumerates_the_literal_exact_rule_user_example_txt() {
    literal_exact("user@example.txt", "user@example.txt");
}
#[test]
fn enumerates_the_literal_exact_rule_wow_txt() {
    literal_exact("wow!.txt", "wow!.txt");
}
#[test]
fn enumerates_the_literal_exact_rule_literal_tag_txt() {
    literal_exact("literal{tag}.txt", "literal{tag}.txt");
}
#[test]
fn enumerates_the_literal_exact_rule_escaped_txt() {
    literal_exact(r"escaped\*.txt", "escaped*.txt");
}
#[test]
fn enumerates_the_literal_exact_rule_back_slash_txt() {
    literal_exact(r"back\\slash.txt", r"back\slash.txt");
}
fn literal_root(root: &str) {
    let (_root, mut overlay) = module_fixture(
        json!([{"match":format!("{root}/**"),"opaque":true,"provider":{"module":"default"}}]),
        r#"export default tracked({getattr({relativePath}){return relativePath===""?{kind:"directory"}:relativePath==="data.txt"?{kind:"file",size:1}:undefined;},
        readdir({relativePath}){if(relativePath==="")return ["data.txt"];},
        readFile({relativePath}){if(relativePath!=="data.txt")throw Error("relativePath");return "X";}});"#,
    );
    assert_eq!(names(&mut overlay, ""), [root]);
    assert_eq!(names(&mut overlay, root), ["data.txt"]);
    assert_eq!(overlay.read_all(&format!("{root}/data.txt")).unwrap(), b"X");
}
#[test]
fn exposes_a_generated_root_and_correct_relative_paths_for_cpp() {
    literal_root("C++");
}
#[test]
fn exposes_a_generated_root_and_correct_relative_paths_for_team_host() {
    literal_root("team@host");
}
#[test]
fn exposes_a_generated_root_and_correct_relative_paths_for_wow() {
    literal_root("wow!");
}
#[test]
fn exposes_a_generated_root_and_correct_relative_paths_for_literal_tag() {
    literal_root("literal{tag}");
}

#[test]
fn uses_source_backing_consistently_when_an_additive_module_declines_a_path() {
    let (root, mut overlay) = module_fixture(
        json!([{"match":"Mixed/**","root":"Mixed","provider":{"module":"default"}}]),
        r#"export default tracked({getattr({relativePath}){if(relativePath==="generated.txt")return {kind:"file",size:9};},
        readdir({relativePath}){if(!relativePath)return ["generated.txt"];},
        readFile({relativePath}){if(relativePath!=="generated.txt")fail("ENOENT");return "GENERATED";},writeFile(){}});"#,
    );
    fs::create_dir_all(source(&root).join("Mixed/native")).unwrap();
    put(source(&root).join("Mixed/source.txt"), "SOURCE");
    assert_eq!(
        sorted_names(&mut overlay, "Mixed"),
        ["generated.txt", "native", "source.txt"]
    );
    assert_eq!(
        overlay.read_all("Mixed/generated.txt").unwrap(),
        b"GENERATED"
    );
    let reads = calls(&root, "readFile").len();
    assert_eq!(overlay.read_all("Mixed/source.txt").unwrap(), b"SOURCE");
    overlay
        .write_file("Mixed/source.txt", b"UPDATED", None, false)
        .unwrap();
    let handle = overlay
        .open("Mixed/source.txt", libc::O_RDWR, None, false)
        .unwrap();
    assert!(handle.native.is_some());
    assert!(handle.binding.is_none());
    overlay
        .rename("Mixed/source.txt", "Mixed/renamed.txt")
        .unwrap();
    overlay
        .truncate("Mixed/renamed.txt", 3, Some(&handle))
        .unwrap();
    assert_eq!(
        overlay
            .read_chunk("Mixed/renamed.txt", 0, 3, &handle)
            .unwrap()
            .unwrap(),
        b"UPD"
    );
    overlay.release("Mixed/renamed.txt", handle).unwrap();
    overlay
        .setattr("Mixed/renamed.txt", &json!({"mode":0o600}), None, false)
        .unwrap();
    assert_eq!(
        fs::metadata(source(&root).join("Mixed/renamed.txt"))
            .unwrap()
            .mode()
            & 0o777,
        0o600
    );
    overlay.remove("Mixed/renamed.txt", false).unwrap();
    let handle = overlay
        .open("Mixed/native/created.txt", libc::O_RDWR, Some(0o644), false)
        .unwrap();
    overlay.release("Mixed/native/created.txt", handle).unwrap();
    assert_eq!(
        fs::read(source(&root).join("Mixed/native/created.txt")).unwrap(),
        b""
    );
    overlay
        .mkdir("Mixed/native/created-directory", 0o755)
        .unwrap();
    overlay
        .remove("Mixed/native/created-directory", true)
        .unwrap();
    assert_eq!(calls(&root, "readFile").len(), reads);
    assert!(calls(&root, "writeFile").is_empty());
}

#[test]
fn preserves_content_only_overlays_and_creation_of_exact_generated_entries() {
    let (root, mut overlay) = module_fixture(
        json!([
        {"match":"existing.txt","provider":{"module":"content"}},
        {"match":"created.txt","root":"","provider":{"module":"default"}}]),
        r#"export const content={readFile(){return "OVERRIDE";}};
        const contents=new Map(); export default tracked({
        getattr({path}){if(contents.has(path))return {kind:"file",size:contents.get(path).length};},
        readFile({path}){return contents.get(path)??Buffer.alloc(0);},
        writeFile(bytes,{path}){contents.set(path,Buffer.from(bytes));}});"#,
    );
    put(source(&root).join("existing.txt"), "SOURCE");
    assert_eq!(overlay.read_all("existing.txt").unwrap(), b"OVERRIDE");
    let handle = overlay
        .open("created.txt", libc::O_RDWR, Some(0o644), false)
        .unwrap();
    overlay.release("created.txt", handle).unwrap();
    assert_eq!(overlay.read_all("created.txt").unwrap(), b"");
    assert_eq!(calls(&root, "writeFile")[0]["args"], json!([""]));
    assert!(!source(&root).join("created.txt").exists());
}
fn content_size(contents: &str, resource: bool) {
    let module = format!(
        r#"export default tracked({{readFile(){{return "generated é";}},{} }});"#,
        if resource {
            "open(){return {marker:'resource'};}"
        } else {
            ""
        }
    );
    let (root, mut overlay) = module_fixture(json!([rule("data")]), &module);
    put(source(&root).join("data"), contents);
    let native =
        native_metadata(&fs::symlink_metadata(source(&root).join("data")).unwrap()).unwrap();
    let opened = metadata(&mut overlay, "data");
    let expected_identity = format!("{}:rule:0", native.identity.unwrap());
    assert_eq!(opened.size, Some("generated é".len() as u64));
    assert_eq!(opened.size_mode.as_deref(), Some("content"));
    assert_eq!(opened.seekable, Some(true));
    assert_eq!(opened.identity.as_deref(), Some(expected_identity.as_str()));
    assert_eq!(opened.mode, native.mode);
    assert_eq!(opened.uid, native.uid);
    assert_eq!(opened.gid, native.gid);
    assert_eq!(
        opened.mtime.as_ref().unwrap().millis,
        native.mtime.unwrap().millis
    );
    let entries = overlay.readdir("").unwrap().unwrap();
    assert_eq!(entries[0].0, "data");
    assert_eq!(entries[0].1.size, opened.size);
    let handle = overlay.open("data", libc::O_RDONLY, None, false).unwrap();
    assert_eq!(handle.value.is_some(), resource);
    let descriptor = overlay.fgetattr("data", &handle, &opened).unwrap().unwrap();
    assert_eq!(descriptor.identity, opened.identity);
    assert_eq!(descriptor.size, opened.size);
    assert_eq!(
        overlay.read_file("data", &handle, &opened).unwrap(),
        "generated é".as_bytes()
    );
    overlay.release("data", handle).unwrap();
}
#[test]
fn sizes_content_only_overlays_independently_of_source_resource_false() {
    content_size("", false);
}
#[test]
fn sizes_content_only_overlays_independently_of_source_resource_true() {
    content_size("", true);
}
#[test]
fn sizes_content_only_overlays_independently_of_source_x_resource_false() {
    content_size("x", false);
}
#[test]
fn sizes_content_only_overlays_independently_of_source_x_resource_true() {
    content_size("x", true);
}
#[test]
fn sizes_content_only_overlays_independently_of_source_source_contents_longer_than_the_gener_resource_false()
 {
    content_size("source contents longer than the generated file", false);
}
#[test]
fn sizes_content_only_overlays_independently_of_source_source_contents_longer_than_the_gener_resource_true()
 {
    content_size("source contents longer than the generated file", true);
}
fn content_defaults(file: Value, size: u64, size_mode: &str, reads: usize) {
    let seekable = file["seekable"].as_bool().unwrap_or(true);
    let mut file = file;
    file["mode"] = json!(0o600);
    let (root, mut overlay) = module_fixture(
        json!([{"match":"data","file":file,"provider":{"module":"default"}}]),
        r#"export default tracked({readFile(){return "GENERATED";}});"#,
    );
    put(source(&root).join("data"), "x");
    let m = metadata(&mut overlay, "data");
    assert_eq!(m.size, Some(size));
    assert_eq!(m.size_mode.as_deref(), Some(size_mode));
    assert_eq!(m.mode, Some(0o600));
    assert_eq!(m.seekable, Some(seekable));
    assert_eq!(calls(&root, "readFile").len(), reads);
}
#[test]
fn applies_content_only_file_defaults_size_3() {
    content_defaults(json!({"size":3}), 3, "explicit", 0);
}
#[test]
fn applies_content_only_file_defaults_sizemode_content() {
    content_defaults(json!({"sizeMode":"content"}), 9, "content", 1);
}
#[test]
fn applies_content_only_file_defaults_sizemode_zero_seekable_false() {
    content_defaults(json!({"sizeMode":"zero","seekable":false}), 0, "zero", 0);
}
#[test]
fn applies_content_only_file_defaults_sizemode_unbounded() {
    content_defaults(
        json!({"sizeMode":"unbounded"}),
        0x7fffffffffff,
        "unbounded",
        0,
    );
}
#[test]
fn applies_content_only_file_defaults_sizemode_unbounded_size_123() {
    content_defaults(
        json!({"sizeMode":"unbounded","size":123}),
        123,
        "unbounded",
        0,
    );
}
#[test]
fn applies_content_only_file_defaults_sizemode_explicit_size_0() {
    content_defaults(json!({"sizeMode":"explicit","size":0}), 0, "explicit", 0);
}
#[test]
fn applies_positional_file_defaults_without_inheriting_the_source_size_for_unbounded_files() {
    let (root, mut overlay) = module_fixture(
        json!([{"match":"data","file":{"sizeMode":"unbounded","seekable":false},"provider":{"module":"default"}}]),
        r#"export default tracked({read(){return "generated";}});"#,
    );
    put(source(&root).join("data"), "x");
    let m = metadata(&mut overlay, "data");
    assert_eq!(m.size, Some(0x7fffffffffff));
    assert_eq!(m.size_mode.as_deref(), Some("unbounded"));
    assert_eq!(m.seekable, Some(false));
    assert!(calls(&root, "read").is_empty());
}
#[test]
fn preserves_native_sizes_for_lifecycle_only_hooks_and_source_fallback() {
    for module in [
        r#"export default tracked({open(){return {};}});"#,
        r#"export default tracked({getattr(){},readFile(){throw Error("must not read");}});"#,
    ] {
        let (root, mut overlay) = module_fixture(json!([rule("data")]), module);
        put(source(&root).join("data"), "SOURCE");
        let m = metadata(&mut overlay, "data");
        assert_eq!(m.size, Some(6));
        assert_eq!(m.size_mode.as_deref(), Some("explicit"));
        let h = overlay.open("data", libc::O_RDONLY, None, false).unwrap();
        assert!(h.native.is_some());
        let m = overlay.fgetattr("data", &h, &m).unwrap().unwrap();
        assert_eq!(m.size, Some(6));
        assert_eq!(m.size_mode.as_deref(), Some("explicit"));
        overlay.release("data", h).unwrap();
        assert!(calls(&root, "readFile").is_empty());
    }
}
#[test]
fn does_not_derive_content_only_metadata_for_directories_symlinks_or_missing_paths() {
    let (root, mut overlay) = module_fixture(
        json!([{"match":"**","file":{"size":123},"provider":{"module":"default"}}]),
        r#"export default tracked({readFile(){throw Error("must not read");}});"#,
    );
    fs::create_dir(source(&root).join("directory")).unwrap();
    std::os::unix::fs::symlink("directory", source(&root).join("link")).unwrap();
    assert_eq!(metadata(&mut overlay, "directory").kind, Kind::Directory);
    assert_eq!(metadata(&mut overlay, "link").kind, Kind::Symlink);
    assert!(overlay.getattr("missing", None).unwrap().is_none());
    assert!(calls(&root, "readFile").is_empty());
}
fn content_error(code: &str, errno: i32) {
    let (root, mut overlay) = module_fixture(
        json!([rule("data")]),
        &format!(
            "export default tracked({{readFile(){{fail({});}}}});",
            json!(code)
        ),
    );
    put(source(&root).join("data"), "SOURCE");
    assert_errno(overlay.getattr("data", None), errno);
}
#[test]
fn propagates_content_only_size_calculation_errors_enoent() {
    content_error("ENOENT", libc::ENOENT);
}
#[test]
fn propagates_content_only_size_calculation_errors_eio() {
    content_error("EIO", libc::EIO);
}
#[test]
fn keeps_earlier_directory_providers_superseded_when_the_winning_module_uses_source_backing() {
    let (root, mut overlay) = module_fixture(
        json!([
        {"match":"Mixed/**","root":"Mixed","provider":{"module":"old"}},
        {"match":"Mixed/**","root":"Mixed","provider":{"module":"default"}}]),
        r#"export const old=tracked({readdir(){throw Error("superseded");}});
        export default tracked({getattr({relativePath}){if(relativePath==="generated.txt")return {kind:"file",size:0};},
          readdir(){return ["generated.txt"];}});"#,
    );
    put(source(&root).join("Mixed/source.txt"), "SOURCE");
    assert_eq!(
        sorted_names(&mut overlay, "Mixed"),
        ["generated.txt", "source.txt"]
    );
    assert_eq!(calls(&root, "readdir").len(), 1);
}
#[test]
fn does_not_fall_back_to_source_contents_when_module_lookup_fails() {
    let (root, mut overlay) = module_fixture(
        json!([rule("data")]),
        r#"export default tracked({getattr(){fail("EACCES","Lookup failed");},readFile(){return "GENERATED";}});"#,
    );
    put(source(&root).join("data"), "SOURCE");
    assert_errno(overlay.read_all("data"), libc::EACCES);
    assert!(calls(&root, "readFile").is_empty());
}
fn exact_not_called(hidden: bool) {
    let mut rules = vec![json!({"match":"data","provider":{"module":"old"}})];
    rules.push(if hidden {
        json!({"match":"data","hide":true})
    } else {
        rule("data")
    });
    let (root, mut overlay) = module_fixture(
        json!(rules),
        r#"export const old=tracked({getattr(){fail("EIO","superseded");}});
        export default tracked({getattr(){return {kind:"file",size:3};},readFile(){return "NEW";}});"#,
    );
    put(source(&root).join("unrelated"), "source");
    assert_eq!(
        sorted_names(&mut overlay, ""),
        if hidden {
            vec!["unrelated"]
        } else {
            vec!["data", "unrelated"]
        }
    );
    assert!(trace(&root).iter().all(|e| e["op"] != "getattr" || !hidden));
    if !hidden {
        assert_eq!(overlay.read_all("data").unwrap(), b"NEW");
    }
}
#[test]
fn does_not_call_a_hidden_exact_entry_metadata_provider_during_enumeration() {
    exact_not_called(true);
}
#[test]
fn does_not_call_a_superseded_exact_entry_metadata_provider_during_enumeration() {
    exact_not_called(false);
}
#[test]
fn propagates_errors_from_the_winning_exact_entry_metadata_provider() {
    let (_root, mut overlay) = module_fixture(
        json!([rule("data")]),
        r#"export default tracked({getattr(){fail("EACCES","lookup denied");}});"#,
    );
    assert_errno(overlay.readdir(""), libc::EACCES);
}

#[test]
fn provides_a_fully_generated_writable_subtree() {
    let (root, mut overlay) = module_fixture(
        json!([opaque("GeneratedCatalog/**", "GeneratedCatalog")]),
        r#"
      const tree=new Map([["",["Pinned","Datasets","AGENTS.md"]],["Pinned",[]],["Datasets",["Batch1"]],
      ["Datasets/Batch1",["Record1","Record2"]],["Datasets/Batch1/Record1",["data.txt","action.txt"]],
      ["Datasets/Batch1/Record2",["data.txt","action.txt"]]]);
      export default tracked({getattr({relativePath:p}){if(tree.has(p))return {kind:"directory"};
        if(p==="AGENTS.md"||p.endsWith("/data.txt")||p.endsWith("/action.txt"))return {kind:"file"};},
      readdir({relativePath}){return tree.get(relativePath);},
      readFile({relativePath}){return relativePath==="AGENTS.md"?"Write to action.txt to trigger an operation.":`Data for ${relativePath}`;},
      writeFile(bytes,{relativePath}){if(relativePath!=="Datasets/Batch1/Record2/action.txt"||bytes.toString()!=="run")throw Error("write arguments");}});
    "#,
    );
    assert_eq!(names(&mut overlay, ""), ["GeneratedCatalog"]);
    assert_eq!(
        names(&mut overlay, "GeneratedCatalog/Datasets/Batch1/Record2"),
        ["data.txt", "action.txt"]
    );
    assert_eq!(
        overlay
            .read_all("GeneratedCatalog/Datasets/Batch1/Record2/data.txt")
            .unwrap(),
        b"Data for Datasets/Batch1/Record2/data.txt"
    );
    overlay
        .write_file(
            "GeneratedCatalog/Datasets/Batch1/Record2/action.txt",
            b"run",
            None,
            false,
        )
        .unwrap();
    let writes = calls(&root, "writeFile");
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0]["context"]["relativePath"],
        "Datasets/Batch1/Record2/action.txt"
    );
    assert_eq!(writes[0]["args"], json!(["run"]));
}
#[test]
fn hides_matching_source_files_while_preserving_passthrough_files() {
    let (root, mut overlay) = fixture(json!([{"match":"secret.txt","hide":true}]), None);
    put(source(&root).join("secret.txt"), "secret");
    put(source(&root).join("visible.txt"), "visible");
    assert_eq!(names(&mut overlay, ""), ["visible.txt"]);
    assert_eq!(overlay.read_all("visible.txt").unwrap(), b"visible");
    assert_errno(overlay.read_all("secret.txt"), libc::ENOENT);
}
#[test]
fn passes_ordinary_writes_through_to_the_source() {
    let (root, mut overlay) = fixture(json!([]), None);
    overlay
        .write_file("created.txt", b"created", None, false)
        .unwrap();
    assert_eq!(
        fs::read(source(&root).join("created.txt")).unwrap(),
        b"created"
    );
}
fn creation_permissions(mode: u32) {
    let (root, mut overlay) = module_fixture(
        json!([opaque("Generated/**", "Generated")]),
        r#"export default tracked({create(){}});"#,
    );
    let h = overlay
        .open("source.txt", libc::O_RDWR, Some(mode), false)
        .unwrap();
    overlay.release("source.txt", h).unwrap();
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(source(&root).join("reference.txt"))
        .unwrap();
    let h = overlay
        .open(
            "Generated/provider.txt",
            libc::O_RDWR,
            Some(0o100000 | mode),
            false,
        )
        .unwrap();
    overlay.release("Generated/provider.txt", h).unwrap();
    assert_eq!(
        fs::metadata(source(&root).join("source.txt"))
            .unwrap()
            .mode()
            & 0o777,
        fs::metadata(source(&root).join("reference.txt"))
            .unwrap()
            .mode()
            & 0o777
    );
    let c = calls(&root, "create");
    assert_eq!(c.len(), 1);
    assert_eq!(c[0]["args"][0]["kind"], "file");
    assert_eq!(c[0]["args"][0]["mode"], mode);
}
#[test]
fn preserves_caller_permissions_when_creating_regular_files_with_mode_420() {
    creation_permissions(0o644);
}
#[test]
fn preserves_caller_permissions_when_creating_regular_files_with_mode_493() {
    creation_permissions(0o755);
}
#[test]
fn preserves_caller_permissions_when_creating_regular_files_with_mode_511() {
    creation_permissions(0o777);
}
#[test]
fn preserves_execute_bits_when_creating_directories() {
    let (root, mut overlay) = module_fixture(
        json!([{"match":"Generated/**","root":"Generated","provider":{"module":"default"}}]),
        r#"export default tracked({mkdir(){}});"#,
    );
    overlay.mkdir("source-directory", 0o777).unwrap();
    overlay
        .mkdir("Generated/provider-directory", 0o777)
        .unwrap();
    assert_ne!(
        fs::metadata(source(&root).join("source-directory"))
            .unwrap()
            .mode()
            & 0o111,
        0
    );
    let c = calls(&root, "mkdir");
    assert_eq!(c.len(), 1);
    assert_eq!(c[0]["args"], json!([{"kind":"directory","mode":0o777}]));
}
#[test]
fn does_not_list_source_children_of_an_opaque_provider_directory() {
    let (root, mut overlay) = module_fixture(
        json!([opaque("Generated/**", "Generated")]),
        r#"export default {getattr({relativePath}){if(!relativePath)return {kind:"directory"};},readdir(){return [];}};"#,
    );
    put(source(&root).join("Generated/source-only"), "source");
    assert!(names(&mut overlay, "Generated").is_empty());
    assert!(
        overlay
            .getattr("Generated/source-only", None)
            .unwrap()
            .is_none()
    );
}
#[test]
fn synthesizes_traversable_ancestors_for_nested_generated_roots() {
    let (_root, mut overlay) = module_fixture(
        json!([opaque("Generated/Nested/**", "Generated/Nested")]),
        r#"export default {getattr({relativePath}){return relativePath?{kind:"file",size:5}:{kind:"directory"};},
        readdir({relativePath}){if(!relativePath)return ["value"];},readFile(){return "value";}};"#,
    );
    assert_eq!(metadata(&mut overlay, "Generated").kind, Kind::Directory);
    assert_eq!(names(&mut overlay, "Generated"), ["Nested"]);
    assert_eq!(
        overlay.read_all("Generated/Nested/value").unwrap(),
        b"value"
    );
}
fn inferred_root(pattern: &str) {
    let (root, mut overlay) = module_fixture(
        json!([{"match":pattern,"opaque":true,"provider":{"module":"default"}}]),
        r#"export default {getattr({relativePath}){return relativePath?{kind:"file",size:4}:{kind:"directory"};},
        readdir({relativePath}){if(!relativePath)return ["data.txt"];},readFile(){return "data";}};"#,
    );
    put(source(&root).join("source-only"), "source");
    let directory = pattern.rsplit_once('/').unwrap().0;
    assert_eq!(metadata(&mut overlay, directory).kind, Kind::Directory);
    overlay.access(directory, 1).unwrap();
    assert_eq!(names(&mut overlay, directory), ["data.txt"]);
    assert_eq!(
        overlay.read_all(&format!("{directory}/data.txt")).unwrap(),
        b"data"
    );
    assert_eq!(
        sorted_names(&mut overlay, ""),
        [directory.split('/').next().unwrap(), "source-only"]
    );
}
#[test]
fn exposes_the_inferred_opaque_root_for_generated_txt_without_hiding_source_siblings() {
    inferred_root("Generated/*.txt");
}
#[test]
fn exposes_the_inferred_opaque_root_for_generated_data_txt_without_hiding_source_siblings() {
    inferred_root("Generated/data.txt");
}
#[test]
fn exposes_the_inferred_opaque_root_for_nested_generated_txt_without_hiding_source_siblings() {
    inferred_root("Nested/Generated/*.txt");
}
#[test]
fn does_not_claim_the_mount_root_for_an_opaque_root_level_file() {
    let (root, mut overlay) = module_fixture(
        json!([{"match":"data.txt","opaque":true,"provider":{"module":"default"}}]),
        r#"export default {getattr(){return {kind:"file",size:4};},readFile(){return "data";}};"#,
    );
    put(source(&root).join("source-only"), "source");
    assert_eq!(sorted_names(&mut overlay, ""), ["data.txt", "source-only"]);
}
#[test]
fn does_not_replace_existing_source_directories_with_inferred_opaque_roots() {
    let (root, mut overlay) = module_fixture(
        json!([{"match":"Generated/data.txt","opaque":true,"provider":{"module":"default"}}]),
        r#"export default {getattr({relativePath}){return relativePath?{kind:"file",size:4}:{kind:"directory"};},readFile(){return "data";}};"#,
    );
    put(source(&root).join("Generated/source-only"), "source");
    assert_eq!(
        metadata(&mut overlay, "Generated").identity,
        Some(native_identity(&source(&root).join("Generated")))
    );
    assert_eq!(
        sorted_names(&mut overlay, "Generated"),
        ["data.txt", "source-only"]
    );
}
fn native_directory_ancestor(proxy: bool) {
    let mut rules = vec![];
    if proxy {
        rules.push(json!({"match":"Proxy/**","root":"Proxy","provider":{"type":"directory","path":"proxy"}}));
    }
    let directory = if proxy { "Proxy/Existing" } else { "Existing" };
    rules.push(opaque(
        &format!("{directory}/Generated/**"),
        &format!("{directory}/Generated"),
    ));
    let (root, mut overlay) = module_fixture(
        json!(rules),
        r#"export default {getattr(){return {kind:"directory"};}};"#,
    );
    let target = if proxy {
        root.path().join("proxy")
    } else {
        source(&root)
    };
    fs::create_dir_all(target.join("Existing")).unwrap();
    fs::set_permissions(target.join("Existing"), fs::Permissions::from_mode(0o750)).unwrap();
    put(target.join("Existing/source-only"), "source");
    let identity = native_identity(&target.join("Existing"));
    let m = metadata(&mut overlay, directory);
    assert_eq!(m.kind, Kind::Directory);
    assert_eq!(m.mode, Some(0o750));
    assert_eq!(m.identity, Some(identity.clone()));
    let h = overlay.open(directory, libc::O_RDONLY, None, true).unwrap();
    let m = overlay.fgetattr(directory, &h, &m).unwrap().unwrap();
    assert_eq!(m.identity, Some(identity));
    assert_eq!(m.mode, Some(0o750));
    assert_eq!(
        sorted_names(&mut overlay, directory),
        ["Generated", "source-only"]
    );
    overlay.release(directory, h).unwrap();
}
#[test]
fn preserves_native_source_directory_identity_beneath_a_generated_root() {
    native_directory_ancestor(false);
}
#[test]
fn preserves_native_proxy_directory_identity_beneath_a_generated_root() {
    native_directory_ancestor(true);
}
#[test]
fn does_not_borrow_native_identity_for_generated_ancestors_inside_an_opaque_module() {
    let (root, mut overlay) = module_fixture(
        json!([
            opaque("Tree/**", "Tree"),
            opaque("Tree/Nested/**", "Tree/Nested")
        ]),
        r#"export default {getattr(){return {kind:"directory"};},readdir(){return [];}};"#,
    );
    put(source(&root).join("Tree/hidden-source"), "hidden");
    let m = metadata(&mut overlay, "Tree");
    assert!(m.identity.is_none());
    let h = overlay.open("Tree", libc::O_RDONLY, None, true).unwrap();
    assert!(h.native.is_none());
    assert!(
        overlay
            .fgetattr("Tree", &h, &m)
            .unwrap()
            .unwrap()
            .identity
            .is_none()
    );
    assert_eq!(names(&mut overlay, "Tree"), ["Nested"]);
    overlay.release("Tree", h).unwrap();
}
#[test]
fn omits_a_generated_root_overridden_by_a_later_opaque_directory() {
    let (_root, mut overlay) = module_fixture(
        json!([
            opaque("Tree/Nested/**", "Tree/Nested"),
            opaque("Tree/**", "Tree")
        ]),
        r#"export default {getattr({relativePath}){if(!relativePath)return {kind:"directory"};},readdir(){return [];}};"#,
    );
    assert!(names(&mut overlay, "Tree").is_empty());
    assert!(overlay.getattr("Tree/Nested", None).unwrap().is_none());
}
#[test]
fn hides_generated_exact_entries_and_generated_roots_from_listings() {
    let (_root, mut overlay) = module_fixture(
        json!([rule("secret"),opaque("Tree/**","Tree"),
        {"match":"secret","hide":true},{"match":"Tree","hide":true}]),
        r#"export default {getattr({path}){return {kind:path==="secret"?"file":"directory"};}};"#,
    );
    assert!(names(&mut overlay, "").is_empty());
    assert!(overlay.readdir("Tree").unwrap().is_none());
}
#[test]
fn uses_the_winning_provider_for_overlapping_directory_listings() {
    let (_root, mut overlay) = module_fixture(
        json!([
        {"match":"Tree/**","root":"Tree","provider":{"module":"first"}},
        {"match":"Tree/**","root":"Tree","opaque":true,"provider":{"module":"default"}}]),
        r#"export const first={getattr(){return {kind:"directory"};},readdir(){return ["first"];}};
        export default {getattr(){return {kind:"directory"};},readdir(){return ["second"];}};"#,
    );
    assert_eq!(names(&mut overlay, "Tree"), ["second"]);
}
fn wildcard_contribution(opaque: bool) {
    let (root, mut overlay) = module_fixture(
        json!([
        {"match":"Tree/**","root":"Tree","provider":{"module":"old"}},
        {"match":"Tree/**","root":"Tree","opaque":opaque,"provider":{"module":"base"}},
        {"match":"Tree/*.json","provider":{"module":"extra"}},
        {"match":"Tree/hidden.json","hide":true},
        {"match":"Tree/masked.json","opaque":true,"provider":{"module":"default"}}]),
        r#"
        export const old=tracked({readdir(){throw Error("superseded");}});
        export const base=tracked({getattr({relativePath}){return {kind:relativePath?"file":"directory",size:4};},readdir(){return ["base.txt"];}});
        export const extra=tracked({getattr(){return {kind:"file",size:2};},readdir(){return ["extra.json","hidden.json","masked.json","unmatched.txt"];},readFile(){return "{}";}});
        export default {};
    "#,
    );
    assert_eq!(
        sorted_names(&mut overlay, "Tree"),
        ["base.txt", "extra.json"]
    );
    assert_eq!(overlay.read_all("Tree/extra.json").unwrap(), b"{}");
    assert_eq!(calls(&root, "readdir").len(), 2);
}
#[test]
fn enumerates_later_wildcard_contributions_to_a_provider_directory_opaque_false() {
    wildcard_contribution(false);
}
#[test]
fn enumerates_later_wildcard_contributions_to_a_provider_directory_opaque_true() {
    wildcard_contribution(true);
}
#[test]
fn falls_back_to_creating_source_files_for_a_nonopaque_provider_without_write_operations() {
    let (root, mut overlay) = module_fixture(json!([rule("**/*.txt")]), "export default {};");
    let h = overlay
        .open("empty.txt", libc::O_RDWR, Some(0o644), false)
        .unwrap();
    overlay.release("empty.txt", h).unwrap();
    assert_eq!(
        fs::metadata(source(&root).join("empty.txt")).unwrap().len(),
        0
    );
    assert_errno(
        overlay.open("empty.txt", libc::O_RDWR, Some(0o644), false),
        libc::EEXIST,
    );
}
#[test]
fn retains_a_source_file_when_its_provider_open_hook_rejects_during_create() {
    let (root, mut overlay) = module_fixture(
        json!([rule("**/*.txt")]),
        r#"export default tracked({open(){throw Error("open hook failed");}});"#,
    );
    let error = overlay
        .open("failed.txt", libc::O_RDWR, Some(0o644), false)
        .err()
        .unwrap();
    assert!(error.to_string().contains("open hook failed"));
    assert_eq!(fs::read(source(&root).join("failed.txt")).unwrap(), b"");
}
#[test]
fn rejects_unsupported_creates_for_opaque_providers() {
    let (_root, mut overlay) = module_fixture(json!([opaque("**", "")]), "export default {};");
    assert_errno(
        overlay.open("empty", libc::O_RDWR, Some(0o644), false),
        libc::EROFS,
    );
}
#[test]
fn rejects_cross_provider_rename_without_changing_either_backing_file() {
    let (root, mut overlay) = fixture(
        json!([{"match":"config","provider":{"type":"file","path":"target"}}]),
        None,
    );
    put(root.path().join("target"), "old");
    put(source(&root).join("temporary"), "new");
    assert_errno(overlay.rename("temporary", "config"), libc::EXDEV);
    assert_errno(overlay.rename("config", "elsewhere"), libc::EXDEV);
    assert_errno(overlay.remove("config", false), libc::EROFS);
    assert_eq!(fs::read(source(&root).join("temporary")).unwrap(), b"new");
    assert_eq!(overlay.read_all("config").unwrap(), b"old");
}
fn fixed_proxy_retention(opaque: bool) {
    let (root, mut overlay) = fixture(
        json!([{"match":"Proxy","opaque":opaque,"provider":{"type":"file","path":"proxy/target"}}]),
        None,
    );
    put(root.path().join("proxy/target"), "original");
    put(root.path().join("proxy/actual"), "intended");
    put(source(&root).join("actual"), "unrelated");
    let h = overlay.open("Proxy", libc::O_RDWR, None, false).unwrap();
    std::os::unix::fs::symlink("actual", root.path().join("proxy/replacement")).unwrap();
    fs::rename(
        root.path().join("proxy/replacement"),
        root.path().join("proxy/target"),
    )
    .unwrap();
    assert_errno(overlay.getattr("Proxy", None), libc::EOPNOTSUPP);
    assert!(!names(&mut overlay, "").contains(&"Proxy".into()));
    assert!(overlay.open("Proxy", libc::O_RDWR, None, false).is_err());
    overlay.write_chunk("Proxy", b"X", 0, &h).unwrap();
    assert_eq!(
        overlay.read_chunk("Proxy", 0, 8, &h).unwrap().unwrap(),
        b"Xriginal"
    );
    assert_eq!(
        fs::read(source(&root).join("actual")).unwrap(),
        b"unrelated"
    );
    assert_eq!(
        fs::read(root.path().join("proxy/actual")).unwrap(),
        b"intended"
    );
    put(root.path().join("proxy/regular"), "restored");
    fs::rename(
        root.path().join("proxy/regular"),
        root.path().join("proxy/target"),
    )
    .unwrap();
    assert_eq!(overlay.read_all("Proxy").unwrap(), b"restored");
    overlay.release("Proxy", h).unwrap();
}
#[test]
fn rejects_file_proxy_symlink_replacements_without_redirecting_retained_handles_opaque_false() {
    fixed_proxy_retention(false);
}
#[test]
fn rejects_file_proxy_symlink_replacements_without_redirecting_retained_handles_opaque_true() {
    fixed_proxy_retention(true);
}
#[test]
fn allows_renames_within_a_directory_proxy_and_follows_host_file_replacement() {
    let (root, mut overlay) = fixture(
        json!([{"match":"Proxy/**","root":"Proxy","opaque":true,"provider":{"type":"directory","path":"proxy"}}]),
        None,
    );
    put(root.path().join("proxy/old"), "value");
    overlay.rename("Proxy/old", "Proxy/new").unwrap();
    assert_eq!(overlay.read_all("Proxy/new").unwrap(), b"value");
    put(root.path().join("proxy/replacement"), "replacement");
    fs::rename(
        root.path().join("proxy/replacement"),
        root.path().join("proxy/new"),
    )
    .unwrap();
    assert_eq!(overlay.read_all("Proxy/new").unwrap(), b"replacement");
    assert!(overlay.getattr("Proxy/old", None).unwrap().is_none());
}
#[test]
fn reads_source_directory_proxy_and_generated_symlink_targets() {
    let (root, mut overlay) = module_fixture(
        json!([{"match":"Proxy/**","root":"Proxy","provider":{"type":"directory","path":"source"}},rule("Generated")]),
        r#"export default {getattr(){return {kind:"symlink",target:"file"};}};"#,
    );
    put(source(&root).join("file"), "value");
    std::os::unix::fs::symlink("file", source(&root).join("link")).unwrap();
    for path in ["link", "Proxy/link", "Generated"] {
        assert_eq!(overlay.readlink(path).unwrap(), "file");
    }
}
#[test]
fn rejects_hidden_mutations_and_writable_opens_on_a_read_only_filesystem() {
    let (root, mut overlay) = fixture(json!([{"match":"secret","hide":true}]), None);
    put(source(&root).join("secret"), "secret");
    assert_errno(overlay.remove("secret", false), libc::ENOENT);
    assert_errno(
        overlay.open("secret", libc::O_RDWR, Some(0o644), false),
        libc::ENOENT,
    );
    assert_errno(overlay.rename("secret", "visible"), libc::ENOENT);
    overlay.config.read_only = true;
    overlay.config.rules.clear();
    let config = Filesystem {
        rules: vec![],
        ..overlay.config.clone()
    };
    let mut readonly = Overlay::new(config, Arc::new(Worker::start().unwrap())).unwrap();
    assert_errno(
        readonly.open("secret", libc::O_RDWR, None, false),
        libc::EROFS,
    );
    assert_errno(readonly.access("secret", 2), libc::EROFS);
    assert_eq!(fs::read(source(&root).join("secret")).unwrap(), b"secret");
}

fn merged_proxy() -> (tempfile::TempDir, Overlay) {
    let (root, overlay) = fixture(
        json!([{"match":"Proxy/**","root":"Proxy","provider":{"type":"directory","path":"proxy"}}]),
        None,
    );
    fs::create_dir(root.path().join("proxy")).unwrap();
    fs::create_dir(source(&root).join("Proxy")).unwrap();
    (root, overlay)
}
#[test]
fn uses_the_existing_backing_for_every_nonopaque_directory_proxy_child() {
    let (root, mut overlay) = merged_proxy();
    let base = source(&root).join("Proxy");
    let target = root.path().join("proxy");
    for (path, text) in [
        (base.join("source-only"), "SOURCE"),
        (base.join("overlap"), "SOURCE overlap"),
        (target.join("proxy-only"), "PROXY"),
        (target.join("overlap"), "PROXY overlap"),
    ] {
        put(path, text);
    }
    assert_eq!(
        sorted_names(&mut overlay, "Proxy"),
        ["overlap", "proxy-only", "source-only"]
    );
    for (name, expected, backing) in [
        ("source-only", "SOURCE", &base),
        ("proxy-only", "PROXY", &target),
        ("overlap", "PROXY overlap", &target),
    ] {
        let path = format!("Proxy/{name}");
        assert_eq!(
            metadata(&mut overlay, &path).size,
            Some(expected.len() as u64)
        );
        assert_eq!(overlay.read_all(&path).unwrap(), expected.as_bytes());
        let h = overlay.open(&path, libc::O_RDWR, None, false).unwrap();
        overlay.write_chunk(&path, b"X", 0, &h).unwrap();
        overlay.truncate(&path, 3, Some(&h)).unwrap();
        assert_eq!(
            fs::read(backing.join(name)).unwrap(),
            format!("X{}", &expected[1..3]).as_bytes()
        );
        put(backing.join("replacement"), "REPLACEMENT");
        fs::rename(backing.join("replacement"), backing.join(name)).unwrap();
        overlay.truncate(&path, 2, Some(&h)).unwrap();
        assert_eq!(
            overlay.read_chunk(&path, 0, 2, &h).unwrap().unwrap(),
            format!("X{}", &expected[1..2]).as_bytes()
        );
        assert_eq!(fs::read(backing.join(name)).unwrap(), b"REPLACEMENT");
        overlay.release(&path, h).unwrap();
        overlay.write_file(&path, b"updated", None, false).unwrap();
        overlay.truncate(&path, 3, None).unwrap();
        assert_eq!(fs::read(backing.join(name)).unwrap(), b"upd");
    }
    assert_eq!(fs::read(base.join("overlap")).unwrap(), b"SOURCE overlap");
    overlay
        .setattr("Proxy/source-only", &json!({"mode":0o600}), None, false)
        .unwrap();
    assert_eq!(
        fs::metadata(base.join("source-only")).unwrap().mode() & 0o777,
        0o600
    );
    overlay.remove("Proxy/source-only", false).unwrap();
    assert!(
        overlay
            .getattr("Proxy/source-only", None)
            .unwrap()
            .is_none()
    );
    let h = overlay
        .open("Proxy/new", libc::O_RDWR, Some(0o644), false)
        .unwrap();
    overlay.release("Proxy/new", h).unwrap();
    assert_eq!(fs::read(target.join("new")).unwrap(), b"");
}
#[test]
fn creates_and_renames_children_on_their_merged_parent_directorys_backing() {
    let (root, mut overlay) = merged_proxy();
    let base = source(&root).join("Proxy");
    let target = root.path().join("proxy");
    for path in [
        base.join("source-only/nested"),
        base.join("merged"),
        target.join("merged"),
        target.join("proxy-only"),
    ] {
        fs::create_dir_all(path).unwrap();
    }
    for (parent, backing) in [
        ("source-only/nested", &base),
        ("merged", &target),
        ("proxy-only", &target),
    ] {
        let directory = format!("Proxy/{parent}");
        let before = metadata(&mut overlay, &directory);
        let dh = overlay
            .open(&directory, libc::O_RDONLY, None, true)
            .unwrap();
        let created = format!("{directory}/created");
        let h = overlay
            .open(&created, libc::O_RDWR, Some(0o644), false)
            .unwrap();
        overlay.release(&created, h).unwrap();
        overlay
            .write_file(&format!("{directory}/written"), b"written", None, false)
            .unwrap();
        overlay.mkdir(&format!("{directory}/child"), 0o755).unwrap();
        overlay
            .rename(&created, &format!("{directory}/renamed"))
            .unwrap();
        assert_eq!(
            sorted_names(&mut overlay, &directory),
            ["child", "renamed", "written"]
        );
        assert_eq!(metadata(&mut overlay, &directory).identity, before.identity);
        assert_eq!(
            overlay
                .fgetattr(&directory, &dh, &before)
                .unwrap()
                .unwrap()
                .identity,
            before.identity
        );
        assert_eq!(fs::read(backing.join(parent).join("renamed")).unwrap(), b"");
        assert_eq!(
            fs::read(backing.join(parent).join("written")).unwrap(),
            b"written"
        );
        assert!(
            fs::metadata(backing.join(parent).join("child"))
                .unwrap()
                .is_dir()
        );
        overlay.release(&directory, dh).unwrap();
    }
    assert!(!target.join("source-only").exists());
    assert_errno(
        overlay.open("Proxy/missing/new", libc::O_RDWR, Some(0o644), false),
        libc::ENOENT,
    );
}
#[test]
fn rejects_partial_removal_and_rename_of_multiply_backed_directories() {
    let (root, mut overlay) = merged_proxy();
    let base = source(&root).join("Proxy");
    let target = root.path().join("proxy");
    for backing in [&base, &target] {
        fs::create_dir(backing.join("merged")).unwrap();
        fs::create_dir(backing.join("empty")).unwrap();
    }
    put(base.join("merged/source"), "source");
    put(target.join("merged/proxy"), "proxy");
    fs::create_dir(target.join("single")).unwrap();
    assert_errno(overlay.remove("Proxy/merged", true), libc::ENOTEMPTY);
    assert_errno(overlay.rename("Proxy/merged", "Proxy/moved"), libc::EXDEV);
    assert_errno(overlay.remove("Proxy/empty", true), libc::EOPNOTSUPP);
    assert_errno(overlay.rename("Proxy/single", "Proxy/empty"), libc::EXDEV);
    overlay.rename("Proxy/merged", "Proxy/merged").unwrap();
    assert_eq!(
        sorted_names(&mut overlay, "Proxy/merged"),
        ["proxy", "source"]
    );
    for backing in [&base, &target] {
        assert!(backing.join("empty").is_dir());
        assert!(!backing.join("moved").exists());
    }
    assert!(target.join("single").is_dir());
    fs::remove_file(target.join("merged/proxy")).unwrap();
    assert_errno(overlay.remove("Proxy/merged", true), libc::ENOTEMPTY);
}
fn overlapping_removal(kind: &str) {
    let (root, mut overlay) = merged_proxy();
    let source_path = source(&root).join("Proxy/data");
    let target_path = root.path().join("proxy/data");
    if kind == "symlink" {
        std::os::unix::fs::symlink("source-target", &source_path).unwrap();
        std::os::unix::fs::symlink("proxy-target", &target_path).unwrap();
    } else {
        if kind == "source-directory" {
            fs::create_dir(&source_path).unwrap();
        } else {
            put(&source_path, "SOURCE");
        }
        if kind == "hardlink" {
            fs::hard_link(&source_path, &target_path).unwrap();
        } else {
            put(&target_path, "PROXY");
        }
    }
    let before = metadata(&mut overlay, "Proxy/data");
    assert_errno(overlay.remove("Proxy/data", false), libc::EOPNOTSUPP);
    assert_errno(overlay.rename("Proxy/data", "Proxy/moved"), libc::EXDEV);
    overlay.rename("Proxy/data", "Proxy/data").unwrap();
    assert_eq!(
        metadata(&mut overlay, "Proxy/data").identity,
        before.identity
    );
    assert!(fs::symlink_metadata(source_path).is_ok());
    assert!(fs::symlink_metadata(target_path).is_ok());
    assert!(!root.path().join("proxy/moved").exists());
}
#[test]
fn rejects_namespace_removal_that_would_reveal_an_overlapping_file_backing() {
    overlapping_removal("file");
}
#[test]
fn rejects_namespace_removal_that_would_reveal_an_overlapping_symlink_backing() {
    overlapping_removal("symlink");
}
#[test]
fn rejects_namespace_removal_that_would_reveal_an_overlapping_hardlink_backing() {
    overlapping_removal("hardlink");
}
#[test]
fn rejects_namespace_removal_that_would_reveal_an_overlapping_source_directory_backing() {
    overlapping_removal("source-directory");
}
#[test]
fn allows_safe_replacement_of_an_overlapping_proxy_file_and_same_inode_renames() {
    let (root, mut overlay) = merged_proxy();
    put(source(&root).join("Proxy/data"), "SOURCE");
    put(root.path().join("proxy/data"), "OLD");
    put(root.path().join("proxy/replacement"), "NEW");
    overlay.rename("Proxy/replacement", "Proxy/data").unwrap();
    assert!(
        overlay
            .getattr("Proxy/replacement", None)
            .unwrap()
            .is_none()
    );
    assert_eq!(overlay.read_all("Proxy/data").unwrap(), b"NEW");
    assert_eq!(
        fs::read(source(&root).join("Proxy/data")).unwrap(),
        b"SOURCE"
    );
    fs::hard_link(
        root.path().join("proxy/data"),
        root.path().join("proxy/alias"),
    )
    .unwrap();
    overlay.rename("Proxy/data", "Proxy/alias").unwrap();
    assert_eq!(overlay.read_all("Proxy/data").unwrap(), b"NEW");
    assert_eq!(overlay.read_all("Proxy/alias").unwrap(), b"NEW");
}
fn module_shadow(kind: &str) {
    let module = format!(
        r#"export default tracked({{getattr({{path}}){{
      if(!path)return {{kind:"directory"}};
      if(path==="data"||path==="alias")return {{kind:{},identity:"generated",size:9,target:"generated-target"}};
      if(path==="replacement")return {{kind:{},identity:"replacement",size:3}};}},
      readdir(){{return [];}},readFile(){{return "GENERATED";}},unlink(){{}},rmdir(){{}},rename(){{}}}});"#,
        json!(kind),
        json!(kind)
    );
    let (root, mut overlay) = module_fixture(json!([rule("**")]), &module);
    let target = source(&root).join("data");
    match kind {
        "directory" => fs::create_dir(&target).unwrap(),
        "symlink" => std::os::unix::fs::symlink("source-target", &target).unwrap(),
        _ => put(&target, "SOURCE"),
    }
    let ino = fs::symlink_metadata(&target).unwrap().ino();
    assert_errno(
        overlay.remove("data", kind == "directory"),
        libc::EOPNOTSUPP,
    );
    assert_errno(overlay.rename("data", "moved"), libc::EXDEV);
    if kind == "directory" {
        assert_errno(overlay.rename("replacement", "data"), libc::EXDEV);
    }
    for op in ["unlink", "rmdir", "rename"] {
        assert!(calls(&root, op).is_empty());
    }
    assert_eq!(fs::symlink_metadata(&target).unwrap().ino(), ino);
    assert_eq!(
        metadata(&mut overlay, "data").kind,
        serde_json::from_value(json!(kind)).unwrap()
    );
    overlay.rename("data", "data").unwrap();
    assert_eq!(calls(&root, "rename").len(), 1);
}
#[test]
fn rejects_module_namespace_mutations_that_would_reveal_a_shadowed_source_file() {
    module_shadow("file");
}
#[test]
fn rejects_module_namespace_mutations_that_would_reveal_a_shadowed_source_directory() {
    module_shadow("directory");
}
#[test]
fn rejects_module_namespace_mutations_that_would_reveal_a_shadowed_source_symlink() {
    module_shadow("symlink");
}
fn module_only(opaque: bool) {
    let (root, mut overlay) = module_fixture(
        json!([{"match":"**","opaque":opaque,"provider":{"module":"default"}}]),
        r#"
      const old={kind:"file",identity:"original",size:3,contents:"OLD"};
      const entries=new Map([["data",old],["alias",old],["replacement",{...old,identity:"replacement",contents:"NEW"}]]);
      export default tracked({getattr({path}){return path?entries.get(path):{kind:"directory"};},readFile({path}){return entries.get(path)?.contents??"";},
      unlink({path}){entries.delete(path);},rename({path,destinationPath}){const r=entries.get(path);if(!r)throw Error("missing");if(r===entries.get(destinationPath))return;entries.set(destinationPath,r);entries.delete(path);}});
    "#,
    );
    put(source(&root).join("data"), "SOURCE");
    overlay.rename("data", "alias").unwrap();
    assert_eq!(overlay.read_all("data").unwrap(), b"OLD");
    overlay.rename("replacement", "data").unwrap();
    assert_eq!(overlay.read_all("data").unwrap(), b"NEW");
    assert!(overlay.getattr("replacement", None).unwrap().is_none());
    overlay.remove("alias", false).unwrap();
    assert!(overlay.getattr("alias", None).unwrap().is_none());
    if opaque {
        overlay.rename("data", "moved").unwrap();
        assert!(overlay.getattr("data", None).unwrap().is_none());
        overlay.remove("moved", false).unwrap();
    } else {
        assert_errno(overlay.remove("data", false), libc::EOPNOTSUPP);
    }
    assert_eq!(fs::read(source(&root).join("data")).unwrap(), b"SOURCE");
}
#[test]
fn preserves_module_only_removals_and_safe_replacement_opaque_false() {
    module_only(false);
}
#[test]
fn preserves_module_only_removals_and_safe_replacement_opaque_true() {
    module_only(true);
}
fn native_namespace(content: bool) {
    let (root, mut overlay) = module_fixture(
        json!([rule("**")]),
        if content {
            r#"export default {readFile({sourcePath}){return nodefs.readFileSync(sourcePath);}};"#
        } else {
            r#"export default {getattr(){return {kind:"file"};}};"#
        },
    );
    put(source(&root).join("data"), "SOURCE");
    overlay.rename("data", "moved").unwrap();
    assert_eq!(fs::read(source(&root).join("moved")).unwrap(), b"SOURCE");
    overlay.remove("moved", false).unwrap();
    assert!(!source(&root).join("moved").exists());
}
#[test]
fn preserves_native_namespace_operations_for_content_only_source_overlays() {
    native_namespace(true);
}
#[test]
fn preserves_native_namespace_operations_for_metadata_only_source_overlays() {
    native_namespace(false);
}
fn removal_metadata_error(code: &str, err: i32) {
    let module = format!(
        r#"let n=0;export default tracked({{getattr(){{if(++n===1)return {{kind:"file",size:9}};fail({});}},readFile(){{return "GENERATED";}},unlink(){{}}}});"#,
        json!(code)
    );
    let (root, mut overlay) = module_fixture(json!([rule("**")]), &module);
    put(source(&root).join("data"), "SOURCE");
    assert_errno(overlay.remove("data", false), err);
    assert!(calls(&root, "unlink").is_empty());
    assert_eq!(fs::read(source(&root).join("data")).unwrap(), b"SOURCE");
}
#[test]
fn propagates_module_metadata_errors_while_checking_removal_safety_enoent() {
    removal_metadata_error("ENOENT", libc::ENOENT);
}
#[test]
fn propagates_module_metadata_errors_while_checking_removal_safety_eio() {
    removal_metadata_error("EIO", libc::EIO);
}
fn proxy_mutation(opaque: bool) {
    let (root, mut overlay) = fixture(
        json!([{"match":"Proxy/**","root":"Proxy","opaque":opaque,"provider":{"type":"directory","path":if opaque{"proxy"}else{"source/Proxy"}}}]),
        None,
    );
    fs::create_dir_all(source(&root).join("Proxy")).unwrap();
    let target = if opaque {
        root.path().join("proxy")
    } else {
        source(&root).join("Proxy")
    };
    put(target.join("directory/child"), "proxy");
    if opaque {
        put(source(&root).join("Proxy/directory/source"), "source");
    }
    overlay.rename("Proxy/directory", "Proxy/moved").unwrap();
    assert!(overlay.getattr("Proxy/directory", None).unwrap().is_none());
    assert_eq!(overlay.read_all("Proxy/moved/child").unwrap(), b"proxy");
    overlay.remove("Proxy/moved/child", false).unwrap();
    overlay.remove("Proxy/moved", true).unwrap();
    assert!(overlay.getattr("Proxy/moved", None).unwrap().is_none());
    put(target.join("file"), "file");
    if opaque {
        put(source(&root).join("Proxy/file"), "source");
    }
    overlay.rename("Proxy/file", "Proxy/renamed").unwrap();
    assert!(overlay.getattr("Proxy/file", None).unwrap().is_none());
    overlay.remove("Proxy/renamed", false).unwrap();
    assert!(overlay.getattr("Proxy/renamed", None).unwrap().is_none());
}
#[test]
fn preserves_directory_mutations_for_a_opaque_proxy() {
    proxy_mutation(true);
}
#[test]
fn preserves_directory_mutations_for_a_same_backing_proxy() {
    proxy_mutation(false);
}
fn generated_child_removal(kind: &str) {
    let mut rules = vec![];
    if kind == "proxy" {
        rules.push(json!({"match":"Parent/**","root":"Parent","opaque":true,"provider":{"type":"directory","path":"proxy"}}));
    }
    if kind == "module" {
        rules.push(json!({"match":"Parent/**","root":"Parent","opaque":true,"provider":{"module":"directory"}}));
    }
    rules.push(rule("Parent/AGENTS.md"));
    let (root, mut overlay) = module_fixture(
        json!(rules),
        r#"
      export const directory=tracked({getattr(){return {kind:"directory"};},readdir(){return [];},rmdir(){}});
      export default tracked({getattr(){if(!nodefs.existsSync(new URL("./hidden",import.meta.url)))return {kind:"file",size:0};}});
    "#,
    );
    fs::create_dir(source(&root).join("Parent")).unwrap();
    fs::create_dir(root.path().join("proxy")).unwrap();
    assert_eq!(names(&mut overlay, "Parent"), ["AGENTS.md"]);
    assert_errno(overlay.remove("Parent", true), libc::ENOTEMPTY);
    if kind == "source" {
        fs::create_dir(source(&root).join("Replacement")).unwrap();
        assert_errno(overlay.rename("Replacement", "Parent"), libc::ENOTEMPTY);
        assert!(source(&root).join("Replacement").is_dir());
    }
    assert!(calls(&root, "rmdir").is_empty());
    assert!(source(&root).join("Parent").is_dir());
    assert!(root.path().join("proxy").is_dir());
    put(root.path().join("hidden"), "");
    overlay.remove("Parent", true).unwrap();
    if kind == "module" {
        assert_eq!(calls(&root, "rmdir").len(), 1);
    }
}
#[test]
fn rejects_removing_a_source_directory_containing_generated_children() {
    generated_child_removal("source");
}
#[test]
fn rejects_removing_a_proxy_directory_containing_generated_children() {
    generated_child_removal("proxy");
}
#[test]
fn rejects_removing_a_module_directory_containing_generated_children() {
    generated_child_removal("module");
}
#[test]
fn rejects_removing_native_ancestors_of_generated_subtrees() {
    let (root, mut overlay) = module_fixture(
        json!([opaque("Parent/Generated/**", "Parent/Generated")]),
        r#"export default {getattr(){return {kind:"directory"};},readdir(){return [];}};"#,
    );
    fs::create_dir(source(&root).join("Parent")).unwrap();
    assert_errno(overlay.remove("Parent", true), libc::ENOTEMPTY);
    assert!(source(&root).join("Parent").is_dir());
}
fn closed_descendants(kind: &str, destination: bool) {
    let mut rules = vec![];
    if kind == "proxy" {
        rules.push(json!({"match":"**","root":"","opaque":true,"provider":{"type":"directory","path":"source"}}));
    }
    if kind == "module" {
        rules.push(json!({"match":"**","root":"","opaque":true,"provider":{"module":"owner"}}));
    }
    rules.push(rule(if destination {
        "after/**/*.txt"
    } else {
        "before/generated"
    }));
    let (root, mut overlay) = module_fixture(
        json!(rules),
        if destination {
            r#"
      export const owner=tracked({getattr({path}){return path==="before"||path==="before/nested"?{kind:"directory"}:path==="before/nested/data.txt"?{kind:"file",size:8}:undefined;},
      readdir({path}){return path==="before"?["nested"]:path==="before/nested"?["data.txt"]:[];},rename(){}});
      export default {getattr(){return {kind:"file",size:9};},readFile(){return "GENERATED";}};
    "#
        } else {
            r#"
      export const owner=tracked({getattr({path}){return path==="before"?{kind:"directory"}:path==="before/native"?{kind:"file",size:6}:undefined;},
      readdir(){return ["native"];},rename(){}});
      export default {getattr(){return {kind:"file",size:1};},readFile(){return "x";}};
    "#
        },
    );
    let native = if destination {
        source(&root).join("before/nested/data.txt")
    } else {
        source(&root).join("before/native")
    };
    put(&native, if destination { "ORIGINAL" } else { "native" });
    assert_errno(overlay.rename("before", "after"), libc::EXDEV);
    assert!(calls(&root, "rename").is_empty());
    assert_eq!(
        fs::read(&native).unwrap(),
        if destination {
            b"ORIGINAL".as_slice()
        } else {
            b"native".as_slice()
        }
    );
    assert!(!source(&root).join("after").exists());
    if !destination {
        assert_eq!(metadata(&mut overlay, "before/generated").kind, Kind::File);
    }
}
#[test]
fn rejects_renaming_a_source_directory_with_closed_descendants_owned_by_another_provider() {
    closed_descendants("source", false);
}
#[test]
fn rejects_renaming_a_proxy_directory_with_closed_descendants_owned_by_another_provider() {
    closed_descendants("proxy", false);
}
#[test]
fn rejects_renaming_a_module_directory_with_closed_descendants_owned_by_another_provider() {
    closed_descendants("module", false);
}
#[test]
fn rejects_renaming_ancestors_of_generated_roots_before_changing_the_backing() {
    let (root, mut overlay) = module_fixture(
        json!([opaque(
            "before/nested/generated/**",
            "before/nested/generated"
        )]),
        r#"export default {getattr(){return {kind:"directory"};},readdir(){return [];}};"#,
    );
    put(source(&root).join("before/native"), "native");
    assert_errno(overlay.rename("before", "after"), libc::EXDEV);
    assert_eq!(
        metadata(&mut overlay, "before/nested/generated").kind,
        Kind::Directory
    );
    assert_eq!(
        fs::read(source(&root).join("before/native")).unwrap(),
        b"native"
    );
    assert!(!source(&root).join("after").exists());
    overlay.rename("before", "before").unwrap();
}
#[test]
fn rejects_a_source_directory_rename_that_redirects_closed_descendants_at_the_destination() {
    closed_descendants("source", true);
}
#[test]
fn rejects_a_proxy_directory_rename_that_redirects_closed_descendants_at_the_destination() {
    closed_descendants("proxy", true);
}
#[test]
fn rejects_a_module_directory_rename_that_redirects_closed_descendants_at_the_destination() {
    closed_descendants("module", true);
}
#[test]
fn retains_nonopaque_source_fallback_for_descendants_of_a_renamed_directory() {
    let (root, mut overlay) = module_fixture(
        json!([rule("after/**/*.txt")]),
        "export default {getattr(){}};",
    );
    put(source(&root).join("before/nested/data.txt"), "ORIGINAL");
    overlay.rename("before", "after").unwrap();
    assert_eq!(
        overlay.read_all("after/nested/data.txt").unwrap(),
        b"ORIGINAL"
    );
}
#[test]
fn propagates_destination_metadata_errors_before_moving_a_directory() {
    let (root, mut overlay) = module_fixture(
        json!([rule("after/*.txt")]),
        r#"export default {getattr(){fail("EACCES","unavailable");}};"#,
    );
    put(source(&root).join("before/data.txt"), "ORIGINAL");
    assert_errno(overlay.rename("before", "after"), libc::EACCES);
    assert_eq!(
        fs::read(source(&root).join("before/data.txt")).unwrap(),
        b"ORIGINAL"
    );
    assert!(!source(&root).join("after").exists());
}
#[test]
fn allows_ordinary_directory_renames_past_hidden_exact_entries_and_unrelated_roots() {
    let (root, mut overlay) = module_fixture(
        json!([rule("before/generated"),{"match":"before/generated","hide":true},opaque("unrelated/**","unrelated")]),
        r#"export default {getattr({path}){return {kind:path==="before/generated"?"file":"directory",size:1};},readdir(){return [];}};"#,
    );
    put(source(&root).join("before/native"), "native");
    overlay.rename("before", "after").unwrap();
    assert_eq!(
        fs::read(source(&root).join("after/native")).unwrap(),
        b"native"
    );
    assert!(overlay.getattr("before", None).unwrap().is_none());
}
fn source_parent_create(opaque: bool, readonly: bool, errno: i32) {
    let (root, mut overlay) = fixture(
        json!([{"match":"Proxy/**","root":"Proxy","opaque":opaque,"provider":{"type":"directory","path":"proxy"}}]),
        None,
    );
    fs::create_dir(root.path().join("proxy")).unwrap();
    fs::create_dir_all(source(&root).join("Proxy/source-only")).unwrap();
    overlay.config.read_only = readonly;
    assert_errno(
        overlay.open("Proxy/source-only/new", libc::O_RDWR, Some(0o644), false),
        errno,
    );
    assert!(!source(&root).join("Proxy/source-only/new").exists());
}
#[test]
fn rejects_source_parent_creation_with_opaque_true_and_readonly_false() {
    source_parent_create(true, false, libc::ENOENT);
}
#[test]
fn rejects_source_parent_creation_with_opaque_false_and_readonly_true() {
    source_parent_create(false, true, libc::EROFS);
}
fn proxy_failure(err: i32) {
    // A filesystem error at the real proxy lookup replaces the old mocked native provider.
    let (root, mut overlay) = fixture(
        json!([{"match":"file","provider":{"type":"file","path":"target"}}]),
        None,
    );
    put(source(&root).join("file"), "source");
    // Test-only metadata injection is scoped to this thread, not the Node provider transport.
    metadata_test_hooks::LOOKUP
        .with_borrow_mut(|hook| *hook = Some(Box::new(move |_| Err(errno(err)))));
    assert_errno(overlay.getattr("file", None), err);
    assert_errno(overlay.open("file", libc::O_RDONLY, None, false), err);
    assert_errno(overlay.write_file("file", b"changed", None, false), err);
    metadata_test_hooks::LOOKUP.with_borrow_mut(|hook| *hook = None);
    assert_eq!(fs::read(source(&root).join("file")).unwrap(), b"source");
}
#[test]
fn does_not_fall_back_to_source_after_a_proxy_eacces_failure() {
    proxy_failure(libc::EACCES);
}
#[test]
fn does_not_fall_back_to_source_after_a_proxy_eio_failure() {
    proxy_failure(libc::EIO);
}
#[test]
fn reconciles_source_and_generated_directory_entries_against_later_opaque_child_overrides() {
    let (root, mut overlay) = module_fixture(
        json!([
        {"match":"Tree/**","root":"Tree","provider":{"module":"tree"}},
        {"match":"passthrough.txt","opaque":true,"provider":{"module":"default"}},
        {"match":"Tree/generated","opaque":true,"provider":{"module":"default"}},
        {"match":"Tree/source","opaque":true,"provider":{"module":"default"}}]),
        r#"
        export const tree={getattr({relativePath}){return {kind:relativePath?"file":"directory",size:0};},readdir(){return ["generated","visible"];}};export default {};
    "#,
    );
    put(source(&root).join("passthrough.txt"), "source");
    put(source(&root).join("Tree/source"), "source");
    assert_eq!(names(&mut overlay, ""), ["Tree"]);
    assert_eq!(names(&mut overlay, "Tree"), ["visible"]);
    for name in ["passthrough.txt", "Tree/generated", "Tree/source"] {
        assert!(overlay.getattr(name, None).unwrap().is_none());
    }
}
#[test]
fn accepts_legal_dot_prefixed_file_names_without_mistaking_them_for_traversal() {
    let (root, mut overlay) = fixture(json!([]), None);
    put(source(&root).join("..notes"), "value");
    assert_eq!(overlay.read_all("..notes").unwrap(), b"value");
}
fn literal_backslash(proxy: bool) {
    let (root, mut overlay) = fixture(
        if proxy {
            json!([{"match":"Proxy/**","root":"Proxy","provider":{"type":"directory","path":"source"}}])
        } else {
            json!([])
        },
        None,
    );
    put(source(&root).join("dir/name"), "NESTED");
    put(source(&root).join(r"dir\name"), "LITERAL");
    put(source(&root).join(r"..\name"), "not traversal");
    let prefix = if proxy { "Proxy/" } else { "" };
    assert!(names(&mut overlay, prefix).contains(&r"dir\name".into()));
    assert_eq!(
        overlay.read_all(&format!(r"{prefix}dir\name")).unwrap(),
        b"LITERAL"
    );
    assert_eq!(
        overlay.read_all(&format!(r"{prefix}..\name")).unwrap(),
        b"not traversal"
    );
    assert_errno(
        overlay.read_all(&format!("{prefix}dir/../name")),
        libc::EINVAL,
    );
    let from = format!(r"{prefix}dir\name");
    let to = format!(r"{prefix}moved\name");
    let h = overlay.open(&from, libc::O_RDWR, None, false).unwrap();
    overlay.write_chunk(&from, b"X", 0, &h).unwrap();
    overlay.release(&from, h).unwrap();
    overlay.rename(&from, &to).unwrap();
    assert_eq!(
        fs::read(source(&root).join(r"moved\name")).unwrap(),
        b"XITERAL"
    );
    overlay.remove(&to, false).unwrap();
    assert_eq!(fs::read(source(&root).join("dir/name")).unwrap(), b"NESTED");
    assert!(!source(&root).join(r"dir\name").exists());
}
#[test]
fn keeps_literal_backslashes_distinct_from_path_separators_in_source_names() {
    literal_backslash(false);
}
#[test]
fn keeps_literal_backslashes_distinct_from_path_separators_in_proxy_names() {
    literal_backslash(true);
}

fn backing_fixture(kind: &str, name: &str) -> (tempfile::TempDir, Overlay, String) {
    let rules = match kind {
        "source" => json!([]),
        "file" => {
            json!([{"match":name,"provider":{"type":"file","path":format!("source/{name}")}}])
        }
        _ => {
            json!([{"match":"Proxy/**","root":"Proxy","provider":{"type":"directory","path":"source"}}])
        }
    };
    let (root, overlay) = fixture(rules, None);
    (
        root,
        overlay,
        if kind == "directory" {
            format!("Proxy/{name}")
        } else {
            name.into()
        },
    )
}
fn symlink_times(kind: &str) {
    let (root, mut overlay, name) = backing_fixture(kind, "link");
    let target = source(&root).join("target");
    let link = source(&root).join("link");
    put(&target, "unchanged");
    std::os::unix::fs::symlink("target", &link).unwrap();
    let before = fs::metadata(&target).unwrap();
    overlay
        .setattr(
            &name,
            &json!({"atime":{"$date":100125},"mtime":{"$date":200750}}),
            None,
            false,
        )
        .unwrap();
    let m = native_metadata(&fs::symlink_metadata(&link).unwrap()).unwrap();
    assert_eq!(m.atime.unwrap().millis, 100125);
    assert_eq!(m.mtime.unwrap().millis, 200750);
    let after = fs::metadata(&target).unwrap();
    assert_eq!(before.atime(), after.atime());
    assert_eq!(before.atime_nsec(), after.atime_nsec());
    assert_eq!(before.mtime(), after.mtime());
    assert_eq!(before.mtime_nsec(), after.mtime_nsec());
    fs::remove_file(&target).unwrap();
    overlay
        .setattr(
            &name,
            &json!({"atime":{"$date":300125},"mtime":{"$date":400750}}),
            None,
            false,
        )
        .unwrap();
    let m = native_metadata(&fs::symlink_metadata(&link).unwrap()).unwrap();
    assert_eq!(m.atime.unwrap().millis, 300125);
    assert_eq!(m.mtime.unwrap().millis, 400750);
}
#[test]
fn changes_source_symlink_timestamps_without_dereferencing_its_target_including_dangling_links() {
    symlink_times("source");
}
#[test]
fn changes_directory_symlink_timestamps_without_dereferencing_its_target_including_dangling_links()
{
    symlink_times("directory");
}
fn fifo(path: &Path) {
    syscall(unsafe { libc::mkfifo(cpath(path).unwrap().as_ptr(), 0o600) }).unwrap();
}
fn reject_fifo(kind: &str) {
    let (root, mut overlay, name) = backing_fixture(kind, "fifo");
    put(source(&root).join("regular"), "ordinary");
    fifo(&source(&root).join("fifo"));
    assert_errno(overlay.getattr(&name, None), libc::EOPNOTSUPP);
    for flags in [libc::O_RDONLY, libc::O_WRONLY, libc::O_RDWR] {
        assert_errno(overlay.open(&name, flags, None, false), libc::EOPNOTSUPP);
    }
    assert_errno(overlay.read_all(&name), libc::EOPNOTSUPP);
    assert_errno(
        overlay.write_file(&name, b"X", None, false),
        libc::EOPNOTSUPP,
    );
    let directory = if kind == "directory" { "Proxy" } else { "" };
    assert_eq!(names(&mut overlay, directory), ["regular"]);
    assert_eq!(
        overlay
            .read_all(if kind == "directory" {
                "Proxy/regular"
            } else {
                "regular"
            })
            .unwrap(),
        b"ordinary"
    );
}
#[test]
fn rejects_fifos_in_source_backing_without_blocking_or_breaking_directory_listings() {
    reject_fifo("source");
}
#[test]
fn rejects_fifos_in_directory_backing_without_blocking_or_breaking_directory_listings() {
    reject_fifo("directory");
}
#[test]
fn rejects_fifos_in_file_backing_without_blocking_or_breaking_directory_listings() {
    reject_fifo("file");
}
#[test]
fn does_not_block_or_leak_a_descriptor_when_a_regular_file_becomes_a_fifo_before_open() {
    let (root, _overlay) = fixture(json!([]), None);
    let path = source(&root).join("regular");
    put(&path, "ordinary");
    let acquired = std::rc::Rc::new(std::cell::Cell::new(-1));
    let capture = acquired.clone();
    native_test_hooks::ACQUIRED
        .with_borrow_mut(|hook| *hook = Some(Box::new(move |file| capture.set(file.as_raw_fd()))));
    native_test_hooks::OPEN.with_borrow_mut(|hook| {
        *hook = Some(Box::new(|path, flags| {
            assert_eq!(flags, libc::O_RDONLY | libc::O_NONBLOCK);
            fs::remove_file(path).unwrap();
            fifo(path);
            Ok(())
        }))
    });
    assert_errno(
        open_native(&path, libc::O_RDONLY, 0, false),
        libc::EOPNOTSUPP,
    );
    native_test_hooks::OPEN.with_borrow_mut(|hook| *hook = None);
    native_test_hooks::ACQUIRED.with_borrow_mut(|hook| *hook = None);
    assert_ne!(acquired.get(), -1);
    assert_closed(acquired.get());
    assert_errno(
        open_native(
            &path,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            0o644,
            false,
        ),
        libc::EEXIST,
    );
}
#[test]
fn rejects_a_file_proxy_replaced_by_a_symlink_between_metadata_checks_and_descriptor_acquisition() {
    let (root, mut overlay) = fixture(
        json!([{"match":"Proxy","provider":{"type":"file","path":"source/target"}}]),
        None,
    );
    put(source(&root).join("target"), "original");
    put(source(&root).join("actual"), "unchanged");
    std::os::unix::fs::symlink("actual", source(&root).join("replacement")).unwrap();
    native_test_hooks::OPEN.with_borrow_mut(|hook| {
        *hook = Some(Box::new(|path, flags| {
            assert_ne!(flags & libc::O_NOFOLLOW, 0);
            fs::rename(path.parent().unwrap().join("replacement"), path).unwrap();
            Ok(())
        }))
    });
    assert_errno(
        overlay.open("Proxy", libc::O_RDWR, None, false),
        libc::ELOOP,
    );
    native_test_hooks::OPEN.with_borrow_mut(|hook| *hook = None);
    assert_eq!(
        fs::read(source(&root).join("actual")).unwrap(),
        b"unchanged"
    );
}
#[test]
fn still_lists_generated_overrides_of_unsupported_source_nodes() {
    let (root, mut overlay) = module_fixture(
        json!([rule("*.txt")]),
        r#"export default {getattr(){return {kind:"file",size:9};},readFile(){return "generated";}};"#,
    );
    fifo(&source(&root).join("generated.txt"));
    assert_eq!(names(&mut overlay, ""), ["generated.txt"]);
    assert_eq!(overlay.read_all("generated.txt").unwrap(), b"generated");
}
fn native_create_fixture(kind: &str) -> (tempfile::TempDir, Overlay) {
    let rules = match kind {
        "source" => json!([]),
        "proxy" => json!([{"match":"**","provider":{"type":"directory","path":"source"}}]),
        _ => json!([{"match":"**","opaque":kind=="provider","provider":{"module":"default"}}]),
    };
    module_fixture(
        rules,
        if kind == "create-hook" {
            r#"export default tracked({async create(m,{sourcePath}){const f=await nodeio.open(sourcePath,"wx",m.mode);await f.close();}});"#
        } else {
            r#"export default tracked({create(){}});"#
        },
    )
}
fn native_create_flags(kind: &str) {
    let (root, mut overlay) = native_create_fixture(kind);
    let h = overlay
        .open("readonly", libc::O_RDONLY, Some(0o644), false)
        .unwrap();
    assert!(h.native.is_some());
    assert_errno(overlay.write_chunk("readonly", b"X", 0, &h), libc::EBADF);
    overlay.release("readonly", h).unwrap();
    let flags = libc::O_WRONLY | libc::O_APPEND;
    let h = overlay.open("append", flags, Some(0o644), false).unwrap();
    overlay.write_chunk("append", b"A", 0, &h).unwrap();
    use std::io::Write;
    let mut native = h.native.as_ref().unwrap();
    native.write_all(b"B").unwrap();
    assert_eq!(fs::read(source(&root).join("append")).unwrap(), b"AB");
    assert_errno(overlay.read_chunk("append", 0, 2, &h), libc::EBADF);
    overlay.release("append", h).unwrap();
}
#[test]
fn preserves_native_access_and_append_flags_when_creating_through_source() {
    native_create_flags("source");
}
#[test]
fn preserves_native_access_and_append_flags_when_creating_through_proxy() {
    native_create_flags("proxy");
}
#[test]
fn preserves_native_access_and_append_flags_when_creating_through_create_hook() {
    native_create_flags("create-hook");
}
fn executable_create(kind: &str, mode: u32) {
    let (root, mut overlay) = native_create_fixture(kind);
    let h = overlay
        .open("executable", libc::O_WRONLY, Some(0o100000 | mode), false)
        .unwrap();
    if kind == "create-hook" || kind == "provider" {
        let c = calls(&root, "create");
        assert_eq!(c.len(), 1);
        assert_eq!(
            c[0]["args"],
            json!([{"kind":"file","mode":mode,"size":0,"sizeMode":"explicit"}])
        );
        assert_eq!(c[0]["context"]["flags"], libc::O_WRONLY);
    }
    if kind != "provider" {
        let actual = fs::metadata(source(&root).join("executable"))
            .unwrap()
            .mode()
            & 0o777;
        let reference = source(&root).join("reference");
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&reference)
            .unwrap();
        assert_eq!(actual, fs::metadata(reference).unwrap().mode() & 0o777);
        assert!(h.native.is_some());
    } else {
        assert!(h.native.is_none());
    }
    overlay.release("executable", h).unwrap();
}
#[test]
fn preserves_executable_creation_permissions_through_source() {
    executable_create("source", 0o751);
}
#[test]
fn preserves_executable_creation_permissions_through_proxy() {
    executable_create("proxy", 0o751);
}
#[test]
fn preserves_executable_creation_permissions_through_create_hook() {
    executable_create("create-hook", 0o751);
}
#[test]
fn preserves_executable_creation_permissions_through_provider() {
    executable_create("provider", 0o751);
}
#[test]
fn preserves_special_permission_bits_in_provider_creation_mode_2541() {
    executable_create("provider", 0o4755);
}
#[test]
fn preserves_special_permission_bits_in_provider_creation_mode_1517() {
    executable_create("provider", 0o2755);
}
#[test]
fn preserves_special_permission_bits_in_provider_creation_mode_1005() {
    executable_create("provider", 0o1755);
}
fn synchronize(kind: &str, directory: bool) {
    let (root, mut overlay, name) =
        backing_fixture(kind, if directory { "backing" } else { "data" });
    if directory {
        fs::create_dir(source(&root).join("backing")).unwrap();
    } else {
        put(source(&root).join("data"), "old");
    }
    let h = overlay.open(&name, libc::O_RDWR, None, directory).unwrap();
    let fd = h.native.as_ref().unwrap().as_raw_fd();
    let identity = native_identity(&source(&root).join(if directory { "backing" } else { "data" }));
    if directory {
        fs::rename(source(&root).join("backing"), source(&root).join("renamed")).unwrap();
        fs::create_dir(source(&root).join("backing")).unwrap();
    } else {
        overlay.write_chunk(&name, b"new", 0, &h).unwrap();
    }
    let observed = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let capture = observed.clone();
    native_test_hooks::SYNC.with_borrow_mut(|hook| {
        *hook = Some(Box::new(move |file, data| {
            assert_eq!(file.as_raw_fd(), fd);
            assert_eq!(
                native_metadata(&file.metadata().unwrap())
                    .unwrap()
                    .identity
                    .as_deref(),
                Some(identity.as_str())
            );
            let mut calls = capture.borrow_mut();
            calls.push((file.as_raw_fd(), data));
            if calls.len() == 3 {
                Err(errno(libc::EIO))
            } else {
                Ok(())
            }
        }))
    });
    let op = if directory { "fsyncdir" } else { "fsync" };
    overlay.sync(&name, &h, op, false).unwrap();
    overlay.sync(&name, &h, op, true).unwrap();
    assert_errno(overlay.sync(&name, &h, op, false), libc::EIO);
    native_test_hooks::SYNC.with_borrow_mut(|hook| *hook = None);
    assert_eq!(*observed.borrow(), [(fd, false), (fd, true), (fd, false)]);
    overlay.release(&name, h).unwrap();
    assert_closed(fd);
    if !directory {
        assert_eq!(fs::read(source(&root).join("data")).unwrap(), b"new");
    }
}
#[test]
fn synchronizes_the_actual_source_backing_descriptor_and_propagates_sync_failures() {
    synchronize("source", false);
}
#[test]
fn synchronizes_the_actual_file_backing_descriptor_and_propagates_sync_failures() {
    synchronize("file", false);
}
#[test]
fn synchronizes_the_actual_directory_backing_descriptor_and_propagates_sync_failures() {
    synchronize("directory", false);
}
#[test]
fn preserves_native_descriptor_identity_when_the_source_pathname_is_atomically_replaced() {
    let (root, mut overlay) = fixture(json!([]), None);
    put(source(&root).join("data"), "ORIGINAL");
    let h = overlay.open("data", libc::O_RDWR, None, false).unwrap();
    put(source(&root).join("replacement"), "REPLACEMENT");
    fs::rename(
        source(&root).join("replacement"),
        source(&root).join("data"),
    )
    .unwrap();
    overlay.truncate("data", 3, Some(&h)).unwrap();
    assert_eq!(
        fs::read(source(&root).join("data")).unwrap(),
        b"REPLACEMENT"
    );
    assert_eq!(
        overlay.read_chunk("data", 0, 3, &h).unwrap().unwrap(),
        b"ORI"
    );
    overlay.release("data", h).unwrap();
}
fn temporary_read_failure(operation: &str) {
    let module = format!(
        r#"export default tracked({{getattr(){{return {{kind:"file",size:4}};}},open(){{return "resource";}},
      fgetattr(){{{} return {{kind:"file",size:4}};}},read(){{fail("EIO","provider failed");}},release({{handle,flags}}){{if(handle!=="resource"||flags!==0)throw Error("release context");}}}});"#,
        if operation == "fgetattr" {
            r#"fail("EIO","provider failed");"#
        } else {
            ""
        }
    );
    let (root, mut overlay) = module_fixture(json!([opaque("data", "")]), &module);
    assert_errno(overlay.read_all("data"), libc::EIO);
    let c = calls(&root, "release");
    assert_eq!(c.len(), 1);
    assert_eq!(c[0]["context"]["handle"], "resource");
    assert_eq!(c[0]["context"]["flags"], libc::O_RDONLY);
}
#[test]
fn releases_temporary_positional_resources_when_read_fails_during_whole_file_reads() {
    temporary_read_failure("read");
}
#[test]
fn releases_temporary_positional_resources_when_fgetattr_fails_during_whole_file_reads() {
    temporary_read_failure("fgetattr");
}
fn decorated_identity(directory: bool, descriptor: bool) {
    let kind = if directory { "directory" } else { "file" };
    let module = format!(
        r#"const m={{kind:{},identity:"provider:decoration",mode:0o750}};
      export default tracked({{getattr(){{return m;}},{} }});"#,
        json!(kind),
        if descriptor {
            r#"fgetattr(){return m;}"#
        } else {
            ""
        }
    );
    let (root, mut overlay) = module_fixture(json!([rule("decorated")]), &module);
    let target = source(&root).join("decorated");
    if directory {
        fs::create_dir(&target).unwrap();
    } else {
        put(&target, "native");
    }
    let before = metadata(&mut overlay, "decorated");
    assert_eq!(before.mode, Some(0o750));
    assert_eq!(
        before.kind,
        if directory {
            Kind::Directory
        } else {
            Kind::File
        }
    );
    assert!(before.identity.as_deref().unwrap().starts_with("native:"));
    if !directory {
        assert_eq!(before.size, Some(6));
    }
    let h = overlay
        .open("decorated", libc::O_RDONLY, None, directory)
        .unwrap();
    let m = overlay.fgetattr("decorated", &h, &before).unwrap().unwrap();
    assert_eq!(m.identity, before.identity);
    assert_eq!(m.mode, Some(0o750));
    if !directory {
        put(&target, "native extended");
        let m = overlay.fgetattr("decorated", &h, &before).unwrap().unwrap();
        assert_eq!(m.size, Some(15));
        assert_eq!(m.mode, Some(0o750));
    }
    fs::rename(&target, source(&root).join("retained")).unwrap();
    if directory {
        fs::create_dir(&target).unwrap();
    } else {
        put(&target, "native");
    }
    assert_ne!(
        metadata(&mut overlay, "decorated").identity,
        before.identity
    );
    let m = overlay.fgetattr("decorated", &h, &before).unwrap().unwrap();
    assert_eq!(m.identity, before.identity);
    assert_eq!(m.mode, Some(0o750));
    if !directory {
        assert_eq!(m.size, Some(15));
    }
    overlay.release("decorated", h).unwrap();
}
#[test]
fn uses_native_identity_for_a_decorated_file_with_fgetattr_false() {
    decorated_identity(false, false);
}
#[test]
fn uses_native_identity_for_a_decorated_file_with_fgetattr_true() {
    decorated_identity(false, true);
}
#[test]
fn uses_native_identity_for_a_decorated_directory_with_fgetattr_false() {
    decorated_identity(true, false);
}
#[test]
fn uses_native_identity_for_a_decorated_directory_with_fgetattr_true() {
    decorated_identity(true, true);
}
#[test]
fn syncs_source_directory_descriptors_after_rename_and_closes_them() {
    synchronize("source", true);
}
#[test]
fn syncs_directory_directory_descriptors_after_rename_and_closes_them() {
    synchronize("directory", true);
}
#[test]
fn does_not_decorate_the_mount_root_with_a_broad_file_metadata_provider() {
    let (root, mut overlay) = module_fixture(
        json!([rule("**")]),
        r#"export default tracked({getattr(){return {kind:"file",mode:0o400};}});"#,
    );
    let before = metadata(&mut overlay, "");
    let h = overlay.open("", libc::O_RDONLY, None, true).unwrap();
    let m = overlay.fgetattr("", &h, &before).unwrap().unwrap();
    assert_eq!(m.kind, Kind::Directory);
    assert_eq!(m.identity, before.identity);
    assert_eq!(m.mode, before.mode);
    assert!(calls(&root, "getattr").is_empty());
    overlay.release("", h).unwrap();
}
fn native_capture(fail: bool) {
    let module = format!(
        r#"let opened=false;const resource={{marker:"resource"}};
      export default tracked({{open(){{opened=true;return resource;}},getattr(){{if(!opened)throw Error("metadata before open");{}
      return {{kind:"file",mode:0o640}};}},release({{handle}}){{if(handle!==resource)throw Error("lost resource");}}}});"#,
        if fail {
            r#"fail("EIO","metadata failed");"#
        } else {
            ""
        }
    );
    let (root, mut overlay) = module_fixture(json!([rule("created")]), &module);
    let fd = std::rc::Rc::new(std::cell::Cell::new(-1));
    let capture = fd.clone();
    native_test_hooks::ACQUIRED
        .with_borrow_mut(|hook| *hook = Some(Box::new(move |f| capture.set(f.as_raw_fd()))));
    let result = overlay.open("created", libc::O_RDWR, Some(0o644), false);
    native_test_hooks::ACQUIRED.with_borrow_mut(|hook| *hook = None);
    if fail {
        assert_errno(result, libc::EIO);
        assert_eq!(calls(&root, "release").len(), 1);
        assert_eq!(fs::read(source(&root).join("created")).unwrap(), b"");
        assert_closed(fd.get());
    } else {
        let h = result.unwrap();
        let opened = metadata(&mut overlay, "created");
        let m = overlay.fgetattr("created", &h, &opened).unwrap().unwrap();
        assert_eq!(m.mode, Some(0o640));
        assert_eq!(m.size, Some(0));
        overlay.release("created", h).unwrap();
    }
}
#[test]
fn captures_native_creation_metadata_and_releases_resources_on_failure_false() {
    native_capture(false);
}
#[test]
fn captures_native_creation_metadata_and_releases_resources_on_failure_true() {
    native_capture(true);
}
fn concurrent_create_failure(operation: &str, mutation: &str) {
    let module = format!(
        r#"const resource={{marker:"resource"}};
      function reject({{sourcePath}}){{nodefs.writeFileSync(new URL("./entered",import.meta.url),"");return new Promise((resolve,reject)=>{{
        const timer=setInterval(()=>{{if(nodefs.existsSync(new URL("./resume",import.meta.url))){{clearInterval(timer);reject(Object.assign(Error("provider failed"),{{code:"EIO"}}));}}}},5);}});}}
      export default tracked({{open(c){{{} }},getattr(c){{{} }},release({{handle}}){{if(handle!==resource)throw Error("lost resource");}}}});"#,
        if operation == "open" {
            "return reject(c);"
        } else {
            "return resource;"
        },
        if operation == "getattr" {
            "return reject(c);"
        } else {
            r#"return {kind:"file"};"#
        }
    );
    let (root, overlay) = module_fixture(json!([rule("created")]), &module);
    put(source(&root).join("replacement"), "concurrent contents");
    let native = source(&root).join("created");
    let root_path = root.path().to_path_buf();
    let task = std::thread::spawn(move || {
        let mut overlay = overlay;
        let fd = std::rc::Rc::new(std::cell::Cell::new(-1));
        let capture = fd.clone();
        native_test_hooks::ACQUIRED
            .with_borrow_mut(|hook| *hook = Some(Box::new(move |f| capture.set(f.as_raw_fd()))));
        let result = overlay.open("created", libc::O_RDWR, Some(0o644), false);
        native_test_hooks::ACQUIRED.with_borrow_mut(|hook| *hook = None);
        assert_errno(result, libc::EIO);
        assert_closed(fd.get());
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !root_path.join("entered").exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "provider did not enter"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    if mutation == "replace" {
        fs::rename(source(&root).join("replacement"), &native).unwrap();
    } else {
        put(&native, "concurrent contents");
    }
    put(root_path.join("resume"), "");
    task.join().unwrap();
    assert_eq!(fs::read(native).unwrap(), b"concurrent contents");
    assert_eq!(
        calls(&root, "release").len(),
        usize::from(operation == "getattr")
    );
}
#[test]
fn preserves_concurrent_replace_when_open_fails_after_native_creation() {
    concurrent_create_failure("open", "replace");
}
#[test]
fn preserves_concurrent_write_when_open_fails_after_native_creation() {
    concurrent_create_failure("open", "write");
}
#[test]
fn preserves_concurrent_replace_when_getattr_fails_after_native_creation() {
    concurrent_create_failure("getattr", "replace");
}
#[test]
fn preserves_concurrent_write_when_getattr_fails_after_native_creation() {
    concurrent_create_failure("getattr", "write");
}
fn native_policy(policy: &str, size: u64) {
    let module = format!(
        r#"const m={{kind:"file",sizeMode:{}}};export default {{getattr(){{return m;}},fgetattr(){{return m;}}}};"#,
        json!(policy)
    );
    let (root, mut overlay) = module_fixture(json!([rule("data")]), &module);
    put(source(&root).join("data"), "native");
    let m = metadata(&mut overlay, "data");
    assert_eq!(m.size, Some(size));
    assert_eq!(m.size_mode.as_deref(), Some(policy));
    let h = overlay.open("data", libc::O_RDONLY, None, false).unwrap();
    let m = overlay.fgetattr("data", &h, &m).unwrap().unwrap();
    assert_eq!(m.size, Some(size));
    assert_eq!(m.size_mode.as_deref(), Some(policy));
    overlay.release("data", h).unwrap();
}
#[test]
fn preserves_an_explicit_zero_size_policy_on_native_backed_metadata_overlays() {
    native_policy("zero", 0);
}
#[test]
fn preserves_an_explicit_unbounded_size_policy_on_native_backed_metadata_overlays() {
    native_policy("unbounded", 0x7fffffffffff);
}
fn acquired_cleanup(operation: &str) {
    let module = format!(
        r#"const resource=await nodeio.open(new URL("./source/resource",import.meta.url),"w+");
      export default tracked({{{operation}(){{return resource;}},async release({{handle}}){{if(handle!==resource)throw Error("resource");await resource.close();if(resource.fd!==-1)throw Error("unclosed");}},
      async releasedir({{handle}}){{if(handle!==resource)throw Error("resource");await resource.close();if(resource.fd!==-1)throw Error("unclosed");}}}});"#
    );
    let (root, mut overlay) = module_fixture(json!([rule("missing")]), &module);
    assert_errno(
        overlay.open(
            "missing",
            if operation == "create" {
                libc::O_RDWR
            } else {
                libc::O_RDONLY
            },
            if operation == "create" {
                Some(0o644)
            } else {
                None
            },
            operation == "opendir",
        ),
        libc::ENOENT,
    );
    let c = calls(
        &root,
        if operation == "opendir" {
            "releasedir"
        } else {
            "release"
        },
    );
    assert_eq!(c.len(), 1);
    assert!(c[0]["context"]["handle"]["fd"].as_i64().unwrap() >= 0);
}
#[test]
fn releases_acquired_provider_resources_if_native_open_fails() {
    acquired_cleanup("open");
}
#[test]
fn releases_acquired_provider_resources_if_native_create_fails() {
    acquired_cleanup("create");
}
#[test]
fn releases_acquired_provider_resources_if_native_opendir_fails() {
    acquired_cleanup("opendir");
}
#[test]
fn preserves_native_acquisition_and_provider_cleanup_errors_together() {
    let (_root, mut overlay) = module_fixture(
        json!([rule("missing")]),
        r#"export default tracked({open(){return {resource:true};},release(){fail("EIO","cleanup failed");}});"#,
    );
    let error = overlay
        .open("missing", libc::O_RDONLY, None, false)
        .err()
        .unwrap();
    let errors = error.downcast_ref::<ResourceRollbackError>().unwrap();
    assert_eq!(error_code(&errors.primary), libc::ENOENT);
    assert_eq!(error_code(&errors.cleanup), libc::EIO);
}
#[test]
fn closes_a_native_source_descriptor_even_when_its_custom_release_hook_fails() {
    let (root, mut overlay) = module_fixture(
        json!([rule("data")]),
        r#"const resource={marker:"opened"};export default tracked({open(){return resource;},
      release({handle}){if(handle!==resource)throw Error("resource lost");fail("EIO","release failed");}});"#,
    );
    put(source(&root).join("data"), "data");
    let h = overlay.open("data", libc::O_RDWR, None, false).unwrap();
    let fd = h.native.as_ref().unwrap().as_raw_fd();
    assert_errno(overlay.release("data", h), libc::EIO);
    assert_closed(fd);
    assert_eq!(calls(&root, "release").len(), 1);
    assert_eq!(calls(&root, "release")[0]["context"]["handle"], "opened");
}
#[test]
fn preserves_zero_size_policy_while_ordinary_whole_file_metadata_is_buffered() {
    let (_root, mut overlay) = module_fixture(
        json!([opaque("command", "")]),
        r#"export default {getattr(){return {kind:"file",sizeMode:"zero"};},readFile(){return "";},writeFile(){}};"#,
    );
    overlay.write_file("command", b"run", None, false).unwrap();
    let m = metadata(&mut overlay, "command");
    assert_eq!(m.size, Some(0));
    assert_eq!(m.size_mode.as_deref(), Some("zero"));
}

fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}
fn example_fixture() -> (tempfile::TempDir, Overlay) {
    let showcase = Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/showcase");
    let mut config =
        crate::config::Config::parse(&fs::read(showcase.join("config.json")).unwrap()).unwrap();
    let modules = crate::module::resolve(&mut config, &showcase).unwrap();
    let mut wrapper = String::from(
        "const log=console.log;console.log=(...args)=>{record(\"log\",args,{});log(...args);};\n",
    );
    for (index, module) in modules.iter().enumerate() {
        let entry = module
            .manifest_path
            .parent()
            .unwrap()
            .join(&module.manifest.entry);
        wrapper += &format!(
            "import * as module{index} from {entry};\n\
             export class {name} {{ constructor() {{ const X=module{index}[{export}]; \
             return tracked(typeof X===\"function\"?new X({runtime}):X); }} }}\n",
            entry = json!(entry),
            name = module.instance,
            export = json!(module.manifest.export),
            runtime = json!({"version":1,"name":module.instance,"settings":module.settings}),
        );
    }
    let (root, overlay) = module_fixture(
        config.filesystems[0]
            .rules
            .iter()
            .map(|rule| serde_json::to_value(rule).unwrap())
            .collect(),
        &wrapper,
    );
    copy_tree(&showcase.join("fixtures"), &root.path().join("fixtures"));
    copy_tree(&root.path().join("fixtures/source"), &source(&root));
    (root, overlay)
}
fn log_count(root: &tempfile::TempDir, text: &str) -> usize {
    calls(root, "log")
        .iter()
        .filter(|v| v["args"][0].as_str().is_some_and(|s| s.contains(text)))
        .count()
}
#[test]
fn demonstrates_additive_instructions_synthetic_ancestors_symlinks_and_hidden_generated_entries() {
    let (_root, mut workspace) = example_fixture();
    let instructions = "components/Button/AGENTS.md";
    workspace.access(instructions, 4).unwrap();
    assert!(
        String::from_utf8(workspace.read_all(instructions).unwrap())
            .unwrap()
            .contains("Component instructions")
    );
    workspace.access("Tools", 1).unwrap();
    assert_eq!(
        workspace.readlink("Tools/Memory/latest").unwrap(),
        "data.txt"
    );
    assert!(
        String::from_utf8(
            workspace
                .read_all("MergedDirectory/source-only.txt")
                .unwrap()
        )
        .unwrap()
        .contains("source side")
    );
    assert_eq!(
        workspace.read_all("MergedDirectory/existing.txt").unwrap(),
        fs::read(_root.path().join("fixtures/proxy-directory/existing.txt")).unwrap()
    );
    for directory in ["", "GeneratedCatalog", "Tools/Memory"] {
        assert!(
            names(&mut workspace, directory)
                .iter()
                .all(|n| !n.ends_with(".private"))
        );
    }
}
#[test]
fn creates_high_level_files_and_implements_real_finite_positional_writes_and_truncation() {
    let (_root, mut workspace) = example_fixture();
    let created = "GeneratedCatalog/created.txt";
    let h = workspace
        .open(created, libc::O_RDWR, Some(0o644), false)
        .unwrap();
    workspace.release(created, h).unwrap();
    assert_eq!(metadata(&mut workspace, created).size, Some(0));
    workspace
        .write_file(created, b"whole-file", None, false)
        .unwrap();
    assert_eq!(workspace.read_all(created).unwrap(), b"whole-file");
    assert!(names(&mut workspace, "GeneratedCatalog").contains(&"created.txt".into()));
    let fixed = "GeneratedCatalog/FixedSize.bin";
    let m = metadata(&mut workspace, fixed);
    assert_eq!(m.size, Some(16));
    assert_eq!(m.size_mode.as_deref(), Some("explicit"));
    let h = workspace.open(fixed, libc::O_RDWR, None, false).unwrap();
    assert_eq!(workspace.write_chunk(fixed, b"OK", 2, &h).unwrap(), Some(2));
    assert_eq!(
        workspace.read_chunk(fixed, 0, 6, &h).unwrap().unwrap(),
        b"FFOKFF"
    );
    workspace.truncate(fixed, 4, Some(&h)).unwrap();
    assert_eq!(
        workspace.fgetattr(fixed, &h, &m).unwrap().unwrap().size,
        Some(4)
    );
    workspace.release(fixed, h).unwrap();
}
fn example_sink(workspace: &mut Overlay, root: &tempfile::TempDir) {
    let sink = "GeneratedCatalog/CommandSink.txt";
    let m = metadata(workspace, sink);
    assert_eq!(m.size, Some(0));
    assert_eq!(m.size_mode.as_deref(), Some("zero"));
    assert_eq!(m.seekable, Some(false));
    let h = workspace.open(sink, libc::O_WRONLY, None, false).unwrap();
    workspace.truncate(sink, 0, Some(&h)).unwrap();
    workspace.write_chunk(sink, b"run", 0, &h).unwrap();
    workspace.release(sink, h).unwrap();
    assert_eq!(log_count(root, "write 3 bytes"), 1);
}
#[test]
fn demonstrates_zero_unbounded_and_non_seekable_policies_without_silently_writable_streams() {
    let (root, mut workspace) = example_fixture();
    example_sink(&mut workspace, &root);
    let stream = "GeneratedCatalog/GeneratedStream.bin";
    let m = metadata(&mut workspace, stream);
    assert_eq!(m.size_mode.as_deref(), Some("unbounded"));
    assert_eq!(m.seekable, Some(true));
    let h = workspace.open(stream, libc::O_RDONLY, None, false).unwrap();
    assert_eq!(
        workspace.read_chunk(stream, 10, 4, &h).unwrap().unwrap(),
        b"SSSS"
    );
    assert_errno(workspace.write_chunk(stream, b"X", 0, &h), libc::EROFS);
    workspace.release(stream, h).unwrap();
    let m = metadata(&mut workspace, "GeneratedCatalog/SequentialStream.bin");
    assert_eq!(m.size, Some(4096));
    assert_eq!(m.seekable, Some(false));
}
#[test]
fn keeps_mutable_resources_and_directory_handles_stable_across_namespace_changes() {
    let (root, mut workspace) = example_fixture();
    let base = "Tools/Memory";
    workspace.mkdir(&format!("{base}/before"), 0o755).unwrap();
    let directory = workspace
        .open(&format!("{base}/before"), libc::O_RDONLY, None, true)
        .unwrap();
    let mut name = format!("{base}/before/file");
    let h = workspace
        .open(&name, libc::O_RDWR, Some(0o644), false)
        .unwrap();
    workspace.write_chunk(&name, b"original", 0, &h).unwrap();
    workspace
        .setattr(
            &name,
            &json!({"mode":0o600,"atime":{"$date":1000},"mtime":{"$date":2000}}),
            Some(&h),
            false,
        )
        .unwrap();
    workspace
        .setattr(&name, &json!({"uid":123,"gid":456}), None, false)
        .unwrap();
    let opened = metadata(&mut workspace, &name);
    let m = workspace.fgetattr(&name, &h, &opened).unwrap().unwrap();
    assert_eq!(m.size, Some(8));
    assert_eq!(m.mode, Some(0o600));
    assert_eq!(m.uid, Some(123));
    assert_eq!(m.gid, Some(456));
    assert_eq!(m.mtime.unwrap().millis, 2000);
    workspace
        .rename(&format!("{base}/before"), &format!("{base}/after"))
        .unwrap();
    name = format!("{base}/after/file");
    workspace.sync(&name, &h, "flush", false).unwrap();
    workspace.sync(&name, &h, "fsync", false).unwrap();
    workspace
        .sync(&format!("{base}/after"), &directory, "fsyncdir", true)
        .unwrap();
    assert_errno(
        workspace.remove(&format!("{base}/after"), true),
        libc::ENOTEMPTY,
    );
    workspace.remove(&name, false).unwrap();
    let replacement = workspace
        .open(&name, libc::O_RDWR, Some(0o644), false)
        .unwrap();
    workspace.release(&name, replacement).unwrap();
    assert_eq!(
        workspace.read_chunk(&name, 0, 8, &h).unwrap().unwrap(),
        b"original"
    );
    workspace.truncate(&name, 3, Some(&h)).unwrap();
    assert_eq!(
        workspace
            .fgetattr(&name, &h, &opened)
            .unwrap()
            .unwrap()
            .size,
        Some(3)
    );
    assert_eq!(metadata(&mut workspace, &name).size, Some(0));
    workspace.remove(&name, false).unwrap();
    workspace.remove(&format!("{base}/after"), true).unwrap();
    workspace.release(&name, h).unwrap();
    workspace
        .release(&format!("{base}/after"), directory)
        .unwrap();
    workspace
        .worker
        .request(json!({"op":"abort"}), &[])
        .unwrap();
    assert_eq!(log_count(&root, "[memory] shutdown signal received"), 1);
    for op in ["flush", "fsync", "fsyncdir", "releasedir"] {
        assert_eq!(calls(&root, op).len(), 1);
    }
}
#[test]
fn demonstrates_source_lifecycle_hooks_writable_proxies_and_a_read_only_filesystem() {
    let (root, mut workspace) = example_fixture();
    let h = workspace
        .open("created.native", libc::O_RDWR, Some(0o644), false)
        .unwrap();
    assert!(h.native.is_some());
    workspace
        .write_chunk("created.native", b"native", 0, &h)
        .unwrap();
    workspace
        .sync("created.native", &h, "fsync", false)
        .unwrap();
    workspace.release("created.native", h).unwrap();
    assert_eq!(
        fs::read(source(&root).join("created.native")).unwrap(),
        b"native"
    );
    workspace
        .write_file("ProxiedFile.txt", b"proxy", None, false)
        .unwrap();
    assert_eq!(
        fs::read(root.path().join("fixtures/proxy-file.txt")).unwrap(),
        b"proxy"
    );
    let h = workspace
        .open("ProxiedDirectory/new", libc::O_RDWR, Some(0o644), false)
        .unwrap();
    workspace.release("ProxiedDirectory/new", h).unwrap();
    workspace
        .rename("ProxiedDirectory/new", "ProxiedDirectory/renamed")
        .unwrap();
    workspace.remove("ProxiedDirectory/renamed", false).unwrap();
    let config = Filesystem {
        source: root.path().join("fixtures/reference-source"),
        read_only: true,
        rules: vec![],
        ..workspace.config.clone()
    };
    let mut reference = Overlay::new(config, workspace.worker.clone()).unwrap();
    assert_errno(
        reference.write_file("README.txt", b"not allowed", None, false),
        libc::EROFS,
    );
    assert_eq!(
        reference.statfs("/").unwrap().f_flag & libc::ST_RDONLY,
        libc::ST_RDONLY
    );
}
#[test]
fn writes_the_actual_content_sized_example_without_options_and_resets_its_command_sink() {
    let (root, mut workspace) = example_fixture();
    workspace
        .write_file(
            "GeneratedCatalog/ContentSized.txt",
            b"updated example",
            None,
            false,
        )
        .unwrap();
    assert_eq!(
        workspace
            .read_all("GeneratedCatalog/ContentSized.txt")
            .unwrap(),
        b"updated example"
    );
    example_sink(&mut workspace, &root);
}
