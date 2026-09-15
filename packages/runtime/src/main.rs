use std::borrow::Cow;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};

use axum::Json as AxumJson;
use axum::extract::State;
use axum::extract::rejection::QueryRejection;
use axum::extract::{Path, Query};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, delete, get, post};
use axum::{
    Router,
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
use xihe_runtime::checkpoint_api::{
    CheckpointService, CreateBaseFailure, GcFailure, SealFailure, StatusFailure,
};
use xihe_runtime::checkpoint_revert::RevertAcks;
use xihe_runtime::checkpoint_revert_api::{BlobFailure, BlobRef, GitStatusFailure, RevertFailure};
use xihe_runtime::device;
use xihe_runtime::dotenv_loader;
use xihe_runtime::error::RuntimeError;
use xihe_runtime::executor::ExecutionEnd;
use xihe_runtime::executor::WorkspaceExecutionRouter;
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
use xihe_runtime::tool_timeout;
use xihe_runtime::workspace::WorkspaceManager;

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
    /// PLAN-0328 M2 W2: Run checkpoints (shadow git engine + mutation lease).
    pub checkpoints: Arc<CheckpointService>,
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

/// Background-process tool parameter: the caller-facing key is `jobId`
/// (PLAN-0317 T1.2); it is the opaque id returned by
/// `start_background_process`, not a process id.
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct JobIdRequest {
    #[serde(rename = "jobId")]
    pub job_id: String,
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
        self.router
            .read_file(&self.ws_id, &path)
            .await
            .map_err(|e| e.to_string())
    }

    #[tool(
        description = "Read file with line range support, binary detection, and line numbers (binary files return base64 with is_binary=true, capped at 16 MiB)"
    )]
    async fn read_file_range(
        &self,
        Parameters(ReadFileRangeRequest {
            path,
            offset,
            limit,
        }): Parameters<ReadFileRangeRequest>,
    ) -> Result<Json<ReadFileRangeResult>, String> {
        // PLAN-292 T6: wire the tool to the sandbox's binary-safe
        // fs::read_file_range instead of the text-only duplicate that
        // hardcoded is_binary=false and failed on binary content.
        let val = self
            .router
            .read_file_range(&self.ws_id, &path, offset, limit)
            .await
            .map_err(|e| e.to_string())?;
        let result: ReadFileRangeResult = serde_json::from_value(val).map_err(|e| e.to_string())?;
        Ok(Json(result))
    }

    #[tool(description = "Write file (creates parent directories as needed)")]
    async fn write_file(
        &self,
        Parameters(WriteFileRequest { path, content }): Parameters<WriteFileRequest>,
    ) -> Result<String, String> {
        self.router
            .write_file(&self.ws_id, &path, &content)
            .await
            .map_err(|e| e.to_string())
    }

    #[tool(description = "List directory contents with file metadata")]
    async fn list_directory(
        &self,
        Parameters(ListDirectoryRequest { path }): Parameters<ListDirectoryRequest>,
    ) -> Result<Json<fs::DirectoryListing>, String> {
        let val = self
            .router
            .list_directory(&self.ws_id, &path)
            .await
            .map_err(|e| e.to_string())?;
        let entries: Vec<fs::FileInfo> =
            serde_json::from_value(val.get("entries").cloned().unwrap_or(val))
                .map_err(|e| format!("deserialize list: {e}"))?;
        Ok(Json(fs::DirectoryListing { entries }))
    }

    #[tool(description = "Match files using glob pattern")]
    async fn glob(
        &self,
        Parameters(GlobRequest { pattern, path }): Parameters<GlobRequest>,
    ) -> Result<Json<fs::GlobResults>, String> {
        let val = self
            .router
            .glob(&self.ws_id, &pattern, &path)
            .await
            .map_err(|e| e.to_string())?;
        let matches: Vec<String> =
            serde_json::from_value(val.get("matches").cloned().unwrap_or(val))
                .map_err(|e| format!("deserialize glob: {e}"))?;
        Ok(Json(fs::GlobResults { matches }))
    }

    #[tool(description = "Search files using regular expression")]
    async fn grep(
        &self,
        Parameters(GrepRequest { pattern, path }): Parameters<GrepRequest>,
    ) -> Result<Json<fs::GrepResults>, String> {
        let val = self
            .router
            .grep(&self.ws_id, &pattern, &path)
            .await
            .map_err(|e| e.to_string())?;
        let matches: Vec<fs::MatchResult> =
            serde_json::from_value(val.get("matches").cloned().unwrap_or(val))
                .map_err(|e| format!("deserialize grep: {e}"))?;
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
        let val = self
            .router
            .execute_command(&self.ws_id, &command, args_vec, timeout, truncate_limit)
            .await
            .map_err(|e| e.to_string())?;
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
        let val = self
            .router
            .read_command_output(&self.ws_id, &artifact_id, offset, limit)
            .await
            .map_err(|e| e.to_string())?;
        if let Some(content) = val.get("content").and_then(|v| v.as_str()) {
            Ok(Json(content.lines().map(|s| s.to_string()).collect()))
        } else if let Some(arr) = val.get("content").and_then(|v| v.as_array()) {
            Ok(Json(
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect(),
            ))
        } else {
            Ok(Json(vec![]))
        }
    }

    #[tool(description = "Get file or directory metadata")]
    async fn get_file_info(
        &self,
        Parameters(GetFileInfoRequest { path }): Parameters<GetFileInfoRequest>,
    ) -> Result<Json<FileInfo>, String> {
        let val = self
            .router
            .get_file_info(&self.ws_id, &path)
            .await
            .map_err(|e| e.to_string())?;
        let info: FileInfo = serde_json::from_value(val).map_err(|e| e.to_string())?;
        Ok(Json(info))
    }

    #[tool(description = "Watch a directory for file system events (2s poll)")]
    async fn watch_directory(
        &self,
        Parameters(WatchDirectoryRequest { path }): Parameters<WatchDirectoryRequest>,
    ) -> Result<Json<fs::FileEventList>, String> {
        let val = self
            .router
            .watch_directory(&self.ws_id, &path)
            .await
            .map_err(|e| e.to_string())?;
        let events: Vec<fs::FileEvent> =
            serde_json::from_value(val.get("events").cloned().unwrap_or(val))
                .map_err(|e| e.to_string())?;
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
        let val = self
            .router
            .edit_file(
                &self.ws_id,
                &file_path,
                &old_string,
                &new_string,
                replace_all.unwrap_or(false),
            )
            .await
            .map_err(|e| e.to_string())?;
        let result: EditFileResult = serde_json::from_value(val).map_err(|e| e.to_string())?;
        Ok(Json(result))
    }

    #[tool(description = "Delete a file")]
    async fn delete_file(
        &self,
        Parameters(DeleteFileRequest { path }): Parameters<DeleteFileRequest>,
    ) -> Result<String, String> {
        self.router
            .delete_file(&self.ws_id, &path)
            .await
            .map_err(|e| e.to_string())
    }

    #[tool(description = "Delete a directory (requires recursive=true for non-empty dirs)")]
    async fn delete_directory(
        &self,
        Parameters(DeleteDirectoryRequest { path, recursive }): Parameters<DeleteDirectoryRequest>,
    ) -> Result<String, String> {
        self.router
            .delete_directory(&self.ws_id, &path, recursive.unwrap_or(false))
            .await
            .map_err(|e| e.to_string())
    }

    #[tool(description = "Move or rename a file or directory")]
    async fn move_file(
        &self,
        Parameters(MoveFileRequest { from, to }): Parameters<MoveFileRequest>,
    ) -> Result<String, String> {
        self.router
            .move_file(&self.ws_id, &from, &to)
            .await
            .map_err(|e| e.to_string())
    }

    #[tool(description = "Copy a file")]
    async fn copy_file(
        &self,
        Parameters(CopyFileRequest { from, to }): Parameters<CopyFileRequest>,
    ) -> Result<String, String> {
        self.router
            .copy_file(&self.ws_id, &from, &to)
            .await
            .map_err(|e| e.to_string())
    }

    #[tool(description = "Create a directory (recursive, creates parents as needed)")]
    async fn mkdir(
        &self,
        Parameters(MkdirRequest { path }): Parameters<MkdirRequest>,
    ) -> Result<String, String> {
        self.router
            .mkdir(&self.ws_id, &path)
            .await
            .map_err(|e| e.to_string())
    }

    #[tool(description = "Extract text content from a PDF file")]
    async fn extract_pdf_text(
        &self,
        Parameters(ExtractPdfTextRequest { path }): Parameters<ExtractPdfTextRequest>,
    ) -> Result<String, String> {
        self.router
            .extract_pdf_text(&self.ws_id, &path)
            .await
            .map_err(|e| e.to_string())
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

    #[tool(description = "Execute a long-running command in the background and return a jobId")]
    async fn start_background_process(
        &self,
        Parameters(ExecuteCommandRequest {
            command,
            args,
            timeout,
            truncate_limit: _truncate,
        }): Parameters<ExecuteCommandRequest>,
    ) -> Result<String, String> {
        let args_vec = args;
        self.router
            .start_background_process(&self.ws_id, &command, args_vec, timeout)
            .await
            .map_err(|e| e.to_string())
    }

    #[tool(description = "List all background processes for this workspace")]
    async fn list_background_processes(
        &self,
    ) -> Result<Json<Vec<sandbox::BackgroundProcess>>, String> {
        let val = self
            .router
            .list_background_processes(&self.ws_id)
            .await
            .map_err(|e| e.to_string())?;
        let jobs: Vec<sandbox::BackgroundProcess> =
            serde_json::from_value(val.get("jobs").cloned().unwrap_or(val))
                .map_err(|e| e.to_string())?;
        Ok(Json(jobs))
    }

    #[tool(description = "Get status of a background process by jobId")]
    async fn get_background_process(
        &self,
        Parameters(JobIdRequest { job_id }): Parameters<JobIdRequest>,
    ) -> Result<Json<sandbox::BackgroundProcess>, String> {
        let val = self
            .router
            .get_background_process(&self.ws_id, &job_id)
            .await
            .map_err(|e| e.to_string())?;
        let proc: sandbox::BackgroundProcess =
            serde_json::from_value(val).map_err(|e| e.to_string())?;
        Ok(Json(proc))
    }

    #[tool(description = "Cancel a background process by jobId")]
    async fn cancel_background_process(
        &self,
        Parameters(JobIdRequest { job_id }): Parameters<JobIdRequest>,
    ) -> Result<String, String> {
        let val = self
            .router
            .cancel_background_process(&self.ws_id, &job_id)
            .await
            .map_err(|e| e.to_string())?;
        Ok(val
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("cancelled")
            .to_string())
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

    // PLAN-0308 M1（spec S1/S2）：读取 CP 随请求下发的等待值（含性质标记），
    // 按三条判断得出生效值并以 task_local 传给 executor；无头时退回本模块 ENV / 默认。
    async fn call_tool(
        &self,
        request: rmcp::model::CallToolRequestParams,
        context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<rmcp::model::CallToolResponse, rmcp::ErrorData> {
        let effective = tool_timeout::resolve_from_extensions(&context.extensions)
            .unwrap_or_else(tool_timeout::current_or_resolve);
        // PLAN-0308 M1 T1.8（spec S5.1）：关联键随请求透传，exec 日志与超时错误携带同一 toolCallId。
        let correlation = tool_timeout::correlation_from_extensions(&context.extensions);
        // T3.4（决策 #31 ②）：CP 下发的输出上限授权（调用方只可收窄）。
        let output_limit = tool_timeout::output_limit_from_extensions(&context.extensions);
        tracing::info!(
            target: "timeout",
            tool = %request.name,
            "tool call wait: {}{} outputLimit={}",
            effective.signature(),
            correlation.render(),
            output_limit.map(|v| v.to_string()).unwrap_or_else(|| "-".to_string())
        );
        let tool_call_context =
            rmcp::handler::server::tool::ToolCallContext::new(self, request, context);
        tool_timeout::scope_tool_call(
            effective,
            correlation,
            output_limit,
            Self::tool_router().call(tool_call_context),
        )
        .await
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
        return EnvFilter::try_new(with_timeout_target(runtime_log_filter)).unwrap_or_else(|_| {
            EnvFilter::new(with_timeout_target("xihe_runtime=info,rmcp=info"))
        });
    }

    let level = runtime_level
        .filter(|value| !value.is_empty())
        .or(global_level.filter(|value| !value.is_empty()))
        .map(normalize_runtime_log_level)
        .unwrap_or_else(|| "info".to_string());

    EnvFilter::new(with_timeout_target(&format!(
        "xihe_runtime={level},rmcp={level}"
    )))
}

/// PLAN-0308 M1（spec S5.1/V10）：工具超时署名日志用独立 target `timeout`，
/// 不在 `xihe_runtime` 前缀下——必须显式放行，否则三跳时间线缺 Runtime 一层。
fn with_timeout_target(filter: &str) -> String {
    if filter
        .split(',')
        .any(|directive| directive.trim_start().starts_with("timeout"))
    {
        return filter.to_string();
    }
    format!("{filter},timeout=info")
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
        RuntimeError::WorkspaceMaterializationFailed { .. } => "WORKSPACE_MATERIALIZATION_FAILED",
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

/// PLAN-0317 T2.3（决策 #13）：取消的有界等待——容器回帧后 CP 才能落
/// `cancelled`；未确认则由 CP 落 `aborted` 并交给追偿（决策 #14）。
const CANCEL_CONFIRM_WAIT: Duration = Duration::from_secs(6);

/// 取消端点状态映射（纯函数，便于单测）。
fn cancel_status(end: Option<ExecutionEnd>) -> (&'static str, bool) {
    match end {
        Some(ExecutionEnd::Cancelled { confirmed: true }) => ("cancelled", true),
        Some(ExecutionEnd::Cancelled { confirmed: false }) => ("unconfirmed", false),
        // 执行在我们到达前已自然结束：取消未命中，不得覆盖既有事实。
        Some(ExecutionEnd::Completed) => ("already_finished", false),
        None => ("unconfirmed", false),
    }
}

/// 内部取消端点：按 (workspaceId, operationItemId) 定位在途执行并触发中止，
/// 有界等待容器确认。找不到 → 404（幂等，不算错误）。
async fn cancel_execution_handler(
    State(state): State<Arc<AppState>>,
    Path((ws_id, item_id)): Path<(String, String)>,
) -> Response {
    let in_flight = state.router.in_flight();
    let Some(mut outcome) = in_flight.request_termination(&ws_id, &item_id) else {
        let request_id = uuid::Uuid::new_v4().to_string();
        return (
            StatusCode::NOT_FOUND,
            [(axum::http::header::CONTENT_TYPE, "application/problem+json")],
            AxumJson(serde_json::json!({
                "type": "https://xihe.dev/problems/execution-not-found",
                "title": "Execution not found",
                "status": 404,
                "code": "EXECUTION_NOT_FOUND",
                "detail": "No in-flight execution for this workspace and operation item",
                "requestId": request_id
            })),
        )
            .into_response();
    };
    let waited = tokio::time::timeout(
        CANCEL_CONFIRM_WAIT,
        outcome.wait_for(|value| value.is_some()),
    )
    .await;
    let end = match waited {
        Ok(Ok(value)) => *value,
        _ => None,
    };
    let (status, confirmed) = cancel_status(end);
    (
        StatusCode::OK,
        AxumJson(serde_json::json!({"status": status, "confirmed": confirmed})),
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
    if let Err(error) = spawn_bridge_server(
        &ws_id,
        &bridge_base_url,
        &req.server_id,
        &req.command,
        &req.args,
    )
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
    if !manager
        .list(&ws_id)
        .await
        .iter()
        .any(|bridge| bridge.server_id == server_id)
    {
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
        return Ok((
            StatusCode::ACCEPTED,
            AxumJson(serde_json::to_value(status).map_err(|error| {
                runtime_problem(RuntimeError::WorkspaceMaterializationFailed {
                    workspace_id: ws_id.clone(),
                    detail: format!("serialize workspace status: {error}"),
                })
            })?),
        ));
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
                tracing::warn!(
                    "Explicit materialization failed: ws_id={} error={}",
                    ws_id_clone,
                    error
                );
                app_clone
                    .registry
                    .mark_failed(&ws_id_clone, &error.to_string())
                    .await;
            }
        }
    });
    let status = app.registry.status(&ws_id).await.ok_or_else(|| {
        runtime_problem(RuntimeError::WorkspaceMaterializationFailed {
            workspace_id: ws_id.clone(),
            detail: "materialization trigger accepted but status unavailable".to_string(),
        })
    })?;
    Ok((
        StatusCode::ACCEPTED,
        AxumJson(serde_json::to_value(status).map_err(|error| {
            runtime_problem(RuntimeError::WorkspaceMaterializationFailed {
                workspace_id: ws_id.clone(),
                detail: format!("serialize workspace status: {error}"),
            })
        })?),
    ))
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

/// PLAN-0328 M2 W2: Run-checkpoint host API (shadow git + workspace mutation lease).
///
/// The service lives in `xihe_runtime::checkpoint_api`; these handlers only map
/// its outcomes to the frozen contract (200 / 400 / 404 / 409 / 503 Problem+JSON).
#[derive(Debug, Deserialize)]
struct CreateRunCheckpointRequest {
    #[serde(rename = "runId")]
    run_id: String,
    #[serde(default)]
    actor: Option<String>,
    #[serde(rename = "callId", default)]
    call_id: Option<String>,
}

fn checkpoint_problem_response(
    status: StatusCode,
    code: &'static str,
    reason: Option<&str>,
    detail: &str,
) -> Response {
    checkpoint_problem_response_with(status, code, reason, detail, serde_json::Map::new())
}

/// Same frozen Problem+JSON shape with additional contract fields (e.g. the
/// revert lease holder or the unacknowledged conflict paths).
fn checkpoint_problem_response_with(
    status: StatusCode,
    code: &'static str,
    reason: Option<&str>,
    detail: &str,
    extra: serde_json::Map<String, serde_json::Value>,
) -> Response {
    let mut body = serde_json::json!({
        "type": format!("https://xihe.dev/problems/{}", code.to_ascii_lowercase()),
        "title": status.canonical_reason().unwrap_or("Run checkpoint request failed"),
        "status": status.as_u16(),
        "code": code,
        "detail": detail,
        "requestId": uuid::Uuid::new_v4().to_string(),
    });
    if let Some(reason) = reason {
        body["reason"] = serde_json::Value::String(reason.to_string());
    }
    if let Some(object) = body.as_object_mut() {
        for (key, value) in extra {
            object.insert(key, value);
        }
    }
    (
        status,
        [(axum::http::header::CONTENT_TYPE, "application/problem+json")],
        AxumJson(body),
    )
        .into_response()
}

async fn create_run_checkpoint_handler(
    Path(ws_id): Path<String>,
    State(app): State<Arc<AppState>>,
    AxumJson(request): AxumJson<CreateRunCheckpointRequest>,
) -> Response {
    match app
        .checkpoints
        .create_base(
            &ws_id,
            &request.run_id,
            request.actor.as_deref(),
            request.call_id.as_deref(),
        )
        .await
    {
        Ok(outcome) => AxumJson(outcome).into_response(),
        Err(CreateBaseFailure::Validation { detail }) => checkpoint_problem_response(
            StatusCode::BAD_REQUEST,
            "CHECKPOINT_INVALID_REQUEST",
            None,
            &detail,
        ),
        Err(CreateBaseFailure::LeaseHeld {
            run_id,
            expires_at_ms,
        }) => (
            StatusCode::CONFLICT,
            [(axum::http::header::CONTENT_TYPE, "application/problem+json")],
            AxumJson(serde_json::json!({
                "type": "https://xihe.dev/problems/checkpoint_lease_held",
                "title": "Workspace mutation lease held",
                "status": 409,
                "code": "CHECKPOINT_LEASE_HELD",
                "reason": "LEASE_HELD",
                "heldByRunId": run_id,
                "expiresAtMs": expires_at_ms,
                "detail": "another run holds the workspace mutation lease",
                "requestId": uuid::Uuid::new_v4().to_string(),
            })),
        )
            .into_response(),
        Err(CreateBaseFailure::Unavailable { reason, detail }) => checkpoint_problem_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "CHECKPOINT_UNAVAILABLE",
            Some(reason),
            &detail,
        ),
    }
}

async fn seal_run_checkpoint_handler(
    Path((ws_id, run_id)): Path<(String, String)>,
    State(app): State<Arc<AppState>>,
) -> Response {
    // `sealedWithLiveJobs` reads the host in-flight registry only: a seal must
    // never materialize or probe the sandbox just to answer this flag.
    let with_live_jobs = app.router.in_flight().count_for_workspace(&ws_id) > 0;
    match app.checkpoints.seal(&ws_id, &run_id, with_live_jobs).await {
        Ok(outcome) => AxumJson(outcome).into_response(),
        Err(SealFailure::NotFound { run_id }) => checkpoint_problem_response(
            StatusCode::NOT_FOUND,
            "CHECKPOINT_NOT_FOUND",
            None,
            &format!("no checkpoint refs for run {run_id}"),
        ),
        Err(SealFailure::Unavailable { reason, detail }) => checkpoint_problem_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "CHECKPOINT_UNAVAILABLE",
            Some(reason),
            &detail,
        ),
    }
}

async fn checkpoint_status_handler(
    Path((ws_id, run_id)): Path<(String, String)>,
    State(app): State<Arc<AppState>>,
) -> Response {
    match app.checkpoints.status(&ws_id, &run_id).await {
        Ok(status) => AxumJson(status).into_response(),
        Err(StatusFailure::NotFound { run_id }) => checkpoint_problem_response(
            StatusCode::NOT_FOUND,
            "CHECKPOINT_NOT_FOUND",
            None,
            &format!("no checkpoint refs for run {run_id}"),
        ),
        Err(StatusFailure::Unavailable { reason, detail }) => checkpoint_problem_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "CHECKPOINT_UNAVAILABLE",
            Some(reason),
            &detail,
        ),
    }
}

async fn checkpoint_gc_handler(
    Path(ws_id): Path<String>,
    State(app): State<Arc<AppState>>,
) -> Response {
    match app.checkpoints.gc(&ws_id).await {
        Ok(outcome) => AxumJson(outcome).into_response(),
        Err(GcFailure::Validation { detail }) => checkpoint_problem_response(
            StatusCode::BAD_REQUEST,
            "CHECKPOINT_INVALID_REQUEST",
            None,
            &detail,
        ),
        Err(GcFailure::Unavailable { reason, detail }) => checkpoint_problem_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "CHECKPOINT_UNAVAILABLE",
            Some(reason),
            &detail,
        ),
    }
}

/// PLAN-0328 M3 W1b: revert + workspace-diff host API.
///
/// `revert/preview` is read-only (no lease); `revert` takes the synthetic
/// workspace mutation lease before executing; `blob` serves one plain-text file
/// from the run's base/end tree; `git-status` is the read-only user-repository
/// status for the dual-diff separation.
fn revert_failure_response(failure: RevertFailure) -> Response {
    match failure {
        RevertFailure::NotFound { run_id } => checkpoint_problem_response(
            StatusCode::NOT_FOUND,
            "CHECKPOINT_NOT_FOUND",
            None,
            &format!("no checkpoint refs for run {run_id}"),
        ),
        RevertFailure::NotSealed { run_id } => checkpoint_problem_response(
            StatusCode::CONFLICT,
            "CHECKPOINT_NOT_SEALED",
            None,
            &format!("run {run_id} is not sealed; revert requires a sealed run"),
        ),
        RevertFailure::LeaseHeld {
            holder,
            expires_at_ms,
        } => {
            let mut extra = serde_json::Map::new();
            if let Some(holder) = holder {
                extra.insert("heldByRunId".to_string(), serde_json::json!(holder));
            }
            if let Some(expires) = expires_at_ms {
                extra.insert("expiresAtMs".to_string(), serde_json::json!(expires));
            }
            checkpoint_problem_response_with(
                StatusCode::CONFLICT,
                "CHECKPOINT_LEASE_HELD",
                Some("LEASE_HELD"),
                "another run holds the workspace mutation lease",
                extra,
            )
        }
        RevertFailure::HeadChanged { recorded, observed } => {
            let mut extra = serde_json::Map::new();
            extra.insert("recorded".to_string(), serde_json::json!(recorded));
            extra.insert("observed".to_string(), serde_json::json!(observed));
            checkpoint_problem_response_with(
                StatusCode::CONFLICT,
                "CHECKPOINT_HEAD_CHANGED",
                None,
                "the workspace HEAD/branch fingerprint changed since the checkpoint base; acknowledge it to revert anyway",
                extra,
            )
        }
        RevertFailure::ConflictsUnacknowledged { paths } => {
            let mut extra = serde_json::Map::new();
            extra.insert("paths".to_string(), serde_json::json!(paths));
            checkpoint_problem_response_with(
                StatusCode::CONFLICT,
                "CHECKPOINT_CONFLICTS_UNACKNOWLEDGED",
                None,
                "conflict paths must be acknowledged from the preview before reverting",
                extra,
            )
        }
        RevertFailure::Unavailable { reason, detail } => checkpoint_problem_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "CHECKPOINT_UNAVAILABLE",
            Some(reason),
            &detail,
        ),
    }
}

async fn revert_preview_handler(
    Path((ws_id, run_id)): Path<(String, String)>,
    State(app): State<Arc<AppState>>,
) -> Response {
    match app.checkpoints.revert_preview(&ws_id, &run_id).await {
        Ok(outcome) => AxumJson(outcome).into_response(),
        Err(failure) => revert_failure_response(failure),
    }
}

#[derive(Debug, Deserialize)]
struct RevertExecuteRequest {
    #[serde(rename = "acknowledgeConflicts", default)]
    acknowledge_conflicts: Vec<String>,
    #[serde(rename = "acknowledgeHeadChange", default)]
    acknowledge_head_change: bool,
}

async fn revert_execute_handler(
    Path((ws_id, run_id)): Path<(String, String)>,
    State(app): State<Arc<AppState>>,
    AxumJson(request): AxumJson<RevertExecuteRequest>,
) -> Response {
    let acks = RevertAcks {
        head_changed: request.acknowledge_head_change,
        conflicts: request.acknowledge_conflicts,
    };
    match app.checkpoints.revert_execute(&ws_id, &run_id, &acks).await {
        Ok(outcome) => AxumJson(outcome).into_response(),
        Err(failure) => revert_failure_response(failure),
    }
}

#[derive(Debug, Deserialize)]
struct CheckpointBlobQuery {
    path: String,
    #[serde(rename = "ref")]
    reference: String,
}

fn blob_failure_response(failure: BlobFailure) -> Response {
    match failure {
        BlobFailure::NotFound { detail } => checkpoint_problem_response(
            StatusCode::NOT_FOUND,
            "CHECKPOINT_NOT_FOUND",
            None,
            &detail,
        ),
        BlobFailure::NotSealed { run_id } => checkpoint_problem_response(
            StatusCode::CONFLICT,
            "CHECKPOINT_NOT_SEALED",
            None,
            &format!("run {run_id} has no end ref; the blob endpoint cannot read it"),
        ),
        BlobFailure::Invalid { detail } => checkpoint_problem_response(
            StatusCode::BAD_REQUEST,
            "CHECKPOINT_INVALID_REQUEST",
            None,
            &detail,
        ),
        BlobFailure::TooLarge { path, size, max } => {
            let mut extra = serde_json::Map::new();
            extra.insert("path".to_string(), serde_json::json!(path));
            extra.insert("size".to_string(), serde_json::json!(size));
            extra.insert("max".to_string(), serde_json::json!(max));
            checkpoint_problem_response_with(
                StatusCode::PAYLOAD_TOO_LARGE,
                "CHECKPOINT_BLOB_TOO_LARGE",
                None,
                &format!("blob {path} exceeds the {max}-byte preview cap"),
                extra,
            )
        }
        BlobFailure::Unavailable { reason, detail } => checkpoint_problem_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "CHECKPOINT_UNAVAILABLE",
            Some(reason),
            &detail,
        ),
    }
}

async fn checkpoint_blob_handler(
    Path((ws_id, run_id)): Path<(String, String)>,
    State(app): State<Arc<AppState>>,
    query: Result<Query<CheckpointBlobQuery>, QueryRejection>,
) -> Response {
    let Ok(Query(query)) = query else {
        return checkpoint_problem_response(
            StatusCode::BAD_REQUEST,
            "CHECKPOINT_INVALID_REQUEST",
            None,
            "blob query requires path and ref=base|end",
        );
    };
    let reference = match query.reference.as_str() {
        "base" => BlobRef::Base,
        "end" => BlobRef::End,
        other => {
            return checkpoint_problem_response(
                StatusCode::BAD_REQUEST,
                "CHECKPOINT_INVALID_REQUEST",
                None,
                &format!("unsupported ref {other:?}; expected base or end"),
            );
        }
    };
    match app
        .checkpoints
        .revert_blob(&ws_id, &run_id, reference, &query.path)
        .await
    {
        Ok(blob) => {
            // Only regular text previews are served: binaries are rejected here so
            // the response is always a valid plain-text document.
            match std::str::from_utf8(&blob.content) {
                Ok(text) if !text.as_bytes().contains(&0) => (
                    StatusCode::OK,
                    [(
                        axum::http::header::CONTENT_TYPE,
                        "text/plain; charset=utf-8",
                    )],
                    text.to_string(),
                )
                    .into_response(),
                _ => checkpoint_problem_response(
                    StatusCode::BAD_REQUEST,
                    "CHECKPOINT_INVALID_REQUEST",
                    None,
                    &format!(
                        "blob {} ({}) is not valid plain text",
                        blob.path, blob.reference
                    ),
                ),
            }
        }
        Err(failure) => blob_failure_response(failure),
    }
}

fn git_status_failure_response(failure: GitStatusFailure) -> Response {
    match failure {
        GitStatusFailure::Validation { detail } => checkpoint_problem_response(
            StatusCode::BAD_REQUEST,
            "CHECKPOINT_INVALID_REQUEST",
            None,
            &detail,
        ),
        GitStatusFailure::Unavailable { reason, detail } => checkpoint_problem_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "CHECKPOINT_UNAVAILABLE",
            Some(reason),
            &detail,
        ),
    }
}

async fn workspace_git_status_handler(
    Path(ws_id): Path<String>,
    State(app): State<Arc<AppState>>,
) -> Response {
    match app.checkpoints.git_status(&ws_id).await {
        Ok(status) => AxumJson(status).into_response(),
        Err(failure) => git_status_failure_response(failure),
    }
}

/// `GET /internal/v1/runtime/diagnostics` — ops projection; carries no secrets
/// and never workspace contents.
async fn runtime_diagnostics_handler(State(app): State<Arc<AppState>>) -> Response {
    let checkpoint = app.checkpoints.diagnostics().await;
    AxumJson(serde_json::json!({
        "deviceId": app.device_id,
        "status": "ok",
        "checkpoint": checkpoint,
    }))
    .into_response()
}

/// Host root for the Run-checkpoint shadow repositories. Mirrors the hydrate
/// contract: `XIHE_WORKSPACE_HOST_ROOT` is the only source; the fallback keeps a
/// misconfigured process from writing to an absolute system path.
fn runtime_checkpoint_host_root() -> PathBuf {
    std::env::var("XIHE_WORKSPACE_HOST_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            tracing::warn!(
                "XIHE_WORKSPACE_HOST_ROOT is not configured; Run checkpoints resolve against ./.xihe-workspaces"
            );
            PathBuf::from(".xihe-workspaces")
        })
}

/// Internal HTTP surface (frozen routes). Kept as one function so the route
/// table is exercised by handler tests without starting a listener.
fn build_app_router(app_state: &Arc<AppState>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/executions/{item_id}/cancel",
            post(cancel_execution_handler),
        )
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
            "/internal/v1/runtime/workspaces/{ws_id}/checkpoints",
            post(create_run_checkpoint_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/checkpoints/gc",
            post(checkpoint_gc_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/checkpoints/{run_id}",
            get(checkpoint_status_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/checkpoints/{run_id}/seal",
            post(seal_run_checkpoint_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/checkpoints/{run_id}/revert/preview",
            post(revert_preview_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/checkpoints/{run_id}/revert",
            post(revert_execute_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/checkpoints/{run_id}/blob",
            get(checkpoint_blob_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/git-status",
            get(workspace_git_status_handler),
        )
        .route(
            "/internal/v1/runtime/diagnostics",
            get(runtime_diagnostics_handler),
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
        .with_state(Arc::clone(app_state))
}

fn main() -> anyhow::Result<()> {
    // PLAN-0307 T3.1/T3.5: config loading (env chain + CLI --set) runs before the
    // Tokio runtime starts so process-env writes stay on the main thread.
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cli_overrides = dotenv_loader::parse_cli_overrides(&args).map_err(anyhow::Error::msg)?;
    dotenv_loader::load(&cli_overrides);
    // PLAN-0307 T3.4: reject dangerous factory defaults in prod (WARN in dev/test).
    xihe_runtime::security_defaults::enforce()?;

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run())
}

async fn run() -> anyhow::Result<()> {
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
    let router = Arc::new(WorkspaceExecutionRouter::new(
        workspace_ensurer.clone(),
        manager.clone(),
        registry.clone(),
    ));
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
        checkpoints: Arc::new(CheckpointService::new(runtime_checkpoint_host_root())),
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
    let channel_client =
        xihe_runtime::channel::ChannelClient::from_env(device_id.clone()).map(Arc::new);
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
    let reaper_router = router.clone();
    let reaper_cp_url =
        std::env::var("XIHE_CP_URL").unwrap_or_else(|_| "http://127.0.0.1:12631".to_string());
    let reaper_api_token =
        std::env::var("XIHE_CP_API_TOKEN").unwrap_or_else(|_| "dev-token-not-secure".to_string());
    let reaper_ct = ct.child_token();
    tokio::spawn(async move {
        idle_reaper_loop(
            reaper_registry,
            reaper_manager,
            reaper_router,
            reaper_cp_url,
            reaper_api_token,
            reaper_ct,
        )
        .await;
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
        heartbeat::heartbeat_loop(
            hb_ready,
            hb_cp_url,
            hb_api_token,
            hb_device_id,
            hb_ct,
            channel_client,
        )
        .await;
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
            let runtime =
                XiheRuntime::new(&ws_id, &instance.workspace_path, profile, router.clone());
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

    let router = build_app_router(&app_state);

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
                    // CHN-2: a failed poll must never be mistaken for "no servers
                    // configured". On error, skip this workspace's reconcile entirely
                    // and keep the currently running bridges untouched.
                    let (generation, hash, servers) = match manager
                        .poll_config_with_generation(ws_id, &cp_url, &cp_api_token)
                        .await
                    {
                        Ok(polled) => polled,
                        Err(error) => {
                            tracing::warn!(
                                "config poll: stdio-servers fetch failed for {ws_id}: {error}; keeping current bridges"
                            );
                            continue;
                        }
                    };
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

/// Job cleanup cadence: the idle reaper ticks every minute; job-file cleanup
/// runs on the first tick and then every 5th (PLAN-0317 decision #3, J-1).
const JOB_CLEANUP_EVERY_TICKS: u64 = 5;

/// PLAN-0317 T2.9（决策 #14）：把追偿确认的迟到终止回报给 CP——CP 只追加
/// `item.terminated.late` 事件，不回改 item 终态。
async fn report_late_termination(
    cp_url: &str,
    api_token: &str,
    late: &xihe_runtime::executor::LateTermination,
) {
    let url = format!(
        "{cp_url}/internal/v1/operations/items/{}/late-termination",
        late.item_id
    );
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
    else {
        tracing::warn!(item_id = %late.item_id, "late-termination: HTTP client build failed");
        return;
    };
    match client
        .post(&url)
        .bearer_auth(api_token)
        .json(&serde_json::json!({"confirmed": late.confirmed}))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => {
            tracing::info!(
                item_id = %late.item_id,
                workspace_id = %late.workspace_id,
                "late-termination reported to CP"
            );
        }
        Ok(response) => {
            tracing::warn!(
                item_id = %late.item_id,
                status = %response.status(),
                "late-termination report rejected by CP"
            );
        }
        Err(error) => {
            tracing::warn!(
                item_id = %late.item_id,
                error = %error,
                "late-termination report failed"
            );
        }
    }
}

fn should_cleanup_jobs(ticks: u64) -> bool {
    ticks == 1 || ticks.is_multiple_of(JOB_CLEANUP_EVERY_TICKS)
}

async fn idle_reaper_loop(
    registry: Arc<WorkspaceRegistry>,
    manager: Arc<Mutex<WorkspaceManager>>,
    router: Arc<WorkspaceExecutionRouter>,
    cp_url: String,
    api_token: String,
    ct: tokio_util::sync::CancellationToken,
) {
    let mut ticker = interval(Duration::from_secs(60));
    let mut ticks: u64 = 0;

    loop {
        tokio::select! {
            _ = ct.cancelled() => {
                tracing::info!("Idle reaper cancelled");
                break;
            }
            _ = ticker.tick() => {
                ticks += 1;
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

                // J-1 (PLAN-0317 T1.1): reclaim expired job files inside
                // already-active containers only. `cleanup_jobs` deliberately
                // skips materialization and the activity timestamp, so this
                // maintenance pass cannot start or keep alive an idle
                // workspace.
                if should_cleanup_jobs(ticks) {
                    for instance in &instances {
                        if instance.state != InstanceState::Active {
                            continue;
                        }
                        match router.cleanup_jobs(&instance.ws_id).await {
                            Ok(value) => {
                                let cleaned = value
                                    .get("cleaned")
                                    .and_then(|v| v.as_u64())
                                    .unwrap_or(0);
                                if cleaned > 0 {
                                    tracing::info!(
                                        workspace_id = %instance.ws_id,
                                        cleaned,
                                        "job cleanup reclaimed expired jobs"
                                    );
                                }
                            }
                            Err(e) => {
                                tracing::debug!(
                                    workspace_id = %instance.ws_id,
                                    error = %e,
                                    "job cleanup skipped"
                                );
                            }
                        }
                    }
                }

                // PLAN-0317 T2.9（决策 #14）：追偿未确认终止的执行；确认结束
                // 后回调 CP 追加 item.terminated.late（账本不改终态）。
                for late in router.retry_unconfirmed_terminations().await {
                    report_late_termination(&cp_url, &api_token, &late).await;
                }
            }
        }
    }
}

#[cfg(test)]
mod cancel_endpoint_tests {
    use super::{ExecutionEnd, cancel_status};
    use axum::extract::{Path, State};
    use axum::http::StatusCode;

    #[test]
    fn cancel_status_maps_every_outcome() {
        assert_eq!(
            cancel_status(Some(ExecutionEnd::Cancelled { confirmed: true })),
            ("cancelled", true)
        );
        assert_eq!(
            cancel_status(Some(ExecutionEnd::Cancelled { confirmed: false })),
            ("unconfirmed", false)
        );
        assert_eq!(
            cancel_status(Some(ExecutionEnd::Completed)),
            ("already_finished", false),
            "a naturally finished execution must not be reported as cancelled"
        );
        assert_eq!(cancel_status(None), ("unconfirmed", false));
    }

    /// PLAN-0317 T2.3：端点级证据（无需 Docker）——未知 item 返回 404；
    /// 已登记执行触发后由执行侧回报确认，端点返回 cancelled/confirmed。
    #[tokio::test]
    async fn cancel_endpoint_returns_404_for_unknown_and_cancelled_for_registered() {
        let state = super::remote_handler_tests::test_state("http://127.0.0.1:1").await;

        let unknown = super::cancel_execution_handler(
            State(state.clone()),
            Path(("ws-1".to_string(), "missing".to_string())),
        )
        .await;
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);

        let registration = state.router.in_flight().register("ws-1", "item-1");
        let reporter = registration.outcome.clone();
        tokio::spawn(async move {
            registration.token.cancelled().await;
            let _ = reporter.send(Some(ExecutionEnd::Cancelled { confirmed: true }));
        });

        let cancelled = super::cancel_execution_handler(
            State(state.clone()),
            Path(("ws-1".to_string(), "item-1".to_string())),
        )
        .await;
        assert_eq!(cancelled.status(), StatusCode::OK);
        let body = axum::body::to_bytes(cancelled.into_body(), usize::MAX)
            .await
            .expect("read cancel body");
        let json: serde_json::Value = serde_json::from_slice(&body).expect("cancel JSON");
        assert_eq!(json["status"], "cancelled");
        assert_eq!(json["confirmed"], true);

        // Cross-workspace attempts must not find the execution (spec S1.6).
        let cross = super::cancel_execution_handler(
            State(state),
            Path(("ws-2".to_string(), "item-1".to_string())),
        )
        .await;
        assert_eq!(cross.status(), StatusCode::NOT_FOUND);
    }
}

#[cfg(test)]
mod reaper_tests {
    use super::should_cleanup_jobs;

    #[test]
    fn job_cleanup_runs_on_first_tick_and_every_five() {
        assert!(should_cleanup_jobs(1), "startup tick must attempt cleanup");
        assert!(!should_cleanup_jobs(2));
        assert!(!should_cleanup_jobs(4));
        assert!(should_cleanup_jobs(5));
        assert!(!should_cleanup_jobs(6));
        assert!(should_cleanup_jobs(10));
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
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind cp stub");
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
            let id = payload
                .get("id")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
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
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake mcp");
        let addr = listener.local_addr().expect("fake mcp addr").to_string();
        let app = Router::new().fallback(any(handler));
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve fake mcp");
        });
        format!("http://{addr}/mcp")
    }

    pub(super) async fn test_state(cp_url: &str) -> Arc<AppState> {
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
            // Checkpoint tests replace this with a tempdir-scoped service; other
            // tests never touch the host root.
            checkpoints: Arc::new(CheckpointService::new(std::env::temp_dir())),
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

#[cfg(test)]
mod checkpoint_handler_tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use axum::http::{Method, Request};
    use tempfile::TempDir;
    use xihe_runtime::checkpoint_api::CheckpointService;

    const WS: &str = "ws-checkpoint";
    const AUTH: &str = "Bearer dev-token-not-secure";
    const DIAGNOSTICS_URI: &str = "/internal/v1/runtime/diagnostics";

    async fn state_with(service: CheckpointService) -> Arc<AppState> {
        let base = super::remote_handler_tests::test_state("http://127.0.0.1:1").await;
        let mut state = (*base).clone();
        state.checkpoints = Arc::new(service);
        Arc::new(state)
    }

    fn workspace_root() -> TempDir {
        let temp = TempDir::new().expect("fixture tempdir");
        std::fs::create_dir_all(temp.path().join(WS)).expect("fixture workspace");
        temp
    }

    async fn send_with_auth(
        state: &Arc<AppState>,
        method: Method,
        uri: &str,
        body: Option<serde_json::Value>,
        auth: Option<&str>,
    ) -> (StatusCode, serde_json::Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(auth) = auth {
            builder = builder.header(axum::http::header::AUTHORIZATION, auth);
        }
        let request = match body {
            Some(value) => builder
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .body(Body::from(value.to_string()))
                .expect("request"),
            None => builder.body(Body::empty()).expect("request"),
        };
        let response = tower::ServiceExt::oneshot(build_app_router(state), request)
            .await
            .expect("infallible router");
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        let json = if bytes.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&bytes).expect("JSON response body")
        };
        (status, json)
    }

    async fn send(
        state: &Arc<AppState>,
        method: Method,
        uri: &str,
        body: Option<serde_json::Value>,
    ) -> (StatusCode, serde_json::Value) {
        send_with_auth(state, method, uri, body, Some(AUTH)).await
    }

    async fn create_checkpoint(
        state: &Arc<AppState>,
        workspace: &str,
        run_id: &str,
    ) -> (StatusCode, serde_json::Value) {
        send(
            state,
            Method::POST,
            &format!("/internal/v1/runtime/workspaces/{workspace}/checkpoints"),
            Some(serde_json::json!({"runId": run_id, "actor": "tester", "callId": "call-1"})),
        )
        .await
    }

    async fn seal_checkpoint(
        state: &Arc<AppState>,
        workspace: &str,
        run_id: &str,
    ) -> (StatusCode, serde_json::Value) {
        send(
            state,
            Method::POST,
            &format!("/internal/v1/runtime/workspaces/{workspace}/checkpoints/{run_id}/seal"),
            None,
        )
        .await
    }

    async fn require_git(service: &CheckpointService) -> bool {
        let diagnostics = service.diagnostics().await;
        if !diagnostics.capable {
            eprintln!(
                "checkpoint handler test skipped: host git unavailable ({:?})",
                diagnostics.git_version
            );
        }
        diagnostics.capable
    }

    /// Frozen create contract: 200 `{checkpointId, runId, state: base, baseRef,
    /// createdAt}` and an idempotent replay per runId.
    #[tokio::test]
    async fn checkpoint_create_returns_base_shape_and_is_idempotent() {
        let temp = workspace_root();
        let service = CheckpointService::new(temp.path());
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;

        let (status, body) = create_checkpoint(&state, WS, "run-1").await;
        assert_eq!(status, StatusCode::OK, "create must return 200: {body}");
        assert_eq!(body["state"], "base");
        assert_eq!(body["runId"], "run-1");
        assert_eq!(body["baseRef"], "refs/xihe/run-1/base");
        let checkpoint_id = body["checkpointId"]
            .as_str()
            .expect("checkpointId is a string")
            .to_string();
        assert!(
            uuid::Uuid::parse_str(&checkpoint_id).is_ok(),
            "checkpointId must be a UUID (CP parses it): {checkpoint_id}"
        );
        let created_at = body["createdAt"].as_str().expect("createdAt is a string");
        assert!(
            created_at.ends_with('Z') && chrono::DateTime::parse_from_rfc3339(created_at).is_ok(),
            "createdAt must be RFC3339 UTC (CP Instant.parse): {created_at}"
        );

        let (replay_status, replay) = create_checkpoint(&state, WS, "run-1").await;
        assert_eq!(replay_status, StatusCode::OK);
        assert_eq!(
            replay["checkpointId"], checkpoint_id,
            "idempotent replay must return the same checkpointId"
        );
        assert_eq!(replay["baseRef"], body["baseRef"]);
        assert_eq!(replay["createdAt"], body["createdAt"]);
    }

    /// Another run holding the workspace lease → 409 CHECKPOINT_LEASE_HELD;
    /// the owning run may re-enter idempotently.
    #[tokio::test]
    async fn checkpoint_create_conflicts_with_a_held_lease() {
        let temp = workspace_root();
        let service = CheckpointService::new(temp.path());
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;
        let (first, _) = create_checkpoint(&state, WS, "run-1").await;
        assert_eq!(first, StatusCode::OK);

        let (status, body) = create_checkpoint(&state, WS, "run-2").await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["code"], "CHECKPOINT_LEASE_HELD");
        assert_eq!(body["reason"], "LEASE_HELD");
        assert_eq!(body["heldByRunId"], "run-1");
        assert!(body["expiresAtMs"].as_u64().unwrap_or(0) > 0);
        assert!(!body["requestId"].as_str().unwrap_or("").is_empty());

        let (owner, _) = create_checkpoint(&state, WS, "run-1").await;
        assert_eq!(
            owner,
            StatusCode::OK,
            "the owning run re-enters idempotently"
        );
    }

    /// An expired lease is reclaimable; the reclaimed workspace then rejects the
    /// previous run.
    #[tokio::test]
    async fn checkpoint_lease_is_reclaimable_after_ttl() {
        let temp = workspace_root();
        // Real TTL seconds (not milliseconds): the reclaiming create does real git
        // work, so the new lease must not expire while the test runs.
        let service = CheckpointService::new(temp.path()).with_lease_ttl(Duration::from_secs(2));
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;
        let (first, _) = create_checkpoint(&state, WS, "run-old").await;
        assert_eq!(first, StatusCode::OK);

        tokio::time::sleep(Duration::from_millis(2300)).await;
        let (reclaimed, body) = create_checkpoint(&state, WS, "run-new").await;
        assert_eq!(
            reclaimed,
            StatusCode::OK,
            "expired lease must be reclaimable: {body}"
        );

        let (blocked, conflict) = create_checkpoint(&state, WS, "run-old").await;
        assert_eq!(blocked, StatusCode::CONFLICT);
        assert_eq!(conflict["heldByRunId"], "run-new");
    }

    /// Seal releases the lease (for that run only) and an idempotent reseal
    /// returns the identical body.
    #[tokio::test]
    async fn checkpoint_seal_releases_the_lease_and_reseals_identically() {
        let temp = workspace_root();
        let service = CheckpointService::new(temp.path());
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;
        assert_eq!(
            create_checkpoint(&state, WS, "run-1").await.0,
            StatusCode::OK
        );

        let (status, sealed) = seal_checkpoint(&state, WS, "run-1").await;
        assert_eq!(status, StatusCode::OK, "seal must return 200: {sealed}");
        assert_eq!(sealed["runId"], "run-1");
        assert_eq!(sealed["state"], "sealed");
        assert_eq!(sealed["endRef"], "refs/xihe/run-1/end");
        assert_eq!(sealed["sealedWithLiveJobs"], false);
        assert_eq!(sealed["sealedAfterAbnormal"], false);

        let (reseal_status, resealed) = seal_checkpoint(&state, WS, "run-1").await;
        assert_eq!(reseal_status, StatusCode::OK);
        assert_eq!(
            resealed, sealed,
            "idempotent reseal must return the same result"
        );

        let (next, body) = create_checkpoint(&state, WS, "run-2").await;
        assert_eq!(next, StatusCode::OK, "seal must release the lease: {body}");
    }

    /// The W2 integration flow through the real HTTP surface: create → write →
    /// seal returns the changed file; status reports it afterwards.
    #[tokio::test]
    async fn checkpoint_seal_reports_the_changed_file_after_write() {
        let temp = workspace_root();
        let service = CheckpointService::new(temp.path());
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;
        assert_eq!(
            create_checkpoint(&state, WS, "run-write").await.0,
            StatusCode::OK
        );

        let target = temp.path().join(WS).join("src").join("new.txt");
        std::fs::create_dir_all(target.parent().expect("parent")).expect("fixture dirs");
        std::fs::write(&target, "created during the run\n").expect("fixture write");

        let (status, sealed) = seal_checkpoint(&state, WS, "run-write").await;
        assert_eq!(status, StatusCode::OK, "seal must return 200: {sealed}");
        assert_eq!(
            sealed["changedFiles"],
            serde_json::json!([{"status": "A", "path": "src/new.txt"}]),
            "the sealed change set must contain exactly the written file"
        );

        let (status_status, status_body) = send(
            &state,
            Method::GET,
            &format!("/internal/v1/runtime/workspaces/{WS}/checkpoints/run-write"),
            None,
        )
        .await;
        assert_eq!(status_status, StatusCode::OK);
        assert_eq!(status_body["state"], "sealed");
        assert_eq!(
            status_body["changedFiles"],
            serde_json::json!([{"status": "A", "path": "src/new.txt"}])
        );
        assert!(status_body["endCommit"].as_str().is_some());
    }

    /// Status contract: `base` before seal, `sealed` after, 404 for an unknown run.
    #[tokio::test]
    async fn checkpoint_status_reports_base_then_sealed_and_404() {
        let temp = workspace_root();
        let service = CheckpointService::new(temp.path());
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;
        let uri = format!("/internal/v1/runtime/workspaces/{WS}/checkpoints/run-status");
        let missing = format!("/internal/v1/runtime/workspaces/{WS}/checkpoints/run-missing");

        let (not_found, body) = send(&state, Method::GET, &missing, None).await;
        assert_eq!(not_found, StatusCode::NOT_FOUND);
        assert_eq!(body["code"], "CHECKPOINT_NOT_FOUND");

        assert_eq!(
            create_checkpoint(&state, WS, "run-status").await.0,
            StatusCode::OK
        );
        let (base_status, base_body) = send(&state, Method::GET, &uri, None).await;
        assert_eq!(base_status, StatusCode::OK);
        assert_eq!(base_body["state"], "base");
        assert!(base_body["baseRef"].as_str().is_some());
        assert!(base_body["endRef"].is_null());
        assert_eq!(base_body["changedFiles"], serde_json::json!([]));

        assert_eq!(
            seal_checkpoint(&state, WS, "run-status").await.0,
            StatusCode::OK
        );
        let (sealed_status, sealed_body) = send(&state, Method::GET, &uri, None).await;
        assert_eq!(sealed_status, StatusCode::OK);
        assert_eq!(sealed_body["state"], "sealed");
        assert!(sealed_body["endRef"].as_str().is_some());
        assert_eq!(sealed_body["changedFiles"], serde_json::json!([]));
    }

    /// Seal of an unknown run → 404; malformed run ids never reach git.
    #[tokio::test]
    async fn checkpoint_seal_unknown_or_invalid_run_returns_404() {
        let temp = workspace_root();
        let service = CheckpointService::new(temp.path());
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;

        let (status, body) = seal_checkpoint(&state, WS, "run-missing").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["code"], "CHECKPOINT_NOT_FOUND");

        let (invalid_status, invalid) = seal_checkpoint(&state, WS, "run.").await;
        assert_eq!(invalid_status, StatusCode::NOT_FOUND, "{invalid}");
    }

    /// Probe failure (no host git) → 503 CHECKPOINT_UNAVAILABLE / GIT_UNAVAILABLE,
    /// and diagnostics exposes the degradation.
    #[tokio::test]
    async fn checkpoint_probe_failure_returns_503_git_unavailable() {
        let temp = workspace_root();
        let service =
            CheckpointService::new(temp.path()).with_git_binary("xihe-runtime-missing-git-binary");
        let state = state_with(service).await;

        let (status, body) = create_checkpoint(&state, WS, "run-1").await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["code"], "CHECKPOINT_UNAVAILABLE");
        assert_eq!(body["reason"], "GIT_UNAVAILABLE");
        assert!(!body["detail"].as_str().unwrap_or("").is_empty());

        let (diag_status, diagnostics) = send(&state, Method::GET, DIAGNOSTICS_URI, None).await;
        assert_eq!(diag_status, StatusCode::OK);
        assert_eq!(diagnostics["checkpoint"]["capable"], false);
        assert!(diagnostics["checkpoint"]["gitVersion"].is_null());
    }

    /// A workspace directory that does not exist → 503 WORKSPACE_UNKNOWN.
    #[tokio::test]
    async fn checkpoint_create_unknown_workspace_returns_503_workspace_unknown() {
        let temp = TempDir::new().expect("fixture tempdir");
        let service = CheckpointService::new(temp.path());
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;

        let (status, body) = create_checkpoint(&state, WS, "run-1").await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["code"], "CHECKPOINT_UNAVAILABLE");
        assert_eq!(body["reason"], "WORKSPACE_UNKNOWN");
    }

    /// GC contract: retention config is honored, unsealed runs survive, and the
    /// response carries both the frozen top-level names and the CP `counts`.
    #[tokio::test]
    async fn checkpoint_gc_endpoint_returns_retention_counts() {
        let temp = workspace_root();
        let service = CheckpointService::new(temp.path())
            .with_retention(1, 30)
            .with_auto_gc(false);
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;
        for run_id in ["run-01", "run-02", "run-03"] {
            assert_eq!(
                create_checkpoint(&state, WS, run_id).await.0,
                StatusCode::OK
            );
            assert_eq!(seal_checkpoint(&state, WS, run_id).await.0, StatusCode::OK);
        }
        assert_eq!(
            create_checkpoint(&state, WS, "run-unsealed").await.0,
            StatusCode::OK
        );

        let (status, body) = send(
            &state,
            Method::POST,
            &format!("/internal/v1/runtime/workspaces/{WS}/checkpoints/gc"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "gc must return 200: {body}");
        assert_eq!(
            body["deletedRuns"],
            serde_json::json!(["run-01", "run-02"]),
            "count-based retention deletes sealed runs oldest-first"
        );
        assert_eq!(body["keptRuns"], 2, "one sealed + one unsealed run survive");
        assert_eq!(body["counts"]["deletedRuns"], 2);
        assert_eq!(body["counts"]["keptSealed"], 1);
        assert_eq!(body["counts"]["keptUnsealed"], 1);
        assert_eq!(body["counts"]["gcRan"], true);
    }

    /// Diagnostics shape: git capability, shadow root and the active lease set,
    /// all without secrets.
    #[tokio::test]
    async fn checkpoint_diagnostics_reports_git_leases_and_shadow_root() {
        let temp = workspace_root();
        let service = CheckpointService::new(temp.path());
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;
        assert_eq!(
            create_checkpoint(&state, WS, "run-1").await.0,
            StatusCode::OK
        );

        let (status, body) = send(&state, Method::GET, DIAGNOSTICS_URI, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ok");
        let checkpoint = &body["checkpoint"];
        assert_eq!(checkpoint["capable"], true);
        assert!(
            checkpoint["gitVersion"]
                .as_str()
                .is_some_and(|value| value.starts_with("git version")),
            "gitVersion must be the probed version string: {checkpoint}"
        );
        assert!(
            checkpoint["shadowRoot"]
                .as_str()
                .is_some_and(|value| value.ends_with("/.xihe-shadow")),
            "shadowRoot must point at the shadow directory: {checkpoint}"
        );
        assert_eq!(checkpoint["activeLeaseWorkspaces"], serde_json::json!([WS]));

        assert_eq!(seal_checkpoint(&state, WS, "run-1").await.0, StatusCode::OK);
        let (_, after_seal) = send(&state, Method::GET, DIAGNOSTICS_URI, None).await;
        assert_eq!(
            after_seal["checkpoint"]["activeLeaseWorkspaces"],
            serde_json::json!([]),
            "seal must release the lease"
        );
    }

    /// In-flight executions of the workspace are recorded as live jobs at seal.
    #[tokio::test]
    async fn checkpoint_seal_records_live_jobs() {
        let temp = workspace_root();
        let service = CheckpointService::new(temp.path());
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;
        assert_eq!(
            create_checkpoint(&state, WS, "run-1").await.0,
            StatusCode::OK
        );
        let _registration = state.router.in_flight().register(WS, "item-live");

        let (status, sealed) = seal_checkpoint(&state, WS, "run-1").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(sealed["sealedWithLiveJobs"], true);

        let (preview_status, preview) = revert_preview(&state, WS, "run-1").await;
        assert_eq!(preview_status, StatusCode::OK, "{preview}");
        assert_eq!(
            preview["sealedWithLiveJobs"], true,
            "the preview must carry the seal marker: {preview}"
        );
    }

    /// Malformed identifiers → 400 before any git work.
    #[tokio::test]
    async fn checkpoint_validation_rejects_unsafe_identifiers() {
        let temp = workspace_root();
        let state = state_with(CheckpointService::new(temp.path())).await;

        let (status, body) = create_checkpoint(&state, WS, "../evil").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], "CHECKPOINT_INVALID_REQUEST");

        let (ws_status, ws_body) = create_checkpoint(&state, "bad.id", "run-1").await;
        assert_eq!(ws_status, StatusCode::BAD_REQUEST, "{ws_body}");

        let (gc_status, gc_body) = send(
            &state,
            Method::POST,
            "/internal/v1/runtime/workspaces/bad.id/checkpoints/gc",
            None,
        )
        .await;
        assert_eq!(gc_status, StatusCode::BAD_REQUEST, "{gc_body}");
    }

    /// The checkpoint routes stay behind the internal service bearer filter.
    #[tokio::test]
    async fn checkpoint_routes_require_service_auth() {
        let temp = workspace_root();
        let state = state_with(CheckpointService::new(temp.path())).await;

        let (status, body) = send_with_auth(
            &state,
            Method::POST,
            &format!("/internal/v1/runtime/workspaces/{WS}/checkpoints"),
            Some(serde_json::json!({"runId": "run-1"})),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["code"], "AUTHORIZATION_REQUIRED");

        let (diag_status, _) =
            send_with_auth(&state, Method::GET, DIAGNOSTICS_URI, None, None).await;
        assert_eq!(diag_status, StatusCode::UNAUTHORIZED);
    }

    // ---- PLAN-0328 M3 W1b: revert / blob / git-status handler tests ----

    async fn send_text(state: &Arc<AppState>, uri: &str) -> (StatusCode, Option<String>, String) {
        let request = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .header(axum::http::header::AUTHORIZATION, AUTH)
            .body(Body::empty())
            .expect("request");
        let response = tower::ServiceExt::oneshot(build_app_router(state), request)
            .await
            .expect("infallible router");
        let status = response.status();
        let content_type = response
            .headers()
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        (
            status,
            content_type,
            String::from_utf8_lossy(&bytes).into_owned(),
        )
    }

    async fn revert_preview(
        state: &Arc<AppState>,
        workspace: &str,
        run_id: &str,
    ) -> (StatusCode, serde_json::Value) {
        send(
            state,
            Method::POST,
            &format!(
                "/internal/v1/runtime/workspaces/{workspace}/checkpoints/{run_id}/revert/preview"
            ),
            None,
        )
        .await
    }

    async fn revert_execute(
        state: &Arc<AppState>,
        workspace: &str,
        run_id: &str,
        body: serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        send(
            state,
            Method::POST,
            &format!("/internal/v1/runtime/workspaces/{workspace}/checkpoints/{run_id}/revert"),
            Some(body),
        )
        .await
    }

    fn null_device() -> &'static str {
        #[cfg(windows)]
        {
            "NUL"
        }
        #[cfg(not(windows))]
        {
            "/dev/null"
        }
    }

    fn git_in(dir: &std::path::Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", null_device())
            .env("GIT_CONFIG_SYSTEM", null_device())
            .env("GIT_AUTHOR_NAME", "handler-test")
            .env("GIT_AUTHOR_EMAIL", "handler-test@example.com")
            .env("GIT_COMMITTER_NAME", "handler-test")
            .env("GIT_COMMITTER_EMAIL", "handler-test@example.com")
            .output()
            .expect("spawn fixture git");
        assert!(
            output.status.success(),
            "git {args:?} failed in {}: {}",
            dir.display(),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// Happy path: create → write → seal → preview → execute deletes the run-created
    /// file and restores the modified one; a repeated execute is all-noop.
    #[tokio::test]
    async fn revert_preview_and_execute_revert_the_run_and_replay_all_noop() {
        let temp = workspace_root();
        std::fs::write(temp.path().join(WS).join("notes.md"), "before\n").expect("fixture notes");
        let service = CheckpointService::new(temp.path());
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;
        assert_eq!(
            create_checkpoint(&state, WS, "run-revert").await.0,
            StatusCode::OK
        );
        std::fs::create_dir_all(temp.path().join(WS).join("src")).expect("fixture dirs");
        std::fs::write(
            temp.path().join(WS).join("src/new.txt"),
            "created during the run\n",
        )
        .expect("fixture write");
        std::fs::write(temp.path().join(WS).join("notes.md"), "after\n").expect("fixture modify");
        assert_eq!(
            seal_checkpoint(&state, WS, "run-revert").await.0,
            StatusCode::OK
        );

        let (status, preview) = revert_preview(&state, WS, "run-revert").await;
        assert_eq!(status, StatusCode::OK, "preview must return 200: {preview}");
        assert_eq!(preview["runId"], "run-revert");
        assert_eq!(preview["state"], "sealed");
        assert_eq!(
            preview["counts"],
            serde_json::json!({"restore": 1, "delete": 1, "skipConflicts": 0, "noop": 0}),
            "preview counts must match the sealed change set: {preview}"
        );
        let entries = preview["entries"].as_array().expect("entries array");
        assert_eq!(
            entries.len(),
            2,
            "pending entries only (noop items are counted, not listed): {preview}"
        );
        assert_eq!(entries[0]["path"], "notes.md");
        assert_eq!(entries[0]["action"], "restore");
        assert!(entries[0]["conflictReason"].is_null());
        assert_eq!(entries[1]["path"], "src/new.txt");
        assert_eq!(entries[1]["action"], "delete");
        assert_eq!(
            preview["headFingerprint"]["status"], "not_repo",
            "a non-Git workspace has no HEAD to protect: {preview}"
        );
        assert_eq!(preview["sealedWithLiveJobs"], false);
        assert_eq!(preview["truncated"], false);

        let (status, executed) = revert_execute(
            &state,
            WS,
            "run-revert",
            serde_json::json!({"acknowledgeConflicts": [], "acknowledgeHeadChange": false}),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "execute must return 200: {executed}"
        );
        assert_eq!(
            executed["counts"],
            serde_json::json!({
                "restored": 1, "deleted": 1, "skippedConflict": 0, "failed": 0, "noop": 0
            }),
            "execute counts must match the preview: {executed}"
        );
        let revert_ref = executed["revertRef"].as_str().expect("revertRef string");
        assert!(
            revert_ref.starts_with("refs/xihe/run-revert/rollback/"),
            "revert must append its audit ref: {revert_ref}"
        );
        assert!(executed["durationMs"].as_u64().is_some());
        let results: Vec<(&str, &str)> = executed["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .map(|entry| {
                (
                    entry["path"].as_str().expect("path"),
                    entry["result"].as_str().expect("result"),
                )
            })
            .collect();
        assert_eq!(
            results,
            vec![("notes.md", "restored"), ("src/new.txt", "deleted")]
        );

        let ws_root = temp.path().join(WS);
        assert_eq!(
            std::fs::read_to_string(ws_root.join("notes.md")).expect("notes read"),
            "before\n",
            "the modified file must be restored to the base content"
        );
        assert!(
            !ws_root.join("src/new.txt").exists(),
            "the run-created file must be deleted"
        );
        assert!(
            !ws_root.join("src").exists(),
            "empty directories left by the revert must be pruned"
        );

        let (replay_status, replayed) = revert_execute(
            &state,
            WS,
            "run-revert",
            serde_json::json!({"acknowledgeConflicts": [], "acknowledgeHeadChange": false}),
        )
        .await;
        assert_eq!(replay_status, StatusCode::OK, "{replayed}");
        assert_eq!(
            replayed["counts"],
            serde_json::json!({
                "restored": 0, "deleted": 0, "skippedConflict": 0, "failed": 0, "noop": 2
            }),
            "a repeated execute must be idempotent: {replayed}"
        );
        assert!(
            replayed["entries"]
                .as_array()
                .expect("entries")
                .iter()
                .all(|entry| entry["result"] == "noop"),
            "every item of a repeated execute is noop: {replayed}"
        );
        assert_ne!(
            replayed["revertRef"], executed["revertRef"],
            "each execution appends its own rollback ref"
        );
    }

    /// Unknown runs → 404; an existing but unsealed run → 409 CHECKPOINT_NOT_SEALED.
    #[tokio::test]
    async fn revert_unknown_and_unsealed_runs_map_404_and_409() {
        let temp = workspace_root();
        let service = CheckpointService::new(temp.path());
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;

        let (preview_status, preview) = revert_preview(&state, WS, "run-missing").await;
        assert_eq!(preview_status, StatusCode::NOT_FOUND);
        assert_eq!(preview["code"], "CHECKPOINT_NOT_FOUND");
        let (execute_status, execute) = revert_execute(
            &state,
            WS,
            "run-missing",
            serde_json::json!({"acknowledgeConflicts": [], "acknowledgeHeadChange": false}),
        )
        .await;
        assert_eq!(execute_status, StatusCode::NOT_FOUND);
        assert_eq!(execute["code"], "CHECKPOINT_NOT_FOUND");

        assert_eq!(
            create_checkpoint(&state, WS, "run-open").await.0,
            StatusCode::OK
        );
        let (open_preview, open_body) = revert_preview(&state, WS, "run-open").await;
        assert_eq!(open_preview, StatusCode::CONFLICT, "{open_body}");
        assert_eq!(open_body["code"], "CHECKPOINT_NOT_SEALED");
        // Executing while the run itself is still live is rejected by the mutation
        // lease first (a running run may not be reverted).
        let (open_execute, open_execute_body) = revert_execute(
            &state,
            WS,
            "run-open",
            serde_json::json!({"acknowledgeConflicts": [], "acknowledgeHeadChange": false}),
        )
        .await;
        assert_eq!(open_execute, StatusCode::CONFLICT, "{open_execute_body}");
        assert_eq!(open_execute_body["code"], "CHECKPOINT_LEASE_HELD");
        assert_eq!(open_execute_body["heldByRunId"], "run-open");

        // Unsealed with an expired lease (Runtime-restart recovery window): the
        // execution reaches the engine and reports the missing seal.
        let stale_temp = workspace_root();
        let stale_service =
            CheckpointService::new(stale_temp.path()).with_lease_ttl(Duration::from_millis(500));
        if !require_git(&stale_service).await {
            return;
        }
        let stale_state = state_with(stale_service).await;
        assert_eq!(
            create_checkpoint(&stale_state, WS, "run-stale").await.0,
            StatusCode::OK
        );
        tokio::time::sleep(Duration::from_millis(700)).await;
        let (stale_status, stale_body) = revert_execute(
            &stale_state,
            WS,
            "run-stale",
            serde_json::json!({"acknowledgeConflicts": [], "acknowledgeHeadChange": false}),
        )
        .await;
        assert_eq!(stale_status, StatusCode::CONFLICT, "{stale_body}");
        assert_eq!(stale_body["code"], "CHECKPOINT_NOT_SEALED");

        let (invalid, invalid_body) = revert_preview(&state, WS, "run.").await;
        assert_eq!(invalid, StatusCode::NOT_FOUND, "{invalid_body}");
        let (invalid_execute, invalid_execute_body) = revert_execute(
            &state,
            WS,
            "run.",
            serde_json::json!({"acknowledgeConflicts": [], "acknowledgeHeadChange": false}),
        )
        .await;
        assert_eq!(
            invalid_execute,
            StatusCode::NOT_FOUND,
            "{invalid_execute_body}"
        );
    }

    /// Probe failure (no host git) and a missing workspace directory → 503 with the
    /// frozen reason codes.
    #[tokio::test]
    async fn revert_probe_and_workspace_failures_map_503() {
        let temp = workspace_root();
        let service =
            CheckpointService::new(temp.path()).with_git_binary("xihe-runtime-missing-git-binary");
        let state = state_with(service).await;

        let (status, body) = revert_preview(&state, WS, "run-1").await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["code"], "CHECKPOINT_UNAVAILABLE");
        assert_eq!(body["reason"], "GIT_UNAVAILABLE");

        let missing = TempDir::new().expect("fixture tempdir");
        let missing_state = state_with(CheckpointService::new(missing.path())).await;
        let (ws_status, ws_body) = revert_preview(&missing_state, WS, "run-1").await;
        assert_eq!(ws_status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(ws_body["code"], "CHECKPOINT_UNAVAILABLE");
        assert_eq!(ws_body["reason"], "WORKSPACE_UNKNOWN");
    }

    /// A live (unsealed) run holds the workspace mutation lease: the revert is
    /// rejected with 409 CHECKPOINT_LEASE_HELD and the synthetic owner is released
    /// on every path (the workspace becomes acquirable again).
    #[tokio::test]
    async fn revert_execute_is_rejected_while_a_live_run_holds_the_workspace_lease() {
        let temp = workspace_root();
        std::fs::write(temp.path().join(WS).join("notes.md"), "before\n").expect("fixture notes");
        let service = CheckpointService::new(temp.path());
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;
        assert_eq!(
            create_checkpoint(&state, WS, "run-1").await.0,
            StatusCode::OK
        );
        std::fs::write(temp.path().join(WS).join("notes.md"), "after\n").expect("fixture modify");
        assert_eq!(seal_checkpoint(&state, WS, "run-1").await.0, StatusCode::OK);

        // A second run holds the workspace mutation lease while it is live.
        assert_eq!(
            create_checkpoint(&state, WS, "run-2").await.0,
            StatusCode::OK
        );
        let (status, body) = revert_execute(
            &state,
            WS,
            "run-1",
            serde_json::json!({"acknowledgeConflicts": [], "acknowledgeHeadChange": false}),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["code"], "CHECKPOINT_LEASE_HELD");
        assert_eq!(body["reason"], "LEASE_HELD");
        assert_eq!(body["heldByRunId"], "run-2");
        assert!(body["expiresAtMs"].as_u64().unwrap_or(0) > 0);
        assert_eq!(
            std::fs::read_to_string(temp.path().join(WS).join("notes.md")).expect("notes"),
            "after\n",
            "a lease-rejected revert must not mutate the workspace"
        );

        // Sealing the live run releases its lease; the revert then succeeds and the
        // synthetic lease is released again (diagnostics show no active leases).
        assert_eq!(seal_checkpoint(&state, WS, "run-2").await.0, StatusCode::OK);
        let (retry_status, retried) = revert_execute(
            &state,
            WS,
            "run-1",
            serde_json::json!({"acknowledgeConflicts": [], "acknowledgeHeadChange": false}),
        )
        .await;
        assert_eq!(retry_status, StatusCode::OK, "{retried}");
        assert_eq!(retried["counts"]["restored"], 1);
        let (_, diagnostics) = send(&state, Method::GET, DIAGNOSTICS_URI, None).await;
        assert_eq!(
            diagnostics["checkpoint"]["activeLeaseWorkspaces"],
            serde_json::json!([]),
            "the synthetic revert lease must be released on success: {diagnostics}"
        );
    }

    /// Conflicts (paths changed after the run) are gated by an exact path list;
    /// acknowledged conflicts are skipped and their content is preserved.
    #[tokio::test]
    async fn revert_conflicts_require_acknowledgement_and_are_skipped() {
        let temp = workspace_root();
        std::fs::write(temp.path().join(WS).join("notes.md"), "before\n").expect("fixture notes");
        let service = CheckpointService::new(temp.path());
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;
        assert_eq!(
            create_checkpoint(&state, WS, "run-conflict").await.0,
            StatusCode::OK
        );
        std::fs::write(temp.path().join(WS).join("notes.md"), "after\n").expect("fixture modify");
        assert_eq!(
            seal_checkpoint(&state, WS, "run-conflict").await.0,
            StatusCode::OK
        );
        // Post-seal user/editor edit: neither base nor end any more.
        std::fs::write(temp.path().join(WS).join("notes.md"), "user edit\n")
            .expect("post-seal edit");

        let (preview_status, preview) = revert_preview(&state, WS, "run-conflict").await;
        assert_eq!(preview_status, StatusCode::OK, "{preview}");
        assert_eq!(
            preview["counts"],
            serde_json::json!({"restore": 0, "delete": 0, "skipConflicts": 1, "noop": 0})
        );
        assert_eq!(preview["entries"][0]["path"], "notes.md");
        assert_eq!(preview["entries"][0]["action"], "restore");
        assert_eq!(
            preview["entries"][0]["conflictReason"], "CONTENT_CHANGED",
            "the frozen conflict code must be exposed: {preview}"
        );

        let (unacked_status, unacked) = revert_execute(
            &state,
            WS,
            "run-conflict",
            serde_json::json!({"acknowledgeConflicts": [], "acknowledgeHeadChange": false}),
        )
        .await;
        assert_eq!(unacked_status, StatusCode::CONFLICT, "{unacked}");
        assert_eq!(unacked["code"], "CHECKPOINT_CONFLICTS_UNACKNOWLEDGED");
        assert_eq!(unacked["paths"], serde_json::json!(["notes.md"]));

        let (acked_status, acked) = revert_execute(
            &state,
            WS,
            "run-conflict",
            serde_json::json!({"acknowledgeConflicts": ["notes.md"], "acknowledgeHeadChange": false}),
        )
        .await;
        assert_eq!(acked_status, StatusCode::OK, "{acked}");
        assert_eq!(
            acked["counts"],
            serde_json::json!({
                "restored": 0, "deleted": 0, "skippedConflict": 1, "failed": 0, "noop": 0
            })
        );
        assert_eq!(acked["entries"][0]["result"], "skippedConflict");
        assert_eq!(acked["entries"][0]["reason"], "CONTENT_CHANGED");
        assert_eq!(
            std::fs::read_to_string(temp.path().join(WS).join("notes.md")).expect("notes"),
            "user edit\n",
            "acknowledged conflicts are skipped, never overwritten"
        );
    }

    /// A user-repository HEAD move after base creation requires an explicit
    /// acknowledgement; the preview exposes recorded/current fingerprints.
    #[tokio::test]
    async fn revert_head_change_requires_acknowledgement() {
        let temp = workspace_root();
        let ws_root = temp.path().join(WS);
        let service = CheckpointService::new(temp.path());
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;
        std::fs::write(ws_root.join("app.txt"), "v1\n").expect("fixture file");
        git_in(&ws_root, &["init", "-q"]);
        git_in(&ws_root, &["add", "-A"]);
        git_in(&ws_root, &["commit", "-qm", "one"]);

        assert_eq!(
            create_checkpoint(&state, WS, "run-head").await.0,
            StatusCode::OK
        );
        std::fs::write(ws_root.join("app.txt"), "v2\n").expect("fixture modify");
        assert_eq!(
            seal_checkpoint(&state, WS, "run-head").await.0,
            StatusCode::OK
        );
        // The user moves HEAD while the worktree stays at the run's end state.
        git_in(&ws_root, &["commit", "-q", "--allow-empty", "-m", "bump"]);

        let (preview_status, preview) = revert_preview(&state, WS, "run-head").await;
        assert_eq!(preview_status, StatusCode::OK, "{preview}");
        assert_eq!(preview["headFingerprint"]["status"], "changed");
        let recorded = preview["headFingerprint"]["recorded"].clone();
        let current = preview["headFingerprint"]["current"].clone();
        assert_eq!(recorded["isRepo"], true);
        assert!(
            recorded["headCommit"].as_str().is_some(),
            "recorded fingerprint must carry the commit: {preview}"
        );
        assert_ne!(
            recorded["headCommit"], current["headCommit"],
            "the user commit must be visible as a HEAD change: {preview}"
        );

        let (blocked_status, blocked) = revert_execute(
            &state,
            WS,
            "run-head",
            serde_json::json!({"acknowledgeConflicts": [], "acknowledgeHeadChange": false}),
        )
        .await;
        assert_eq!(blocked_status, StatusCode::CONFLICT, "{blocked}");
        assert_eq!(blocked["code"], "CHECKPOINT_HEAD_CHANGED");
        assert_eq!(blocked["recorded"]["headCommit"], recorded["headCommit"]);
        assert_eq!(
            std::fs::read_to_string(ws_root.join("app.txt")).expect("app"),
            "v2\n",
            "a head-change-rejected revert must not mutate the workspace"
        );

        let (acked_status, acked) = revert_execute(
            &state,
            WS,
            "run-head",
            serde_json::json!({"acknowledgeConflicts": [], "acknowledgeHeadChange": true}),
        )
        .await;
        assert_eq!(acked_status, StatusCode::OK, "{acked}");
        assert_eq!(acked["counts"]["restored"], 1);
        assert_eq!(
            std::fs::read_to_string(ws_root.join("app.txt")).expect("app"),
            "v1\n"
        );
    }

    /// Blob endpoint: base/end text content, 400 for unsupported ref/traversal/
    /// non-file/binary, 404 for absent paths, 413 above the 1 MiB cap.
    #[tokio::test]
    async fn checkpoint_blob_serves_text_and_rejects_caps_paths_and_binary() {
        let temp = workspace_root();
        let ws_root = temp.path().join(WS);
        std::fs::write(ws_root.join("notes.md"), "before\n").expect("fixture notes");
        let service = CheckpointService::new(temp.path());
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;
        assert_eq!(
            create_checkpoint(&state, WS, "run-blob").await.0,
            StatusCode::OK
        );
        std::fs::write(ws_root.join("notes.md"), "after\n").expect("fixture modify");
        std::fs::create_dir_all(ws_root.join("src")).expect("fixture dirs");
        std::fs::write(ws_root.join("src/new.txt"), "created during the run\n")
            .expect("fixture write");
        std::fs::write(ws_root.join("big.txt"), vec![b'a'; 1024 * 1024 + 1])
            .expect("fixture big file");
        std::fs::write(ws_root.join("bin.dat"), [0x62_u8, 0x69, 0x6e, 0x00, 0xff])
            .expect("fixture binary");
        assert_eq!(
            seal_checkpoint(&state, WS, "run-blob").await.0,
            StatusCode::OK
        );

        let blob_uri = |path: &str, reference: &str| {
            format!(
                "/internal/v1/runtime/workspaces/{WS}/checkpoints/run-blob/blob?path={path}&ref={reference}"
            )
        };

        let (status, content_type, body) = send_text(&state, &blob_uri("notes.md", "end")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(content_type.as_deref(), Some("text/plain; charset=utf-8"));
        assert_eq!(body, "after\n");
        let (_, _, base_body) = send_text(&state, &blob_uri("notes.md", "base")).await;
        assert_eq!(base_body, "before\n");
        let (_, _, created_body) = send_text(&state, &blob_uri("src%2Fnew.txt", "end")).await;
        assert_eq!(created_body, "created during the run\n");

        // A run-created path has no base blob.
        let (missing_base, _, _) = send_text(&state, &blob_uri("src%2Fnew.txt", "base")).await;
        assert_eq!(missing_base, StatusCode::NOT_FOUND);
        let (missing_path, _, _) = send_text(&state, &blob_uri("missing.txt", "end")).await;
        assert_eq!(missing_path, StatusCode::NOT_FOUND);

        for uri in [
            blob_uri("notes.md", "head"),
            blob_uri("..%2Fevil.txt", "end"),
            blob_uri("%2Fetc%2Fpasswd", "end"),
            blob_uri("src", "end"),
            blob_uri("bin.dat", "end"),
        ] {
            let (bad, _, body) = send_text(&state, &uri).await;
            assert_eq!(bad, StatusCode::BAD_REQUEST, "{uri}: {body}");
        }
        let (too_large, _, large_body) = send_text(&state, &blob_uri("big.txt", "end")).await;
        assert_eq!(too_large, StatusCode::PAYLOAD_TOO_LARGE, "{large_body}");
        assert!(large_body.contains("CHECKPOINT_BLOB_TOO_LARGE"));

        let (no_query, _, _) = send_text(
            &state,
            &format!("/internal/v1/runtime/workspaces/{WS}/checkpoints/run-blob/blob"),
        )
        .await;
        assert_eq!(no_query, StatusCode::BAD_REQUEST);

        let (invalid_run, _, _) = send_text(
            &state,
            &format!(
                "/internal/v1/runtime/workspaces/{WS}/checkpoints/run./blob?path=notes.md&ref=end"
            ),
        )
        .await;
        assert_eq!(
            invalid_run,
            StatusCode::BAD_REQUEST,
            "malformed run ids are rejected"
        );
    }

    /// git-status: a non-Git workspace reports `isRepository: false`; a Git workspace
    /// reports porcelain entries read-only; missing/invalid workspaces fail closed.
    #[tokio::test]
    async fn workspace_git_status_reports_repo_and_non_repo_workspaces() {
        let temp = workspace_root();
        let service = CheckpointService::new(temp.path());
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;
        let uri = format!("/internal/v1/runtime/workspaces/{WS}/git-status");
        let (status, body) = send(&state, Method::GET, &uri, None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["isRepository"], false);
        assert_eq!(body["entries"], serde_json::json!([]));

        // A real user repository: one modified tracked file plus one untracked file.
        let repo_temp = workspace_root();
        let repo_root = repo_temp.path().join(WS);
        let repo_service = CheckpointService::new(repo_temp.path());
        if !require_git(&repo_service).await {
            return;
        }
        let repo_state = state_with(repo_service).await;
        std::fs::write(repo_root.join("tracked.txt"), "v1\n").expect("fixture tracked");
        git_in(&repo_root, &["init", "-q"]);
        git_in(&repo_root, &["add", "-A"]);
        git_in(&repo_root, &["commit", "-qm", "one"]);
        std::fs::write(repo_root.join("tracked.txt"), "v2\n").expect("fixture modify");
        std::fs::write(repo_root.join("new.txt"), "n\n").expect("fixture untracked");

        let (repo_status, repo_body) = send(&repo_state, Method::GET, &uri, None).await;
        assert_eq!(repo_status, StatusCode::OK, "{repo_body}");
        assert_eq!(repo_body["isRepository"], true);
        let mut entries: Vec<(String, String)> = repo_body["entries"]
            .as_array()
            .expect("entries array")
            .iter()
            .map(|entry| {
                (
                    entry["status"].as_str().expect("status").to_string(),
                    entry["path"].as_str().expect("path").to_string(),
                )
            })
            .collect();
        entries.sort();
        assert_eq!(
            entries,
            vec![
                (" M".to_string(), "tracked.txt".to_string()),
                ("??".to_string(), "new.txt".to_string()),
            ],
            "porcelain codes and paths must be reported verbatim: {repo_body}"
        );
        assert!(
            !repo_root.join(".git/index.lock").exists(),
            "git-status must not leave an index lock behind (read-only)"
        );

        // Missing workspace directory → 503 WORKSPACE_UNKNOWN; invalid id → 400.
        let missing = TempDir::new().expect("fixture tempdir");
        let missing_state = state_with(CheckpointService::new(missing.path())).await;
        let (missing_status, missing_body) = send(
            &missing_state,
            Method::GET,
            &format!("/internal/v1/runtime/workspaces/{WS}/git-status"),
            None,
        )
        .await;
        assert_eq!(missing_status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(missing_body["code"], "CHECKPOINT_UNAVAILABLE");
        assert_eq!(missing_body["reason"], "WORKSPACE_UNKNOWN");

        let (invalid_status, invalid_body) = send(
            &state,
            Method::GET,
            "/internal/v1/runtime/workspaces/bad.id/git-status",
            None,
        )
        .await;
        assert_eq!(invalid_status, StatusCode::BAD_REQUEST, "{invalid_body}");
        assert_eq!(invalid_body["code"], "CHECKPOINT_INVALID_REQUEST");
    }

    /// The W1b routes stay behind the internal service bearer filter.
    #[tokio::test]
    async fn revert_and_git_status_routes_require_service_auth() {
        let temp = workspace_root();
        let state = state_with(CheckpointService::new(temp.path())).await;

        let (status, body) = send_with_auth(
            &state,
            Method::POST,
            &format!("/internal/v1/runtime/workspaces/{WS}/checkpoints"),
            Some(serde_json::json!({"runId": "run-1"})),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["code"], "AUTHORIZATION_REQUIRED");

        let (diag_status, _) =
            send_with_auth(&state, Method::GET, DIAGNOSTICS_URI, None, None).await;
        assert_eq!(diag_status, StatusCode::UNAUTHORIZED);

        let (preview_status, preview_body) = send_with_auth(
            &state,
            Method::POST,
            &format!("/internal/v1/runtime/workspaces/{WS}/checkpoints/run-1/revert/preview"),
            None,
            None,
        )
        .await;
        assert_eq!(preview_status, StatusCode::UNAUTHORIZED);
        assert_eq!(preview_body["code"], "AUTHORIZATION_REQUIRED");

        let (blob_status, blob_body) = send_with_auth(
            &state,
            Method::GET,
            &format!(
                "/internal/v1/runtime/workspaces/{WS}/checkpoints/run-1/blob?path=a.txt&ref=base"
            ),
            None,
            None,
        )
        .await;
        assert_eq!(blob_status, StatusCode::UNAUTHORIZED);
        assert_eq!(blob_body["code"], "AUTHORIZATION_REQUIRED");

        let (git_status, git_body) = send_with_auth(
            &state,
            Method::GET,
            &format!("/internal/v1/runtime/workspaces/{WS}/git-status"),
            None,
            None,
        )
        .await;
        assert_eq!(git_status, StatusCode::UNAUTHORIZED);
        assert_eq!(git_body["code"], "AUTHORIZATION_REQUIRED");
    }
}

#[cfg(test)]
mod tool_router_regression_tests {
    use super::*;

    /// PLAN-0308 T1.2：自定义 `call_tool` 不得影响宏生成的其余方法
    /// （宏按方法名逐个判断，见 rmcp-macros tool_handler.rs:44/64/88/98）。
    #[test]
    fn tool_router_lists_builtin_tools() {
        let tools = XiheRuntime::tool_router().list_all();
        assert!(
            tools.iter().any(|tool| tool.name == "read_file"),
            "read_file missing from tool surface"
        );
        assert!(
            tools.len() >= 20,
            "expected the built-in tool surface, got {}",
            tools.len()
        );
    }

    /// PLAN-0317 T1.2（V2）：后台任务工具的参数与描述统一为 `jobId`；
    /// 旧的 `path` 参数写法不得残留。
    #[test]
    fn background_job_tools_use_job_id() {
        let tools = XiheRuntime::tool_router().list_all();
        for name in ["get_background_process", "cancel_background_process"] {
            let tool = tools
                .iter()
                .find(|t| t.name.as_ref() == name)
                .unwrap_or_else(|| panic!("{name} missing from tool surface"));
            let json = serde_json::to_value(tool).expect("tool serializes");
            let props = json
                .get("inputSchema")
                .and_then(|schema| schema.get("properties"))
                .and_then(|properties| properties.as_object())
                .unwrap_or_else(|| panic!("{name} input schema missing"));
            assert!(
                props.contains_key("jobId"),
                "{name} must take jobId: {props:?}"
            );
            assert!(
                !props.contains_key("path"),
                "{name} must not expose path: {props:?}"
            );
        }
        let start = tools
            .iter()
            .find(|t| t.name.as_ref() == "start_background_process")
            .expect("start_background_process present");
        let description = start.description.as_deref().unwrap_or_default();
        assert!(
            description.contains("jobId"),
            "start description must mention jobId: {description}"
        );
        assert!(
            !description.contains("PID"),
            "start description must not mention PID: {description}"
        );
    }

    /// PLAN-0308 M1（V10）：超时署名日志的 `timeout` target 必须在默认过滤器内可见，
    /// 否则三跳时间线缺 Runtime 一层（预存缺陷：过滤器只放行 xihe_runtime/rmcp 前缀）。
    #[test]
    fn timeout_log_target_is_always_enabled() {
        let default_filter = resolve_runtime_log_filter_with(None, None, None);
        assert!(
            default_filter.to_string().contains("timeout=info"),
            "default filter must enable the timeout target: {default_filter}"
        );

        let custom = resolve_runtime_log_filter_with(Some("xihe_runtime=debug"), None, None);
        assert!(
            custom.to_string().contains("timeout=info"),
            "custom filter must keep the timeout target: {custom}"
        );

        let explicit =
            resolve_runtime_log_filter_with(Some("xihe_runtime=debug,timeout=warn"), None, None);
        assert_eq!(explicit.to_string().matches("timeout=").count(), 1);
    }
}
