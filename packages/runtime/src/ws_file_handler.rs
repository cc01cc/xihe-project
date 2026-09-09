use axum::body::Bytes;
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

use crate::{AppState, DeleteFileRequest, GetFileInfoRequest, ListDirectoryRequest, MkdirRequest};
use xihe_runtime::{error::RuntimeError, fs};

/// PLAN-274 Decision 11: per-workspace fail-closed gate. Mutations must not
/// proceed when the Registry/Manager cross-map diverges for this workspace.
async fn ensure_workspace_consistent(
    app: &AppState,
    ws_id: &str,
) -> Result<(), (StatusCode, Json<Value>)> {
    let issues = app.registry.check_workspace_consistency(ws_id).await;
    if issues.is_empty() {
        return Ok(());
    }
    Err(problem(
        StatusCode::CONFLICT,
        "WORKSPACE_STATE_CONFLICT",
        &format!("workspace cross-map inconsistency: {}", issues.join("; ")),
    ))
}

// ---- Request / Response types ----

#[derive(Serialize, Deserialize)]
pub struct ReadFileRestRequest {
    pub path: String,
    pub max_bytes: Option<usize>,
}

#[derive(Serialize, Deserialize)]
pub struct ReadFileResult {
    pub content: String,
    pub truncated: bool,
}

// ---- Error mapping ----

fn problem(status: StatusCode, code: &str, detail: &str) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(serde_json::json!({
            "type": format!("https://xihe.dev/problems/{}", code.to_ascii_lowercase()),
            "title": status.canonical_reason().unwrap_or("Request failed"),
            "status": status.as_u16(),
            "code": code,
            "detail": detail,
            "requestId": uuid::Uuid::new_v4().to_string(),
        })),
    )
}

pub(crate) fn map_error(e: RuntimeError) -> (StatusCode, Json<Value>) {
    let status = match &e {
        RuntimeError::PathTraversal { .. } | RuntimeError::SymlinkEscape { .. } => {
            StatusCode::FORBIDDEN
        }
        RuntimeError::FileNotFound(_) => StatusCode::NOT_FOUND,
        RuntimeError::WorkspaceNotFound(_) => StatusCode::NOT_FOUND,
        RuntimeError::ExecutionSpecNotFound(_) | RuntimeError::McpBridgeNotFound { .. } => {
            StatusCode::NOT_FOUND
        }
        RuntimeError::ExecutionSpecUnavailable { .. }
        | RuntimeError::WorkspaceMaterializationFailed { .. }
        | RuntimeError::McpBridgeUnavailable { .. }
        | RuntimeError::Docker(_) => StatusCode::SERVICE_UNAVAILABLE,
        RuntimeError::InvalidExecutionSpec { .. } => StatusCode::UNPROCESSABLE_ENTITY,
        RuntimeError::InvalidPath(_) => StatusCode::BAD_REQUEST,
        RuntimeError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    let code = match status {
        StatusCode::FORBIDDEN => "FORBIDDEN",
        StatusCode::NOT_FOUND => "FILE_NOT_FOUND",
        StatusCode::BAD_REQUEST => "INVALID_REQUEST",
        _ => "RUNTIME_ERROR",
    };
    problem(status, code, "Runtime file operation failed")
}

// ---- Handlers ----

pub async fn handle_read_file(
    State(app): State<Arc<AppState>>,
    Path(ws_id): Path<String>,
    Json(req): Json<ReadFileRestRequest>,
) -> Result<Json<ReadFileResult>, (StatusCode, Json<Value>)> {
    let ws = app
        .ensure_workspace(&ws_id)
        .await
        .map_err(map_error)?;
    let mut content = fs::read_file(&req.path, &ws.workspace_path)
        .await
        .map_err(map_error)?;
    let truncated = if let Some(max) = req.max_bytes {
        if content.len() > max {
            content.truncate(max);
            true
        } else {
            false
        }
    } else {
        false
    };
    Ok(Json(ReadFileResult { content, truncated }))
}

pub async fn handle_write_binary(
    State(app): State<Arc<AppState>>,
    Path((ws_id, raw_path)): Path<(String, String)>,
    body: Bytes,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let path = percent_encoding::percent_decode_str(&raw_path)
        .decode_utf8()
        .map_err(|_| {
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "type": "https://xihe.dev/problems/invalid-request",
                    "title": "Bad Request",
                    "status": 400,
                    "code": "INVALID_REQUEST",
                    "detail": "Invalid file path",
                    "requestId": uuid::Uuid::new_v4().to_string(),
                })),
            )
        })?;
    let ws = app
        .ensure_workspace(&ws_id)
        .await
        .map_err(map_error)?;
    ensure_workspace_consistent(&app, &ws_id).await?;
    // PLAN-274 explicit exception: binary writes stay on the host direct path
    // because the Docker-exec JSON frame only carries UTF-8 strings and would
    // corrupt arbitrary bytes. Path safety still uses the shared fs helper
    // (lexical + canonical symlink checks); consistency is fail-closed above.
    let msg = fs::write_file_binary(&path, &body, &ws.workspace_path)
        .await
        .map_err(map_error)?;
    Ok(Json(serde_json::json!({ "message": msg })))
}

pub async fn handle_list_directory(
    State(app): State<Arc<AppState>>,
    Path(ws_id): Path<String>,
    Json(req): Json<ListDirectoryRequest>,
) -> Result<Json<fs::DirectoryListing>, (StatusCode, Json<Value>)> {
    let ws = app
        .ensure_workspace(&ws_id)
        .await
        .map_err(map_error)?;
    let entries = fs::list_directory(&req.path, &ws.workspace_path).map_err(map_error)?;
    Ok(Json(fs::DirectoryListing { entries }))
}

pub async fn handle_delete_file(
    State(app): State<Arc<AppState>>,
    Path(ws_id): Path<String>,
    Json(req): Json<DeleteFileRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // PLAN-274 §3.2: mutations share the Sandbox executor with MCP tools.
    app.ensure_workspace(&ws_id).await.map_err(map_error)?;
    ensure_workspace_consistent(&app, &ws_id).await?;
    let msg = app.router.delete_file(&ws_id, &req.path).await.map_err(map_error)?;
    Ok(Json(serde_json::json!({ "message": msg })))
}

pub async fn handle_mkdir(
    State(app): State<Arc<AppState>>,
    Path(ws_id): Path<String>,
    Json(req): Json<MkdirRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // PLAN-274 §3.2: mutations share the Sandbox executor with MCP tools.
    app.ensure_workspace(&ws_id).await.map_err(map_error)?;
    ensure_workspace_consistent(&app, &ws_id).await?;
    let msg = app.router.mkdir(&ws_id, &req.path).await.map_err(map_error)?;
    Ok(Json(serde_json::json!({ "message": msg })))
}

pub async fn handle_stat(
    State(app): State<Arc<AppState>>,
    Path(ws_id): Path<String>,
    Json(req): Json<GetFileInfoRequest>,
) -> Result<Json<fs::FileInfo>, (StatusCode, Json<Value>)> {
    let ws = app
        .ensure_workspace(&ws_id)
        .await
        .map_err(map_error)?;
    let info = fs::get_file_info(&req.path, &ws.workspace_path).map_err(map_error)?;
    Ok(Json(info))
}

// ---- Tests ----

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AppState;
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;
    use tempfile::TempDir;
    use tokio::task::JoinHandle;
    use tokio::sync::Mutex;
    use xihe_runtime::hydrate::{ExecutionSpecClient, WorkspaceEnsurer};
    use xihe_runtime::gateway::WorkspaceRegistry;
    use xihe_runtime::workspace::WorkspaceManager;
    use xihe_runtime::executor::WorkspaceExecutionRouter;

    struct TestCp {
        task: JoinHandle<()>,
    }

    impl Drop for TestCp {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    /// Create a targeted-spec test server and a cached workspace instance.
    async fn setup_ws() -> (Arc<AppState>, String, TempDir, TestCp) {
        let dir = TempDir::new().unwrap();
        let ws_id = uuid::Uuid::new_v4().to_string();
        let hash = "a".repeat(64);
        let route_path = format!(
            "/internal/v1/runtime/workspaces/{ws_id}/execution-spec"
        );
        let spec_body = serde_json::json!({
            "workspaceId": ws_id,
            "generation": 1,
            "sandboxSpecHash": hash,
            "sandboxSpec": {"profile": "strict"},
            "storageBackend": "host_directory",
            "storageRef": ws_id,
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let route_body = spec_body.clone();
        let router = axum::Router::new()
            .route(
                &route_path,
                axum::routing::get(move || {
                    let body = route_body.clone();
                    async move { axum::Json(body) }
                }),
            )
            .fallback(|| async { StatusCode::NOT_FOUND });
        let task = tokio::spawn(async move {
            axum::serve(listener, router)
                .await
                .expect("targeted-spec test server should stay running");
        });

        let registry = Arc::new(WorkspaceRegistry::new());
        let workspace_path = xihe_runtime::storage::resolve_host_path(
            dir.path().to_str().unwrap(),
            &ws_id,
            &ws_id,
        )
        .await
        .unwrap();
        tokio::fs::create_dir_all(&workspace_path).await.unwrap();
        registry
            .register_with_spec(
                &ws_id,
                workspace_path.to_str().unwrap(),
                xihe_runtime::sandbox::SecurityProfile::Strict,
                1,
                &hash,
            )
            .await;
        let manager = Arc::new(Mutex::new(WorkspaceManager::new()));
        let workspace_ensurer = Arc::new(WorkspaceEnsurer::new(
            registry.clone(),
            manager.clone(),
            ExecutionSpecClient::new(&format!("http://{address}"), "test-token"),
            Some(dir.path().to_path_buf()),
        ));
        let router = Arc::new(WorkspaceExecutionRouter::new(
            workspace_ensurer.clone(),
            manager.clone(),
            registry.clone(),
        ));
        let app = Arc::new(AppState {
            registry: registry.clone(),
            manager: manager.clone(),
            device_id: "test-device".to_string(),
            ready: Arc::new(AtomicBool::new(true)),
            workspace_ensurer,
            router,
        });
        (app, ws_id, dir, TestCp { task })
    }

    #[tokio::test]
    async fn test_read_write_roundtrip() {
        let (app, ws_id, _dir, _cp) = setup_ws().await;

        // Write a file directly via the fs module to validate the workspace works
        let ws = app.registry.get(&ws_id).await.unwrap();
        fs::write_file_binary("hello.txt", b"Hello, REST!", &ws.workspace_path)
            .await
            .unwrap();

        // Now call the handler
        let state = State(app);
        let path = Path(ws_id);
        let json = Json(ReadFileRestRequest {
            path: "hello.txt".into(),
            max_bytes: None,
        });
        let result = handle_read_file(state, path, json).await.unwrap();
        assert_eq!(result.content, "Hello, REST!");
        assert!(!result.truncated);
    }

    #[tokio::test]
    async fn test_workspace_not_found() {
        let (app, _own_ws_id, _dir, _cp) = setup_ws().await;

        let state = State(app);
        let path = Path("ws-nonexistent".to_string());
        let json = Json(ReadFileRestRequest {
            path: "x.txt".into(),
            max_bytes: None,
        });
        let result = handle_read_file(state, path, json).await;
        match result {
            Err((status, _)) => assert_eq!(status, StatusCode::NOT_FOUND),
            Ok(_) => panic!("expected 404 but got OK"),
        }
    }

    #[tokio::test]
    async fn test_write_binary_handler() {
        let (app, ws_id, _dir, _cp) = setup_ws().await;

        // URL-encoded path "test/hello.txt"
        let state = State(app);
        let path = Path((ws_id, "test%2Fhello.txt".to_string()));
        let body = Bytes::from("Hello, Binary!");
        let result = handle_write_binary(state, path, body).await.unwrap();
        assert!(
            result
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap()
                .contains("Written")
        );
    }

    #[tokio::test]
    async fn test_max_bytes_truncation() {
        let (app, ws_id, _dir, _cp) = setup_ws().await;

        // Write a 100-byte file via fs
        let ws = app.registry.get(&ws_id).await.unwrap();
        let content = "A".repeat(100);
        fs::write_file_binary("large.txt", content.as_bytes(), &ws.workspace_path)
            .await
            .unwrap();

        // Read with max_bytes=10
        let state = State(app);
        let path = Path(ws_id);
        let json = Json(ReadFileRestRequest {
            path: "large.txt".into(),
            max_bytes: Some(10),
        });
        let result = handle_read_file(state, path, json).await.unwrap();
        assert_eq!(result.content.len(), 10);
        assert!(result.truncated);
    }

    #[tokio::test]
    async fn test_list_directory_handler() {
        let (app, ws_id, _dir, _cp) = setup_ws().await;

        // Write two files via fs
        let ws = app.registry.get(&ws_id).await.unwrap();
        fs::write_file_binary("a.txt", b"data", &ws.workspace_path)
            .await
            .unwrap();
        fs::write_file_binary("b.txt", b"data", &ws.workspace_path)
            .await
            .unwrap();

        // List via handler
        let state = State(app);
        let path = Path(ws_id);
        let json = Json(ListDirectoryRequest { path: ".".into() });
        let result = handle_list_directory(state, path, json).await.unwrap();
        let names: Vec<&str> = result.entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"a.txt"));
        assert!(names.contains(&"b.txt"));
    }

    // PLAN-274 §3.2: mutations share the Sandbox executor. Without a Docker
    // container these handlers fail closed (503); success is covered by
    // Docker-backed Host E2E, not by host-direct unit tests.
    #[tokio::test]
    async fn test_delete_file_handler() {
        let (app, ws_id, _dir, _cp) = setup_ws().await;

        // Write via fs so the file exists on the host.
        let ws = app.registry.get(&ws_id).await.unwrap();
        fs::write_file_binary("del.txt", b"to delete", &ws.workspace_path)
            .await
            .unwrap();

        // Delete via handler requires the Sandbox executor; without Docker it
        // must fail closed instead of falling back to host direct.
        let state = State(app);
        let path = Path(ws_id);
        let json = Json(DeleteFileRequest {
            path: "del.txt".into(),
        });
        match handle_delete_file(state, path, json).await {
            Err((status, _)) => assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE),
            Ok(_) => panic!("expected fail-closed 503 without Docker container"),
        }
    }

    #[tokio::test]
    async fn test_mkdir_handler() {
        let (app, ws_id, _dir, _cp) = setup_ws().await;

        let state = State(app);
        let path = Path(ws_id);
        let json = Json(MkdirRequest {
            path: "sub/dir".into(),
        });
        match handle_mkdir(state, path, json).await {
            Err((status, _)) => assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE),
            Ok(_) => panic!("expected fail-closed 503 without Docker container"),
        }
    }

    #[tokio::test]
    async fn test_stat_handler() {
        let (app, ws_id, _dir, _cp) = setup_ws().await;

        // Write via fs
        let ws = app.registry.get(&ws_id).await.unwrap();
        fs::write_file_binary("metrics.txt", b"metrics data", &ws.workspace_path)
            .await
            .unwrap();

        // Stat via handler
        let state = State(app);
        let path = Path(ws_id);
        let json = Json(GetFileInfoRequest {
            path: "metrics.txt".into(),
        });
        let result = handle_stat(state, path, json).await.unwrap();
        assert_eq!(result.name, "metrics.txt");
        assert!(!result.is_dir);
    }

    #[tokio::test]
    async fn test_binary_write_and_stat() {
        let (app, ws_id, _dir, _cp) = setup_ws().await;

        // Write via handler
        let state = State(app.clone());
        let path = Path((ws_id.clone(), "binary.bin".to_string()));
        let bin_data: Vec<u8> = vec![0x00, 0x01, 0x02, 0xFF, 0xFE];
        let body = Bytes::from(bin_data.clone());
        let _ = handle_write_binary(state, path, body).await.unwrap();

        // Stat via handler
        let state = State(app);
        let path = Path(ws_id);
        let json = Json(GetFileInfoRequest {
            path: "binary.bin".into(),
        });
        let result = handle_stat(state, path, json).await.unwrap();
        assert_eq!(result.size as usize, bin_data.len());
    }
}
