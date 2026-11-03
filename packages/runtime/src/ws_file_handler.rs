use axum::body::{Body, to_bytes};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use percent_encoding::{AsciiSet, CONTROLS, utf8_percent_encode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;
use tracing::warn;

use crate::AppState;
use xihe_runtime::{error::RuntimeError, fs};

static EVENT_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
const PATH_SEGMENT_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'/')
    .add(b'?')
    .add(b'\\');

/// Best-effort Runtime -> CP notification. File operations stay successful
/// when the event surface is unavailable; UI will recover through snapshot
/// refresh after reconnect or a sequence gap.
///
/// PLAN-0639 M1: `root_id` is the declared root that owns this path (defaults to the
/// workspace id for the legacy single-root shape).
pub(crate) async fn report_workspace_event(
    workspace_id: &str,
    root_id: &str,
    path: &str,
    change_type: &str,
) {
    let normalized_path = path.replace('\\', "/");
    if normalized_path.starts_with('/')
        || normalized_path.contains(':')
        || normalized_path.split('/').any(|part| part == "..")
    {
        warn!(
            "workspace event skipped due to invalid relative path workspaceId={} errorCode=INVALID_WORKSPACE_PATH",
            workspace_id
        );
        return;
    }
    post_workspace_event(
        workspace_id,
        serde_json::json!({
            "kind": "file_changed",
            "path": normalized_path,
            "changeType": change_type,
            "rootId": root_id,
            "source": "runtime",
        }),
    )
    .await;
}

/// PLAN-0639 M1: report a file event with deepest-root attribution.  When the path falls
/// inside a nested declared root, the event is attributed to that deepest root and the
/// parent root's duplicate is dropped at the emission side (D39-5b).
#[allow(dead_code)] // wired in PLAN-0639 M1 checkpoint dispatch (D39-5b emission side)
pub(crate) async fn report_workspace_event_attributed(
    workspace_id: &str,
    spec_roots: &[(String, String)], // (root_id, canonical_root_path)
    path: &str,
    change_type: &str,
) {
    let canonical_path = path.replace('\\', "/");
    let mut best: Option<&(String, String)> = None;
    for root in spec_roots {
        let root_path = root.1.replace('\\', "/");
        if canonical_path.starts_with(&format!("{root_path}/")) || canonical_path == root_path {
            let best_len = best.map(|b| b.1.len()).unwrap_or(0);
            if root.1.len() > best_len {
                best = Some(root);
            }
        }
    }
    match best {
        Some((root_id, _)) => {
            report_workspace_event(workspace_id, root_id, path, change_type).await;
        }
        None => {
            warn!(
                "workspace event dropped: no matching declared root workspaceId={} path={}",
                workspace_id, path
            );
        }
    }
}

pub(crate) async fn report_workspace_snapshot_required(workspace_id: &str) {
    post_workspace_event(workspace_id, snapshot_required_payload()).await;
}

fn snapshot_required_payload() -> serde_json::Value {
    serde_json::json!({
        "kind": "snapshot_required",
        "source": "runtime",
        "reason": "overflow",
    })
}

async fn post_workspace_event(workspace_id: &str, payload: serde_json::Value) {
    let cp_url = std::env::var("XIHE_CP_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:12631".to_string())
        .trim_end_matches('/')
        .to_string();
    let token =
        std::env::var("XIHE_CP_API_TOKEN").unwrap_or_else(|_| "dev-token-not-secure".to_string());
    let client = EVENT_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .expect("workspace event client should build")
    });
    let result = client
        .post(format!(
            "{cp_url}/internal/v1/runtime/workspaces/{}/events",
            utf8_percent_encode(workspace_id, PATH_SEGMENT_ENCODE_SET)
        ))
        .bearer_auth(token)
        .json(&payload)
        .send()
        .await;
    match result {
        Ok(response) if response.status().is_success() => {}
        Ok(response) => warn!(
            "workspace event publish rejected workspaceId={} status={}",
            workspace_id,
            response.status()
        ),
        Err(error) => warn!(
            "workspace event publish failed workspaceId={} reason={}",
            workspace_id, error
        ),
    }
}

#[cfg(test)]
mod event_contract_tests {
    use super::snapshot_required_payload;

    #[test]
    fn overflow_event_uses_reason_not_snapshot_version() {
        let payload = snapshot_required_payload();
        assert_eq!(payload["kind"], "snapshot_required");
        assert_eq!(payload["reason"], "overflow");
        assert!(payload.get("snapshotVersion").is_none());
    }
}

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
    /// PLAN-0639 D39-5: declared root that owns `path`. Absent = primary root
    /// (root[0].id == workspaceId, legacy callers).
    #[serde(default, rename = "rootId")]
    pub root_id: Option<String>,
}

/// PLAN-0639 D39-5: shared REST wire shape for single-path file endpoints
/// (list / delete / mkdir / stat). `rootId` selects the declared root; absent
/// = primary root (legacy callers). These are the REST twins of the MCP tool
/// request structs in `main.rs`, extended with the optional rootId.
#[derive(Debug, Deserialize)]
pub struct RootFileRequest {
    pub path: String,
    #[serde(default, rename = "rootId")]
    pub root_id: Option<String>,
}

/// PLAN-0639 D39-5: write-binary carries `rootId` in the query string — the
/// request body is the raw file payload.
#[derive(Debug, Deserialize)]
pub struct WriteBinaryQuery {
    #[serde(default, rename = "rootId")]
    pub root_id: Option<String>,
}

/// PLAN-0639 D39-5 先定根、再解析: resolve the declared-root boundary for one
/// file request and enforce the executable-surface policy.
///
/// * No `rootId` → primary root: the boundary is the materialized workspace
///   path, no extra spec fetch, byte-identical to pre-0639 behavior.
/// * `rootId` present → declared roots are read from the ExecutionSpec and the
///   requested root selected; unknown ids fail closed (`400`, via
///   `fs::select_root_boundary`).
/// * A non-primary root currently has no execution surface — executor-side
///   per-root dispatch is a later wave — so it fails closed with `501
///   PER_ROOT_EXECUTION_UNSUPPORTED` rather than being silently served from
///   the primary root (D39-5: serving the wrong root would be a boundary lie).
async fn resolve_request_root(
    app: &AppState,
    ws_id: &str,
    root_id: Option<&str>,
) -> Result<fs::RootBoundary, (StatusCode, Json<Value>)> {
    let instance = app.registry.get(ws_id).await.ok_or_else(|| {
        problem(
            StatusCode::NOT_FOUND,
            "WORKSPACE_NOT_FOUND",
            "workspace is not materialized in this runtime",
        )
    })?;
    let roots = if root_id.is_none() {
        Vec::new()
    } else {
        app.workspace_ensurer
            .declared_roots(ws_id)
            .await
            .map_err(map_error)?
    };
    let boundary =
        fs::select_root_boundary(&instance.workspace_path, &roots, root_id).map_err(map_error)?;
    if let Some(requested) = boundary.root_id.as_deref() {
        let same_root = boundary
            .host_path
            .canonicalize()
            .ok()
            .zip(
                std::path::Path::new(&instance.workspace_path)
                    .canonicalize()
                    .ok(),
            )
            .is_some_and(|(a, b)| a == b);
        if !same_root {
            return Err(problem(
                StatusCode::NOT_IMPLEMENTED,
                "PER_ROOT_EXECUTION_UNSUPPORTED",
                &format!(
                    "declared root {requested:?} resolved, but non-primary root execution is not routed in this runtime build"
                ),
            ));
        }
    }
    Ok(boundary)
}

/// PLAN-0639 D39-5 再解析: authoritative two-stage validation of the request
/// path against its declared root boundary, before the executor dispatch.
/// `FileNotFound` is absence, not a guard failure — the executor owns
/// `found:false` / 404 semantics, so preflight lets it through unchanged.
fn preflight_read_path(
    path: &str,
    boundary: &fs::RootBoundary,
) -> Result<(), (StatusCode, Json<Value>)> {
    match fs::resolve_read_path_for_root(
        path,
        &boundary.host_path.to_string_lossy(),
        boundary.root_id.as_deref(),
    ) {
        Ok(_) | Err(RuntimeError::FileNotFound(_)) => Ok(()),
        Err(error) => Err(map_error(error)),
    }
}

/// Write-side variant of [`preflight_read_path`].
fn preflight_write_path(
    path: &str,
    boundary: &fs::RootBoundary,
) -> Result<(), (StatusCode, Json<Value>)> {
    fs::resolve_write_path_for_root(
        path,
        &boundary.host_path.to_string_lossy(),
        boundary.root_id.as_deref(),
    )
    .map(|_| ())
    .map_err(map_error)
}

#[derive(Serialize, Deserialize)]
pub struct ReadFileResult {
    /// PLAN-0427: false when the path resolves to no content (missing file or
    /// unmaterialized root) — a self-describing success, not an HTTP error.
    #[serde(default = "found_default")]
    pub found: bool,
    pub content: String,
    pub truncated: bool,
}

fn found_default() -> bool {
    // Deserialize compatibility for pre-0427 payloads: content-bearing bodies
    // are treated as found; empty bodies default via explicit set in tests.
    true
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

fn serde_map_error(e: serde_json::Error) -> (StatusCode, Json<Value>) {
    problem(
        StatusCode::BAD_GATEWAY,
        "EXECUTOR_RESPONSE_INVALID",
        &format!("executor response deserialization failed: {e}"),
    )
}

pub(crate) fn map_error(e: RuntimeError) -> (StatusCode, Json<Value>) {
    let status = match &e {
        RuntimeError::PathTraversal { .. } | RuntimeError::SymlinkEscape { .. } => {
            StatusCode::FORBIDDEN
        }
        RuntimeError::FileNotFound(_) => StatusCode::NOT_FOUND,
        RuntimeError::WorkspaceNotFound(_) => StatusCode::NOT_FOUND,
        RuntimeError::ExecutionSpecNotFound(_) | RuntimeError::McpSessionUnavailable { .. } => {
            StatusCode::NOT_FOUND
        }
        RuntimeError::ExecutionSpecUnavailable { .. }
        | RuntimeError::WorkspaceMaterializationFailed { .. }
        | RuntimeError::McpSessionFailed { .. }
        | RuntimeError::Docker(_) => StatusCode::SERVICE_UNAVAILABLE,
        RuntimeError::InvalidExecutionSpec { .. } => StatusCode::UNPROCESSABLE_ENTITY,
        RuntimeError::PayloadTooLarge { .. } => StatusCode::PAYLOAD_TOO_LARGE,
        RuntimeError::PartialRollbackFailed { .. } => StatusCode::CONFLICT,
        RuntimeError::InvalidPath(_) => StatusCode::BAD_REQUEST,
        RuntimeError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    let code = match status {
        StatusCode::FORBIDDEN => "FORBIDDEN",
        StatusCode::NOT_FOUND => "FILE_NOT_FOUND",
        StatusCode::BAD_REQUEST => "INVALID_REQUEST",
        StatusCode::PAYLOAD_TOO_LARGE => "PAYLOAD_TOO_LARGE",
        StatusCode::CONFLICT if matches!(e, RuntimeError::PartialRollbackFailed { .. }) => {
            "PARTIAL_ROLLBACK_FAILED"
        }
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
    // PLAN-0345 T2.3 (decision #12): reads go through the Sandbox executor
    // router like MCP tools, closing the read-side executor-bypass. The
    // response shape is unchanged for REST consumers.
    app.ensure_workspace(&ws_id).await.map_err(map_error)?;
    ensure_workspace_consistent(&app, &ws_id).await?;
    // PLAN-0639 D39-5: rootId (absent = primary root) selects the declared
    // root boundary; the per-root two-stage check runs here, authoritatively,
    // before the executor dispatch.
    let boundary = resolve_request_root(&app, &ws_id, req.root_id.as_deref()).await?;
    preflight_read_path(&req.path, &boundary)?;
    // PLAN-0427 T2.1: absence is a domain fact, not an error — FileNotFound
    // (ENOENT classified in fs::resolve_canonical) answers 200 {found:false}.
    // Real traversal still fails via map_error below (403), and workspace
    // absence was already intercepted by ensure_workspace (404).
    let mut content = match app.router.read_file(&ws_id, &req.path).await {
        Ok(content) => content,
        Err(RuntimeError::FileNotFound(_)) => {
            return Ok(Json(ReadFileResult {
                found: false,
                content: String::new(),
                truncated: false,
            }));
        }
        Err(e) => return Err(map_error(e)),
    };
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
    Ok(Json(ReadFileResult {
        found: true,
        content,
        truncated,
    }))
}

pub async fn handle_write_binary(
    State(app): State<Arc<AppState>>,
    Path((ws_id, raw_path)): Path<(String, String)>,
    Query(query): Query<WriteBinaryQuery>,
    body: Body,
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
    app.ensure_workspace(&ws_id).await.map_err(map_error)?;
    ensure_workspace_consistent(&app, &ws_id).await?;
    // PLAN-0639 D39-5: declared-root boundary + authoritative write preflight.
    let boundary = resolve_request_root(&app, &ws_id, query.root_id.as_deref()).await?;
    preflight_write_path(&path, &boundary)?;
    let body = to_bytes(
        body,
        xihe_runtime::executor::FILE_OPERATION_MAX_PAYLOAD_BYTES + 1,
    )
    .await
    .map_err(|_| {
        map_error(RuntimeError::PayloadTooLarge {
            actual: xihe_runtime::executor::FILE_OPERATION_MAX_PAYLOAD_BYTES + 1,
            limit: xihe_runtime::executor::FILE_OPERATION_MAX_PAYLOAD_BYTES,
        })
    })?;
    let msg = app
        .router
        .write_file_binary(&ws_id, &path, &body)
        .await
        .map_err(map_error)?;
    Ok(Json(serde_json::json!({ "message": msg })))
}

pub async fn handle_list_directory(
    State(app): State<Arc<AppState>>,
    Path(ws_id): Path<String>,
    Json(req): Json<RootFileRequest>,
) -> Result<Json<fs::DirectoryListing>, (StatusCode, Json<Value>)> {
    // PLAN-0345 T2.3: router.list_directory (executor oneshot), same shape.
    app.ensure_workspace(&ws_id).await.map_err(map_error)?;
    ensure_workspace_consistent(&app, &ws_id).await?;
    // PLAN-0639 D39-5: declared-root boundary + authoritative read preflight.
    let boundary = resolve_request_root(&app, &ws_id, req.root_id.as_deref()).await?;
    preflight_read_path(&req.path, &boundary)?;
    let val = app
        .router
        .list_directory(&ws_id, &req.path)
        .await
        .map_err(map_error)?;
    let entries: Vec<fs::FileInfo> =
        serde_json::from_value(val.get("entries").cloned().unwrap_or(val))
            .map_err(serde_map_error)?;
    Ok(Json(fs::DirectoryListing { entries }))
}

pub async fn handle_delete_file(
    State(app): State<Arc<AppState>>,
    Path(ws_id): Path<String>,
    Json(req): Json<RootFileRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // PLAN-274 §3.2: mutations share the Sandbox executor with MCP tools.
    app.ensure_workspace(&ws_id).await.map_err(map_error)?;
    ensure_workspace_consistent(&app, &ws_id).await?;
    // PLAN-0639 D39-5: declared-root boundary + authoritative read preflight.
    let boundary = resolve_request_root(&app, &ws_id, req.root_id.as_deref()).await?;
    preflight_read_path(&req.path, &boundary)?;
    let msg = app
        .router
        .delete_file(&ws_id, &req.path)
        .await
        .map_err(map_error)?;
    Ok(Json(serde_json::json!({ "message": msg })))
}

pub async fn handle_mkdir(
    State(app): State<Arc<AppState>>,
    Path(ws_id): Path<String>,
    Json(req): Json<RootFileRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // PLAN-274 §3.2: mutations share the Sandbox executor with MCP tools.
    app.ensure_workspace(&ws_id).await.map_err(map_error)?;
    ensure_workspace_consistent(&app, &ws_id).await?;
    // PLAN-0639 D39-5: declared-root boundary + authoritative write preflight.
    let boundary = resolve_request_root(&app, &ws_id, req.root_id.as_deref()).await?;
    preflight_write_path(&req.path, &boundary)?;
    let msg = app
        .router
        .mkdir(&ws_id, &req.path)
        .await
        .map_err(map_error)?;
    Ok(Json(serde_json::json!({ "message": msg })))
}

pub async fn handle_stat(
    State(app): State<Arc<AppState>>,
    Path(ws_id): Path<String>,
    Json(req): Json<RootFileRequest>,
) -> Result<Json<fs::FileInfo>, (StatusCode, Json<Value>)> {
    // PLAN-0345 T2.3: router.get_file_info (executor oneshot), same shape.
    app.ensure_workspace(&ws_id).await.map_err(map_error)?;
    ensure_workspace_consistent(&app, &ws_id).await?;
    // PLAN-0639 D39-5: declared-root boundary + authoritative read preflight.
    let boundary = resolve_request_root(&app, &ws_id, req.root_id.as_deref()).await?;
    preflight_read_path(&req.path, &boundary)?;
    let val = app
        .router
        .get_file_info(&ws_id, &req.path)
        .await
        .map_err(map_error)?;
    let info: fs::FileInfo = serde_json::from_value(val).map_err(serde_map_error)?;
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
    use tokio::sync::Mutex;
    use tokio::task::JoinHandle;
    use xihe_runtime::executor::WorkspaceExecutionRouter;
    use xihe_runtime::gateway::WorkspaceRegistry;
    use xihe_runtime::hydrate::{ExecutionSpecClient, WorkspaceEnsurer};
    use xihe_runtime::workspace::WorkspaceManager;

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
        setup_ws_with(serde_json::Value::Null, true).await
    }

    /// PLAN-0639 D39-5: light variant — the spec carries `roots` and no Sandbox
    /// container is created. Root-aware guards (400 on unknown rootId, 501 on
    /// non-primary roots) exit before the executor dispatch, so these tests
    /// need no Docker.
    async fn setup_ws_light(roots: serde_json::Value) -> (Arc<AppState>, String, TempDir, TestCp) {
        setup_ws_with(roots, false).await
    }

    async fn setup_ws_with(
        roots: serde_json::Value,
        with_container: bool,
    ) -> (Arc<AppState>, String, TempDir, TestCp) {
        let dir = TempDir::new().unwrap();
        let ws_id = uuid::Uuid::new_v4().to_string();
        let hash = "a".repeat(64);
        let route_path = format!("/internal/v1/runtime/workspaces/{ws_id}/execution-spec");
        let mut spec_body = serde_json::json!({
            "workspaceId": ws_id,
            "generation": 1,
            "sandboxSpecHash": hash,
            "sandboxSpec": {"profile": "strict"},
            "storageBackend": "host_directory",
            "storageRef": ws_id,
        });
        if !roots.is_null() {
            spec_body["roots"] = roots;
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
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
        let workspace_path =
            xihe_runtime::storage::resolve_host_path(dir.path().to_str().unwrap(), &ws_id, &ws_id)
                .await
                .unwrap();
        tokio::fs::create_dir_all(&workspace_path).await.unwrap();
        let lifecycle = Arc::new(xihe_runtime::lifecycle::Lifecycle::new(
            registry.clone(),
            Arc::new(xihe_runtime::lifecycle::WorkspaceOperationLock::new()),
        ));
        lifecycle
            .register_ready(
                &ws_id,
                workspace_path.to_str().unwrap(),
                xihe_runtime::sandbox::SecurityProfile::Strict,
                1,
                &hash,
            )
            .await
            .expect("seed workspace as ready");
        let manager = Arc::new(Mutex::new(WorkspaceManager::new()));
        let workspace_ensurer = Arc::new(WorkspaceEnsurer::new(
            lifecycle,
            manager.clone(),
            ExecutionSpecClient::new(&format!("http://{address}"), "test-token"),
            Some(dir.path().to_path_buf()),
        ));
        // PLAN-0345 T2.3: read/list/stat now go through the executor router,
        // which runs inside a real Sandbox container. Create the container bound
        // to the workspace tempdir so the exec-based handlers can serve ops
        // (V6/V7 want real-container evidence, not host-direct shortcuts).
        if with_container {
            manager
                .lock()
                .await
                .create_workspace(
                    &ws_id,
                    workspace_path.to_str().unwrap(),
                    xihe_runtime::sandbox::SecurityProfile::Strict,
                    "xihe/workspace:latest",
                )
                .await
                .expect("test sandbox container must start");
        }
        let router = Arc::new(WorkspaceExecutionRouter::new(
            workspace_ensurer.clone(),
            manager.clone(),
            registry.clone(),
            Arc::new(xihe_runtime::job_engine::JobEngine::new(
                "test-boot",
                dir.path().join("router-job-output"),
            )),
        ));
        let lifecycle = Arc::new(xihe_runtime::lifecycle::Lifecycle::new(
            registry.clone(),
            Arc::new(xihe_runtime::lifecycle::WorkspaceOperationLock::new()),
        ));
        let app = Arc::new(AppState {
            registry: registry.clone(),
            manager: manager.clone(),
            device_id: "test-device".to_string(),
            boot_id: uuid::Uuid::new_v4().to_string(),
            ready: Arc::new(AtomicBool::new(true)),
            workspace_ensurer: workspace_ensurer.clone(),
            router: router.clone(),
            mcp_sessions: Arc::new(
                xihe_runtime::mcp_session::McpSessionManager::new()
                    .expect("session manager for tests"),
            ),
            sandbox_backend: Arc::new(xihe_runtime::backend::DockerBackend::new(
                workspace_ensurer.clone(),
                manager.clone(),
                router.clone(),
            )),
            lifecycle,
            job_engine: Arc::new(xihe_runtime::job_engine::JobEngine::new(
                "test-boot",
                dir.path().join("job-output"),
            )),
            checkpoints: Arc::new(xihe_runtime::checkpoint_api::CheckpointService::new(
                dir.path(),
            )),
            imports: Arc::new(crate::import_job::ImportManager::new()),
            workspace_event_watchers: crate::workspace_events::WorkspaceEventWatchers::default(),
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
            root_id: None,
        });
        let result = handle_read_file(state, path, json).await.unwrap();
        assert!(result.found);
        assert_eq!(result.content, "Hello, REST!");
        assert!(!result.truncated);
    }

    // PLAN-0427 T2.1: absence answers 200 {found:false}; an existing but
    // empty file answers 200 {found:true, content:""} — the two must differ.
    #[tokio::test]
    async fn test_read_missing_file_returns_found_false() {
        let (app, ws_id, _dir, _cp) = setup_ws().await;

        let state = State(app);
        let path = Path(ws_id);
        let json = Json(ReadFileRestRequest {
            path: "does-not-exist.txt".into(),
            max_bytes: None,
            root_id: None,
        });
        let result = handle_read_file(state, path, json).await.unwrap();
        assert!(!result.found, "missing file must answer found:false");
        assert_eq!(result.content, "");
        assert!(!result.truncated);
    }

    #[tokio::test]
    async fn test_read_empty_file_returns_found_true() {
        let (app, ws_id, _dir, _cp) = setup_ws().await;

        let ws = app.registry.get(&ws_id).await.unwrap();
        fs::write_file_binary("empty.txt", b"", &ws.workspace_path)
            .await
            .unwrap();

        let state = State(app);
        let path = Path(ws_id);
        let json = Json(ReadFileRestRequest {
            path: "empty.txt".into(),
            max_bytes: None,
            root_id: None,
        });
        let result = handle_read_file(state, path, json).await.unwrap();
        assert!(result.found, "empty file must answer found:true");
        assert_eq!(result.content, "");
    }

    #[tokio::test]
    async fn test_workspace_not_found() {
        let (app, _own_ws_id, _dir, _cp) = setup_ws().await;

        let state = State(app);
        let path = Path("ws-nonexistent".to_string());
        let json = Json(ReadFileRestRequest {
            path: "x.txt".into(),
            max_bytes: None,
            root_id: None,
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
        let query = Query(WriteBinaryQuery { root_id: None });
        let body = Body::from("Hello, Binary!");
        let result = handle_write_binary(state, path, query, body).await.unwrap();
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
            root_id: None,
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
        let json = Json(RootFileRequest {
            path: ".".into(),
            root_id: None,
        });
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

        // Delete via handler goes through the Sandbox executor (PLAN-274); the
        // test sandbox container is running, so the delete must succeed and the
        // file be gone afterwards (no host-direct fallback exists).
        let state = State(app);
        let path = Path(ws_id);
        let json = Json(RootFileRequest {
            path: "del.txt".into(),
            root_id: None,
        });
        let _ = handle_delete_file(state, path, json)
            .await
            .expect("executor delete must succeed with the test container running");
        assert!(
            fs::read_file("del.txt", &ws.workspace_path).await.is_err(),
            "deleted file must be gone from WorkspaceStorage"
        );
    }

    #[tokio::test]
    async fn test_mkdir_handler() {
        let (app, ws_id, _dir, _cp) = setup_ws().await;
        let ws = app.registry.get(&ws_id).await.unwrap();

        let state = State(app);
        let path = Path(ws_id);
        let json = Json(RootFileRequest {
            path: "sub/dir".into(),
            root_id: None,
        });
        let _ = handle_mkdir(state, path, json)
            .await
            .expect("executor mkdir must succeed with the test container running");
        let info = fs::get_file_info("sub/dir", &ws.workspace_path).unwrap();
        assert!(
            info.is_dir,
            "created directory must exist in WorkspaceStorage"
        );
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
        let json = Json(RootFileRequest {
            path: "metrics.txt".into(),
            root_id: None,
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
        let query = Query(WriteBinaryQuery { root_id: None });
        let bin_data: Vec<u8> = vec![0x00, 0x01, 0x02, 0xFF, 0xFE];
        let body = Body::from(bin_data.clone());
        let _ = handle_write_binary(state, path, query, body).await.unwrap();

        // Stat via handler
        let state = State(app);
        let path = Path(ws_id);
        let json = Json(RootFileRequest {
            path: "binary.bin".into(),
            root_id: None,
        });
        let result = handle_stat(state, path, json).await.unwrap();
        assert_eq!(result.size as usize, bin_data.len());
    }

    // ---- PLAN-0639 D39-5: rootId on REST file endpoints ----

    /// Unknown rootId fails closed with 400 before any filesystem access —
    /// 先定根 never guesses a boundary.
    #[tokio::test]
    async fn test_read_unknown_root_id_fails_closed_400() {
        let primary = TempDir::new().unwrap();
        let (app, ws_id, _dir, _cp) = setup_ws_light(serde_json::json!([
            {"rootId": "ws-primary", "hostPath": primary.path().to_string_lossy()},
        ]))
        .await;

        let state = State(app);
        let path = Path(ws_id);
        let json = Json(ReadFileRestRequest {
            path: "x.txt".into(),
            max_bytes: None,
            root_id: Some("root-unknown".into()),
        });
        let result = handle_read_file(state, path, json).await;
        match result {
            Err((status, Json(body))) => {
                assert_eq!(status, StatusCode::BAD_REQUEST);
                assert_eq!(body["code"], "INVALID_REQUEST");
            }
            Ok(_) => panic!("unknown rootId must fail closed, not resolve"),
        }
    }

    /// A well-known non-primary root resolves its boundary but cannot execute
    /// yet (executor-side per-root dispatch is a later wave) — 501, never a
    /// silent serve from the primary root.
    #[tokio::test]
    async fn test_read_non_primary_root_fails_closed_501() {
        let primary = TempDir::new().unwrap();
        let root_b = TempDir::new().unwrap();
        let (app, ws_id, _dir, _cp) = setup_ws_light(serde_json::json!([
            {"rootId": "ws-primary", "hostPath": primary.path().to_string_lossy()},
            {"rootId": "root-b", "hostPath": root_b.path().to_string_lossy()},
        ]))
        .await;

        let state = State(app);
        let path = Path(ws_id);
        let json = Json(ReadFileRestRequest {
            path: "x.txt".into(),
            max_bytes: None,
            root_id: Some("root-b".into()),
        });
        let result = handle_read_file(state, path, json).await;
        match result {
            Err((status, Json(body))) => {
                assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
                assert_eq!(body["code"], "PER_ROOT_EXECUTION_UNSUPPORTED");
            }
            Ok(_) => panic!("non-primary root execution must fail closed in this wave"),
        }
    }
}
