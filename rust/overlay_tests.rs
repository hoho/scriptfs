use super::*;

/// Builds an overlay whose rules reference module instances by export name:
/// `{"module":"default"}` loads the default export of the fixture module.
pub(crate) fn fixture(rules: Value, module: Option<&str>) -> (tempfile::TempDir, Overlay) {
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/test-fixtures");
    fs::create_dir_all(&fixtures).unwrap();
    let root = tempfile::tempdir_in(fixtures).unwrap();
    fs::create_dir(root.path().join("source")).unwrap();
    let entry = root.path().join("module.mjs");
    if let Some(module) = module {
        fs::write(&entry, module).unwrap();
    }
    let mut rules = rules;
    let mut instances = serde_json::Map::new();
    for rule in rules.as_array_mut().unwrap() {
        if let Some(provider) = rule.get_mut("provider") {
            if let Some(name) = provider.get("module").and_then(Value::as_str) {
                instances.insert(
                    name.into(),
                    json!({"entry":entry,"export":name,"runtime":{"version":1,"name":name}}),
                );
            }
            if provider.get("path").is_some() {
                provider["path"] = json!(root.path().join(provider["path"].as_str().unwrap()));
            }
        }
    }
    let config: Filesystem = serde_json::from_value(json!({"name":"test","source":root.path().join("source"),"mountPoint":root.path().join("mount"),"rules":rules})).unwrap();
    let worker = Worker::start().unwrap();
    if !instances.is_empty() {
        worker
            .request(json!({"op":"load","modules":instances}), &[])
            .unwrap();
    }
    let overlay = Overlay::new(config, Arc::new(worker)).unwrap();
    (root, overlay)
}

#[test]
fn default_display_timestamps_do_not_change_the_content_revision() {
    let first = Metadata::from_value(json!({"kind":"file","size":7}))
        .unwrap()
        .unwrap()
        .normalized();
    let second = Metadata::from_value(json!({"kind":"file","size":7}))
        .unwrap()
        .unwrap()
        .normalized();
    assert!(first.mtime.is_some());
    assert_eq!(first.content_revision(), second.content_revision());
    assert_eq!(
        first.content_revision(),
        first.clone().normalized().content_revision()
    );
    let explicit = Metadata::from_value(json!({"kind":"file","size":7,"mtime":{"$date":1}}))
        .unwrap()
        .unwrap()
        .normalized();
    assert_ne!(first.content_revision(), explicit.content_revision());
}

#[test]
fn directory_metadata_batches_preserve_callbacks_masking_and_shadowed_rules() {
    let (root, mut overlay) = fixture(
        json!([
            {"match":"Dir/**","root":"Dir","opaque":true,"file":{"mode":0o600},"provider":{"module":"default"}},
            {"match":"Dir/f000","opaque":true,"provider":{"module":"override"}},
            {"match":"Dir/f001","hide":true}
        ]),
        Some(
            r#"
            import {appendFileSync} from "node:fs";
            import path from "node:path";
            export default {
                getattr(c) {
                    if(c.path==="Dir")return {kind:"directory"};
                    const name=path.basename(c.path);
                    appendFileSync(path.join(c.sourcePath,"..","..","trace"),name+"\n");
                    if(name==="missing")return;
                    if(name==="unsupported")throw Object.assign(new Error("unsupported"),{code:"EOPNOTSUPP"});
                    return {kind:"file",size:4,mtime:new Date(1000)};
                },
                readdir() {
                    return [...Array.from({length:600},(_,i)=>`f${String(i).padStart(3,"0")}`),
                        {name:"missing",metadata:{kind:"file",size:999}},
                        "unsupported"];
                },
            };
            export const override = {getattr(){return {kind:"file",size:9};}};
        "#,
        ),
    );
    let entries = overlay.readdir("Dir").unwrap().unwrap();
    assert_eq!(entries.len(), 599);
    assert_eq!(entries[0].0, "f000");
    assert_eq!(entries[0].1.size, Some(9));
    for (_, metadata) in &entries[1..] {
        assert_eq!(metadata.size, Some(4));
        assert_eq!(metadata.mode, Some(0o600));
        assert_eq!(metadata.mtime.as_ref().unwrap().millis, 1000);
    }
    let trace = fs::read_to_string(root.path().join("source/trace")).unwrap();
    assert_eq!(trace.lines().count(), 600);
    assert!(!trace.lines().any(|name| matches!(name, "f000" | "f001")));
    assert_eq!(
        overlay.getattr("Dir/f002", None).unwrap().unwrap().size,
        Some(4)
    );
}

#[test]
fn native_positional_io_survives_unlink_and_replacement() {
    let (root, mut fs) = fixture(json!([]), None);
    let source = root.path().join("source");
    std::fs::write(source.join("file"), "abcdef").unwrap();
    let handle = fs.open("file", libc::O_RDWR, None, false).unwrap();
    assert!(handle.native.is_some());
    assert_eq!(
        fs.read_chunk("file", 2, 3, &handle).unwrap().unwrap(),
        b"cde"
    );
    fs.remove("file", false).unwrap();
    std::fs::write(source.join("file"), "replacement").unwrap();
    assert_eq!(
        fs.read_chunk("file", 0, 6, &handle).unwrap().unwrap(),
        b"abcdef"
    );
    fs.write_chunk("file", b"X", 0, &handle).unwrap();
    assert_eq!(std::fs::read(source.join("file")).unwrap(), b"replacement");
    fs.release("file", handle).unwrap();
}

#[test]
fn provider_classes_and_non_enumerable_callbacks_preserve_this() {
    let (_root, mut fs) = fixture(
        json!([{"match":"file","opaque":true,"provider":{"module":"default"}}]),
        Some(
            r#"
            class Provider {
                #contents = Buffer.from("class");
                getattr() { return {kind:"file",size:this.#contents.length}; }
                readFile() { return this.#contents; }
                replace(contents) { this.#contents = contents; }
                get unrelated() { throw new Error("Unrelated getter was evaluated"); }
            }
            const provider = new Provider();
            Object.defineProperty(provider, "writeFile", {
                value(contents) { this.replace(contents); },
                enumerable: false,
            });
            export default provider;
        "#,
        ),
    );
    let metadata = fs.getattr("file", None).unwrap().unwrap();
    let handle = fs.open("file", libc::O_RDONLY, None, false).unwrap();
    assert_eq!(fs.read_file("file", &handle, &metadata).unwrap(), b"class");
    fs.release("file", handle).unwrap();
    fs.write_file("file", b"updated", None, false).unwrap();
    let metadata = fs.getattr("file", None).unwrap().unwrap();
    let handle = fs.open("file", libc::O_RDONLY, None, false).unwrap();
    assert_eq!(
        fs.read_file("file", &handle, &metadata).unwrap(),
        b"updated"
    );
    fs.release("file", handle).unwrap();
}

#[test]
fn proxy_io_and_merged_directory_ownership() {
    let (root, mut fs) = fixture(
        json!([
            {"match":"Proxy/**","root":"Proxy","provider":{"type":"directory","path":"proxy"}},
            {"match":"single","provider":{"type":"file","path":"single"}}
        ]),
        None,
    );
    std::fs::create_dir(root.path().join("proxy")).unwrap();
    std::fs::create_dir(root.path().join("source/Proxy")).unwrap();
    std::fs::write(root.path().join("single"), "fixed").unwrap();
    std::fs::write(root.path().join("proxy/overlap"), "PROXY").unwrap();
    std::fs::write(root.path().join("source/Proxy/overlap"), "SOURCE").unwrap();
    std::fs::write(root.path().join("source/Proxy/source"), "SOURCE").unwrap();
    let entries = fs.readdir("Proxy").unwrap().unwrap();
    assert_eq!(
        entries.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(),
        ["overlap", "source"]
    );
    assert_eq!(
        error_code(&fs.remove("Proxy/overlap", false).unwrap_err()),
        libc::EOPNOTSUPP
    );
    let handle = fs.open("Proxy/overlap", libc::O_RDWR, None, false).unwrap();
    fs.write_chunk("Proxy/overlap", b"X", 0, &handle).unwrap();
    fs.release("Proxy/overlap", handle).unwrap();
    assert_eq!(
        std::fs::read(root.path().join("proxy/overlap")).unwrap(),
        b"XROXY"
    );
    assert_eq!(
        error_code(
            &fs.open("single", libc::O_RDWR, Some(0o644), false)
                .err()
                .unwrap()
        ),
        libc::EROFS
    );
}

#[test]
fn javascript_buffers_dates_options_and_opaque_handles() {
    let (_root, mut fs) = fixture(
        json!([{"match":"Generated/**","root":"Generated","opaque":true,"provider":{"module":"default","options":{"text":"hello","literal":{"$date":1234}}}}]),
        Some(
            r#"
      import { Buffer } from "node:buffer";
      export default {
        getattr({relativePath}) { return relativePath ? {kind:"file",identity:"resource",size:5,mtime:new Date(1234)} : {kind:"directory"}; },
        readdir() { return ["file"]; },
        open(context) { if(context.options.literal instanceof Date || context.options.literal.$date !== 1234)throw new Error("Options were reinterpreted"); return {bytes:Buffer.from(context.options.text),created:new Date(4567)}; },
        fgetattr({handle}) { if (!(handle.created instanceof Date)) throw new Error("Lost handle"); return {kind:"file",identity:"resource",size:handle.bytes.length}; },
        read(position,length,{handle,signal}) { signal.throwIfAborted(); return handle.bytes.subarray(position,position+length); },
        write(bytes,position,{handle}) { if (!Buffer.isBuffer(bytes)) throw new Error("Not Buffer"); bytes.copy(handle.bytes,position); return bytes.length; },
        release({handle}) { if (!handle) throw new Error("Lost release handle"); }
      };
    "#,
        ),
    );
    assert_eq!(
        fs.getattr("Generated/file", None)
            .unwrap()
            .unwrap()
            .mtime
            .unwrap()
            .millis,
        1234
    );
    let handle = fs
        .open("Generated/file", libc::O_RDWR, None, false)
        .unwrap();
    assert!(handle.value.is_some());
    assert!(handle.native.is_none());
    assert_eq!(
        fs.read_chunk("Generated/file", 1, 3, &handle)
            .unwrap()
            .unwrap(),
        b"ell"
    );
    fs.write_chunk("Generated/file", b"Y", 0, &handle).unwrap();
    let metadata = fs.getattr("Generated/file", None).unwrap().unwrap();
    assert_eq!(
        fs.fgetattr("Generated/file", &handle, &metadata)
            .unwrap()
            .unwrap()
            .identity
            .as_deref(),
        Some("resource:rule:0")
    );
    assert_eq!(
        fs.read_file("Generated/file", &handle, &metadata).unwrap(),
        b"Yello"
    );
    fs.release("Generated/file", handle).unwrap();
}

#[test]
fn picomatch_rules_and_generated_ancestors_remain_compatible() {
    let (_root, mut fs) = fixture(
        json!([
            {"match":"a/{one,two}/+(file|other).txt","root":"a","opaque":true,"provider":{"module":"default"}},
            {"match":"literal+name.txt","provider":{"module":"default"}},
            {"match":"literal\\!name.txt","provider":{"module":"default"}},
            {"match":"a/**/hidden*","hide":true},
            {"match":"Nested/Deep/**","root":"Nested/Deep","opaque":true,"provider":{"module":"default"}}
        ]),
        Some(
            r#"export default {getattr(){return {kind:"file",size:4};},readFile(){return "test";},readdir(){return [];}};"#,
        ),
    );
    assert!(fs.getattr("a/one/file.txt", None).unwrap().is_some());
    assert!(fs.getattr("a/two/hidden.txt", None).unwrap().is_none());
    assert_eq!(
        fs.getattr("Nested", None).unwrap().unwrap().kind,
        Kind::Directory
    );
    let entries = fs.readdir("").unwrap().unwrap();
    assert!(entries.iter().any(|(n, _)| n == "literal+name.txt"));
    assert!(entries.iter().any(|(n, _)| n == "literal!name.txt"));
    assert!(entries.iter().any(|(n, _)| n == "Nested"));
}

#[test]
fn positional_identity_and_provider_errors_are_not_silently_ignored() {
    let (_root, mut fs) = fixture(
        json!([{"match":"file","opaque":true,"provider":{"module":"default"}}]),
        Some(
            r#"
      let identity="first";
      export default {
        getattr(){return {kind:"file",identity,size:4};},
        read(){return "test";},
        write(){throw Object.assign(new Error("no space"),{code:"ENOSPC"});},
        truncate(){identity="replacement";}
      };
    "#,
        ),
    );
    let metadata = fs.getattr("file", None).unwrap().unwrap();
    let handle = fs.open("file", libc::O_RDWR, None, false).unwrap();
    assert_eq!(
        error_code(&fs.write_chunk("file", b"X", 0, &handle).unwrap_err()),
        libc::ENOSPC
    );
    fs.truncate("file", 0, None).unwrap();
    assert_eq!(
        error_code(
            &fs.check_identity("file", &handle, &metadata, "read")
                .unwrap_err()
        ),
        libc::ESTALE
    );
    fs.release("file", handle).unwrap();
}

#[test]
fn whole_file_writes_preserve_previous_contents_and_callback_dates() {
    let (_root, mut fs) = fixture(
        json!([{"match":"file","opaque":true,"provider":{"module":"default"}}]),
        Some(
            r#"
      let value=Buffer.from("old");
      export default {
        getattr(){return {kind:"file",mtime:new Date(1234)};},
        readFile(){return value;},
        writeFile(next,{previousContents}){if(previousContents.toString()!=="old")throw new Error("previousContents changed");value=next;},
        utimens(atime,mtime){if(!(atime instanceof Date)||mtime.getTime()!==6789)throw new Error("Dates changed");}
      };
    "#,
        ),
    );
    fs.write_file("file", b"new", None, false).unwrap();
    fs.setattr(
        "file",
        &json!({"atime":{"$date":1234},"mtime":{"$date":6789}}),
        None,
        false,
    )
    .unwrap();
    let handle = fs.open("file", libc::O_RDONLY, None, false).unwrap();
    let metadata = fs.getattr("file", None).unwrap().unwrap();
    assert_eq!(metadata.size, Some(3));
    assert_eq!(fs.read_file("file", &handle, &metadata).unwrap(), b"new");
    fs.release("file", handle).unwrap();
}

#[test]
fn fixed_file_proxies_reject_symbolic_link_replacement_and_special_nodes() {
    let (root, mut fs) = fixture(
        json!([{"match":"file","opaque":true,"provider":{"type":"file","path":"proxy"}}]),
        None,
    );
    std::fs::write(root.path().join("proxy"), "original").unwrap();
    std::fs::write(root.path().join("target"), "target").unwrap();
    std::fs::remove_file(root.path().join("proxy")).unwrap();
    std::os::unix::fs::symlink(root.path().join("target"), root.path().join("proxy")).unwrap();
    assert_eq!(
        error_code(&fs.getattr("file", None).unwrap_err()),
        libc::EOPNOTSUPP
    );
}

#[test]
fn provider_chown_translates_only_unsigned_unchanged_sentinel() {
    let (_root, mut overlay) = fixture(
        json!([{"match":"file","opaque":true,"provider":{"module":"default"}}]),
        Some(
            r#"
            let calls=0;
            const expected=[[-1,123],[456,-1],[4294967294,0],[0,-1],[-1,0],[-1,789]];
            export default {
                getattr(){return {kind:"file",size:0,uid:calls};},
                chown(uid,gid){
                    const next=expected[calls++];
                    if(!next || uid!==next[0] || gid!==next[1])throw Error(`Unexpected ownership: ${uid},${gid}`);
                }

            };
        "#,
        ),
    );
    for changes in [
        json!({"uid":u32::MAX,"gid":123}),
        json!({"uid":456,"gid":u32::MAX}),
        json!({"uid":u32::MAX-1,"gid":0}),
        json!({"uid":0}),
        json!({"gid":0}),
        json!({"uid":-1,"gid":789}),
    ] {
        overlay.setattr("file", &changes, None, false).unwrap();
    }
    assert_eq!(overlay.getattr("file", None).unwrap().unwrap().uid, Some(6));
}

#[test]
fn provider_resource_identity_is_stable_without_merging_lifecycle_handles() {
    let (_root, mut overlay) = fixture(
        json!([{"match":"**","root":"","opaque":true,"provider":{"module":"default"}}]),
        Some(
            r#"
            const shared={bytes:Buffer.from("abc")};
            const directory={};
            let released=0;
            export default {
                getattr({path}){return {kind:path==="dir"?"directory":"file",size:3,uid:released};},
                open({path}){return path==="same"?shared:{bytes:Buffer.from("xyz")};},
                create(){return shared;},
                opendir(){return directory;},
                read(position,length,{handle}){return handle.bytes.subarray(position,position+length);},
                release({handle}){if(!Buffer.isBuffer(handle.bytes))throw Error("Missing retained resource");released++;},
                releasedir({handle}){if(handle!==directory)throw Error("Lost directory resource");released++;}
            };
        "#,
        ),
    );
    let first = overlay.open("same", libc::O_RDWR, None, false).unwrap();
    let second = overlay.open("same", libc::O_RDWR, None, false).unwrap();
    let shared = first.resource;
    assert!(shared.is_some());
    assert_eq!(second.resource, shared);
    assert_ne!(first.value, second.value);
    overlay.release("same", first).unwrap();
    assert_eq!(
        overlay.read_chunk("same", 0, 3, &second).unwrap().unwrap(),
        b"abc"
    );
    let reopened = overlay.open("same", libc::O_RDWR, None, false).unwrap();
    assert_eq!(reopened.resource, shared);
    assert_ne!(reopened.value, second.value);
    let distinct_first = overlay.open("distinct", libc::O_RDWR, None, false).unwrap();
    let distinct_second = overlay.open("distinct", libc::O_RDWR, None, false).unwrap();
    assert!(distinct_first.resource.is_some());
    assert!(distinct_second.resource.is_some());
    assert_ne!(distinct_first.resource, distinct_second.resource);
    assert_ne!(distinct_first.resource, shared);
    let created = overlay
        .open("created", libc::O_RDWR, Some(0o644), false)
        .unwrap();
    assert_eq!(created.resource, shared);
    let directory_first = overlay.open("dir", libc::O_RDONLY, None, true).unwrap();
    let directory_second = overlay.open("dir", libc::O_RDONLY, None, true).unwrap();
    assert!(directory_first.resource.is_some());
    assert_eq!(directory_first.resource, directory_second.resource);
    assert_ne!(directory_first.value, directory_second.value);
    assert_ne!(directory_first.resource, shared);
    for (path, handle) in [
        ("same", second),
        ("same", reopened),
        ("distinct", distinct_first),
        ("distinct", distinct_second),
        ("created", created),
        ("dir", directory_first),
        ("dir", directory_second),
    ] {
        overlay.release(path, handle).unwrap();
    }
    assert_eq!(overlay.getattr("same", None).unwrap().unwrap().uid, Some(8));
}

#[test]
fn provider_resource_identity_preserves_primitives_functions_and_void_hooks() {
    let (_root, mut overlay) = fixture(
        json!([{"match":"**","root":"","opaque":true,"provider":{"module":"default"}}]),
        Some(
            r#"
            const retained=()=>{};
            let releases=0;
            export default {
                getattr(){return {kind:"file",size:0,uid:releases};},
                open({path}){return path==="function"?retained:path==="null"?null:path==="nan"?NaN:path==="void"?undefined:path;},
                release({path,handle}){
                    const expected=path==="function"?retained:path==="null"?null:path==="void"?undefined:path;
                    if(path==="nan"?!Number.isNaN(handle):handle!==expected)throw Error("Resource changed during transport");
                    releases++;
                }
            };
        "#,
        ),
    );
    for path in ["primitive", "function", "null"] {
        let first = overlay.open(path, libc::O_RDONLY, None, false).unwrap();
        let second = overlay.open(path, libc::O_RDONLY, None, false).unwrap();
        assert!(first.resource.is_some());
        assert_eq!(first.resource, second.resource);
        assert_ne!(first.value, second.value);
        let different = overlay
            .open("different", libc::O_RDONLY, None, false)
            .unwrap();
        assert_ne!(different.resource, first.resource);
        overlay.release(path, first).unwrap();
        overlay.release(path, second).unwrap();
        overlay.release("different", different).unwrap();
    }
    let void = overlay.open("void", libc::O_RDONLY, None, false).unwrap();
    assert!(void.value.is_none());
    assert!(void.resource.is_none());
    overlay.release("void", void).unwrap();
    let first_nan = overlay.open("nan", libc::O_RDONLY, None, false).unwrap();
    let second_nan = overlay.open("nan", libc::O_RDONLY, None, false).unwrap();
    assert!(first_nan.resource.is_some());
    assert!(second_nan.resource.is_some());
    assert_ne!(first_nan.resource, second_nan.resource);
    assert_ne!(first_nan.value, second_nan.value);
    overlay.release("nan", first_nan).unwrap();
    overlay.release("nan", second_nan).unwrap();
    assert_eq!(
        overlay.getattr("primitive", None).unwrap().unwrap().uid,
        Some(12)
    );
}

#[test]
fn allocations_are_discarded_when_provider_release_callbacks_are_absent() {
    let (_root, mut overlay) = fixture(
        json!([{"match":"**","root":"","opaque":true,"provider":{"module":"default"}}]),
        Some(
            r#"
            export default {
                getattr({path}){return {kind:path==="dir"?"directory":"file",size:1};},
                open(){return "file-resource";},
                opendir(){return "directory-resource";},
                read(){return "X";}
            };
        "#,
        ),
    );
    for (path, directory, op) in [("file", false, "release"), ("dir", true, "releasedir")] {
        let handle = overlay.open(path, libc::O_RDONLY, None, directory).unwrap();
        assert!(handle.value.is_some());
        assert!(handle.resource.is_some());
        assert!(!overlay.supports(handle.binding, op));
        let resource = handle.resource;
        let probe = Handle {
            binding: handle.binding,
            value: handle.value,
            resource: handle.resource,
            native: None,
            flags: handle.flags,
            captured: None,
            directory,
        };
        overlay.release(path, handle).unwrap();
        let error = overlay.read_chunk(path, 0, 1, &probe).err().unwrap();
        assert_eq!(error_code(&error), libc::EBADF);
        let reopened = overlay.open(path, libc::O_RDONLY, None, directory).unwrap();
        assert!(reopened.resource.is_some());
        assert_ne!(reopened.resource, resource);
        overlay.release(path, reopened).unwrap();
    }
}

#[test]
fn native_acquisition_rollback_discards_allocations_without_release_callbacks() {
    let (root, mut overlay) = fixture(
        json!([{"match":"**","provider":{"module":"default"}}]),
        Some(r#"export default {open(){return "resource";}};"#),
    );
    fs::write(root.path().join("source/exists"), "native").unwrap();
    let retained = overlay.open("exists", libc::O_RDONLY, None, false).unwrap();
    assert!(retained.native.is_some());
    assert!(retained.resource.is_some());
    let resource = retained.resource;
    let probe = Handle {
        binding: retained.binding,
        value: retained.value,
        resource: retained.resource,
        native: None,
        flags: retained.flags,
        captured: None,
        directory: false,
    };
    let error = overlay
        .open("missing", libc::O_RDONLY, None, false)
        .err()
        .unwrap();
    assert_eq!(error_code(&error), libc::ENOENT);
    overlay.release("exists", retained).unwrap();
    let error = overlay
        .call(
            probe.binding.unwrap(),
            "exists",
            "getattr",
            json!([]),
            Some(&probe),
            &[],
            Value::Null,
        )
        .err()
        .unwrap();
    assert_eq!(error_code(&error), libc::EBADF);
    let reopened = overlay.open("exists", libc::O_RDONLY, None, false).unwrap();
    assert!(reopened.resource.is_some());
    assert_ne!(reopened.resource, resource);
    overlay.release("exists", reopened).unwrap();
    assert_eq!(
        fs::read(root.path().join("source/exists")).unwrap(),
        b"native"
    );
}

#[test]
fn provider_errno_codes_preserve_actionable_native_errors() {
    for (code, expected) in [
        ("EDQUOT", libc::EDQUOT),
        ("ENFILE", libc::ENFILE),
        ("ENOMEM", libc::ENOMEM),
        ("EINTR", libc::EINTR),
        ("EAGAIN", libc::EAGAIN),
        ("EWOULDBLOCK", libc::EAGAIN),
        ("ENAMETOOLONG", libc::ENAMETOOLONG),
        ("ERANGE", libc::ERANGE),
        ("ETIMEDOUT", libc::ETIMEDOUT),
        ("UNKNOWN_PROVIDER_CODE", libc::EIO),
    ] {
        let (_root, mut overlay) = fixture(
            json!([{"match":"file","opaque":true,"provider":{"module":"default","options":{"code":code}}}]),
            Some(
                r#"
                export default {
                    getattr(){return {kind:"file",size:1};},
                    write(bytes,position,{options}){throw Object.assign(Error("operation failed"),{code:options.code});}
                };
            "#,
            ),
        );
        let handle = overlay.open("file", libc::O_RDWR, None, false).unwrap();
        let error = overlay.write_chunk("file", b"X", 0, &handle).unwrap_err();
        assert_eq!(error_code(&error), expected);
        assert_eq!(
            error
                .downcast_ref::<ProviderError>()
                .unwrap()
                .code
                .as_deref(),
            Some(code)
        );
        overlay.release("file", handle).unwrap();
    }
}

#[test]
fn provider_context_preserves_absent_null_and_literal_options() {
    for (options, actual_type, effective) in [
        (None, "undefined", json!("default-options")),
        (Some(Value::Null), "object", Value::Null),
        (Some(json!({"$date":1234})), "object", json!({"$date":1234})),
        (Some(json!(false)), "boolean", json!(false)),
        (Some(json!(0)), "number", json!(0)),
        (Some(json!("")), "string", json!("")),
        (
            Some(json!([null, {"$date":1234}])),
            "object",
            json!([null, {"$date":1234}]),
        ),
    ] {
        let (_root, mut overlay) = fixture(
            json!([{"match":"file","opaque":true,"provider":{"module":"default"}}]),
            Some(
                r#"
                export default {
                    getattr(context) {
                        const {options = "default-options"} = context;
                        return {
                            kind: "file",
                            size: 1,
                            identity: JSON.stringify({actualType: typeof context.options, options})
                        };
                    }
                };
            "#,
            ),
        );
        overlay.rules[0].rule.provider.as_mut().unwrap().options = options.clone();
        assert_eq!(overlay.context(0, "file").get("options"), options.as_ref());
        let response = overlay
            .call(0, "file", "getattr", json!([]), None, &[], Value::Null)
            .unwrap();
        assert_eq!(
            response.value,
            json!({
                "kind":"file",
                "size":1,
                "identity":json!({"actualType":actual_type,"options":effective}).to_string()
            })
        );
        assert_eq!(
            overlay.getattr("file", None).unwrap().unwrap().size,
            Some(1)
        );
    }
}
