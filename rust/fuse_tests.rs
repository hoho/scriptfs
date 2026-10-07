use super::*;
use crate::overlay::tests::fixture;
use std::fs;

fn lookup(core: &mut Core, path: &str) -> u64 {
    let metadata = core.overlay.getattr(path, None).unwrap().unwrap();
    core.observe(path, metadata, true)
}

#[test]
fn whole_file_partial_reads_reuse_the_buffer_without_synthetic_revisions() {
    let (root, overlay) = fixture(
        json!([{"match":"file","opaque":true,"provider":{"module":"default"}}]),
        Some(
            r#"
            import {appendFileSync} from "node:fs";
            import path from "node:path";
            const bytes = Buffer.alloc(2 * 1024 * 1024, 17);
            export default {
                getattr() { return {kind:"file",identity:"file",size:bytes.length}; },
                readFile({sourcePath}) {
                    appendFileSync(path.join(sourcePath,"..","trace"),"read\n");
                    return bytes;
                },
            };
        "#,
        ),
    );
    let mut core = Core::new(overlay).unwrap();
    let ino = lookup(&mut core, "file");
    let fh = core.open(ino, libc::O_RDONLY, None, false).unwrap();
    core.with_handle(fh, |c, h| {
        let pointer = c.contents(h, false)?.as_ptr();
        assert_eq!(pointer, c.nodes[&ino].contents.as_ref().unwrap().as_ptr());
        Ok(())
    })
    .unwrap();
    let pointer = core.nodes[&ino].contents.as_ref().unwrap().as_ptr();
    for index in 0..256 {
        assert_eq!(core.read(fh, index * 4096, 4096).unwrap(), vec![17; 4096]);
        assert_eq!(
            core.nodes[&ino].contents.as_ref().unwrap().as_ptr(),
            pointer
        );
    }
    assert_eq!(
        fs::read_to_string(root.path().join("source/trace")).unwrap(),
        "read\n"
    );
    core.shutdown().unwrap();
}

#[test]
fn whole_file_cache_still_tracks_explicit_revisions_sizes_and_identity() {
    let (root, overlay) = fixture(
        json!([{"match":"file","opaque":true,"provider":{"module":"default"}}]),
        Some(
            r#"
            import {readFileSync,appendFileSync} from "node:fs";
            import path from "node:path";
            const control = c => JSON.parse(readFileSync(path.join(c.sourcePath,"..","control")));
            export default {
                getattr(c) {
                    const {bytes,time,identity} = control(c);
                    return {kind:"file",identity,size:bytes.length,mtime:new Date(time)};
                },
                readFile(c) {
                    appendFileSync(path.join(c.sourcePath,"..","trace"),"read\n");
                    return Buffer.from(control(c).bytes);
                },
            };
        "#,
        ),
    );
    let control = root.path().join("source/control");
    let update = |bytes: &str, time: i64, identity: &str| {
        fs::write(
            &control,
            json!({"bytes":bytes,"time":time,"identity":identity}).to_string(),
        )
        .unwrap();
    };
    update("ORIGINAL", 1000, "original");
    let mut core = Core::new(overlay).unwrap();
    let ino = lookup(&mut core, "file");
    let fh = core.open(ino, libc::O_RDONLY, None, false).unwrap();
    assert_eq!(core.read(fh, 0, 32).unwrap(), b"ORIGINAL");
    assert_eq!(core.read(fh, 0, 32).unwrap(), b"ORIGINAL");
    update("MODIFIED", 2000, "original");
    assert_eq!(core.read(fh, 0, 32).unwrap(), b"MODIFIED");
    update("SHORT", 2000, "original");
    assert_eq!(core.read(fh, 0, 32).unwrap(), b"SHORT");
    update("REPLACED", 3000, "replacement");
    assert_eq!(error_code(&core.read(fh, 0, 32).unwrap_err()), libc::ESTALE);
    assert_eq!(
        fs::read_to_string(root.path().join("source/trace")).unwrap(),
        "read\nread\nread\n"
    );
    update("SHORT", 2000, "original");
    core.shutdown().unwrap();
}

#[test]
fn whole_file_buffered_writes_update_the_existing_allocation() {
    let (_root, overlay) = fixture(
        json!([{"match":"file","opaque":true,"provider":{"module":"default"}}]),
        Some(
            r#"
            let bytes = Buffer.alloc(2 * 1024 * 1024, 17);
            export default {
                getattr() { return {kind:"file",size:bytes.length}; },
                readFile() { return bytes; },
                writeFile(next) { bytes = next; },
            };
        "#,
        ),
    );
    let mut core = Core::new(overlay).unwrap();
    let ino = lookup(&mut core, "file");
    let fh = core.open(ino, libc::O_RDWR, None, false).unwrap();
    core.read(fh, 0, 4).unwrap();
    let pointer = core.nodes[&ino].contents.as_ref().unwrap().as_ptr();
    for index in 0..16 {
        core.write(fh, index * 4096, &[19; 4096]).unwrap();
        assert_eq!(
            core.nodes[&ino].contents.as_ref().unwrap().as_ptr(),
            pointer
        );
    }
    assert_eq!(core.read(fh, 0, 65536).unwrap(), vec![19; 65536]);
    core.shutdown().unwrap();
}

#[test]
fn native_alias_discovered_after_external_removal_keeps_its_inode() {
    let (root, overlay) = fixture(json!([]), None);
    let source = root.path().join("source");
    fs::write(source.join("first"), "ORIGINAL").unwrap();
    let mut core = Core::new(overlay).unwrap();
    let ino = lookup(&mut core, "first");
    let first = core.open(ino, libc::O_RDWR, None, false).unwrap();
    fs::hard_link(source.join("first"), source.join("second")).unwrap();
    fs::remove_file(source.join("first")).unwrap();
    assert_eq!(lookup(&mut core, "second"), ino);
    assert_eq!(core.metadata(ino).unwrap().size, Some(8));
    let second = core.open(ino, libc::O_RDWR, None, false).unwrap();
    core.write(second, 0, b"CHANGED!").unwrap();
    assert_eq!(core.read(first, 0, 8).unwrap(), b"CHANGED!");
    core.shutdown().unwrap();
}

#[test]
fn listing_only_inodes_are_retained_only_while_snapshots_reference_them() {
    let (root, overlay) = fixture(json!([]), None);
    fs::write(root.path().join("source/file"), "data").unwrap();
    let mut core = Core::new(overlay).unwrap();
    let metadata = core.overlay.getattr("file", None).unwrap().unwrap();
    let ino = core.observe("file", metadata, false);
    let directory = core.open(1, libc::O_RDONLY, None, true).unwrap();
    core.handles.get_mut(&directory).unwrap().entries =
        Some(vec![("file".into(), FileType::RegularFile, ino)]);
    core.discard(ino);
    assert!(core.nodes.contains_key(&ino));
    core.handles.get_mut(&directory).unwrap().entries = None;
    core.discard(ino);
    assert!(!core.nodes.contains_key(&ino));
    assert!(!core.paths.contains_key("file"));
    core.shutdown().unwrap();
}

#[test]
fn whole_file_buffers_update_all_open_resource_sizes() {
    let (_root, overlay) = fixture(
        json!([{"match":"file","opaque":true,"provider":{"module":"default"}}]),
        Some(
            r#"
            let contents = Buffer.from("old");
            export default {
                getattr() { return {kind:"file",identity:"shared",size:contents.length}; },
                open() { return {}; },
                readFile() { return contents; },
                writeFile(next) { contents = next; },
            };
        "#,
        ),
    );
    let mut core = Core::new(overlay).unwrap();
    let ino = lookup(&mut core, "file");
    let first = core.open(ino, libc::O_RDWR, None, false).unwrap();
    let second = core.open(ino, libc::O_RDWR, None, false).unwrap();
    core.write(first, 0, b"EXTENDED").unwrap();
    let third = core.open(ino, libc::O_RDWR, None, false).unwrap();
    core.flush_node(ino).unwrap();
    for fh in [first, second, third] {
        assert_eq!(
            core.with_handle(fh, |c, h| c.handle_metadata(h))
                .unwrap()
                .size,
            Some(8)
        );
        assert_eq!(core.read(fh, 0, 20).unwrap(), b"EXTENDED");
    }
    core.shutdown().unwrap();
}

#[test]
fn partial_descriptor_metadata_retains_the_opened_identity() {
    let (root, overlay) = fixture(
        json!([{"match":"file","provider":{"module":"default"}}]),
        Some(
            r#"
            import { open } from "node:fs/promises";
            export default {
                open({sourcePath}) { return open(sourcePath, "r+"); },
                async fgetattr({handle}) { return {kind:"file",size:(await handle.stat()).size}; },
                async read(position,length,{handle}) {
                    const bytes=Buffer.alloc(length);
                    const {bytesRead}=await handle.read(bytes,0,length,position);
                    return bytes.subarray(0,bytesRead);
                },
                release({handle}) { return handle.close(); },
            };
        "#,
        ),
    );
    fs::write(root.path().join("source/file"), "ORIGINAL").unwrap();
    let mut core = Core::new(overlay).unwrap();
    let ino = lookup(&mut core, "file");
    let identity = core.nodes[&ino].metadata.identity.clone();
    let fh = core.open(ino, libc::O_RDWR, None, false).unwrap();
    assert_eq!(
        core.with_handle(fh, |c, h| c.handle_metadata(h))
            .unwrap()
            .identity,
        identity
    );
    fs::remove_file(root.path().join("source/file")).unwrap();
    fs::write(root.path().join("source/file"), "NEW").unwrap();
    assert_eq!(core.read(fh, 0, 8).unwrap(), b"ORIGINAL");
    core.shutdown().unwrap();
}

#[test]
fn last_alias_removal_prunes_externally_removed_names_before_snapshotting() {
    let (root, overlay) = fixture(
        json!([{"match":"*","opaque":true,"provider":{"module":"default"}}]),
        Some(
            r#"
            import {stat,readFile,writeFile,unlink} from "node:fs/promises";
            export default {
                async getattr({sourcePath}) {
                    try {
                        const s=await stat(sourcePath);
                        return {kind:"file",identity:`${s.dev}:${s.ino}`,size:s.size,nlink:s.nlink};
                    } catch(error) { if(error.code==="ENOENT")return; throw error; }
                },
                readFile({sourcePath}) { return readFile(sourcePath); },
                writeFile(contents,{sourcePath}) { return writeFile(sourcePath,contents); },
                unlink({sourcePath}) { return unlink(sourcePath); },
            };
        "#,
        ),
    );
    let source = root.path().join("source");
    fs::write(source.join("first"), "ORIGINAL").unwrap();
    fs::hard_link(source.join("first"), source.join("second")).unwrap();
    let mut core = Core::new(overlay).unwrap();
    let ino = lookup(&mut core, "first");
    assert_eq!(lookup(&mut core, "second"), ino);
    let first = core.open(ino, libc::O_RDWR, None, false).unwrap();
    let second = core.open(ino, libc::O_RDWR, None, false).unwrap();
    fs::remove_file(source.join("first")).unwrap();
    core.remove("second", false).unwrap();
    assert!(core.nodes[&ino].detached);
    assert_eq!(core.read(first, 0, 8).unwrap(), b"ORIGINAL");
    core.write(first, 0, b"UPDATED!").unwrap();
    core.flush_node(ino).unwrap();
    assert_eq!(core.read(second, 0, 8).unwrap(), b"UPDATED!");
    assert!(!source.join("first").exists());
    core.shutdown().unwrap();
}

#[test]
fn changed_generated_symlink_target_gets_a_new_inode() {
    let (_root, overlay) = fixture(
        json!([
            {"match":"Link","opaque":true,"provider":{"module":"default"}},
            {"match":"Change","opaque":true,"provider":{"module":"change"}}
        ]),
        Some(
            r#"
            let target="original-target";
            export default {getattr(){return {kind:"symlink",identity:"link",target,size:target.length};}};
            export const change={
                getattr(){return {kind:"file",size:0};},
                writeFile(contents){target=contents.toString();}
            };
        "#,
        ),
    );
    let mut core = Core::new(overlay).unwrap();
    let original = lookup(&mut core, "Link");
    core.overlay
        .write_file("Change", b"changed-target", None, false)
        .unwrap();
    assert_eq!(
        core.metadata(original).unwrap().target.as_deref(),
        Some("original-target")
    );
    assert_ne!(lookup(&mut core, "Link"), original);
    assert_eq!(
        core.nodes[&original].metadata.target.as_deref(),
        Some("original-target")
    );
    core.shutdown().unwrap();
}
