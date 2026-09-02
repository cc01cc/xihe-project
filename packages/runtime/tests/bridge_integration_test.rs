use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

const BINARY: &str = "target/debug/xihe-mcp-bridge";

fn fixture_binary() -> String {
    std::env::var("CARGO_BIN_EXE_xihe-stdio-fixture").unwrap_or_else(|_| {
        let mut path = std::path::PathBuf::from("target/debug/xihe-stdio-fixture");
        if cfg!(windows) {
            path.set_extension("exe");
        }
        path.to_string_lossy().into_owned()
    })
}

fn bridge_binary() -> PathBuf {
    let path = std::env::var("CARGO_BIN_EXE_xihe-mcp-bridge")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let mut path = PathBuf::from(BINARY);
            if cfg!(windows) {
                path.set_extension("exe");
            }
            path
        });
    assert!(
        path.is_file(),
        "MCP bridge binary must exist at {}",
        path.display()
    );
    path
}

fn find_free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn start_bridge(port: u16) -> Child {
    Command::new(bridge_binary())
        .args(["--port", &port.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("failed to start xihe-mcp-bridge")
}

fn wait_for_ready(port: u16) {
    let start = std::time::Instant::now();
    loop {
        if start.elapsed() > Duration::from_secs(10) {
            panic!("bridge did not start within 10s");
        }
        if std::net::TcpStream::connect(format!("127.0.0.1:{port}")).is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn stop_bridge(mut child: Child) {
    child.kill().expect("MCP bridge process should still be running");
    child
        .wait()
        .expect("MCP bridge process should provide an exit status");
}

#[test]
fn test_health_endpoint() {
    let port = find_free_port();
    let child = start_bridge(port);
    wait_for_ready(port);

    let client = reqwest::blocking::Client::new();
    let resp = client
        .get(format!("http://127.0.0.1:{port}/_health"))
        .send()
        .unwrap();
    assert_eq!(resp.status(), 200);
    assert!(resp.text().unwrap().contains("ok"));

    stop_bridge(child);
}

#[test]
fn test_spawn_and_health() {
    let port = find_free_port();
    let child = start_bridge(port);
    wait_for_ready(port);

    let client = reqwest::blocking::Client::new();
    let base = format!("http://127.0.0.1:{port}");

    let req = serde_json::json!({
        "server_id": "test-srv",
        "command": fixture_binary(),
        "args": []
    });
    let resp = client
        .post(format!("{base}/_spawn"))
        .json(&req)
        .send()
        .unwrap();
    assert_eq!(resp.status(), 200);

    let resp = client.get(format!("{base}/_health")).send().unwrap();
    let health: serde_json::Value = resp.json().unwrap();
    assert_eq!(health["count"], 1);

    let payload = serde_json::json!({"jsonrpc": "2.0", "method": "tools/list", "id": 1});
    let resp = client
        .post(format!("{base}/test-srv"))
        .json(&payload)
        .send()
        .unwrap();
    assert_eq!(resp.status(), 200);
    let echoed = resp.text().unwrap();
    assert!(echoed.contains("\"method\":\"tools/list\""));

    stop_bridge(child);
}

#[test]
fn test_spawn_conflict() {
    let port = find_free_port();
    let child = start_bridge(port);
    wait_for_ready(port);

    let client = reqwest::blocking::Client::new();
    let base = format!("http://127.0.0.1:{port}");

    let req = serde_json::json!({
        "server_id": "dup",
        "command": fixture_binary(),
        "args": []
    });

    let resp = client
        .post(format!("{base}/_spawn"))
        .json(&req)
        .send()
        .unwrap();
    assert_eq!(resp.status(), 200);

    let resp = client
        .post(format!("{base}/_spawn"))
        .json(&req)
        .send()
        .unwrap();
    assert_eq!(resp.status(), 409);

    stop_bridge(child);
}

#[test]
fn test_kill_not_found() {
    let port = find_free_port();
    let child = start_bridge(port);
    wait_for_ready(port);

    let client = reqwest::blocking::Client::new();
    let resp = client
        .post(format!("http://127.0.0.1:{port}/_kill/nonexistent"))
        .send()
        .unwrap();
    assert_eq!(resp.status(), 404);

    stop_bridge(child);
}

#[test]
fn test_mcp_call_not_found() {
    let port = find_free_port();
    let child = start_bridge(port);
    wait_for_ready(port);

    let client = reqwest::blocking::Client::new();
    let resp = client
        .post(format!("http://127.0.0.1:{port}/nonexistent"))
        .json(&serde_json::json!({"jsonrpc": "2.0", "method": "tools/list", "id": 1}))
        .send()
        .unwrap();
    assert_eq!(resp.status(), 404);

    stop_bridge(child);
}
