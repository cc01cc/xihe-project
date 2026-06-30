use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU16, Ordering};

use axum::extract::State;
use axum::routing::{any, delete, get, post};
use axum::Json as AxumJson;
use axum::{extract::Path, http::StatusCode, Router};
use bollard::query_parameters::{RemoveContainerOptions, StopContainerOptions};
use bollard::Docker;
use rmcp::handler::server::wrapper::Json;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService,
};
use rmcp::{schemars, tool, tool_router};
use serde::{Deserialize, Serialize};
use tower::Service;
use tower_http::cors::{Any, CorsLayer};
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;
use tokio::time::interval;

mod config_client;
mod ws_file_handler;

use xihe_runtime::dotenv_loader;
use xihe_runtime::fetch;
use xihe_runtime::fetch::WebFetchResult;
use xihe_runtime::fs;
use xihe_runtime::fs::{EditFileResult, FileInfo, ReadFileRangeResult};
use xihe_runtime::gateway::{WorkspaceRegistry, InstanceState};
use xihe_runtime::mcp_process;
use xihe_runtime::mcp_process::McpProcessManager;
use xihe_runtime::sandbox;

const CONTAINER_RUNTIME_PORT: u16 = 39001;

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

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

static MCP_SERVICE: OnceLock<StreamableHttpService<XiheRuntime, LocalSessionManager>> = OnceLock::new();

fn resolve_security_profile() -> SecurityProfile {
    match std::env::var("XIHE_WORKSPACE_PROFILE")
        .as_deref()
        .unwrap_or("strict")
    {
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

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ExecuteCommandRequest {
    pub command: String,
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

#[tool_router(server_handler)]
impl XiheRuntime {
    pub fn new(ws_id: &str, workspace_path: &str, profile: SecurityProfile, container_addr: Option<String>) -> Self {
        Self {
            workspace: workspace_path.to_string(),
            ws_id: ws_id.to_string(),
            profile,
            container_addr,
        }
    }

    /// POST to container-runtime endpoint.
    /// If successful, returns the raw JSON body. On HTTP error, returns the error body text.
    async fn container_post(&self, endpoint: &str, body: &impl serde::Serialize) -> Result<serde_json::Value, String> {
        let base = self.container_addr.as_ref().ok_or_else(|| "no container".to_string())?;
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
            struct Req { path: String }
            let resp = self.container_post("/fs/read", &Req { path: path.clone() }).await?;
            return resp["content"].as_str().map(|s| s.to_string())
                .ok_or_else(|| "invalid response from container-runtime".to_string());
        }
        fs::read_file(&path, &self.workspace)
            .await
            .map_err(|e| e.to_string())
    }

    #[tool(description = "Read file with line range support, binary detection, and line numbers")]
    async fn read_file_range(
        &self,
        Parameters(ReadFileRangeRequest { path, offset, limit }): Parameters<ReadFileRangeRequest>,
    ) -> Result<Json<ReadFileRangeResult>, String> {
        if self.container_addr.is_some() {
            let resp = self
                .container_post("/fs/read_range", &serde_json::json!({
                    "path": path, "offset": offset, "limit": limit
                }))
                .await?;
            let result: ReadFileRangeResult = serde_json::from_value(resp)
                .map_err(|e| format!("deserialize read_range: {e}"))?;
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
            let _ = self.container_post("/fs/write", &serde_json::json!({
                "path": path, "content": content
            })).await?;
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
            let entries: Vec<fs::FileInfo> = serde_json::from_value(resp)
                .map_err(|e| format!("deserialize list: {e}"))?;
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
                .container_post("/fs/glob", &serde_json::json!({ "pattern": pattern, "path": path }))
                .await?;
            let matches: Vec<String> = serde_json::from_value(resp["matches"].clone())
                .map_err(|e| format!("deserialize glob: {e}"))?;
            return Ok(Json(fs::GlobResults { matches }));
        }
        let matches = fs::glob_files(&pattern, &path, &self.workspace).map_err(|e| e.to_string())?;
        Ok(Json(fs::GlobResults { matches }))
    }

    #[tool(description = "Search files using regular expression")]
    async fn grep(
        &self,
        Parameters(GrepRequest { pattern, path }): Parameters<GrepRequest>,
    ) -> Result<Json<fs::GrepResults>, String> {
        if self.container_addr.is_some() {
            let resp = self
                .container_post("/fs/grep", &serde_json::json!({ "pattern": pattern, "path": path }))
                .await?;
            let matches: Vec<fs::MatchResult> = serde_json::from_value(resp["matches"].clone())
                .map_err(|e| format!("deserialize grep: {e}"))?;
            return Ok(Json(fs::GrepResults { matches }));
        }
        let matches = fs::grep_files(&pattern, &path, &self.workspace).map_err(|e| e.to_string())?;
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
            struct Req { command: String, timeout_secs: Option<u64> }
            let resp = self.container_post("/exec", &Req {
                command: command.clone(),
                timeout_secs: timeout,
            }).await?;
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
        let events = tokio::task::spawn_blocking(move || {
            fs::watch_directory(&path, &workspace)
        })
        .await
        .map_err(|e| format!("Task failed: {e}"))?
        .map_err(|e| e.to_string())?;
        Ok(Json(fs::FileEventList { events }))
    }

    #[tool(description = "Search and replace text in a file (single by default, all with replace_all=true)")]
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
        Parameters(WebFetchRequest { url, format, timeout }): Parameters<WebFetchRequest>,
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
                let _ = client.post(&url)
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

fn get_non_empty_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.trim().is_empty())
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

fn resolve_runtime_log_filter() -> EnvFilter {
    if let Some(runtime_log_filter) = get_non_empty_env("XIHE_RUNTIME_LOG_FILTER") {
        return EnvFilter::try_new(runtime_log_filter)
            .unwrap_or_else(|_| EnvFilter::new("xihe_runtime=info,rmcp=info"));
    }

    let level = get_non_empty_env("XIHE_LOG_LEVEL_RUNTIME")
        .or_else(|| get_non_empty_env("XIHE_LOG_LEVEL"))
        .map(|value| normalize_runtime_log_level(&value))
        .unwrap_or_else(|| "info".to_string());

    EnvFilter::new(format!("xihe_runtime={level},rmcp={level}"))
}

async fn health() -> &'static str {
    "OK"
}

#[derive(Debug, Deserialize)]
struct CreateWorkspaceRequest {
    ws_id: String,
    workspace_path: String,
    profile: Option<String>,
}

#[derive(Debug, Serialize)]
struct CreateWorkspaceResponse {
    status: String,
    ws_id: String,
}

#[derive(Debug, Deserialize)]
struct DeleteWorkspaceRequest {
    ws_id: String,
}

#[derive(Debug, Serialize)]
struct DeleteWorkspaceResponse {
    status: String,
    ws_id: String,
}

#[derive(Debug, Deserialize)]
struct McpSpawnRequest {
    server_id: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Debug, Serialize)]
struct McpSpawnResponse {
    status: String,
    server_id: String,
    url: String,
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
    State(registry): State<Arc<WorkspaceRegistry>>,
    AxumJson(req): AxumJson<McpSpawnRequest>,
) -> Result<AxumJson<McpSpawnResponse>, StatusCode> {
    registry
        .get(&ws_id)
        .await
        .ok_or(StatusCode::NOT_FOUND)?;

    let container_name = format!("xihe-workspace-ws_{ws_id}");
    let docker = Docker::connect_with_local_defaults()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

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

    let container_ip = resolve_container_ip(&docker, &container_name).await
        .unwrap_or_else(|_| "127.0.0.1".to_string());

    let manager = mcp_manager();
    manager
        .spawn(&ws_id, &req.server_id, &req.command, &req.args, &container_ip, port)
        .await;

    let url = format!("http://{}:{}/{}", container_ip, port, req.server_id);
    tracing::info!("MCP bridge spawned: ws={ws_id} server={} at {url}", req.server_id);
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

async fn mcp_list_handler(
    Path(ws_id): Path<String>,
) -> AxumJson<serde_json::Value> {
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
            let mut svc = MCP_SERVICE.get().expect("MCP_SERVICE not initialized").clone();
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
    State(registry): State<Arc<WorkspaceRegistry>>,
    AxumJson(req): AxumJson<CreateWorkspaceRequest>,
) -> AxumJson<CreateWorkspaceResponse> {
    let profile = match req.profile.as_deref() {
        Some("coding") => SecurityProfile::Coding,
        Some("isolated") => SecurityProfile::Isolated,
        _ => SecurityProfile::Strict,
    };
    registry
        .register_with_profile(&req.ws_id, &req.workspace_path, profile)
        .await;
    tracing::info!(
        "Workspace registered via API: ws_id={}, path={}",
        req.ws_id,
        req.workspace_path
    );
    AxumJson(CreateWorkspaceResponse {
        status: "ok".to_string(),
        ws_id: req.ws_id,
    })
}

async fn delete_workspace_handler(
    State(registry): State<Arc<WorkspaceRegistry>>,
    AxumJson(req): AxumJson<DeleteWorkspaceRequest>,
) -> AxumJson<DeleteWorkspaceResponse> {
    let ws_id = &req.ws_id;
    mcp_manager().cleanup_workspace(ws_id).await;
    registry.unregister(ws_id).await;
    tracing::info!("Workspace deleted: ws_id={}, bridges cleaned up", ws_id);
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

    // Phase 3: override managed env vars from CP config after sync
    let cp_overrides: HashMap<&str, &str> = HashMap::from([
        ("XIHE_LOG_DIR", "logDir"),
        ("XIHE_LOG_LEVEL", "logLevel"),
        ("XIHE_LOG_LEVEL_RUNTIME", "levelRuntime"),
        ("XIHE_RUNTIME_LOG_FILTER", "runtimeFilter"),
        ("XIHE_WORKSPACE_PROFILE", "profile"),
    ]);
    for (env_key, config_key) in &cp_overrides {
        if let Some(val) = config_client::get_cp("logging", config_key).await {
            if !val.is_empty() {
                std::env::set_var(env_key, &val);
            }
        }
    }
    if let Some(val) = config_client::get_cp("workspace-config", "profile").await {
        if !val.is_empty() {
            std::env::set_var("XIHE_WORKSPACE_PROFILE", &val);
        }
    }

    let log_dir = std::env::var("XIHE_LOG_DIR")
        .unwrap_or_else(|_| "logs".to_string());
    let log_path = PathBuf::from(&log_dir).join("runtime.log");
    if let Some(parent) = log_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let file_appender = tracing_appender::rolling::daily(log_dir, "runtime.log");
    let (non_blocking_file, _guard) = tracing_appender::non_blocking(file_appender);

    tracing_subscriber::registry()
        .with(resolve_runtime_log_filter())
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stdout))
        .with(tracing_subscriber::fmt::layer().with_writer(non_blocking_file).with_ansi(false).json())
        .init();

    let runtime_host =
        std::env::var("XIHE_RUNTIME_HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
    let runtime_port = std::env::var("XIHE_RUNTIME_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(12633);
    let bind_addr = format!("{runtime_host}:{runtime_port}");

    let registry = Arc::new(WorkspaceRegistry::new());

    tracing::info!(
        "Starting xihe Runtime MCP Server (Gateway mode) on {}",
        bind_addr
    );

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

    let workspace_path = std::env::var("XIHE_WORKSPACE")
        .unwrap_or_else(|_| "/tmp/xihe-workspace".to_string());
    let wp = workspace_path.clone();

    let service = StreamableHttpService::new(
        move || {
            let ws_id = CURRENT_WS_ID.try_with(|id| id.clone())
                .unwrap_or_else(|_| "default".to_string());
            let profile = resolve_security_profile();
            let container_addr = match profile {
                SecurityProfile::Strict => None,
                _ => tokio::runtime::Handle::current()
                    .block_on(resolve_container_addr(&ws_id)),
            };
            Ok(XiheRuntime::new(&ws_id, &wp, profile, container_addr))
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
        .route("/workspace/{ws_id}/mcp", any(workspace_mcp_handler))
        .route("/workspace/create", post(create_workspace_handler))
        .route("/workspace/delete", post(delete_workspace_handler))
        .route(
            "/workspace/{ws_id}/mcp/spawn",
            post(mcp_spawn_handler),
        )
        .route(
            "/workspace/{ws_id}/mcp/spawn/{server_id}",
            delete(mcp_kill_handler),
        )
        .route(
            "/workspace/{ws_id}/mcp/spawn",
            get(mcp_list_handler),
        )
        .route(
            "/workspace/{ws_id}/mcp/stdio/{server_id}",
            post(mcp_stdio_handler),
        )
        .route(
            "/workspace/{ws_id}/files/read",
            post(ws_file_handler::handle_read_file),
        )
        .route(
            "/workspace/{ws_id}/files/write/{*path}",
            post(ws_file_handler::handle_write_binary),
        )
        .route(
            "/workspace/{ws_id}/files/list",
            post(ws_file_handler::handle_list_directory),
        )
        .route(
            "/workspace/{ws_id}/files/delete",
            post(ws_file_handler::handle_delete_file),
        )
        .route(
            "/workspace/{ws_id}/files/mkdir",
            post(ws_file_handler::handle_mkdir),
        )
        .route(
            "/workspace/{ws_id}/files/stat",
            post(ws_file_handler::handle_stat),
        )
        .layer(cors)
        .with_state(registry);

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

    Ok(())
}

async fn mcp_config_poll_loop(
    manager: &'static mcp_process::McpProcessManager,
    registry: Arc<WorkspaceRegistry>,
    ct: tokio_util::sync::CancellationToken,
) {
    let cp_url = std::env::var("XIHE_CP_URL")
        .unwrap_or_else(|_| "http://localhost:12631".into());
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
                    let servers = manager.poll_config(ws_id, &cp_url).await;
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

async fn idle_reaper_loop(registry: Arc<WorkspaceRegistry>, ct: tokio_util::sync::CancellationToken) {
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
