use super::*;
use std::net::TcpListener;

const TOKEN: &str = "0123456789abcdef0123456789abcdef";

fn echo_server() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            thread::spawn(move || {
                let mut reader = stream.try_clone().unwrap();
                let _ = io::copy(&mut reader, &mut stream);
                let _ = stream.shutdown(Shutdown::Write);
            });
        }
    });
    address
}

fn server(routes: &[&str], ttl: Duration) -> (Server, BTreeMap<String, u16>) {
    Server::start(
        "127.0.0.1:0".parse().unwrap(),
        TOKEN.into(),
        &routes.iter().map(|r| r.to_string()).collect::<Vec<_>>(),
        ttl,
    )
    .unwrap()
}

fn exchange(port: u16, message: &[u8]) -> Vec<u8> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream.write_all(message).unwrap();
    stream.shutdown(Shutdown::Write).unwrap();
    let mut output = Vec::new();
    stream.read_to_end(&mut output).unwrap();
    output
}

/// Connects, sends a message, and expects the tunnel to close the connection
/// without forwarding anything. Closing with unread input may surface as a reset.
fn rejected(port: u16, message: &[u8]) -> bool {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let _ = stream.write_all(message);
    let _ = stream.shutdown(Shutdown::Write);
    let mut output = Vec::new();
    match stream.read_to_end(&mut output) {
        Ok(_) => output.is_empty(),
        Err(error) => error.kind() == io::ErrorKind::ConnectionReset,
    }
}

#[test]
fn module_connections_reach_host_targets_with_half_close() {
    let target = echo_server();
    let (server, ports) = server(&["api.http"], PENDING_TTL);
    let _client = Client::start(
        server.address,
        TOKEN.into(),
        BTreeMap::from([("api.http".into(), target.to_string())]),
    );
    let payload = vec![7u8; 256 * 1024];
    assert_eq!(exchange(ports["api.http"], &payload), payload);
    assert_eq!(exchange(ports["api.http"], b"again"), b"again");
}

#[test]
fn connections_wait_for_the_host_to_attach() {
    let target = echo_server();
    let (server, ports) = server(&["api.http"], PENDING_TTL);
    let port = ports["api.http"];
    let early = thread::spawn(move || exchange(port, b"queued"));
    thread::sleep(Duration::from_millis(200));
    let _client = Client::start(
        server.address,
        TOKEN.into(),
        BTreeMap::from([("api.http".into(), target.to_string())]),
    );
    assert_eq!(early.join().unwrap(), b"queued");
}

#[test]
fn unreachable_targets_close_the_module_connection() {
    let closed = TcpListener::bind("127.0.0.1:0").unwrap();
    let target = closed.local_addr().unwrap();
    drop(closed);
    let (server, ports) = server(&["api.http", "api.other"], PENDING_TTL);
    let _client = Client::start(
        server.address,
        TOKEN.into(),
        BTreeMap::from([("api.http".into(), target.to_string())]),
    );
    let started = Instant::now();
    assert!(rejected(ports["api.http"], b"lost"));
    assert!(rejected(ports["api.other"], b"unknown route"));
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn unclaimed_connections_expire() {
    let (_server, ports) = server(&["api.http"], Duration::from_millis(200));
    let started = Instant::now();
    assert!(rejected(ports["api.http"], b"nobody"));
    assert!(started.elapsed() >= Duration::from_millis(150));
}

#[test]
fn invalid_tokens_and_headers_are_rejected() {
    let target = echo_server();
    let (server, ports) = server(&["api.http"], Duration::from_millis(500));
    let _intruder = Client::start(
        server.address,
        "f".repeat(32),
        BTreeMap::from([("api.http".into(), target.to_string())]),
    );
    assert!(rejected(ports["api.http"], b"secret"));

    let mut oversized = TcpStream::connect(server.address).unwrap();
    oversized
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let _ = oversized.write_all(&[b'x'; MAX_LINE + 10]);
    let mut buffer = [0u8; 8];
    assert!(matches!(oversized.read(&mut buffer), Ok(0) | Err(_)));

    let mut unknown = TcpStream::connect(server.address).unwrap();
    unknown
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    unknown
        .write_all(format!("{MAGIC} {TOKEN} data 999\n").as_bytes())
        .unwrap();
    assert!(matches!(unknown.read(&mut buffer), Ok(0) | Err(_)));
}

#[test]
fn the_client_reconnects_after_the_container_restarts_its_listener() {
    let target = echo_server();
    let (first, _) = server(&["api.http"], PENDING_TTL);
    let address = first.address;
    let _client = Client::start(
        address,
        TOKEN.into(),
        BTreeMap::from([("api.http".into(), target.to_string())]),
    );
    thread::sleep(Duration::from_millis(100));
    first.stop();
    // The freed port may briefly be unavailable while the parallel suite binds
    // other ephemeral ports, so retry like a restarted container would.
    let deadline = Instant::now() + Duration::from_secs(5);
    let (second, ports) = loop {
        match Server::start(
            address,
            TOKEN.into(),
            &["api.http".to_string()],
            PENDING_TTL,
        ) {
            Ok(server) => break server,
            Err(error) if Instant::now() < deadline => {
                eprintln!("retrying tunnel bind: {error}");
                thread::sleep(Duration::from_millis(50));
            }
            Err(error) => panic!("{error}"),
        }
    };
    assert_eq!(exchange(ports["api.http"], b"back"), b"back");
    drop(second);
}

#[test]
fn stopping_releases_threads_and_listeners() {
    let (server, ports) = server(&["api.http"], PENDING_TTL);
    let address = server.address;
    let mut client = Client::start(address, TOKEN.into(), BTreeMap::new());
    thread::sleep(Duration::from_millis(50));
    client.stop();
    server.stop();
    assert!(TcpListener::bind(address).is_ok());
    assert!(TcpListener::bind(("127.0.0.1", ports["api.http"])).is_ok());
}

#[test]
fn header_lines_are_bounded_and_utf8() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let mut writer = TcpStream::connect(address).unwrap();
    let (mut reader, _) = listener.accept().unwrap();
    writer.write_all(b"first\nsecond").unwrap();
    writer.shutdown(Shutdown::Write).unwrap();
    assert_eq!(read_line(&mut reader).unwrap().as_deref(), Some("first"));
    assert_eq!(
        read_line(&mut reader).unwrap_err().kind(),
        io::ErrorKind::UnexpectedEof
    );
    assert!(same_token(TOKEN, TOKEN));
    assert!(!same_token(TOKEN, &TOKEN[1..]));
    assert!(!same_token(TOKEN, &"0".repeat(32)));
}
