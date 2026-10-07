use super::*;
use crate::overlay::tests::fixture;
use std::{fs, path::Path};

const BACKED: &str = r#"
import {stat,readFile,writeFile,truncate,unlink,rename,open,appendFile,mkdir,rmdir} from "node:fs/promises";
import path from "node:path";
const trace=(context,event,...values)=>appendFile(path.join(context.sourcePath,"..","trace.jsonl"),JSON.stringify([event,...values])+"\n");
async function getattr({sourcePath}) {
    try {const s=await stat(sourcePath);return {kind:s.isDirectory()?"directory":"file",identity:`${s.dev}:${s.ino}`,size:s.size,nlink:s.nlink,mode:s.mode,mtime:s.mtime,ctime:s.ctime};}
    catch(e){if(e.code==="ENOENT")return;throw e;}
}
const base={getattr,unlink:({sourcePath})=>unlink(sourcePath),rmdir:({sourcePath})=>rmdir(sourcePath),
    rename:({sourcePath,destinationPath})=>rename(sourcePath,path.join(path.dirname(sourcePath),destinationPath)),
    truncate:(size,{sourcePath})=>truncate(sourcePath,size)};
export const whole={...base,readFile:({sourcePath})=>readFile(sourcePath),writeFile:(bytes,{sourcePath})=>writeFile(sourcePath,bytes)};
export const wholeTruncate={...whole,ftruncate:(size,{sourcePath})=>truncate(sourcePath,size)};
export const positional={...base,
    read:async(position,length,{sourcePath})=>(await readFile(sourcePath)).subarray(position,position+length),
    write:async(bytes,position,{sourcePath})=>{const h=await open(sourcePath,"r+");try{return (await h.write(bytes,0,bytes.length,position)).bytesWritten;}finally{await h.close();}}};
export const resource={...base,
    open:({sourcePath,flags})=>open(sourcePath,flags&~512),
    create:(_,{sourcePath,flags})=>open(sourcePath,flags|64),
    fgetattr:async({handle})=>{const s=await handle.stat();return {kind:"file",identity:`${s.dev}:${s.ino}`,size:s.size,nlink:s.nlink,mode:s.mode};},
    read:async(position,length,{handle})=>{const b=Buffer.alloc(length);const r=await handle.read(b,0,length,position);return b.subarray(0,r.bytesRead);},
    write:async(bytes,position,{handle})=>(await handle.write(bytes,0,bytes.length,position)).bytesWritten,
    ftruncate:(size,{handle})=>handle.truncate(size),release:({handle})=>handle.close()};
export const mixed={...resource,write:undefined,writeFile:whole.writeFile};
export default whole;
"#;

fn provider(module: &str) -> (tempfile::TempDir, Core) {
    provider_rules(
        json!([{"match":"**","opaque":true,"provider":{"module":"default"}}]),
        module,
    )
}
fn provider_rules(rules: Value, module: &str) -> (tempfile::TempDir, Core) {
    let (root, overlay) = fixture(rules, Some(module));
    (root, Core::new(overlay).unwrap())
}
fn backed(export: &str) -> (tempfile::TempDir, Core) {
    provider_rules(
        json!([{"match":"**","opaque":true,"provider":{"module":export}}]),
        BACKED,
    )
}
fn native() -> (tempfile::TempDir, Core) {
    let (root, overlay) = fixture(json!([]), None);
    (root, Core::new(overlay).unwrap())
}
fn put(root: &Path, name: &str, bytes: &[u8]) {
    fs::write(root.join("source").join(name), bytes).unwrap();
}
fn disk(root: &Path, name: &str) -> Vec<u8> {
    fs::read(root.join("source").join(name)).unwrap()
}
fn opened(core: &mut Core, path: &str, flags: i32) -> (u64, u64) {
    let ino = core.lookup_node(path).unwrap();
    let fh = core.open_file(ino, flags).unwrap();
    (ino, fh)
}
fn code<T>(result: Result<T>, expected: i32) {
    match result {
        Ok(_) => panic!("expected errno {expected}, operation succeeded"),
        Err(e) => assert_eq!(failure(e), expected),
    }
}
fn truncate_handle(core: &mut Core, fh: u64, size: u64) -> Result<Metadata> {
    let ino = core.handles[&fh].ino;
    core.set_attributes(ino, Some(fh), Some(size), &json!({}))
}
fn trace(root: &Path) -> Vec<Value> {
    let text = fs::read_to_string(root.join("source/trace.jsonl")).unwrap_or_default();
    text.lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
fn replace(root: &Path, path: &str, contents: &[u8]) {
    put(root, "incoming", contents);
    fs::rename(root.join("source/incoming"), root.join("source").join(path)).unwrap();
}

#[test]
fn zero_cache_ttl() {
    assert_eq!(TTL, Duration::ZERO);
    let (root, mut core) = native();
    put(root.path(), "data", b"old");
    let ino = core.lookup_node("data").unwrap();
    put(root.path(), "data", b"changed");
    assert_eq!(attr(ino, &core.attributes(ino, None).unwrap()).size, 7);
}

fn ownership(uid: u32, gid: u32) {
    let (root, mut core) = provider(
        r#"
        import {appendFile} from "node:fs/promises";import path from "node:path";
        export default {getattr(){return {kind:"file",size:0};},
            chown(uid,gid,c){return appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify([uid,gid])+"\n");}};
    "#,
    );
    let ino = core.lookup_node("data").unwrap();
    core.set_attributes(ino, None, None, &json!({"uid":uid,"gid":gid}))
        .unwrap();
    assert_eq!(
        trace(root.path()),
        vec![json!([
            if uid == u32::MAX { -1i64 } else { uid as i64 },
            if gid == u32::MAX { -1i64 } else { gid as i64 }
        ])]
    );
}
#[test]
fn preserves_ownership_sentinel_and_unsigned_ids_123_4294967295() {
    ownership(123, u32::MAX);
}
#[test]
fn preserves_ownership_sentinel_and_unsigned_ids_4294967295_456() {
    ownership(u32::MAX, 456);
}
#[test]
fn preserves_ownership_sentinel_and_unsigned_ids_4294967295_4294967295() {
    ownership(u32::MAX, u32::MAX);
}
#[test]
fn signed_sentinels_native_equivalent() {
    ownership((-1i32) as u32, (-1i32) as u32);
}
#[test]
fn preserves_ownership_sentinel_and_unsigned_ids_2147483648_4294967294() {
    ownership(0x80000000, 0xfffffffe);
}
#[test]
fn preserves_ownership_sentinel_and_unsigned_ids_0_0() {
    ownership(0, 0);
}
#[test]
fn late_resource_is_released() {
    let (root, mut core) = provider(
        r#"
        import {appendFile} from "node:fs/promises";import path from "node:path";
        export default {getattr(){return {kind:"file",size:0};},
            async open(){await new Promise(r=>setTimeout(r,40));return {retained:true};},
            release(c){return appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify(c.handle)+"\n");}};
    "#,
    );
    let (_, fh) = opened(&mut core, "data", libc::O_RDONLY);
    core.release_handle(fh, false).unwrap();
    assert_eq!(trace(root.path()), vec![json!({"retained":true})]);
    assert!(core.handles.is_empty());
}
const MEMORY: &str = r#"
    import {readFile,writeFile,appendFile} from "node:fs/promises";import path from "node:path";
    let contents=new Map();
    export default {
        getattr({path:p}){const b=contents.get(p);return b&&{kind:"file",size:b.length};},
        readFile({path:p}){const b=contents.get(p);if(!b)throw Object.assign(new Error("missing"),{code:"ENOENT"});return b;},
        async writeFile(b,c){contents.set(c.path,Buffer.from(b));await appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify([c.path,b.toString(),c.previousContents?.toString()??null])+"\n");}
    };
"#;
#[test]
fn materializes_create() {
    let (root, mut core) = provider(MEMORY);
    let (ino, fh) = core.create_file("empty", 0o644, libc::O_RDWR).unwrap();
    assert_eq!(core.attributes(ino, Some(fh)).unwrap().size, Some(0));
    assert_eq!(trace(root.path()), vec![json!(["empty", "", null])]);
    core.write(fh, 0, b"created").unwrap();
    core.sync_handle(fh, "flush", false).unwrap();
    let (_, reader) = opened(&mut core, "empty", libc::O_RDONLY);
    assert_eq!(core.read(reader, 0, 7).unwrap(), b"created");
    core.shutdown().unwrap();
}
fn direct_create(create: bool) {
    let (_root, mut core) = provider(
        r#"
        let exists=false;
        export default {getattr({path}){if(path==="data"||exists)return {kind:"file",size:16,seekable:false};},
            create(){exists=true;return {};},read(_p,n){return Buffer.alloc(n,"X");}};
    "#,
    );
    let (_, fh) = if create {
        core.create_file("new", 0o644, libc::O_RDWR).unwrap()
    } else {
        opened(&mut core, "data", libc::O_RDONLY)
    };
    assert!(core.direct_io(fh));
    assert_eq!(core.read(fh, 0, 2).unwrap(), b"XX");
    code(core.read(fh, 0, 2), libc::ESPIPE);
    core.shutdown().unwrap();
}
#[test]
fn requests_direct_i_o_for_non_seekable_open_handles() {
    direct_create(false);
}
#[test]
fn requests_direct_i_o_for_non_seekable_create_handles() {
    direct_create(true);
}
fn create_flags(flags: i32) {
    let (root, mut core) = provider(
        r#"
        import {appendFile} from "node:fs/promises";import path from "node:path";let exists=false;
        const t=(c,e)=>appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify([e,c.flags,c.handle?.resource])+"\n");
        export default {getattr(){if(exists)return {kind:"file",size:0};},
            async create(_m,c){exists=true;await t(c,"create");return {resource:true};},
            read(){return Buffer.alloc(0);},write(b){return b.length;},release(c){return t(c,"release");}};
    "#,
    );
    let (_, fh) = core.create_file("data", 0o644, flags).unwrap();
    assert_eq!(core.handles[&fh].provider.flags, flags);
    if flags & libc::O_ACCMODE == libc::O_RDONLY {
        code(core.write(fh, 0, b"X"), libc::EBADF);
    } else {
        assert_eq!(core.write(fh, 0, b"X").unwrap(), 1);
    }
    if flags & libc::O_ACCMODE == libc::O_WRONLY {
        code(core.read(fh, 0, 1), libc::EBADF);
    } else {
        assert!(core.read(fh, 0, 1).unwrap().is_empty());
    }
    core.release_handle(fh, false).unwrap();
    assert_eq!(
        trace(root.path()),
        vec![
            json!(["create", flags, null]),
            json!(["release", flags, true])
        ]
    );
}
#[test]
fn preserves_create_flags_0_through_provider_callbacks_and_access_checks() {
    create_flags(0);
}
#[test]
fn preserves_create_flags_1_through_provider_callbacks_and_access_checks() {
    create_flags(1);
}
#[test]
fn preserves_create_flags_2_through_provider_callbacks_and_access_checks() {
    create_flags(2);
}
#[test]
fn preserves_create_flags_3_through_provider_callbacks_and_access_checks() {
    create_flags(1 | 0x400);
}
#[test]
fn preserves_create_flags_4_through_provider_callbacks_and_access_checks() {
    create_flags(1 | 0x101000);
}
fn short_reads(seekable: bool) {
    let module = format!(
        r#"
        import {{appendFile}} from "node:fs/promises";import path from "node:path";
        const bytes=Buffer.from("abcdef");
        export default {{getattr(){{return {{kind:"file",size:6,seekable:{seekable}}};}},
            async read(p,n,c){{await appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify(p)+"\n");return bytes.subarray(p,p+Math.min(n,2));}}}};
    "#
    );
    let (root, mut core) = provider(&module);
    let (_, fh) = opened(&mut core, "data", libc::O_RDONLY);
    assert_eq!(core.direct_io(fh), !seekable);
    assert_eq!(
        core.read(fh, 0, 10).unwrap(),
        if seekable { &b"abcdef"[..] } else { &b"ab"[..] }
    );
    assert_eq!(
        trace(root.path()),
        if seekable {
            vec![json!(0), json!(2), json!(4), json!(6)]
        } else {
            vec![json!(0)]
        }
    );
    assert_eq!(
        core.read(fh, if seekable { 6 } else { 2 }, 4).unwrap(),
        if seekable { &b""[..] } else { &b"cd"[..] }
    );
    core.shutdown().unwrap();
}
#[test]
fn handles_short_positional_reads_without_changing_direct_i_o_behavior_seekable_true() {
    short_reads(true);
}
#[test]
fn handles_short_positional_reads_without_changing_direct_i_o_behavior_seekable_false() {
    short_reads(false);
}
#[test]
fn propagates_errors_while_completing_a_short_cached_read() {
    let (_root, mut core) = provider(
        r#"export default {getattr(){return {kind:"file",size:6};},read(p){if(p)throw Object.assign(new Error("read failed"),{code:"EACCES"});return Buffer.from("ab");}};"#,
    );
    let (_, fh) = opened(&mut core, "data", 0);
    code(core.read(fh, 0, 6), libc::EACCES);
    core.shutdown().unwrap();
}
#[test]
fn preserves_retained_bytes_when_ftruncate_precedes_the_first_read() {
    let (root, mut core) = native();
    put(root.path(), "data", b"abcdef");
    let (_, fh) = opened(&mut core, "data", 2);
    truncate_handle(&mut core, fh, 4).unwrap();
    assert_eq!(core.read(fh, 0, 4).unwrap(), b"abcd");
    core.write(fh, 3, b"Z").unwrap();
    core.sync_handle(fh, "flush", false).unwrap();
    assert_eq!(disk(root.path(), "data"), b"abcZ");
    core.shutdown().unwrap();
}
#[test]
fn native_inode_registry_lifetime() {
    let (_root, mut core) = provider(
        r#"let id="first";export default {getattr({path}){if(path==="switch")id="second";return {kind:"file",identity:id,size:0};}};"#,
    );
    let first = core.lookup_node("data").unwrap();
    assert_eq!(core.lookup_node("data").unwrap(), first);
    core.lookup_node("switch").unwrap();
    assert_ne!(core.lookup_node("data").unwrap(), first);
    assert_ne!(first, 0);
    core.nodes.get_mut(&first).unwrap().lookups = 0;
    core.discard(first);
    assert!(!core.identities.contains_key("first"));
}
#[test]
fn preserves_source_writes_with_lifecycle_only_open_hooks_when_truncating() {
    let (root, mut core) = provider_rules(
        json!([{"match":"**","provider":{"module":"default"}}]),
        r#"
        import {appendFile} from "node:fs/promises";import path from "node:path";
        const t=(c,e)=>appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify([e,c.handle.opened])+"\n");
        export default {open(){return {opened:true};},fsync(_d,c){return t(c,"sync");},release(c){return t(c,"release");}};
    "#,
    );
    put(root.path(), "data", b"0000");
    let (_, fh) = opened(&mut core, "data", 2);
    core.write(fh, 0, b"A").unwrap();
    truncate_handle(&mut core, fh, 3).unwrap();
    core.sync_handle(fh, "fsync", false).unwrap();
    assert_eq!(disk(root.path(), "data"), b"A00");
    core.release_handle(fh, false).unwrap();
    assert_eq!(
        trace(root.path()),
        vec![json!(["sync", true]), json!(["release", true])]
    );
}
#[test]
fn shares_source_data_between_create_only_lifecycle_hooks_and_subsequent_native_opens() {
    let (root, mut core) = provider_rules(
        json!([{"match":"**","provider":{"module":"default"}}]),
        r#"import {writeFile} from "node:fs/promises";export default {create(_m,{sourcePath}){return writeFile(sourcePath,"");}};"#,
    );
    let (_, first) = core.create_file("data", 0o644, 2).unwrap();
    core.write(first, 0, b"A").unwrap();
    let (_, second) = opened(&mut core, "data", 2);
    assert_eq!(core.read(second, 0, 1).unwrap(), b"A");
    core.write(second, 1, b"B").unwrap();
    core.shutdown().unwrap();
    assert_eq!(disk(root.path(), "data"), b"AB");
}
#[test]
fn opens_source_files_during_create_with_open_only_lifecycle_hooks() {
    let (root, mut core) = provider_rules(
        json!([{"match":"**","provider":{"module":"default"}}]),
        r#"import {appendFile} from "node:fs/promises";import path from "node:path";export default {open(c){return appendFile(path.join(c.sourcePath,"..","trace.jsonl"),"true\n");}};"#,
    );
    let (_, fh) = core.create_file("data", 0o644, 2).unwrap();
    core.write(fh, 0, b"created").unwrap();
    core.sync_handle(fh, "flush", false).unwrap();
    assert_eq!(disk(root.path(), "data"), b"created");
    assert_eq!(trace(root.path()), vec![json!(true)]);
    core.shutdown().unwrap();
}
#[test]
fn directory_resources() {
    let (root, mut core) = provider_rules(
        json!([{"match":"**","provider":{"module":"default"}}]),
        r#"
        import {appendFile} from "node:fs/promises";import path from "node:path";let calls=0;
        const t=(c,e)=>appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify([e,c.path,c.handle.directory])+"\n");
        export default {opendir(){return {directory:true};},async fsyncdir(_d,c){if(calls++===1)throw Object.assign(new Error("denied"),{code:"EACCES"});if(calls===3)throw Object.assign(new Error("unsupported"),{code:"ENOSYS"});await t(c,"sync");},releasedir(c){return t(c,"release");}};
    "#,
    );
    fs::create_dir(root.path().join("source/before")).unwrap();
    let ino = core.lookup_node("before").unwrap();
    let fh = core.open(ino, 0, None, true).unwrap();
    core.rename("before", "after", 0).unwrap();
    core.sync_handle(fh, "fsyncdir", false).unwrap();
    code(core.sync_handle(fh, "fsyncdir", false), libc::EACCES);
    code(core.sync_handle(fh, "fsyncdir", false), libc::EOPNOTSUPP);
    core.release_handle(fh, true).unwrap();
    assert_eq!(
        trace(root.path()),
        vec![
            json!(["sync", "after", true]),
            json!(["release", "after", true])
        ]
    );
    code(core.sync_handle(fh, "fsyncdir", false), libc::EBADF);
}
#[test]
fn opens_synthetic_ancestors_but_rejects_unsupported_virtual_directory_synchronization() {
    let (_root, mut core) = provider_rules(
        json!([{"match":"Nested/Deep/**","root":"Nested/Deep","opaque":true,"provider":{"module":"default"}}]),
        r#"export default {getattr(){return {kind:"directory"};}};"#,
    );
    for path in ["Nested", "Nested/Deep"] {
        let ino = core.lookup_node(path).unwrap();
        let fh = core.open(ino, 0, None, true).unwrap();
        code(core.sync_handle(fh, "fsyncdir", false), libc::EOPNOTSUPP);
        core.release_handle(fh, true).unwrap();
    }
}
#[test]
fn does_not_zero_the_next_reader_after_pathname_truncation() {
    let (root, mut core) = native();
    put(root.path(), "data", b"abcdef");
    let ino = core.lookup_node("data").unwrap();
    core.truncate(ino, 4, None).unwrap();
    let (_, fh) = opened(&mut core, "data", 0);
    assert_eq!(core.read(fh, 0, 4).unwrap(), b"abcd");
    core.shutdown().unwrap();
}
#[test]
fn invalidates_a_completed_clean_truncate_when_the_backing_file_changes() {
    let (root, mut core) = native();
    put(root.path(), "data", b"abcdef");
    let ino = core.lookup_node("data").unwrap();
    core.truncate(ino, 4, None).unwrap();
    put(root.path(), "data", b"NEW DATA");
    let (_, fh) = opened(&mut core, "data", 2);
    assert_eq!(core.read(fh, 0, 8).unwrap(), b"NEW DATA");
    core.write(fh, 0, b"X").unwrap();
    core.shutdown().unwrap();
    assert_eq!(disk(root.path(), "data"), b"XEW DATA");
}
fn noop_truncate(operation: &str) {
    let module = format!(
        r#"{BACKED}
        whole.truncate=undefined;const originalWrite=whole.writeFile;
        whole.writeFile=async(b,c)=>{{await appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify(b.toString())+"\n");return originalWrite(b,c);}};
    "#
    );
    let (root, mut core) = provider_rules(
        json!([{"match":"**","opaque":true,"provider":{"module":"whole"}}]),
        &module,
    );
    put(root.path(), "data", b"");
    let ino = core.lookup_node("data").unwrap();
    let fh = if operation == "pathname" {
        core.truncate(ino, 0, None).unwrap();
        core.open_file(ino, 2).unwrap()
    } else {
        let fh = core
            .open_file(
                ino,
                2 | if operation == "open" {
                    libc::O_TRUNC
                } else {
                    0
                },
            )
            .unwrap();
        if operation == "descriptor" {
            truncate_handle(&mut core, fh, 0).unwrap();
        }
        fh
    };
    assert!(!core.nodes[&ino].dirty);
    assert!(trace(root.path()).is_empty());
    put(root.path(), "data", b"ABCDE");
    assert_eq!(core.read(fh, 0, 5).unwrap(), b"ABCDE");
    core.write(fh, 1, b"X").unwrap();
    core.sync_handle(fh, "flush", false).unwrap();
    assert_eq!(disk(root.path(), "data"), b"AXCDE");
    assert_eq!(trace(root.path()), vec![json!("AXCDE")]);
    core.shutdown().unwrap();
}
#[test]
fn refreshes_whole_file_contents_after_a_no_op_zero_truncate_through_pathname() {
    noop_truncate("pathname");
}
#[test]
fn refreshes_whole_file_contents_after_a_no_op_zero_truncate_through_descriptor() {
    noop_truncate("descriptor");
}
#[test]
fn refreshes_whole_file_contents_after_a_no_op_zero_truncate_through_open() {
    noop_truncate("open");
}
#[test]
fn retains_zero_padding_after_extending_a_dirty_newly_created_file() {
    let (root, mut core) = native();
    let (ino, fh) = core.create_file("data", 0o644, 2).unwrap();
    core.write(fh, 0, b"abc").unwrap();
    truncate_handle(&mut core, fh, 6).unwrap();
    assert_eq!(core.attributes(ino, Some(fh)).unwrap().size, Some(6));
    assert_eq!(core.read(fh, 0, 6).unwrap(), b"abc\0\0\0");
    core.sync_handle(fh, "flush", false).unwrap();
    assert_eq!(disk(root.path(), "data"), b"abc\0\0\0");
    core.shutdown().unwrap();
}
#[test]
fn shares_buffered_contents_between_handles_without_losing_disjoint_writes() {
    let (root, mut core) = backed("whole");
    put(root.path(), "data", b"0000");
    let (_, a) = opened(&mut core, "data", 2);
    let (_, b) = opened(&mut core, "data", 2);
    assert_eq!(core.read(a, 0, 4).unwrap(), b"0000");
    assert_eq!(core.read(b, 0, 4).unwrap(), b"0000");
    core.write(a, 0, b"A").unwrap();
    core.sync_handle(a, "flush", false).unwrap();
    core.write(b, 1, b"B").unwrap();
    core.sync_handle(b, "flush", false).unwrap();
    assert_eq!(disk(root.path(), "data"), b"AB00");
    core.shutdown().unwrap();
}
#[test]
fn refreshes_clean_shared_buffers_when_a_backing_file_changes_before_a_new_open() {
    let (root, mut core) = backed("whole");
    put(root.path(), "data", b"old");
    let (_, a) = opened(&mut core, "data", 2);
    assert_eq!(core.read(a, 0, 3).unwrap(), b"old");
    put(root.path(), "data", b"new contents");
    assert_eq!(core.read(a, 0, 12).unwrap(), b"new contents");
    let (_, b) = opened(&mut core, "data", 2);
    assert_eq!(core.read(b, 0, 12).unwrap(), b"new contents");
    core.shutdown().unwrap();
}

fn last_alias(
    kind: &str,
    external_replace: bool,
    mounted_replace: bool,
    observe: bool,
    dirty: bool,
) {
    let (root, mut core) = backed(kind);
    let source = root.path().join("source");
    put(root.path(), "data", b"ORIGINAL");
    fs::hard_link(source.join("data"), source.join("alias")).unwrap();
    let (ino, a) = opened(&mut core, "data", 2);
    let (alias, b) = opened(&mut core, "alias", 2);
    assert_eq!(ino, alias);
    if dirty {
        core.write(a, 0, b"A").unwrap();
    }
    if external_replace {
        replace(root.path(), "data", b"NEW");
    } else {
        fs::remove_file(source.join("data")).unwrap();
    }
    if observe {
        if external_replace {
            assert_ne!(core.lookup_node("data").unwrap(), ino);
        } else {
            code(core.lookup_node("data"), libc::ENOENT);
        }
    }
    if mounted_replace {
        put(root.path(), "incoming", b"NEXT");
        core.rename("incoming", "alias", 0).unwrap();
    } else {
        core.remove("alias", false).unwrap();
    }
    for fh in [a, b] {
        assert_eq!(
            core.read(fh, 0, 8).unwrap(),
            if dirty {
                &b"ARIGINAL"[..]
            } else {
                &b"ORIGINAL"[..]
            }
        );
        let m = core.attributes(ino, Some(fh)).unwrap();
        assert_eq!(m.size, Some(8));
        assert_eq!(m.nlink, Some(0));
    }
    core.write(a, 0, b"UPDATED!").unwrap();
    core.sync_handle(a, "flush", false).unwrap();
    assert_eq!(core.read(b, 0, 8).unwrap(), b"UPDATED!");
    truncate_handle(&mut core, a, 5).unwrap();
    core.sync_handle(a, "flush", false).unwrap();
    assert_eq!(core.read(b, 0, 8).unwrap(), b"UPDAT");
    if external_replace {
        assert_eq!(disk(root.path(), "data"), b"NEW");
    } else {
        assert!(!source.join("data").exists());
    }
    if mounted_replace {
        assert_eq!(disk(root.path(), "alias"), b"NEXT");
    } else {
        assert!(!source.join("alias").exists());
    }
    core.shutdown().unwrap();
}
#[test]
fn retains_whole_handles_across_external_remove_then_mounted_unlink_observe_false_dirty_false() {
    last_alias("whole", false, false, false, false);
}
#[test]
fn retains_whole_handles_across_external_remove_then_mounted_unlink_observe_false_dirty_true() {
    last_alias("whole", false, false, false, true);
}
#[test]
fn retains_whole_handles_across_external_remove_then_mounted_unlink_observe_true_dirty_false() {
    last_alias("whole", false, false, true, false);
}
#[test]
fn retains_whole_handles_across_external_remove_then_mounted_unlink_observe_true_dirty_true() {
    last_alias("whole", false, false, true, true);
}
#[test]
fn retains_whole_handles_across_external_remove_then_mounted_replace_observe_false_dirty_false() {
    last_alias("whole", false, true, false, false);
}
#[test]
fn retains_whole_handles_across_external_remove_then_mounted_replace_observe_false_dirty_true() {
    last_alias("whole", false, true, false, true);
}
#[test]
fn retains_whole_handles_across_external_remove_then_mounted_replace_observe_true_dirty_false() {
    last_alias("whole", false, true, true, false);
}
#[test]
fn retains_whole_handles_across_external_remove_then_mounted_replace_observe_true_dirty_true() {
    last_alias("whole", false, true, true, true);
}
#[test]
fn retains_whole_handles_across_external_replace_then_mounted_unlink_observe_false_dirty_false() {
    last_alias("whole", true, false, false, false);
}
#[test]
fn retains_whole_handles_across_external_replace_then_mounted_unlink_observe_false_dirty_true() {
    last_alias("whole", true, false, false, true);
}
#[test]
fn retains_whole_handles_across_external_replace_then_mounted_unlink_observe_true_dirty_false() {
    last_alias("whole", true, false, true, false);
}
#[test]
fn retains_whole_handles_across_external_replace_then_mounted_unlink_observe_true_dirty_true() {
    last_alias("whole", true, false, true, true);
}
#[test]
fn retains_whole_handles_across_external_replace_then_mounted_replace_observe_false_dirty_false() {
    last_alias("whole", true, true, false, false);
}
#[test]
fn retains_whole_handles_across_external_replace_then_mounted_replace_observe_false_dirty_true() {
    last_alias("whole", true, true, false, true);
}
#[test]
fn retains_whole_handles_across_external_replace_then_mounted_replace_observe_true_dirty_false() {
    last_alias("whole", true, true, true, false);
}
#[test]
fn retains_whole_handles_across_external_replace_then_mounted_replace_observe_true_dirty_true() {
    last_alias("whole", true, true, true, true);
}
#[test]
fn retains_whole_ftruncate_handles_across_external_remove_then_mounted_unlink_observe_false_dirty_false()
 {
    last_alias("wholeTruncate", false, false, false, false);
}
#[test]
fn retains_whole_ftruncate_handles_across_external_remove_then_mounted_unlink_observe_false_dirty_true()
 {
    last_alias("wholeTruncate", false, false, false, true);
}
#[test]
fn retains_whole_ftruncate_handles_across_external_remove_then_mounted_unlink_observe_true_dirty_false()
 {
    last_alias("wholeTruncate", false, false, true, false);
}
#[test]
fn retains_whole_ftruncate_handles_across_external_remove_then_mounted_unlink_observe_true_dirty_true()
 {
    last_alias("wholeTruncate", false, false, true, true);
}
#[test]
fn retains_whole_ftruncate_handles_across_external_remove_then_mounted_replace_observe_false_dirty_false()
 {
    last_alias("wholeTruncate", false, true, false, false);
}
#[test]
fn retains_whole_ftruncate_handles_across_external_remove_then_mounted_replace_observe_false_dirty_true()
 {
    last_alias("wholeTruncate", false, true, false, true);
}
#[test]
fn retains_whole_ftruncate_handles_across_external_remove_then_mounted_replace_observe_true_dirty_false()
 {
    last_alias("wholeTruncate", false, true, true, false);
}
#[test]
fn retains_whole_ftruncate_handles_across_external_remove_then_mounted_replace_observe_true_dirty_true()
 {
    last_alias("wholeTruncate", false, true, true, true);
}
#[test]
fn retains_whole_ftruncate_handles_across_external_replace_then_mounted_unlink_observe_false_dirty_false()
 {
    last_alias("wholeTruncate", true, false, false, false);
}
#[test]
fn retains_whole_ftruncate_handles_across_external_replace_then_mounted_unlink_observe_false_dirty_true()
 {
    last_alias("wholeTruncate", true, false, false, true);
}
#[test]
fn retains_whole_ftruncate_handles_across_external_replace_then_mounted_unlink_observe_true_dirty_false()
 {
    last_alias("wholeTruncate", true, false, true, false);
}
#[test]
fn retains_whole_ftruncate_handles_across_external_replace_then_mounted_unlink_observe_true_dirty_true()
 {
    last_alias("wholeTruncate", true, false, true, true);
}
#[test]
fn retains_whole_ftruncate_handles_across_external_replace_then_mounted_replace_observe_false_dirty_false()
 {
    last_alias("wholeTruncate", true, true, false, false);
}
#[test]
fn retains_whole_ftruncate_handles_across_external_replace_then_mounted_replace_observe_false_dirty_true()
 {
    last_alias("wholeTruncate", true, true, false, true);
}
#[test]
fn retains_whole_ftruncate_handles_across_external_replace_then_mounted_replace_observe_true_dirty_false()
 {
    last_alias("wholeTruncate", true, true, true, false);
}
#[test]
fn retains_whole_ftruncate_handles_across_external_replace_then_mounted_replace_observe_true_dirty_true()
 {
    last_alias("wholeTruncate", true, true, true, true);
}
#[test]
fn retains_positional_handles_across_external_remove_then_mounted_unlink_observe_false_dirty_false()
{
    last_alias("positional", false, false, false, false);
}
#[test]
fn retains_positional_handles_across_external_remove_then_mounted_unlink_observe_false_dirty_true()
{
    last_alias("positional", false, false, false, true);
}
#[test]
fn retains_positional_handles_across_external_remove_then_mounted_unlink_observe_true_dirty_false()
{
    last_alias("positional", false, false, true, false);
}
#[test]
fn retains_positional_handles_across_external_remove_then_mounted_unlink_observe_true_dirty_true() {
    last_alias("positional", false, false, true, true);
}
#[test]
fn retains_positional_handles_across_external_remove_then_mounted_replace_observe_false_dirty_false()
 {
    last_alias("positional", false, true, false, false);
}
#[test]
fn retains_positional_handles_across_external_remove_then_mounted_replace_observe_false_dirty_true()
{
    last_alias("positional", false, true, false, true);
}
#[test]
fn retains_positional_handles_across_external_remove_then_mounted_replace_observe_true_dirty_false()
{
    last_alias("positional", false, true, true, false);
}
#[test]
fn retains_positional_handles_across_external_remove_then_mounted_replace_observe_true_dirty_true()
{
    last_alias("positional", false, true, true, true);
}
#[test]
fn retains_positional_handles_across_external_replace_then_mounted_unlink_observe_false_dirty_false()
 {
    last_alias("positional", true, false, false, false);
}
#[test]
fn retains_positional_handles_across_external_replace_then_mounted_unlink_observe_false_dirty_true()
{
    last_alias("positional", true, false, false, true);
}
#[test]
fn retains_positional_handles_across_external_replace_then_mounted_unlink_observe_true_dirty_false()
{
    last_alias("positional", true, false, true, false);
}
#[test]
fn retains_positional_handles_across_external_replace_then_mounted_unlink_observe_true_dirty_true()
{
    last_alias("positional", true, false, true, true);
}
#[test]
fn retains_positional_handles_across_external_replace_then_mounted_replace_observe_false_dirty_false()
 {
    last_alias("positional", true, true, false, false);
}
#[test]
fn retains_positional_handles_across_external_replace_then_mounted_replace_observe_false_dirty_true()
 {
    last_alias("positional", true, true, false, true);
}
#[test]
fn retains_positional_handles_across_external_replace_then_mounted_replace_observe_true_dirty_false()
 {
    last_alias("positional", true, true, true, false);
}
#[test]
fn retains_positional_handles_across_external_replace_then_mounted_replace_observe_true_dirty_true()
{
    last_alias("positional", true, true, true, true);
}

fn stale_buffer(operation: &str) {
    let (root, mut core) = backed("whole");
    put(root.path(), "data", b"OLD");
    let (ino, old) = opened(&mut core, "data", 2);
    core.write(old, 0, b"DIRTY").unwrap();
    replace(root.path(), "data", b"NEW");
    let (fresh_ino, fresh) = opened(&mut core, "data", 2);
    assert_ne!(ino, fresh_ino);
    assert_eq!(core.read(fresh, 0, 8).unwrap(), b"NEW");
    assert_eq!(core.read(old, 0, 8).unwrap(), b"DIRTY");
    code(truncate_handle(&mut core, old, 0), libc::ESTALE);
    if operation == "timer" {
        core.nodes.get_mut(&ino).unwrap().dirty_at = Some(Instant::now() - Duration::from_secs(1));
        core.flush_due();
        assert!(core.nodes[&ino].dirty);
        assert!(core.nodes[&ino].dirty_at.is_none());
    } else {
        code(core.sync_handle(old, operation, false), libc::ESTALE);
    }
    code(core.release_handle(old, false), libc::ESTALE);
    assert!(core.nodes[&ino].dirty);
    core.write(fresh, 0, b"X").unwrap();
    core.sync_handle(fresh, "flush", false).unwrap();
    assert_eq!(disk(root.path(), "data"), b"XEW");
    assert!(core.shutdown().is_err());
    assert!(core.handles.is_empty());
}
#[test]
fn isolates_replacement_identities_and_rejects_stale_buffered_flush_writes() {
    stale_buffer("flush");
}
#[test]
fn isolates_replacement_identities_and_rejects_stale_buffered_fsync_writes() {
    stale_buffer("fsync");
}
#[test]
fn isolates_replacement_identities_and_rejects_stale_buffered_timer_writes() {
    stale_buffer("timer");
}
#[test]
fn rejects_stale_whole_file_reads_and_flushes_without_a_replacement_lookup() {
    let (root, mut core) = backed("whole");
    put(root.path(), "data", b"OLD");
    let (ino, clean) = opened(&mut core, "data", 2);
    replace(root.path(), "data", b"NEW");
    code(core.read(clean, 0, 3), libc::ESTALE);
    let (new, dirty) = opened(&mut core, "data", 2);
    assert_ne!(ino, new);
    core.write(dirty, 0, b"DIRTY").unwrap();
    replace(root.path(), "data", b"NEXT");
    code(core.sync_handle(dirty, "flush", false), libc::ESTALE);
    code(core.release_handle(dirty, false), libc::ESTALE);
    assert_eq!(disk(root.path(), "data"), b"NEXT");
    assert!(core.nodes[&new].dirty);
    assert!(core.shutdown().is_err());
    assert!(core.handles.is_empty());
}
fn stale_positional(lookup: bool) {
    let (root, mut core) = backed("positional");
    put(root.path(), "data", b"ORIGINAL");
    let (ino, old) = opened(&mut core, "data", 2);
    core.write(old, 0, b"A").unwrap();
    assert_eq!(core.read(old, 0, 8).unwrap(), b"ARIGINAL");
    replace(root.path(), "data", b"NEW");
    if lookup {
        assert_ne!(core.lookup_node("data").unwrap(), ino);
    }
    code(core.read(old, 0, 8), libc::ESTALE);
    code(core.write(old, 0, b"BAD"), libc::ESTALE);
    assert_eq!(disk(root.path(), "data"), b"NEW");
    let (_, fresh) = opened(&mut core, "data", 2);
    assert_eq!(core.read(fresh, 0, 3).unwrap(), b"NEW");
    core.write(fresh, 0, b"X").unwrap();
    assert_eq!(disk(root.path(), "data"), b"XEW");
    core.shutdown().unwrap();
}
#[test]
fn rejects_stale_handleless_positional_i_o_with_replacement_lookup_false() {
    stale_positional(false);
}
#[test]
fn rejects_stale_handleless_positional_i_o_with_replacement_lookup_true() {
    stale_positional(true);
}
#[test]
fn rechecks_handleless_positional_identity_between_continuation_reads() {
    let (root, mut core) = provider(
        r#"
        import {appendFile} from "node:fs/promises";import path from "node:path";let identity="original";
        export default {getattr(){return {kind:"file",identity,size:8};},async read(p,_n,c){await appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify(p)+"\n");identity="replacement";return Buffer.from("OR");}};
    "#,
    );
    let (_, fh) = opened(&mut core, "data", 0);
    code(core.read(fh, 0, 8), libc::ESTALE);
    assert_eq!(trace(root.path()), vec![json!(0)]);
    core.shutdown().unwrap();
}
#[test]
fn keeps_handleless_positional_i_o_on_a_known_surviving_alias_and_detached_snapshot() {
    let (root, mut core) = backed("positional");
    put(root.path(), "data", b"ORIGINAL");
    fs::hard_link(
        root.path().join("source/data"),
        root.path().join("source/alias"),
    )
    .unwrap();
    let (_, a) = opened(&mut core, "data", 2);
    let (_, b) = opened(&mut core, "alias", 2);
    replace(root.path(), "data", b"NEW");
    assert_eq!(core.read(a, 0, 8).unwrap(), b"ORIGINAL");
    core.write(a, 0, b"A").unwrap();
    assert_eq!(core.read(b, 0, 8).unwrap(), b"ARIGINAL");
    core.lookup_node("data").unwrap();
    core.remove("alias", false).unwrap();
    core.write(a, 0, b"B").unwrap();
    assert_eq!(core.read(b, 0, 8).unwrap(), b"BRIGINAL");
    assert_eq!(disk(root.path(), "data"), b"NEW");
    core.shutdown().unwrap();
}
fn surviving_alias(operation: &str) {
    let (root, mut core) = backed("whole");
    put(root.path(), "data", b"ORIGINAL");
    fs::hard_link(
        root.path().join("source/data"),
        root.path().join("source/alias"),
    )
    .unwrap();
    let (ino, a) = opened(&mut core, "data", 2);
    let (_, b) = opened(&mut core, "alias", 2);
    core.write(a, 0, b"A").unwrap();
    core.write(b, 1, b"B").unwrap();
    assert_eq!(core.read(a, 0, 8).unwrap(), b"ABIGINAL");
    match operation {
        "unlink" => core.remove("data", false).unwrap(),
        "replace" => {
            put(root.path(), "incoming", b"NEW");
            core.rename("incoming", "data", 0).unwrap();
        }
        _ => fs::remove_file(root.path().join("source/data")).unwrap(),
    }
    core.write(a, 0, b"UPDATED!").unwrap();
    core.sync_handle(a, "fsync", false).unwrap();
    assert_eq!(disk(root.path(), "alias"), b"UPDATED!");
    assert_eq!(core.read(b, 0, 8).unwrap(), b"UPDATED!");
    for fh in [a, b] {
        assert_eq!(core.attributes(ino, Some(fh)).unwrap().nlink, Some(1));
    }
    if operation == "replace" {
        assert_eq!(disk(root.path(), "data"), b"NEW");
    }
    core.shutdown().unwrap();
}
#[test]
fn persists_whole_file_writes_through_a_surviving_hard_link_after_unlink() {
    surviving_alias("unlink");
}
#[test]
fn persists_whole_file_writes_through_a_surviving_hard_link_after_replace() {
    surviving_alias("replace");
}
#[test]
fn persists_whole_file_writes_through_a_surviving_hard_link_after_external_unlink() {
    surviving_alias("external-unlink");
}
#[test]
fn native_alias_recovery() {
    let (root, mut core) = backed("whole");
    put(root.path(), "data", b"ORIGINAL");
    fs::hard_link(
        root.path().join("source/data"),
        root.path().join("source/alias"),
    )
    .unwrap();
    let alias = core.lookup_node("alias").unwrap();
    let (ino, fh) = opened(&mut core, "data", 2);
    assert_eq!(ino, alias);
    core.remove("data", false).unwrap();
    core.write(fh, 0, b"UPDATED!").unwrap();
    core.sync_handle(fh, "fsync", false).unwrap();
    assert_eq!(disk(root.path(), "alias"), b"UPDATED!");
    core.shutdown().unwrap();
}
#[test]
fn refreshes_captured_sizes_across_distinct_open_handles_sharing_a_provider_identity() {
    let module = format!("{BACKED}\nwhole.open=()=>({{}});");
    let (root, mut core) = provider_rules(
        json!([{"match":"**","opaque":true,"provider":{"module":"whole"}}]),
        &module,
    );
    put(root.path(), "data", b"OLD");
    fs::hard_link(
        root.path().join("source/data"),
        root.path().join("source/alias"),
    )
    .unwrap();
    let (ino, a) = opened(&mut core, "data", 2);
    let (_, b) = opened(&mut core, "alias", 2);
    core.write(a, 0, b"EXTENDED").unwrap();
    core.sync_handle(a, "flush", false).unwrap();
    assert_eq!(core.attributes(ino, Some(b)).unwrap().size, Some(8));
    core.shutdown().unwrap();
}
fn whole_shared_sizes(truncate_hook: bool) {
    let module = format!(
        r#"
        let bytes=Buffer.from("old");export default {{getattr(){{return {{kind:"file",size:bytes.length}};}},open(){{return {{}};}},readFile(){{return bytes;}},writeFile(b){{bytes=Buffer.from(b);}},
            {} }};
    "#,
        if truncate_hook {
            "truncate(n){const next=Buffer.alloc(n);bytes.copy(next);bytes=next;}"
        } else {
            ""
        }
    );
    let (_root, mut core) = provider(&module);
    let (ino, a) = opened(&mut core, "data", 2);
    let (_, b) = opened(&mut core, "data", 2);
    core.write(a, 0, b"EXTENDED").unwrap();
    let (_, pending) = opened(&mut core, "data", 2);
    core.sync_handle(a, "flush", false).unwrap();
    for fh in [a, b, pending] {
        assert_eq!(core.attributes(ino, Some(fh)).unwrap().size, Some(8));
        assert_eq!(core.read(fh, 0, 20).unwrap(), b"EXTENDED");
    }
    truncate_handle(&mut core, a, 4).unwrap();
    core.sync_handle(a, "fsync", false).unwrap();
    for fh in [a, b, pending] {
        assert_eq!(core.attributes(ino, Some(fh)).unwrap().size, Some(4));
        assert_eq!(core.read(fh, 0, 20).unwrap(), b"EXTE");
    }
    let truncated = core.open_file(ino, 2 | libc::O_TRUNC).unwrap();
    core.sync_handle(truncated, "flush", false).unwrap();
    for fh in [a, b, pending, truncated] {
        assert!(core.read(fh, 0, 20).unwrap().is_empty());
    }
    core.write(b, 0, b"another").unwrap();
    core.sync_handle(b, "flush", false).unwrap();
    core.truncate(ino, 3, None).unwrap();
    core.sync_handle(b, "flush", false).unwrap();
    for fh in [a, b, pending, truncated] {
        assert_eq!(core.read(fh, 0, 20).unwrap(), b"ano");
    }
    core.shutdown().unwrap();
}
#[test]
fn shares_whole_file_sizes_without_identities_including_pending_opens_and_truncate_hooks_false() {
    whole_shared_sizes(false);
}
#[test]
fn shares_whole_file_sizes_without_identities_including_pending_opens_and_truncate_hooks_true() {
    whole_shared_sizes(true);
}
#[test]
fn keeps_distinct_positional_resources_captured_sizes_independent_without_identities() {
    let (_root, mut core) = provider(
        r#"
        let original={bytes:Buffer.from("ORIGINAL")},replacement={bytes:Buffer.from("REPLACEMENT")},current=original;
        export default {getattr(){return {kind:"file",size:current.bytes.length};},open(){const h=current;current=replacement;return h;},
            read(p,n,{handle}){return handle.bytes.subarray(p,p+n);},ftruncate(n,{handle}){handle.bytes=handle.bytes.subarray(0,n);}};
    "#,
    );
    let (ino, a) = opened(&mut core, "data", 2);
    let (_, b) = opened(&mut core, "data", 2);
    truncate_handle(&mut core, a, 3).unwrap();
    assert_eq!(core.attributes(ino, Some(a)).unwrap().size, Some(3));
    assert_eq!(core.attributes(ino, Some(b)).unwrap().size, Some(11));
    assert_eq!(core.read(b, 0, 20).unwrap(), b"REPLACEMENT");
    core.shutdown().unwrap();
}
fn acquisition_replace(flags: i32) {
    let (root, mut core) = provider_rules(
        json!([{"match":"**","provider":{"module":"default"}}]),
        r#"
        import {writeFile,rename} from "node:fs/promises";
        export default {async open({sourcePath}){await writeFile(sourcePath+".incoming","NEW");await rename(sourcePath+".incoming",sourcePath);}};
    "#,
    );
    put(root.path(), "data", b"OLD");
    let old = core.lookup_node("data").unwrap();
    let before = core.nodes[&old].metadata.identity.clone();
    code(core.open_file(old, flags), libc::ESTALE);
    assert!(core.handles.is_empty());
    let fresh = core.lookup_node("data").unwrap();
    assert_ne!(before, core.nodes[&fresh].metadata.identity);
    assert_eq!(disk(root.path(), "data"), b"NEW");
    core.shutdown().unwrap();
}
#[test]
fn exposes_native_identity_changes_without_premature_truncation_flags_0() {
    acquisition_replace(0);
}
#[test]
fn exposes_native_identity_changes_without_premature_truncation_flags_512() {
    acquisition_replace(libc::O_TRUNC);
}
#[test]
fn reports_an_unknown_surviving_hard_link_instead_of_discarding_buffered_writes() {
    let (root, mut core) = backed("whole");
    put(root.path(), "data", b"ORIGINAL");
    fs::hard_link(
        root.path().join("source/data"),
        root.path().join("source/alias"),
    )
    .unwrap();
    let (ino, fh) = opened(&mut core, "data", 2);
    core.remove("data", false).unwrap();
    code(core.write(fh, 0, b"UPDATED!"), libc::ESTALE);
    assert_eq!(core.lookup_node("alias").unwrap(), ino);
    core.write(fh, 0, b"UPDATED!").unwrap();
    core.sync_handle(fh, "flush", false).unwrap();
    assert_eq!(disk(root.path(), "alias"), b"UPDATED!");
    core.shutdown().unwrap();
}
#[test]
fn mutex_serializes_pending_flush() {
    let (root, core) = provider(
        r#"
        import {appendFile} from "node:fs/promises";import path from "node:path";let bytes=Buffer.from("0000");
        export default {getattr(){return {kind:"file",size:bytes.length};},readFile(){return bytes;},
            async writeFile(b,c){await appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify(b.toString())+"\n");await new Promise(r=>setTimeout(r,40));bytes=Buffer.from(b);}};
    "#,
    );
    let shared = Arc::new(Mutex::new(core));
    let fh = {
        let mut c = shared.lock().unwrap();
        let (_, fh) = opened(&mut c, "data", 2);
        c.write(fh, 0, b"A").unwrap();
        fh
    };
    let flushing = shared.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let mut c = flushing.lock().unwrap();
        tx.send(()).unwrap();
        c.sync_handle(fh, "flush", false).unwrap();
    });
    rx.recv().unwrap();
    {
        let mut c = shared.lock().unwrap();
        c.write(fh, 1, b"B").unwrap();
        c.sync_handle(fh, "flush", false).unwrap();
    }
    worker.join().unwrap();
    assert_eq!(trace(root.path()), vec![json!("A000"), json!("AB00")]);
    shared.lock().unwrap().shutdown().unwrap();
}

#[test]
fn moves_open_handles_when_their_file_or_parent_directory_is_renamed() {
    let (root, mut core) = native();
    fs::create_dir(root.path().join("source/directory")).unwrap();
    put(root.path(), "directory/data", b"0000");
    let (_, fh) = opened(&mut core, "directory/data", 2);
    core.write(fh, 0, b"A").unwrap();
    core.rename("directory", "renamed", 0).unwrap();
    core.write(fh, 1, b"B").unwrap();
    core.sync_handle(fh, "flush", false).unwrap();
    assert_eq!(disk(root.path(), "renamed/data"), b"AB00");
    assert!(!root.path().join("source/directory").exists());
    core.shutdown().unwrap();
}
fn hidden_parent(kind: &str) {
    let rules = match kind {
        "proxy" => {
            json!([{"match":"Proxy/**","root":"Proxy","provider":{"type":"directory","path":"source"}},{"match":"Proxy/after/*.txt","hide":true}])
        }
        "source" => json!([{"match":"after/*.txt","hide":true}]),
        _ => {
            json!([{"match":"**","provider":{"module":kind}},{"match":"after/*.txt","hide":true}])
        }
    };
    let module = format!(
        r#"{BACKED}
        for(const provider of [positional,whole]){{provider.getattr=undefined;provider.rename=undefined;provider.unlink=undefined;provider.rmdir=undefined;}}
    "#
    );
    let (root, overlay) = fixture(rules, Some(&module));
    fs::create_dir(root.path().join("source/before")).unwrap();
    put(root.path(), "before/data.txt", b"abcdef");
    let mut core = Core::new(overlay).unwrap();
    let prefix = if kind == "proxy" { "Proxy/" } else { "" };
    let before = format!("{prefix}before");
    let after = format!("{prefix}after");
    let (ino, fh) = opened(&mut core, &format!("{before}/data.txt"), 2);
    core.rename(&before, &after, 0).unwrap();
    assert_eq!(core.attributes(ino, Some(fh)).unwrap().size, Some(6));
    assert_eq!(core.read(fh, 0, 6).unwrap(), b"abcdef");
    core.write(fh, 0, b"X").unwrap();
    truncate_handle(&mut core, fh, 3).unwrap();
    core.sync_handle(fh, "fsync", false).unwrap();
    assert_eq!(core.read(fh, 0, 3).unwrap(), b"Xbc");
    assert_eq!(disk(root.path(), "after/data.txt"), b"Xbc");
    code(core.lookup_node(&format!("{after}/data.txt")), libc::ENOENT);
    core.shutdown().unwrap();
}
#[test]
fn retains_source_descriptor_i_o_when_a_parent_rename_hides_its_path() {
    hidden_parent("source");
}
#[test]
fn retains_proxy_descriptor_i_o_when_a_parent_rename_hides_its_path() {
    hidden_parent("proxy");
}
#[test]
fn retains_positional_descriptor_i_o_when_a_parent_rename_hides_its_path() {
    hidden_parent("positional");
}
#[test]
fn retains_whole_file_descriptor_i_o_when_a_parent_rename_hides_its_path() {
    hidden_parent("whole");
}
#[test]
fn does_not_resurrect_an_unlinked_file_when_an_open_handle_is_flushed() {
    let (root, mut core) = native();
    put(root.path(), "data", b"0000");
    let (_, fh) = opened(&mut core, "data", 2);
    core.write(fh, 0, b"A").unwrap();
    core.remove("data", false).unwrap();
    core.write(fh, 1, b"B").unwrap();
    core.sync_handle(fh, "flush", false).unwrap();
    assert_eq!(core.read(fh, 0, 4).unwrap(), b"AB00");
    assert!(!root.path().join("source/data").exists());
    core.shutdown().unwrap();
}
#[test]
fn keeps_overwritten_destination_handles_separate_from_the_renamed_file() {
    let (root, mut core) = native();
    put(root.path(), "data", b"old");
    put(root.path(), "new", b"new");
    let (_, fh) = opened(&mut core, "data", 2);
    core.rename("new", "data", 0).unwrap();
    core.write(fh, 0, b"X").unwrap();
    core.sync_handle(fh, "flush", false).unwrap();
    assert_eq!(core.read(fh, 0, 3).unwrap(), b"Xld");
    assert_eq!(disk(root.path(), "data"), b"new");
    core.shutdown().unwrap();
}
fn zero_links(kind: &str, replacing: bool) {
    let module = format!(
        r#"{BACKED}
        import {{readFile as readControl}} from "node:fs/promises";
        const original={kind};
        if(original.fgetattr){{const fgetattr=original.fgetattr;original.fgetattr=async c=>({{...await fgetattr(c),nlink:1}});}}
        const remove=original.unlink,move=original.rename;
        async function denied(c){{if(await readControl(path.join(c.sourcePath,"..","deny"),"utf8")==="yes")throw Object.assign(new Error("denied"),{{code:"EACCES"}});}}
        original.unlink=async c=>{{await denied(c);return remove(c);}};
        original.rename=async c=>{{await denied(c);return move(c);}};
    "#
    );
    let (root, mut core) = provider_rules(
        json!([{"match":"**","opaque":true,"provider":{"module":kind}}]),
        &module,
    );
    put(root.path(), "data", b"OLD");
    put(root.path(), "replacement", b"NEW");
    fs::write(root.path().join("source/deny"), "yes").unwrap();
    let (ino, fh) = opened(&mut core, "data", 2);
    let removal = |c: &mut Core| {
        if replacing {
            c.rename("replacement", "data", 0)
        } else {
            c.remove("data", false)
        }
    };
    code(removal(&mut core), libc::EACCES);
    assert_eq!(core.attributes(ino, Some(fh)).unwrap().nlink, Some(1));
    fs::write(root.path().join("source/deny"), "no").unwrap();
    removal(&mut core).unwrap();
    assert_eq!(core.attributes(ino, Some(fh)).unwrap().nlink, Some(0));
    assert_eq!(core.read(fh, 0, 20).unwrap(), b"OLD");
    if replacing {
        let fresh = core.lookup_node("data").unwrap();
        assert_ne!(ino, fresh);
        assert_eq!(core.attributes(fresh, None).unwrap().nlink, Some(1));
    }
    core.shutdown().unwrap();
}
#[test]
fn reports_zero_links_for_a_detached_whole_file_file_after_unlink() {
    zero_links("whole", false);
}
#[test]
fn reports_zero_links_for_a_detached_whole_file_file_after_replace() {
    zero_links("whole", true);
}
#[test]
fn reports_zero_links_for_a_detached_positional_file_after_unlink() {
    zero_links("resource", false);
}
#[test]
fn reports_zero_links_for_a_detached_positional_file_after_replace() {
    zero_links("resource", true);
}
#[test]
fn does_not_dispatch_detached_positional_writes_against_a_replacement_pathname() {
    let (root, mut core) = backed("positional");
    put(root.path(), "data", b"OLD");
    let (_, fh) = opened(&mut core, "data", 2);
    core.remove("data", false).unwrap();
    put(root.path(), "data", b"NEW");
    core.write(fh, 0, b"X").unwrap();
    assert_eq!(core.read(fh, 0, 3).unwrap(), b"XLD");
    assert_eq!(disk(root.path(), "data"), b"NEW");
    core.shutdown().unwrap();
}
#[test]
fn snapshots_whole_file_provider_handles_that_implement_descriptor_truncation() {
    let module = format!("{BACKED}\nwholeTruncate.open=()=>({{resource:\"old\"}});");
    let (root, mut core) = provider_rules(
        json!([{"match":"**","opaque":true,"provider":{"module":"wholeTruncate"}}]),
        &module,
    );
    put(root.path(), "data", b"OLD");
    let (_, fh) = opened(&mut core, "data", 2);
    core.remove("data", false).unwrap();
    put(root.path(), "data", b"NEW");
    assert_eq!(core.read(fh, 0, 3).unwrap(), b"OLD");
    assert_eq!(disk(root.path(), "data"), b"NEW");
    core.shutdown().unwrap();
}
const MIXED_WRITER: &str = r#"
    import {readFile,appendFile} from "node:fs/promises";import path from "node:path";
    const original={identity:"original",bytes:Buffer.from("ORIGINAL")},replacement={identity:"replacement",bytes:Buffer.from("NEW")};
    const entries=new Map([["data",original],["replacement",replacement]]);
    const metadata=e=>e&&({kind:"file",identity:e.identity,size:e.bytes.length});
    async function options(c){try{return JSON.parse(await readFile(path.join(c.sourcePath,"..","control"),"utf8"));}catch(e){if(e.code==="ENOENT")return {limit:2};throw e;}}
    const log=(c,event,value)=>appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify([event,value])+"\n");
    export default {
        getattr({path:p}){return metadata(entries.get(p));},open({path:p}){return entries.get(p);},
        fgetattr({handle}){return metadata(handle);},readFile({path:p}){return entries.get(p).bytes;},
        async write(b,p,c){const o=await options(c);await log(c,"write",c.handle.identity);if(o.fail)throw Object.assign(new Error("write failed"),{code:"EIO"});
            const n=Math.min(b.length,o.limit),next=Buffer.alloc(Math.max(c.handle.bytes.length,p+n));c.handle.bytes.copy(next);if(n)b.copy(next,p,0,n);if(n)c.handle.bytes=next;return n;},
        async ftruncate(n,c){const o=await options(c);await log(c,"truncate",n);if(o.fail)throw Object.assign(new Error("truncate failed"),{code:"EIO"});const b=Buffer.alloc(n);c.handle.bytes.copy(b);c.handle.bytes=b;},
        fsync(_d,c){return log(c,"sync",c.handle.identity);},
        unlink({path:p}){entries.delete(p);},
        rename({path:p,destinationPath:q}){entries.set(q,entries.get(p));entries.delete(p);}
    };
"#;
fn retained_mixed(replacing: bool) {
    let (root, mut core) = provider(MIXED_WRITER);
    let (ino, a) = opened(&mut core, "data", 2);
    let (_, b) = opened(&mut core, "data", 2);
    if replacing {
        core.rename("replacement", "data", 0).unwrap();
    } else {
        core.remove("data", false).unwrap();
    }
    assert_eq!(core.write(a, 1, b"XYZ").unwrap(), 2);
    assert_eq!(core.read(b, 0, 20).unwrap(), b"OXYGINAL");
    assert_eq!(core.write(b, 10, b"END").unwrap(), 2);
    assert_eq!(core.read(a, 0, 20).unwrap(), b"OXYGINAL\0\0EN");
    fs::write(root.path().join("source/control"), r#"{"limit":0}"#).unwrap();
    assert_eq!(core.write(a, 100, b"ignored").unwrap(), 0);
    assert_eq!(core.attributes(ino, Some(a)).unwrap().size, Some(12));
    truncate_handle(&mut core, b, 4).unwrap();
    assert_eq!(core.read(a, 0, 20).unwrap(), b"OXYG");
    truncate_handle(&mut core, b, 8).unwrap();
    assert_eq!(core.read(a, 0, 20).unwrap(), b"OXYG\0\0\0\0");
    fs::write(
        root.path().join("source/control"),
        r#"{"fail":true,"limit":2}"#,
    )
    .unwrap();
    code(core.write(a, 0, b"ignored"), libc::EIO);
    code(truncate_handle(&mut core, a, 0), libc::EIO);
    assert_eq!(core.read(b, 0, 20).unwrap(), b"OXYG\0\0\0\0");
    core.sync_handle(a, "fsync", false).unwrap();
    let events = trace(root.path());
    assert_eq!(events.iter().filter(|v| v[0] == "write").count(), 4);
    assert_eq!(events.iter().filter(|v| v[0] == "truncate").count(), 3);
    assert_eq!(events.last().unwrap(), &json!(["sync", "original"]));
    if replacing {
        let (_, fresh) = opened(&mut core, "data", 0);
        assert_eq!(core.read(fresh, 0, 20).unwrap(), b"NEW");
    } else {
        code(core.lookup_node("data"), libc::ENOENT);
    }
    core.shutdown().unwrap();
}
#[test]
fn persists_retained_mixed_writer_mutations_after_unlink_while_keeping_snapshot_reads_coherent() {
    retained_mixed(false);
}
#[test]
fn persists_retained_mixed_writer_mutations_after_replace_while_keeping_snapshot_reads_coherent() {
    retained_mixed(true);
}
#[test]
fn rejects_unsupported_retained_mixed_writer_truncation_instead_of_acknowledging_a_snapshot_only_change()
 {
    let (root, mut core) = provider(
        r#"
        import {appendFile} from "node:fs/promises";import path from "node:path";const original={bytes:Buffer.from("ORIGINAL")};
        export default {getattr(){return {kind:"file",size:8};},open(){return original;},readFile(){return original.bytes;},write(){return 0;},unlink(){},
            truncate(n,c){return appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify(n)+"\n");}};
    "#,
    );
    let (_, fh) = opened(&mut core, "data", 2);
    core.remove("data", false).unwrap();
    code(truncate_handle(&mut core, fh, 0), libc::EOPNOTSUPP);
    assert!(trace(root.path()).is_empty());
    assert_eq!(core.read(fh, 0, 20).unwrap(), b"ORIGINAL");
    core.shutdown().unwrap();
}
#[test]
fn supports_positional_only_truncation_and_open_file_removal_without_readfile() {
    let (root, mut core) = backed("positional");
    put(root.path(), "data", b"abcdef");
    let (_, fh) = opened(&mut core, "data", 2);
    truncate_handle(&mut core, fh, 4).unwrap();
    assert_eq!(disk(root.path(), "data"), b"abcd");
    core.remove("data", false).unwrap();
    put(root.path(), "data", b"new!");
    core.write(fh, 0, b"X").unwrap();
    assert_eq!(core.read(fh, 0, 4).unwrap(), b"Xbcd");
    assert_eq!(disk(root.path(), "data"), b"new!");
    core.shutdown().unwrap();
}
#[test]
fn preserves_a_positional_providers_stable_per_open_object_after_replacement() {
    let (root, mut core) = backed("resource");
    put(root.path(), "data", b"OLD");
    put(root.path(), "replacement", b"NEW");
    let (_, fh) = opened(&mut core, "data", 2);
    core.rename("replacement", "data", 0).unwrap();
    core.write(fh, 0, b"X").unwrap();
    assert_eq!(core.read(fh, 0, 3).unwrap(), b"XLD");
    assert_eq!(disk(root.path(), "data"), b"NEW");
    core.shutdown().unwrap();
}
#[test]
fn rejects_a_parent_rename_that_would_switch_an_open_descendants_provider() {
    let (root, mut core) = provider_rules(
        json!([{"match":"before/*.txt","provider":{"module":"first"}},{"match":"after/*.txt","provider":{"module":"second"}}]),
        r#"
        import {appendFile} from "node:fs/promises";import path from "node:path";
        export const first={getattr(){return {kind:"file",size:3};},open(){return "original handle";},readFile(){return Buffer.from("old");},
            release(c){return appendFile(path.join(c.sourcePath,"..","..","trace.jsonl"),JSON.stringify([c.path,c.handle])+"\n");}};
        export const second={...first};
    "#,
    );
    fs::create_dir(root.path().join("source/before")).unwrap();
    let (_, fh) = opened(&mut core, "before/data.txt", 2);
    code(core.rename("before", "after", 0), libc::EXDEV);
    core.release_handle(fh, false).unwrap();
    assert_eq!(
        trace(root.path()),
        vec![json!(["before/data.txt", "original handle"])]
    );
}
#[test]
fn reports_acknowledged_whole_file_buffered_extensions_before_flushing() {
    let (root, mut core) = backed("whole");
    put(root.path(), "data", b"");
    let (ino, fh) = opened(&mut core, "data", 2);
    core.write(fh, 0, b"hello").unwrap();
    assert_eq!(core.attributes(ino, None).unwrap().size, Some(5));
    assert!(disk(root.path(), "data").is_empty());
    core.shutdown().unwrap();
    assert_eq!(disk(root.path(), "data"), b"hello");
}
#[test]
fn reports_a_created_positional_files_size_before_its_creating_handle_closes() {
    let (root, mut core) = backed("resource");
    let (ino, fh) = core.create_file("data", 0o644, 2).unwrap();
    core.write(fh, 0, b"hello").unwrap();
    assert_eq!(core.attributes(ino, None).unwrap().size, Some(5));
    assert_eq!(core.read(fh, 0, 5).unwrap(), b"hello");
    assert_eq!(disk(root.path(), "data"), b"hello");
    core.shutdown().unwrap();
}
#[test]
fn releases_acquired_resources_if_metadata_fails_before_create_returns_a_descriptor() {
    let (root, mut core) = provider(
        r#"
        import {appendFile} from "node:fs/promises";import path from "node:path";let created=false;
        export default {create(){created=true;return {id:"resource"};},getattr(){if(created)throw Object.assign(new Error("metadata failed"),{code:"EACCES"});},
            release(c){return appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify(c.handle)+"\n");}};
    "#,
    );
    code(core.create_file("data", 0o644, 2), libc::EACCES);
    assert_eq!(trace(root.path()), vec![json!({"id":"resource"})]);
    assert!(core.handles.is_empty());
    assert!(!core.paths.contains_key("data"));
    core.shutdown().unwrap();
}
#[test]
fn does_not_allocate_or_retain_full_buffers_for_completed_handleless_source_truncations() {
    let (root, mut core) = native();
    for index in 0..16 {
        let path = format!("retention-{index}");
        put(root.path(), &path, b"");
        let ino = core.lookup_node(&path).unwrap();
        core.truncate(ino, 1024 * 1024, None).unwrap();
        assert!(core.nodes[&ino].contents.is_none());
        assert!(!core.nodes[&ino].dirty);
        assert_eq!(
            fs::metadata(root.path().join("source").join(path))
                .unwrap()
                .len(),
            1024 * 1024
        );
    }
    assert!(core.handles.is_empty());
    core.shutdown().unwrap();
}
#[test]
fn ftruncates_a_stable_positional_resource_rather_than_its_replacement() {
    let (root, mut core) = backed("resource");
    put(root.path(), "data", b"ORIGINAL");
    let (ino, fh) = opened(&mut core, "data", 2);
    replace(root.path(), "data", b"NEW");
    truncate_handle(&mut core, fh, 4).unwrap();
    assert_eq!(core.attributes(ino, Some(fh)).unwrap().size, Some(4));
    assert_eq!(core.read(fh, 0, 8).unwrap(), b"ORIG");
    assert_eq!(disk(root.path(), "data"), b"NEW");
    core.shutdown().unwrap();
}
fn post_trunc_policy(policy: &str) {
    let module = format!(
        r#"
        let bytes=Buffer.from("ORIGINAL");const original={{bytes}};
        export default {{getattr(){{return {{kind:"file",identity:"stable",size:original.bytes.length,sizeMode:"{policy}"}};}},
            open(){{return original;}},read(p,n,{{handle}}){{return handle.bytes.subarray(p,p+n);}},ftruncate(n,{{handle}}){{handle.bytes=handle.bytes.subarray(0,n);}}}};
    "#
    );
    let (_root, mut core) = provider(&module);
    let (ino, fh) = opened(&mut core, "data", 2 | libc::O_TRUNC);
    let m = core.attributes(ino, Some(fh)).unwrap();
    assert_eq!(m.size, Some(if policy == "unbounded" { 8 } else { 0 }));
    assert_eq!(m.size_mode.as_deref(), Some(policy));
    assert!(core.read(fh, 0, 8).unwrap().is_empty());
    core.shutdown().unwrap();
}
#[test]
fn captures_post_o_trunc_metadata_on_stable_resources_with_content_size_policy() {
    post_trunc_policy("content");
}
#[test]
fn captures_post_o_trunc_metadata_on_stable_resources_with_explicit_size_policy() {
    post_trunc_policy("explicit");
}
#[test]
fn captures_post_o_trunc_metadata_on_stable_resources_with_zero_size_policy() {
    post_trunc_policy("zero");
}
#[test]
fn captures_post_o_trunc_metadata_on_stable_resources_with_unbounded_size_policy() {
    post_trunc_policy("unbounded");
}
fn enosys(operation: &str) {
    let module = format!(
        r#"let first=true;export default {{getattr(){{return {{kind:"file",size:0}};}},{operation}(){{if(first){{first=false;throw Object.assign(new Error("unsupported"),{{code:"ENOSYS"}});}}}}}};"#
    );
    let (_root, mut core) = provider(&module);
    let ino = core.lookup_node("data").unwrap();
    if operation == "open" {
        code(core.open_file(ino, 2), libc::EOPNOTSUPP);
        let fh = core.open_file(ino, 2).unwrap();
        core.release_handle(fh, false).unwrap();
    } else if operation == "access" {
        code(core.overlay.access("data", 0), libc::EOPNOTSUPP);
        core.overlay.access("data", 0).unwrap();
    } else {
        let fh = core.open_file(ino, 2).unwrap();
        code(core.sync_handle(fh, operation, false), libc::EOPNOTSUPP);
        core.sync_handle(fh, operation, false).unwrap();
        core.release_handle(fh, false).unwrap();
    }
}
#[test]
fn reports_provider_enosys_from_fsync_without_disabling_the_operation_mount_wide() {
    enosys("fsync");
}
#[test]
fn reports_provider_enosys_from_flush_without_disabling_the_operation_mount_wide() {
    enosys("flush");
}
#[test]
fn reports_provider_enosys_from_access_without_disabling_the_operation_mount_wide() {
    enosys("access");
}
#[test]
fn reports_provider_enosys_from_open_without_disabling_the_operation_mount_wide() {
    enosys("open");
}
fn provider_errno(name: &str, expected: i32) {
    let module = format!(
        r#"function fail(){{throw Object.assign(new Error("{name}"),{{code:"{name}"}});}}export default {{getattr({{path}}){{if(path==="data")return {{kind:"file",size:0}};}},write:fail,fsync:fail,mkdir:fail}};"#
    );
    let (_root, mut core) = provider(&module);
    let (_, fh) = opened(&mut core, "data", 2);
    code(core.write(fh, 0, b"X"), expected);
    code(core.sync_handle(fh, "fsync", false), expected);
    code(core.overlay.mkdir("directory", 0o755), expected);
    core.shutdown().unwrap();
}
#[test]
fn preserves_the_bindings_enospc_errno_across_provider_operations() {
    provider_errno("ENOSPC", libc::ENOSPC);
}
#[test]
fn preserves_the_bindings_edquot_errno_across_provider_operations() {
    provider_errno("EDQUOT", libc::EDQUOT);
}
#[test]
fn preserves_the_bindings_efbig_errno_across_provider_operations() {
    provider_errno("EFBIG", libc::EFBIG);
}
#[test]
fn preserves_the_bindings_eloop_errno_across_provider_operations() {
    provider_errno("ELOOP", libc::ELOOP);
}
#[test]
fn preserves_the_bindings_emfile_errno_across_provider_operations() {
    provider_errno("EMFILE", libc::EMFILE);
}
#[test]
fn preserves_the_bindings_enfile_errno_across_provider_operations() {
    provider_errno("ENFILE", libc::ENFILE);
}
#[test]
fn preserves_the_bindings_enomem_errno_across_provider_operations() {
    provider_errno("ENOMEM", libc::ENOMEM);
}
#[test]
fn preserves_the_bindings_eintr_errno_across_provider_operations() {
    provider_errno("EINTR", libc::EINTR);
}
#[test]
fn preserves_the_bindings_eagain_errno_across_provider_operations() {
    provider_errno("EAGAIN", libc::EAGAIN);
}
#[test]
fn preserves_the_bindings_enametoolong_errno_across_provider_operations() {
    provider_errno("ENAMETOOLONG", libc::ENAMETOOLONG);
}
#[test]
fn preserves_the_bindings_erange_errno_across_provider_operations() {
    provider_errno("ERANGE", libc::ERANGE);
}
#[test]
fn preserves_the_bindings_etimedout_errno_across_provider_operations() {
    provider_errno("ETIMEDOUT", libc::ETIMEDOUT);
}
#[test]
fn unknown_error_reaches_failure_logger() {
    let (_root, mut core) = provider(
        r#"export default {getattr(){return {kind:"file",size:0};},write(){throw Object.assign(new Error("unknown-provider-error"),{code:"EUNKNOWN"});}};"#,
    );
    let (_, fh) = opened(&mut core, "data", 2);
    let error = core.write(fh, 0, b"X").unwrap_err();
    assert!(format!("{error:#}").contains("unknown-provider-error"));
    let mut logged = Vec::new();
    assert_eq!(
        failure_report(error, |error| logged.push(format!("{error:#}"))),
        libc::EIO
    );
    assert_eq!(logged.len(), 1);
    assert!(logged[0].contains("unknown-provider-error"));
    core.shutdown().unwrap();
}

fn sink_module(policy: &str, sequential: bool, reader: bool, fail_first: bool) -> String {
    format!(
        r#"
        import {{appendFile}} from "node:fs/promises";import path from "node:path";let calls=0;
        export default {{getattr(){{return {{kind:"file",mode:128,size:0,sizeMode:"{policy}",seekable:{},atime:new Date(0),mtime:new Date(0),ctime:new Date(0),birthtime:new Date(0)}};}},
            {}
            async writeFile(b,c){{await appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify([b.toString(),c.previousContents?.toString()??null])+"\n");
                if({fail_first}&&calls++===0)throw Object.assign(new Error("write failed"),{{code:"EIO"}});}}
        }};
    "#,
        !sequential,
        if reader {
            "readFile(){throw Object.assign(new Error(\"write only\"),{code:\"EACCES\"});},"
        } else {
            ""
        }
    )
}
fn zero_sink(reader: bool) {
    let (root, mut core) = provider(&sink_module("zero", false, reader, false));
    let (_, fh) = opened(&mut core, "data", 1);
    core.write(fh, 0, b"run").unwrap();
    core.sync_handle(fh, "flush", false).unwrap();
    assert_eq!(trace(root.path()), vec![json!(["run", ""])]);
    core.shutdown().unwrap();
}
#[test]
fn writes_a_zero_sized_sink_without_reading_it_read_callback_present_false() {
    zero_sink(false);
}
#[test]
fn writes_a_zero_sized_sink_without_reading_it_read_callback_present_true() {
    zero_sink(true);
}
fn reset_sink(policy: &str) {
    let (root, mut core) = provider(&sink_module(policy, false, true, false));
    let (_, a) = opened(&mut core, "data", 1);
    let (_, b) = opened(&mut core, "data", 1);
    core.write(a, 0, b"long-").unwrap();
    core.write(b, 5, b"command").unwrap();
    core.sync_handle(a, "flush", false).unwrap();
    core.write(b, 0, b"x").unwrap();
    core.sync_handle(b, "fsync", false).unwrap();
    core.write(a, 0, b"y").unwrap();
    core.write(b, 1, b"z").unwrap();
    core.sync_handle(b, "flush", false).unwrap();
    assert_eq!(
        trace(root.path()),
        vec![
            json!(["long-command", ""]),
            json!(["x", ""]),
            json!(["yz", ""])
        ]
    );
    core.shutdown().unwrap();
}
#[test]
fn resets_clean_zero_sized_sink_buffers_across_already_open_writers() {
    reset_sink("zero");
}
#[test]
fn resets_clean_explicit_sized_sink_buffers_across_already_open_writers() {
    reset_sink("explicit");
}
#[test]
fn preserves_pending_command_bytes_after_a_failed_flush() {
    let (root, mut core) = provider(&sink_module("zero", false, false, true));
    let (ino, a) = opened(&mut core, "data", 1);
    let (_, b) = opened(&mut core, "data", 1);
    core.write(a, 0, b"long-").unwrap();
    code(core.sync_handle(a, "flush", false), libc::EIO);
    assert!(core.nodes[&ino].dirty);
    core.write(b, 5, b"command").unwrap();
    core.sync_handle(b, "flush", false).unwrap();
    assert_eq!(
        trace(root.path()),
        vec![json!(["long-", ""]), json!(["long-command", ""])]
    );
    core.shutdown().unwrap();
}
fn persist(core: &mut Core, fh: u64, operation: &str) {
    if operation == "timer" {
        let ino = core.handles[&fh].ino;
        core.nodes.get_mut(&ino).unwrap().dirty_at = Some(Instant::now() - Duration::from_secs(1));
        core.flush_due();
        assert!(!core.nodes[&ino].dirty);
    } else {
        core.sync_handle(fh, operation, false).unwrap();
    }
}
fn sequential_sink(operation: &str) {
    let (root, mut core) = provider(&sink_module("zero", true, false, false));
    let (_, fh) = opened(&mut core, "data", 1);
    core.write(fh, 0, b"one").unwrap();
    persist(&mut core, fh, operation);
    code(core.write(fh, 0, b"wrong"), libc::ESPIPE);
    core.write(fh, 3, b"t").unwrap();
    core.write(fh, 4, b"wo").unwrap();
    persist(&mut core, fh, operation);
    assert_eq!(
        trace(root.path()),
        vec![json!(["one", ""]), json!(["two", ""])]
    );
    core.shutdown().unwrap();
}
#[test]
fn does_not_pad_sequential_zero_sized_sinks_after_flush() {
    sequential_sink("flush");
}
#[test]
fn does_not_pad_sequential_zero_sized_sinks_after_fsync() {
    sequential_sink("fsync");
}
#[test]
fn does_not_pad_sequential_zero_sized_sinks_after_timer() {
    sequential_sink("timer");
}
#[test]
fn retains_sequential_sink_chunks_after_failed_flushes_and_combines_open_writers() {
    let (root, mut core) = provider(&sink_module("zero", true, false, true));
    let (_, a) = opened(&mut core, "data", 1);
    let (_, b) = opened(&mut core, "data", 1);
    core.write(a, 0, b"one").unwrap();
    code(core.sync_handle(a, "flush", false), libc::EIO);
    core.write(a, 3, b"-two").unwrap();
    core.write(b, 0, b"-three").unwrap();
    core.sync_handle(b, "flush", false).unwrap();
    core.write(a, 7, b"four").unwrap();
    core.sync_handle(a, "flush", false).unwrap();
    assert_eq!(
        trace(root.path()),
        vec![
            json!(["one", ""]),
            json!(["one-two-three", ""]),
            json!(["four", ""])
        ]
    );
    core.shutdown().unwrap();
}
#[test]
fn preserves_finite_sequential_file_offsets_before_and_after_the_empty_file_is_persisted() {
    let (root, mut core) = provider(
        r#"
        import {appendFile} from "node:fs/promises";import path from "node:path";let bytes=Buffer.alloc(0);
        export default {getattr(){return {kind:"file",size:bytes.length,sizeMode:"explicit",seekable:false};},readFile(){return bytes;},
            async writeFile(next,c){bytes=Buffer.from(next);await appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify(bytes.toString())+"\n");}};
    "#,
    );
    let (_, a) = opened(&mut core, "data", 1);
    let (_, b) = opened(&mut core, "data", 1);
    core.write(a, 0, b"one").unwrap();
    core.write(b, 0, b"X").unwrap();
    core.sync_handle(b, "flush", false).unwrap();
    core.write(b, 1, b"Y").unwrap();
    core.sync_handle(b, "flush", false).unwrap();
    core.write(a, 3, b"two").unwrap();
    core.sync_handle(a, "flush", false).unwrap();
    assert_eq!(
        trace(root.path()),
        vec![json!("Xne"), json!("XYe"), json!("XYetwo")]
    );
    core.shutdown().unwrap();
}
#[test]
fn does_not_discard_unreadable_nonempty_contents_when_buffering_a_partial_write() {
    let (root, mut core) = provider(
        r#"import {appendFile} from "node:fs/promises";import path from "node:path";export default {getattr(){return {kind:"file",size:4};},writeFile(b,c){return appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify(b.toString())+"\n");}};"#,
    );
    let (ino, fh) = opened(&mut core, "data", 1);
    code(core.write(fh, 0, b"X"), libc::ENOENT);
    assert!(!core.nodes[&ino].dirty);
    assert!(trace(root.path()).is_empty());
    core.shutdown().unwrap();
}
#[test]
fn reports_symlink_type_and_returns_the_link_target() {
    let (root, mut core) = native();
    fs::create_dir(root.path().join("source/directory")).unwrap();
    std::os::unix::fs::symlink("directory", root.path().join("source/link")).unwrap();
    let ino = core.lookup_node("link").unwrap();
    let m = core.attributes(ino, None).unwrap();
    assert_eq!(attr(ino, &m).kind, FileType::Symlink);
    assert_eq!(m.target.as_deref(), Some("directory"));
    assert_eq!(m.size, Some(9));
    assert_eq!(core.overlay.readlink("link").unwrap(), "directory");
    assert_eq!(core.link_target(ino).unwrap(), "directory");
    code(core.link_target(1), libc::EINVAL);
    code(core.link_target(u64::MAX), libc::ESTALE);
}
#[test]
fn rejects_read_only_writes_and_invalid_handles() {
    let (root, mut core) = native();
    put(root.path(), "data", b"abc");
    let (_, fh) = opened(&mut core, "data", 0);
    code(core.write(fh, 0, b"X"), libc::EBADF);
    code(core.sync_handle(12345, "flush", false), libc::EBADF);
    code(core.lookup_node("missing"), libc::ENOENT);
    assert_eq!(disk(root.path(), "data"), b"abc");
    core.shutdown().unwrap();
}
#[test]
fn does_not_deliver_empty_command_writes_for_truncate_or_close() {
    let (root, mut core) = provider(&sink_module("explicit", false, false, false));
    let ino = core.lookup_node("data").unwrap();
    core.truncate(ino, 0, None).unwrap();
    let fh = core.open_file(ino, 2).unwrap();
    core.sync_handle(fh, "flush", false).unwrap();
    assert!(trace(root.path()).is_empty());
    core.write(fh, 0, b"run").unwrap();
    core.sync_handle(fh, "flush", false).unwrap();
    core.release_handle(fh, false).unwrap();
    assert_eq!(trace(root.path()), vec![json!(["run", ""])]);
}
#[test]
fn reports_native_descriptor_metadata_after_replacement_by_a_shorter_file() {
    let (root, mut core) = native();
    put(root.path(), "data", b"ABCDEF");
    let (ino, fh) = opened(&mut core, "data", 2);
    replace(root.path(), "data", b"XY");
    assert_eq!(core.attributes(ino, Some(fh)).unwrap().size, Some(6));
    assert_eq!(core.read(fh, 0, 6).unwrap(), b"ABCDEF");
    truncate_handle(&mut core, fh, 4).unwrap();
    assert_eq!(core.attributes(ino, Some(fh)).unwrap().size, Some(4));
    let fresh = core.lookup_node("data").unwrap();
    assert_ne!(ino, fresh);
    assert_eq!(core.attributes(fresh, None).unwrap().size, Some(2));
    core.shutdown().unwrap();
}
#[test]
fn uses_provider_resource_metadata_and_preserves_detached_snapshot_metadata() {
    let (root, mut core) = backed("resource");
    put(root.path(), "data", b"ABCDEF");
    let (ino, fh) = opened(&mut core, "data", 2);
    replace(root.path(), "data", b"XY");
    assert_eq!(core.attributes(ino, Some(fh)).unwrap().size, Some(6));
    assert_eq!(core.read(fh, 0, 6).unwrap(), b"ABCDEF");
    core.shutdown().unwrap();
}
#[test]
fn refreshes_captured_attributes_on_all_handles_sharing_a_provider_resource() {
    let (_root, mut core) = provider(
        r#"const shared={};export default {getattr(){return {kind:"file",mode:420,size:0};},open(){return shared;},fsetattr(){}};"#,
    );
    let (ino, a) = opened(&mut core, "data", 2);
    let (_, b) = opened(&mut core, "data", 2);
    assert!(core.handles[&a].provider.resource.is_some());
    assert_eq!(
        core.handles[&a].provider.resource,
        core.handles[&b].provider.resource
    );
    assert_ne!(
        core.handles[&a].provider.value,
        core.handles[&b].provider.value
    );
    core.set_attributes(ino, Some(b), None, &json!({"mode":0o600,"uid":123}))
        .unwrap();
    for fh in [a, b] {
        let m = core.attributes(ino, Some(fh)).unwrap();
        assert_eq!(m.mode.unwrap() & 0o7777, 0o600);
        assert_eq!(m.uid, Some(123));
    }
    core.shutdown().unwrap();
}
#[test]
fn captures_native_metadata_after_acquisition_rather_than_before_an_open_callback() {
    let (root, mut core) = provider_rules(
        json!([{"match":"data","provider":{"module":"default"}}]),
        r#"import {stat,writeFile} from "node:fs/promises";export default {async getattr({sourcePath}){return {kind:"file",size:(await stat(sourcePath)).size};},open({sourcePath}){return writeFile(sourcePath,"EXPANDED CONTENT");}};"#,
    );
    put(root.path(), "data", b"ORIGINAL");
    let (ino, fh) = opened(&mut core, "data", 2);
    assert_eq!(core.attributes(ino, Some(fh)).unwrap().size, Some(16));
    assert_eq!(core.read(fh, 0, 32).unwrap(), b"EXPANDED CONTENT");
    core.shutdown().unwrap();
}
#[test]
fn captures_native_directory_metadata_after_acquisition_and_applies_descriptor_changes() {
    let (root, mut core) = provider_rules(
        json!([{"match":"data","provider":{"module":"default"}}]),
        r#"import {stat,chmod} from "node:fs/promises";export default {async getattr({sourcePath}){return {kind:"directory",mode:(await stat(sourcePath)).mode&4095};},opendir({sourcePath}){return chmod(sourcePath,448);}};"#,
    );
    fs::create_dir(root.path().join("source/data")).unwrap();
    let ino = core.lookup_node("data").unwrap();
    let fh = core.open(ino, 0, None, true).unwrap();
    assert_eq!(
        core.attributes(ino, Some(fh)).unwrap().mode.unwrap() & 0o7777,
        0o700
    );
    core.set_attributes(ino, Some(fh), None, &json!({"mode":0o600}))
        .unwrap();
    assert_eq!(
        core.attributes(ino, Some(fh)).unwrap().mode.unwrap() & 0o7777,
        0o600
    );
    core.release_handle(fh, true).unwrap();
}
fn captured_native(defaults: bool) {
    let module = if defaults {
        r#"export default {getattr(){return {kind:"file",mode:488,mtime:new Date(1000)};}};"#
    } else {
        r#"import {stat} from "node:fs/promises";export default {async getattr({sourcePath}){return {kind:"file",size:(await stat(sourcePath)).size,mode:488,mtime:new Date(1000)};}};"#
    };
    let mut rule = json!({"match":"data","provider":{"module":"default"}});
    if defaults {
        rule["file"] = json!({"size":8});
    }
    let (root, mut core) = provider_rules(json!([rule]), module);
    put(root.path(), "data", b"ORIGINAL");
    let (ino, a) = opened(&mut core, "data", 2);
    let (_, b) = opened(&mut core, "data", 2);
    let initial = core.attributes(ino, Some(a)).unwrap();
    assert_eq!(initial.size, Some(8));
    assert_eq!(initial.mode, Some(0o750));
    assert_eq!(initial.mtime.unwrap().millis, 1000);
    truncate_handle(&mut core, a, 0).unwrap();
    for fh in [a, b] {
        assert_eq!(core.attributes(ino, Some(fh)).unwrap().size, Some(0));
    }
    core.write(b, 0, b"EXPANDED CONTENT").unwrap();
    for fh in [a, b] {
        assert_eq!(core.attributes(ino, Some(fh)).unwrap().size, Some(16));
    }
    assert_eq!(core.read(a, 0, 32).unwrap(), b"EXPANDED CONTENT");
    core.truncate(ino, 4, None).unwrap();
    for fh in [a, b] {
        assert_eq!(core.attributes(ino, Some(fh)).unwrap().size, Some(4));
    }
    core.set_attributes(
        ino,
        Some(b),
        None,
        &json!({"mode":0o600,"mtime":{"$date":2000}}),
    )
    .unwrap();
    for fh in [a, b] {
        let m = core.attributes(ino, Some(fh)).unwrap();
        assert_eq!(m.mode.unwrap() & 0o7777, 0o600);
        assert_eq!(m.mtime.unwrap().millis, 2000);
    }
    fs::rename(
        root.path().join("source/data"),
        root.path().join("source/retained"),
    )
    .unwrap();
    put(root.path(), "data", b"NEW");
    for fh in [a, b] {
        assert_eq!(core.attributes(ino, Some(fh)).unwrap().size, Some(4));
    }
    assert_eq!(core.read(a, 0, 32).unwrap(), b"EXPA");
    core.write(b, 0, b"RETAINED CONTENT").unwrap();
    for fh in [a, b] {
        assert_eq!(core.attributes(ino, Some(fh)).unwrap().size, Some(16));
    }
    assert_eq!(disk(root.path(), "data"), b"NEW");
    core.shutdown().unwrap();
}
#[test]
fn updates_captured_native_sizes_and_attributes_from_metadata_across_shared_handles() {
    captured_native(false);
}
#[test]
fn updates_captured_native_sizes_and_attributes_from_defaults_across_shared_handles() {
    captured_native(true);
}
fn captured_policy(policy: &str) {
    let module = format!(
        r#"export default {{getattr(){{return {{kind:"file",size:8,sizeMode:"{policy}"}};}}}};"#
    );
    let (root, mut core) = provider_rules(
        json!([{"match":"data","provider":{"module":"default"}}]),
        &module,
    );
    put(root.path(), "data", b"ORIGINAL");
    let (ino, fh) = opened(&mut core, "data", 2);
    truncate_handle(&mut core, fh, 0).unwrap();
    core.write(fh, 0, b"X").unwrap();
    assert_eq!(
        core.attributes(ino, Some(fh)).unwrap().size,
        Some(if policy == "zero" { 0 } else { 8 })
    );
    assert_eq!(disk(root.path(), "data"), b"X");
    core.shutdown().unwrap();
}
#[test]
fn preserves_the_zero_policy_of_captured_native_size_overrides() {
    captured_policy("zero");
}
#[test]
fn preserves_the_unbounded_policy_of_captured_native_size_overrides() {
    captured_policy("unbounded");
}
#[test]
fn keeps_explicit_native_fgetattr_callbacks_authoritative_after_writes() {
    let (root, mut core) = provider_rules(
        json!([{"match":"data","provider":{"module":"default"}}]),
        r#"export default {getattr(){return {kind:"file",size:8};},fgetattr(){return {kind:"file",size:23};}};"#,
    );
    put(root.path(), "data", b"ORIGINAL");
    let (ino, fh) = opened(&mut core, "data", 2);
    core.write(fh, 0, b"X").unwrap();
    assert_eq!(core.attributes(ino, Some(fh)).unwrap().size, Some(23));
    assert_eq!(disk(root.path(), "data"), b"XRIGINAL");
    core.shutdown().unwrap();
}

fn handleless_metadata(directory: bool, change: &str) {
    let module = format!(
        r#"
        import {{readFileSync}} from "node:fs";import {{appendFile}} from "node:fs/promises";import path from "node:path";
        const original={{kind:"{}",identity:"original",mode:493}},replacement={{kind:"{}",identity:"replacement",mode:493}};
        function options(c){{try{{return readFileSync(path.join(c.sourcePath,"..","control"),"utf8");}}catch(e){{if(e.code==="ENOENT")return "unchanged";throw e;}}}}
        export default {{getattr(c){{if(c.path==="alias")return original;const change=options(c);return change==="remove"?undefined:change==="unchanged"?original:replacement;}},
            async fsetattr(changes,c){{const entry=c.path==="alias"||options(c)==="unchanged"?original:replacement;Object.assign(entry,changes);await appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify([c.path,entry.identity,entry.mode])+"\n");}}}};
    "#,
        if directory { "directory" } else { "file" },
        if directory { "directory" } else { "file" }
    );
    let (root, mut core) = provider(&module);
    let ino = core.lookup_node("data").unwrap();
    let fh = if directory {
        core.open(ino, 0, None, true).unwrap()
    } else {
        core.open_file(ino, 2).unwrap()
    };
    if change == "alias" {
        assert_eq!(core.lookup_node("alias").unwrap(), ino);
    }
    fs::write(root.path().join("source/control"), change).unwrap();
    let changing = core.set_attributes(ino, Some(fh), None, &json!({"mode":0o700}));
    if change == "unchanged" || change == "alias" {
        changing.unwrap();
        assert_eq!(
            trace(root.path()),
            vec![json!([
                if change == "alias" { "alias" } else { "data" },
                "original",
                0o700
            ])]
        );
    } else {
        code(changing, libc::ESTALE);
        assert!(trace(root.path()).is_empty());
    }
    core.release_handle(fh, directory).unwrap();
}
#[test]
fn checks_handleless_file_identity_before_metadata_changes_after_unchanged() {
    handleless_metadata(false, "unchanged");
}
#[test]
fn checks_handleless_file_identity_before_metadata_changes_after_replace() {
    handleless_metadata(false, "replace");
}
#[test]
fn checks_handleless_file_identity_before_metadata_changes_after_remove() {
    handleless_metadata(false, "remove");
}
#[test]
fn checks_handleless_file_identity_before_metadata_changes_after_alias() {
    handleless_metadata(false, "alias");
}
#[test]
fn checks_handleless_directory_identity_before_metadata_changes_after_unchanged() {
    handleless_metadata(true, "unchanged");
}
#[test]
fn checks_handleless_directory_identity_before_metadata_changes_after_replace() {
    handleless_metadata(true, "replace");
}
#[test]
fn checks_handleless_directory_identity_before_metadata_changes_after_remove() {
    handleless_metadata(true, "remove");
}
fn distinct_attributes(identified: bool) {
    let module = format!(
        r#"export default {{getattr(){{return {{kind:"file",{}mode:420,size:0}};}},open(){{return {{}};}},fsetattr(){{}}}};"#,
        if identified {
            "identity:\"shared\","
        } else {
            ""
        }
    );
    let (_root, mut core) = provider(&module);
    let (ino, a) = opened(&mut core, "data", 2);
    let (_, b) = opened(&mut core, "data", 2);
    assert!(core.handles[&a].provider.resource.is_some());
    assert!(core.handles[&b].provider.resource.is_some());
    assert_ne!(
        core.handles[&a].provider.resource,
        core.handles[&b].provider.resource
    );
    assert_ne!(
        core.handles[&a].provider.value,
        core.handles[&b].provider.value
    );
    let changes =
        json!({"mode":0o600,"uid":123,"gid":456,"atime":{"$date":1000},"mtime":{"$date":2000}});
    core.set_attributes(ino, Some(b), None, &changes).unwrap();
    let modified = core.attributes(ino, Some(b)).unwrap();
    assert_eq!(modified.mode, Some(0o600));
    assert_eq!(modified.uid, Some(123));
    assert_eq!(modified.gid, Some(456));
    assert_eq!(modified.atime.unwrap().millis, 1000);
    assert_eq!(modified.mtime.unwrap().millis, 2000);
    core.release_handle(b, false).unwrap();
    let retained = core.attributes(ino, Some(a)).unwrap();
    assert_eq!(retained.mode, Some(if identified { 0o600 } else { 0o644 }));
    if identified {
        assert_eq!(retained.uid, Some(123));
        assert_eq!(retained.mtime.unwrap().millis, 2000);
    }
    core.shutdown().unwrap();
}
#[test]
fn shares_captured_attributes_across_distinct_open_resources_only_with_a_stable_identity_true() {
    distinct_attributes(true);
}
#[test]
fn shares_captured_attributes_across_distinct_open_resources_only_with_a_stable_identity_false() {
    distinct_attributes(false);
}
fn native_path_override(operation: &str) {
    let (root, mut core) = provider_rules(
        json!([{"match":"**","provider":{"module":"default"}}]),
        r#"
        import {appendFile,truncate,chmod} from "node:fs/promises";import path from "node:path";
        const log=(c,op)=>appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify(op)+"\n");
        export default {async ftruncate(n,c){await log(c,"truncate");await truncate(c.sourcePath,n);},async fsetattr(changes,c){await log(c,"setattr");await chmod(c.sourcePath,changes.mode);}};
    "#,
    );
    put(root.path(), "data", b"ORIGINAL");
    let (ino, fh) = opened(&mut core, "data", 2);
    replace(root.path(), "data", b"NEW");
    let changing = if operation == "ftruncate" {
        truncate_handle(&mut core, fh, 0)
    } else {
        core.set_attributes(ino, Some(fh), None, &json!({"mode":0o600}))
    };
    code(changing, libc::ESTALE);
    assert!(trace(root.path()).is_empty());
    assert_eq!(core.read(fh, 0, 8).unwrap(), b"ORIGINAL");
    assert_eq!(disk(root.path(), "data"), b"NEW");
    core.shutdown().unwrap();
}
#[test]
fn checks_path_based_ftruncate_overrides_even_when_native_i_o_retains_a_descriptor() {
    native_path_override("ftruncate");
}
#[test]
fn checks_path_based_fsetattr_overrides_even_when_native_i_o_retains_a_descriptor() {
    native_path_override("fsetattr");
}
fn virtual_directory(replacing: bool, identified: bool) {
    let module = format!(
        r#"
        import {{readFileSync}} from "node:fs";import path from "node:path";
        const entries=new Map([["old",{{kind:"directory",mode:493,{}}}],["replacement",{{kind:"directory",mode:448,{}}}]]);
        export default {{getattr({{path}}){{return entries.get(path);}},readdir(){{return [];}},
            rmdir(c){{if(readFileSync(path.join(c.sourcePath,"..","control"),"utf8")==="deny")throw Object.assign(new Error("busy"),{{code:"ENOTEMPTY"}});entries.delete(c.path);}},
            mkdir(m,{{path}}){{entries.set(path,m);}},rename({{path,destinationPath}}){{entries.set(destinationPath,entries.get(path));entries.delete(path);}}}};
    "#,
        if identified { "identity:\"old\"" } else { "" },
        if identified { "identity:\"new\"" } else { "" }
    );
    let (root, mut core) = provider(&module);
    fs::write(root.path().join("source/control"), "deny").unwrap();
    let ino = core.lookup_node("old").unwrap();
    let fh = core.open(ino, 0, None, true).unwrap();
    assert!(core.directory_entries(ino, fh, 0).unwrap().is_empty());
    if replacing {
        core.rename("replacement", "old", 0).unwrap();
    } else {
        code(core.remove("old", true), libc::ENOTEMPTY);
        assert_eq!(attr(ino, &core.attributes(ino, Some(fh)).unwrap()).nlink, 2);
        fs::write(root.path().join("source/control"), "allow").unwrap();
        core.remove("old", true).unwrap();
        core.overlay.mkdir("old", 0o700).unwrap();
    }
    let fresh = core.lookup_node("old").unwrap();
    assert_ne!(fresh, ino);
    assert_eq!(core.attributes(fresh, None).unwrap().mode, Some(0o700));
    let old = core.attributes(ino, Some(fh)).unwrap();
    assert_eq!(old.mode, Some(0o755));
    assert_eq!(old.nlink, Some(0));
    let new_fh = core.open(fresh, 0, None, true).unwrap();
    assert_eq!(
        attr(fresh, &core.attributes(fresh, Some(new_fh)).unwrap()).nlink,
        2
    );
    core.release_handle(new_fh, true).unwrap();
    core.release_handle(fh, true).unwrap();
}
#[test]
fn retains_virtual_directory_metadata_through_rmdir_with_identity_false() {
    virtual_directory(false, false);
}
#[test]
fn retains_virtual_directory_metadata_through_rmdir_with_identity_true() {
    virtual_directory(false, true);
}
#[test]
fn retains_virtual_directory_metadata_through_replace_with_identity_false() {
    virtual_directory(true, false);
}
#[test]
fn retains_virtual_directory_metadata_through_replace_with_identity_true() {
    virtual_directory(true, true);
}
fn whole_truncation(size: u64) {
    let module = r#"
        import {appendFile} from "node:fs/promises";import path from "node:path";let bytes=Buffer.from("abcdef");
        export default {getattr(){return {kind:"file",size:bytes.length};},readFile(){return bytes;},async writeFile(b,c){bytes=Buffer.from(b);await appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify([...bytes])+"\n");}};
    "#;
    let (root, mut core) = provider(module);
    let (_, fh) = opened(&mut core, "data", 2);
    truncate_handle(&mut core, fh, size).unwrap();
    core.sync_handle(fh, "fsync", false).unwrap();
    core.release_handle(fh, false).unwrap();
    let (_, reopened) = opened(&mut core, "data", 2);
    let mut expected = b"abcdef".to_vec();
    expected.resize(size as usize, 0);
    assert_eq!(core.read(reopened, 0, size as u32).unwrap(), expected);
    assert_eq!(trace(root.path()), vec![json!(expected)]);
    core.shutdown().unwrap();
}
#[test]
fn persists_ordinary_whole_file_truncation_to_0_bytes_across_fsync_and_reopen() {
    whole_truncation(0);
}
#[test]
fn persists_ordinary_whole_file_truncation_to_3_bytes_across_fsync_and_reopen() {
    whole_truncation(3);
}
#[test]
fn persists_ordinary_whole_file_truncation_to_9_bytes_across_fsync_and_reopen() {
    whole_truncation(9);
}
fn mixed_io(read_file: bool) {
    let module = format!(
        r#"
        let bytes=Buffer.from("abcdef");export default {{getattr(){{return {{kind:"file",size:bytes.length}};}},read(p,n){{return bytes.subarray(p,p+n);}},
            {}writeFile(b){{bytes=Buffer.from(b);}}}};
    "#,
        if read_file {
            "readFile(){return bytes;},"
        } else {
            ""
        }
    );
    let (_root, mut core) = provider(&module);
    let (_, a) = opened(&mut core, "data", 2);
    core.write(a, 0, b"Y").unwrap();
    assert_eq!(core.read(a, 0, 6).unwrap(), b"Ybcdef");
    core.sync_handle(a, "flush", false).unwrap();
    let (_, b) = opened(&mut core, "data", 2 | libc::O_TRUNC);
    core.write(b, 0, b"X").unwrap();
    assert_eq!(core.read(b, 0, 6).unwrap(), b"X");
    core.sync_handle(b, "fsync", false).unwrap();
    let (_, fresh) = opened(&mut core, "data", 2);
    assert_eq!(core.read(fresh, 0, 6).unwrap(), b"X");
    core.shutdown().unwrap();
}
#[test]
fn keeps_mixed_i_o_coherent_with_partial_writes_and_o_trunc_readfile_false() {
    mixed_io(false);
}
#[test]
fn keeps_mixed_i_o_coherent_with_partial_writes_and_o_trunc_readfile_true() {
    mixed_io(true);
}
#[test]
fn assembles_short_positional_reads_using_retained_and_temporary_provider_resources() {
    let (root, mut core) = provider(
        r#"
        import {appendFile} from "node:fs/promises";import path from "node:path";let bytes=Buffer.from("abcdef");
        const log=(c,e,v)=>appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify([e,v])+"\n");
        export default {getattr(){return {kind:"file",size:bytes.length};},fgetattr(){return {kind:"file",size:bytes.length};},
            async open(c){await log(c,"open",c.flags);return "resource";},read(p,n,{handle}){if(handle!=="resource")throw new Error("bad resource");return bytes.subarray(p,p+Math.min(n,2));},
            async writeFile(b,c){bytes=Buffer.from(b);await log(c,"write",c.previousContents.toString());},release(c){return log(c,"release",c.handle);}};
    "#,
    );
    let (_, fh) = opened(&mut core, "data", 2);
    core.write(fh, 2, b"X").unwrap();
    assert_eq!(core.read(fh, 0, 6).unwrap(), b"abXdef");
    assert_eq!(trace(root.path()), vec![json!(["open", 2])]);
    core.sync_handle(fh, "flush", false).unwrap();
    let events = trace(root.path());
    assert_eq!(events.iter().filter(|v| v[0] == "open").count(), 2);
    assert_eq!(events.iter().filter(|v| v[0] == "release").count(), 1);
    assert!(events.contains(&json!(["write", "abcdef"])));
    truncate_handle(&mut core, fh, 4).unwrap();
    core.sync_handle(fh, "flush", false).unwrap();
    assert_eq!(core.read(fh, 0, 8).unwrap(), b"abXd");
    core.shutdown().unwrap();
}
fn assembly_race(operation: &str, removal: bool) {
    let module = format!(
        r#"
        import {{appendFile}} from "node:fs/promises";import path from "node:path";let entry={{identity:"original",bytes:Buffer.from("ORIGINAL")}};
        const log=(c,e)=>appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify(e)+"\n");
        export default {{getattr(){{return entry&&{{kind:"file",identity:entry.identity,size:entry.bytes.length}};}},
            async read(p,n,c){{await log(c,"read");const b=entry.bytes.subarray(p,p+Math.min(n,2));entry={};return b;}},
            writeFile(_b,c){{return log(c,"write");}},unlink(c){{entry=undefined;return log(c,"unlink");}}}};
    "#,
        if removal {
            "undefined"
        } else {
            "{identity:\"replacement\",bytes:Buffer.from(\"REPLACED\")}"
        }
    );
    let (root, mut core) = provider(&module);
    let (_, fh) = opened(&mut core, "data", 2);
    if operation == "write" {
        code(core.write(fh, 0, b"X"), libc::ESTALE);
    } else {
        code(core.remove("data", false), libc::ESTALE);
    }
    core.release_handle(fh, false).unwrap();
    assert_eq!(trace(root.path()), vec![json!("read")]);
    if removal {
        code(core.lookup_node("data"), libc::ENOENT);
    } else {
        let (_, fresh) = opened(&mut core, "data", 0);
        assert_eq!(core.nodes[&core.handles[&fresh].ino].metadata.size, Some(8));
    }
    core.shutdown().unwrap();
}
#[test]
fn rejects_replace_while_assembling_a_positional_buffer_for_write() {
    assembly_race("write", false);
}
#[test]
fn rejects_remove_while_assembling_a_positional_buffer_for_write() {
    assembly_race("write", true);
}
#[test]
fn rejects_replace_while_assembling_a_positional_buffer_for_unlink() {
    assembly_race("unlink", false);
}
#[test]
fn rejects_remove_while_assembling_a_positional_buffer_for_unlink() {
    assembly_race("unlink", true);
}
fn writeonly_mixed(fail_read: bool) {
    let module = format!(
        r#"{BACKED}
        const originalOpen=mixed.open,originalRead=mixed.read,originalRelease=mixed.release;
        const log=(c,event)=>appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify([event,c.flags])+"\n");
        mixed.open=async c=>{{await log(c,"open");return originalOpen(c);}};
        mixed.read=async(p,n,c)=>{{await log(c,"read");if(c.flags!==0)throw new Error("reader access flags");if({fail_read})throw Object.assign(new Error("read failed"),{{code:"EIO"}});return originalRead(p,n,c);}};
        mixed.release=async c=>{{await log(c,"release");return originalRelease(c);}};
    "#
    );
    let (root, mut core) = provider_rules(
        json!([{"match":"**","opaque":true,"provider":{"module":"mixed"}}]),
        &module,
    );
    put(root.path(), "data", b"abcdef");
    let (_, fh) = opened(&mut core, "data", 1 | libc::O_APPEND);
    if fail_read {
        code(core.write(fh, 6, b"X"), libc::EIO);
        assert_eq!(disk(root.path(), "data"), b"abcdef");
    } else {
        core.write(fh, 6, b"X").unwrap();
        core.sync_handle(fh, "flush", false).unwrap();
        assert_eq!(disk(root.path(), "data"), b"abcdefX");
    }
    let events = trace(root.path());
    let opens = events.iter().filter(|v| v[0] == "open").count();
    let releases = events.iter().filter(|v| v[0] == "release").count();
    assert!(opens >= 2);
    assert_eq!(releases, opens - 1);
    assert_eq!(events[0], json!(["open", 1 | libc::O_APPEND]));
    assert!(
        events
            .iter()
            .filter(|v| v[0] == "open")
            .skip(1)
            .all(|v| v[1] == 0)
    );
    core.release_handle(fh, false).unwrap();
    let events = trace(root.path());
    assert_eq!(
        events.iter().filter(|v| v[0] == "open").count(),
        events.iter().filter(|v| v[0] == "release").count()
    );
}
#[test]
fn uses_and_releases_readable_resources_for_write_only_mixed_i_o_read_failure_false() {
    writeonly_mixed(false);
}
#[test]
fn uses_and_releases_readable_resources_for_write_only_mixed_i_o_read_failure_true() {
    writeonly_mixed(true);
}
#[test]
fn snapshots_mixed_i_o_resources_before_unlink_instead_of_writing_to_their_replacement() {
    let (root, mut core) = backed("mixed");
    put(root.path(), "data", b"OLD");
    let (_, fh) = opened(&mut core, "data", 2);
    core.remove("data", false).unwrap();
    put(root.path(), "data", b"NEW");
    core.write(fh, 0, b"X").unwrap();
    core.sync_handle(fh, "flush", false).unwrap();
    assert_eq!(core.read(fh, 0, 3).unwrap(), b"XLD");
    assert_eq!(disk(root.path(), "data"), b"NEW");
    core.shutdown().unwrap();
}
#[test]
fn snapshots_write_only_mixed_resources_using_a_separate_reader_before_unlink() {
    let module = format!(
        r#"{BACKED}
        const originalOpen=mixed.open,originalRead=mixed.read,originalRelease=mixed.release;
        const log=(c,event)=>appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify([event,c.flags])+"\n");
        mixed.open=async c=>{{await log(c,"open");return originalOpen(c);}};
        mixed.read=(p,n,c)=>{{if((c.flags&3)===1)throw Object.assign(new Error("write-only"),{{code:"EBADF"}});return originalRead(p,n,c);}};
        mixed.release=async c=>{{await log(c,"release");return originalRelease(c);}};
    "#
    );
    let (root, mut core) = provider_rules(
        json!([{"match":"**","opaque":true,"provider":{"module":"mixed"}}]),
        &module,
    );
    put(root.path(), "data", b"ABC");
    let (_, writer) = opened(&mut core, "data", 1);
    let (_, reader) = opened(&mut core, "data", 0);
    core.remove("data", false).unwrap();
    let events = trace(root.path());
    assert_eq!(events.iter().filter(|v| v[0] == "open").count(), 3);
    assert_eq!(events.iter().filter(|v| v[0] == "release").count(), 1);
    assert!(events.contains(&json!(["release", 0])));
    core.write(writer, 0, b"X").unwrap();
    core.sync_handle(writer, "flush", false).unwrap();
    assert_eq!(core.read(reader, 0, 3).unwrap(), b"XBC");
    assert!(!root.path().join("source/data").exists());
    core.shutdown().unwrap();
}
fn unbufferable(unbounded: bool) {
    let module = format!(
        r#"import {{appendFile}} from "node:fs/promises";import path from "node:path";export default {{getattr(){{return {{kind:"file",size:4,sizeMode:"{}",seekable:{}}};}},read(_p,_n,c){{return appendFile(path.join(c.sourcePath,"..","trace.jsonl"),"true\n").then(()=>Buffer.from("data"));}},writeFile(_b,c){{return appendFile(path.join(c.sourcePath,"..","trace.jsonl"),"false\n");}}}};"#,
        if unbounded { "unbounded" } else { "explicit" },
        unbounded
    );
    let (root, mut core) = provider(&module);
    let (_, fh) = opened(&mut core, "data", 2);
    code(core.write(fh, 0, b"X"), libc::EOPNOTSUPP);
    assert!(trace(root.path()).is_empty());
    core.shutdown().unwrap();
}
#[test]
fn rejects_whole_file_buffering_of_a_unbounded_positional_reader() {
    unbufferable(true);
}
#[test]
fn rejects_whole_file_buffering_of_a_non_seekable_positional_reader() {
    unbufferable(false);
}
#[test]
fn preserves_dirty_buffered_writes_when_a_provider_also_implements_truncate() {
    let (root, mut core) = backed("whole");
    put(root.path(), "data", b"abcdef");
    let (_, fh) = opened(&mut core, "data", 2);
    core.write(fh, 0, b"X").unwrap();
    truncate_handle(&mut core, fh, 3).unwrap();
    core.sync_handle(fh, "flush", false).unwrap();
    assert_eq!(disk(root.path(), "data"), b"Xbc");
    core.shutdown().unwrap();
}
#[test]
fn converts_native_millisecond_timestamps_to_dates_for_source_and_provider_operations() {
    let (root, mut core) = native();
    put(root.path(), "data", b"data");
    let ino = core.lookup_node("data").unwrap();
    core.set_attributes(
        ino,
        None,
        None,
        &json!({"atime":{"$date":100125},"mtime":{"$date":200750}}),
    )
    .unwrap();
    let m = core.metadata(ino).unwrap();
    assert_eq!(m.atime.unwrap().millis, 100125);
    assert_eq!(m.mtime.unwrap().millis, 200750);
    let (root, mut core) = provider(
        r#"import {appendFile} from "node:fs/promises";import path from "node:path";export default {getattr(){return {kind:"file",size:0};},utimens(a,m,c){if(!(a instanceof Date)||!(m instanceof Date))throw new Error("not Dates");return appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify([a.getTime(),m.getTime()])+"\n");}};"#,
    );
    let ino = core.lookup_node("data").unwrap();
    core.set_attributes(
        ino,
        None,
        None,
        &json!({"atime":{"$date":100125},"mtime":{"$date":200750}}),
    )
    .unwrap();
    assert_eq!(trace(root.path()), vec![json!([100125, 200750])]);
    core.shutdown().unwrap();
}
#[test]
fn honors_non_seekable_metadata_on_created_provider_files() {
    let (_root, mut core) = provider(
        r#"let exists=false;export default {create(){exists=true;},getattr(){if(exists)return {kind:"file",size:0,seekable:false};},write(b){return b.length;}};"#,
    );
    let (_, fh) = core.create_file("data", 0o644, 2).unwrap();
    assert!(core.direct_io(fh));
    code(core.write(fh, 1, b"X"), libc::ESPIPE);
    assert_eq!(core.write(fh, 0, b"X").unwrap(), 1);
    core.shutdown().unwrap();
}

#[test]
fn descriptor_dispatch_and_distinct_mtime() {
    let (root, mut core) = native();
    put(root.path(), "data", b"ABCDEF");
    let (ino, fh) = opened(&mut core, "data", 2);
    replace(root.path(), "data", b"XY");
    core.set_attributes(
        ino,
        Some(fh),
        None,
        &json!({"atime":{"$date":100125},"mtime":{"$date":200750}}),
    )
    .unwrap();
    let captured = core.attributes(ino, Some(fh)).unwrap();
    assert_eq!(captured.size, Some(6));
    assert_eq!(captured.atime.as_ref().unwrap().millis, 100125);
    assert_eq!(captured.mtime.as_ref().unwrap().millis, 200750);
    let native_attr = attr(ino, &captured);
    assert_eq!(
        native_attr.atime,
        UNIX_EPOCH + Duration::from_millis(100125)
    );
    assert_eq!(
        native_attr.mtime,
        UNIX_EPOCH + Duration::from_millis(200750)
    );
    let fresh = core.lookup_node("data").unwrap();
    assert_ne!(fresh, ino);
    assert_eq!(core.attributes(fresh, None).unwrap().size, Some(2));
    assert_ne!(core.metadata(fresh).unwrap().mtime.unwrap().millis, 200750);
    core.shutdown().unwrap();
}
#[test]
fn unsupported_native_abi_negotiation() {
    // Package-version patching is gone; native initialization must reject missing required ABI capabilities.
    let (root, mut core) = native();
    put(root.path(), "data", b"untouched");
    let ino = core.lookup_node("data").unwrap();
    assert_eq!(
        kernel_initialization(Err(fuser::consts::FUSE_ATOMIC_O_TRUNC)),
        Err(libc::EOPNOTSUPP)
    );
    assert_eq!(kernel_initialization(Ok(())), Ok(()));
    assert!(core.handles.is_empty());
    assert_eq!(disk(root.path(), "data"), b"untouched");
    assert_eq!(core.nodes[&ino].metadata.size, Some(9));
}
#[test]
fn zero_nlink_is_not_defaulted() {
    let (root, mut core) = native();
    put(root.path(), "data", b"retained");
    let (ino, fh) = opened(&mut core, "data", 2);
    core.remove("data", false).unwrap();
    let m = core.attributes(ino, Some(fh)).unwrap();
    assert_eq!(attr(ino, &m).nlink, 0);
    let mut m = m;
    m.nlink = Some(2);
    assert_eq!(attr(ino, &m).nlink, 2);
    m.nlink = None;
    assert_eq!(attr(ino, &m).nlink, 1);
    assert_eq!(core.read(fh, 0, 8).unwrap(), b"retained");
    core.shutdown().unwrap();
}
#[test]
fn signed_dates_and_unsigned_sizes() {
    let (root, mut core) = native();
    put(root.path(), "data", b"x");
    let (ino, fh) = opened(&mut core, "data", 2);
    for time in [-4294967297i64, -200750, -1, 0, 1, 4294967297] {
        let atime = change_date(TimeOrNow::SpecificTime(Date { millis: time }.time()));
        let mtime = change_date(TimeOrNow::SpecificTime(Date { millis: -time }.time()));
        assert_eq!(atime.millis, time);
        assert_eq!(mtime.millis, -time);
        let changes = json!({"atime":atime,"mtime":mtime});
        core.set_attributes(ino, None, None, &changes).unwrap();
        let m = core.metadata(ino).unwrap();
        assert_eq!(m.atime.as_ref().unwrap().millis, time);
        assert_eq!(m.mtime.as_ref().unwrap().millis, -time);
        core.set_attributes(ino, Some(fh), None, &changes).unwrap();
        let mut m = core.attributes(ino, Some(fh)).unwrap();
        assert_eq!(m.atime.as_ref().unwrap().millis, time);
        assert_eq!(m.mtime.as_ref().unwrap().millis, -time);
        m.size = Some(8589934597);
        let native = attr(ino, &m);
        assert_eq!(native.size, 8589934597);
        assert_eq!(native.blocks, 8589934597u64.div_ceil(512));
        assert_eq!(native.atime, Date { millis: time }.time());
        assert_eq!(native.mtime, Date { millis: -time }.time());
    }
    core.shutdown().unwrap();
}
#[test]
fn direct_io_and_full_width_storage() {
    direct_create(false);
    direct_create(true);
    let (_root, mut core) = native();
    let mut stats = core.overlay.statfs("").unwrap();
    stats.f_blocks = 4294967303;
    stats.f_bfree = 6442450951;
    stats.f_bavail = 8589934597;
    stats.f_files = 17179869189;
    stats.f_ffree = 34359738369;
    let counters = storage_counts(&stats);
    assert_eq!(
        counters,
        [4294967303, 6442450951, 8589934597, 17179869189, 34359738369]
    );
    let (_root, mut core) = provider(
        r#"let exists=false;export default {getattr(){if(exists)return {kind:"file",size:0,seekable:true};},create(){exists=true;}};"#,
    );
    let (_, fh) = core.create_file("data", 0o644, 2).unwrap();
    assert!(!core.direct_io(fh));
    core.shutdown().unwrap();
}
#[test]
fn full_create_flags() {
    for flags in [64, 65, 66, 1089, 1052737] {
        create_flags(flags);
    }
}
#[test]
fn drifted_descriptor_contract_is_atomic() {
    // Source-patching drift checks are obsolete; compiled native ABI types and descriptor-kind validation replace them.
    fn native_abi<T: Filesystem>() {}
    native_abi::<Mount>();
    let (root, mut core) = provider(
        r#"
        import {appendFile} from "node:fs/promises";import path from "node:path";
        export default {getattr(){return {kind:"file",identity:"stable",size:3};},open(){return {resource:true};},
            fgetattr(){return {kind:"directory",identity:"stable",size:4096};},
            release(c){return appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify(c.handle)+"\n");}};
    "#,
    );
    let ino = core.lookup_node("data").unwrap();
    code(core.open_file(ino, 2), libc::ESTALE);
    assert!(core.handles.is_empty());
    assert_eq!(core.nodes[&ino].metadata.kind, Kind::File);
    assert_eq!(core.nodes[&ino].metadata.size, Some(3));
    assert_eq!(trace(root.path()), vec![json!({"resource":true})]);
    core.shutdown().unwrap();
}

fn provider_options_callbacks(options: Option<Value>, expectation: &str) {
    let mut reference = json!({"module":"default"});
    if let Some(options) = &options {
        reference["options"] = options.clone();
    }
    let input = json!({"modules":{"default":{"manifest":"./module"}},"filesystems":[{
        "name":"options","source":"source","mountPoint":"mount",
        "rules":[{"match":"**","opaque":true,"provider":reference}]
    }]});
    let config = crate::config::Config::parse(&serde_json::to_vec(&input).unwrap()).unwrap();
    let parsed = config.filesystems[0].rules[0].provider.as_ref().unwrap();
    assert_eq!(parsed.options, options);
    let serialized = serde_json::to_value(&config).unwrap();
    assert_eq!(
        serialized["filesystems"][0]["rules"][0]["provider"].get("options"),
        options.as_ref()
    );
    let module = format!(
        r#"
        import {{appendFile}} from "node:fs/promises";import path from "node:path";
        const expected={};
        async function check(c,operation){{
            const present=Object.prototype.hasOwnProperty.call(c,"options");
            const {{options={{defaulted:true}}}}=c;
            if(expected==="missing"&&(c.options!==undefined||options.defaulted!==true))
                throw new Error("missing options did not retain undefined/default destructuring");
            if(expected==="null"&&(!present||c.options!==null||options!==null))
                throw new Error("explicit null options did not retain null");
            if(expected==="literal"&&(!present||options instanceof Date||options.$date!==1234||
                options.nested[0]!==null||options.nested[1] instanceof Date||options.nested[1].$date!==2345))
                throw new Error("literal provider options were revived as dates");
            await appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify([operation,expected])+"\n");
        }}
        export default {{
            async getattr(c){{await check(c,"getattr");return {{kind:"file",size:Buffer.byteLength(expected)}};}},
            async readFile(c){{await check(c,"readFile");return Buffer.from(expected);}}
        }};
    "#,
        serde_json::to_string(expectation).unwrap()
    );
    let rules = serialized["filesystems"][0]["rules"].clone();
    let (root, mut core) = provider_rules(rules, &module);
    let (_, fh) = opened(&mut core, "data", libc::O_RDONLY);
    assert_eq!(core.read(fh, 0, 64).unwrap(), expectation.as_bytes());
    let calls = trace(root.path());
    assert!(
        calls
            .iter()
            .any(|call| call == &json!(["getattr", expectation]))
    );
    assert_eq!(
        calls
            .iter()
            .filter(|call| *call == &json!(["readFile", expectation]))
            .count(),
        1
    );
    core.shutdown().unwrap();
}

#[test]
fn missing_provider_options_are_undefined_in_actual_callbacks() {
    provider_options_callbacks(None, "missing");
}

#[test]
fn explicit_null_provider_options_remain_null_in_actual_callbacks() {
    provider_options_callbacks(Some(Value::Null), "null");
}

#[test]
fn literal_date_provider_options_are_not_revived_in_actual_callbacks() {
    provider_options_callbacks(
        Some(json!({"$date":1234,"nested":[null,{"$date":2345}]})),
        "literal",
    );
}

fn discard_without_release_callback(directory: bool) {
    let module = format!(
        r#"
        export default {{
            getattr(){{return {{kind:"{}",size:4}};}},
            {}(){{return 17;}},
            read(_position,_length,c){{if(c.handle!==17)throw new Error("lost resource");return Buffer.from("data");}},
            fsyncdir(_datasync,c){{if(c.handle!==17)throw new Error("lost directory resource");}},
            readdir(c){{if(c.handle!==undefined&&c.handle!==17)throw new Error("lost directory resource");return [];}}
        }};
    "#,
        if directory { "directory" } else { "file" },
        if directory { "opendir" } else { "open" }
    );
    let (_root, mut core) = provider_rules(
        json!([{"match":"data","opaque":true,"provider":{"module":"default"}}]),
        &module,
    );
    let ino = core.lookup_node("data").unwrap();
    let acquire = |core: &mut Core| {
        if directory {
            core.open(ino, libc::O_RDONLY, None, true).unwrap()
        } else {
            core.open_file(ino, libc::O_RDONLY).unwrap()
        }
    };
    let first = acquire(&mut core);
    let second = acquire(&mut core);
    let resource = core.handles[&first].provider.resource.unwrap();
    assert_eq!(core.handles[&second].provider.resource, Some(resource));
    assert_ne!(
        core.handles[&first].provider.value,
        core.handles[&second].provider.value
    );
    core.release_handle(first, directory).unwrap();
    if directory {
        code(core.directory_entries(ino, first, 0), libc::EBADF);
        core.sync_handle(second, "fsyncdir", false).unwrap();
        assert!(core.directory_entries(ino, second, 0).unwrap().is_empty());
    } else {
        code(core.read(first, 0, 4), libc::EBADF);
        assert_eq!(core.read(second, 0, 4).unwrap(), b"data");
    }
    let third = acquire(&mut core);
    assert_eq!(core.handles[&third].provider.resource, Some(resource));
    core.release_handle(second, directory).unwrap();
    core.release_handle(third, directory).unwrap();
    let fourth = acquire(&mut core);
    assert_ne!(core.handles[&fourth].provider.resource, Some(resource));
    core.release_handle(fourth, directory).unwrap();
    assert!(core.handles.is_empty());
    core.shutdown().unwrap();
}

#[test]
fn file_resources_without_release_callbacks_are_discarded() {
    discard_without_release_callback(false);
}

#[test]
fn directory_resources_without_release_callbacks_are_discarded() {
    discard_without_release_callback(true);
}

#[test]
fn directory_snapshot_pagination_retains_listing_inodes_until_release() {
    let (root, mut core) = native();
    put(root.path(), "first", b"one");
    put(root.path(), "second", b"two");
    let fh = core.open(1, 0, None, true).unwrap();
    let entries = core.directory_entries(1, fh, 0).unwrap();
    assert_eq!(
        entries.iter().map(|e| e.0.as_str()).collect::<Vec<_>>(),
        vec!["first", "second"]
    );
    for (_, kind, ino) in &entries {
        assert_eq!(*kind, FileType::RegularFile);
        assert_eq!(core.nodes[ino].lookups, 0);
        core.discard(*ino);
        assert!(core.nodes.contains_key(ino));
    }
    put(root.path(), "third", b"three");
    fs::remove_file(root.path().join("source/first")).unwrap();
    assert_eq!(core.directory_entries(1, fh, 0).unwrap(), entries);
    assert_eq!(core.directory_entries(1, fh, 1).unwrap(), entries[1..]);
    assert!(core.directory_entries(1, fh, 2).unwrap().is_empty());
    code(core.directory_entries(1, fh, -1), libc::EINVAL);
    core.release_handle(fh, true).unwrap();
    for (_, _, ino) in entries {
        assert!(!core.nodes.contains_key(&ino));
    }
    let fresh = core.open(1, 0, None, true).unwrap();
    let entries = core.directory_entries(1, fresh, 0).unwrap();
    assert_eq!(
        entries.iter().map(|e| e.0.as_str()).collect::<Vec<_>>(),
        vec!["second", "third"]
    );
    core.release_handle(fresh, true).unwrap();
    core.shutdown().unwrap();
}
#[test]
fn shutdown_releases_every_resource_even_when_flush_and_release_fail() {
    let (root, mut core) = provider(
        r#"
        import {appendFile} from "node:fs/promises";import path from "node:path";
        export default {getattr(){return {kind:"file",size:0};},open({path}){return {path};},
            writeFile(){throw Object.assign(new Error("flush-failure"),{code:"EIO"});},
            async release(c){await appendFile(path.join(c.sourcePath,"..","trace.jsonl"),JSON.stringify(c.handle.path)+"\n");throw new Error("release-failure:"+c.path);}};
    "#,
    );
    let (_, a) = opened(&mut core, "first", 2);
    let (_, b) = opened(&mut core, "second", 2);
    core.write(a, 0, b"A").unwrap();
    core.write(b, 0, b"B").unwrap();
    let error = core.shutdown().unwrap_err();
    let message = format!("{error:#}");
    assert!(message.contains("flush-failure"));
    assert!(message.contains("release-failure:first"));
    assert!(message.contains("release-failure:second"));
    assert!(core.handles.is_empty());
    let mut events = trace(root.path());
    events.sort_by_key(|v| v.as_str().unwrap().to_string());
    assert_eq!(events, vec![json!("first"), json!("second")]);
}
