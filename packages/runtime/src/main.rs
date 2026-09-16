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
use xihe_runtime::checkpoint::NestedRepoPolicy;
use xihe_runtime::checkpoint_api::{
    C0_RUN_ID, CaptureFailure, CheckpointService, CleanupFailure, GcFailure,
};
use xihe_runtime::checkpoint_revert_api::{BlobFailure, GitStatusFailure, RestoreFailure};
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
    /// PLAN-0338: Run checkpoint slices (shadow git engine, capture/restore locks).
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

#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
pub struct ApplyPatchRequest {
    pub patches: Vec<ApplyPatchEntry>,
    #[serde(rename = "snapshotId")]
    pub snapshot_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
pub struct ApplyPatchEntry {
    pub path: String,
    #[serde(rename = "expectedHash")]
    pub expected_hash: String,
    pub hunks: Vec<ApplyPatchHunk>,
}

#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
pub struct ApplyPatchHunk {
    pub before: String,
    pub after: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPatchResult {
    pub changed: Vec<String>,
    pub diff: String,
    pub new_hashes: std::collections::HashMap<String, String>,
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

    #[tool(description = "Apply an atomic multi-file patch with expected content hashes")]
    async fn apply_patch(
        &self,
        Parameters(ApplyPatchRequest {
            patches,
            snapshot_id,
        }): Parameters<ApplyPatchRequest>,
    ) -> Result<Json<ApplyPatchResult>, String> {
        let patch_values = serde_json::to_value(patches).map_err(|e| e.to_string())?;
        let val = self
            .router
            .apply_patch(&self.ws_id, patch_values, snapshot_id.as_deref())
            .await
            .map_err(|e| e.to_string())?;
        let result: ApplyPatchResult = serde_json::from_value(val).map_err(|e| e.to_string())?;
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
                // PLAN-0338 T0.5 ⑧: C0 initial slice, best-effort. A capture
                // failure (host git missing or below the minimum version, git
                // error, ...) only logs and never blocks or fails
                // materialization; the reserved run id `c0` passes the regular
                // run-id validation unchanged.
                match app_clone
                    .checkpoints
                    .capture(&ws_id_clone, C0_RUN_ID, "materialize", "materialize", false)
                    .await
                {
                    Ok(outcome) => tracing::info!(
                        "C0 checkpoint capture completed: ws_id={} noChange={} sliceRef={}",
                        ws_id_clone,
                        outcome.no_change,
                        outcome.slice_ref.as_deref().unwrap_or("none")
                    ),
                    Err(error) => tracing::warn!(
                        "C0 checkpoint capture skipped (materialization unaffected): ws_id={} error={:?}",
                        ws_id_clone,
                        error
                    ),
                }
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

/// PLAN-0338: Run-checkpoint slice host API (capture / preview / restore / blob / gc).
///
/// The service lives in `xihe_runtime::checkpoint_api` and
/// `xihe_runtime::checkpoint_revert_api`; these handlers only map its outcomes to
/// the frozen contract (200 / 400 / 404 / 409 / 413 / 503 Problem+JSON).
#[derive(Debug, Deserialize)]
struct CaptureCheckpointRequest {
    #[serde(rename = "runId")]
    run_id: String,
    actor: String,
    #[serde(rename = "callId")]
    call_id: String,
    #[serde(default)]
    abnormal: bool,
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
/// unacknowledged type-change paths).
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

/// `POST .../checkpoints/capture` — the single capture point (Run terminal,
/// abnormal re-capture and the C0 baseline). `noChange` responses carry no ref.
async fn capture_checkpoint_handler(
    Path(ws_id): Path<String>,
    State(app): State<Arc<AppState>>,
    AxumJson(request): AxumJson<CaptureCheckpointRequest>,
) -> Response {
    match app
        .checkpoints
        .capture(
            &ws_id,
            &request.run_id,
            &request.actor,
            &request.call_id,
            request.abnormal,
        )
        .await
    {
        Ok(outcome) => AxumJson(outcome).into_response(),
        Err(CaptureFailure::Validation { detail }) => checkpoint_problem_response(
            StatusCode::BAD_REQUEST,
            "CHECKPOINT_INVALID_REQUEST",
            None,
            &detail,
        ),
        Err(CaptureFailure::Unavailable { reason, detail }) => checkpoint_problem_response(
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

/// `POST .../checkpoints/cleanup` — explicit plan-B cleanup (Runtime side):
/// removes the whole shadow repository of one workspace; a capture or restore
/// in progress answers 409 `CHECKPOINT_BUSY` (no queueing). CP-side projection
/// invalidation and the user confirmation flow are PLAN-0339.
fn checkpoint_cleanup_failure_response(failure: CleanupFailure) -> Response {
    match failure {
        CleanupFailure::Validation { detail } => checkpoint_problem_response(
            StatusCode::BAD_REQUEST,
            "CHECKPOINT_INVALID_REQUEST",
            None,
            &detail,
        ),
        CleanupFailure::Busy => checkpoint_problem_response(
            StatusCode::CONFLICT,
            "CHECKPOINT_BUSY",
            None,
            "a checkpoint capture or restore currently owns this workspace",
        ),
        CleanupFailure::Unavailable { reason, detail } => checkpoint_problem_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "CHECKPOINT_UNAVAILABLE",
            Some(reason),
            &detail,
        ),
    }
}

async fn checkpoint_cleanup_handler(
    Path(ws_id): Path<String>,
    State(app): State<Arc<AppState>>,
) -> Response {
    match app.checkpoints.cleanup(&ws_id).await {
        Ok(outcome) => AxumJson(outcome).into_response(),
        Err(failure) => checkpoint_cleanup_failure_response(failure),
    }
}

/// PLAN-0338: restore + slice-blob host API.
///
/// `revert/preview` is read-only; `revert` executes per path after an explicit
/// acknowledgement of every type change and fails fast while another restore
/// runs; `blob` serves one plain-text file from the slice tree; `git-status` is
/// the read-only user-repository status for the dual-diff separation.
fn restore_failure_response(failure: RestoreFailure) -> Response {
    match failure {
        RestoreFailure::NotFound { detail } => checkpoint_problem_response(
            StatusCode::NOT_FOUND,
            "CHECKPOINT_NOT_FOUND",
            None,
            &detail,
        ),
        RestoreFailure::TypeChangesUnacknowledged { paths } => {
            let mut extra = serde_json::Map::new();
            extra.insert("paths".to_string(), serde_json::json!(paths));
            checkpoint_problem_response_with(
                StatusCode::CONFLICT,
                "CHECKPOINT_TYPE_CHANGES_UNACKNOWLEDGED",
                None,
                "type-change paths must be acknowledged from the preview before restoring",
                extra,
            )
        }
        RestoreFailure::RestoreLocked => checkpoint_problem_response(
            StatusCode::CONFLICT,
            "CHECKPOINT_RESTORE_LOCKED",
            None,
            "another checkpoint restore is already running for this workspace",
        ),
        RestoreFailure::Unavailable { reason, detail } => checkpoint_problem_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "CHECKPOINT_UNAVAILABLE",
            Some(reason),
            &detail,
        ),
    }
}

#[derive(Debug, Deserialize)]
struct RestorePreviewRequest {
    #[serde(rename = "sliceRef")]
    slice_ref: String,
}

async fn restore_preview_handler(
    Path(ws_id): Path<String>,
    State(app): State<Arc<AppState>>,
    AxumJson(request): AxumJson<RestorePreviewRequest>,
) -> Response {
    match app
        .checkpoints
        .restore_preview(&ws_id, &request.slice_ref)
        .await
    {
        Ok(outcome) => AxumJson(outcome).into_response(),
        Err(failure) => restore_failure_response(failure),
    }
}

#[derive(Debug, Deserialize)]
struct RestoreExecuteRequest {
    #[serde(rename = "sliceRef")]
    slice_ref: String,
    #[serde(rename = "acknowledgeTypeChanges", default)]
    acknowledge_type_changes: Vec<String>,
}

async fn restore_execute_handler(
    Path(ws_id): Path<String>,
    State(app): State<Arc<AppState>>,
    AxumJson(request): AxumJson<RestoreExecuteRequest>,
) -> Response {
    match app
        .checkpoints
        .restore_execute(
            &ws_id,
            &request.slice_ref,
            &request.acknowledge_type_changes,
        )
        .await
    {
        Ok(outcome) => AxumJson(outcome).into_response(),
        Err(failure) => restore_failure_response(failure),
    }
}

#[derive(Debug, Deserialize)]
struct CheckpointBlobQuery {
    #[serde(rename = "sliceRef")]
    slice_ref: String,
    path: String,
}

fn blob_failure_response(failure: BlobFailure) -> Response {
    match failure {
        BlobFailure::NotFound { detail } => checkpoint_problem_response(
            StatusCode::NOT_FOUND,
            "CHECKPOINT_NOT_FOUND",
            None,
            &detail,
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
    Path(ws_id): Path<String>,
    State(app): State<Arc<AppState>>,
    query: Result<Query<CheckpointBlobQuery>, QueryRejection>,
) -> Response {
    let Ok(Query(query)) = query else {
        return checkpoint_problem_response(
            StatusCode::BAD_REQUEST,
            "CHECKPOINT_INVALID_REQUEST",
            None,
            "blob query requires sliceRef and path",
        );
    };
    match app
        .checkpoints
        .slice_blob(&ws_id, &query.slice_ref, &query.path)
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
                    &format!("blob {} is not valid plain text", blob.path),
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

/// Opt-in nested-repository hard limit (`XIHE_CHECKPOINT_REJECT_NESTED_REPOS`,
/// default off). When enabled, captures refuse workspaces containing nested
/// repositories with an explicit `NESTED_REPO_LIMIT` degraded reason; the
/// default policy records them as opaque gitlinks (PLAN-0338 T1.2 / V2).
fn runtime_checkpoint_nested_repo_policy() -> NestedRepoPolicy {
    let enabled = std::env::var("XIHE_CHECKPOINT_REJECT_NESTED_REPOS")
        .is_ok_and(|value| value.eq_ignore_ascii_case("true") || value == "1");
    if enabled {
        NestedRepoPolicy::Reject
    } else {
        NestedRepoPolicy::Opaque
    }
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
            "/internal/v1/runtime/workspaces/{ws_id}/checkpoints/capture",
            post(capture_checkpoint_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/checkpoints/gc",
            post(checkpoint_gc_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/checkpoints/cleanup",
            post(checkpoint_cleanup_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/checkpoints/revert/preview",
            post(restore_preview_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/checkpoints/revert",
            post(restore_execute_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/checkpoints/blob",
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
        checkpoints: Arc::new(
            CheckpointService::new(runtime_checkpoint_host_root())
                .with_nested_repo_policy(runtime_checkpoint_nested_repo_policy()),
        ),
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
    const CAPTURE_URI: &str = "/internal/v1/runtime/workspaces/ws-checkpoint/checkpoints/capture";

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

    async fn capture_checkpoint(
        state: &Arc<AppState>,
        workspace: &str,
        run_id: &str,
        abnormal: bool,
    ) -> (StatusCode, serde_json::Value) {
        send(
            state,
            Method::POST,
            &format!("/internal/v1/runtime/workspaces/{workspace}/checkpoints/capture"),
            Some(serde_json::json!({
                "runId": run_id,
                "actor": "tester",
                "callId": "call-1",
                "abnormal": abnormal,
            })),
        )
        .await
    }

    async fn restore_preview(
        state: &Arc<AppState>,
        workspace: &str,
        slice_ref: &str,
    ) -> (StatusCode, serde_json::Value) {
        send(
            state,
            Method::POST,
            &format!("/internal/v1/runtime/workspaces/{workspace}/checkpoints/revert/preview"),
            Some(serde_json::json!({"sliceRef": slice_ref})),
        )
        .await
    }

    async fn restore_execute(
        state: &Arc<AppState>,
        workspace: &str,
        slice_ref: &str,
        acknowledge_type_changes: Vec<String>,
    ) -> (StatusCode, serde_json::Value) {
        send(
            state,
            Method::POST,
            &format!("/internal/v1/runtime/workspaces/{workspace}/checkpoints/revert"),
            Some(serde_json::json!({
                "sliceRef": slice_ref,
                "acknowledgeTypeChanges": acknowledge_type_changes,
            })),
        )
        .await
    }

    async fn require_git(service: &CheckpointService) -> bool {
        let diagnostics = service.diagnostics().await;
        assert!(
            diagnostics.capable,
            "checkpoint handler tests require a real host git >= 2.20 (spec/test-migration §8): {:?}",
            diagnostics.git_version
        );
        true
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

    /// Frozen capture contract: 200 with `{runId, noChange, sliceRef, commit,
    /// capturedAt, state, changedFiles, opaqueNestedRepos, predecessor}`, a
    /// same-process replay that is idempotent, and a `noChange` body that carries
    /// no ref.
    #[tokio::test]
    async fn checkpoint_capture_returns_slice_shape_no_change_and_replays_idempotently() {
        let temp = workspace_root();
        let service = CheckpointService::new(temp.path());
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;

        let (status, body) = capture_checkpoint(&state, WS, "run-1", false).await;
        assert_eq!(status, StatusCode::OK, "capture must return 200: {body}");
        assert_eq!(body["runId"], "run-1");
        assert_eq!(body["noChange"], false);
        assert_eq!(body["state"], "captured");
        assert_eq!(body["changedFiles"], serde_json::json!([]));
        assert_eq!(body["opaqueNestedRepos"], serde_json::json!([]));
        assert!(body["predecessor"].is_null());
        let slice_ref = body["sliceRef"].as_str().expect("sliceRef is a string");
        assert!(
            slice_ref.starts_with("refs/xihe/slices/"),
            "slice ref namespace: {slice_ref}"
        );
        let leaf = slice_ref.trim_start_matches("refs/xihe/slices/");
        let (epoch, hash) = leaf.split_once('-').expect("epochMs-hash leaf");
        assert!(
            epoch.chars().all(|c| c.is_ascii_digit()) && !epoch.is_empty(),
            "epochMs leaf: {leaf}"
        );
        assert_eq!(hash.len(), 40, "full commit hash: {leaf}");
        assert_eq!(body["commit"].as_str().expect("commit"), hash);
        let captured_at = body["capturedAt"].as_str().expect("capturedAt");
        assert!(
            captured_at.ends_with('Z') && chrono::DateTime::parse_from_rfc3339(captured_at).is_ok(),
            "capturedAt must be RFC3339 UTC (CP Instant.parse): {captured_at}"
        );

        // Same-run replay within this process returns the identical slice.
        let (replay_status, replay) = capture_checkpoint(&state, WS, "run-1", false).await;
        assert_eq!(replay_status, StatusCode::OK);
        assert_eq!(replay["sliceRef"], body["sliceRef"]);
        assert_eq!(replay["commit"], body["commit"]);
        assert_eq!(replay["capturedAt"], body["capturedAt"]);

        // An unchanged workspace captured under another run id writes no ref.
        let (no_change_status, no_change) = capture_checkpoint(&state, WS, "run-2", false).await;
        assert_eq!(no_change_status, StatusCode::OK, "{no_change}");
        assert_eq!(no_change["noChange"], true);
        assert!(no_change["sliceRef"].is_null());
        assert!(no_change["commit"].is_null());
        assert!(no_change["capturedAt"].is_null());
        assert_eq!(no_change["state"], "captured");
        assert_eq!(no_change["changedFiles"], serde_json::json!([]));
        assert_eq!(no_change["predecessor"], body["sliceRef"]);
    }

    /// Writes are reported against the chain tail and abnormal captures carry the
    /// `abnormal-captured` state; the reserved C0 id is accepted verbatim.
    #[tokio::test]
    async fn checkpoint_capture_reports_changes_abnormal_state_and_accepts_c0() {
        let temp = workspace_root();
        let service = CheckpointService::new(temp.path());
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;
        let ws_root = temp.path().join(WS);

        let (_, first) = capture_checkpoint(&state, WS, "c0", false).await;
        assert_eq!(first["runId"], "c0");
        let first_ref = first["sliceRef"].as_str().expect("slice ref").to_string();

        std::fs::create_dir_all(ws_root.join("src")).expect("fixture dirs");
        std::fs::write(ws_root.join("src/new.txt"), "created during the run\n")
            .expect("fixture write");
        let (status, second) = capture_checkpoint(&state, WS, "run-write", true).await;
        assert_eq!(status, StatusCode::OK, "{second}");
        assert_eq!(second["noChange"], false);
        assert_eq!(second["state"], "abnormal-captured");
        assert_eq!(second["predecessor"], first_ref);
        assert_eq!(
            second["changedFiles"],
            serde_json::json!([{"status": "A", "path": "src/new.txt"}]),
            "the change set is the diff against the chain tail"
        );
    }

    /// Probe failure (no host git) → 503 GIT_UNAVAILABLE and degraded diagnostics.
    #[tokio::test]
    async fn checkpoint_capture_probe_failure_returns_503_git_unavailable() {
        let temp = workspace_root();
        let service =
            CheckpointService::new(temp.path()).with_git_binary("xihe-runtime-missing-git-binary");
        let state = state_with(service).await;

        let (status, body) = capture_checkpoint(&state, WS, "run-1", false).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["code"], "CHECKPOINT_UNAVAILABLE");
        assert_eq!(body["reason"], "GIT_UNAVAILABLE");
        assert!(!body["detail"].as_str().unwrap_or("").is_empty());

        let (diag_status, diagnostics) = send(&state, Method::GET, DIAGNOSTICS_URI, None).await;
        assert_eq!(diag_status, StatusCode::OK);
        assert_eq!(diagnostics["checkpoint"]["capable"], false);
        assert!(diagnostics["checkpoint"]["gitVersion"].is_null());
        assert_eq!(diagnostics["checkpoint"]["activeCaptureLocks"], 0);
        assert_eq!(diagnostics["checkpoint"]["activeRestoreLocks"], 0);
    }

    /// A workspace directory that does not exist → 503 WORKSPACE_UNKNOWN.
    #[tokio::test]
    async fn checkpoint_capture_unknown_workspace_returns_503_workspace_unknown() {
        let temp = TempDir::new().expect("fixture tempdir");
        let service = CheckpointService::new(temp.path());
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;

        let (status, body) = capture_checkpoint(&state, WS, "run-1", false).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["code"], "CHECKPOINT_UNAVAILABLE");
        assert_eq!(body["reason"], "WORKSPACE_UNKNOWN");
    }

    /// Malformed identifiers → 400 before any git work.
    #[tokio::test]
    async fn checkpoint_validation_rejects_unsafe_identifiers() {
        let temp = workspace_root();
        let state = state_with(CheckpointService::new(temp.path())).await;

        let (status, body) = capture_checkpoint(&state, WS, "../evil", false).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], "CHECKPOINT_INVALID_REQUEST");

        let (ws_status, ws_body) = capture_checkpoint(&state, "bad.id", "run-1", false).await;
        assert_eq!(ws_status, StatusCode::BAD_REQUEST, "{ws_body}");

        let (gc_status, gc_body) = send(
            &state,
            Method::POST,
            "/internal/v1/runtime/workspaces/bad.id/checkpoints/gc",
            None,
        )
        .await;
        assert_eq!(gc_status, StatusCode::BAD_REQUEST, "{gc_body}");

        let (cleanup_status, cleanup_body) = send(
            &state,
            Method::POST,
            "/internal/v1/runtime/workspaces/bad.id/checkpoints/cleanup",
            None,
        )
        .await;
        assert_eq!(cleanup_status, StatusCode::BAD_REQUEST, "{cleanup_body}");
    }

    /// Plan-B cleanup: removes the whole shadow repo, is idempotent, never
    /// touches the workspace files, and the next capture bootstraps afresh.
    #[tokio::test]
    async fn checkpoint_cleanup_removes_shadow_repo_and_next_capture_bootstraps() {
        let temp = workspace_root();
        let ws_root = temp.path().join(WS);
        std::fs::write(ws_root.join("a.txt"), "one").expect("seed workspace file");
        let service = CheckpointService::new(temp.path()).with_auto_gc(false);
        if !require_git(&service).await {
            return;
        }
        let shadow = service.engine().shadow_git_dir(WS).expect("shadow path");
        let state = state_with(service).await;

        let (status, body) = capture_checkpoint(&state, WS, "run-1", false).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(shadow.is_dir(), "capture bootstraps the shadow repository");

        let cleanup_uri = format!("/internal/v1/runtime/workspaces/{WS}/checkpoints/cleanup");
        let (cleanup_status, cleanup_body) = send(&state, Method::POST, &cleanup_uri, None).await;
        assert_eq!(cleanup_status, StatusCode::OK, "{cleanup_body}");
        assert_eq!(cleanup_body["removed"], true);
        assert!(
            !shadow.exists(),
            "cleanup removes the whole shadow repository"
        );

        let (again_status, again_body) = send(&state, Method::POST, &cleanup_uri, None).await;
        assert_eq!(again_status, StatusCode::OK, "{again_body}");
        assert_eq!(again_body["removed"], false, "cleanup is idempotent");
        assert!(
            ws_root.join("a.txt").exists(),
            "workspace files are untouched"
        );

        let (recapture_status, recapture_body) =
            capture_checkpoint(&state, WS, "run-2", false).await;
        assert_eq!(recapture_status, StatusCode::OK, "{recapture_body}");
        assert_eq!(recapture_body["noChange"], false);
        assert!(
            recapture_body["sliceRef"]
                .as_str()
                .unwrap_or("")
                .starts_with("refs/xihe/slices/"),
            "{recapture_body}"
        );
    }

    /// Cleanup fails fast with 409 CHECKPOINT_BUSY while a capture holds the
    /// workspace lock, and succeeds once the lock is released.
    #[tokio::test]
    async fn checkpoint_cleanup_is_rejected_while_a_lock_is_held() {
        let temp = workspace_root();
        let service = CheckpointService::new(temp.path()).with_auto_gc(false);
        require_git(&service).await;
        let state = state_with(service).await;

        let guard = state.checkpoints.engine().lock_capture(WS).await;
        let uri = format!("/internal/v1/runtime/workspaces/{WS}/checkpoints/cleanup");
        let (status, body) = send(&state, Method::POST, &uri, None).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["code"], "CHECKPOINT_BUSY");
        drop(guard);

        let (released_status, released_body) = send(&state, Method::POST, &uri, None).await;
        assert_eq!(released_status, StatusCode::OK, "{released_body}");
        assert_eq!(released_body["removed"], false);
    }

    /// Opt-in nested-repo hard limit: `Reject` answers 503 NESTED_REPO_LIMIT,
    /// the default `Opaque` policy captures the same workspace and declares the
    /// nested repository instead.
    #[tokio::test]
    async fn checkpoint_capture_nested_repo_policy_is_explicit() {
        let temp = workspace_root();
        let ws_root = temp.path().join(WS);
        let nested = ws_root.join("sub-repo");
        std::fs::create_dir_all(&nested).expect("nested dir");
        let initialized = std::process::Command::new("git")
            .args([
                "-c",
                "user.email=fixture@xihe.local",
                "-c",
                "user.name=fixture",
                "init",
                "-q",
            ])
            .current_dir(&nested)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if !initialized {
            return;
        }
        // A real nested repository has a commit; without one `git add -A` refuses
        // the gitlink with exit 128 (documented edge, explicit GIT_FAILED).
        let committed = std::process::Command::new("git")
            .args([
                "-c",
                "user.email=fixture@xihe.local",
                "-c",
                "user.name=fixture",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "nested baseline",
            ])
            .current_dir(&nested)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if !committed {
            return;
        }
        std::fs::write(nested.join("inner.txt"), "inner").expect("nested file");

        let rejecting = CheckpointService::new(temp.path())
            .with_nested_repo_policy(NestedRepoPolicy::Reject)
            .with_auto_gc(false);
        if !require_git(&rejecting).await {
            return;
        }
        let reject_state = state_with(rejecting).await;
        let (status, body) = capture_checkpoint(&reject_state, WS, "run-1", false).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["code"], "CHECKPOINT_UNAVAILABLE");
        assert_eq!(body["reason"], "NESTED_REPO_LIMIT", "{body}");
        assert!(
            body["detail"].as_str().unwrap_or("").contains("sub-repo"),
            "{body}"
        );

        let opaque_state =
            state_with(CheckpointService::new(temp.path()).with_auto_gc(false)).await;
        let (ok_status, ok_body) = capture_checkpoint(&opaque_state, WS, "run-1", false).await;
        assert_eq!(ok_status, StatusCode::OK, "{ok_body}");
        assert_eq!(
            ok_body["opaqueNestedRepos"],
            serde_json::json!(["sub-repo"])
        );

        let (diag_status, diagnostics) =
            send(&opaque_state, Method::GET, DIAGNOSTICS_URI, None).await;
        assert_eq!(diag_status, StatusCode::OK);
        assert_eq!(diagnostics["checkpoint"]["nestedRepoPolicy"], "opaque");
    }

    /// GC contract: retention counts slices (oldest first) and returns only
    /// `{counts: {deleted, kept}}`.
    #[tokio::test]
    async fn checkpoint_gc_counts_slices_and_keeps_the_newest() {
        let temp = workspace_root();
        let ws_root = temp.path().join(WS);
        let service = CheckpointService::new(temp.path())
            .with_retention(1, 30)
            .with_auto_gc(false);
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;
        for index in 1..=3 {
            std::fs::write(ws_root.join("file.txt"), format!("version {index}\n"))
                .expect("fixture write");
            let (status, body) =
                capture_checkpoint(&state, WS, &format!("run-{index:02}"), false).await;
            assert_eq!(status, StatusCode::OK, "{body}");
        }

        let (status, body) = send(
            &state,
            Method::POST,
            &format!("/internal/v1/runtime/workspaces/{WS}/checkpoints/gc"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "gc must return 200: {body}");
        assert_eq!(body["counts"]["deleted"], 2, "{body}");
        assert_eq!(body["counts"]["kept"], 1, "{body}");
        assert_eq!(body.as_object().expect("object").len(), 1, "counts only");
    }

    /// Diagnostics shape: git capability, shadow root and the lock counters.
    #[tokio::test]
    async fn checkpoint_diagnostics_reports_locks_and_shadow_root() {
        let temp = workspace_root();
        let service = CheckpointService::new(temp.path());
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;

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
        assert_eq!(checkpoint["activeCaptureLocks"], 0);
        assert_eq!(checkpoint["activeRestoreLocks"], 0);
        assert!(checkpoint.get("activeLeaseWorkspaces").is_none());

        // A held capture lock shows up and is released with its guard.
        let capture = state.checkpoints.engine().lock_capture(WS).await;
        let (_, held) = send(&state, Method::GET, DIAGNOSTICS_URI, None).await;
        assert_eq!(held["checkpoint"]["activeCaptureLocks"], 1);
        drop(capture);
        let (_, released) = send(&state, Method::GET, DIAGNOSTICS_URI, None).await;
        assert_eq!(released["checkpoint"]["activeCaptureLocks"], 0);
    }

    /// Happy path: capture C1 → write → capture C2 → preview C1 → restore C1;
    /// a replay finds the workspace already at the slice.
    #[tokio::test]
    async fn restore_preview_and_execute_round_trip() {
        let temp = workspace_root();
        let ws_root = temp.path().join(WS);
        std::fs::write(ws_root.join("notes.md"), "before\n").expect("fixture notes");
        let service = CheckpointService::new(temp.path());
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;

        let (_, first) = capture_checkpoint(&state, WS, "run-1", false).await;
        let slice = first["sliceRef"].as_str().expect("slice ref").to_string();
        std::fs::create_dir_all(ws_root.join("src")).expect("fixture dirs");
        std::fs::write(ws_root.join("src/new.txt"), "created during the run\n")
            .expect("fixture write");
        std::fs::write(ws_root.join("notes.md"), "after\n").expect("fixture modify");
        let (_, second) = capture_checkpoint(&state, WS, "run-2", false).await;
        assert_eq!(second["noChange"], false);

        let (status, preview) = restore_preview(&state, WS, &slice).await;
        assert_eq!(status, StatusCode::OK, "preview must return 200: {preview}");
        assert_eq!(preview["sliceRef"], slice);
        assert_eq!(
            preview["counts"],
            serde_json::json!({"restore": 1, "delete": 1, "typeConflict": 0}),
            "preview counts must match the target slice diff: {preview}"
        );
        assert_eq!(preview["truncated"], false);
        let entries = preview["entries"].as_array().expect("entries array");
        assert_eq!(entries.len(), 2, "{preview}");
        let restore_entry = entries
            .iter()
            .find(|entry| entry["action"] == "restore")
            .expect("restore entry");
        assert_eq!(restore_entry["path"], "notes.md");
        assert_eq!(restore_entry["state"], "execute");
        assert!(restore_entry["reason"].is_null());
        let delete_entry = entries
            .iter()
            .find(|entry| entry["action"] == "delete")
            .expect("delete entry");
        assert_eq!(delete_entry["path"], "src/new.txt");

        let (status, executed) = restore_execute(&state, WS, &slice, Vec::new()).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "restore must return 200: {executed}"
        );
        assert_eq!(executed["sliceRef"], slice);
        assert_eq!(
            executed["counts"],
            serde_json::json!({"restored": 1, "deleted": 1, "failed": 0}),
            "{executed}"
        );
        assert_eq!(executed["suspects"], serde_json::json!([]));
        assert!(executed["durationMs"].as_u64().is_some());
        let results: Vec<(&str, &str)> = executed["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .map(|entry| {
                (
                    entry["path"].as_str().expect("path"),
                    entry["outcome"].as_str().expect("outcome"),
                )
            })
            .collect();
        assert!(results.contains(&("notes.md", "restored")), "{results:?}");
        assert!(results.contains(&("src/new.txt", "deleted")), "{results:?}");
        assert_eq!(
            std::fs::read_to_string(ws_root.join("notes.md")).expect("notes read"),
            "before\n"
        );
        assert!(!ws_root.join("src/new.txt").exists());
        assert!(
            !ws_root.join("src").exists(),
            "empty directories left by the restore are pruned"
        );

        // Replaying the restore finds an empty plan (already at the slice).
        let (replay_status, replayed) = restore_execute(&state, WS, &slice, Vec::new()).await;
        assert_eq!(replay_status, StatusCode::OK, "{replayed}");
        assert_eq!(
            replayed["counts"],
            serde_json::json!({"restored": 0, "deleted": 0, "failed": 0})
        );
        assert_eq!(replayed["entries"], serde_json::json!([]));
        assert_eq!(replayed["suspects"], serde_json::json!([]));
    }

    /// Unknown slice refs → 404; probe failure / missing workspace → 503.
    #[tokio::test]
    async fn restore_unknown_slice_maps_404_and_unavailable_maps_503() {
        let temp = workspace_root();
        let service = CheckpointService::new(temp.path());
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;
        let unknown = "refs/xihe/slices/1700000000000-0123456789abcdef0123456789abcdef01234567";

        let (preview_status, preview) = restore_preview(&state, WS, unknown).await;
        assert_eq!(preview_status, StatusCode::NOT_FOUND);
        assert_eq!(preview["code"], "CHECKPOINT_NOT_FOUND");
        let (execute_status, execute) = restore_execute(&state, WS, unknown, Vec::new()).await;
        assert_eq!(execute_status, StatusCode::NOT_FOUND);
        assert_eq!(execute["code"], "CHECKPOINT_NOT_FOUND");

        let broken =
            CheckpointService::new(temp.path()).with_git_binary("xihe-runtime-missing-git-binary");
        let broken_state = state_with(broken).await;
        let (broken_status, broken_body) = restore_preview(&broken_state, WS, unknown).await;
        assert_eq!(broken_status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(broken_body["code"], "CHECKPOINT_UNAVAILABLE");
        assert_eq!(broken_body["reason"], "GIT_UNAVAILABLE");

        let missing = TempDir::new().expect("fixture tempdir");
        let missing_state = state_with(CheckpointService::new(missing.path())).await;
        let (missing_status, missing_body) = restore_preview(&missing_state, WS, unknown).await;
        assert_eq!(missing_status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(missing_body["code"], "CHECKPOINT_UNAVAILABLE");
        assert_eq!(missing_body["reason"], "WORKSPACE_UNKNOWN");
    }

    /// Type changes are gated by an exact acknowledgement list.
    #[tokio::test]
    async fn restore_type_change_requires_acknowledgement() {
        let temp = workspace_root();
        let ws_root = temp.path().join(WS);
        std::fs::write(ws_root.join("p"), "p-base").expect("fixture file");
        let service = CheckpointService::new(temp.path());
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;
        let (_, first) = capture_checkpoint(&state, WS, "run-1", false).await;
        let slice = first["sliceRef"].as_str().expect("slice ref").to_string();

        // The file became a directory containing a file (file → directory).
        std::fs::remove_file(ws_root.join("p")).expect("remove file");
        std::fs::create_dir_all(ws_root.join("p")).expect("create dir");
        std::fs::write(ws_root.join("p/child.txt"), "child").expect("write child");

        let (preview_status, preview) = restore_preview(&state, WS, &slice).await;
        assert_eq!(preview_status, StatusCode::OK, "{preview}");
        assert_eq!(
            preview["counts"],
            serde_json::json!({"restore": 1, "delete": 1, "typeConflict": 1})
        );
        let conflict = preview["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .find(|entry| entry["state"] == "type_conflict")
            .expect("type conflict entry");
        assert_eq!(conflict["path"], "p");
        assert_eq!(conflict["reason"], "TYPE_CHANGE");

        let (blocked_status, blocked) = restore_execute(&state, WS, &slice, Vec::new()).await;
        assert_eq!(blocked_status, StatusCode::CONFLICT, "{blocked}");
        assert_eq!(blocked["code"], "CHECKPOINT_TYPE_CHANGES_UNACKNOWLEDGED");
        assert_eq!(blocked["paths"], serde_json::json!(["p"]));
        assert_eq!(
            std::fs::read_to_string(ws_root.join("p/child.txt")).expect("child"),
            "child",
            "the gate must precede mutation"
        );

        let (status, executed) = restore_execute(&state, WS, &slice, vec!["p".to_string()]).await;
        assert_eq!(status, StatusCode::OK, "{executed}");
        assert_eq!(
            executed["counts"],
            serde_json::json!({"restored": 1, "deleted": 1, "failed": 0})
        );
        assert!(!ws_root.join("p/child.txt").exists());
        assert_eq!(
            std::fs::read_to_string(ws_root.join("p")).expect("restored file"),
            "p-base"
        );
    }

    /// A second concurrent restore → 409 CHECKPOINT_RESTORE_LOCKED (no queueing).
    #[tokio::test]
    async fn restore_lock_maps_409_checkpoint_restore_locked() {
        let temp = workspace_root();
        let service = CheckpointService::new(temp.path());
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;
        let (_, first) = capture_checkpoint(&state, WS, "run-1", false).await;
        let slice = first["sliceRef"].as_str().expect("slice ref").to_string();

        let guard = state
            .checkpoints
            .engine()
            .try_lock_restore(WS)
            .expect("fixture restore lock");
        let (status, body) = restore_execute(&state, WS, &slice, Vec::new()).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["code"], "CHECKPOINT_RESTORE_LOCKED");
        drop(guard);

        // With the restore lock free the same request succeeds.
        let (status, body) = restore_execute(&state, WS, &slice, Vec::new()).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    /// Blob endpoint: slice text content, 400 for traversal/non-file/binary, 404
    /// for absent paths and unknown slices, 413 above the 1 MiB cap.
    #[tokio::test]
    async fn checkpoint_blob_serves_slice_text_and_rejects_caps_paths_and_binary() {
        let temp = workspace_root();
        let ws_root = temp.path().join(WS);
        std::fs::write(ws_root.join("notes.md"), "before\n").expect("fixture notes");
        let service = CheckpointService::new(temp.path());
        if !require_git(&service).await {
            return;
        }
        let state = state_with(service).await;
        let (_, first) = capture_checkpoint(&state, WS, "run-1", false).await;
        let first_slice = first["sliceRef"].as_str().expect("slice ref").to_string();

        std::fs::write(ws_root.join("notes.md"), "after\n").expect("fixture modify");
        std::fs::create_dir_all(ws_root.join("src")).expect("fixture dirs");
        std::fs::write(ws_root.join("src/new.txt"), "created during the run\n")
            .expect("fixture write");
        std::fs::write(ws_root.join("big.txt"), vec![b'a'; 1024 * 1024 + 1])
            .expect("fixture big file");
        std::fs::write(ws_root.join("bin.dat"), [0x62_u8, 0x69, 0x6e, 0x00, 0xff])
            .expect("fixture binary");
        let (_, second) = capture_checkpoint(&state, WS, "run-2", false).await;
        let second_slice = second["sliceRef"].as_str().expect("slice ref").to_string();

        let blob_uri = |slice: &str, path: &str| {
            format!(
                "/internal/v1/runtime/workspaces/{WS}/checkpoints/blob?sliceRef={slice}&path={path}"
            )
        };
        let blob_uri_encoded = |slice: &str, path: &str| {
            let encoded = slice.replace('/', "%2F");
            format!(
                "/internal/v1/runtime/workspaces/{WS}/checkpoints/blob?sliceRef={encoded}&path={path}"
            )
        };

        let (status, content_type, body) =
            send_text(&state, &blob_uri_encoded(&first_slice, "notes.md")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(content_type.as_deref(), Some("text/plain; charset=utf-8"));
        assert_eq!(body, "before\n");
        let (_, _, after_body) =
            send_text(&state, &blob_uri_encoded(&second_slice, "notes.md")).await;
        assert_eq!(after_body, "after\n");
        let (_, _, created_body) =
            send_text(&state, &blob_uri_encoded(&second_slice, "src%2Fnew.txt")).await;
        assert_eq!(created_body, "created during the run\n");

        // A path absent from that slice and an unknown slice are 404s.
        let (missing_path, _, _) =
            send_text(&state, &blob_uri_encoded(&first_slice, "missing.txt")).await;
        assert_eq!(missing_path, StatusCode::NOT_FOUND);
        let unknown = "refs/xihe/slices/1700000000000-0123456789abcdef0123456789abcdef01234567";
        let (missing_slice, _, _) = send_text(&state, &blob_uri_encoded(unknown, "notes.md")).await;
        assert_eq!(missing_slice, StatusCode::NOT_FOUND);

        for path in ["..%2Fevil.txt", "%2Fetc%2Fpasswd", "src", "bin.dat"] {
            let (bad, _, body) = send_text(&state, &blob_uri_encoded(&second_slice, path)).await;
            assert_eq!(bad, StatusCode::BAD_REQUEST, "{path}: {body}");
        }
        let (too_large, _, large_body) =
            send_text(&state, &blob_uri_encoded(&second_slice, "big.txt")).await;
        assert_eq!(too_large, StatusCode::PAYLOAD_TOO_LARGE, "{large_body}");
        assert!(large_body.contains("CHECKPOINT_BLOB_TOO_LARGE"));

        let (no_query, _, _) = send_text(
            &state,
            &format!("/internal/v1/runtime/workspaces/{WS}/checkpoints/blob"),
        )
        .await;
        assert_eq!(no_query, StatusCode::BAD_REQUEST);

        let (invalid_slice, _, _) =
            send_text(&state, &blob_uri("refs%2Fxihe%2Frun-1%2Fend", "notes.md")).await;
        assert_eq!(
            invalid_slice,
            StatusCode::NOT_FOUND,
            "malformed slice refs are rejected as not found"
        );
    }

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

    /// Every checkpoint route stays behind the internal service bearer filter.
    #[tokio::test]
    async fn checkpoint_routes_require_service_auth() {
        let temp = workspace_root();
        let state = state_with(CheckpointService::new(temp.path())).await;

        for (method, uri, body) in [
            (
                Method::POST,
                CAPTURE_URI.to_string(),
                Some(serde_json::json!({"runId": "run-1", "actor": "a", "callId": "c"})),
            ),
            (
                Method::POST,
                format!("/internal/v1/runtime/workspaces/{WS}/checkpoints/revert/preview"),
                Some(serde_json::json!({"sliceRef": "refs/xihe/slices/1-x"})),
            ),
            (
                Method::POST,
                format!("/internal/v1/runtime/workspaces/{WS}/checkpoints/revert"),
                Some(serde_json::json!({"sliceRef": "refs/xihe/slices/1-x"})),
            ),
            (
                Method::POST,
                format!("/internal/v1/runtime/workspaces/{WS}/checkpoints/gc"),
                None,
            ),
            (
                Method::GET,
                format!("/internal/v1/runtime/workspaces/{WS}/checkpoints/blob"),
                None,
            ),
            (
                Method::GET,
                format!("/internal/v1/runtime/workspaces/{WS}/git-status"),
                None,
            ),
            (Method::GET, DIAGNOSTICS_URI.to_string(), None),
        ] {
            let (status, body) = send_with_auth(&state, method.clone(), &uri, body, None).await;
            assert_eq!(
                status,
                StatusCode::UNAUTHORIZED,
                "{method} {uri} must require service auth: {body}"
            );
            assert_eq!(body["code"], "AUTHORIZATION_REQUIRED", "{method} {uri}");
        }
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
        assert!(
            tools.iter().any(|tool| tool.name == "apply_patch"),
            "apply_patch missing from public tool surface"
        );
        for name in ["create_snapshot", "revert_snapshot"] {
            assert!(
                tools.iter().all(|tool| tool.name.as_ref() != name),
                "{name} must remain internal-only"
            );
        }
    }

    #[test]
    fn apply_patch_tool_exposes_structured_patch_schema() {
        let tools = XiheRuntime::tool_router().list_all();
        let tool = tools
            .iter()
            .find(|tool| tool.name.as_ref() == "apply_patch")
            .expect("apply_patch present");
        let json = serde_json::to_value(tool).expect("tool serializes");
        let props = json
            .get("inputSchema")
            .and_then(|schema| schema.get("properties"))
            .and_then(|properties| properties.as_object())
            .expect("apply_patch input schema missing");
        assert!(
            props.contains_key("patches"),
            "patches must be structured input"
        );
        let schema = json.to_string();
        assert!(
            schema.contains("\"expectedHash\""),
            "expectedHash must be in the wire schema"
        );
        assert!(
            schema.contains("\"hunks\""),
            "hunks must be in the wire schema"
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
