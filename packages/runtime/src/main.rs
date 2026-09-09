use std::borrow::Cow;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};

use axum::Json as AxumJson;
use axum::extract::State;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, delete, get, post};
use axum::{
    Router,
    extract::Path,
    http::{HeaderMap, Request, StatusCode},
};
use rmcp::handler::server::wrapper::Json;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::ProtocolVersion;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ServerHandler, schemars, tool, tool_handler, tool_router};
use serde::{Deserialize, Deserializer, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use tokio::time::interval;
use tower::Service;
use tower_http::cors::{Any, CorsLayer};
use tracing_subscriber::EnvFilter;
use tracing_subscriber::prelude::*;

mod ws_file_handler;
use tokio::sync::Mutex;
use xihe_runtime::device;
use xihe_runtime::dotenv_loader;
use xihe_runtime::fetch;
use xihe_runtime::fetch::WebFetchResult;
use xihe_runtime::fs;
use xihe_runtime::fs::{EditFileResult, FileInfo, ReadFileRangeResult};
use xihe_runtime::gateway::{InstanceState, WorkspaceRegistry};
use xihe_runtime::heartbeat;
use xihe_runtime::hydrate::WorkspaceEnsurer;
use xihe_runtime::mcp_process;
use xihe_runtime::mcp_process::McpProcessManager;
use xihe_runtime::remote_mcp::{
    RemoteMcpConnector, RemoteMcpError, RequestStateBinding, RequestStateStore,
    validate_endpoint_dns, validate_endpoint_with_allowlist,
};
use xihe_runtime::sandbox;
use xihe_runtime::storage;
use xihe_runtime::workspace::WorkspaceManager;
use xihe_runtime::executor::WorkspaceExecutionRouter;
use xihe_runtime::error::RuntimeError;

/// Shared runtime state for Axum handlers — holds the routing registry
/// and the Docker-backed WorkspaceManager. This converges the former dual
/// path (registry vs manager) into a single handler-owned state: every
/// create/delete updates both, fail-closed on Docker errors.
#[derive(Clone)]
pub struct AppState {
    pub registry: Arc<WorkspaceRegistry>,
    pub manager: Arc<Mutex<WorkspaceManager>>,
    pub device_id: String,
    pub workspace_ensurer: Arc<WorkspaceEnsurer>,
    pub router: Arc<WorkspaceExecutionRouter>,
    /// Readiness describes the Runtime process, not any particular Workspace.
    pub ready: Arc<AtomicBool>,
}

impl AppState {
    pub async fn ensure_workspace(
        &self,
        workspace_id: &str,
    ) -> xihe_runtime::error::Result<xihe_runtime::gateway::XiheRuntimeInstance> {
        self.workspace_ensurer
            .ensure_workspace_materialized(workspace_id)
            .await
    }

    /// PLAN-242 M2: identity-only check for remote MCP calls (no container).
    pub async fn ensure_workspace_identity(
        &self,
        workspace_id: &str,
    ) -> xihe_runtime::error::Result<()> {
        self.workspace_ensurer
            .ensure_workspace_identity(workspace_id)
            .await
    }
}

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static REMOTE_REQUEST_STATES: OnceLock<RequestStateStore> = OnceLock::new();

fn http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("failed to create HTTP client")
    })
}

use xihe_runtime::sandbox::CommandResult;
use xihe_runtime::sandbox::SecurityProfile;

fn mcp_manager() -> &'static McpProcessManager {
    static MANAGER: OnceLock<McpProcessManager> = OnceLock::new();
    MANAGER.get_or_init(McpProcessManager::new)
}

tokio::task_local! {
    static CURRENT_WS_ID: String;
}

static MCP_SERVICE: OnceLock<StreamableHttpService<XiheRuntime, LocalSessionManager>> =
    OnceLock::new();

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ReadFileRequest {
    pub path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct WriteFileRequest {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListDirectoryRequest {
    pub path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GlobRequest {
    pub pattern: String,
    pub path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GrepRequest {
    pub pattern: String,
    pub path: String,
}

fn deserialize_args<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let v = serde_json::Value::deserialize(deserializer)?;
    match v {
        serde_json::Value::String(s) => {
            let t = s.trim();
            if t.is_empty() || t == "[]" || t == "None" || t == "null" {
                Ok(Vec::new())
            } else if t.starts_with('[') {
                // LLM sometimes sends array as JSON-encoded string, e.g. "[\"-c\", \"date\"]"
                let parsed: Vec<String> =
                    serde_json::from_str::<Vec<String>>(t).unwrap_or_else(|_| {
                        serde_json::from_str::<Vec<serde_json::Value>>(t)
                            .map(|arr| {
                                arr.into_iter()
                                    .map(|x| {
                                        x.as_str().map(|s| s.to_string()).unwrap_or_else(|| {
                                            x.to_string().trim_matches('"').to_string()
                                        })
                                    })
                                    .collect()
                            })
                            .unwrap_or_else(|_| vec![s.clone()])
                    });
                Ok(parsed)
            } else {
                Ok(vec![s])
            }
        }
        serde_json::Value::Array(arr) => Ok(arr
            .into_iter()
            .filter_map(|x| {
                x.as_str()
                    .map(|s| s.to_string())
                    .or_else(|| Some(x.to_string()))
            })
            .collect()),
        serde_json::Value::Null => Ok(Vec::new()),
        _ => Ok(Vec::new()),
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ExecuteCommandRequest {
    pub command: String,
    #[serde(default, deserialize_with = "deserialize_args")]
    #[schemars(default)]
    pub args: Vec<String>,
    pub timeout: Option<u64>,
    pub truncate_limit: Option<u64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ReadCommandOutputRequest {
    pub artifact_id: String,
    pub offset: Option<usize>,
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetFileInfoRequest {
    pub path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct WatchDirectoryRequest {
    pub path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct EditFileRequest {
    pub file_path: String,
    pub old_string: String,
    pub new_string: String,
    pub replace_all: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DeleteFileRequest {
    pub path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DeleteDirectoryRequest {
    pub path: String,
    pub recursive: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct MoveFileRequest {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CopyFileRequest {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct MkdirRequest {
    pub path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ExtractPdfTextRequest {
    pub path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ReadFileRangeRequest {
    pub path: String,
    pub offset: Option<usize>,
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct WebFetchRequest {
    pub url: String,
    pub format: Option<String>,
    pub timeout: Option<u64>,
}

#[derive(Clone)]
pub struct XiheRuntime {
    #[allow(dead_code)]
    workspace: String,
    ws_id: String,
    #[allow(dead_code)]
    profile: SecurityProfile,
    router: Arc<WorkspaceExecutionRouter>,
}

#[tool_router]
impl XiheRuntime {
    pub fn new(
        ws_id: &str,
        workspace_path: &str,
        profile: SecurityProfile,
        router: Arc<WorkspaceExecutionRouter>,
    ) -> Self {
        Self {
            workspace: workspace_path.to_string(),
            ws_id: ws_id.to_string(),
            profile,
            router,
        }
    }

    #[tool(description = "Read file content from the workspace")]
    async fn read_file(
        &self,
        Parameters(ReadFileRequest { path }): Parameters<ReadFileRequest>,
    ) -> Result<String, String> {
        self.router.read_file(&self.ws_id, &path).await.map_err(|e| e.to_string())
    }

    #[tool(description = "Read file with line range support, binary detection, and line numbers")]
    async fn read_file_range(
        &self,
        Parameters(ReadFileRangeRequest {
            path,
            offset,
            limit,
        }): Parameters<ReadFileRangeRequest>,
    ) -> Result<Json<ReadFileRangeResult>, String> {
        let content = self.router.read_file(&self.ws_id, &path).await.map_err(|e| e.to_string())?;
        let lines: Vec<&str> = content.lines().collect();
        let total_lines = lines.len();
        let off = offset.unwrap_or(1).max(1);
        let lim = limit.unwrap_or(total_lines);
        let start = (off - 1).min(total_lines);
        let end = (start + lim).min(total_lines);
        let ranged = lines[start..end].iter().enumerate().map(|(i, l)| format!("{} | {}", start+i+1, l)).collect::<Vec<_>>().join("\n");
        Ok(Json(ReadFileRangeResult { content: ranged, total_lines, is_binary: false }))
    }

    #[tool(description = "Write file (creates parent directories as needed)")]
    async fn write_file(
        &self,
        Parameters(WriteFileRequest { path, content }): Parameters<WriteFileRequest>,
    ) -> Result<String, String> {
        self.router.write_file(&self.ws_id, &path, &content).await.map_err(|e| e.to_string())
    }

    #[tool(description = "List directory contents with file metadata")]
    async fn list_directory(
        &self,
        Parameters(ListDirectoryRequest { path }): Parameters<ListDirectoryRequest>,
    ) -> Result<Json<fs::DirectoryListing>, String> {
        let val = self.router.list_directory(&self.ws_id, &path).await.map_err(|e| e.to_string())?;
        let entries: Vec<fs::FileInfo> = serde_json::from_value(val.get("entries").cloned().unwrap_or(val)).map_err(|e| format!("deserialize list: {e}"))?;
        Ok(Json(fs::DirectoryListing { entries }))
    }

    #[tool(description = "Match files using glob pattern")]
    async fn glob(
        &self,
        Parameters(GlobRequest { pattern, path }): Parameters<GlobRequest>,
    ) -> Result<Json<fs::GlobResults>, String> {
        let val = self.router.glob(&self.ws_id, &pattern, &path).await.map_err(|e| e.to_string())?;
        let matches: Vec<String> = serde_json::from_value(val.get("matches").cloned().unwrap_or(val)).map_err(|e| format!("deserialize glob: {e}"))?;
        Ok(Json(fs::GlobResults { matches }))
    }

    #[tool(description = "Search files using regular expression")]
    async fn grep(
        &self,
        Parameters(GrepRequest { pattern, path }): Parameters<GrepRequest>,
    ) -> Result<Json<fs::GrepResults>, String> {
        let val = self.router.grep(&self.ws_id, &pattern, &path).await.map_err(|e| e.to_string())?;
        let matches: Vec<fs::MatchResult> = serde_json::from_value(val.get("matches").cloned().unwrap_or(val)).map_err(|e| format!("deserialize grep: {e}"))?;
        Ok(Json(fs::GrepResults { matches }))
    }

    #[tool(description = "Execute a shell command inside a sandboxed Docker container")]
    async fn execute_command(
        &self,
        Parameters(ExecuteCommandRequest {
            command,
            args,
            timeout,
            truncate_limit,
        }): Parameters<ExecuteCommandRequest>,
    ) -> Result<Json<CommandResult>, String> {
        let args_vec = args;
        let val = self.router.execute_command(&self.ws_id, &command, args_vec, timeout, truncate_limit).await.map_err(|e| e.to_string())?;
        let result: CommandResult = serde_json::from_value(val).map_err(|e| e.to_string())?;
        Ok(Json(result))
    }

    #[tool(description = "Read paginated command output by artifact_id")]
    async fn read_command_output(
        &self,
        Parameters(ReadCommandOutputRequest {
            artifact_id,
            offset,
            limit,
        }): Parameters<ReadCommandOutputRequest>,
    ) -> Result<Json<Vec<String>>, String> {
        let val = self.router.read_command_output(&self.ws_id, &artifact_id, offset, limit).await.map_err(|e| e.to_string())?;
        if let Some(content) = val.get("content").and_then(|v| v.as_str()) {
            Ok(Json(content.lines().map(|s| s.to_string()).collect()))
        } else if let Some(arr) = val.get("content").and_then(|v| v.as_array()) {
            Ok(Json(arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()))
        } else {
            Ok(Json(vec![]))
        }
    }

    #[tool(description = "Get file or directory metadata")]
    async fn get_file_info(
        &self,
        Parameters(GetFileInfoRequest { path }): Parameters<GetFileInfoRequest>,
    ) -> Result<Json<FileInfo>, String> {
        let val = self.router.get_file_info(&self.ws_id, &path).await.map_err(|e| e.to_string())?;
        let info: FileInfo = serde_json::from_value(val).map_err(|e| e.to_string())?;
        Ok(Json(info))
    }

    #[tool(description = "Watch a directory for file system events (2s poll)")]
    async fn watch_directory(
        &self,
        Parameters(WatchDirectoryRequest { path }): Parameters<WatchDirectoryRequest>,
    ) -> Result<Json<fs::FileEventList>, String> {
        let val = self.router.watch_directory(&self.ws_id, &path).await.map_err(|e| e.to_string())?;
        let events: Vec<fs::FileEvent> = serde_json::from_value(val.get("events").cloned().unwrap_or(val)).map_err(|e| e.to_string())?;
        Ok(Json(fs::FileEventList { events }))
    }

    #[tool(
        description = "Search and replace text in a file (single by default, all with replace_all=true)"
    )]
    async fn edit_file(
        &self,
        Parameters(EditFileRequest {
            file_path,
            old_string,
            new_string,
            replace_all,
        }): Parameters<EditFileRequest>,
    ) -> Result<Json<EditFileResult>, String> {
        let val = self.router.edit_file(&self.ws_id, &file_path, &old_string, &new_string, replace_all.unwrap_or(false)).await.map_err(|e| e.to_string())?;
        let result: EditFileResult = serde_json::from_value(val).map_err(|e| e.to_string())?;
        Ok(Json(result))
    }

    #[tool(description = "Delete a file")]
    async fn delete_file(
        &self,
        Parameters(DeleteFileRequest { path }): Parameters<DeleteFileRequest>,
    ) -> Result<String, String> {
        self.router.delete_file(&self.ws_id, &path).await.map_err(|e| e.to_string())
    }

    #[tool(description = "Delete a directory (requires recursive=true for non-empty dirs)")]
    async fn delete_directory(
        &self,
        Parameters(DeleteDirectoryRequest { path, recursive }): Parameters<DeleteDirectoryRequest>,
    ) -> Result<String, String> {
        self.router.delete_directory(&self.ws_id, &path, recursive.unwrap_or(false)).await.map_err(|e| e.to_string())
    }

    #[tool(description = "Move or rename a file or directory")]
    async fn move_file(
        &self,
        Parameters(MoveFileRequest { from, to }): Parameters<MoveFileRequest>,
    ) -> Result<String, String> {
        self.router.move_file(&self.ws_id, &from, &to).await.map_err(|e| e.to_string())
    }

    #[tool(description = "Copy a file")]
    async fn copy_file(
        &self,
        Parameters(CopyFileRequest { from, to }): Parameters<CopyFileRequest>,
    ) -> Result<String, String> {
        self.router.copy_file(&self.ws_id, &from, &to).await.map_err(|e| e.to_string())
    }

    #[tool(description = "Create a directory (recursive, creates parents as needed)")]
    async fn mkdir(
        &self,
        Parameters(MkdirRequest { path }): Parameters<MkdirRequest>,
    ) -> Result<String, String> {
        self.router.mkdir(&self.ws_id, &path).await.map_err(|e| e.to_string())
    }

    #[tool(description = "Extract text content from a PDF file")]
    async fn extract_pdf_text(
        &self,
        Parameters(ExtractPdfTextRequest { path }): Parameters<ExtractPdfTextRequest>,
    ) -> Result<String, String> {
        self.router.extract_pdf_text(&self.ws_id, &path).await.map_err(|e| e.to_string())
    }

    #[tool(description = "Fetch a URL and return its content as text or markdown")]
    async fn web_fetch(
        &self,
        Parameters(WebFetchRequest {
            url,
            format,
            timeout,
        }): Parameters<WebFetchRequest>,
    ) -> Result<Json<WebFetchResult>, String> {
        fetch::web_fetch(&url, format.as_deref(), timeout)
            .await
            .map(Json)
    }

    #[tool(description = "Execute a long-running command in the background and return a PID")]
    async fn start_background_process(
        &self,
        Parameters(ExecuteCommandRequest {
            command,
            args,
            timeout: _timeout,
            truncate_limit: _truncate,
        }): Parameters<ExecuteCommandRequest>,
    ) -> Result<String, String> {
        let args_vec = args;
        self.router.start_background_process(&self.ws_id, &command, args_vec).await.map_err(|e| e.to_string())
    }

    #[tool(description = "List all background processes for this workspace")]
    async fn list_background_processes(
        &self,
    ) -> Result<Json<Vec<sandbox::BackgroundProcess>>, String> {
        let val = self.router.list_background_processes(&self.ws_id).await.map_err(|e| e.to_string())?;
        let jobs: Vec<sandbox::BackgroundProcess> = serde_json::from_value(val.get("jobs").cloned().unwrap_or(val)).map_err(|e| e.to_string())?;
        Ok(Json(jobs))
    }

    #[tool(description = "Get status of a background process by PID")]
    async fn get_background_process(
        &self,
        Parameters(GetFileInfoRequest { path: pid }): Parameters<GetFileInfoRequest>,
    ) -> Result<Json<sandbox::BackgroundProcess>, String> {
        let val = self.router.get_background_process(&self.ws_id, &pid).await.map_err(|e| e.to_string())?;
        let proc: sandbox::BackgroundProcess = serde_json::from_value(val).map_err(|e| e.to_string())?;
        Ok(Json(proc))
    }

    #[tool(description = "Cancel a background process")]
    async fn cancel_background_process(
        &self,
        Parameters(GetFileInfoRequest { path: pid }): Parameters<GetFileInfoRequest>,
    ) -> Result<String, String> {
        let val = self.router.cancel_background_process(&self.ws_id, &pid).await.map_err(|e| e.to_string())?;
        Ok(val.get("status").and_then(|v| v.as_str()).unwrap_or("cancelled").to_string())
    }
}

#[tool_handler]
impl ServerHandler for XiheRuntime {
    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(&[
            ProtocolVersion::V_2026_07_28,
            ProtocolVersion::V_2025_11_25,
            ProtocolVersion::V_2025_06_18,
            ProtocolVersion::V_2025_03_26,
        ])
    }
}

fn normalize_runtime_log_level(level_name: &str) -> String {
    let normalized = level_name.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "trace" | "debug" | "info" | "warn" | "error" => normalized,
        "warning" => "warn".to_string(),
        "critical" => "error".to_string(),
        _ => "info".to_string(),
    }
}

fn resolve_runtime_log_filter_with(
    runtime_log_filter: Option<&str>,
    runtime_level: Option<&str>,
    global_level: Option<&str>,
) -> EnvFilter {
    if let Some(runtime_log_filter) = runtime_log_filter.filter(|value| !value.is_empty()) {
        return EnvFilter::try_new(runtime_log_filter)
            .unwrap_or_else(|_| EnvFilter::new("xihe_runtime=info,rmcp=info"));
    }

    let level = runtime_level
        .filter(|value| !value.is_empty())
        .or(global_level.filter(|value| !value.is_empty()))
        .map(normalize_runtime_log_level)
        .unwrap_or_else(|| "info".to_string());

    EnvFilter::new(format!("xihe_runtime={level},rmcp={level}"))
}

async fn health() -> &'static str {
    "OK"
}

/// M2-3.5: readiness probe — grill B double endpoint.
/// `/health` is always 200 (liveness), `/ready` is 200 only after `ready` flag true.
async fn ready(State(app): State<Arc<AppState>>) -> impl IntoResponse {
    if app.ready.load(Ordering::Relaxed) {
        (
            StatusCode::OK,
            AxumJson(serde_json::json!({"status":"ready","deviceId": app.device_id})),
        )
            .into_response()
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            AxumJson(serde_json::json!({"status":"not_ready","deviceId": app.device_id})),
        )
            .into_response()
    }
}

fn runtime_error_status(error: &RuntimeError) -> StatusCode {
    match error {
        RuntimeError::ExecutionSpecNotFound(_)
        | RuntimeError::WorkspaceNotFound(_)
        | RuntimeError::SandboxNotFound(_)
        | RuntimeError::McpBridgeNotFound { .. } => StatusCode::NOT_FOUND,
        RuntimeError::ExecutionSpecUnavailable { .. }
        | RuntimeError::WorkspaceMaterializationFailed { .. }
        | RuntimeError::McpBridgeUnavailable { .. }
        | RuntimeError::Docker(_) => StatusCode::SERVICE_UNAVAILABLE,
        RuntimeError::InvalidExecutionSpec { .. } => StatusCode::UNPROCESSABLE_ENTITY,
        RuntimeError::PathTraversal { .. } | RuntimeError::SymlinkEscape { .. } => {
            StatusCode::FORBIDDEN
        }
        RuntimeError::InvalidPath(_) => StatusCode::BAD_REQUEST,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn runtime_error_code(error: &RuntimeError) -> &'static str {
    match error {
        RuntimeError::ExecutionSpecNotFound(_)
        | RuntimeError::WorkspaceNotFound(_)
        | RuntimeError::SandboxNotFound(_)
        | RuntimeError::McpBridgeNotFound { .. } => "WORKSPACE_NOT_FOUND",
        RuntimeError::ExecutionSpecUnavailable { .. } => "EXECUTION_SPEC_UNAVAILABLE",
        RuntimeError::McpBridgeUnavailable { .. } => "MCP_BRIDGE_UNAVAILABLE",
        RuntimeError::InvalidExecutionSpec { .. } => "EXECUTION_SPEC_INVALID",
        RuntimeError::WorkspaceMaterializationFailed { .. } => {
            "WORKSPACE_MATERIALIZATION_FAILED"
        }
        RuntimeError::PathTraversal { .. } | RuntimeError::SymlinkEscape { .. } => "FORBIDDEN",
        RuntimeError::InvalidPath(_) => "INVALID_REQUEST",
        _ => "RUNTIME_ERROR",
    }
}

fn runtime_problem(error: RuntimeError) -> (StatusCode, AxumJson<serde_json::Value>) {
    let status = runtime_error_status(&error);
    let code = runtime_error_code(&error);
    (
        status,
        AxumJson(serde_json::json!({
            "type": format!("https://xihe.dev/problems/{}", code.to_ascii_lowercase()),
            "title": status.canonical_reason().unwrap_or("Runtime request failed"),
            "status": status.as_u16(),
            "code": code,
            "detail": error.to_string(),
            "requestId": uuid::Uuid::new_v4().to_string(),
        })),
    )
}

fn runtime_problem_with_header(
    error: RuntimeError,
) -> (
    StatusCode,
    [(axum::http::HeaderName, &'static str); 1],
    AxumJson<serde_json::Value>,
) {
    let (status, body) = runtime_problem(error);
    (
        status,
        [(axum::http::header::CONTENT_TYPE, "application/problem+json")],
        body,
    )
}

#[derive(Debug, Deserialize)]
struct CreateWorkspaceRequest {
    #[serde(rename = "workspaceId")]
    ws_id: String,
    #[allow(dead_code)]
    #[serde(rename = "workspacePath")]
    workspace_path: String,
    #[serde(rename = "storageRef")]
    storage_ref: Option<String>,
    #[allow(dead_code)]
    profile: Option<String>,
}

#[derive(Debug, Serialize)]
struct CreateWorkspaceResponse {
    status: String,
    #[serde(rename = "workspaceId")]
    ws_id: String,
}

#[derive(Debug, Deserialize)]
struct DeleteWorkspaceRequest {
    #[serde(rename = "workspaceId")]
    ws_id: String,
}

#[derive(Debug, Serialize)]
struct DeleteWorkspaceResponse {
    status: String,
    #[serde(rename = "workspaceId")]
    ws_id: String,
}

#[derive(Debug, Deserialize)]
struct McpSpawnRequest {
    #[serde(rename = "serverId")]
    server_id: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Debug, Serialize)]
struct McpSpawnResponse {
    status: String,
    #[serde(rename = "serverId")]
    server_id: String,
    url: String,
}

#[derive(Debug, Deserialize)]
struct RemoteMcpCallRequest {
    endpoint: String,
    tool: String,
    #[serde(default)]
    arguments: serde_json::Value,
    #[serde(rename = "userId")]
    user_id: String,
    scope: String,
    #[serde(rename = "requestState")]
    request_state: Option<serde_json::Value>,
    /// PLAN-242 M2: "no-auth" skips the CP token broker (public servers such
    /// as deepwiki ignore the placeholder Bearer, verified M1.3).
    #[serde(rename = "authMode", default)]
    auth_mode: String,
    /// PLAN-242 M2: when true, return tools/list instead of tools/call.
    #[serde(rename = "listTools", default)]
    list_tools: bool,
}

fn runtime_service_token() -> String {
    std::env::var("XIHE_CP_API_TOKEN").unwrap_or_else(|_| "dev-token-not-secure".to_string())
}

fn has_runtime_service_auth(headers: &HeaderMap) -> bool {
    let expected = runtime_service_token();
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| !token.is_empty() && token == expected)
}

async fn internal_auth_middleware(request: Request<axum::body::Body>, next: Next) -> Response {
    if request.uri().path() == "/health"
        || request.uri().path() == "/ready"
        || has_runtime_service_auth(request.headers())
    {
        return next.run(request).await;
    }
    let request_id = uuid::Uuid::new_v4().to_string();
    (
        StatusCode::UNAUTHORIZED,
        [(axum::http::header::CONTENT_TYPE, "application/problem+json")],
        AxumJson(serde_json::json!({
            "type": "https://xihe.dev/problems/authorization-required",
            "title": "Authorization required",
            "status": 401,
            "code": "AUTHORIZATION_REQUIRED",
            "detail": "A service Bearer token is required",
            "requestId": request_id
        })),
    )
        .into_response()
}

async fn request_id_middleware(request: Request<axum::body::Body>, next: Next) -> Response {
    let request_id = request
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .map(|value| value.to_string())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let span = tracing::info_span!("request", request_id = %request_id);
    let mut response = tracing::Instrument::instrument(next.run(request), span).await;
    if let Ok(value) = axum::http::HeaderValue::from_str(&request_id) {
        response.headers_mut().insert("x-request-id", value);
    }
    response
}

fn remote_mcp_error_response(
    error: RemoteMcpError,
) -> (
    StatusCode,
    [(axum::http::HeaderName, &'static str); 1],
    AxumJson<serde_json::Value>,
) {
    let (status, code) = match error {
        RemoteMcpError::AuthorizationRequired => {
            (StatusCode::UNAUTHORIZED, "authorization_required")
        }
        RemoteMcpError::Cancelled => (StatusCode::from_u16(499).unwrap(), "cancelled"),
        RemoteMcpError::Timeout => (StatusCode::REQUEST_TIMEOUT, "timeout"),
        RemoteMcpError::EndpointNotAllowed(_) => {
            (StatusCode::UNPROCESSABLE_ENTITY, "endpoint_not_allowed")
        }
        RemoteMcpError::InvalidEndpoint(_) => (StatusCode::BAD_REQUEST, "invalid_endpoint"),
        RemoteMcpError::HttpStatus(_)
        | RemoteMcpError::InvalidJson(_)
        | RemoteMcpError::Request(_) => (StatusCode::BAD_GATEWAY, "remote_mcp_unavailable"),
        RemoteMcpError::JsonRpc(_) => (StatusCode::BAD_GATEWAY, "remote_mcp_error"),
        RemoteMcpError::RequestStateInvalid => {
            (StatusCode::UNPROCESSABLE_ENTITY, "request_state_invalid")
        }
    };
    (
        status,
        [(axum::http::header::CONTENT_TYPE, "application/problem+json")],
        AxumJson(serde_json::json!({
            "type": format!("https://xihe.dev/problems/{code}"),
            "title": "Remote MCP request failed",
            "status": status.as_u16(),
            "code": code.to_ascii_uppercase(),
            "detail": "Remote MCP request failed",
            "requestId": uuid::Uuid::new_v4().to_string()
        })),
    )
}

async fn remote_mcp_call_handler(
    Path((workspace_id, server_id)): Path<(String, String)>,
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumJson(request): AxumJson<RemoteMcpCallRequest>,
) -> Result<
    AxumJson<serde_json::Value>,
    (
        StatusCode,
        [(axum::http::HeaderName, &'static str); 1],
        AxumJson<serde_json::Value>,
    ),
> {
    if !has_runtime_service_auth(&headers) {
        return Err((
            StatusCode::UNAUTHORIZED,
            [(axum::http::header::CONTENT_TYPE, "application/problem+json")],
            AxumJson(
                serde_json::json!({"type":"https://xihe.dev/problems/authorization-required","title":"Authorization required","status":401,"code":"AUTHORIZATION_REQUIRED","detail":"A service Bearer token is required","requestId":uuid::Uuid::new_v4().to_string()}),
            ),
        ));
    }
    // PLAN-242 M2: identity check only — remote execution lives outside the
    // sandbox, so no container is materialized. Unknown ids fail closed.
    app.ensure_workspace_identity(&workspace_id)
        .await
        .map_err(runtime_problem_with_header)?;
    if request.user_id.trim().is_empty() || request.scope.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            [(axum::http::header::CONTENT_TYPE, "application/problem+json")],
            AxumJson(
                serde_json::json!({"type":"https://xihe.dev/problems/invalid-request","title":"Invalid request","status":400,"code":"INVALID_REQUEST","detail":"userId and scope are required","requestId":uuid::Uuid::new_v4().to_string()}),
            ),
        ));
    }
    if !request.list_tools && request.tool.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            [(axum::http::header::CONTENT_TYPE, "application/problem+json")],
            AxumJson(
                serde_json::json!({"type":"https://xihe.dev/problems/invalid-request","title":"Invalid request","status":400,"code":"INVALID_REQUEST","detail":"tool is required","requestId":uuid::Uuid::new_v4().to_string()}),
            ),
        ));
    }
    let allowed_hosts = std::env::var("XIHE_REMOTE_MCP_ALLOWED_HOSTS")
        .ok()
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|host| !host.is_empty())
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let endpoint = validate_endpoint_with_allowlist(&request.endpoint, &allowed_hosts)
        .map_err(remote_mcp_error_response)?;
    validate_endpoint_dns(&endpoint)
        .await
        .map_err(remote_mcp_error_response)?;

    let cp_url =
        std::env::var("XIHE_CP_URL").unwrap_or_else(|_| "http://localhost:12631".to_string());
    let service_token = runtime_service_token();
    let binding = RequestStateBinding {
        user_id: request.user_id.clone(),
        workspace_id: workspace_id.clone(),
        server_id: server_id.clone(),
        scope: request.scope.clone(),
    };
    // PLAN-242 M2: no-auth servers skip the CP token broker entirely; the
    // placeholder Bearer is ignored by public servers (verified M1.3).
    let no_auth = request.auth_mode.eq_ignore_ascii_case("no-auth");
    let store = REMOTE_REQUEST_STATES
        .get_or_init(RequestStateStore::default)
        .clone();
    if request.list_tools {
        let token = if no_auth {
            "no-auth".to_string()
        } else {
            fetch_remote_mcp_token(
                &cp_url,
                &service_token,
                &request.user_id,
                &workspace_id,
                &server_id,
                &request.scope,
            )
            .await
            .map_err(|error| {
                let (status, code) = match error {
                    RemoteMcpError::AuthorizationRequired => {
                        (StatusCode::UNAUTHORIZED, "authorization_required")
                    }
                    _ => (StatusCode::BAD_GATEWAY, "token_broker_unavailable"),
                };
                (status, [(axum::http::header::CONTENT_TYPE, "application/problem+json")], AxumJson(serde_json::json!({"type":format!("https://xihe.dev/problems/{code}"),"title":"Token broker failed","status":status.as_u16(),"code":code.to_ascii_uppercase(),"detail":"Token broker request failed","requestId":uuid::Uuid::new_v4().to_string()})))
            })?
        };
        let connector = RemoteMcpConnector::new_with_context(
            &request.endpoint,
            token,
            Duration::from_secs(30),
            binding,
            store,
        )
        .map_err(remote_mcp_error_response)?;
        let cancellation = tokio_util::sync::CancellationToken::new();
        connector
            .initialize(&cancellation)
            .await
            .map_err(remote_mcp_error_response)?;
        return connector
            .tools_list(&cancellation)
            .await
            .map(AxumJson)
            .map_err(remote_mcp_error_response);
    }
    let token = if no_auth {
        "no-auth".to_string()
    } else {
        fetch_remote_mcp_token(
            &cp_url,
            &service_token,
            &request.user_id,
            &workspace_id,
            &server_id,
            &request.scope,
        )
        .await
        .map_err(|error| {
            let (status, code) = match error {
                RemoteMcpError::AuthorizationRequired => {
                    (StatusCode::UNAUTHORIZED, "authorization_required")
                }
                _ => (StatusCode::BAD_GATEWAY, "token_broker_unavailable"),
            };
            (status, [(axum::http::header::CONTENT_TYPE, "application/problem+json")], AxumJson(serde_json::json!({"type":format!("https://xihe.dev/problems/{code}"),"title":"Token broker failed","status":status.as_u16(),"code":code.to_ascii_uppercase(),"detail":"Token broker request failed","requestId":uuid::Uuid::new_v4().to_string()})))
        })?
    };
    let result = run_remote_mcp_call(
        &request.endpoint,
        token,
        binding.clone(),
        store.clone(),
        &request.tool,
        request.arguments.clone(),
        request.request_state.clone(),
    )
    .await;
    let result = match result {
        // No-auth servers never enter the broker refresh loop (single attempt).
        Err(RemoteMcpError::AuthorizationRequired) if !no_auth => {
            let refreshed = fetch_remote_mcp_token(
                &cp_url,
                &service_token,
                &request.user_id,
                &workspace_id,
                &server_id,
                &request.scope,
            )
            .await
            .map_err(remote_mcp_error_response)?;
            run_remote_mcp_call(
                &request.endpoint,
                refreshed,
                binding,
                store,
                &request.tool,
                request.arguments,
                request.request_state,
            )
            .await
        }
        other => other,
    };
    result.map(AxumJson).map_err(remote_mcp_error_response)
}

async fn run_remote_mcp_call(
    endpoint: &str,
    token: String,
    binding: RequestStateBinding,
    request_states: RequestStateStore,
    tool: &str,
    arguments: serde_json::Value,
    request_state: Option<serde_json::Value>,
) -> Result<serde_json::Value, RemoteMcpError> {
    let connector = RemoteMcpConnector::new_with_context(
        endpoint,
        token,
        Duration::from_secs(30),
        binding,
        request_states,
    )?;
    let cancellation = tokio_util::sync::CancellationToken::new();
    connector.initialize(&cancellation).await?;
    connector.tools_list(&cancellation).await?;
    connector
        .tools_call_with_state(tool, arguments, request_state, &cancellation)
        .await
}

async fn fetch_remote_mcp_token(
    cp_url: &str,
    service_token: &str,
    user_id: &str,
    workspace_id: &str,
    server_id: &str,
    scope: &str,
) -> Result<String, RemoteMcpError> {
    let response = http_client()
        .post(format!(
            "{}/internal/v1/oauth/token",
            cp_url.trim_end_matches('/')
        ))
        .bearer_auth(service_token)
        .json(&serde_json::json!({
            "userId": user_id,
            "workspaceId": workspace_id,
            "serverId": server_id,
            "scope": scope,
        }))
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                RemoteMcpError::Timeout
            } else {
                RemoteMcpError::Request(error)
            }
        })?;
    if response.status() == StatusCode::UNAUTHORIZED || response.status() == StatusCode::FORBIDDEN {
        return Err(RemoteMcpError::AuthorizationRequired);
    }
    if !response.status().is_success() {
        return Err(RemoteMcpError::HttpStatus(response.status()));
    }
    let body = response
        .json::<serde_json::Value>()
        .await
        .map_err(RemoteMcpError::InvalidJson)?;
    body.get("access_token")
        .and_then(serde_json::Value::as_str)
        .filter(|token| !token.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| RemoteMcpError::JsonRpc("token broker response has no access token".into()))
}

static NEXT_BRIDGE_PORT: AtomicU16 = AtomicU16::new(39000);

fn allocate_bridge_port() -> u16 {
    // Grill Q10 C: dynamic probing — ask OS for a free port, fallback to atomic increment
    if let Ok(listener) = std::net::TcpListener::bind("127.0.0.1:0")
        && let Ok(addr) = listener.local_addr()
    {
        let port = addr.port();
        // Keep atomic in sync to avoid reuse on fallback path
        NEXT_BRIDGE_PORT.store(port.wrapping_add(1), Ordering::Relaxed);
        return port;
    }
    let port = NEXT_BRIDGE_PORT.fetch_add(1, Ordering::Relaxed);
    if port >= 40000 {
        NEXT_BRIDGE_PORT.store(39000, Ordering::Relaxed);
        39000
    } else {
        port
    }
}

async fn spawn_bridge_server(
    workspace_id: &str,
    base_url: &str,
    server_id: &str,
    command: &str,
    args: &[String],
) -> Result<(), RuntimeError> {
    let url = mcp_process::bridge_spawn_url(base_url);
    let mut last_error = None;
    for attempt in 0..10 {
        match http_client()
            .post(&url)
            .json(&serde_json::json!({
                "server_id": server_id,
                "command": command,
                "args": args,
            }))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(response) => {
                let status = response.status();
                let detail = match response.text().await {
                    Ok(body) if !body.is_empty() => {
                        format!("bridge returned {status}: {body}")
                    }
                    Ok(_) => format!("bridge returned {status}"),
                    Err(error) => format!("bridge returned {status}; body read failed: {error}"),
                };
                return Err(RuntimeError::McpBridgeUnavailable {
                    workspace_id: workspace_id.to_string(),
                    server_id: server_id.to_string(),
                    detail,
                });
            }
            Err(error) => {
                last_error = Some(error.to_string());
                if attempt < 9 {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    }

    Err(RuntimeError::McpBridgeUnavailable {
        workspace_id: workspace_id.to_string(),
        server_id: server_id.to_string(),
        detail: format!(
            "bridge spawn endpoint {} was unreachable: {}",
            url,
            last_error.unwrap_or_else(|| "unknown connection error".to_string())
        ),
    })
}

async fn mcp_spawn_handler(
    Path(ws_id): Path<String>,
    State(app): State<Arc<AppState>>,
    AxumJson(req): AxumJson<McpSpawnRequest>,
) -> Result<AxumJson<McpSpawnResponse>, (StatusCode, AxumJson<serde_json::Value>)> {
    app.ensure_workspace(&ws_id)
        .await
        .map_err(runtime_problem)?;

    let port = allocate_bridge_port();
    let (bridge_host, bridge_port) = {
        let manager = app.manager.lock().await;
        manager
            .start_mcp_bridge(&ws_id, &req.server_id, &req.command, &req.args, port)
            .await
            .map_err(runtime_problem)?
    };
    let bridge_base_url = mcp_process::bridge_base_url(&bridge_host, bridge_port);
    if let Err(error) =
        spawn_bridge_server(&ws_id, &bridge_base_url, &req.server_id, &req.command, &req.args)
            .await
    {
        let cleanup_result = {
            let manager = app.manager.lock().await;
            manager.stop_mcp_bridge(&ws_id, &req.server_id).await
        };
        if let Err(cleanup_error) = cleanup_result {
            tracing::warn!(
                "MCP bridge cleanup failed after spawn error: ws={} server={} error={}",
                ws_id,
                req.server_id,
                cleanup_error
            );
        }
        return Err(runtime_problem(error));
    }

    let manager = mcp_manager();
    manager
        .spawn(
            &ws_id,
            &req.server_id,
            &req.command,
            &req.args,
            &bridge_host,
            bridge_port,
        )
        .await;

    let url = mcp_process::bridge_server_url(&bridge_base_url, &req.server_id);
    tracing::info!(
        "MCP bridge spawned: ws={ws_id} server={} at {url}",
        req.server_id
    );
    Ok(AxumJson(McpSpawnResponse {
        status: "ok".into(),
        server_id: req.server_id,
        url,
    }))
}
async fn mcp_kill_handler(
    Path((ws_id, server_id)): Path<(String, String)>,
    State(app): State<Arc<AppState>>,
) -> Result<AxumJson<serde_json::Value>, (StatusCode, AxumJson<serde_json::Value>)> {
    app.ensure_workspace(&ws_id)
        .await
        .map_err(runtime_problem)?;
    let manager = mcp_manager();
    if !manager.list(&ws_id).await.iter().any(|bridge| bridge.server_id == server_id) {
        return Err(runtime_problem(RuntimeError::McpBridgeNotFound {
            workspace_id: ws_id,
            server_id,
        }));
    }
    {
        let workspace_manager = app.manager.lock().await;
        workspace_manager
            .stop_mcp_bridge(&ws_id, &server_id)
            .await
            .map_err(runtime_problem)?;
    }
    let removed = manager.stop(&ws_id, &server_id).await;
    if !removed {
        return Err(runtime_problem(RuntimeError::McpBridgeNotFound {
            workspace_id: ws_id,
            server_id,
        }));
    }
    Ok(AxumJson(serde_json::json!({"status": "ok"})))
}

async fn mcp_list_handler(
    Path(ws_id): Path<String>,
    State(app): State<Arc<AppState>>,
) -> Result<AxumJson<serde_json::Value>, (StatusCode, AxumJson<serde_json::Value>)> {
    app.ensure_workspace(&ws_id)
        .await
        .map_err(runtime_problem)?;
    let manager = mcp_manager();
    let bridges = manager.list(&ws_id).await;
    Ok(AxumJson(serde_json::json!({
        "servers": bridges,
        "count": bridges.len()
    })))
}

async fn mcp_stdio_handler(
    Path((ws_id, server_id)): Path<(String, String)>,
    State(app): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Result<axum::response::Response, (StatusCode, AxumJson<serde_json::Value>)> {
    app.ensure_workspace(&ws_id)
        .await
        .map_err(runtime_problem)?;
    let manager = mcp_manager();
    let bridge_base_url = manager
        .get_bridge_url(&ws_id, &server_id)
        .await
        .ok_or_else(|| {
            runtime_problem(RuntimeError::McpBridgeNotFound {
                workspace_id: ws_id.clone(),
                server_id: server_id.clone(),
            })
        })?;
    let bridge_url = mcp_process::bridge_server_url(&bridge_base_url, &server_id);

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{bridge_url}/{server_id}"))
        .header("Content-Type", "application/json")
        .body(body.to_vec())
        .send()
        .await
        .map_err(|error| {
            runtime_problem(RuntimeError::Docker(format!(
                "MCP bridge request failed: {error}"
            )))
        })?;

    let status = resp.status();
    let body = resp.bytes().await.map_err(|error| {
        runtime_problem(RuntimeError::Docker(format!(
            "MCP bridge response failed: {error}"
        )))
    })?;

    Ok(axum::response::Response::builder()
        .status(status)
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(body))
        .unwrap())
}

async fn workspace_mcp_handler(
    Path(ws_id): Path<String>,
    State(app): State<Arc<AppState>>,
    req: axum::extract::Request,
) -> axum::response::Response {
    if let Err(error) = app.ensure_workspace(&ws_id).await {
        return runtime_problem(error).into_response();
    }
    CURRENT_WS_ID
        .scope(ws_id, async {
            let Some(service) = MCP_SERVICE.get() else {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    AxumJson(serde_json::json!({
                        "code": "MCP_SERVICE_UNAVAILABLE",
                        "detail": "MCP service is not initialized",
                        "requestId": uuid::Uuid::new_v4().to_string(),
                    })),
                )
                    .into_response();
            };
            let mut svc = service.clone();
            match svc.call(req).await {
                Ok(response) => response.map(axum::body::Body::new),
                Err(error) => {
                    tracing::error!("workspace MCP request failed: {error}");
                    (
                        StatusCode::BAD_GATEWAY,
                        AxumJson(serde_json::json!({
                            "code": "MCP_REQUEST_FAILED",
                            "detail": "Workspace MCP request failed",
                            "requestId": uuid::Uuid::new_v4().to_string(),
                        })),
                    )
                        .into_response()
                }
            }
        })
        .await
}

async fn workspace_status_handler(
    Path(ws_id): Path<String>,
    State(app): State<Arc<AppState>>,
) -> Result<AxumJson<serde_json::Value>, (StatusCode, AxumJson<serde_json::Value>)> {
    match app.registry.status(&ws_id).await {
        Some(status) => Ok(AxumJson(serde_json::to_value(status).map_err(|error| {
            runtime_problem(RuntimeError::WorkspaceMaterializationFailed {
                workspace_id: ws_id.clone(),
                detail: format!("serialize workspace status: {error}"),
            })
        })?)),
        None => Err(runtime_problem(RuntimeError::ExecutionSpecNotFound(ws_id))),
    }
}

/// PLAN-262 M4 (decision 12): explicit async materialization trigger.
/// Returns 202 immediately with the current materialization state; the caller
/// polls GET .../status for progress. Reuses the idempotent per-workspace
/// ensure path without blocking on Sandbox creation or image pulls.
async fn workspace_materialize_handler(
    Path(ws_id): Path<String>,
    State(app): State<Arc<AppState>>,
) -> Result<(StatusCode, AxumJson<serde_json::Value>), (StatusCode, AxumJson<serde_json::Value>)> {
    if !xihe_runtime::hydrate::is_safe_workspace_id(&ws_id) {
        return Err(runtime_problem(RuntimeError::InvalidExecutionSpec {
            workspace_id: ws_id.clone(),
            detail: "workspaceId contains invalid route characters".to_string(),
        }));
    }
    // Fast path: already materialized and in sync with CP spec.
    if let Some(status) = app.registry.status(&ws_id).await
        && status.state == xihe_runtime::gateway::MaterializationState::Ready
    {
        return Ok((StatusCode::ACCEPTED, AxumJson(serde_json::to_value(status).map_err(|error| {
            runtime_problem(RuntimeError::WorkspaceMaterializationFailed {
                workspace_id: ws_id.clone(),
                detail: format!("serialize workspace status: {error}"),
            })
        })?)));
    }
    // PLAN-262 M4 P0 / PLAN-274: state is written before spawn so the 202
    // response never races a missing status. Failures mark Failed instead of
    // leaving Materializing forever.
    app.registry.mark_materializing(&ws_id).await;
    let app_clone = Arc::clone(&app);
    let ws_id_clone = ws_id.clone();
    tokio::spawn(async move {
        match app_clone.ensure_workspace(&ws_id_clone).await {
            Ok(_) => {
                tracing::info!("Explicit materialization completed: ws_id={}", ws_id_clone);
            }
            Err(error) => {
                tracing::warn!("Explicit materialization failed: ws_id={} error={}", ws_id_clone, error);
                app_clone.registry.mark_failed(&ws_id_clone, &error.to_string()).await;
            }
        }
    });
    let status = app.registry.status(&ws_id).await.ok_or_else(|| {
        runtime_problem(RuntimeError::WorkspaceMaterializationFailed {
            workspace_id: ws_id.clone(),
            detail: "materialization trigger accepted but status unavailable".to_string(),
        })
    })?;
    Ok((StatusCode::ACCEPTED, AxumJson(serde_json::to_value(status).map_err(|error| {
        runtime_problem(RuntimeError::WorkspaceMaterializationFailed {
            workspace_id: ws_id.clone(),
            detail: format!("serialize workspace status: {error}"),
        })
    })?)))
}

async fn create_workspace_handler(
    State(app): State<Arc<AppState>>,
    AxumJson(req): AxumJson<CreateWorkspaceRequest>,
) -> Result<AxumJson<CreateWorkspaceResponse>, (StatusCode, AxumJson<serde_json::Value>)> {
    let _ = &app; // explicit acknowledgement that the AppState may be extended later
    let storage_ref = req.storage_ref.as_deref().ok_or_else(|| {
        runtime_problem(RuntimeError::InvalidExecutionSpec {
            workspace_id: req.ws_id.clone(),
            detail: "storageRef is required; workspacePath is never used as a fallback".to_string(),
        })
    })?;
    let host_root = std::env::var("XIHE_WORKSPACE_HOST_ROOT").map_err(|_| {
        runtime_problem(RuntimeError::WorkspaceMaterializationFailed {
            workspace_id: req.ws_id.clone(),
            detail: "XIHE_WORKSPACE_HOST_ROOT is not configured".to_string(),
        })
    })?;
    storage::resolve_host_path(&host_root, storage_ref, &req.ws_id)
        .await
        .map_err(runtime_problem)?;
    tracing::info!(
        "Workspace logical create acknowledged without Sandbox materialization: ws_id={} storageRef={}",
        req.ws_id,
        storage_ref
    );
    Ok(AxumJson(CreateWorkspaceResponse {
        status: "ok".to_string(),
        ws_id: req.ws_id,
    }))
}
async fn delete_workspace_handler(
    State(app): State<Arc<AppState>>,
    AxumJson(req): AxumJson<DeleteWorkspaceRequest>,
) -> Result<AxumJson<DeleteWorkspaceResponse>, (StatusCode, AxumJson<serde_json::Value>)> {
    let ws_id = &req.ws_id;
    mcp_manager().cleanup_workspace(ws_id).await;
    let cleanup_result = {
        let mut manager = app.manager.lock().await;
        if manager.get_state(ws_id).is_some() {
            manager.delete_workspace(ws_id).await
        } else {
            Ok(())
        }
    };
    if let Err(error) = cleanup_result {
        app.registry.mark_failed(ws_id, &error.to_string()).await;
        return Err(runtime_problem(error));
    }
    app.registry.unregister(ws_id).await;
    app.registry.mark_released(ws_id).await;
    tracing::info!(
        "Sandbox deleted: ws_id={}, temporary execution resources cleaned; WorkspaceStorage preserved",
        ws_id
    );
    Ok(AxumJson(DeleteWorkspaceResponse {
        status: "ok".to_string(),
        ws_id: ws_id.clone(),
    }))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenv_loader::load();

    // CP configuration is optional at startup. Keep readiness independent from CP and
    // refresh the optional config client after the HTTP listener is available.
    let log_dir = std::env::var("XIHE_LOG_DIR").unwrap_or_else(|_| "logs".to_string());
    let log_level = std::env::var("XIHE_LOG_LEVEL").ok();
    let runtime_log_level = std::env::var("XIHE_LOG_LEVEL_RUNTIME").ok();
    let runtime_log_filter = std::env::var("XIHE_RUNTIME_LOG_FILTER").ok();
    let log_path = PathBuf::from(&log_dir).join("runtime.log");
    if let Some(parent) = log_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let file_appender = tracing_appender::rolling::daily(log_dir, "runtime.log");
    let (non_blocking_file, _guard) = tracing_appender::non_blocking(file_appender);

    tracing_subscriber::registry()
        .with(resolve_runtime_log_filter_with(
            runtime_log_filter.as_deref(),
            runtime_log_level.as_deref(),
            log_level.as_deref(),
        ))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(|| xihe_runtime::log_redact::RedactingWriter::new(std::io::stdout())),
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

    let runtime_host = std::env::var("XIHE_RUNTIME_HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
    let runtime_port = std::env::var("XIHE_RUNTIME_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(12633);
    let bind_addr = format!("{runtime_host}:{runtime_port}");

    let registry = Arc::new(WorkspaceRegistry::new());
    let manager = Arc::new(Mutex::new(WorkspaceManager::new()));
    let workspace_ensurer = Arc::new(WorkspaceEnsurer::from_env(
        registry.clone(),
        manager.clone(),
    ));
    let router = Arc::new(WorkspaceExecutionRouter::new(workspace_ensurer.clone(), manager.clone(), registry.clone()));
    // M2-3.1: device_id persistence (grill A random UUID file)
    let state_dir = device::resolve_state_dir();
    let device_id = match device::ensure_device_id(&state_dir).await {
        Ok(id) => id,
        Err(e) => {
            tracing::warn!(
                "device_id init failed (state_dir={:?}): {}, using ephemeral",
                state_dir,
                e
            );
            uuid::Uuid::new_v4().to_string()
        }
    };

    // A previous Runtime process may have exited before its graceful shutdown
    // handler ran. Remove only stale workspace containers owned by this run (or
    // unlabelled dev containers when no isolated E2E run is active); never touch
    // another isolated E2E run's containers.
    {
        let mut manager = manager.lock().await;
        if let Err(error) = manager.cleanup_orphans().await {
            tracing::warn!("runtime orphan cleanup failed: {}", error);
        }
    }

    let readiness = Arc::new(AtomicBool::new(true));
    let app_state = Arc::new(AppState {
        registry: registry.clone(),
        manager: manager.clone(),
        device_id: device_id.clone(),
        workspace_ensurer: workspace_ensurer.clone(),
        router: router.clone(),
        ready: readiness.clone(),
    });
    // `readiness` and `workspace_ensurer` are consumed by `app_state`; clone first
    // so the background loops can observe them without taking references into
    // `app_state` (which would require a second Arc to be cheap).
    let hb_ready = readiness.clone();
    let reaper_ready_marker = readiness.clone();
    let cp_poll_ensurer = workspace_ensurer.clone();

    tracing::info!(
        "Starting xihe Runtime MCP Server (Gateway mode) on {} (device_id={})",
        bind_addr,
        device_id
    );
    tracing::info!("readiness: true; Workspace Sandbox materialization is lazy");

    let ct = tokio_util::sync::CancellationToken::new();

    // XH Channel (PLAN-245): when XIHE_CHANNEL_URL is set, run the outbound
    // WebSocket control channel. Connection liveness drives the single-sink
    // rule (channel up → HTTP heartbeat idle; down → HTTP fallback).
    let channel_client = xihe_runtime::channel::ChannelClient::from_env(device_id.clone())
        .map(Arc::new);
    if let Some(channel) = channel_client.clone() {
        tracing::info!("channel: enabled url={}", channel.url);
        let channel_ct = ct.child_token();
        let channel_registry = registry.clone();
        tokio::spawn(async move {
            channel.run(channel_registry, channel_ct).await;
        });
    } else {
        tracing::info!("channel: disabled (XIHE_CHANNEL_URL not set); using HTTP heartbeat");
    }

    let reaper_registry = registry.clone();
    let reaper_manager = manager.clone();
    let reaper_ct = ct.child_token();
    tokio::spawn(async move {
        idle_reaper_loop(reaper_registry, reaper_manager, reaper_ct).await;
    });

    let mcp_manager = mcp_manager();
    let cp_poll_registry = registry.clone();
    let cp_poll_workspace_manager = manager.clone();
    let poll_ct = ct.child_token();
    tokio::spawn(async move {
        mcp_config_poll_loop(
            mcp_manager,
            cp_poll_registry,
            cp_poll_ensurer,
            cp_poll_workspace_manager,
            poll_ct,
        )
        .await;
    });

    let _hb_ready = hb_ready.clone();
    let hb_cp_url =
        std::env::var("XIHE_CP_URL").unwrap_or_else(|_| "http://127.0.0.1:12631".to_string());
    let hb_api_token =
        std::env::var("XIHE_CP_API_TOKEN").unwrap_or_else(|_| "dev-token-not-secure".to_string());
    let hb_device_id = device_id.clone();
    let hb_ct = ct.child_token();
    tokio::spawn(async move {
        heartbeat::heartbeat_loop(hb_ready, hb_cp_url, hb_api_token, hb_device_id, hb_ct, channel_client).await;
    });
    let _ = reaper_ready_marker;

    let service_ensurer = workspace_ensurer;
    let service = StreamableHttpService::new(
        move || {
            let ws_id = CURRENT_WS_ID
                .try_with(|id| id.clone())
                .unwrap_or_else(|_| "default".to_string());
            // Lazy, per-workspace materialization. Errors are surfaced through the
            // rmcp service handler so the caller observes a structured Problem+JSON.
            // block_in_place: rmcp invokes this closure from async worker threads;
            // a bare block_on panics with "Cannot start a runtime from within a runtime".
            let materialized = tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current()
                    .block_on(service_ensurer.ensure_workspace_materialized(&ws_id))
            });
            let instance = match materialized {
                Ok(instance) => instance,
                Err(error) => {
                    return Err(std::io::Error::other(format!(
                        "workspace materialization failed: {error}"
                    )));
                }
            };
            let profile = instance.profile;
            let runtime = XiheRuntime::new(
                &ws_id,
                &instance.workspace_path,
                profile,
                router.clone(),
            );
            Ok(runtime)
        },
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default()
            .with_cancellation_token(ct.child_token())
            .with_allowed_hosts(["localhost", "127.0.0.1", "runtime", "runtime:8001"]),
    );
    let _ = MCP_SERVICE.set(service);
    // Drop the registry handle for clarity; the Streamable service keeps its own
    // references via `service_ensurer` which is cloned below if needed.
    drop(registry);

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let router = Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/mcp",
            any(workspace_mcp_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces",
            post(create_workspace_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/status",
            get(workspace_status_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/materialize",
            post(workspace_materialize_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/delete",
            post(delete_workspace_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/mcp/spawn",
            post(mcp_spawn_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/mcp/spawn/{server_id}",
            delete(mcp_kill_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/mcp/spawn",
            get(mcp_list_handler),
        )
        .route(
            "/internal/v1/runtime/remote-mcp/{workspace_id}/{server_id}/call",
            post(remote_mcp_call_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/mcp/stdio/{server_id}",
            post(mcp_stdio_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/files/read",
            post(ws_file_handler::handle_read_file),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/files/write/{*path}",
            post(ws_file_handler::handle_write_binary),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/files/list",
            post(ws_file_handler::handle_list_directory),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/files/delete",
            post(ws_file_handler::handle_delete_file),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/files/mkdir",
            post(ws_file_handler::handle_mkdir),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/files/stat",
            post(ws_file_handler::handle_stat),
        )
        .layer(middleware::from_fn(internal_auth_middleware))
        .layer(middleware::from_fn(request_id_middleware))
        .layer(cors)
        .with_state(Arc::clone(&app_state));

    let tcp_listener = match tokio::net::TcpListener::bind(&bind_addr).await {
        Ok(listener) => listener,
        Err(error) => {
            tracing::error!(
                "Failed to bind runtime server to {}: {}. \
                 Override with XIHE_RUNTIME_PORT or free the port.",
                bind_addr,
                error
            );
            return Err(error.into());
        }
    };

    tracing::info!("Runtime MCP Server listening on {}", bind_addr);

    axum::serve(tcp_listener, router)
        .with_graceful_shutdown(async move {
            if let Err(e) = tokio::signal::ctrl_c().await {
                tracing::warn!("Failed to listen for shutdown signal: {}", e);
            }
            ct.cancel();
        })
        .await?;

    // Cold shutdown: stop all managed sandboxes (keep host storage). PLAN-201 M2.6 / M3.6.
    // This is bounded: each stop has 10s timeout inside WorkspaceManager::stop_container.
    tracing::info!("runtime_shutdown_started: draining and stopping managed sandboxes");
    {
        let ids: Vec<String> = {
            let mgr = app_state.manager.lock().await;
            mgr.list_workspaces()
                .iter()
                .map(|s| s.ws_id.clone())
                .collect()
        };
        if ids.is_empty() {
            tracing::info!("runtime_shutdown_draining: no managed sandboxes");
        } else {
            tracing::info!(
                "runtime_shutdown_draining: stopping {} sandbox(es)",
                ids.len()
            );
        }
        for ws_id in ids {
            let res = {
                let mut mgr = app_state.manager.lock().await;
                mgr.delete_workspace(&ws_id).await
            };
            match res {
                Ok(_) => tracing::info!("sandbox_deleted: ws_id={} storage_preserved=true", ws_id),
                Err(e) => {
                    let msg = e.to_string();
                    if msg.contains("SandboxNotFound") || msg.contains("not found") {
                        tracing::info!("sandbox_delete_skipped: ws_id={} not tracked", ws_id);
                    } else {
                        tracing::warn!("sandbox_delete_failed: ws_id={} err={}", ws_id, msg);
                    }
                }
            }
        }
    }
    tracing::info!("runtime_shutdown_finished: managed sandboxes drained, host storage preserved");

    Ok(())
}

async fn mcp_config_poll_loop(
    manager: &'static mcp_process::McpProcessManager,
    registry: Arc<WorkspaceRegistry>,
    ensurer: Arc<WorkspaceEnsurer>,
    workspace_manager: Arc<Mutex<WorkspaceManager>>,
    ct: tokio_util::sync::CancellationToken,
) {
    let cp_url = std::env::var("XIHE_CP_URL").unwrap_or_else(|_| "http://localhost:12631".into());
    let cp_api_token =
        std::env::var("XIHE_CP_API_TOKEN").unwrap_or_else(|_| "dev-token-not-secure".into());
    let mut interval = tokio::time::interval(mcp_process::CONFIG_POLL_INTERVAL);
    loop {
        tokio::select! {
            _ = ct.cancelled() => break,
            _ = interval.tick() => {
                // Q11: reap idle bridges (15 min) — grill A timeout
                manager.reap_idle(Duration::from_secs(900)).await;
                let instances = registry.all_instances().await;
                for instance in &instances {
                    let ws_id = &instance.ws_id;
                    // ensure_workspace_materialized performs one targeted CP lookup even
                    // for a Registry hit, so a local hash is never compared only with
                    // itself.
                    if let Err(error) = ensurer.ensure_workspace_materialized(ws_id).await {
                        tracing::warn!(
                            "config poll: ensure_workspace failed for {ws_id}: {error}"
                        );
                        registry
                            .mark_failed(ws_id, &format!("config poll: {error}"))
                            .await;
                        continue;
                    }
                    let (generation, hash, servers) =
                        manager.poll_config_with_generation(ws_id, &cp_url, &cp_api_token).await;
                    let existing = manager.list(ws_id).await;
                    for (server_id, command, args) in &servers {
                        if let Some(existing_info) =
                            existing.iter().find(|b| &b.server_id == server_id)
                        {
                            if existing_info.generation == generation
                                && existing_info.hash == hash
                            {
                                continue;
                            }
                            // Q9 A: generation/hash changed → rebuild (kill old, spawn new)
                            tracing::info!(
                                "config poll: generation/hash changed for {}/{} ({}->{}, {}->{}) rebuilding",
                                ws_id, server_id, existing_info.generation, generation, existing_info.hash, hash
                            );
                            let stop_result = {
                                let workspace_manager = workspace_manager.lock().await;
                                workspace_manager
                                    .stop_mcp_bridge(ws_id, server_id)
                                    .await
                            };
                            if let Err(error) = stop_result {
                                tracing::warn!(
                                    "config poll: failed to stop changed bridge for {}/{}: {}",
                                    ws_id,
                                    server_id,
                                    error
                                );
                                registry
                                    .mark_failed(ws_id, &format!("config poll stop failed: {error}"))
                                    .await;
                                continue;
                            }
                            manager.stop(ws_id, server_id).await;
                        }
                        tracing::info!(
                            "config poll: spawning {}/{} ({})",
                            ws_id, server_id, command
                        );

                        let port = allocate_bridge_port();
                        let endpoint = {
                            let workspace_manager = workspace_manager.lock().await;
                            workspace_manager
                                .start_mcp_bridge(ws_id, server_id, command, args, port)
                                .await
                        };
                        let (bridge_host, bridge_port) = match endpoint {
                            Ok(endpoint) => endpoint,
                            Err(error) => {
                                tracing::warn!(
                                    "config poll: bridge {}/{} is unavailable: {}",
                                    ws_id,
                                    server_id,
                                    error
                                );
                                registry
                                    .mark_failed(ws_id, &format!("config poll bridge unavailable: {error}"))
                                    .await;
                                continue;
                            }
                        };
                        let bridge_base_url =
                            mcp_process::bridge_base_url(&bridge_host, bridge_port);
                        if let Err(error) =
                            spawn_bridge_server(ws_id, &bridge_base_url, server_id, command, args)
                                .await
                        {
                            tracing::warn!(
                                "config poll: failed to spawn {}/{} through bridge: {}",
                                ws_id,
                                server_id,
                                error
                            );
                            let cleanup_result = {
                                let workspace_manager = workspace_manager.lock().await;
                                workspace_manager.stop_mcp_bridge(ws_id, server_id).await
                            };
                            if let Err(cleanup_error) = cleanup_result {
                                tracing::warn!(
                                    "config poll: bridge cleanup failed for {}/{}: {}",
                                    ws_id,
                                    server_id,
                                    cleanup_error
                                );
                            }
                            registry
                                .mark_failed(ws_id, &format!("config poll bridge spawn failed: {error}"))
                                .await;
                            continue;
                        }

                        manager
                            .spawn_with_generation(
                                ws_id,
                                server_id,
                                command,
                                args,
                                &bridge_host,
                                bridge_port,
                                generation,
                                &hash,
                            )
                            .await;
                        tracing::info!(
                            "config poll: bridge {}/{} spawned at {}:{}",
                            ws_id,
                            server_id,
                            bridge_host,
                            bridge_port
                        );
                    }

                    // Remove servers no longer in config
                    let configured_ids: std::collections::HashSet<&str> = servers.iter().map(|(id, _, _)| id.as_str()).collect();
                    for bridge_info in &existing {
                        if !configured_ids.contains(bridge_info.server_id.as_str()) {
                            tracing::info!("config poll: stopping removed server {}/{}", ws_id, bridge_info.server_id);
                            let stop_result = {
                                let workspace_manager = workspace_manager.lock().await;
                                workspace_manager
                                    .stop_mcp_bridge(ws_id, &bridge_info.server_id)
                                    .await
                            };
                            match stop_result {
                                Ok(()) => {
                                    manager.stop(ws_id, &bridge_info.server_id).await;
                                }
                                Err(error) => {
                                    tracing::warn!(
                                        "config poll: failed to stop removed bridge for {}/{}: {}",
                                        ws_id,
                                        bridge_info.server_id,
                                        error
                                    );
                                    registry
                                        .mark_failed(ws_id, &format!("config poll stop failed: {error}"))
                                        .await;
                                }
                            }
                        }
                    }
                    // M4-5.3 minimal observed report (log only for v1)
                    manager.log_observed(ws_id).await;
                }
            }
        }
    }
    tracing::info!("MCP config polling stopped");
}

async fn idle_reaper_loop(
    registry: Arc<WorkspaceRegistry>,
    manager: Arc<Mutex<WorkspaceManager>>,
    ct: tokio_util::sync::CancellationToken,
) {
    let mut ticker = interval(Duration::from_secs(60));

    loop {
        tokio::select! {
            _ = ct.cancelled() => {
                tracing::info!("Idle reaper cancelled");
                break;
            }
            _ = ticker.tick() => {
                // Periodic cross-map consistency check
                let consistency_issues = registry.check_consistency().await;
                if !consistency_issues.is_empty() {
                    tracing::error!(
                        error_code = "RUNTIME_CROSS_MAP_INCONSISTENCY",
                        consistency_issue_count = consistency_issues.len(),
                        consistency_issues = ?consistency_issues,
                        "cross-map consistency check reported errors; continuing idle reaper"
                    );
                }

                let instances = registry.all_instances().await;
                for instance in &instances {
                    let elapsed = match instance.last_active.elapsed() {
                        Ok(d) => d,
                        Err(e) => {
                            tracing::warn!("Clock error for {}: {}", instance.ws_id, e);
                            continue;
                        }
                    };
                    let ws_id = &instance.ws_id;

                    // Tier 4: 7 days idle — Suspended → Released. The Sandbox container is
                    // already gone in Tier 3; we only mark Released and surface the workspace
                    // in the per-workspace status map. Physical WorkspaceStorage stays intact.
                    if elapsed >= Duration::from_secs(604800) && instance.state == InstanceState::Suspended {
                        registry.set_state(ws_id, InstanceState::Released).await;
                        registry.unregister(ws_id).await;
                        tracing::info!(
                            "Idle reaper: released workspace {} (idle >7d); cache invalidated, WorkspaceStorage preserved at {}",
                            ws_id,
                            instance.workspace_path
                        );
                        continue;
                    }

                    // Stop & pause must reflect the current Docker state, otherwise a Sandbox
                    // restarted out of band (already exited) would never enter a clean state.
                    let is_container_already_stopped = matches!(
                        instance.state,
                        InstanceState::Stopped | InstanceState::Suspended | InstanceState::Released
                    );
                    if is_container_already_stopped {
                        tracing::debug!(
                            "Idle reaper: workspace {} container already non-running (state={:?}); skipping active tier",
                            ws_id, instance.state
                        );
                        continue;
                    }

                    // Tier 3: 24 hours idle — remove ephemeral container, keep WorkspaceStorage.
                    // Tier 3 is idempotent against the suspended state so a Sandbox that was
                    // already stopped externally still gets its state promoted to Suspended.
                    if elapsed >= Duration::from_secs(86400)
                        && (instance.state == InstanceState::Stopped
                            || matches!(instance.state, InstanceState::Active | InstanceState::Paused))
                    {
                        let mut mgr = manager.lock().await;
                        match mgr.delete_workspace(ws_id).await {
                            Ok(_) => {
                                registry.set_state(ws_id, InstanceState::Suspended).await;
                                registry.unregister(ws_id).await;
                                tracing::info!(
                                    "Idle reaper: suspended workspace {} (idle >24h); cache invalidated, WorkspaceStorage preserved",
                                    ws_id
                                );
                            }
                            Err(e) => {
                                tracing::warn!(
                                    "Idle reaper: failed to remove container {}: {}; retaining state",
                                    ws_id, e
                                );
                            }
                        }
                        continue;
                    }

                    // Tier 2: 2 hours idle — Active/Paused → Stopped
                    if elapsed >= Duration::from_secs(7200) && (instance.state == InstanceState::Active || instance.state == InstanceState::Paused) {
                        let mgr = manager.lock().await;
                        match mgr.stop_container(ws_id).await {
                            Ok(_) => {
                                registry.set_state(ws_id, InstanceState::Stopped).await;
                                tracing::info!("Idle reaper: stopped container {} (idle >2h)", ws_id);
                            }
                            Err(e) => {
                                tracing::warn!(
                                    "Idle reaper: failed to stop container {}: {}; retaining state",
                                    ws_id, e
                                );
                            }
                        }
                        continue;
                    }

                    // Tier 1: 15 minutes idle — Active → Paused
                    if elapsed >= Duration::from_secs(900) && instance.state == InstanceState::Active {
                        let mgr = manager.lock().await;
                        match mgr.pause_container(ws_id).await {
                            Ok(_) => {
                                registry.set_state(ws_id, InstanceState::Paused).await;
                                tracing::info!("Idle reaper: paused container {} (idle >15m)", ws_id);
                            }
                            Err(e) => {
                                tracing::warn!(
                                    "Idle reaper: failed to pause container {}: {}; retaining state",
                                    ws_id, e
                                );
                            }
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod remote_handler_tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use axum::http::Request;
    use tokio::net::TcpListener;

    const TEST_WS: &str = "ws-test";

    #[allow(unsafe_code)]
    fn allow_local_http() {
        // Edition 2024: env mutation is unsafe; confined to this test binary,
        // which has no other readers of this flag.
        unsafe {
            std::env::set_var("XIHE_REMOTE_MCP_ALLOW_INSECURE_LOCAL", "true");
        }
    }

    fn spec_json(ws_id: &str) -> serde_json::Value {
        serde_json::json!({
            "workspaceId": ws_id,
            "generation": 1,
            "sandboxSpecHash": "a".repeat(64),
            "sandboxSpec": {"profile": "strict"},
            "storageBackend": "host_directory",
            "storageRef": ws_id,
        })
    }

    async fn cp_stub() -> String {
        async fn handler(Path(ws_id): Path<String>) -> impl IntoResponse {
            if ws_id == "ws-missing" {
                return (StatusCode::NOT_FOUND, "not found").into_response();
            }
            AxumJson(spec_json(&ws_id)).into_response()
        }
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind cp stub");
        let addr = listener.local_addr().expect("cp stub addr").to_string();
        let app = Router::new().route(
            "/internal/v1/runtime/workspaces/{ws_id}/execution-spec",
            get(handler),
        );
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve cp stub");
        });
        format!("http://{addr}")
    }

    async fn fake_mcp() -> String {
        async fn handler(request: Request<Body>) -> impl IntoResponse {
            let (_parts, body) = request.into_parts();
            let bytes = to_bytes(body, usize::MAX).await.expect("read fake body");
            let payload: serde_json::Value =
                serde_json::from_slice(&bytes).expect("fake received JSON");
            let id = payload.get("id").cloned().unwrap_or(serde_json::Value::Null);
            let response = match payload.get("method").and_then(|m| m.as_str()) {
                Some("initialize") => serde_json::json!({
                    "jsonrpc": "2.0", "id": id,
                    "result": {"protocolVersion": "2026-07-28", "capabilities": {}}
                }),
                Some("tools/list") => serde_json::json!({
                    "jsonrpc": "2.0", "id": id,
                    "result": {"tools": [
                        {"name": "fake_echo", "description": "Echo",
                         "inputSchema": {"type": "object"}}
                    ]}
                }),
                Some("tools/call") => serde_json::json!({
                    "jsonrpc": "2.0", "id": id,
                    "result": {"content": [{"type": "text", "text": "wire-ok"}]}
                }),
                _ => serde_json::json!({"jsonrpc": "2.0", "id": id, "result": {}}),
            };
            (
                [(axum::http::header::CONTENT_TYPE, "application/json")],
                response.to_string(),
            )
        }
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind fake mcp");
        let addr = listener.local_addr().expect("fake mcp addr").to_string();
        let app = Router::new().fallback(any(handler));
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve fake mcp");
        });
        format!("http://{addr}/mcp")
    }

    async fn test_state(cp_url: &str) -> Arc<AppState> {
        let registry = Arc::new(WorkspaceRegistry::new());
        let manager = Arc::new(Mutex::new(WorkspaceManager::new()));
        let client = xihe_runtime::hydrate::ExecutionSpecClient::new(cp_url, "test-token");
        let ensurer = Arc::new(WorkspaceEnsurer::from_env_with_client(
            registry.clone(),
            manager.clone(),
            client,
        ));
        let router = Arc::new(WorkspaceExecutionRouter::new(
            ensurer.clone(),
            manager.clone(),
            registry.clone(),
        ));
        Arc::new(AppState {
            registry,
            manager,
            device_id: "test-device".to_string(),
            workspace_ensurer: ensurer,
            router,
            ready: Arc::new(AtomicBool::new(true)),
        })
    }

    fn auth_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer dev-token-not-secure".parse().expect("auth header"),
        );
        headers
    }

    fn call_request(endpoint: &str, list_tools: bool) -> RemoteMcpCallRequest {
        RemoteMcpCallRequest {
            endpoint: endpoint.to_string(),
            tool: if list_tools {
                String::new()
            } else {
                "fake_echo".to_string()
            },
            arguments: serde_json::json!({"value": "hello"}),
            user_id: "u-1".to_string(),
            scope: "mcp:tools".to_string(),
            request_state: None,
            auth_mode: "no-auth".to_string(),
            list_tools,
        }
    }

    /// PLAN-242 M2.5 (Fake 门): tools/call 经身份校验直达 Fake，
    /// 且不建容器、不写注册表。
    #[tokio::test]
    async fn remote_call_reaches_fake_without_container() {
        allow_local_http();
        let cp_url = cp_stub().await;
        let endpoint = fake_mcp().await;
        let app = test_state(&cp_url).await;

        let result = remote_mcp_call_handler(
            Path((TEST_WS.to_string(), "fake".to_string())),
            State(app.clone()),
            auth_headers(),
            AxumJson(call_request(&endpoint, false)),
        )
        .await
        .expect("remote call succeeds");

        assert_eq!(result.0["content"][0]["text"], "wire-ok");
        assert!(app.registry.status(TEST_WS).await.is_none());
        assert!(app.manager.lock().await.list_workspaces().is_empty());
    }

    /// PLAN-242 M2.5 (Fake 门): listTools 返回工具表，同样不建容器。
    #[tokio::test]
    async fn remote_list_returns_tools_without_container() {
        allow_local_http();
        let cp_url = cp_stub().await;
        let endpoint = fake_mcp().await;
        let app = test_state(&cp_url).await;

        let result = remote_mcp_call_handler(
            Path((TEST_WS.to_string(), "fake".to_string())),
            State(app.clone()),
            auth_headers(),
            AxumJson(call_request(&endpoint, true)),
        )
        .await
        .expect("remote list succeeds");

        assert_eq!(result.0["tools"][0]["name"], "fake_echo");
        assert!(app.registry.status(TEST_WS).await.is_none());
    }

    /// PLAN-242 M2.3: 未知 workspace fail-closed（404），不建容器。
    #[tokio::test]
    async fn remote_call_unknown_workspace_fails_closed() {
        allow_local_http();
        let cp_url = cp_stub().await;
        let endpoint = fake_mcp().await;
        let app = test_state(&cp_url).await;

        let error = remote_mcp_call_handler(
            Path(("ws-missing".to_string(), "fake".to_string())),
            State(app.clone()),
            auth_headers(),
            AxumJson(call_request(&endpoint, false)),
        )
        .await
        .expect_err("unknown workspace must fail");

        assert_eq!(error.0, StatusCode::NOT_FOUND);
        assert!(app.manager.lock().await.list_workspaces().is_empty());
    }
}
