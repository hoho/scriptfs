use super::*;

/// Loads `module` as the instance "default" and returns the provider reference
/// that requests use to address it.
fn load(worker: &Worker, module: &std::path::Path) -> Value {
    worker
        .request(
            json!({"op":"load","modules":{"default":{"entry":module,"export":"default","runtime":{"version":1,"name":"default"}}}}),
            &[],
        )
        .unwrap();
    json!({"module": "default"})
}

fn fixture(contents: &str) -> (tempfile::TempDir, Worker, Value) {
    let root = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
    let module = root.path().join("module.mjs");
    std::fs::write(&module, contents).unwrap();
    let worker = Worker::start().unwrap();
    let provider = load(&worker, &module);
    (root, worker, provider)
}

fn open(worker: &Worker, provider: &Value) -> Response {
    worker
        .request(
            json!({"op": "open", "provider": provider, "context": {}, "flags": 0}),
            &[],
        )
        .unwrap()
}

fn discard(worker: &Worker, handle: &Response) {
    worker
        .request(json!({"op": "discard", "handle": handle.value}), &[])
        .unwrap();
}

#[test]
#[cfg(target_os = "linux")]
fn owned_pipes_reserve_capacity_when_the_kernel_allows_it() {
    use std::os::fd::{FromRawFd, OwnedFd};
    let mut fds = [-1; 2];
    assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
    let input = unsafe { OwnedFd::from_raw_fd(fds[1]) };
    let _output = unsafe { OwnedFd::from_raw_fd(fds[0]) };
    let original = unsafe { libc::fcntl(input.as_raw_fd(), libc::F_GETPIPE_SZ) };
    assert!(original > 0);
    println!("Original pipe capacity: {original} bytes");
    let requested = 1024 * 1024;
    let available = unsafe { libc::fcntl(input.as_raw_fd(), libc::F_SETPIPE_SZ, requested) };
    if available >= 0 {
        assert!(available >= requested);
        assert_eq!(
            unsafe { libc::fcntl(input.as_raw_fd(), libc::F_SETPIPE_SZ, original) },
            original
        );
    } else {
        assert!(matches!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::EPERM) | Some(libc::EINVAL)
        ));
    }
    Worker::reserve_pipe(&input, "test").unwrap();
    let actual = unsafe { libc::fcntl(input.as_raw_fd(), libc::F_GETPIPE_SZ) };
    println!("Reserved pipe capacity: {actual} bytes");
    assert!(actual >= if available >= 0 { requested } else { original });
}

#[test]
fn fragmented_and_pipelined_requests_preserve_body_ownership_and_order() {
    let (_root, worker, provider) = fixture(
        r#"let seen=[]; export default {
            async writeFile(bytes, c) {
                await new Promise(resolve=>setTimeout(resolve,5));
                seen.push([c.options,bytes.length,bytes[0],bytes[bytes.length-1]]);
                return seen;
            },
            getattr(){return seen;}
        };"#,
    );
    let mut io = worker.io.lock().unwrap();
    for (index, length) in [(1, 65537), (2, 8193)] {
        let header = serde_json::to_vec(&json!({
            "op":"writeFile","id":index,"provider":provider,"context":{"options":index},
            "contentsLength":length,"previousMissing":true,"bodyLength":length
        }))
        .unwrap();
        let input = io.input.as_mut().unwrap();
        for byte in (header.len() as u32).to_le_bytes() {
            input.write_all(&[byte]).unwrap();
        }
        for part in header.chunks(17) {
            input.write_all(part).unwrap();
        }
        for part in vec![index as u8; length].chunks(4093) {
            input.write_all(part).unwrap();
        }
    }
    assert_eq!(io.receive(1).unwrap().value, json!([[1, 65537, 1, 1]]));
    assert_eq!(
        io.receive(2).unwrap().value,
        json!([[1, 65537, 1, 1], [2, 8193, 2, 2]])
    );
    drop(io);
    assert_eq!(
        worker
            .request(
                json!({"op":"getattr","provider":provider,"context":{}}),
                &[]
            )
            .unwrap()
            .value,
        json!([[1, 65537, 1, 1], [2, 8193, 2, 2]])
    );
}

#[test]
fn vectored_frames_handle_short_writes_interruptions_and_zero_progress() {
    struct Writer {
        bytes: Vec<u8>,
        limit: usize,
        calls: usize,
        interrupt: bool,
    }
    impl Write for Writer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.write_vectored(&[IoSlice::new(bytes)])
        }
        fn write_vectored(&mut self, buffers: &[IoSlice<'_>]) -> std::io::Result<usize> {
            self.calls += 1;
            if std::mem::take(&mut self.interrupt) {
                return Err(std::io::ErrorKind::Interrupted.into());
            }
            let bytes: Vec<u8> = buffers
                .iter()
                .flat_map(|b| b.iter().copied())
                .take(self.limit)
                .collect();
            self.bytes.extend_from_slice(&bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    for limit in [1, 3, 4, 7, 1024] {
        for interrupt in [false, true] {
            let mut writer = Writer {
                bytes: Vec::new(),
                limit,
                calls: 0,
                interrupt,
            };
            WorkerIo::write_frame(&mut writer, b"size", b"header", b"body").unwrap();
            assert_eq!(writer.bytes, b"sizeheaderbody");
            if limit == 1024 {
                assert_eq!(writer.calls, 1 + usize::from(interrupt));
            }
        }
    }
    let mut writer = Writer {
        bytes: Vec::new(),
        limit: 0,
        calls: 0,
        interrupt: false,
    };
    assert_eq!(
        WorkerIo::write_frame(&mut writer, b"size", b"header", b"body")
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::WriteZero
    );
    WorkerIo::write_frame(&mut writer, b"", b"", b"").unwrap();
    assert_eq!(writer.calls, 1);
}

#[test]
fn vectored_worker_frames_preserve_large_binary_bodies_and_stream_alignment() {
    let (_root, worker, provider) = fixture(
        r#"let bytes; export default {writeFile(next){bytes=Buffer.from(next);},readFile(){return bytes;}};"#,
    );
    let bytes: Vec<u8> = (0..3 * 1024 * 1024)
        .map(|index| (index % 251) as u8)
        .collect();
    worker.request(json!({"op":"writeFile","provider":provider,"context":{},"contentsLength":bytes.len(),"previousMissing":true}),&bytes).unwrap();
    for _ in 0..3 {
        let response = worker
            .request(
                json!({"op":"readFile","provider":provider,"context":{}}),
                &[],
            )
            .unwrap();
        assert_eq!(response.body, bytes);
    }
}

#[test]
fn metadata_batches_split_large_responses_and_preserve_protocol_alignment() {
    let (_root, worker, provider) = fixture(
        r#"export default {getattr(c){return {kind:"file",identity:c.path,padding:"x".repeat(512*1024)};}};"#,
    );
    let results = worker.metadata_batch((0..3).map(|i| {
        json!({"op":"getattr","provider":provider,"context":{"path":i.to_string()}})
    }).collect()).unwrap();
    for (index, result) in results.iter().enumerate() {
        let value = &result.as_ref().unwrap().value;
        assert_eq!(value["identity"], index.to_string());
        assert_eq!(value["padding"].as_str().unwrap().len(), 512 * 1024);
    }
    let next = worker
        .request(
            json!({"op":"getattr","provider":provider,"context":{"path":"next"}}),
            &[],
        )
        .unwrap();
    assert_eq!(next.value["identity"], "next");
}

#[test]
fn metadata_batches_keep_large_contexts_on_the_individual_request_path() {
    let (_root, worker, provider) = fixture(
        r#"export default {getattr(c){return {kind:"file",identity:c.path,size:c.options.padding.length};}};"#,
    );
    let results = worker.metadata_batch((0..2).map(|i| {
        json!({"op":"getattr","provider":provider,"context":{"path":i.to_string(),"options":{"padding":"x".repeat(600*1024)}}})
    }).collect()).unwrap();
    for (index, result) in results.iter().enumerate() {
        let value = &result.as_ref().unwrap().value;
        assert_eq!(value["identity"], index.to_string());
        assert_eq!(value["size"], 600 * 1024);
    }
}

#[test]
fn metadata_batches_preserve_order_context_and_drain_callback_errors() {
    let (_root, worker, provider) = fixture(
        r#"
        export default {
            name:"provider",
            async getattr(c) {
                console.log(c.path);
                if(c.path==="bad")throw Object.assign(new Error("denied"),{code:"EACCES"});
                if(c.path==="unsupported")throw Object.assign(new Error("unsupported"),{code:"EOPNOTSUPP"});
                if(c.path==="missing")return;
                return {kind:"file",size:c.options.size,identity:this.name+":"+c.path,
                    mtime:new Date(1000),aborted:c.signal.aborted};
            },
        };
    "#,
    );
    let paths = ["first", "bad", "unsupported", "missing", "last"];
    let results = worker.metadata_batch(paths.iter().map(|path| {
        json!({"op":"getattr","provider":provider,"context":{"path":path,"options":{"size":17}}})
    }).collect()).unwrap();
    assert_eq!(results.len(), paths.len());
    assert_eq!(
        results[0].as_ref().unwrap().value["identity"],
        "provider:first"
    );
    assert_eq!(results[0].as_ref().unwrap().value["size"], 17);
    assert_eq!(
        results[0].as_ref().unwrap().value["mtime"],
        json!({"$date":1000})
    );
    assert_eq!(results[0].as_ref().unwrap().value["aborted"], false);
    assert_eq!(
        results[1]
            .as_ref()
            .err()
            .unwrap()
            .downcast_ref::<ProviderError>()
            .unwrap()
            .code
            .as_deref(),
        Some("EACCES")
    );
    assert_eq!(
        results[2]
            .as_ref()
            .err()
            .unwrap()
            .downcast_ref::<ProviderError>()
            .unwrap()
            .code
            .as_deref(),
        Some("EOPNOTSUPP")
    );
    assert!(results[3].as_ref().unwrap().value.is_null());
    assert_eq!(
        results[4].as_ref().unwrap().value["identity"],
        "provider:last"
    );
    let next = worker.request(json!({"op":"getattr","provider":provider,"context":{"path":"next","options":{"size":3}}}),&[]).unwrap();
    assert_eq!(next.value["identity"], "provider:next");
    assert_eq!(next.value["size"], 3);
}

#[test]
fn shared_objects_have_stable_resources_and_independent_acquisitions() {
    let (_root, worker, provider) =
        fixture("const shared = {}; export default { open() { return shared; } };");
    let first = open(&worker, &provider);
    let second = open(&worker, &provider);
    assert_ne!(first.value, second.value);
    assert_eq!(first.resource, second.resource);
    assert!(first.resource.is_some());
    discard(&worker, &first);
    let third = open(&worker, &provider);
    assert_eq!(second.resource, third.resource);
    discard(&worker, &second);
    discard(&worker, &third);
}

#[test]
fn distinct_objects_never_share_resource_tokens() {
    let (_root, worker, provider) = fixture("export default { open() { return {}; } };");
    let first = open(&worker, &provider);
    let second = open(&worker, &provider);
    assert_ne!(first.value, second.value);
    assert_ne!(first.resource, second.resource);
    discard(&worker, &first);
    discard(&worker, &second);
}

#[test]
fn primitive_tokens_are_retired_only_after_the_last_acquisition() {
    let (_root, worker, provider) = fixture("export default { open() { return 0; } };");
    let first = open(&worker, &provider);
    let second = open(&worker, &provider);
    assert_eq!(first.resource, second.resource);
    discard(&worker, &first);
    let third = open(&worker, &provider);
    assert_eq!(second.resource, third.resource);
    discard(&worker, &second);
    discard(&worker, &third);
    let fourth = open(&worker, &provider);
    assert_ne!(first.resource, fourth.resource);
    discard(&worker, &fourth);
}

#[test]
fn nan_resources_preserve_javascript_strict_equality() {
    let (_root, worker, provider) = fixture("export default { open() { return NaN; } };");
    let first = open(&worker, &provider);
    let second = open(&worker, &provider);
    assert_ne!(first.resource, second.resource);
    discard(&worker, &first);
    discard(&worker, &second);
}

#[test]
fn discarded_acquisitions_cannot_be_used_again() {
    let (_root, worker, provider) = fixture("export default { open() { return {}; } };");
    let handle = open(&worker, &provider);
    discard(&worker, &handle);
    let error = worker
        .request(json!({"op": "discard", "handle": handle.value}), &[])
        .err()
        .unwrap();
    assert_eq!(
        error
            .downcast_ref::<ProviderError>()
            .unwrap()
            .code
            .as_deref(),
        Some("EBADF")
    );
}

#[test]
fn a_mismatched_response_identity_stops_the_worker_from_being_reused() {
    let (_root, worker, provider) = fixture("export default { getattr(){ return 1; } };");
    let mut io = worker.io.lock().unwrap();
    // Answer a request the caller is no longer waiting for.
    io.send(
        7,
        json!({"op":"getattr","provider":provider,"context":{}}),
        &[],
    )
    .unwrap();
    let error = io.receive(8).map(|_| ()).unwrap_err();
    assert!(
        error.to_string().contains("does not answer the pending"),
        "{error:#}"
    );
    assert!(io.desynchronized);
    drop(io);
    let error = worker
        .request(
            json!({"op":"getattr","provider":provider,"context":{}}),
            &[],
        )
        .map(|_| ())
        .unwrap_err();
    assert!(error.to_string().contains("desynchronized"), "{error:#}");
}

#[test]
fn an_unreadable_response_header_stops_the_worker_from_being_reused() {
    let (_root, worker, provider) = fixture("export default { getattr(){ return 1; } };");
    let mut io = worker.io.lock().unwrap();
    {
        // A header the host cannot parse hides the body length, so the frame
        // boundary is lost for good.
        let input = io.input.as_mut().unwrap();
        let header = b"not json";
        input
            .write_all(&(header.len() as u32).to_le_bytes())
            .unwrap();
        input.write_all(header).unwrap();
        input.flush().unwrap();
    }
    assert!(io.receive(1).is_err());
    assert!(io.desynchronized);
    drop(io);
    assert!(
        worker
            .request(
                json!({"op":"getattr","provider":provider,"context":{}}),
                &[]
            )
            .map(|_| ())
            .unwrap_err()
            .to_string()
            .contains("desynchronized")
    );
}

#[test]
fn stdout_frames_still_pass_through_before_the_matching_response() {
    let (_root, worker, provider) =
        fixture("export default { getattr(){ console.log('from the provider'); return 2; } };");
    assert_eq!(
        worker
            .request(
                json!({"op":"getattr","provider":provider,"context":{}}),
                &[]
            )
            .unwrap()
            .value,
        json!(2)
    );
}

#[test]
fn worker_output_fixture() {
    let Ok(mode) = std::env::var("SCRIPTFS_TEST_WORKER_OUTPUT") else {
        return;
    };
    let (_root, worker, provider) = fixture(
        r#"export default { getattr(){
            process.stderr.write('x'.repeat(128 * 1024));
            console.error('worker stderr marker');
            console.log('worker stdout marker');
            throw new Error('expected provider failure');
        } };"#,
    );
    let error = worker
        .request(
            json!({"op":"getattr","provider":provider,"context":{}}),
            &[],
        )
        .err()
        .unwrap();
    assert_eq!(error.to_string(), "expected provider failure");
    assert_ne!(mode, "fail", "injected test failure");
}

#[test]
fn worker_output_is_captured_unless_the_test_fails_or_capture_is_disabled() {
    for (mode, nocapture, visible) in [
        ("pass", false, false),
        ("pass", true, true),
        ("fail", false, true),
    ] {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "worker::tests::worker_output_fixture"])
            .env("SCRIPTFS_TEST_WORKER_OUTPUT", mode);
        if nocapture {
            command.arg("--nocapture");
        }
        let output = command.output().unwrap();
        assert_eq!(output.status.success(), mode == "pass");
        let combined = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        for marker in [
            "worker stdout marker",
            "worker stderr marker",
            "Error: expected provider failure",
        ] {
            assert_eq!(
                combined.contains(marker),
                visible,
                "mode={mode}, nocapture={nocapture}, marker={marker}"
            );
        }
    }
}

#[cfg(unix)]
fn timed_fixture(contents: &str, timeout: Duration) -> (tempfile::TempDir, Worker, Value) {
    let root = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
    let module = root.path().join("module.mjs");
    std::fs::write(&module, contents).unwrap();
    let worker = Worker::start_with(Some(timeout)).unwrap();
    let provider = load(&worker, &module);
    (root, worker, provider)
}

#[test]
#[cfg(unix)]
fn waiting_forever_is_still_the_default() {
    assert!(provider_timeout().unwrap().is_none());
}

#[test]
#[cfg(unix)]
fn an_exhausted_budget_cancels_a_cooperative_provider() {
    let (_root, worker, provider) = timed_fixture(
        r#"export default { getattr(context){
            return new Promise((_, reject) => context.signal.addEventListener("abort",
                () => reject(Object.assign(new Error("cancelled"), { code: "EINTR" }))));
        } };"#,
        Duration::from_millis(250),
    );
    let started = Instant::now();
    let error = worker
        .request(
            json!({"op":"getattr","provider":provider,"context":{}}),
            &[],
        )
        .map(|_| ())
        .unwrap_err();
    assert_eq!(
        error
            .downcast_ref::<ProviderError>()
            .and_then(|e| e.code.as_deref()),
        Some("EINTR"),
        "{error:#}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "timed out late"
    );
    // The worker cooperated, so it stays usable for later calls.
    assert!(
        worker
            .request(json!({"op":"describe","provider":provider}), &[])
            .is_ok()
    );
}

#[test]
#[cfg(unix)]
fn an_uncancellable_provider_is_stopped_instead_of_blocking_forever() {
    let (_root, worker, provider) = timed_fixture(
        "export default { getattr(){ return new Promise(() => {}); } };",
        Duration::from_millis(250),
    );
    let started = Instant::now();
    let error = worker
        .request(
            json!({"op":"getattr","provider":provider,"context":{}}),
            &[],
        )
        .map(|_| ())
        .unwrap_err();
    assert!(
        error.to_string().contains("exited or broke the protocol"),
        "{error:#}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "timed out late"
    );
}

#[test]
#[cfg(unix)]
fn an_invalid_budget_is_rejected() {
    for value in ["abc", "-1", "nan"] {
        assert!(
            super::provider_timeout_value(Some(value)).is_err(),
            "{value} must be rejected"
        );
    }
    assert!(super::provider_timeout_value(Some("0")).unwrap().is_none());
    assert_eq!(
        super::provider_timeout_value(Some(" 1.5 ")).unwrap(),
        Some(Duration::from_millis(1500))
    );
}

fn lifecycle_module(root: &std::path::Path) -> std::path::PathBuf {
    let module = root.join("lifecycle.mjs");
    std::fs::write(
        &module,
        r#"
        import { appendFileSync } from "node:fs";
        const log = (line) => appendFileSync(new URL("./events", import.meta.url), line + "\n");
        export class Recorder {
            constructor(runtime) { this.runtime = runtime; log(`construct ${runtime.name}`); }
            async start(runtime) {
                await new Promise((resolve) => setTimeout(resolve, 5));
                log(`start ${runtime.name} same=${runtime === this.runtime} frozen=${Object.isFrozen(runtime) && Object.isFrozen(runtime.settings) && Object.isFrozen(runtime.settings.nested)} signal=${runtime.signal instanceof AbortSignal} limit=${runtime.settings.nested.limit}`);
            }
            stop() { log(`stop ${this.runtime.name}`); if (this.runtime.settings.failStop) throw new Error(`cannot stop ${this.runtime.name}`); }
            readFile() { return this.runtime.name; }
        }
        export const plain = { readFile() { return "plain"; } };
        export class Broken { start() { throw Object.assign(new Error("port busy"), { code: "EADDRINUSE" }); } }
        export const notAProvider = 5;
    "#,
    )
    .unwrap();
    module
}

fn spec(module: &std::path::Path, export: &str, name: &str, settings: Value) -> Value {
    json!({"entry":module,"export":export,"runtime":{"version":1,"name":name,"settings":settings}})
}

fn events(root: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(root.join("events"))
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

#[test]
fn modules_are_constructed_started_and_stopped_in_order() {
    let root = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
    let module = lifecycle_module(root.path());
    let worker = Worker::start().unwrap();
    worker
        .request(
            json!({"op":"load","modules":{
                "alpha": spec(&module, "Recorder", "alpha", json!({"nested":{"limit":3}})),
                "beta": spec(&module, "plain", "beta", json!({})),
                "gamma": spec(&module, "Recorder", "gamma", json!({"nested":{"limit":4}}))
            }}),
            &[],
        )
        .unwrap();
    for (instance, expected) in [("alpha", "alpha"), ("beta", "plain"), ("gamma", "gamma")] {
        let response = worker
            .request(
                json!({"op":"readFile","provider":{"module":instance},"context":{}}),
                &[],
            )
            .unwrap();
        assert_eq!(response.body, expected.as_bytes());
    }
    let error = worker
        .request(
            json!({"op":"readFile","provider":{"module":"missing"},"context":{}}),
            &[],
        )
        .err()
        .unwrap();
    assert!(
        error
            .to_string()
            .contains("Module \"missing\" is not loaded"),
        "{error:#}"
    );
    let error = worker
        .request(
            json!({"op":"load","modules":{"alpha": spec(&module, "plain", "alpha", json!({}))}}),
            &[],
        )
        .err()
        .unwrap();
    assert!(
        error
            .to_string()
            .contains("Module \"alpha\" is already loaded"),
        "{error:#}"
    );
    worker.request(json!({"op":"unload"}), &[]).unwrap();
    assert_eq!(
        events(root.path()),
        [
            "construct alpha",
            "start alpha same=true frozen=true signal=true limit=3",
            "construct gamma",
            "start gamma same=true frozen=true signal=true limit=4",
            "stop gamma",
            "stop alpha",
        ]
    );
    assert!(
        worker
            .request(
                json!({"op":"readFile","provider":{"module":"alpha"},"context":{}}),
                &[],
            )
            .is_err()
    );
}

#[test]
fn failed_starts_name_the_module_and_stop_the_modules_already_started() {
    let root = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
    let module = lifecycle_module(root.path());
    let worker = Worker::start().unwrap();
    let error = worker
        .request(
            json!({"op":"load","modules":{
                "alpha": spec(&module, "Recorder", "alpha", json!({"nested":{"limit":1}})),
                "broken": spec(&module, "Broken", "broken", json!({}))
            }}),
            &[],
        )
        .err()
        .unwrap();
    let message = format!("{error:#}");
    assert!(
        message.contains("Module \"broken\" failed to start: port busy"),
        "{message}"
    );
    assert_eq!(events(root.path()).last().unwrap(), "stop alpha");
    for (export, expected) in [
        ("missing", "has no export \"missing\""),
        ("notAProvider", "is neither a class nor an object"),
    ] {
        let error = worker
            .request(
                json!({"op":"load","modules":{"x": spec(&module, export, "x", json!({}))}}),
                &[],
            )
            .err()
            .unwrap();
        assert!(error.to_string().contains(expected), "{error:#}");
    }
}

#[test]
fn stop_failures_are_reported_after_every_module_stops() {
    let root = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
    let module = lifecycle_module(root.path());
    let worker = Worker::start().unwrap();
    worker
        .request(
            json!({"op":"load","modules":{
                "alpha": spec(&module, "Recorder", "alpha", json!({"nested":{"limit":1},"failStop":true})),
                "beta": spec(&module, "Recorder", "beta", json!({"nested":{"limit":2},"failStop":true}))
            }}),
            &[],
        )
        .unwrap();
    let error = worker.request(json!({"op":"unload"}), &[]).err().unwrap();
    assert_eq!(
        error.to_string(),
        "Module \"beta\" failed to stop: cannot stop beta; Module \"alpha\" failed to stop: cannot stop alpha"
    );
    let stops: Vec<_> = events(root.path())
        .into_iter()
        .filter(|line| line.starts_with("stop"))
        .collect();
    assert_eq!(stops, ["stop beta", "stop alpha"]);
}
