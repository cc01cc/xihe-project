use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use axum::body::Bytes;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

use xihe_runtime::{error::RuntimeError, fs, gateway::WorkspaceRegistry};
use crate::{DeleteFileRequest, GetFileInfoRequest, ListDirectoryRequest, MkdirRequest};

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

fn map_error(e: RuntimeError) -> (StatusCode, String) {
    let status = match &e {
        RuntimeError::PathTraversal { .. } | RuntimeError::SymlinkEscape { .. } => {
            StatusCode::FORBIDDEN
        }
        RuntimeError::FileNotFound(_) => StatusCode::NOT_FOUND,
        RuntimeError::WorkspaceNotFound(_) => StatusCode::NOT_FOUND,
        RuntimeError::InvalidPath(_) => StatusCode::BAD_REQUEST,
        RuntimeError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, e.to_string())
}

// ---- Handlers ----

pub async fn handle_read_file(
    State(registry): State<Arc<WorkspaceRegistry>>,
    Path(ws_id): Path<String>,
    Json(req): Json<ReadFileRestRequest>,
) -> Result<Json<ReadFileResult>, (StatusCode, String)> {
    let ws = registry
        .get(&ws_id)
        .await
        .ok_or_else(|| (StatusCode::NOT_FOUND, "workspace not found".into()))?;
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
    State(registry): State<Arc<WorkspaceRegistry>>,
    Path((ws_id, raw_path)): Path<(String, String)>,
    body: Bytes,
) -> Result<Json<Value>, (StatusCode, String)> {
    let ws = registry
        .get(&ws_id)
        .await
        .ok_or_else(|| (StatusCode::NOT_FOUND, "workspace not found".into()))?;
    let path = percent_encoding::percent_decode_str(&raw_path)
        .decode_utf8()
        .map_err(|_| (StatusCode::BAD_REQUEST, "invalid percent encoding in path".into()))?;
    let msg = fs::write_file_binary(&path, &body, &ws.workspace_path)
        .await
        .map_err(map_error)?;
    Ok(Json(serde_json::json!({ "message": msg })))
}

pub async fn handle_list_directory(
    State(registry): State<Arc<WorkspaceRegistry>>,
    Path(ws_id): Path<String>,
    Json(req): Json<ListDirectoryRequest>,
) -> Result<Json<fs::DirectoryListing>, (StatusCode, String)> {
    let ws = registry
        .get(&ws_id)
        .await
        .ok_or_else(|| (StatusCode::NOT_FOUND, "workspace not found".into()))?;
    let entries =
        fs::list_directory(&req.path, &ws.workspace_path).map_err(map_error)?;
    Ok(Json(fs::DirectoryListing { entries }))
}

pub async fn handle_delete_file(
    State(registry): State<Arc<WorkspaceRegistry>>,
    Path(ws_id): Path<String>,
    Json(req): Json<DeleteFileRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let ws = registry
        .get(&ws_id)
        .await
        .ok_or_else(|| (StatusCode::NOT_FOUND, "workspace not found".into()))?;
    let msg = fs::delete_file(&req.path, &ws.workspace_path)
        .await
        .map_err(map_error)?;
    Ok(Json(serde_json::json!({ "message": msg })))
}

pub async fn handle_mkdir(
    State(registry): State<Arc<WorkspaceRegistry>>,
    Path(ws_id): Path<String>,
    Json(req): Json<MkdirRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let ws = registry
        .get(&ws_id)
        .await
        .ok_or_else(|| (StatusCode::NOT_FOUND, "workspace not found".into()))?;
    let msg = fs::mkdir(&req.path, &ws.workspace_path)
        .await
        .map_err(map_error)?;
    Ok(Json(serde_json::json!({ "message": msg })))
}

pub async fn handle_stat(
    State(registry): State<Arc<WorkspaceRegistry>>,
    Path(ws_id): Path<String>,
    Json(req): Json<GetFileInfoRequest>,
) -> Result<Json<fs::FileInfo>, (StatusCode, String)> {
    let ws = registry
        .get(&ws_id)
        .await
        .ok_or_else(|| (StatusCode::NOT_FOUND, "workspace not found".into()))?;
    let info = fs::get_file_info(&req.path, &ws.workspace_path).map_err(map_error)?;
    Ok(Json(info))
}

// ---- Tests ----

#[cfg(test)]
mod tests {
    use super::*;
    use xihe_runtime::gateway::WorkspaceRegistry;
    use std::sync::Arc;
    use tempfile::TempDir;

    /// Helper: create a temp workspace dir, register it, return (registry, ws_id, _dir_guard)
    async fn setup_ws() -> (Arc<WorkspaceRegistry>, String, TempDir) {
        let dir = TempDir::new().unwrap();
        let ws_id = uuid::Uuid::new_v4().to_string();
        let reg = WorkspaceRegistry::new();
        reg.register(&ws_id, dir.path().to_str().unwrap()).await;
        (Arc::new(reg), ws_id, dir)
    }

    #[tokio::test]
    async fn test_read_write_roundtrip() {
        let (reg, ws_id, _dir) = setup_ws().await;

        // Write a file directly via the fs module to validate the workspace works
        let ws = reg.get(&ws_id).await.unwrap();
        fs::write_file_binary("hello.txt", b"Hello, REST!", &ws.workspace_path)
            .await
            .unwrap();

        // Now call the handler
        let state = State(reg);
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
        let (reg, _own_ws_id, _dir) = setup_ws().await;

        let state = State(reg);
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
        let (reg, ws_id, _dir) = setup_ws().await;

        // URL-encoded path "test/hello.txt"
        let state = State(reg);
        let path = Path((ws_id, "test%2Fhello.txt".to_string()));
        let body = Bytes::from("Hello, Binary!");
        let result = handle_write_binary(state, path, body).await.unwrap();
        assert!(result.get("message").and_then(|v| v.as_str()).unwrap().contains("Written"));
    }

    #[tokio::test]
    async fn test_max_bytes_truncation() {
        let (reg, ws_id, _dir) = setup_ws().await;

        // Write a 100-byte file via fs
        let ws = reg.get(&ws_id).await.unwrap();
        let content = "A".repeat(100);
        fs::write_file_binary("large.txt", content.as_bytes(), &ws.workspace_path)
            .await
            .unwrap();

        // Read with max_bytes=10
        let state = State(reg);
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
        let (reg, ws_id, _dir) = setup_ws().await;

        // Write two files via fs
        let ws = reg.get(&ws_id).await.unwrap();
        fs::write_file_binary("a.txt", b"data", &ws.workspace_path)
            .await
            .unwrap();
        fs::write_file_binary("b.txt", b"data", &ws.workspace_path)
            .await
            .unwrap();

        // List via handler
        let state = State(reg);
        let path = Path(ws_id);
        let json = Json(ListDirectoryRequest { path: ".".into() });
        let result = handle_list_directory(state, path, json).await.unwrap();
        let names: Vec<&str> = result.entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"a.txt"));
        assert!(names.contains(&"b.txt"));
    }

    #[tokio::test]
    async fn test_delete_file_handler() {
        let (reg, ws_id, _dir) = setup_ws().await;

        // Write via fs
        let ws = reg.get(&ws_id).await.unwrap();
        fs::write_file_binary("del.txt", b"to delete", &ws.workspace_path)
            .await
            .unwrap();

        // Delete via handler
        let state = State(reg);
        let path = Path(ws_id);
        let json = Json(DeleteFileRequest { path: "del.txt".into() });
        let result = handle_delete_file(state, path, json).await.unwrap();
        assert!(result.get("message").and_then(|v| v.as_str()).is_some());
    }

    #[tokio::test]
    async fn test_mkdir_handler() {
        let (reg, ws_id, _dir) = setup_ws().await;

        let state = State(reg);
        let path = Path(ws_id);
        let json = Json(MkdirRequest { path: "sub/dir".into() });
        let result = handle_mkdir(state, path, json).await.unwrap();
        assert!(result.get("message").and_then(|v| v.as_str()).is_some());
    }

    #[tokio::test]
    async fn test_stat_handler() {
        let (reg, ws_id, _dir) = setup_ws().await;

        // Write via fs
        let ws = reg.get(&ws_id).await.unwrap();
        fs::write_file_binary("metrics.txt", b"metrics data", &ws.workspace_path)
            .await
            .unwrap();

        // Stat via handler
        let state = State(reg);
        let path = Path(ws_id);
        let json = Json(GetFileInfoRequest { path: "metrics.txt".into() });
        let result = handle_stat(state, path, json).await.unwrap();
        assert_eq!(result.name, "metrics.txt");
        assert!(!result.is_dir);
    }

    #[tokio::test]
    async fn test_binary_write_and_stat() {
        let (reg, ws_id, _dir) = setup_ws().await;

        // Write via handler
        let state = State(reg.clone());
        let path = Path((ws_id.clone(), "binary.bin".to_string()));
        let bin_data: Vec<u8> = vec![0x00, 0x01, 0x02, 0xFF, 0xFE];
        let body = Bytes::from(bin_data.clone());
        let _ = handle_write_binary(state, path, body).await.unwrap();

        // Stat via handler
        let state = State(reg);
        let path = Path(ws_id);
        let json = Json(GetFileInfoRequest { path: "binary.bin".into() });
        let result = handle_stat(state, path, json).await.unwrap();
        assert_eq!(result.size as usize, bin_data.len());
    }
}
