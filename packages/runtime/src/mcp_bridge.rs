use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex, RwLock};
use tracing::{error, info, warn};
use tracing_subscriber::filter::EnvFilter;
use tracing_subscriber::prelude::*;

const BUFFER_LIMIT: usize = 1_048_576;
const READ_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_CHECK_INTERVAL: Duration = Duration::from_secs(5);

struct ManagedProcess {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    // STDIO MCP transport is newline-delimited JSON-RPC: one request line
    // produces exactly one response line. stdout must outlive a single call
    // so later forwards keep working; taking it per request would strand
    // every subsequent call on this server.
    stdout: Mutex<BufReader<ChildStdout>>,
    server_id: String,
    restart_count: u8,
    command: String,
    args: Vec<String>,
}

struct BridgeState {
    processes: Arc<RwLock<HashMap<String, Arc<ManagedProcess>>>>,
    max_restarts: u8,
}

impl Clone for BridgeState {
    fn clone(&self) -> Self {
        Self {
            processes: self.processes.clone(),
            max_restarts: self.max_restarts,
        }
    }
}

#[derive(Deserialize)]
struct SpawnRequest {
    server_id: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct SpawnResponse {
    status: String,
    server_id: String,
}

#[derive(Serialize, Deserialize)]
struct HealthResponse {
    status: String,
    servers: Vec<String>,
    count: usize,
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let port = args
        .iter()
        .position(|a| a == "--port")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(39000);

    let log_dir = std::env::var("XIHE_LOG_DIR").unwrap_or_else(|_| "logs".to_string());
    let file_appender = tracing_appender::rolling::daily(&log_dir, "mcp-bridge.log");
    let (non_blocking_file, _guard) = tracing_appender::non_blocking(file_appender);

    let env_filter = std::env::var("XIHE_LOG_LEVEL_RUNTIME")
        .or_else(|_| std::env::var("XIHE_LOG_LEVEL"))
        .or_else(|_| std::env::var("RUST_LOG"))
        .unwrap_or_else(|_| "info".to_string());

    tracing_subscriber::registry()
        .with(EnvFilter::new(env_filter))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(|| xihe_runtime::log_redact::RedactingWriter::new(std::io::stdout()))
                .with_ansi(false),
        )
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(xihe_runtime::log_redact::RedactingMakeWriter::new(
                    non_blocking_file,
                ))
                .with_ansi(false)
                .json(),
        )
        .init();

    let state = BridgeState {
        processes: Arc::new(RwLock::new(HashMap::new())),
        max_restarts: 3,
    };

    // Health check background task
    let hc_state = state.clone();
    tokio::spawn(async move {
        health_check_loop(hc_state).await;
    });

    let router = Router::new()
        .route("/_spawn", post(spawn_handler))
        .route("/_kill/{server_id}", post(kill_handler))
        .route("/_health", get(health_handler))
        .route("/{server_id}", post(mcp_call_handler))
        .with_state(state);

    // Bridge-network clients connect through the sandbox container IP. The
    // WorkspaceManager rejects an un-published dynamic bridge port before this
    // process is started when the caller is a native Windows Runtime.
    let addr = format!("0.0.0.0:{port}");
    info!("mcp-bridge listening on {addr}");
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, router).await.unwrap();
}

async fn health_check_loop(state: BridgeState) {
    let mut interval = tokio::time::interval(HEALTH_CHECK_INTERVAL);
    loop {
        interval.tick().await;
        let server_ids: Vec<String> = {
            let procs = state.processes.read().await;
            procs.keys().cloned().collect()
        };
        for sid in &server_ids {
            let proc = {
                let procs = state.processes.read().await;
                procs.get(sid).cloned()
            };
            if let Some(proc) = proc {
                let mut child = proc.child.lock().await;
                match child.try_wait() {
                    Ok(Some(status)) => {
                        drop(child);
                        info!(
                            "server {sid} exited with {status}, attempts={}/{}",
                            proc.restart_count, state.max_restarts
                        );

                        if proc.restart_count < state.max_restarts {
                            if let Err(e) = restart_process(&state, sid, &proc).await {
                                error!("failed to restart {sid}: {e}");
                            }
                        } else {
                            warn!("server {sid} exceeded max restarts, removing");
                            let mut procs = state.processes.write().await;
                            procs.remove(sid);
                        }
                    }
                    Ok(None) => {}
                    Err(e) => {
                        error!("health check wait error for {sid}: {e}");
                    }
                }
            }
        }
    }
}

async fn restart_process(
    state: &BridgeState,
    sid: &str,
    old_proc: &ManagedProcess,
) -> Result<(), std::io::Error> {
    let mut cmd = Command::new(&old_proc.command);
    cmd.args(&old_proc.args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit());

    let mut new_child = cmd.spawn()?;
    let new_stdin = new_child
        .stdin
        .take()
        .ok_or_else(|| std::io::Error::other("failed to capture stdin"))?;
    let new_stdout = new_child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("failed to capture stdout"))?;

    let new_proc = Arc::new(ManagedProcess {
        child: Mutex::new(new_child),
        stdin: Mutex::new(new_stdin),
        stdout: Mutex::new(BufReader::new(new_stdout)),
        server_id: old_proc.server_id.clone(),
        restart_count: old_proc.restart_count + 1,
        command: old_proc.command.clone(),
        args: old_proc.args.clone(),
    });

    let mut procs = state.processes.write().await;
    procs.insert(sid.to_string(), new_proc);
    info!("restarted server {sid}");
    Ok(())
}

async fn spawn_handler(
    State(state): State<BridgeState>,
    Json(req): Json<SpawnRequest>,
) -> Result<Json<SpawnResponse>, StatusCode> {
    let mut procs = state.processes.write().await;
    if procs.contains_key(&req.server_id) {
        return Err(StatusCode::CONFLICT);
    }

    let process = Arc::new(spawn_managed_process(&req).map_err(|e| {
        error!("failed to spawn {}: {e}", req.server_id);
        StatusCode::INTERNAL_SERVER_ERROR
    })?);

    procs.insert(req.server_id.clone(), process);
    info!("spawned server {}", req.server_id);

    Ok(Json(SpawnResponse {
        status: "ok".into(),
        server_id: req.server_id,
    }))
}

async fn kill_handler(
    State(state): State<BridgeState>,
    Path(server_id): Path<String>,
) -> StatusCode {
    let mut procs = state.processes.write().await;
    if let Some(proc) = procs.remove(&server_id) {
        let mut child = proc.child.lock().await;
        let _ = child.kill().await;
        let _ = child.wait().await;
        info!("killed server {server_id}");
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    }
}

async fn health_handler(State(state): State<BridgeState>) -> Json<HealthResponse> {
    let procs = state.processes.read().await;
    let servers: Vec<String> = procs.keys().cloned().collect();
    Json(HealthResponse {
        status: "ok".into(),
        count: servers.len(),
        servers,
    })
}

async fn mcp_call_handler(
    State(state): State<BridgeState>,
    Path(server_id): Path<String>,
    body: axum::body::Bytes,
) -> Result<Response, StatusCode> {
    let proc = {
        let procs = state.processes.read().await;
        procs
            .get(&server_id)
            .cloned()
            .ok_or(StatusCode::NOT_FOUND)?
    };

    let mut stdin = proc.stdin.lock().await;

    stdin.write_all(&body).await.map_err(|e| {
        error!("write stdin failed for {server_id}: {e}");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    stdin.flush().await.map_err(|_| {
        error!("flush stdin failed for {server_id}");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    drop(stdin);

    // Read exactly one newline-delimited JSON-RPC response. Reading the
    // stream to EOF would hang until READ_TIMEOUT because STDIO servers
    // stay alive between calls.
    let mut stdout = proc.stdout.lock().await;
    let read_result = tokio::time::timeout(READ_TIMEOUT, async {
        let mut line = Vec::with_capacity(4096);
        let n = match stdout.read_until(b'\n', &mut line).await {
            Ok(n) => n,
            Err(e) => return Err(e),
        };
        Ok::<(usize, Vec<u8>), std::io::Error>((n, line))
    })
    .await;

    match read_result {
        Ok(Ok((0, _))) => {
            error!("server {server_id} closed stdout");
            Err(StatusCode::BAD_GATEWAY)
        }
        Ok(Ok((n, line))) => {
            let total = n;
            if total > BUFFER_LIMIT {
                warn!("response truncated at {BUFFER_LIMIT}B for {server_id}");
            }
            Ok((
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/json")],
                axum::body::Body::from(line),
            )
                .into_response())
        }
        Ok(Err(e)) => {
            error!("read error for {server_id}: {e}");
            Err(StatusCode::BAD_GATEWAY)
        }
        Err(_) => {
            warn!("read timeout ({READ_TIMEOUT:?}) for {server_id}");
            Err(StatusCode::GATEWAY_TIMEOUT)
        }
    }
}

fn spawn_managed_process(req: &SpawnRequest) -> std::io::Result<ManagedProcess> {
    let mut cmd = Command::new(&req.command);
    cmd.args(&req.args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit());

    let mut child = cmd.spawn()?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| std::io::Error::other("failed to capture stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("failed to capture stdout"))?;

    Ok(ManagedProcess {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        stdout: Mutex::new(BufReader::new(stdout)),
        server_id: req.server_id.clone(),
        restart_count: 0,
        command: req.command.clone(),
        args: req.args.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use tower::ServiceExt;

    fn test_state() -> BridgeState {
        BridgeState {
            processes: Arc::new(RwLock::new(HashMap::new())),
            max_restarts: 3,
        }
    }

    #[tokio::test]
    async fn test_spawn_and_health() {
        let state = test_state();
        let app = Router::new()
            .route("/_spawn", post(spawn_handler))
            .route("/_health", get(health_handler))
            .with_state(state.clone());

        let spawn_req = serde_json::json!({
            "server_id": "test-cat",
            "command": test_process_command().0,
            "args": test_process_command().1
        });

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/_spawn")
                    .header("Content-Type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::to_string(&spawn_req).unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let health_resp = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/_health")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(health_resp.status(), StatusCode::OK);

        let health_body: HealthResponse = serde_json::from_slice(
            &axum::body::to_bytes(health_resp.into_body(), 4096)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(health_body.count, 1);
        assert!(health_body.servers.contains(&"test-cat".to_string()));
    }

    #[tokio::test]
    async fn test_spawn_conflict() {
        let state = test_state();
        let app = Router::new()
            .route("/_spawn", post(spawn_handler))
            .with_state(state.clone());

        let spawn_req = serde_json::json!({
            "server_id": "dup",
            "command": test_process_command().0,
            "args": test_process_command().1
        });

        let resp1 = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/_spawn")
                    .header("Content-Type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::to_string(&spawn_req).unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp1.status(), StatusCode::OK);

        let resp2 = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/_spawn")
                    .header("Content-Type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::to_string(&spawn_req).unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp2.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn test_kill_not_found() {
        let state = test_state();
        let app = Router::new()
            .route("/_kill/{server_id}", post(kill_handler))
            .with_state(state);

        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/_kill/nonexistent")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_mcp_call_not_found() {
        let state = test_state();
        let app = Router::new()
            .route("/{server_id}", post(mcp_call_handler))
            .with_state(state);

        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/nonexistent")
                    .header("Content-Type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({"jsonrpc": "2.0", "method": "tools/list", "id": 1})
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_spawn_and_kill() {
        let state = test_state();
        let app = Router::new()
            .route("/_spawn", post(spawn_handler))
            .route("/_kill/{server_id}", post(kill_handler))
            .route("/_health", get(health_handler))
            .with_state(state.clone());

        // Spawn
        let spawn_req = serde_json::json!({
            "server_id": "to-kill",
            "command": test_process_command().0,
            "args": test_process_command().1
        });

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/_spawn")
                    .header("Content-Type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::to_string(&spawn_req).unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // Verify health shows 1 server
        let health_resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/_health")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(health_resp.status(), StatusCode::OK);

        // Kill
        let kill_resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/_kill/to-kill")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(kill_resp.status(), StatusCode::OK);

        // Verify health shows 0 servers
        let health_after = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/_health")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(health_after.status(), StatusCode::OK);
    }

    fn test_process_command() -> (&'static str, Vec<&'static str>) {
        #[cfg(windows)]
        {
            ("cmd.exe", vec!["/D", "/C", "more"])
        }
        #[cfg(not(windows))]
        {
            ("cat", vec![])
        }
    }
}
