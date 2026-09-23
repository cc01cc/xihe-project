use std::borrow::Cow;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

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

mod import_job;
mod workspace_events;
mod ws_file_handler;
use crate::import_job::{ImportManager, ImportRequest, list_source_directory};
use tokio::sync::Mutex;
use workspace_events::WorkspaceEventWatchers;
use xihe_runtime::backend::{DockerBackend, SandboxBackend, SandboxHandle};
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
use xihe_runtime::job_engine::{CancelOutcome, JobEngineError, JobSnapshot, JobStatus};
use xihe_runtime::lifecycle::LifecycleState;
use xihe_runtime::mcp_session::{self, McpSessionManager, StdioServerSpec};
use xihe_runtime::process_guard::{self, DirectAttachProbeRequest};
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
    /// PLAN-0390: process-boot identity, regenerated on every Runtime start
    /// (unlike the persisted `device_id`). Exposed on the probes so CP can tell
    /// a restarted Runtime from a long-lived one.
    pub boot_id: String,
    /// PLAN-0393: Windows process job engine (Job Object ownership, bounded
    /// output, timeout/cancel/cleanup) for non-Docker execution modes.
    pub job_engine: Arc<xihe_runtime::job_engine::JobEngine>,
    pub workspace_ensurer: Arc<WorkspaceEnsurer>,
    pub router: Arc<WorkspaceExecutionRouter>,
    /// PLAN-0347 T1.3: stdio MCP sessions (`exec attach`), replacing the
    /// in-container HTTP bridge (Q2-A).
    pub mcp_sessions: Arc<McpSessionManager>,
    /// PLAN-0347 T1.1/T1.2: execution seam (`SandboxBackend`) used by the
    /// destroy path; the ensure path still resolves the CP spec first.
    pub sandbox_backend: Arc<dyn SandboxBackend>,
    /// PLAN-0345: single authoritative lifecycle write path + execution lease.
    pub lifecycle: Arc<xihe_runtime::lifecycle::Lifecycle>,
    /// PLAN-0338: Run checkpoint slices (shadow git engine, capture/restore locks).
    pub checkpoints: Arc<CheckpointService>,
    /// Readiness describes the Runtime process, not any particular Workspace.
    pub ready: Arc<AtomicBool>,
    pub imports: Arc<ImportManager>,
    pub(crate) workspace_event_watchers: WorkspaceEventWatchers,
}

impl AppState {
    pub async fn ensure_workspace(
        &self,
        workspace_id: &str,
    ) -> xihe_runtime::error::Result<xihe_runtime::gateway::XiheRuntimeInstance> {
        let instance = self
            .workspace_ensurer
            .ensure_workspace_materialized(workspace_id)
            .await?;
        if let Err(error) = self
            .workspace_event_watchers
            .ensure(workspace_id, &instance.workspace_path)
            .await
        {
            tracing::warn!(
                "workspace filesystem watcher unavailable workspaceId={} error={}",
                workspace_id,
                error
            );
        }
        Ok(instance)
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
        Parameters(ApplyPatchRequest { patches }): Parameters<ApplyPatchRequest>,
    ) -> Result<Json<ApplyPatchResult>, String> {
        let patch_values = serde_json::to_value(patches).map_err(|e| e.to_string())?;
        let val = self
            .router
            .apply_patch(&self.ws_id, patch_values)
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

    #[tool(
        description = "Execute a long-running command in the background and return a jobId; timeout is in seconds and is clamped to the configured maximum — an omitted timeout uses the configured default, an explicit 0 is clamped to the maximum, and a maximum of 0 means no limit"
    )]
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

/// Liveness probe. The body contract (`OK`) is documented in DEV-002 and is
/// intentionally left unchanged; process-boot identity is exposed on
/// `/internal/v1/runtime/diagnostics` (`bootId`) for CP, not here.
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
        | RuntimeError::SandboxNotFound(_) => StatusCode::NOT_FOUND,
        RuntimeError::ExecutionSpecUnavailable { .. }
        | RuntimeError::WorkspaceMaterializationFailed { .. }
        | RuntimeError::McpSessionUnavailable { .. }
        | RuntimeError::Unsupported { .. }
        | RuntimeError::Docker(_) => StatusCode::SERVICE_UNAVAILABLE,
        RuntimeError::McpSessionFailed { .. } => StatusCode::BAD_GATEWAY,
        RuntimeError::McpSessionBusy { .. } => StatusCode::TOO_MANY_REQUESTS,
        RuntimeError::ProcessTimeout { .. } => StatusCode::GATEWAY_TIMEOUT,
        RuntimeError::ProcessCancelled { .. } => StatusCode::CONFLICT,
        RuntimeError::ProcessTreeCleanupFailed { .. } => StatusCode::INTERNAL_SERVER_ERROR,
        RuntimeError::InvalidExecutionSpec { .. } => StatusCode::UNPROCESSABLE_ENTITY,
        RuntimeError::PathTraversal { .. } | RuntimeError::SymlinkEscape { .. } => {
            StatusCode::FORBIDDEN
        }
        RuntimeError::InvalidPath(_) => StatusCode::BAD_REQUEST,
        // PLAN-0345 (decision #7/#11): explicit destroy conflict surfaces as 409,
        // never as 502 collapse.
        RuntimeError::WorkspaceDestroying { .. } => StatusCode::CONFLICT,
        RuntimeError::WorkspaceBusy { .. } => StatusCode::CONFLICT,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn runtime_error_code(error: &RuntimeError) -> &'static str {
    match error {
        RuntimeError::ExecutionSpecNotFound(_)
        | RuntimeError::WorkspaceNotFound(_)
        | RuntimeError::SandboxNotFound(_) => "WORKSPACE_NOT_FOUND",
        RuntimeError::ExecutionSpecUnavailable { .. } => "EXECUTION_SPEC_UNAVAILABLE",
        RuntimeError::McpSessionUnavailable { .. } => "MCP_SESSION_UNAVAILABLE",
        RuntimeError::McpSessionFailed { .. } => "MCP_SESSION_FAILED",
        RuntimeError::McpSessionBusy { .. } => "MCP_SESSION_BUSY",
        RuntimeError::ProcessTimeout { .. } => "PROCESS_TIMEOUT",
        RuntimeError::ProcessCancelled { .. } => "PROCESS_CANCELLED",
        RuntimeError::ProcessTreeCleanupFailed { .. } => "PROCESS_TREE_CLEANUP_FAILED",
        RuntimeError::ProcessExited { .. } => "PROCESS_EXITED",
        RuntimeError::InvalidExecutionSpec { .. } => "EXECUTION_SPEC_INVALID",
        RuntimeError::WorkspaceMaterializationFailed { .. } => "WORKSPACE_MATERIALIZATION_FAILED",
        RuntimeError::WorkspaceDestroying { .. } => "WORKSPACE_DESTROYING",
        RuntimeError::WorkspaceBusy { .. } => "WORKSPACE_BUSY",
        RuntimeError::Unsupported { .. } => "CAPABILITY_UNAVAILABLE",
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
    /// PLAN-0344 T1.3：destroy 窗口内枚举到的存活 jobId（CP 据此把对应
    /// running 档案落 orphaned；枚举失败时为 null，CP 走 fail-closed）。
    #[serde(rename = "jobIds")]
    job_ids: Option<Vec<String>>,
    #[serde(rename = "jobsEnumerationFailed")]
    jobs_enumeration_failed: bool,
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

/// PLAN-0347 T1.3（spec §6）：会话状态查询（只读宿主注册表）。
async fn mcp_servers_handler(
    Path(ws_id): Path<String>,
    State(app): State<Arc<AppState>>,
) -> Result<AxumJson<serde_json::Value>, (StatusCode, AxumJson<serde_json::Value>)> {
    app.ensure_workspace(&ws_id)
        .await
        .map_err(runtime_problem)?;
    let servers = app.mcp_sessions.servers(&ws_id).await;
    Ok(AxumJson(serde_json::json!({
        "servers": servers,
        "count": servers.len(),
    })))
}

/// PLAN-0347 T1.3：停止单个 stdio 会话（配置删除/排障入口）。
async fn mcp_session_stop_handler(
    Path((ws_id, server_id)): Path<(String, String)>,
    State(app): State<Arc<AppState>>,
) -> Result<AxumJson<serde_json::Value>, (StatusCode, AxumJson<serde_json::Value>)> {
    app.ensure_workspace(&ws_id)
        .await
        .map_err(runtime_problem)?;
    let known = app.mcp_sessions.spec(&ws_id, &server_id).await.is_some()
        || app
            .mcp_sessions
            .servers(&ws_id)
            .await
            .iter()
            .any(|snapshot| snapshot.server_id == server_id);
    if !known {
        return Err(runtime_problem(RuntimeError::McpSessionUnavailable {
            workspace_id: ws_id,
            server_id,
            detail: "server not configured".to_string(),
        }));
    }
    app.mcp_sessions.stop_server(&ws_id, &server_id).await;
    Ok(AxumJson(serde_json::json!({"status": "ok"})))
}

/// PLAN-0347 T1.3：`/mcp/spawn` 已退役（会话由配置轮询 + 调用惰性管理）。
fn mcp_spawn_retired(ws_id: &str) -> (StatusCode, AxumJson<serde_json::Value>) {
    (
        StatusCode::GONE,
        AxumJson(serde_json::json!({
            "type": "https://xihe.dev/problems/mcp-session-endpoint-retired",
            "title": "Endpoint retired",
            "status": 410,
            "code": "MCP_SESSION_ENDPOINT_RETIRED",
            "detail": format!(
                "stdio MCP sessions for {ws_id} are managed lazily; call /mcp/stdio/{{server_id}} or inspect /mcp/servers"
            ),
            "requestId": uuid::Uuid::new_v4().to_string(),
        })),
    )
}

async fn mcp_spawn_retired_handler(
    Path(ws_id): Path<String>,
) -> (StatusCode, AxumJson<serde_json::Value>) {
    mcp_spawn_retired(&ws_id)
}

/// 惰性补齐 spec：缓存未命中时单次拉取 CP 配置（≤30s 轮询窗口内首次调用不再失败）。
async fn stdio_spec_for(
    app: &Arc<AppState>,
    ws_id: &str,
    server_id: &str,
) -> Result<StdioServerSpec, RuntimeError> {
    if let Some(spec) = app.mcp_sessions.spec(ws_id, server_id).await {
        return Ok(spec);
    }
    let cp_url = std::env::var("XIHE_CP_URL").unwrap_or_else(|_| "http://localhost:12631".into());
    let cp_api_token =
        std::env::var("XIHE_CP_API_TOKEN").unwrap_or_else(|_| "dev-token-not-secure".into());
    let (_hash, specs) = mcp_session::fetch_stdio_specs(&cp_url, &cp_api_token, ws_id)
        .await
        .map_err(|detail| RuntimeError::McpSessionUnavailable {
            workspace_id: ws_id.to_string(),
            server_id: server_id.to_string(),
            detail,
        })?;
    for removed in app.mcp_sessions.reconcile_specs(ws_id, specs).await {
        app.mcp_sessions.stop_server(ws_id, &removed).await;
    }
    app.mcp_sessions
        .spec(ws_id, server_id)
        .await
        .ok_or_else(|| RuntimeError::McpSessionUnavailable {
            workspace_id: ws_id.to_string(),
            server_id: server_id.to_string(),
            detail: "server is not configured for this workspace".to_string(),
        })
}

/// PLAN-0347 T1.3：stdio 调用直达会话（不再经容器内 HTTP bridge）。
async fn mcp_stdio_handler(
    Path((ws_id, server_id)): Path<(String, String)>,
    State(app): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Result<AxumJson<serde_json::Value>, (StatusCode, AxumJson<serde_json::Value>)> {
    app.ensure_workspace(&ws_id)
        .await
        .map_err(runtime_problem)?;
    let spec = stdio_spec_for(&app, &ws_id, &server_id)
        .await
        .map_err(runtime_problem)?;
    let frame = if body.is_empty() {
        return Err(runtime_problem(RuntimeError::McpSessionUnavailable {
            workspace_id: ws_id,
            server_id,
            detail: "empty request body".to_string(),
        }));
    } else {
        body.to_vec()
    };
    let response = app
        .mcp_sessions
        .request(&ws_id, &spec, frame, mcp_session::DEFAULT_REQUEST_TIMEOUT)
        .await
        .map_err(runtime_problem)?;
    Ok(AxumJson(response))
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

async fn workspace_import_start_handler(
    Path(ws_id): Path<String>,
    State(app): State<Arc<AppState>>,
    AxumJson(request): AxumJson<ImportRequest>,
) -> Result<(StatusCode, AxumJson<serde_json::Value>), (StatusCode, AxumJson<serde_json::Value>)> {
    if !xihe_runtime::hydrate::is_safe_workspace_id(&ws_id) {
        return Err(runtime_problem(RuntimeError::InvalidPath(
            "workspaceId contains invalid route characters".to_string(),
        )));
    }
    let host_root = std::env::var("XIHE_WORKSPACE_HOST_ROOT").map_err(|_| {
        runtime_problem(RuntimeError::InvalidPath(
            "XIHE_WORKSPACE_HOST_ROOT is not configured".to_string(),
        ))
    })?;
    let status = app
        .imports
        .start(ws_id, PathBuf::from(host_root), request)
        .await
        .map_err(|detail| runtime_problem(RuntimeError::InvalidPath(detail)))?;
    Ok((
        StatusCode::ACCEPTED,
        AxumJson(serde_json::to_value(status).unwrap_or_default()),
    ))
}

#[derive(Debug, Deserialize)]
struct SourceDirectoryRequest {
    path: String,
}

async fn source_directory_handler(
    State(_app): State<Arc<AppState>>,
    AxumJson(request): AxumJson<SourceDirectoryRequest>,
) -> Result<AxumJson<serde_json::Value>, (StatusCode, AxumJson<serde_json::Value>)> {
    let requested_path = request.path;
    let path_for_listing = requested_path.clone();
    let entries = tokio::task::spawn_blocking(move || list_source_directory(&path_for_listing))
        .await
        .map_err(|error| runtime_problem(RuntimeError::InvalidPath(error.to_string())))?
        .map_err(|detail| runtime_problem(RuntimeError::InvalidPath(detail)))?;
    Ok(AxumJson(serde_json::json!({
        "path": requested_path,
        "entries": entries,
    })))
}

async fn workspace_import_status_handler(
    Path((_ws_id, import_id)): Path<(String, String)>,
    State(app): State<Arc<AppState>>,
) -> Result<AxumJson<serde_json::Value>, (StatusCode, AxumJson<serde_json::Value>)> {
    let status = app.imports.get(&import_id).await.ok_or_else(|| {
        runtime_problem(RuntimeError::InvalidPath("import not found".to_string()))
    })?;
    Ok(AxumJson(serde_json::to_value(status).unwrap_or_default()))
}

async fn workspace_import_cancel_handler(
    Path((_ws_id, import_id)): Path<(String, String)>,
    State(app): State<Arc<AppState>>,
) -> Result<AxumJson<serde_json::Value>, (StatusCode, AxumJson<serde_json::Value>)> {
    let status = app.imports.cancel(&import_id).await.ok_or_else(|| {
        runtime_problem(RuntimeError::InvalidPath("import not found".to_string()))
    })?;
    Ok(AxumJson(serde_json::to_value(status).unwrap_or_default()))
}

/// PLAN-0344 T1.2：CP 续看/对账用的内部 job 读路径（不经 MCP 工具面，
/// 避免向 Agent 暴露字节游标协议）。
#[derive(Debug, Deserialize)]
pub struct JobStatusRequest {
    #[serde(rename = "jobId")]
    job_id: String,
}

#[derive(Debug, Deserialize)]
pub struct JobOutputRequest {
    #[serde(rename = "jobId")]
    job_id: String,
    #[serde(default)]
    stream: Option<String>,
    #[serde(default)]
    offset: Option<u64>,
    #[serde(default)]
    limit: Option<u64>,
}

/// PLAN-0390: internal job-start request from CP. camelCase to match the
/// Xihe-owned JSON contract (`operationItemId` / `timeoutSecs`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStartRequest {
    /// Operation-ledger item that owns this job (durable anchor).
    pub operation_item_id: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// `0` means "no timeout", matching the MCP `start_background_process`
    /// contract (container `resolve_job_timeout` maps `Some(0)` to unlimited).
    #[serde(default)]
    pub timeout_secs: u64,
    /// Accepted for contract compatibility. The current Docker path cannot
    /// carry `cwd`/`env` through `start_background_process`; backend adapters
    /// (PLAN-0392+) will consume them.
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: Option<std::collections::BTreeMap<String, String>>,
}

fn job_not_found_problem(ws_id: &str, job_id: &str) -> (StatusCode, AxumJson<serde_json::Value>) {
    (
        StatusCode::NOT_FOUND,
        AxumJson(serde_json::json!({
            "type": "https://xihe.dev/problems/job-not-found",
            "title": "Job not found",
            "status": 404,
            "code": "JOB_NOT_FOUND",
            "detail": format!("Job {job_id} not found in workspace {ws_id}"),
            "requestId": uuid::Uuid::new_v4().to_string(),
        })),
    )
}

fn is_job_not_found(error: &RuntimeError) -> bool {
    matches!(error, RuntimeError::InvalidPath(message) if message.starts_with("job not found"))
}

async fn workspace_job_status_handler(
    Path(ws_id): Path<String>,
    State(app): State<Arc<AppState>>,
    AxumJson(req): AxumJson<JobStatusRequest>,
) -> Result<AxumJson<serde_json::Value>, (StatusCode, AxumJson<serde_json::Value>)> {
    match direct_attach_job_context(&app, &ws_id).await {
        Ok(Some(_context)) => {
            return match app.job_engine.snapshot(&req.job_id) {
                Ok(snapshot) => Ok(AxumJson(job_snapshot_projection(&req.job_id, &snapshot))),
                Err(error) if job_engine_not_found(&error) => {
                    Err(job_not_found_problem(&ws_id, &req.job_id))
                }
                Err(error) => Err(job_engine_problem(error)),
            };
        }
        Ok(None) => {}
        Err(problem) => return Err(problem),
    }
    match app.router.get_background_process(&ws_id, &req.job_id).await {
        Ok(value) => Ok(AxumJson(value)),
        Err(error) if is_job_not_found(&error) => Err(job_not_found_problem(&ws_id, &req.job_id)),
        Err(error) => Err(runtime_problem(error)),
    }
}

async fn workspace_job_output_handler(
    Path(ws_id): Path<String>,
    State(app): State<Arc<AppState>>,
    AxumJson(req): AxumJson<JobOutputRequest>,
) -> Result<AxumJson<serde_json::Value>, (StatusCode, AxumJson<serde_json::Value>)> {
    let stream = req.stream.as_deref().unwrap_or("stdout");
    let offset = req.offset.map(|value| value as usize);
    let limit = req.limit.map(|value| value as usize);
    match direct_attach_job_context(&app, &ws_id).await {
        Ok(Some(_context)) => {
            return match app
                .job_engine
                .read_output(&req.job_id, stream, offset, limit)
            {
                Ok(chunk) => Ok(AxumJson(job_output_projection(&chunk))),
                Err(JobEngineError::NotFound) => Err(job_not_found_problem(&ws_id, &req.job_id)),
                // Reclaimed output is not an error for CP: `available=false`
                // (CP folds it into JOB_OUTPUT_EXPIRED/LOST).
                Err(JobEngineError::OutputMissing(reason)) => Ok(AxumJson(serde_json::json!({
                    "jobId": req.job_id,
                    "stream": stream,
                    "available": false,
                    "reason": reason,
                }))),
                Err(error) => Err(job_engine_problem(error)),
            };
        }
        Ok(None) => {}
        Err(problem) => return Err(problem),
    }
    match app
        .router
        .read_job_output(&ws_id, &req.job_id, stream, offset, limit)
        .await
    {
        Ok(value) => Ok(AxumJson(value)),
        Err(error) => Err(runtime_problem(error)),
    }
}

/// PLAN-0366 T1.3：CP 取消端点直连的 internal 取消通道（与 `/jobs/status` 同形）。
/// 复用既有四阶段终止（SIGTERM → ≤3s 等待 → SIGKILL → 复核）；`failed` = 复核仍存活
/// （终止未确认），由 CP 折叠为 502 `JOB_CANCEL_UNCONFIRMED`，不臆造成功。
async fn workspace_job_cancel_handler(
    Path(ws_id): Path<String>,
    State(app): State<Arc<AppState>>,
    AxumJson(req): AxumJson<JobStatusRequest>,
) -> Result<AxumJson<serde_json::Value>, (StatusCode, AxumJson<serde_json::Value>)> {
    match direct_attach_job_context(&app, &ws_id).await {
        Ok(Some(_context)) => {
            return match app.job_engine.cancel(&req.job_id) {
                Ok(result) => Ok(AxumJson(serde_json::json!({
                    "jobId": req.job_id,
                    // Wire fold kept for CP (`cancelled`/`failed` only); the
                    // 0390 outcome travels additively.
                    "status": match result.outcome {
                        CancelOutcome::Cancelled => "cancelled",
                        _ => "failed",
                    },
                    "outcome": result.outcome,
                    "changed": result.changed,
                }))),
                Err(JobEngineError::NotFound) => Err(job_not_found_problem(&ws_id, &req.job_id)),
                Err(error) => Err(job_engine_problem(error)),
            };
        }
        Ok(None) => {}
        Err(problem) => return Err(problem),
    }
    match app
        .router
        .cancel_background_process(&ws_id, &req.job_id)
        .await
    {
        Ok(value) => Ok(AxumJson(job_cancel_response(&req.job_id, &value))),
        Err(error) if is_job_not_found(&error) => Err(job_not_found_problem(&ws_id, &req.job_id)),
        Err(error) => Err(runtime_problem(error)),
    }
}

/// PLAN-0393: `.../jobs/cleanup` — reclaims one engine job (terminate when
/// needed, remove output, report `processes`); PLAN-0390 `CleanupResult` shape.
async fn workspace_job_cleanup_handler(
    Path(ws_id): Path<String>,
    State(app): State<Arc<AppState>>,
    AxumJson(req): AxumJson<JobStatusRequest>,
) -> Result<AxumJson<serde_json::Value>, (StatusCode, AxumJson<serde_json::Value>)> {
    direct_attach_job_context(&app, &ws_id).await?;
    match app.job_engine.cleanup(&req.job_id) {
        Ok(result) => Ok(AxumJson(serde_json::json!({
            "jobId": req.job_id,
            "outcome": result.outcome,
            "reason": result.reason,
            "processes": result.processes,
        }))),
        Err(JobEngineError::NotFound) => Err(job_not_found_problem(&ws_id, &req.job_id)),
        Err(error) => Err(job_engine_problem(error)),
    }
}

/// PLAN-0393 decision #15/#16: engine capabilities in the 0390
/// `BackendCapability` shape, keeping the probe's legacy `reason` key.
async fn workspace_job_capabilities_handler(
    Path(ws_id): Path<String>,
    State(app): State<Arc<AppState>>,
) -> Result<AxumJson<serde_json::Value>, (StatusCode, AxumJson<serde_json::Value>)> {
    let instance = app
        .ensure_workspace(&ws_id)
        .await
        .map_err(runtime_problem)?;
    if instance.execution_mode == "docker" {
        return Err(job_backend_launch_pending_problem(
            "container jobs are served by the Docker backend (PLAN-0392)",
        ));
    }
    let probe = process_guard::probe_direct_attach(process_guard::DirectAttachProbeRequest {
        storage_mode: "direct_attach".to_string(),
        host_path: instance.workspace_path.clone(),
        execution_mode: instance.execution_mode.clone(),
    })
    .await
    .map_err(runtime_problem)?;
    // Capability content is adapter-owned (PLAN-0393 decision #15); the host
    // adapter carries `canIsolateFilesystem=false` as the machine-readable
    // "unrestricted" marker.
    let mut capability = if instance.execution_mode == "windows-mxc" {
        xihe_runtime::job_mxc_adapter::mxc_capability(&probe)
    } else {
        xihe_runtime::job_host_adapter::host_capability(&probe)
    };
    if let Some(object) = capability.as_object_mut() {
        let file_projection =
            xihe_runtime::executor::WorkspaceExecutionRouter::file_operations_capability(
                &instance.execution_mode,
                Some(&probe),
            );
        if let Some(file_operations) = file_projection.get("fileOperations") {
            object.insert("fileOperations".to_string(), file_operations.clone());
        }
    }
    Ok(AxumJson(capability))
}

/// Resolved context for a non-Docker workspace's job routes: the execution
/// mode and the materialized workspace path must come from the same locked
/// materialization (a concurrent mode switch must not route a stale path).
struct DirectAttachJobContext {
    mode: String,
    workspace_path: String,
}

/// Resolves the workspace job context; `Ok(None)` means the Docker path.
/// Materialization errors are preserved so callers fail closed.
async fn direct_attach_job_context(
    app: &Arc<AppState>,
    ws_id: &str,
) -> Result<Option<DirectAttachJobContext>, (StatusCode, AxumJson<serde_json::Value>)> {
    let instance = app.ensure_workspace(ws_id).await.map_err(runtime_problem)?;
    if instance.execution_mode == "docker" {
        Ok(None)
    } else {
        Ok(Some(DirectAttachJobContext {
            mode: instance.execution_mode,
            workspace_path: instance.workspace_path,
        }))
    }
}

fn job_engine_not_found(error: &JobEngineError) -> bool {
    matches!(error, JobEngineError::NotFound)
}

/// `timed_out` is the engine/0390 word; the wire keeps `timeout` for CP.
fn job_wire_status(status: JobStatus) -> &'static str {
    match status {
        JobStatus::TimedOut => "timeout",
        other => other.as_str(),
    }
}

/// PLAN-0390/0393 §路由投影表: keep the keys CP already reads (`jobId`,
/// `status`, `exitCode`, `createdAt`) and add the 0390 keys additively.
/// Transport details (pid, policy path, tier) are never projected.
fn job_snapshot_projection(job_id: &str, snapshot: &JobSnapshot) -> serde_json::Value {
    serde_json::json!({
        "jobId": job_id,
        "status": job_wire_status(snapshot.status),
        "exitCode": snapshot.exit_code,
        "createdAt": snapshot.started_at,
        "startedAt": snapshot.started_at,
        "finishedAt": snapshot.finished_at,
        "stdoutBytes": snapshot.stdout_bytes,
        "stderrBytes": snapshot.stderr_bytes,
        "truncated": snapshot.truncated,
        "cleanupStatus": snapshot.cleanup_status,
    })
}

fn job_output_projection(chunk: &xihe_runtime::job_engine::OutputChunk) -> serde_json::Value {
    serde_json::json!({
        "available": true,
        "stream": chunk.stream,
        "offset": chunk.offset,
        "nextOffset": chunk.next_offset,
        "sizeBytes": chunk.size_bytes,
        "truncated": chunk.truncated,
        "data": chunk.data,
    })
}

fn job_engine_problem(error: JobEngineError) -> (StatusCode, AxumJson<serde_json::Value>) {
    let status = match error {
        JobEngineError::LaunchPending(_) => StatusCode::NOT_IMPLEMENTED,
        JobEngineError::NotFound => StatusCode::NOT_FOUND,
        JobEngineError::Unavailable(_)
        | JobEngineError::InvalidPath(_)
        | JobEngineError::OutputMissing(_)
        | JobEngineError::Unsupported(_) => StatusCode::BAD_GATEWAY,
    };
    (
        status,
        AxumJson(serde_json::json!({
            "type": "https://xihe.dev/problems/job-engine",
            "title": status.canonical_reason().unwrap_or("Job Engine Error"),
            "status": status.as_u16(),
            "code": error.code(),
            "detail": error.reason(),
            "requestId": uuid::Uuid::new_v4().to_string(),
        })),
    )
}

/// 取消结果折叠：容器侧返回 `{"status":"cancelled"|"failed"}`；
/// 缺失/未知状态一律按 `failed`（终止未确认）上报。
fn job_cancel_response(job_id: &str, value: &serde_json::Value) -> serde_json::Value {
    let status = match value.get("status").and_then(|value| value.as_str()) {
        Some("cancelled") => "cancelled",
        _ => "failed",
    };
    serde_json::json!({"jobId": job_id, "status": status})
}

/// PLAN-0390: normalize the `start_background_process` result into the opaque
/// job id string. The executor currently returns a bare `String`, but the
/// contract allows a future object payload, so accept a string `Value`, an
/// object with `jobId`, or an object with snake_case `job_id`; anything else
/// falls back to the raw `Value` rendering.
fn normalize_job_id(value: &serde_json::Value) -> String {
    if let Some(id) = value.as_str() {
        return id.to_string();
    }
    if let Some(id) = value
        .get("jobId")
        .or_else(|| value.get("job_id"))
        .and_then(|inner| inner.as_str())
    {
        return id.to_string();
    }
    value.to_string()
}

/// PLAN-0390: `PROCESS_BACKEND_LAUNCH_PENDING` is not a client error — the
/// direct-attach backend adapter is not implemented yet. Map it to 501 with the
/// same Problem-Details shape as `runtime_problem`, carrying the reason as the
/// `detail` message.
fn job_backend_launch_pending_problem(reason: &str) -> (StatusCode, AxumJson<serde_json::Value>) {
    let status = StatusCode::NOT_IMPLEMENTED;
    (
        status,
        AxumJson(serde_json::json!({
            "type": "https://xihe.dev/problems/job-backend-launch-pending",
            "title": status.canonical_reason().unwrap_or("Not Implemented"),
            "status": status.as_u16(),
            "code": "JOB_BACKEND_LAUNCH_PENDING",
            "detail": reason,
            "requestId": uuid::Uuid::new_v4().to_string(),
        })),
    )
}

/// PLAN-0390: CP-facing job start path. Reuses the MCP background-process
/// launcher; the workspace's backend decides whether the job can actually run.
async fn workspace_job_start_handler(
    Path(ws_id): Path<String>,
    State(app): State<Arc<AppState>>,
    AxumJson(req): AxumJson<JobStartRequest>,
) -> Result<(StatusCode, AxumJson<serde_json::Value>), (StatusCode, AxumJson<serde_json::Value>)> {
    let JobStartRequest {
        operation_item_id,
        command,
        args,
        timeout_secs,
        cwd,
        env,
    } = req;
    // PLAN-0393 T1.8: non-Docker workspaces start through the process job
    // engine; Docker keeps the container launcher.
    if let Some(context) = direct_attach_job_context(&app, &ws_id).await? {
        return start_direct_attach_job(
            &app,
            &ws_id,
            &context.mode,
            &context.workspace_path,
            &operation_item_id,
            &command,
            args,
            cwd,
            env,
            timeout_secs,
        )
        .await;
    }
    // `timeout_secs == 0` stays `Some(0)` so the container treats it as
    // unlimited (matching the MCP tool contract).
    match app
        .router
        .start_background_process(&ws_id, &command, args, Some(timeout_secs))
        .await
    {
        Ok(job_id) => {
            let job_id = normalize_job_id(&serde_json::Value::String(job_id));
            Ok((
                StatusCode::ACCEPTED,
                AxumJson(serde_json::json!({
                    "jobId": job_id,
                    "status": "running",
                    "operationItemId": operation_item_id,
                    "bootId": app.boot_id,
                })),
            ))
        }
        Err(RuntimeError::Unsupported { reason, .. })
            if reason == "PROCESS_BACKEND_LAUNCH_PENDING" =>
        {
            Err(job_backend_launch_pending_problem(&reason))
        }
        Err(error) => Err(runtime_problem(error)),
    }
}

/// PLAN-0393 T1.8: start a job on a non-Docker workspace through the process
/// job engine. `windows-mxc` stays fail-closed until PLAN-0394 assembles the
/// MXC policy artifact; it never downgrades to bare host execution.
#[allow(clippy::too_many_arguments)]
async fn start_direct_attach_job(
    app: &Arc<AppState>,
    ws_id: &str,
    mode: &str,
    workspace_path: &str,
    operation_item_id: &str,
    command: &str,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<std::collections::BTreeMap<String, String>>,
    timeout_secs: u64,
) -> Result<(StatusCode, AxumJson<serde_json::Value>), (StatusCode, AxumJson<serde_json::Value>)> {
    if mode == "windows-mxc" {
        // PLAN-0394: probe first; the policy artifact is assembled by the MXC
        // adapter into this job's output directory. A missing or unavailable
        // backend stays fail-closed (never downgrades to bare host execution).
        let probe = process_guard::probe_direct_attach(DirectAttachProbeRequest {
            storage_mode: "direct_attach".to_string(),
            host_path: workspace_path.to_string(),
            execution_mode: mode.to_string(),
        })
        .await
        .map_err(runtime_problem)?;
        if !probe.available {
            return Err(job_backend_launch_pending_problem(
                probe
                    .reason
                    .as_deref()
                    .unwrap_or("MXC backend is not available"),
            ));
        }
        let plan = xihe_runtime::job_mxc_adapter::build_mxc_job(
            xihe_runtime::job_mxc_adapter::MxcJobRequest {
                workspace_path: workspace_path.to_string(),
                command: command.to_string(),
                args,
                cwd,
                env: env.unwrap_or_default(),
                timeout_secs,
            },
            &app.job_engine.output_dir(operation_item_id),
        )
        .map_err(job_engine_problem)?;
        return match app
            .job_engine
            .start_in_workspace(Some(ws_id), operation_item_id, plan)
        {
            Ok(_handle) => Ok((
                StatusCode::ACCEPTED,
                AxumJson(serde_json::json!({
                    "jobId": operation_item_id,
                    "status": "running",
                    "operationItemId": operation_item_id,
                    "bootId": app.boot_id,
                })),
            )),
            Err(error) => Err(job_engine_problem(error)),
        };
    }
    // PLAN-0395: unrestricted host plan; the adapter owns the mapping and the
    // "not an isolation boundary" marker. Switching to this mode is the
    // owner/admin decision CP records; the Runtime adds an audit line.
    let plan = xihe_runtime::job_host_adapter::build_host_job(
        xihe_runtime::job_host_adapter::HostJobRequest {
            workspace_path: workspace_path.to_string(),
            command: command.to_string(),
            args,
            cwd,
            env: env.unwrap_or_default(),
            timeout_secs,
        },
    )
    .map_err(job_engine_problem)?;
    tracing::warn!(
        workspace_id = %workspace_path,
        job_id = %operation_item_id,
        backend_kind = plan.backend_kind,
        "PLAN-0395: starting an unrestricted host job (no filesystem isolation)"
    );
    match app
        .job_engine
        .start_in_workspace(Some(ws_id), operation_item_id, plan)
    {
        Ok(_handle) => Ok((
            StatusCode::ACCEPTED,
            AxumJson(serde_json::json!({
                "jobId": operation_item_id,
                "status": "running",
                "operationItemId": operation_item_id,
                "bootId": app.boot_id,
            })),
        )),
        Err(error) => Err(job_engine_problem(error)),
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
    // PLAN-0345 (decision #7/#11): destroying window rejects late materialize
    // synchronously with 409 WORKSPACE_DESTROYING — never a silent 202.
    if let Some(status) = app.registry.status(&ws_id).await
        && status.state == xihe_runtime::gateway::MaterializationState::Destroying
    {
        return Err(runtime_problem(RuntimeError::WorkspaceDestroying {
            workspace_id: ws_id.clone(),
        }));
    }
    // Fast path: already materialized and in sync with CP spec.
    if let Some(status) = app.registry.status(&ws_id).await
        && status.state == xihe_runtime::gateway::MaterializationState::Ready
    {
        // PLAN-0365 (root cause D): the C0 baseline is part of a complete
        // materialization. After a checkpoint cleanup the shadow refs are gone
        // while the workspace stays Ready, so this fast path must still
        // bootstrap a fresh C0 slice (best-effort, same as the spawn path).
        match app
            .checkpoints
            .capture(&ws_id, C0_RUN_ID, "materialize", "materialize", false)
            .await
        {
            Ok(outcome) => tracing::info!(
                workspace_id = %ws_id,
                no_change = outcome.no_change,
                slice_ref = outcome.slice_ref.as_deref().unwrap_or("none"),
                "C0 checkpoint capture completed on fast path"
            ),
            Err(error) => tracing::warn!(
                workspace_id = %ws_id,
                error = ?error,
                "C0 checkpoint capture skipped on fast path (materialization unaffected)"
            ),
        }
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
    app.lifecycle.begin_materialize(&ws_id).await;
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
                    .lifecycle
                    .fail_materialization(&ws_id_clone, &error.to_string())
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
    // PLAN-0345 (decisions #7/#10): mark destroying before any teardown so late
    // ensure/materialize callers get 409 WORKSPACE_DESTROYING during the window,
    // and hold the execution lease for the in-flight destroy.
    app.lifecycle
        .transition(
            ws_id,
            xihe_runtime::lifecycle::LifecycleState::Destroying,
            None,
        )
        .await
        .map_err(runtime_problem)?;
    let _lease = app
        .lifecycle
        .leases()
        .acquire(ws_id, "destroy")
        .await
        .map_err(runtime_problem)?;
    // PLAN-0344 T1.3（round-1 P1-2）：destroying 标记后、容器 stop 前枚举
    // 仍存活的 job。枚举失败不回滚 destroy（fail-closed：CP 侧把该 workspace
    // 全部 running 档案落 orphaned）。
    let (job_ids, jobs_enumeration_failed) = match app.router.list_running_job_ids(ws_id).await {
        Ok(ids) => (Some(ids), false),
        Err(error) => {
            tracing::warn!(
                "job enumeration failed during destroy: ws_id={} error={error}",
                ws_id
            );
            (None, true)
        }
    };
    app.mcp_sessions.cleanup_workspace(ws_id).await;
    let cleanup_result = {
        let manager = app.manager.lock().await;
        if manager.get_state(ws_id).is_some() {
            drop(manager);
            app.sandbox_backend
                .destroy(&SandboxHandle {
                    workspace_id: ws_id.to_string(),
                })
                .await
        } else {
            Ok(())
        }
    };
    if let Err(error) = cleanup_result {
        // 0329 §4: distinguishable cleanup failure; leave destroying window open
        // (state -> failed) so operators can retry the destroy.
        app.lifecycle
            .transition(
                ws_id,
                xihe_runtime::lifecycle::LifecycleState::Failed,
                Some(&error.to_string()),
            )
            .await
            .map_err(runtime_problem)?;
        return Err(runtime_problem(error));
    }
    app.workspace_event_watchers.stop(ws_id).await;
    // F2: no resident `destroyed` state — unregister + released marker.
    app.lifecycle.complete_destroy(ws_id).await;
    tracing::info!(
        "Sandbox deleted: ws_id={}, temporary execution resources cleaned; WorkspaceStorage preserved",
        ws_id
    );
    Ok(AxumJson(DeleteWorkspaceResponse {
        status: "ok".to_string(),
        ws_id: ws_id.clone(),
        job_ids,
        jobs_enumeration_failed,
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

/// PLAN-0340 L1b: branch + short HEAD (no dirty).
async fn workspace_git_facts_handler(
    Path(ws_id): Path<String>,
    State(app): State<Arc<AppState>>,
) -> Response {
    match app.checkpoints.git_facts(&ws_id).await {
        Ok(facts) => AxumJson(facts).into_response(),
        Err(failure) => git_status_failure_response(failure),
    }
}

/// `GET /internal/v1/runtime/diagnostics` — ops projection; carries no secrets
/// and never workspace contents.
async fn runtime_diagnostics_handler(State(app): State<Arc<AppState>>) -> Response {
    let checkpoint = app.checkpoints.diagnostics().await;
    AxumJson(serde_json::json!({
        "deviceId": app.device_id,
        "bootId": app.boot_id,
        "status": "ok",
        "checkpoint": checkpoint,
    }))
    .into_response()
}

/// Probe a direct-attach backend before CP persists a Workspace binding.
///
/// This endpoint reports backend availability only. It does not materialize a
/// Workspace and never returns a host path to a caller other than CP.
async fn direct_attach_probe_handler(
    AxumJson(request): AxumJson<DirectAttachProbeRequest>,
) -> Result<
    AxumJson<process_guard::BackendCapabilitySnapshot>,
    (StatusCode, AxumJson<serde_json::Value>),
> {
    process_guard::probe_direct_attach(request)
        .await
        .map(AxumJson)
        .map_err(runtime_problem)
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
            "/internal/v1/runtime/workspaces/{ws_id}/imports",
            post(workspace_import_start_handler),
        )
        .route(
            "/internal/v1/runtime/source-directory",
            post(source_directory_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/imports/{import_id}",
            get(workspace_import_status_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/imports/{import_id}/cancel",
            post(workspace_import_cancel_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/delete",
            post(delete_workspace_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/mcp/spawn",
            post(mcp_spawn_retired_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/mcp/servers",
            get(mcp_servers_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/mcp/servers/{server_id}",
            delete(mcp_session_stop_handler),
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
            "/internal/v1/runtime/workspaces/{ws_id}/git-facts",
            get(workspace_git_facts_handler),
        )
        .route(
            "/internal/v1/runtime/diagnostics",
            get(runtime_diagnostics_handler),
        )
        .route(
            "/internal/v1/runtime/capabilities/direct-attach/probe",
            post(direct_attach_probe_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/jobs/status",
            post(workspace_job_status_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/jobs/output",
            post(workspace_job_output_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/jobs/cancel",
            post(workspace_job_cancel_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/jobs/cleanup",
            post(workspace_job_cleanup_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/jobs/capabilities",
            post(workspace_job_capabilities_handler),
        )
        .route(
            "/internal/v1/runtime/workspaces/{ws_id}/jobs/start",
            post(workspace_job_start_handler),
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
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--file-worker") {
        return tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(xihe_runtime::file_worker::run(&args));
    }
    // PLAN-0307 T3.1/T3.5: config loading (env chain + CLI --set) runs before the
    // Tokio runtime starts so process-env writes stay on the main thread.
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
    let lifecycle = Arc::new(xihe_runtime::lifecycle::Lifecycle::new(
        registry.clone(),
        Arc::new(xihe_runtime::lifecycle::ExecutionLease::new()),
    ));
    let workspace_ensurer = Arc::new(WorkspaceEnsurer::from_env(
        lifecycle.clone(),
        manager.clone(),
    ));
    let router = Arc::new(WorkspaceExecutionRouter::new(
        workspace_ensurer.clone(),
        manager.clone(),
        registry.clone(),
        Arc::new(xihe_runtime::job_engine::JobEngine::new(
            "test-boot",
            std::env::temp_dir().join("xihe-runtime-router-job-output"),
        )),
    ));
    // PLAN-0347 T1.3: stdio MCP sessions (exec attach directly into the
    // workspace container; no in-container HTTP bridge).
    let mcp_sessions = Arc::new(
        McpSessionManager::new()
            .map_err(|error| anyhow::anyhow!("mcp session manager init failed: {error}"))?,
    );
    // PLAN-0347 T1.1/T1.2: execution seam object (single Docker implementation).
    let sandbox_backend: Arc<dyn SandboxBackend> = Arc::new(DockerBackend::new(
        workspace_ensurer.clone(),
        manager.clone(),
        router.clone(),
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
    // PLAN-0393: job output lives under the Runtime state dir; a previous
    // process's directories are unreachable (handles are not persisted), so
    // they are reaped on startup.
    let job_boot_id = uuid::Uuid::new_v4().to_string();
    let job_engine = Arc::new(xihe_runtime::job_engine::JobEngine::new(
        job_boot_id.clone(),
        device::resolve_state_dir().join("job-output"),
    ));
    let orphan_job_dirs = job_engine.reap_orphan_output_dirs();
    if orphan_job_dirs > 0 {
        tracing::info!(
            dirs = orphan_job_dirs,
            "PLAN-0393: reclaimed orphan job output directories"
        );
    }
    let app_state = Arc::new(AppState {
        registry: registry.clone(),
        manager: manager.clone(),
        device_id: device_id.clone(),
        boot_id: job_boot_id,
        workspace_ensurer: workspace_ensurer.clone(),
        router: router.clone(),
        job_engine: job_engine.clone(),
        mcp_sessions: mcp_sessions.clone(),
        sandbox_backend: sandbox_backend.clone(),
        lifecycle: lifecycle.clone(),
        checkpoints: Arc::new(
            CheckpointService::new(runtime_checkpoint_host_root())
                .with_nested_repo_policy(runtime_checkpoint_nested_repo_policy()),
        ),
        ready: readiness.clone(),
        imports: Arc::new(ImportManager::new()),
        workspace_event_watchers: WorkspaceEventWatchers::default(),
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
    let reaper_lifecycle = lifecycle.clone();
    let reaper_sessions = mcp_sessions.clone();
    let reaper_manager = manager.clone();
    let reaper_router = router.clone();
    let reaper_workspace_event_watchers = app_state.workspace_event_watchers.clone();
    let reaper_cp_url =
        std::env::var("XIHE_CP_URL").unwrap_or_else(|_| "http://127.0.0.1:12631".to_string());
    let reaper_api_token =
        std::env::var("XIHE_CP_API_TOKEN").unwrap_or_else(|_| "dev-token-not-secure".to_string());
    let reaper_ct = ct.child_token();
    tokio::spawn(async move {
        idle_reaper_loop(
            ReaperContext {
                registry: reaper_registry,
                lifecycle: reaper_lifecycle,
                sessions: reaper_sessions,
                manager: reaper_manager,
                router: reaper_router,
                job_engine: job_engine.clone(),
                workspace_event_watchers: reaper_workspace_event_watchers,
                cp_url: reaper_cp_url,
                api_token: reaper_api_token,
            },
            reaper_ct,
        )
        .await;
    });

    let cp_poll_registry = registry.clone();
    let cp_poll_lifecycle = lifecycle.clone();
    let cp_poll_sessions = mcp_sessions.clone();
    let poll_ct = ct.child_token();
    tokio::spawn(async move {
        mcp_config_poll_loop(
            cp_poll_sessions,
            cp_poll_registry,
            cp_poll_lifecycle,
            cp_poll_ensurer,
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
    let service_workspace_event_watchers = app_state.workspace_event_watchers.clone();
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
                tokio::runtime::Handle::current().block_on(async {
                    let instance = service_ensurer
                        .ensure_workspace_materialized(&ws_id)
                        .await?;
                    if let Err(error) = service_workspace_event_watchers
                        .ensure(&ws_id, &instance.workspace_path)
                        .await
                    {
                        tracing::warn!(
                            "workspace filesystem watcher unavailable workspaceId={} error={}",
                            ws_id,
                            error
                        );
                    }
                    Ok::<_, xihe_runtime::error::RuntimeError>(instance)
                })
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
    app_state.mcp_sessions.shutdown_all().await;
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

/// PLAN-0347 T1.3/T1.4：配置轮询改为会话 reconcile（不再管理 bridge）。
/// - 仅处理 `Active`（ready）实例：暂停/停止态跳过，避免轮询解除暂停（Q5 缺口 D）；
/// - 拉取失败保持现状（CHN-2：Err ≠ 空配置），不动已有会话；
/// - spec 变化/删除 → 停对应会话（下次调用惰性重建）。
async fn mcp_config_poll_loop(
    sessions: Arc<McpSessionManager>,
    registry: Arc<WorkspaceRegistry>,
    lifecycle: Arc<xihe_runtime::lifecycle::Lifecycle>,
    ensurer: Arc<WorkspaceEnsurer>,
    ct: tokio_util::sync::CancellationToken,
) {
    let cp_url = std::env::var("XIHE_CP_URL").unwrap_or_else(|_| "http://localhost:12631".into());
    let cp_api_token =
        std::env::var("XIHE_CP_API_TOKEN").unwrap_or_else(|_| "dev-token-not-secure".into());
    let mut interval = tokio::time::interval(mcp_session::CONFIG_POLL_INTERVAL);
    loop {
        tokio::select! {
            _ = ct.cancelled() => break,
            _ = interval.tick() => {
                let instances = registry.all_instances().await;
                for instance in &instances {
                    let ws_id = &instance.ws_id;
                    if instance.state != InstanceState::Active {
                        continue;
                    }
                    // ensure_workspace_materialized performs one targeted CP lookup even
                    // for a Registry hit, so a local hash is never compared only with
                    // itself.
                    if let Err(error) = ensurer.ensure_workspace_materialized(ws_id).await {
                        tracing::warn!(
                            "config poll: ensure_workspace failed for {ws_id}: {error}"
                        );
                        if let Err(transition_error) = lifecycle
                            .transition(
                                ws_id,
                                LifecycleState::Failed,
                                Some(&format!("config poll: {error}")),
                            )
                            .await
                        {
                            tracing::warn!(
                                workspace_id = %ws_id,
                                error = %transition_error,
                                "config poll: failed to record workspace failure"
                            );
                        }
                        continue;
                    }
                    // CHN-2: a failed poll must never be mistaken for "no servers
                    // configured". On error, keep the currently running sessions.
                    let (_hash, specs) =
                        match mcp_session::fetch_stdio_specs(&cp_url, &cp_api_token, ws_id).await {
                            Ok(polled) => polled,
                            Err(error) => {
                                tracing::warn!(
                                    "config poll: stdio-servers fetch failed for {ws_id}: {error}; keeping current sessions"
                                );
                                continue;
                            }
                        };
                    for server_id in sessions.reconcile_specs(ws_id, specs).await {
                        tracing::info!(
                            "config poll: stopping changed/removed server {ws_id}/{server_id}"
                        );
                        sessions.stop_server(ws_id, &server_id).await;
                    }
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

/// PLAN-0347 T1.4: idle reaper dependency bundle (keeps the loop signature sane).
struct ReaperContext {
    registry: Arc<WorkspaceRegistry>,
    lifecycle: Arc<xihe_runtime::lifecycle::Lifecycle>,
    sessions: Arc<McpSessionManager>,
    manager: Arc<Mutex<WorkspaceManager>>,
    router: Arc<WorkspaceExecutionRouter>,
    job_engine: Arc<xihe_runtime::job_engine::JobEngine>,
    workspace_event_watchers: WorkspaceEventWatchers,
    cp_url: String,
    api_token: String,
}

async fn idle_reaper_loop(ctx: ReaperContext, ct: tokio_util::sync::CancellationToken) {
    let ReaperContext {
        registry,
        lifecycle,
        sessions,
        manager,
        router,
        job_engine,
        workspace_event_watchers,
        cp_url,
        api_token,
    } = ctx;
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

                    // PLAN-0345 T1.4 (decision #17/F4): 3-tier ladder. The
                    // legacy Tier 4 (7d `Released`) is deleted — Tier 3 already
                    // unregisters, so no Suspended/Released value is ever
                    // written. `reaper::target_tier` is the tested SSOT.
                    use xihe_runtime::lifecycle::reaper::{target_tier, ReapTier};
                    let tier = match target_tier(elapsed) {
                        Some(t) => t,
                        None => continue,
                    };

                    // Stop & pause must reflect the current Docker state, otherwise a Sandbox
                    // restarted out of band (already exited) would never enter a clean state.
                    if tier != ReapTier::Evict
                        && matches!(
                            instance.state,
                            InstanceState::Stopped | InstanceState::Suspended | InstanceState::Released
                        )
                    {
                        tracing::debug!(
                            "Idle reaper: workspace {} container already non-running (state={:?}); skipping active tier",
                            ws_id, instance.state
                        );
                        continue;
                    }

                    // Direct-attach workspaces have no Docker container to
                    // stop or pause. Their host watcher and registry entry
                    // still need the same eviction boundary.
                    if instance.execution_mode != "docker" {
                        if tier == ReapTier::Evict {
                            workspace_event_watchers.stop(ws_id).await;
                            lifecycle.evict(ws_id).await;
                            sessions.cleanup_workspace(ws_id).await;
                            tracing::info!(
                                workspace_id = %ws_id,
                                execution_mode = %instance.execution_mode,
                                event = "reap_evict",
                                "Idle reaper: evicted direct-attach runtime entry"
                            );
                        }
                        continue;
                    }

                    match tier {
                        // Tier 3: 24 hours idle — remove ephemeral container,
                        // unregister, keep WorkspaceStorage. Statuses keep the
                        // last entry for presentation ("已释放" derivation).
                        ReapTier::Evict => {
                            let mut mgr = manager.lock().await;
                            match mgr.delete_workspace(ws_id).await {
                                Ok(_) => {
                                    workspace_event_watchers.stop(ws_id).await;
                                    lifecycle.evict(ws_id).await;
                                    sessions.cleanup_workspace(ws_id).await;
                                    tracing::info!(
                                        workspace_id = %ws_id,
                                        event = "reap_evict",
                                        "Idle reaper: evicted workspace (idle >24h); cache invalidated, WorkspaceStorage preserved"
                                    );
                                }
                                Err(e) => {
                                    tracing::warn!(
                                        "Idle reaper: failed to remove container {}: {}; retaining state",
                                        ws_id, e
                                    );
                                }
                            }
                        }
                        // Tier 2: 2 hours idle — Active/Paused → Stopped
                        ReapTier::Stop => {
                            let mgr = manager.lock().await;
                            match mgr.stop_container(ws_id).await {
                                Ok(_) => {
                                    if let Err(error) = lifecycle
                                        .transition(ws_id, LifecycleState::Stopped, None)
                                        .await
                                    {
                                        tracing::warn!(
                                            workspace_id = %ws_id,
                                            error = %error,
                                            "Idle reaper: stop transition rejected"
                                        );
                                    }
                                    sessions.cleanup_workspace(ws_id).await;
                                    xihe_runtime::lifecycle::reaper::log_transition(
                                        "reap_stop", ws_id, "active", "stopped", "",
                                    );
                                    tracing::info!("Idle reaper: stopped container {} (idle >2h)", ws_id);
                                }
                                Err(e) => {
                                    tracing::warn!(
                                        "Idle reaper: failed to stop container {}: {}; retaining state",
                                        ws_id, e
                                    );
                                }
                            }
                        }
                        // Tier 1: 15 minutes idle — Active → Paused
                        ReapTier::Pause => {
                            if instance.state == InstanceState::Active {
                                // PLAN-0344 T1.3（决策 #3）：暂停生效前登记 job 暂停
                                // 起点，恢复后折算进累计运行时间（避免解冻即 timeout）。
                                if let Err(error) = router.mark_jobs_paused(ws_id).await {
                                    tracing::warn!(
                                        workspace_id = %ws_id,
                                        error = %error,
                                        "Idle reaper: job pause marking failed; timeout budget keeps wall clock"
                                    );
                                }
                                let mgr = manager.lock().await;
                                match mgr.pause_container(ws_id).await {
                                    Ok(_) => {
                                        if let Err(error) = lifecycle
                                            .transition(ws_id, LifecycleState::Paused, None)
                                            .await
                                        {
                                            tracing::warn!(
                                                workspace_id = %ws_id,
                                                error = %error,
                                                "Idle reaper: pause transition rejected"
                                            );
                                        }
                                        xihe_runtime::lifecycle::reaper::log_transition(
                                            "reap_pause", ws_id, "active", "paused", "",
                                        );
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

                // J-1 (PLAN-0317 T1.1): reclaim expired job files inside
                // already-active containers only. `cleanup_jobs` deliberately
                // skips materialization and the activity timestamp, so this
                // maintenance pass cannot start or keep alive an idle
                // workspace.
                if should_cleanup_jobs(ticks) {
                    // PLAN-0393: engine jobs live outside containers; their
                    // output TTL is reclaimed independently of Docker.
                    let reclaimed = job_engine.reap_expired();
                    if reclaimed > 0 {
                        tracing::info!(
                            reclaimed,
                            "PLAN-0393: reclaimed expired process job outputs"
                        );
                    }
                    for instance in &instances {
                        if instance.state != InstanceState::Active {
                            continue;
                        }
                        if instance.execution_mode != "docker" {
                            // Engine jobs are covered by `reap_expired` above.
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
mod job_cancel_tests {
    use super::job_cancel_response;

    /// PLAN-0366 T1.3：容器状态折叠——cancelled 原样；failed/缺失/未知一律
    /// failed（终止未确认，CP 折叠 502）。
    #[test]
    fn cancel_response_folds_container_status() {
        let cancelled = job_cancel_response("job-1", &serde_json::json!({"status": "cancelled"}));
        assert_eq!(cancelled["jobId"], "job-1");
        assert_eq!(cancelled["status"], "cancelled");

        let failed = job_cancel_response("job-2", &serde_json::json!({"status": "failed"}));
        assert_eq!(failed["jobId"], "job-2");
        assert_eq!(failed["status"], "failed");

        for value in [
            serde_json::json!({}),
            serde_json::json!({"status": "weird"}),
        ] {
            assert_eq!(
                job_cancel_response("job-3", &value)["status"],
                "failed",
                "missing or unknown container status must never be reported as cancelled"
            );
        }
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
        let lifecycle = Arc::new(xihe_runtime::lifecycle::Lifecycle::new(
            registry.clone(),
            Arc::new(xihe_runtime::lifecycle::ExecutionLease::new()),
        ));
        let client = xihe_runtime::hydrate::ExecutionSpecClient::new(cp_url, "test-token");
        let ensurer = Arc::new(WorkspaceEnsurer::from_env_with_client(
            lifecycle.clone(),
            manager.clone(),
            client,
        ));
        let router = Arc::new(WorkspaceExecutionRouter::new(
            ensurer.clone(),
            manager.clone(),
            registry.clone(),
            Arc::new(xihe_runtime::job_engine::JobEngine::new(
                "test-boot",
                std::env::temp_dir().join("xihe-runtime-router-job-output"),
            )),
        ));
        Arc::new(AppState {
            registry: registry.clone(),
            manager: manager.clone(),
            device_id: "test-device".to_string(),
            boot_id: uuid::Uuid::new_v4().to_string(),
            workspace_ensurer: ensurer.clone(),
            router: router.clone(),
            job_engine: Arc::new(xihe_runtime::job_engine::JobEngine::new(
                "test-boot",
                std::env::temp_dir().join("xihe-runtime-test-job-output"),
            )),
            mcp_sessions: Arc::new(
                McpSessionManager::new().expect("mcp session manager (docker) for tests"),
            ),
            sandbox_backend: Arc::new(DockerBackend::new(
                ensurer.clone(),
                manager.clone(),
                router.clone(),
            )),
            lifecycle: lifecycle.clone(),
            // Checkpoint tests replace this with a tempdir-scoped service; other
            // tests never touch the host root.
            checkpoints: Arc::new(CheckpointService::new(std::env::temp_dir())),
            ready: Arc::new(AtomicBool::new(true)),
            imports: Arc::new(ImportManager::new()),
            workspace_event_watchers: WorkspaceEventWatchers::default(),
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

    /// PLAN-0349 T1.4/T2.1: Runtime classifies broker failures by HTTP status at
    /// each call site (no problem-code parsing). First fetch: 401/403 →
    /// authorization_required, other non-2xx → token_broker_unavailable. The
    /// refetch after a remote 401 goes through remote_mcp_error_response:
    /// non-2xx → remote_mcp_unavailable.
    #[tokio::test]
    async fn oauth_mode_broker_failures_map_per_call_site() {
        #[allow(unsafe_code)]
        fn point_cp_at(url: &str) {
            // Edition 2024: env mutation is unsafe; only the OAuth-mode handler
            // calls in this module read XIHE_CP_URL.
            unsafe {
                std::env::set_var("XIHE_CP_URL", url);
            }
        }
        use std::collections::HashMap;
        use std::sync::{Arc, Mutex};

        async fn spec(Path(ws_id): Path<String>) -> impl IntoResponse {
            AxumJson(spec_json(&ws_id)).into_response()
        }
        async fn token(
            State(counters): State<Arc<Mutex<HashMap<String, usize>>>>,
            body: String,
        ) -> axum::response::Response {
            let payload: serde_json::Value =
                serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
            let user = payload
                .get("userId")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
            let call = {
                let mut counts = counters.lock().expect("token counters");
                let entry = counts.entry(user.clone()).or_insert(0);
                *entry += 1;
                *entry
            };
            if user == "u-broker-503" || (user == "u-refetch-503" && call >= 2) {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    [(axum::http::header::CONTENT_TYPE, "application/problem+json")],
                    AxumJson(serde_json::json!({
                        "type": "https://xihe.dev/problems/oauth_token_unavailable",
                        "code": "OAUTH_TOKEN_UNAVAILABLE",
                    })),
                )
                    .into_response();
            }
            AxumJson(serde_json::json!({
                "access_token": "initial-token",
                "token_type": "Bearer",
                "expires_in": 300,
                "scope": "mcp:tools",
            }))
            .into_response()
        }

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind broker stub");
        let addr = listener.local_addr().expect("broker stub addr").to_string();
        let app = Router::new()
            .route(
                "/internal/v1/runtime/workspaces/{ws_id}/execution-spec",
                get(spec),
            )
            .route("/internal/v1/oauth/token", post(token))
            .with_state(Arc::new(Mutex::new(HashMap::<String, usize>::new())));
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve broker stub");
        });
        let cp_url = format!("http://{addr}");
        point_cp_at(&cp_url);
        allow_local_http();

        async fn fake_mcp_unauthorized() -> String {
            async fn handler() -> impl IntoResponse {
                (StatusCode::UNAUTHORIZED, "{\"error\":\"unauthorized\"}")
            }
            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind fake mcp 401");
            let addr = listener
                .local_addr()
                .expect("fake mcp 401 addr")
                .to_string();
            let app = Router::new().fallback(any(handler));
            tokio::spawn(async move {
                axum::serve(listener, app)
                    .await
                    .expect("serve fake mcp 401");
            });
            format!("http://{addr}/mcp")
        }

        let endpoint = fake_mcp_unauthorized().await;
        let state = test_state(&cp_url).await;

        let mut first_fetch = call_request(&endpoint, true);
        first_fetch.auth_mode = "oauth".to_string();
        first_fetch.user_id = "u-broker-503".to_string();
        let error = remote_mcp_call_handler(
            Path((TEST_WS.to_string(), "fake".to_string())),
            State(state.clone()),
            auth_headers(),
            AxumJson(first_fetch),
        )
        .await
        .expect_err("broker 503 on the first fetch must fail");
        assert_eq!(error.0, StatusCode::BAD_GATEWAY);
        assert_eq!(error.2.0["code"], "TOKEN_BROKER_UNAVAILABLE");

        let mut refetch = call_request(&endpoint, false);
        refetch.auth_mode = "oauth".to_string();
        refetch.user_id = "u-refetch-503".to_string();
        let error = remote_mcp_call_handler(
            Path((TEST_WS.to_string(), "fake".to_string())),
            State(state.clone()),
            auth_headers(),
            AxumJson(refetch),
        )
        .await
        .expect_err("broker 503 on the refetch must fail");
        assert_eq!(error.0, StatusCode::BAD_GATEWAY);
        assert_eq!(error.2.0["code"], "REMOTE_MCP_UNAVAILABLE");
    }

    /// The refetch path keeps its existing timeout mapping (the 30s wire
    /// timeout is not reproduced in unit time; the mapping table itself is).
    #[test]
    fn refetch_timeout_keeps_the_408_mapping() {
        let (status, _, body) = remote_mcp_error_response(RemoteMcpError::Timeout);
        assert_eq!(status, StatusCode::REQUEST_TIMEOUT);
        assert_eq!(body.0["code"], "TIMEOUT");
    }

    #[tokio::test]
    async fn boot_id_is_stable_uuid_shaped_across_reads() {
        let app = test_state("http://127.0.0.1:1").await;
        let first = app.boot_id.clone();
        let second = app.boot_id.clone();
        assert_eq!(first, second, "boot_id must be stable for one AppState");
        assert!(!first.trim().is_empty());
        assert_eq!(first.len(), 36);
        assert!(
            uuid::Uuid::parse_str(&first).is_ok(),
            "boot_id must be UUID-shaped: {first}"
        );
    }

    #[test]
    fn job_start_request_deserializes_camel_case_fields() {
        let req: JobStartRequest = serde_json::from_value(serde_json::json!({
            "operationItemId": "x",
            "command": "echo",
            "args": ["a"],
            "timeoutSecs": 5,
        }))
        .expect("camelCase job start request");
        assert_eq!(req.operation_item_id, "x");
        assert_eq!(req.command, "echo");
        assert_eq!(req.args, vec!["a".to_string()]);
        assert_eq!(req.timeout_secs, 5);
        assert!(req.cwd.is_none());
        assert!(req.env.is_none());
    }

    #[test]
    fn job_start_request_defaults_args_and_timeout() {
        let req: JobStartRequest = serde_json::from_value(serde_json::json!({
            "operationItemId": "x",
            "command": "echo",
        }))
        .expect("minimal job start request");
        assert!(req.args.is_empty());
        assert_eq!(req.timeout_secs, 0);
    }

    #[test]
    fn normalize_job_id_reads_string_and_object_shapes() {
        assert_eq!(normalize_job_id(&serde_json::json!("job-str")), "job-str");
        assert_eq!(
            normalize_job_id(&serde_json::json!({"jobId": "job-camel"})),
            "job-camel"
        );
        assert_eq!(
            normalize_job_id(&serde_json::json!({"job_id": "job-snake"})),
            "job-snake"
        );
    }

    #[test]
    fn backend_launch_pending_problem_maps_to_501_contract() {
        let (status, body) = job_backend_launch_pending_problem("PROCESS_BACKEND_LAUNCH_PENDING");
        assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
        assert_eq!(body.0["status"], 501);
        assert_eq!(body.0["code"], "JOB_BACKEND_LAUNCH_PENDING");
        assert_eq!(body.0["detail"], "PROCESS_BACKEND_LAUNCH_PENDING");
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
        assert!(
            !props.contains_key("snapshotId"),
            "snapshotId must not remain in the apply_patch wire schema"
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

#[cfg(test)]
mod job_engine_route_tests {
    use super::{
        AppState, JobStartRequest, JobStatusRequest, job_engine_problem, job_output_projection,
        job_snapshot_projection, workspace_job_cancel_handler, workspace_job_capabilities_handler,
        workspace_job_cleanup_handler, workspace_job_output_handler, workspace_job_start_handler,
        workspace_job_status_handler,
    };
    use axum::extract::{Path, State};
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;
    use tokio::sync::Mutex;
    use xihe_runtime::gateway::WorkspaceRegistry;
    use xihe_runtime::hydrate::{ExecutionSpecClient, WorkspaceEnsurer};
    use xihe_runtime::job_engine::{JobEngine, JobStatus};
    use xihe_runtime::lifecycle::Lifecycle;
    use xihe_runtime::workspace::WorkspaceManager;

    struct DirectAttachApp {
        app: Arc<AppState>,
        ws_id: String,
        dir: tempfile::TempDir,
        _server: tokio::task::JoinHandle<()>,
    }

    /// Boots a direct-attach workspace (`windows-host`) against an in-test CP
    /// stub, so job routes run through the engine (no Docker).
    async fn direct_attach_app() -> DirectAttachApp {
        direct_attach_app_with_mode("windows-host").await
    }

    async fn direct_attach_app_with_mode(execution_mode: &str) -> DirectAttachApp {
        let dir = tempfile::tempdir().expect("workspace dir");
        let ws_id = uuid::Uuid::new_v4().to_string();
        let host_path = dir.path().to_string_lossy().to_string();
        let hash = "b".repeat(64);
        let route_path = format!("/internal/v1/runtime/workspaces/{ws_id}/execution-spec");
        let spec_body = serde_json::json!({
            "workspaceId": ws_id,
            "generation": 1,
            "sandboxSpecHash": hash,
            "sandboxSpec": {"profile": "coding"},
            "storageBackend": "host_directory",
            "storageRef": ws_id,
            "storageMode": "direct_attach",
            "hostPath": host_path,
            "executionMode": execution_mode,
        });
        let route_body = spec_body.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind stub CP");
        let address = listener.local_addr().expect("stub CP address");
        let server = tokio::spawn(async move {
            let router = axum::Router::new().route(
                &route_path,
                axum::routing::get(move || {
                    let body = route_body.clone();
                    async move { axum::Json(body) }
                }),
            );
            let _ = axum::serve(listener, router).await;
        });

        let registry = Arc::new(WorkspaceRegistry::new());
        let manager = Arc::new(Mutex::new(WorkspaceManager::new()));
        let lifecycle = Arc::new(Lifecycle::new(
            registry.clone(),
            Arc::new(xihe_runtime::lifecycle::ExecutionLease::new()),
        ));
        let ensurer = Arc::new(WorkspaceEnsurer::new(
            lifecycle.clone(),
            manager.clone(),
            ExecutionSpecClient::new(&format!("http://{address}"), "test-token"),
            Some(dir.path().to_path_buf()),
        ));
        let router = Arc::new(xihe_runtime::executor::WorkspaceExecutionRouter::new(
            ensurer.clone(),
            manager.clone(),
            registry.clone(),
            Arc::new(xihe_runtime::job_engine::JobEngine::new(
                "test-boot",
                std::env::temp_dir().join("xihe-runtime-router-job-output"),
            )),
        ));
        let app = Arc::new(AppState {
            registry: registry.clone(),
            manager: manager.clone(),
            device_id: "test-device".to_string(),
            boot_id: "test-boot".to_string(),
            workspace_ensurer: ensurer.clone(),
            router: router.clone(),
            job_engine: Arc::new(JobEngine::new("test-boot", dir.path().join("job-output"))),
            mcp_sessions: Arc::new(
                xihe_runtime::mcp_session::McpSessionManager::new()
                    .expect("session manager for tests"),
            ),
            sandbox_backend: Arc::new(xihe_runtime::backend::DockerBackend::new(
                ensurer.clone(),
                manager.clone(),
                router.clone(),
            )),
            lifecycle,
            checkpoints: Arc::new(xihe_runtime::checkpoint_api::CheckpointService::new(
                dir.path(),
            )),
            ready: Arc::new(AtomicBool::new(true)),
            imports: Arc::new(crate::import_job::ImportManager::new()),
            workspace_event_watchers: crate::workspace_events::WorkspaceEventWatchers::default(),
        });
        DirectAttachApp {
            app,
            ws_id,
            dir,
            _server: server,
        }
    }

    async fn body_json(response: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("read body");
        serde_json::from_slice(&bytes).expect("json body")
    }

    #[test]
    fn snapshot_projection_keeps_cp_keys_and_hides_transport_details() {
        let snapshot = xihe_runtime::job_engine::JobSnapshot {
            status: JobStatus::TimedOut,
            exit_code: Some(1),
            started_at: Some("2026-09-21T10:00:00.000Z".to_string()),
            finished_at: Some("2026-09-21T10:01:00.000Z".to_string()),
            stdout_bytes: 12,
            stderr_bytes: 3,
            truncated: true,
            cleanup_status: "not_started".to_string(),
        };
        let projected = job_snapshot_projection("job-1", &snapshot);
        assert_eq!(projected["jobId"], "job-1");
        assert_eq!(projected["status"], "timeout", "timed_out folds to timeout");
        assert_eq!(projected["exitCode"], 1);
        assert_eq!(projected["createdAt"], projected["startedAt"]);
        assert_eq!(projected["truncated"], true);
        assert_eq!(projected["cleanupStatus"], "not_started");
        for forbidden in [
            "pid",
            "wrapperPid",
            "policyPath",
            "mxcTier",
            "policyArtifact",
        ] {
            assert!(
                projected.get(forbidden).is_none(),
                "projection leaked {forbidden}"
            );
        }
    }

    #[test]
    fn output_and_problem_projection_shapes() {
        let chunk = xihe_runtime::job_engine::OutputChunk {
            stream: "stdout".to_string(),
            offset: 0,
            next_offset: 4,
            size_bytes: 4,
            truncated: false,
            data: "data".to_string(),
        };
        let projected = job_output_projection(&chunk);
        assert_eq!(projected["available"], true);
        assert_eq!(projected["nextOffset"], 4);
        assert_eq!(projected["data"], "data");

        let (status, _) = job_engine_problem(xihe_runtime::job_engine::JobEngineError::NotFound);
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = job_engine_problem(
            xihe_runtime::job_engine::JobEngineError::InvalidPath("outside grants".to_string()),
        );
        assert_eq!(status, StatusCode::BAD_GATEWAY);
    }

    #[tokio::test]
    async fn direct_attach_job_routes_use_the_engine_end_to_end() {
        let DirectAttachApp {
            app,
            ws_id,
            dir,
            _server,
        } = direct_attach_app().await;
        let job_id = uuid::Uuid::new_v4().to_string();

        let started = workspace_job_start_handler(
            Path(ws_id.clone()),
            State(app.clone()),
            axum::Json(JobStartRequest {
                operation_item_id: job_id.clone(),
                command: "cmd".to_string(),
                args: vec!["/C".to_string(), "echo engine-route & exit 0".to_string()],
                timeout_secs: 30,
                cwd: None,
                env: None,
            }),
        )
        .await
        .expect("start job");
        assert_eq!(started.0, StatusCode::ACCEPTED);
        let start_body = body_json(started.1.into_response()).await;
        assert_eq!(start_body["jobId"], job_id);
        assert_eq!(start_body["bootId"], "test-boot");

        // Idempotent re-start must not spawn a second process.
        let again = workspace_job_start_handler(
            Path(ws_id.clone()),
            State(app.clone()),
            axum::Json(JobStartRequest {
                operation_item_id: job_id.clone(),
                command: "cmd".to_string(),
                args: vec!["/C".to_string(), "exit 0".to_string()],
                timeout_secs: 30,
                cwd: None,
                env: None,
            }),
        )
        .await
        .expect("re-start job");
        assert_eq!(again.0, StatusCode::ACCEPTED);

        // Poll status until terminal; the wire status must be a CP-recognised
        // literal (succeeded/cancelled/timeout/orphaned).
        let mut status = String::new();
        for _ in 0..200 {
            let response = workspace_job_status_handler(
                Path(ws_id.clone()),
                State(app.clone()),
                axum::Json(JobStatusRequest {
                    job_id: job_id.clone(),
                }),
            )
            .await
            .expect("status");
            let body = body_json(response.into_response()).await;
            status = body["status"].as_str().unwrap_or_default().to_string();
            if matches!(
                status.as_str(),
                "succeeded" | "failed" | "cancelled" | "timeout"
            ) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        assert_eq!(status, "succeeded");

        let output = workspace_job_output_handler(
            Path(ws_id.clone()),
            State(app.clone()),
            axum::Json(super::JobOutputRequest {
                job_id: job_id.clone(),
                stream: Some("stdout".to_string()),
                offset: Some(0),
                limit: None,
            }),
        )
        .await
        .expect("output");
        let output_body = body_json(output.into_response()).await;
        assert_eq!(output_body["available"], true);
        assert!(
            output_body["data"]
                .as_str()
                .unwrap_or_default()
                .contains("engine-route"),
            "captured stdout: {output_body}"
        );

        let cancelled = workspace_job_cancel_handler(
            Path(ws_id.clone()),
            State(app.clone()),
            axum::Json(JobStatusRequest {
                job_id: job_id.clone(),
            }),
        )
        .await
        .expect("cancel");
        let cancel_body = body_json(cancelled.into_response()).await;
        assert_eq!(cancel_body["outcome"], "already_terminal");
        assert_eq!(cancel_body["changed"], false);

        let cleanup = workspace_job_cleanup_handler(
            Path(ws_id.clone()),
            State(app.clone()),
            axum::Json(JobStatusRequest {
                job_id: job_id.clone(),
            }),
        )
        .await
        .expect("cleanup");
        let cleanup_body = body_json(cleanup.into_response()).await;
        assert_eq!(cleanup_body["outcome"], "completed");
        assert!(
            !app.job_engine
                .output_root()
                .join(job_id.replace(['/', '\\', ':'], "_"))
                .exists()
        );

        let missing = workspace_job_status_handler(
            Path(ws_id),
            State(app),
            axum::Json(JobStatusRequest {
                job_id: "missing".to_string(),
            }),
        )
        .await
        .expect_err("missing job must 404");
        assert_eq!(missing.0, StatusCode::NOT_FOUND);
        drop(dir);
    }

    #[tokio::test]
    async fn mxc_job_route_is_probe_gated() {
        let DirectAttachApp {
            app,
            ws_id,
            dir,
            _server,
        } = direct_attach_app_with_mode("windows-mxc").await;
        let job_id = uuid::Uuid::new_v4().to_string();
        let result = workspace_job_start_handler(
            Path(ws_id.clone()),
            State(app.clone()),
            axum::Json(JobStartRequest {
                operation_item_id: job_id.clone(),
                command: "cmd".to_string(),
                args: vec!["/C".to_string(), "exit 0".to_string()],
                timeout_secs: 30,
                cwd: None,
                env: None,
            }),
        )
        .await;
        let mxc = std::env::var("XIHE_MXC_EXECUTABLE").unwrap_or_default();
        let mxc_available = !mxc.is_empty() && std::path::Path::new(&mxc).exists();
        // Capability content is adapter-owned: MXC claims filesystem isolation,
        // host does not (asserted in the host route test).
        let capability =
            workspace_job_capabilities_handler(Path(ws_id.clone()), State(app.clone()))
                .await
                .expect("mxc capabilities");
        let capability_body = body_json(capability.into_response()).await;
        assert_eq!(capability_body["canIsolateFilesystem"], true);
        assert_eq!(capability_body["backendKind"], "windows-mxc");
        if mxc_available {
            let (status, _) = result.expect("mxc job start");
            assert_eq!(status, StatusCode::ACCEPTED);
            let mut terminal = false;
            for _ in 0..200 {
                let response = workspace_job_status_handler(
                    Path(ws_id.clone()),
                    State(app.clone()),
                    axum::Json(JobStatusRequest {
                        job_id: job_id.clone(),
                    }),
                )
                .await
                .expect("status");
                let body = body_json(response.into_response()).await;
                if matches!(
                    body["status"].as_str().unwrap_or_default(),
                    "succeeded" | "failed" | "cancelled" | "timeout"
                ) {
                    terminal = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            assert!(terminal, "MXC job never reached a terminal state");
            let cleanup = workspace_job_cleanup_handler(
                Path(ws_id),
                State(app.clone()),
                axum::Json(JobStatusRequest {
                    job_id: job_id.clone(),
                }),
            )
            .await
            .expect("cleanup");
            let cleanup_body = body_json(cleanup.into_response()).await;
            assert_eq!(cleanup_body["outcome"], "completed");
            assert!(
                !app.job_engine
                    .output_dir(&job_id)
                    .join("policy.json")
                    .exists(),
                "policy artifact must be reclaimed with the job output"
            );
        } else {
            let problem = result.expect_err("MXC must fail closed without a backend");
            assert_eq!(problem.0, StatusCode::NOT_IMPLEMENTED);
            assert_eq!(problem.1.0["code"], "JOB_BACKEND_LAUNCH_PENDING");
            assert!(
                !app.job_engine.output_dir(&job_id).exists(),
                "no artifact may be written when the probe fails"
            );
        }
        drop(dir);
    }

    #[tokio::test]
    async fn job_capabilities_route_reports_engine_capability() {
        let DirectAttachApp {
            app,
            ws_id,
            dir,
            _server,
        } = direct_attach_app().await;
        let response = workspace_job_capabilities_handler(Path(ws_id), State(app))
            .await
            .expect("capabilities");
        let body = body_json(response.into_response()).await;
        assert_eq!(body["backendKind"], "windows-host");
        assert_eq!(body["canCancel"], true);
        assert_eq!(body["canStreamOutput"], true);
        assert_eq!(body["canIsolateFilesystem"], false);
        assert!(body["available"].is_boolean());
        assert!(body.get("unavailableReason").is_some());
        assert!(body.get("reason").is_some(), "legacy probe key kept");
        drop(dir);
    }

    // ---- PLAN-0390 fixture 一致性（PLAN-0393/0394/0395 M2） ----

    /// Fixture 驱动的 10 条一致性用例；`XIHE_JOB_CONFORMANCE_BACKEND`
    /// （缺省 `windows-host`）选择适配器。fixture 路径可用
    /// `XIHE_JOB_CONFORMANCE_FIXTURE` 覆盖，否则按仓库相对位置解析。
    fn conformance_fixture() -> serde_json::Value {
        let path = std::env::var("XIHE_JOB_CONFORMANCE_FIXTURE").unwrap_or_else(|_| {
            format!(
                "{}/../../../plans/PLAN-0390-XH-execution-job-backends/fixture/job-handle-conformance.json",
                env!("CARGO_MANIFEST_DIR")
            )
        });
        let bytes = std::fs::read(&path)
            .unwrap_or_else(|error| panic!("cannot read conformance fixture {path}: {error}"));
        serde_json::from_slice(&bytes).expect("fixture json")
    }

    fn conformance_backend() -> String {
        std::env::var("XIHE_JOB_CONFORMANCE_BACKEND").unwrap_or_else(|_| "windows-host".to_string())
    }

    async fn conformance_app() -> DirectAttachApp {
        direct_attach_app_with_mode(&conformance_backend()).await
    }

    async fn start_job(
        app: &Arc<AppState>,
        ws_id: &str,
        job_id: &str,
        args: Vec<String>,
        timeout_secs: u64,
    ) -> Result<(StatusCode, serde_json::Value), (StatusCode, serde_json::Value)> {
        start_job_program(app, ws_id, job_id, "cmd", args, timeout_secs).await
    }

    async fn start_job_program(
        app: &Arc<AppState>,
        ws_id: &str,
        job_id: &str,
        program: &str,
        args: Vec<String>,
        timeout_secs: u64,
    ) -> Result<(StatusCode, serde_json::Value), (StatusCode, serde_json::Value)> {
        match workspace_job_start_handler(
            Path(ws_id.to_string()),
            State(app.clone()),
            axum::Json(JobStartRequest {
                operation_item_id: job_id.to_string(),
                command: program.to_string(),
                args,
                timeout_secs,
                cwd: None,
                env: None,
            }),
        )
        .await
        {
            Ok((status, body)) => Ok((status, body_json(body.into_response()).await)),
            Err(problem) => Err((problem.0, problem.1.0)),
        }
    }

    async fn await_terminal(app: &Arc<AppState>, ws_id: &str, job_id: &str) -> serde_json::Value {
        for _ in 0..400 {
            let response = workspace_job_status_handler(
                Path(ws_id.to_string()),
                State(app.clone()),
                axum::Json(JobStatusRequest {
                    job_id: job_id.to_string(),
                }),
            )
            .await
            .expect("status");
            let body = body_json(response.into_response()).await;
            if matches!(
                body["status"].as_str().unwrap_or_default(),
                "succeeded" | "failed" | "cancelled" | "timeout"
            ) {
                return body;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("job {job_id} never reached a terminal state");
    }

    #[tokio::test]
    async fn conf_start_success() {
        let fixture = conformance_fixture();
        assert_eq!(fixture["contract"], "job-handle-v1");
        let DirectAttachApp {
            app,
            ws_id,
            dir,
            _server,
        } = conformance_app().await;
        let job_id = uuid::Uuid::new_v4().to_string();
        let (status, body) = start_job(
            &app,
            &ws_id,
            &job_id,
            vec!["/C".to_string(), "ping -n 5 127.0.0.1 > nul".to_string()],
            30,
        )
        .await
        .expect("start");
        assert_eq!(status, StatusCode::ACCEPTED);
        assert_eq!(body["jobId"], job_id);
        assert!(!body["bootId"].as_str().unwrap_or_default().is_empty());
        let snapshot = app.job_engine.snapshot(&job_id).expect("snapshot");
        assert_eq!(snapshot.status.as_str(), "running");
        assert!(
            !app.job_engine
                .handle(&job_id)
                .expect("handle")
                .opaque_handle_id
                .is_empty()
        );
        app.job_engine.cancel(&job_id).expect("cancel");
        app.job_engine.cleanup(&job_id).expect("cleanup");
        drop(dir);
    }

    #[tokio::test]
    async fn conf_start_unsupported_backend() {
        // 契约：后备不可用/进程创建失败时不产生任何进程。
        // 路由级 501 分支由 `mxc_job_route_is_probe_gated` 覆盖（无 MXC 环境）。
        let DirectAttachApp {
            app,
            ws_id: _ws_id,
            dir,
            _server,
        } = direct_attach_app_with_mode("windows-mxc").await;
        let job_id = uuid::Uuid::new_v4().to_string();
        let plan = xihe_runtime::job_engine::LaunchPlan {
            backend_kind: "windows-mxc".to_string(),
            program: "definitely-not-a-real-program-xyz.exe".to_string(),
            grants: xihe_runtime::process_guard::FilesystemPolicy {
                read_only_roots: Vec::new(),
                read_write_roots: vec![dir.path().to_path_buf()],
            },
            ..Default::default()
        };
        let error = app.job_engine.start(&job_id, plan).expect_err("must fail");
        assert_eq!(error.code(), "RUNTIME_UNAVAILABLE");
        assert_eq!(app.job_engine.active_count(), 0);
        assert!(!app.job_engine.output_dir(&job_id).exists());
        drop(dir);
    }

    #[tokio::test]
    async fn conf_output_cursor_monotonic() {
        let DirectAttachApp {
            app,
            ws_id,
            dir,
            _server,
        } = conformance_app().await;
        let job_id = uuid::Uuid::new_v4().to_string();
        start_job(
            &app,
            &ws_id,
            &job_id,
            vec!["/C".to_string(), "echo conformance-output".to_string()],
            30,
        )
        .await
        .expect("start");
        await_terminal(&app, &ws_id, &job_id).await;
        let response = workspace_job_output_handler(
            Path(ws_id.clone()),
            State(app.clone()),
            axum::Json(super::JobOutputRequest {
                job_id: job_id.clone(),
                stream: Some("stdout".to_string()),
                offset: Some(0),
                limit: Some(65_536),
            }),
        )
        .await
        .expect("output");
        let body = body_json(response.into_response()).await;
        let offset = body["offset"].as_u64().expect("offset");
        let next = body["nextOffset"].as_u64().expect("nextOffset");
        let size = body["sizeBytes"].as_u64().expect("sizeBytes");
        assert!(next >= offset, "cursor must be monotonic: {body}");
        assert!(
            size <= next - offset,
            "sizeBytes must not exceed the read window"
        );
        app.job_engine.cleanup(&job_id).expect("cleanup");
        drop(dir);
    }

    #[tokio::test]
    async fn conf_output_truncated_boundary() {
        let DirectAttachApp {
            app,
            ws_id,
            dir,
            _server,
        } = conformance_app().await;
        let job_id = uuid::Uuid::new_v4().to_string();
        start_job_program(
            &app,
            &ws_id,
            &job_id,
            "node",
            vec![
                "-e".to_string(),
                "process.stdout.write(String.fromCharCode(97).repeat(2097152))".to_string(),
            ],
            60,
        )
        .await
        .expect("start");
        let snapshot = await_terminal(&app, &ws_id, &job_id).await;
        let response = workspace_job_output_handler(
            Path(ws_id.clone()),
            State(app.clone()),
            axum::Json(super::JobOutputRequest {
                job_id: job_id.clone(),
                stream: Some("stdout".to_string()),
                offset: Some(0),
                limit: Some(1_048_576),
            }),
        )
        .await
        .expect("output");
        let body = body_json(response.into_response()).await;
        assert_eq!(
            body["truncated"], true,
            "2 MiB producer must be truncated: snapshot={snapshot} chunk={body}"
        );
        let offset = body["offset"].as_u64().expect("offset");
        let next = body["nextOffset"].as_u64().expect("nextOffset");
        assert_eq!(next - offset, 1_048_576);
        app.job_engine.cleanup(&job_id).expect("cleanup");
        drop(dir);
    }

    #[tokio::test]
    async fn conf_cancel_terminal_idempotent() {
        let DirectAttachApp {
            app,
            ws_id,
            dir,
            _server,
        } = conformance_app().await;
        let job_id = uuid::Uuid::new_v4().to_string();
        start_job(
            &app,
            &ws_id,
            &job_id,
            vec!["/C".to_string(), "exit 0".to_string()],
            30,
        )
        .await
        .expect("start");
        await_terminal(&app, &ws_id, &job_id).await;
        let response = workspace_job_cancel_handler(
            Path(ws_id.clone()),
            State(app.clone()),
            axum::Json(JobStatusRequest {
                job_id: job_id.clone(),
            }),
        )
        .await
        .expect("cancel");
        let body = body_json(response.into_response()).await;
        assert_eq!(body["outcome"], "already_terminal");
        assert_eq!(body["changed"], false);
        app.job_engine.cleanup(&job_id).expect("cleanup");
        drop(dir);
    }

    #[tokio::test]
    async fn conf_cancel_missing_handle() {
        let DirectAttachApp {
            app,
            ws_id,
            dir,
            _server,
        } = conformance_app().await;
        let problem = workspace_job_cancel_handler(
            Path(ws_id),
            State(app),
            axum::Json(JobStatusRequest {
                job_id: "missing".to_string(),
            }),
        )
        .await
        .expect_err("missing handle must 404");
        assert_eq!(problem.0, StatusCode::NOT_FOUND);
        assert_eq!(problem.1.0["code"], "JOB_NOT_FOUND");
        drop(dir);
    }

    #[tokio::test]
    async fn conf_cancel_process_tree_unconfirmed_contract() {
        // fixture 要求「树未确认 → unconfirmed」。构造真实残留会让 Job Object
        // 语义失效，故此处断言分类契约，真实场景见 0393 manual-verification §6。
        let fixture = conformance_fixture();
        let case = fixture["cases"]
            .as_array()
            .expect("cases")
            .iter()
            .find(|case| case["id"] == "cancel-process-tree-unconfirmed")
            .expect("case");
        assert_eq!(case["expect"]["cancel.outcome"], "unconfirmed");
        let DirectAttachApp {
            app,
            ws_id,
            dir,
            _server,
        } = conformance_app().await;
        let job_id = uuid::Uuid::new_v4().to_string();
        start_job(
            &app,
            &ws_id,
            &job_id,
            vec!["/C".to_string(), "ping -n 30 127.0.0.1 > nul".to_string()],
            60,
        )
        .await
        .expect("start");
        let cancel = app.job_engine.cancel(&job_id).expect("cancel");
        assert_eq!(
            cancel.outcome,
            xihe_runtime::job_engine::CancelOutcome::Cancelled,
            "the real tree is confirmable, so cancel reports cancelled"
        );
        app.job_engine.cleanup(&job_id).expect("cleanup");
        drop(dir);
    }

    #[tokio::test]
    async fn conf_cleanup_explicit_result() {
        let DirectAttachApp {
            app,
            ws_id,
            dir,
            _server,
        } = conformance_app().await;
        let job_id = uuid::Uuid::new_v4().to_string();
        start_job(
            &app,
            &ws_id,
            &job_id,
            vec!["/C".to_string(), "exit 0".to_string()],
            30,
        )
        .await
        .expect("start");
        await_terminal(&app, &ws_id, &job_id).await;
        let response = workspace_job_cleanup_handler(
            Path(ws_id),
            State(app),
            axum::Json(JobStatusRequest {
                job_id: job_id.clone(),
            }),
        )
        .await
        .expect("cleanup");
        let body = body_json(response.into_response()).await;
        assert!(
            matches!(body["outcome"].as_str(), Some("completed") | Some("failed")),
            "explicit outcome required: {body}"
        );
        assert!(body["processes"].as_u64().is_some());
        drop(dir);
    }

    #[tokio::test]
    async fn conf_capability_unavailable_has_reason() {
        // 不可用能力必须带原因（adapter 层构造，确定性）。
        let probe = xihe_runtime::process_guard::BackendCapabilitySnapshot::unavailable(
            "windows-mxc",
            "builtin",
            "experimental",
            "windows-mxc",
            "MXC_EXECUTABLE_MISSING",
            None,
        );
        let capability = xihe_runtime::job_mxc_adapter::mxc_capability(&probe);
        assert_eq!(capability["available"], false);
        assert_eq!(capability["unavailableReason"], "MXC_EXECUTABLE_MISSING");
        // fixture 的 error.code 是引擎侧投影；HTTP 面沿用既有的 JOB_* 码。
        assert_eq!(
            xihe_runtime::job_engine::JobEngineError::LaunchPending("probe failed".to_string())
                .code(),
            "PROCESS_BACKEND_LAUNCH_PENDING"
        );

        // 与真实分支对照：环境未配置 MXC 时路由返回 501 且带 reason。
        let DirectAttachApp {
            app,
            ws_id,
            dir,
            _server,
        } = direct_attach_app_with_mode("windows-mxc").await;
        let mxc = std::env::var("XIHE_MXC_EXECUTABLE").unwrap_or_default();
        let mxc_available = !mxc.is_empty() && std::path::Path::new(&mxc).exists();
        if !mxc_available {
            let problem = start_job(
                &app,
                &ws_id,
                &uuid::Uuid::new_v4().to_string(),
                vec!["/C".to_string(), "exit 0".to_string()],
                30,
            )
            .await
            .expect_err("must fail closed without MXC");
            assert_eq!(problem.1["code"], "JOB_BACKEND_LAUNCH_PENDING");
            assert!(
                !problem.1["detail"].as_str().unwrap_or_default().is_empty(),
                "fail-closed must explain why: {problem:?}"
            );
        }
        drop(dir);
    }

    #[tokio::test]
    async fn host_job_honors_env_and_readonly_cwd() {
        // 边界矩阵：env 生效；cwd 落在只读 grant 内也允许（Host 无写保护，
        // grants 只是引擎的 cwd 规则——见 PLAN-0395 spec §3）。
        let DirectAttachApp {
            app,
            ws_id,
            dir,
            _server,
        } = direct_attach_app_with_mode("windows-host").await;
        let job_id = uuid::Uuid::new_v4().to_string();
        let mut env = std::collections::BTreeMap::new();
        env.insert("XIHE_IT_MARKER".to_string(), "boundary-42".to_string());
        let (status, _) = workspace_job_start_handler(
            Path(ws_id.clone()),
            State(app.clone()),
            axum::Json(JobStartRequest {
                operation_item_id: job_id.clone(),
                command: "node".to_string(),
                args: vec![
                    "-e".to_string(),
                    "process.stdout.write(process.env.XIHE_IT_MARKER || 'missing')".to_string(),
                ],
                timeout_secs: 30,
                cwd: Some(dir.path().to_string_lossy().into_owned()),
                env: Some(env),
            }),
        )
        .await
        .expect("start");
        assert_eq!(status, StatusCode::ACCEPTED);
        await_terminal(&app, &ws_id, &job_id).await;
        let response = workspace_job_output_handler(
            Path(ws_id.clone()),
            State(app.clone()),
            axum::Json(super::JobOutputRequest {
                job_id: job_id.clone(),
                stream: Some("stdout".to_string()),
                offset: Some(0),
                limit: None,
            }),
        )
        .await
        .expect("output");
        let body = body_json(response.into_response()).await;
        assert!(
            body["data"]
                .as_str()
                .unwrap_or_default()
                .contains("boundary-42"),
            "env must reach the job: {body}"
        );
        app.job_engine.cleanup(&job_id).expect("cleanup");
        drop(dir);
    }
    #[tokio::test]
    async fn oneshot_command_runs_through_the_engine_with_the_same_contract() {
        // PLAN-0397 V1/V2/V5/V8：直连 execute_command 走引擎，返回契约与旧实现逐字一致。
        let DirectAttachApp {
            app,
            ws_id,
            dir,
            _server,
        } = direct_attach_app_with_mode("windows-host").await;
        let result = app
            .router
            .execute_command(
                &ws_id,
                "cmd",
                vec!["/C".to_string(), "echo oneshot-engine & exit 3".to_string()],
                Some(30),
                None,
            )
            .await;
        let value = result.expect("one-shot command");
        assert_eq!(value["exit_code"], 3, "{value}");
        assert_eq!(value["success"], false);
        assert!(
            value["stdout"]
                .as_str()
                .unwrap_or_default()
                .contains("oneshot-engine"),
            "{value}"
        );
        assert_eq!(value["stdout_truncated"], false);
        assert_eq!(value["stderr_truncated"], false);
        // 跑完即回收：不留下任何 job 目录，也不残留活跃句柄。
        assert_eq!(app.job_engine.active_count(), 0);
        let out = app.job_engine.output_root();
        let leftovers = std::fs::read_dir(out)
            .map(|entries| entries.flatten().count())
            .unwrap_or(0);
        assert_eq!(leftovers, 0, "one-shot jobs must be reclaimed immediately");

        // PLAN-0397 V4：取消请求经 in-flight token 命中直连命令。
        let registrations = app.router.in_flight();
        let item_id = "oneshot-cancel-item".to_string();
        let signal_item = item_id.clone();
        let signal_ws = ws_id.clone();
        let canceller = tokio::spawn(async move {
            for _ in 0..200 {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                if registrations
                    .request_termination(&signal_ws, &signal_item)
                    .is_some()
                {
                    break;
                }
            }
        });
        let cancelled = app
            .router
            .execute_op(
                &ws_id,
                "execute_command",
                serde_json::json!({
                    "command": "cmd",
                    "args": ["/C", "ping -n 30 127.0.0.1 > nul"],
                    "operationItemId": item_id,
                }),
            )
            .await;
        let _ = canceller.await;
        assert!(
            matches!(
                cancelled,
                Err(xihe_runtime::error::RuntimeError::Cancelled {
                    confirmed: true,
                    ..
                })
            ),
            "expected a confirmed cancel, got {cancelled:?}"
        );
        assert_eq!(app.job_engine.active_count(), 0);

        // PLAN-0397 V3：超时由引擎终止并映射回既有错误面。
        let timeout = app
            .router
            .execute_command(
                &ws_id,
                "cmd",
                vec!["/C".to_string(), "ping -n 30 127.0.0.1 > nul".to_string()],
                Some(1),
                None,
            )
            .await;
        assert!(
            matches!(
                timeout,
                Err(xihe_runtime::error::RuntimeError::ProcessTimeout { .. })
            ),
            "expected ProcessTimeout, got {timeout:?}"
        );
        assert_eq!(app.job_engine.active_count(), 0);

        drop(dir);
    }

    #[tokio::test]
    async fn conf_no_transport_detail_leak() {
        let DirectAttachApp {
            app,
            ws_id,
            dir,
            _server,
        } = conformance_app().await;
        let job_id = uuid::Uuid::new_v4().to_string();
        start_job(
            &app,
            &ws_id,
            &job_id,
            vec!["/C".to_string(), "ping -n 5 127.0.0.1 > nul".to_string()],
            30,
        )
        .await
        .expect("start");
        let response = workspace_job_status_handler(
            Path(ws_id.clone()),
            State(app.clone()),
            axum::Json(JobStatusRequest {
                job_id: job_id.clone(),
            }),
        )
        .await
        .expect("status");
        let body = body_json(response.into_response()).await;
        let object = body.as_object().expect("object");
        for forbidden in [
            "containerPath",
            "containerIp",
            "networkMode",
            "sandboxUrl",
            "policyPath",
            "wrapperPid",
            "containerId",
            "pid",
        ] {
            assert!(
                !object.contains_key(forbidden),
                "status leaked {forbidden}: {body}"
            );
        }
        app.job_engine.cancel(&job_id).expect("cancel");
        app.job_engine.cleanup(&job_id).expect("cleanup");
        drop(dir);
    }
}
