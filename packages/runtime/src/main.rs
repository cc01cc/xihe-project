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
use bollard::Docker;
use bollard::query_parameters::{RemoveContainerOptions, StopContainerOptions};
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

mod config_client;
mod ws_file_handler;

use xihe_runtime::dotenv_loader;
use xihe_runtime::fetch;
use xihe_runtime::fetch::WebFetchResult;
use xihe_runtime::fs;
use xihe_runtime::fs::{EditFileResult, FileInfo, ReadFileRangeResult};
use xihe_runtime::gateway::{InstanceState, WorkspaceRegistry};
use xihe_runtime::device;
use xihe_runtime::mcp_process;
use xihe_runtime::mcp_process::McpProcessManager;
use xihe_runtime::storage;
use xihe_runtime::workspace::WorkspaceManager;
use tokio::sync::Mutex;
use xihe_runtime::remote_mcp::{
    RemoteMcpConnector, RemoteMcpError, RequestStateBinding, RequestStateStore,
    validate_endpoint_dns, validate_endpoint_with_allowlist,
};
use xihe_runtime::sandbox;

const CONTAINER_RUNTIME_PORT: u16 = 39001;

/// Shared runtime state for Axum handlers — holds the routing registry
/// and the Docker-backed WorkspaceManager. This converges the former dual
/// path (registry vs manager) into a single handler-owned state: every
/// create/delete updates both, fail-closed on Docker errors.
#[derive(Clone)]
pub struct AppState {
    pub registry: Arc<WorkspaceRegistry>,
    pub manager: Arc<Mutex<WorkspaceManager>>,
    pub device_id: String,
    /// Readiness: false until first successful hydrate (for now, set true after device_id ensured).
    /// In future, this will be set true only after `GET assignments` succeeds.
    pub ready: Arc<AtomicBool>,
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

async fn resolve_container_addr(ws_id: &str) -> Option<String> {
    let docker = Docker::connect_with_local_defaults().ok()?;
    let name = format!("xihe-workspace-ws_{ws_id}");
    let inspect = docker.inspect_container(&name, None).await.ok()?;
    let ip = inspect
        .network_settings?
        .networks?
        .values()
        .find_map(|ep| ep.ip_address.clone().filter(|ip| !ip.is_empty()))?;
    Some(format!("http://{ip}:{CONTAINER_RUNTIME_PORT}"))
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

fn resolve_security_profile_value(value: Option<&str>) -> SecurityProfile {
    match value.unwrap_or("strict") {
        "coding" => SecurityProfile::Coding,
        "isolated" => SecurityProfile::Isolated,
        _ => SecurityProfile::Strict,
    }
}

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
                let parsed: Vec<String> = serde_json::from_str::<Vec<String>>(t).unwrap_or_else(|_| {
                    serde_json::from_str::<Vec<serde_json::Value>>(t)
                        .map(|arr| {
                            arr.into_iter()
                                .map(|x| {
                                    x.as_str()
                                        .map(|s| s.to_string())
                                        .unwrap_or_else(|| x.to_string().trim_matches('"').to_string())
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
            .filter_map(|x| x.as_str().map(|s| s.to_string()).or_else(|| Some(x.to_string())))
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

#[derive(Debug, Clone)]
pub struct XiheRuntime {
    workspace: String,
    ws_id: String,
    #[allow(dead_code)]
    profile: SecurityProfile,
    container_addr: Option<String>,
}

#[tool_router]
impl XiheRuntime {
    pub fn new(
        ws_id: &str,
        workspace_path: &str,
        profile: SecurityProfile,
        container_addr: Option<String>,
    ) -> Self {
        Self {
            workspace: workspace_path.to_string(),
            ws_id: ws_id.to_string(),
            profile,
            container_addr,
        }
    }

    /// POST to container-runtime endpoint.
    /// If successful, returns the raw JSON body. On HTTP error, returns the error body text.
    async fn container_post(
        &self,
        endpoint: &str,
        body: &impl serde::Serialize,
    ) -> Result<serde_json::Value, String> {
        let base = self
            .container_addr
            .as_ref()
            .ok_or_else(|| "no container".to_string())?;
        let url = format!("{base}{endpoint}");
        let resp = http_client()
            .post(&url)
            .json(body)
            .send()
            .await
            .map_err(|e| format!("container-runtime request failed: {e}"))?;
        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("container-runtime error ({endpoint}): {text}"));
        }
        resp.json::<serde_json::Value>()
            .await
            .map_err(|e| format!("container-runtime response parse failed: {e}"))
    }

    #[tool(description = "Read file content from the workspace")]
    async fn read_file(
        &self,
        Parameters(ReadFileRequest { path }): Parameters<ReadFileRequest>,
    ) -> Result<String, String> {
        if self.container_addr.is_some() {
            #[derive(serde::Serialize)]
            struct Req {
                path: String,
            }
            let resp = self
                .container_post("/fs/read", &Req { path: path.clone() })
                .await?;
            return resp["content"]
                .as_str()
                .map(|s| s.to_string())
                .ok_or_else(|| "invalid response from container-runtime".to_string());
        }
        fs::read_file(&path, &self.workspace)
            .await
            .map_err(|e| e.to_string())
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
        if self.container_addr.is_some() {
            let resp = self
                .container_post(
                    "/fs/read_range",
                    &serde_json::json!({
                        "path": path, "offset": offset, "limit": limit
                    }),
                )
                .await?;
            let result: ReadFileRangeResult =
                serde_json::from_value(resp).map_err(|e| format!("deserialize read_range: {e}"))?;
            return Ok(Json(result));
        }
        fs::read_file_range(&path, offset, limit, &self.workspace)
            .await
            .map_err(|e| e.to_string())
            .map(Json)
    }

    #[tool(description = "Write content to a file in the workspace")]
    async fn write_file(
        &self,
        Parameters(WriteFileRequest { path, content }): Parameters<WriteFileRequest>,
    ) -> Result<String, String> {
        if self.container_addr.is_some() {
            let _ = self
                .container_post(
                    "/fs/write",
                    &serde_json::json!({
                        "path": path, "content": content
                    }),
                )
                .await?;
            return Ok(format!("Written {} bytes to {}", content.len(), path));
        }
        fs::write_file(&path, &content, &self.workspace)
            .await
            .map_err(|e| e.to_string())
    }

    #[tool(description = "List directory contents with file metadata")]
    async fn list_directory(
        &self,
        Parameters(ListDirectoryRequest { path }): Parameters<ListDirectoryRequest>,
    ) -> Result<Json<fs::DirectoryListing>, String> {
        if self.container_addr.is_some() {
            let resp = self
                .container_post("/fs/list", &serde_json::json!({ "path": path }))
                .await?;
            let entries: Vec<fs::FileInfo> =
                serde_json::from_value(resp).map_err(|e| format!("deserialize list: {e}"))?;
            return Ok(Json(fs::DirectoryListing { entries }));
        }
        let entries = fs::list_directory(&path, &self.workspace).map_err(|e| e.to_string())?;
        Ok(Json(fs::DirectoryListing { entries }))
    }

    #[tool(description = "Match files using glob pattern")]
    async fn glob(
        &self,
        Parameters(GlobRequest { pattern, path }): Parameters<GlobRequest>,
    ) -> Result<Json<fs::GlobResults>, String> {
        if self.container_addr.is_some() {
            let resp = self
                .container_post(
                    "/fs/glob",
                    &serde_json::json!({ "pattern": pattern, "path": path }),
                )
                .await?;
            let matches: Vec<String> = serde_json::from_value(resp["matches"].clone())
                .map_err(|e| format!("deserialize glob: {e}"))?;
            return Ok(Json(fs::GlobResults { matches }));
        }
        let matches =
            fs::glob_files(&pattern, &path, &self.workspace).map_err(|e| e.to_string())?;
        Ok(Json(fs::GlobResults { matches }))
    }

    #[tool(description = "Search files using regular expression")]
    async fn grep(
        &self,
        Parameters(GrepRequest { pattern, path }): Parameters<GrepRequest>,
    ) -> Result<Json<fs::GrepResults>, String> {
        if self.container_addr.is_some() {
            let resp = self
                .container_post(
                    "/fs/grep",
                    &serde_json::json!({ "pattern": pattern, "path": path }),
                )
                .await?;
            let matches: Vec<fs::MatchResult> = serde_json::from_value(resp["matches"].clone())
                .map_err(|e| format!("deserialize grep: {e}"))?;
            return Ok(Json(fs::GrepResults { matches }));
        }
        let matches =
            fs::grep_files(&pattern, &path, &self.workspace).map_err(|e| e.to_string())?;
        Ok(Json(fs::GrepResults { matches }))
    }

    #[tool(description = "Execute a shell command inside a sandboxed Docker container")]
    async fn execute_command(
        &self,
        Parameters(ExecuteCommandRequest {
            command,
            args: _args,
            timeout,
            truncate_limit,
        }): Parameters<ExecuteCommandRequest>,
    ) -> Result<Json<CommandResult>, String> {
        if self.container_addr.is_some() {
            #[derive(serde::Serialize)]
            struct Req {
                command: String,
                timeout_secs: Option<u64>,
            }
            let resp = self
                .container_post(
                    "/exec",
                    &Req {
                        command: command.clone(),
                        timeout_secs: timeout,
                    },
                )
                .await?;
            let mut result = CommandResult {
                stdout: resp["stdout"].as_str().unwrap_or_default().to_string(),
                stderr: resp["stderr"].as_str().unwrap_or_default().to_string(),
                exit_code: resp["exit_code"].as_i64().unwrap_or(-1),
                success: resp["exit_code"].as_i64() == Some(0),
                artifact_id: None,
            };
            if let Some(limit) = truncate_limit {
                let limit_usize = limit as usize;
                if result.stdout.len() > limit_usize {
                    let artifact_id = sandbox::store_artifact(&result.stdout, limit_usize);
                    result.stdout = format!(
                        "[Output truncated to {limit_usize} chars. Use read_command_output with artifact_id={artifact_id} to retrieve]"
                    );
                    result.artifact_id = Some(artifact_id);
                }
            }
            return Ok(Json(result));
        }
        // Strict profile fallback — no container available
        Err("execute_command requires a workspace container (Coding/Isolated profile)".into())
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
        match sandbox::read_artifact(&artifact_id, offset, limit) {
            Some(lines) => Ok(Json(lines)),
            None => Err(format!("Artifact not found: {artifact_id}")),
        }
    }

    #[tool(description = "Get file or directory metadata")]
    async fn get_file_info(
        &self,
        Parameters(GetFileInfoRequest { path }): Parameters<GetFileInfoRequest>,
    ) -> Result<Json<FileInfo>, String> {
        let result = fs::get_file_info(&path, &self.workspace).map_err(|e| e.to_string())?;
        Ok(Json(result))
    }

    #[tool(description = "Watch a directory for file system events (2s poll)")]
    async fn watch_directory(
        &self,
        Parameters(WatchDirectoryRequest { path }): Parameters<WatchDirectoryRequest>,
    ) -> Result<Json<fs::FileEventList>, String> {
        let workspace = self.workspace.clone();
        let events = tokio::task::spawn_blocking(move || fs::watch_directory(&path, &workspace))
            .await
            .map_err(|e| format!("Task failed: {e}"))?
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
        let result = fs::edit_file(
            &file_path,
            &old_string,
            &new_string,
            replace_all.unwrap_or(false),
            &self.workspace,
        )
        .await
        .map_err(|e| e.to_string())?;
        Ok(Json(result))
    }

    #[tool(description = "Delete a file")]
    async fn delete_file(
        &self,
        Parameters(DeleteFileRequest { path }): Parameters<DeleteFileRequest>,
    ) -> Result<String, String> {
        fs::delete_file(&path, &self.workspace)
            .await
            .map_err(|e| e.to_string())
    }

    #[tool(description = "Delete a directory (requires recursive=true for non-empty dirs)")]
    async fn delete_directory(
        &self,
        Parameters(DeleteDirectoryRequest { path, recursive }): Parameters<DeleteDirectoryRequest>,
    ) -> Result<String, String> {
        fs::delete_directory(&path, recursive.unwrap_or(false), &self.workspace)
            .await
            .map_err(|e| e.to_string())
    }

    #[tool(description = "Move or rename a file or directory")]
    async fn move_file(
        &self,
        Parameters(MoveFileRequest { from, to }): Parameters<MoveFileRequest>,
    ) -> Result<String, String> {
        fs::move_file(&from, &to, &self.workspace)
            .await
            .map_err(|e| e.to_string())
    }

    #[tool(description = "Copy a file")]
    async fn copy_file(
        &self,
        Parameters(CopyFileRequest { from, to }): Parameters<CopyFileRequest>,
    ) -> Result<String, String> {
        fs::copy_file(&from, &to, &self.workspace)
            .await
            .map_err(|e| e.to_string())
    }

    #[tool(description = "Create a directory (recursive, creates parents as needed)")]
    async fn mkdir(
        &self,
        Parameters(MkdirRequest { path }): Parameters<MkdirRequest>,
    ) -> Result<String, String> {
        fs::mkdir(&path, &self.workspace)
            .await
            .map_err(|e| e.to_string())
    }

    #[tool(description = "Extract text content from a PDF file")]
    async fn extract_pdf_text(
        &self,
        Parameters(ExtractPdfTextRequest { path }): Parameters<ExtractPdfTextRequest>,
    ) -> Result<String, String> {
        fs::extract_pdf_text(&path, &self.workspace)
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

    #[tool(description = "Execute a long-running command in the background and return a PID")]
    async fn start_background_process(
        &self,
        Parameters(ExecuteCommandRequest {
            command,
            args: _args,
            timeout: _timeout,
            truncate_limit: _truncate,
        }): Parameters<ExecuteCommandRequest>,
    ) -> Result<String, String> {
        let pid = sandbox::register_background_process(&self.ws_id, &command);
        if self.container_addr.is_some() {
            let base = self.container_addr.clone().unwrap();
            let cmd = command.clone();
            tokio::spawn(async move {
                let client = http_client();
                let url = format!("{base}/exec");
                let _ = client
                    .post(&url)
                    .json(&serde_json::json!({ "command": cmd, "timeout_secs": null }))
                    .send()
                    .await;
            });
        }
        Ok(pid)
    }

    #[tool(description = "List all background processes for this workspace")]
    async fn list_background_processes(
        &self,
    ) -> Result<Json<Vec<sandbox::BackgroundProcess>>, String> {
        Ok(Json(sandbox::list_background_processes(&self.ws_id)))
    }

    #[tool(description = "Get status of a background process by PID")]
    async fn get_background_process(
        &self,
        Parameters(GetFileInfoRequest { path: pid }): Parameters<GetFileInfoRequest>,
    ) -> Result<Json<sandbox::BackgroundProcess>, String> {
        sandbox::get_background_process(&pid)
            .map(Json)
            .ok_or_else(|| format!("Background process not found: {pid}"))
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

#[derive(Debug, Deserialize)]
struct CreateWorkspaceRequest {
    #[serde(rename = "workspaceId")]
    ws_id: String,
    #[serde(rename = "workspacePath")]
    workspace_path: String,
    #[serde(rename = "storageRef")]
    storage_ref: Option<String>,
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
    if app.registry.get(&workspace_id).await.is_none() {
        return Err((
            StatusCode::NOT_FOUND,
            [(axum::http::header::CONTENT_TYPE, "application/problem+json")],
            AxumJson(
                serde_json::json!({"type":"https://xihe.dev/problems/workspace-not-found","title":"Workspace not found","status":404,"code":"WORKSPACE_NOT_FOUND","detail":"Workspace is not registered","requestId":uuid::Uuid::new_v4().to_string()}),
            ),
        ));
    }
    if request.user_id.trim().is_empty()
        || request.tool.trim().is_empty()
        || request.scope.trim().is_empty()
    {
        return Err((
            StatusCode::BAD_REQUEST,
            [(axum::http::header::CONTENT_TYPE, "application/problem+json")],
            AxumJson(
                serde_json::json!({"type":"https://xihe.dev/problems/invalid-request","title":"Invalid request","status":400,"code":"INVALID_REQUEST","detail":"userId and tool are required","requestId":uuid::Uuid::new_v4().to_string()}),
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
    let token = fetch_remote_mcp_token(
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
        })?;
    let store = REMOTE_REQUEST_STATES
        .get_or_init(RequestStateStore::default)
        .clone();
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
        Err(RemoteMcpError::AuthorizationRequired) => {
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
    let port = NEXT_BRIDGE_PORT.fetch_add(1, Ordering::Relaxed);
    // Cycle back into range 39000-39999 if we overflow
    if port >= 40000 {
        NEXT_BRIDGE_PORT.store(39000, Ordering::Relaxed);
        39000
    } else {
        port
    }
}

async fn mcp_spawn_handler(
    Path(ws_id): Path<String>,
    State(app): State<Arc<AppState>>,
    AxumJson(req): AxumJson<McpSpawnRequest>,
) -> Result<AxumJson<McpSpawnResponse>, StatusCode> {
    app.registry.get(&ws_id).await.ok_or(StatusCode::NOT_FOUND)?;

    let container_name = format!("xihe-workspace-ws_{ws_id}");
    let docker =
        Docker::connect_with_local_defaults().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let port = allocate_bridge_port();
    let bridge_cmd = format!(
        "/usr/local/bin/xihe-mcp-bridge --port {} & echo $! > /workspace/.xihe-bridge-{}.pid",
        port, req.server_id
    );

    let exec = docker
        .create_exec(
            &container_name,
            bollard::exec::CreateExecOptions {
                cmd: Some(vec!["sh".to_string(), "-c".to_string(), bridge_cmd]),
                attach_stdout: Some(false),
                attach_stderr: Some(false),
                ..Default::default()
            },
        )
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    docker
        .start_exec(
            &exec.id,
            Some(bollard::exec::StartExecOptions {
                detach: true,
                ..Default::default()
            }),
        )
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let container_ip = resolve_container_ip(&docker, &container_name)
        .await
        .unwrap_or_else(|_| "127.0.0.1".to_string());

    let manager = mcp_manager();
    manager
        .spawn(
            &ws_id,
            &req.server_id,
            &req.command,
            &req.args,
            &container_ip,
            port,
        )
        .await;

    let url = format!("http://{}:{}/{}", container_ip, port, req.server_id);
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
) -> AxumJson<serde_json::Value> {
    let manager = mcp_manager();
    let _removed = manager.stop(&ws_id, &server_id).await;
    AxumJson(serde_json::json!({"status": "ok"}))
}

async fn mcp_list_handler(Path(ws_id): Path<String>) -> AxumJson<serde_json::Value> {
    let manager = mcp_manager();
    let bridges = manager.list(&ws_id).await;
    AxumJson(serde_json::json!({
        "servers": bridges,
        "count": bridges.len()
    }))
}

async fn mcp_stdio_handler(
    Path((ws_id, server_id)): Path<(String, String)>,
    body: axum::body::Bytes,
) -> Result<axum::response::Response, StatusCode> {
    let manager = mcp_manager();
    let bridge_url = manager
        .get_bridge_url(&ws_id, &server_id)
        .await
        .ok_or(StatusCode::NOT_FOUND)?;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{bridge_url}/{server_id}"))
        .header("Content-Type", "application/json")
        .body(body.to_vec())
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;

    let status = resp.status();
    let body = resp.bytes().await.map_err(|_| StatusCode::BAD_GATEWAY)?;

    Ok(axum::response::Response::builder()
        .status(status)
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(body))
        .unwrap())
}

async fn workspace_mcp_handler(
    Path(ws_id): Path<String>,
    req: axum::extract::Request,
) -> axum::response::Response {
    CURRENT_WS_ID
        .scope(ws_id, async {
            let mut svc = MCP_SERVICE
                .get()
                .expect("MCP_SERVICE not initialized")
                .clone();
            let response = svc.call(req).await.unwrap();
            response.map(axum::body::Body::new)
        })
        .await
}

async fn resolve_container_ip(docker: &Docker, container_name: &str) -> Result<String, String> {
    docker
        .inspect_container(container_name, None)
        .await
        .map_err(|e| format!("inspect failed: {e}"))
        .and_then(|inspect| {
            inspect
                .network_settings
                .and_then(|ns| ns.networks)
                .and_then(|networks| {
                    networks
                        .values()
                        .find_map(|ep| ep.ip_address.clone().filter(|ip| !ip.is_empty()))
                })
                .ok_or_else(|| "no IP found".to_string())
        })
}

async fn create_workspace_handler(
    State(app): State<Arc<AppState>>,
    AxumJson(req): AxumJson<CreateWorkspaceRequest>,
) -> AxumJson<CreateWorkspaceResponse> {
    let profile = match req.profile.as_deref() {
        Some("coding") => SecurityProfile::Coding,
        Some("isolated") => SecurityProfile::Isolated,
        _ => SecurityProfile::Strict,
    };
    // M1a: storageRef → hostRoot resolver with strict allowlist + canonical + ownership check (grill B1/B2).
    let effective_path = if let Some(ref sref) = req.storage_ref {
        if let Ok(host_root) = std::env::var("XIHE_WORKSPACE_HOST_ROOT") {
            match storage::resolve_host_path(&host_root, sref, &req.ws_id).await {
                Ok(p) => p.to_string_lossy().to_string(),
                Err(e) => {
                    tracing::error!(
                        "storage resolve failed ws_id={} sref={:?} hostRoot={:?} err={}",
                        req.ws_id, sref, host_root, e
                    );
                    return AxumJson(CreateWorkspaceResponse {
                        status: format!("error: STORAGE_BINDING_INVALID: {}", e),
                        ws_id: req.ws_id,
                    });
                }
            }
        } else {
            tracing::warn!(
                "XIHE_WORKSPACE_HOST_ROOT not set, fallback to workspacePath for ws_id={}",
                req.ws_id
            );
            req.workspace_path.clone()
        }
    } else {
        tracing::warn!(
            "storageRef missing for ws_id={}, fallback to workspacePath (legacy)",
            req.ws_id
        );
        req.workspace_path.clone()
    };

    // Strict profile: no container (network none, read-only rootfs, 127.0.0.1:39001 unreachable).
    // Keep host-direct fallback for Strict; fail-closed only applies to Coding/Isolated.
    // For M1b consistency, Strict also writes the fixed sentinel so file API can verify mount (host-only).
    if profile == SecurityProfile::Strict {
        app.registry
            .register_with_profile(&req.ws_id, &effective_path, profile)
            .await;
        if let Err(err) = std::fs::create_dir_all(&effective_path) {
            tracing::error!(
                "Failed to create workspace directory {} (resolved from {:?} / {:?}): {}",
                effective_path, req.workspace_path, req.storage_ref, err
            );
        } else {
            let sentinel_path = std::path::Path::new(&effective_path).join(".xihe-sentinel");
            let _ = std::fs::write(&sentinel_path, format!("sentinel-{}", req.ws_id));
        }
        tracing::info!(
            "Workspace registered via API (Strict, no container): ws_id={}, path={}, storageRef={:?}, effective_path={}",
            req.ws_id, req.workspace_path, req.storage_ref, effective_path
        );
        return AxumJson(CreateWorkspaceResponse {
            status: "ok".to_string(),
            ws_id: req.ws_id,
        });
    }

    // Coding/Isolated: must create Docker container — fail-closed on Docker errors.
    let image = std::env::var("XIHE_WORKSPACE_IMAGE").unwrap_or_else(|_| "xihe/workspace".to_string());
    let mut mgr = app.manager.lock().await;

    // Idempotency: if manager already tracks this ws, just ensure registry and return.
    if mgr.get_state(&req.ws_id).is_some() {
        app.registry
            .register_with_profile(&req.ws_id, &effective_path, profile)
            .await;
        tracing::info!(
            "Workspace already tracked in manager, re-registered: ws_id={}, path={}",
            req.ws_id, effective_path
        );
        return AxumJson(CreateWorkspaceResponse {
            status: "ok".to_string(),
            ws_id: req.ws_id,
        });
    }

    match mgr
        .create_workspace(&req.ws_id, &effective_path, profile, &image)
        .await
    {
        Ok(state) => {
            // Also register in routing registry so MCP factory can resolve workspace_path.
            app.registry
                .register_with_profile(&req.ws_id, &effective_path, profile)
                .await;
            tracing::info!(
                "Workspace created with container: ws_id={}, path={}, container={}, image={}, profile={:?}",
                req.ws_id, effective_path, state.container_name, image, profile
            );
            AxumJson(CreateWorkspaceResponse {
                status: "ok".to_string(),
                ws_id: req.ws_id,
            })
        }
        Err(err) => {
            let msg = err.to_string();
            // Docker name conflict after restart (manager HashMap empty but container exists externally) → treat as ok, re-register.
            let is_conflict = msg.contains("already exists")
                || msg.contains("Conflict")
                || msg.contains("is already in use")
                || msg.contains("already in use");
            if is_conflict {
                tracing::warn!(
                    "Workspace container already exists externally, re-registering: ws_id={}, err={}",
                    req.ws_id, msg
                );
                app.registry
                    .register_with_profile(&req.ws_id, &effective_path, profile)
                    .await;
                // Ensure host dir exists even if container existed
                let _ = std::fs::create_dir_all(&effective_path);
                return AxumJson(CreateWorkspaceResponse {
                    status: "ok".to_string(),
                    ws_id: req.ws_id,
                });
            }
            tracing::error!(
                "Failed to create workspace container ws_id={}, path={}, image={}, err={}",
                req.ws_id, effective_path, image, msg
            );
            // Fail-closed: do NOT register, do NOT create fallback dir. Return error status so caller can observe.
            AxumJson(CreateWorkspaceResponse {
                status: format!("error: {msg}"),
                ws_id: req.ws_id,
            })
        }
    }
}

async fn delete_workspace_handler(
    State(app): State<Arc<AppState>>,
    AxumJson(req): AxumJson<DeleteWorkspaceRequest>,
) -> AxumJson<DeleteWorkspaceResponse> {
    let ws_id = &req.ws_id;
    mcp_manager().cleanup_workspace(ws_id).await;
    // Try to remove via manager (stops container + removes dir) if tracked; ignore not-found.
    // For Strict (no container), manager won't track, so we also remove host dir via registry.
    let is_tracked = {
        let mgr = app.manager.lock().await;
        mgr.get_state(ws_id).is_some()
    };
    if is_tracked {
        let mut mgr = app.manager.lock().await;
        if let Err(e) = mgr.delete_workspace(ws_id).await {
            tracing::warn!("Manager delete failed for ws_id={}: {}", ws_id, e);
        } else {
            tracing::info!("Workspace container removed via manager: ws_id={}", ws_id);
        }
    } else {
        // Manager not tracking (e.g. Strict). Remove host dir via registry's workspace_path.
        if let Some(instance) = app.registry.get(ws_id).await {
            let _ = tokio::fs::remove_dir_all(&instance.workspace_path).await;
            tracing::info!("Strict host dir removed for ws_id={}: {}", ws_id, instance.workspace_path);
        }
        // Also try best-effort docker removal for orphan containers
        let name = format!("xihe-workspace-ws_{ws_id}");
        if let Ok(docker) = Docker::connect_with_local_defaults() {
            let _ = docker
                .remove_container(
                    &name,
                    Some(RemoveContainerOptions {
                        force: true,
                        v: true,
                        link: false,
                    }),
                )
                .await;
        }
    }
    app.registry.unregister(ws_id).await;
    tracing::info!("Workspace deleted: ws_id={}, registry + manager cleaned", ws_id);
    AxumJson(DeleteWorkspaceResponse {
        status: "ok".to_string(),
        ws_id: ws_id.clone(),
    })
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenv_loader::load();

    // Initialize CP ConfigClient (non-blocking on failure, uses env fallback)
    config_client::init_global_config_client().await;

    // Resolve CP-managed values locally; changing process-wide environment is unsafe in edition 2024.
    let log_dir = config_client::get_cp("logging", "logDir")
        .await
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var("XIHE_LOG_DIR").ok())
        .unwrap_or_else(|| "logs".to_string());
    let log_level = config_client::get_cp("logging", "logLevel").await;
    let runtime_log_level = config_client::get_cp("logging", "levelRuntime").await;
    let runtime_log_filter = config_client::get_cp("logging", "runtimeFilter").await;
    let profile_name = match config_client::get_cp("workspace-config", "profile").await {
        Some(value) if !value.is_empty() => Some(value),
        _ => match config_client::get_cp("logging", "profile").await {
            Some(value) if !value.is_empty() => Some(value),
            _ => std::env::var("XIHE_WORKSPACE_PROFILE").ok(),
        },
    };
    let security_profile = resolve_security_profile_value(profile_name.as_deref());
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
            tracing_subscriber::fmt::layer().with_writer(|| {
                xihe_runtime::log_redact::RedactingWriter::new(std::io::stdout())
            }),
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
    // M2-3.1: device_id persistence (grill A random UUID file)
    let state_dir = device::resolve_state_dir();
    let device_id = match device::ensure_device_id(&state_dir).await {
        Ok(id) => id,
        Err(e) => {
            tracing::warn!("device_id init failed (state_dir={:?}): {}, using ephemeral", state_dir, e);
            uuid::Uuid::new_v4().to_string()
        }
    };
    let readiness = Arc::new(AtomicBool::new(false));
    let app_state = Arc::new(AppState {
        registry: registry.clone(),
        manager: manager.clone(),
        device_id: device_id.clone(),
        ready: readiness.clone(),
    });

    tracing::info!(
        "Starting xihe Runtime MCP Server (Gateway mode) on {} (device_id={})",
        bind_addr, device_id
    );
    // For v1, readiness is true after device_id ensured. Future hydrate will gate it.
    readiness.store(true, Ordering::Relaxed);
    tracing::info!("readiness: true (device_id ready, hydrate not yet required for v1)");

    let ct = tokio_util::sync::CancellationToken::new();

    let reaper_registry = registry.clone();
    let reaper_ct = ct.child_token();
    tokio::spawn(async move {
        idle_reaper_loop(reaper_registry, reaper_ct).await;
    });

    let mcp_manager = mcp_manager();
    let cp_poll_registry = registry.clone();
    let poll_ct = ct.child_token();
    tokio::spawn(async move {
        mcp_config_poll_loop(mcp_manager, cp_poll_registry, poll_ct).await;
    });

    let workspace_path =
        std::env::var("XIHE_WORKSPACE").unwrap_or_else(|_| "/tmp/xihe-workspace".to_string());
    let wp = workspace_path.clone();

    let service_registry = registry.clone();
    let wp_for_single = wp.clone();
    let service = StreamableHttpService::new(
        move || {
            let ws_id = CURRENT_WS_ID
                .try_with(|id| id.clone())
                .unwrap_or_else(|_| "default".to_string());
            let profile = security_profile;
            let container_addr = match profile {
                SecurityProfile::Strict => None,
                _ => tokio::runtime::Handle::current().block_on(resolve_container_addr(&ws_id)),
            };
            let ws_root = match service_registry.try_get(&ws_id) {
                Some(instance) => instance.workspace_path.clone(),
                None => {
                    // Fail-closed: unknown workspace must not silently use default directory.
                    // Only explicit single-workspace mode may fall back, and must be logged.
                    let single_mode =
                        std::env::var("XIHE_SINGLE_WORKSPACE_MODE").as_deref() == Ok("true");
                    if single_mode {
                        tracing::warn!(
                            "single_workspace_fallback: ws_id={} not registered, using XIHE_WORKSPACE={}",
                            ws_id, wp_for_single
                        );
                        wp_for_single.clone()
                    } else {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::NotFound,
                            format!(
                                "workspace not registered: {} (WORKSPACE_NOT_REGISTERED)",
                                ws_id
                            ),
                        ));
                    }
                }
            };
            Ok(XiheRuntime::new(&ws_id, &ws_root, profile, container_addr))
        },
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default()
            .with_cancellation_token(ct.child_token())
            .with_allowed_hosts(["localhost", "127.0.0.1", "runtime", "runtime:8001"]),
    );
    let _ = MCP_SERVICE.set(service);

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
            mgr.list_workspaces().iter().map(|s| s.ws_id.clone()).collect()
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
                let mgr = app_state.manager.lock().await;
                mgr.stop_container(&ws_id).await
            };
            match res {
                Ok(_) => tracing::info!("sandbox_stopped: ws_id={}", ws_id),
                Err(e) => {
                    let msg = e.to_string();
                    if msg.contains("SandboxNotFound") || msg.contains("not found") {
                        tracing::info!("sandbox_stop_skipped: ws_id={} not tracked", ws_id);
                    } else {
                        tracing::warn!("sandbox_stop_failed: ws_id={} err={}", ws_id, msg);
                    }
                }
            }
            // Best-effort: also try to stop any orphan docker container by name (manager HashMap may be empty after restart).
            let name = format!("xihe-workspace-ws_{ws_id}");
            if let Ok(docker) = Docker::connect_with_local_defaults() {
                let _ = docker
                    .stop_container(&name, Some(StopContainerOptions { t: Some(10), ..Default::default() }))
                    .await;
            }
        }
    }
    tracing::info!("runtime_shutdown_finished: managed sandboxes drained, host storage preserved");

    Ok(())
}

async fn mcp_config_poll_loop(
    manager: &'static mcp_process::McpProcessManager,
    registry: Arc<WorkspaceRegistry>,
    ct: tokio_util::sync::CancellationToken,
) {
    let cp_url = std::env::var("XIHE_CP_URL").unwrap_or_else(|_| "http://localhost:12631".into());
    let cp_api_token =
        std::env::var("XIHE_CP_API_TOKEN").unwrap_or_else(|_| "dev-token-not-secure".into());
    let docker = match Docker::connect_with_local_defaults() {
        Ok(d) => Some(d),
        Err(e) => {
            tracing::warn!("Docker unavailable in config poll loop: {e}, spawn disabled");
            None
        }
    };
    let mut interval = tokio::time::interval(mcp_process::CONFIG_POLL_INTERVAL);
    loop {
        tokio::select! {
            _ = ct.cancelled() => break,
            _ = interval.tick() => {
                let Some(ref docker) = docker else { continue };
                let instances = registry.all_instances().await;
                for instance in &instances {
                    let ws_id = &instance.ws_id;
                    let servers = manager.poll_config(ws_id, &cp_url, &cp_api_token).await;
                    let existing = manager.list(ws_id).await;
                    for (server_id, command, args) in &servers {
                        if existing.iter().any(|b| b.server_id == *server_id) {
                            continue;
                        }
                        tracing::info!(
                            "config poll: spawning {}/{} ({})",
                            ws_id, server_id, command
                        );

                        let port = allocate_bridge_port();
                        let container_name = format!("xihe-workspace-ws_{ws_id}");
                        let bridge_cmd = format!(
                            "/usr/local/bin/xihe-mcp-bridge --port {port} & echo $! > /workspace/.xihe-bridge-{server_id}.pid"
                        );

                        let exec = match docker.create_exec(
                            &container_name,
                            bollard::exec::CreateExecOptions {
                                cmd: Some(vec!["sh".to_string(), "-c".to_string(), bridge_cmd]),
                                attach_stdout: Some(false),
                                attach_stderr: Some(false),
                                ..Default::default()
                            },
                        ).await {
                            Ok(exec) => exec,
                            Err(e) => {
                                tracing::warn!("config poll: failed to create exec for {}/{}: {e}", ws_id, server_id);
                                continue;
                            }
                        };

                        if let Err(e) = docker.start_exec(
                            &exec.id,
                            Some(bollard::exec::StartExecOptions {
                                detach: true,
                                ..Default::default()
                            }),
                        ).await {
                            tracing::warn!("config poll: failed to start bridge for {}/{}: {e}", ws_id, server_id);
                            continue;
                        }

                        let container_ip = resolve_container_ip(docker, &container_name).await
                            .unwrap_or_else(|_| "127.0.0.1".to_string());

                        manager.spawn(ws_id, server_id, command, args, &container_ip, port).await;
                        tracing::info!("config poll: bridge {}/{} spawned at {}:{}", ws_id, server_id, container_ip, port);
                    }

                    // Remove servers no longer in config
                    let configured_ids: std::collections::HashSet<&str> = servers.iter().map(|(id, _, _)| id.as_str()).collect();
                    for bridge_info in &existing {
                        if !configured_ids.contains(bridge_info.server_id.as_str()) {
                            tracing::info!("config poll: stopping removed server {}/{}", ws_id, bridge_info.server_id);
                            manager.stop(ws_id, &bridge_info.server_id).await;
                            // Docker kill the bridge process inside the container
                            let kill_cmd = format!(
                                "kill $(cat /workspace/.xihe-bridge-{}.pid 2>/dev/null) 2>/dev/null; \
                                 rm -f /workspace/.xihe-bridge-{}.pid",
                                bridge_info.server_id, bridge_info.server_id
                            );
                            let container_name = format!("xihe-workspace-ws_{ws_id}");
                            if let Ok(exec) = docker.create_exec(
                                &container_name,
                                bollard::exec::CreateExecOptions {
                                    cmd: Some(vec!["sh".to_string(), "-c".to_string(), kill_cmd]),
                                    attach_stdout: Some(false),
                                    attach_stderr: Some(false),
                                    ..Default::default()
                                },
                            ).await {
                                let _ = docker.start_exec(
                                    &exec.id,
                                    Some(bollard::exec::StartExecOptions {
                                        detach: true,
                                        ..Default::default()
                                    }),
                                ).await;
                            }
                        }
                    }
                }
            }
        }
    }
    tracing::info!("MCP config polling stopped");
}

async fn idle_reaper_loop(
    registry: Arc<WorkspaceRegistry>,
    ct: tokio_util::sync::CancellationToken,
) {
    let docker = match Docker::connect_with_local_defaults() {
        Ok(d) => d,
        Err(e) => {
            tracing::error!("Failed to connect to Docker in idle reaper: {}", e);
            return;
        }
    };

    let mut ticker = interval(Duration::from_secs(60));

    loop {
        tokio::select! {
            _ = ct.cancelled() => {
                tracing::info!("Idle reaper cancelled");
                break;
            }
            _ = ticker.tick() => {
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
                    let name = format!("xihe-workspace-ws_{ws_id}");

                    // Tier 4: 7 days idle — Suspended → Released (rmdir workspace dir)
                    if elapsed >= Duration::from_secs(604800) && instance.state == InstanceState::Suspended {
                        match tokio::fs::remove_dir_all(&instance.workspace_path).await {
                            Ok(_) => {
                                registry.set_state(ws_id, InstanceState::Released).await;
                                tracing::info!("Idle reaper: released workspace {} (idle >7d)", ws_id);
                            }
                            Err(e) => {
                                tracing::warn!("Idle reaper: failed to remove dir {}: {}", ws_id, e);
                            }
                        }
                        continue;
                    }

                    // Tier 3: 24 hours idle — Stopped → Suspended (remove container, keep dir)
                    if elapsed >= Duration::from_secs(86400) && instance.state == InstanceState::Stopped {
                        match docker.remove_container(&name, Some(RemoveContainerOptions { force: true, v: true, link: false })).await {
                            Ok(_) => {
                                registry.set_state(ws_id, InstanceState::Suspended).await;
                                tracing::info!("Idle reaper: suspended workspace {} (idle >24h)", ws_id);
                            }
                            Err(e) => {
                                tracing::warn!("Idle reaper: failed to remove container {}: {}", ws_id, e);
                            }
                        }
                        continue;
                    }

                    // Tier 2: 2 hours idle — Active/Paused → Stopped
                    if elapsed >= Duration::from_secs(7200) && (instance.state == InstanceState::Active || instance.state == InstanceState::Paused) {
                        match docker.stop_container(&name, Some(StopContainerOptions { t: Some(10), ..Default::default() })).await {
                            Ok(_) => {
                                registry.set_state(ws_id, InstanceState::Stopped).await;
                                tracing::info!("Idle reaper: stopped container {} (idle >2h)", ws_id);
                            }
                            Err(e) => {
                                tracing::warn!("Idle reaper: failed to stop container {}: {}", ws_id, e);
                            }
                        }
                        continue;
                    }

                    // Tier 1: 15 minutes idle — Active → Paused
                    if elapsed >= Duration::from_secs(900) && instance.state == InstanceState::Active {
                        match docker.pause_container(&name).await {
                            Ok(_) => {
                                registry.set_state(ws_id, InstanceState::Paused).await;
                                tracing::info!("Idle reaper: paused container {} (idle >15m)", ws_id);
                            }
                            Err(e) => {
                                tracing::warn!("Idle reaper: failed to pause container {}: {}", ws_id, e);
                            }
                        }
                    }
                }
            }
        }
    }
}
