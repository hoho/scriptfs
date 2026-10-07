//! Outbound module tunnel.
//!
//! Modules run inside the container but often need servers that only the host
//! can reach (services bound to the host loopback, VPN-only hosts, ...). The
//! container cannot dial the host reliably on every Podman network backend, so
//! the host dials the container instead:
//!
//! 1. The container listens on [`crate::module::TUNNEL_PORT`] (published on the
//!    host loopback) and binds one loopback listener per outbound route.
//! 2. The host opens a control connection: `SCRIPTFS-TUNNEL/1 <token> control`.
//! 3. When a module connects to a route listener, the container announces
//!    `open <id> <route>` on the control connection.
//! 4. The host dials the configured target and, on success, opens a data
//!    connection `SCRIPTFS-TUNNEL/1 <token> data <id>` that is spliced to the
//!    module connection. On failure it answers `fail <id>`.
#![cfg_attr(not(any(test, target_os = "linux")), allow(dead_code))]
use std::{
    collections::{BTreeMap, HashMap},
    io::{self, Read, Write},
    net::{Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const MAGIC: &str = "SCRIPTFS-TUNNEL/1";
const MAX_LINE: usize = 256;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);
const RECONNECT_DELAY: Duration = Duration::from_millis(250);
/// How long a module connection waits for the host to pick it up.
pub const PENDING_TTL: Duration = Duration::from_secs(30);

/// Reads one `\n`-terminated line without consuming anything after it, so the
/// raw stream that follows a data header stays intact.
fn read_line(stream: &mut TcpStream) -> io::Result<Option<String>> {
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        if stream.read(&mut byte)? == 0 {
            if line.is_empty() {
                return Ok(None);
            }
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        if byte[0] == b'\n' {
            break;
        }
        if line.len() == MAX_LINE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "tunnel line too long",
            ));
        }
        line.push(byte[0]);
    }
    String::from_utf8(line)
        .map(Some)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid tunnel line"))
}

fn same_token(left: &str, right: &str) -> bool {
    left.len() == right.len()
        && left
            .bytes()
            .zip(right.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

/// Copies both directions until each side finishes, propagating half-closes.
fn splice(left: TcpStream, right: TcpStream) {
    fn pump(mut from: TcpStream, mut to: TcpStream) {
        match io::copy(&mut from, &mut to) {
            Ok(_) => {
                let _ = to.shutdown(Shutdown::Write);
            }
            Err(_) => {
                let _ = from.shutdown(Shutdown::Both);
                let _ = to.shutdown(Shutdown::Both);
            }
        }
    }
    let (Ok(left_reader), Ok(right_reader)) = (left.try_clone(), right.try_clone()) else {
        return;
    };
    let forward = thread::spawn(move || pump(left_reader, right));
    pump(right_reader, left);
    let _ = forward.join();
}

struct Pending {
    stream: TcpStream,
    route: String,
    created: Instant,
}

#[derive(Default)]
struct State {
    control: Option<(u64, TcpStream)>,
    pending: HashMap<u64, Pending>,
    next: u64,
    generation: u64,
}
impl State {
    fn announce(&mut self, id: u64) {
        let Some((_, control)) = &mut self.control else {
            return;
        };
        let Some(pending) = self.pending.get(&id) else {
            return;
        };
        if control
            .write_all(format!("open {id} {}\n", pending.route).as_bytes())
            .is_err()
        {
            if let Some((_, control)) = self.control.take() {
                let _ = control.shutdown(Shutdown::Both);
            }
        }
    }
}

struct Shared {
    token: String,
    ttl: Duration,
    stop: AtomicBool,
    state: Mutex<State>,
}

/// Container side of the tunnel.
pub struct Server {
    #[cfg_attr(not(test), allow(dead_code))]
    pub address: SocketAddr,
    shared: Arc<Shared>,
    wake: Vec<SocketAddr>,
    threads: Vec<JoinHandle<()>>,
}

fn loopback(address: SocketAddr) -> SocketAddr {
    if address.ip().is_unspecified() {
        SocketAddr::from(([127, 0, 0, 1], address.port()))
    } else {
        address
    }
}

impl Server {
    /// Binds the tunnel listener and one loopback listener per route. Returns
    /// the container port assigned to every route.
    pub fn start(
        listen: SocketAddr,
        token: String,
        routes: &[String],
        ttl: Duration,
    ) -> io::Result<(Self, BTreeMap<String, u16>)> {
        let shared = Arc::new(Shared {
            token,
            ttl,
            stop: AtomicBool::new(false),
            state: Mutex::new(State::default()),
        });
        let listener = TcpListener::bind(listen)?;
        let address = listener.local_addr()?;
        let mut ports = BTreeMap::new();
        let mut listeners = Vec::new();
        for route in routes {
            let listener = TcpListener::bind(("127.0.0.1", 0))?;
            ports.insert(route.clone(), listener.local_addr()?.port());
            listeners.push((route.clone(), listener));
        }
        let mut wake = vec![loopback(address)];
        let mut threads = Vec::new();
        {
            let shared = shared.clone();
            threads.push(thread::spawn(move || accept_tunnel(listener, shared)));
        }
        for (route, listener) in listeners {
            wake.push(listener.local_addr()?);
            let shared = shared.clone();
            threads.push(thread::spawn(move || accept_route(listener, route, shared)));
        }
        {
            let shared = shared.clone();
            threads.push(thread::spawn(move || expire(shared)));
        }
        Ok((
            Self {
                address,
                shared,
                wake,
                threads,
            },
            ports,
        ))
    }

    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        if self.shared.stop.swap(true, Ordering::SeqCst) {
            return;
        }
        for address in &self.wake {
            let _ = TcpStream::connect_timeout(address, Duration::from_secs(1));
        }
        if let Ok(mut state) = self.shared.state.lock() {
            if let Some((_, control)) = state.control.take() {
                let _ = control.shutdown(Shutdown::Both);
            }
            state.pending.clear();
        }
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn accept_route(listener: TcpListener, route: String, shared: Arc<Shared>) {
    for stream in listener.incoming() {
        if shared.stop.load(Ordering::SeqCst) {
            return;
        }
        let Ok(stream) = stream else { continue };
        let Ok(mut state) = shared.state.lock() else {
            return;
        };
        state.next += 1;
        let id = state.next;
        state.pending.insert(
            id,
            Pending {
                stream,
                route: route.clone(),
                created: Instant::now(),
            },
        );
        state.announce(id);
    }
}

fn expire(shared: Arc<Shared>) {
    while !shared.stop.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(100).min(shared.ttl));
        let Ok(mut state) = shared.state.lock() else {
            return;
        };
        let ttl = shared.ttl;
        state.pending.retain(|_, p| p.created.elapsed() < ttl);
    }
}

fn accept_tunnel(listener: TcpListener, shared: Arc<Shared>) {
    for stream in listener.incoming() {
        if shared.stop.load(Ordering::SeqCst) {
            return;
        }
        let Ok(stream) = stream else { continue };
        let shared = shared.clone();
        thread::spawn(move || {
            let _ = handle_tunnel(stream, &shared);
        });
    }
}

fn handle_tunnel(mut stream: TcpStream, shared: &Shared) -> io::Result<()> {
    stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT))?;
    let Some(line) = read_line(&mut stream)? else {
        return Ok(());
    };
    let mut parts = line.split(' ');
    let (Some(MAGIC), Some(token)) = (parts.next(), parts.next()) else {
        return Ok(());
    };
    if !same_token(token, &shared.token) {
        return Ok(());
    }
    match (parts.next(), parts.next(), parts.next()) {
        (Some("control"), None, None) => {
            stream.set_read_timeout(None)?;
            stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT))?;
            stream.set_nodelay(true)?;
            stream.write_all(b"ok\n")?;
            let generation = {
                let mut state = shared
                    .state
                    .lock()
                    .map_err(|_| io::Error::other("tunnel state poisoned"))?;
                if let Some((_, old)) = state.control.take() {
                    let _ = old.shutdown(Shutdown::Both);
                }
                state.generation += 1;
                let generation = state.generation;
                state.control = Some((generation, stream.try_clone()?));
                let mut ids: Vec<u64> = state.pending.keys().copied().collect();
                ids.sort_unstable();
                for id in ids {
                    state.announce(id);
                }
                generation
            };
            while let Ok(Some(line)) = read_line(&mut stream) {
                if let Some(id) = line
                    .strip_prefix("fail ")
                    .and_then(|id| id.parse::<u64>().ok())
                {
                    if let Ok(mut state) = shared.state.lock() {
                        if let Some(pending) = state.pending.remove(&id) {
                            let _ = pending.stream.shutdown(Shutdown::Both);
                        }
                    }
                }
            }
            if let Ok(mut state) = shared.state.lock() {
                if state
                    .control
                    .as_ref()
                    .is_some_and(|(g, _)| *g == generation)
                {
                    state.control = None;
                }
            }
        }
        (Some("data"), Some(id), None) => {
            let Ok(id) = id.parse::<u64>() else {
                return Ok(());
            };
            let pending = shared
                .state
                .lock()
                .map_err(|_| io::Error::other("tunnel state poisoned"))?
                .pending
                .remove(&id);
            if let Some(pending) = pending {
                stream.set_read_timeout(None)?;
                splice(pending.stream, stream);
            }
        }
        _ => (),
    }
    Ok(())
}

/// Host side of the tunnel: keeps a control connection to the container and
/// dials targets on behalf of module connections.
pub struct Client {
    stop: Arc<AtomicBool>,
    control: Arc<Mutex<Option<TcpStream>>>,
    thread: Option<JoinHandle<()>>,
}

impl Client {
    /// `routes` maps tunnel routes to `host:port` targets reachable from the
    /// host.
    pub fn start(address: SocketAddr, token: String, routes: BTreeMap<String, String>) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let control = Arc::new(Mutex::new(None));
        let thread = {
            let stop = stop.clone();
            let control = control.clone();
            let routes = Arc::new(routes);
            thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    if let Ok(stream) = TcpStream::connect_timeout(&address, Duration::from_secs(2))
                    {
                        let _ = serve_control(stream, address, &token, &routes, &control, &stop);
                    }
                    if let Ok(mut control) = control.lock() {
                        control.take();
                    }
                    let deadline = Instant::now() + RECONNECT_DELAY;
                    while Instant::now() < deadline && !stop.load(Ordering::SeqCst) {
                        thread::sleep(Duration::from_millis(10));
                    }
                }
            })
        };
        Self {
            stop,
            control,
            thread: Some(thread),
        }
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Ok(mut control) = self.control.lock() {
            if let Some(control) = control.take() {
                let _ = control.shutdown(Shutdown::Both);
            }
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        self.stop();
    }
}

fn serve_control(
    mut stream: TcpStream,
    address: SocketAddr,
    token: &str,
    routes: &Arc<BTreeMap<String, String>>,
    control: &Arc<Mutex<Option<TcpStream>>>,
    stop: &AtomicBool,
) -> io::Result<()> {
    {
        let mut slot = control
            .lock()
            .map_err(|_| io::Error::other("tunnel state poisoned"))?;
        if stop.load(Ordering::SeqCst) {
            return Ok(());
        }
        *slot = Some(stream.try_clone()?);
    }
    stream.set_nodelay(true)?;
    stream.write_all(format!("{MAGIC} {token} control\n").as_bytes())?;
    stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT))?;
    if read_line(&mut stream)?.as_deref() != Some("ok") {
        return Ok(());
    }
    stream.set_read_timeout(None)?;
    while let Some(line) = read_line(&mut stream)? {
        let mut parts = line.split(' ');
        let (Some("open"), Some(id), Some(route), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let Ok(id) = id.parse::<u64>() else { continue };
        let target = routes.get(route).cloned();
        let route = route.to_string();
        let token = token.to_string();
        let control = control.clone();
        thread::spawn(move || {
            let result = target
                .ok_or_else(|| io::Error::other("unknown route"))
                .and_then(|target| {
                    let upstream = dial(&target)?;
                    Ok((target, upstream))
                })
                .and_then(|(target, upstream)| {
                    let mut data = TcpStream::connect_timeout(&address, DIAL_TIMEOUT)?;
                    data.set_nodelay(true)?;
                    data.write_all(format!("{MAGIC} {token} data {id}\n").as_bytes())?;
                    Ok((target, upstream, data))
                });
            match result {
                Ok((_, upstream, data)) => splice(upstream, data),
                Err(error) => {
                    eprintln!("ScriptFS tunnel: {route} connection failed: {error}");
                    if let Ok(mut control) = control.lock() {
                        if let Some(control) = control.as_mut() {
                            let _ = control.write_all(format!("fail {id}\n").as_bytes());
                        }
                    }
                }
            }
        });
    }
    Ok(())
}

fn dial(target: &str) -> io::Result<TcpStream> {
    let (host, port) =
        crate::module::parse_target(target).map_err(|e| io::Error::other(format!("{e:#}")))?;
    let mut last = io::Error::other(format!("{target} did not resolve"));
    for address in (host.as_str(), port).to_socket_addrs()? {
        match TcpStream::connect_timeout(&address, DIAL_TIMEOUT) {
            Ok(stream) => {
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
            Err(error) => last = io::Error::new(error.kind(), format!("{target}: {error}")),
        }
    }
    Err(last)
}

#[cfg(test)]
#[path = "tunnel_tests.rs"]
mod tests;
