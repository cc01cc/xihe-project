use std::time::Duration;

use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;
use tracing_subscriber::prelude::*;

use xihe_runtime::error::RuntimeError;
use tokio::io::{AsyncBufReadExt, BufReader};
use std::path::{Path, PathBuf};
use xihe_runtime::fs;

const WORKSPACE: &str = "/workspace";
const JOB_DIR: &str = "/tmp/xihe-jobs";
const JOB_CAP: usize = 1024 * 1024;
const JOB_TTL_SECS: u64 = 15 * 60;
// Coding/Isolated gateways reach this service through a Docker-assigned loopback
// host port. Binding all container interfaces is required because Windows native
// hosts cannot route directly to Docker Desktop's Linux bridge IP.
const LISTEN_ADDR: &str = "0.0.0.0:39001";

#[derive(Clone)]
struct AppState;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--oneshot") {
        if let Err(e) = oneshot_main().await {
            let resp = serde_json::json!({
                "ok": false,
                "error": {"code": "ONESHOT_ERROR", "message": e.to_string()},
                "error_code": "ONESHOT_ERROR"
            });
            println!("{}", serde_json::to_string(&resp).unwrap());
            std::process::exit(1);
        }
        return;
    }
    let log_dir = std::env::var("XIHE_LOG_DIR").unwrap_or_else(|_| "logs".to_string());
    let file_appender = tracing_appender::rolling::daily(&log_dir, "container-runtime.log");
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

    let app = Router::new()
        .route("/health", get(health))
        .route("/fs/read", post(fs_read))
        .route("/fs/read_range", post(fs_read_range))
        .route("/fs/write", post(fs_write))
        .route("/fs/edit", post(fs_edit))
        .route("/fs/delete", post(fs_delete))
        .route("/fs/mkdir", post(fs_mkdir))
        .route("/fs/list", post(fs_list))
        .route("/fs/glob", post(fs_glob))
        .route("/fs/grep", post(fs_grep))
        .route("/fs/info", post(fs_info))
        .route("/fs/watch", post(fs_watch))
        .route("/fs/move", post(fs_move))
        .route("/fs/copy", post(fs_copy))
        .route("/exec", post(exec_command))
        .with_state(AppState);

    info!("xihe-container-runtime listening on {LISTEN_ADDR}");
    let listener = tokio::net::TcpListener::bind(LISTEN_ADDR)
        .await
        .expect("failed to bind");
    axum::serve(listener, app).await.expect("server error");
}


// ── Oneshot dispatcher ───────────────────────────────────────────────────
#[derive(serde::Deserialize)]
#[allow(dead_code)]
struct OperationRequest {
    operation: String,
    payload: serde_json::Value,
    request_id: Option<String>,
}

#[derive(serde::Serialize)]
struct OperationResponse {
    ok: bool,
    result: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<OperationError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
}

#[derive(serde::Serialize)]
struct OperationError {
    code: String,
    message: String,
}

async fn oneshot_main() -> anyhow::Result<()> {
    let stdin = tokio::io::stdin();
    let mut reader = BufReader::new(stdin);
    let mut line = String::new();
    let n = reader.read_line(&mut line).await?;
    if n == 0 {
        anyhow::bail!("empty stdin for oneshot");
    }
    let req: OperationRequest = serde_json::from_str(line.trim())?;
    let result = dispatch_operation(&req).await;
    let resp = match result {
        Ok(val) => OperationResponse { ok: true, result: val, error: None, error_code: None },
        Err(e) => {
            let (code, msg) = map_runtime_error(&e);
            OperationResponse { ok: false, result: serde_json::Value::Null, error: Some(OperationError { code: code.clone(), message: msg.clone() }), error_code: Some(code) }
        }
    };
    let out = serde_json::to_string(&resp)?;
    println!("{}", out);
    Ok(())
}

fn map_runtime_error(e: &RuntimeError) -> (String, String) {
    match e {
        RuntimeError::PathTraversal { path } => ("PATH_TRAVERSAL".to_string(), path.clone()),
        RuntimeError::SymlinkEscape { path, resolved } => ("SYMLINK_ESCAPE".to_string(), format!("{path} -> {resolved}")),
        RuntimeError::InvalidPath(msg) => ("INVALID_PATH".to_string(), msg.clone()),
        RuntimeError::FileNotFound(msg) => ("FILE_NOT_FOUND".to_string(), msg.clone()),
        RuntimeError::WorkspaceNotFound(msg) => ("WORKSPACE_NOT_FOUND".to_string(), msg.clone()),
        _ => ("EXEC_FAILED".to_string(), e.to_string()),
    }
}

async fn dispatch_operation(req: &OperationRequest) -> Result<serde_json::Value, RuntimeError> {
    match req.operation.as_str() {
        "read_file" => {
            let path = req.payload.get("path").and_then(|v| v.as_str()).ok_or_else(|| RuntimeError::InvalidPath("missing path".into()))?;
            let content = fs::read_file(path, WORKSPACE).await?;
            Ok(serde_json::json!({"content": content}))
        }
        "write_file" => {
            let path = req.payload.get("path").and_then(|v| v.as_str()).ok_or_else(|| RuntimeError::InvalidPath("missing path".into()))?;
            let content = req.payload.get("content").and_then(|v| v.as_str()).unwrap_or("");
            let msg = fs::write_file(path, content, WORKSPACE).await?;
            Ok(serde_json::json!({"message": msg}))
        }
        "list_directory" => {
            let path = req.payload.get("path").and_then(|v| v.as_str()).ok_or_else(|| RuntimeError::InvalidPath("missing path".into()))?;
            let entries = tokio::task::spawn_blocking({ let p = path.to_string(); move || fs::list_directory(&p, WORKSPACE) }).await.map_err(|e| RuntimeError::InvalidPath(e.to_string()))??;
            Ok(serde_json::json!({"entries": entries}))
        }
        "glob" => {
            let pattern = req.payload.get("pattern").and_then(|v| v.as_str()).ok_or_else(|| RuntimeError::InvalidPath("missing pattern".into()))?;
            let path = req.payload.get("path").and_then(|v| v.as_str()).ok_or_else(|| RuntimeError::InvalidPath("missing path".into()))?;
            let matches = tokio::task::spawn_blocking({ let pat = pattern.to_string(); let p = path.to_string(); move || fs::glob_files(&pat, &p, WORKSPACE) }).await.map_err(|e| RuntimeError::InvalidPath(e.to_string()))??;
            Ok(serde_json::json!({"matches": matches}))
        }
        "grep" => {
            let pattern = req.payload.get("pattern").and_then(|v| v.as_str()).ok_or_else(|| RuntimeError::InvalidPath("missing pattern".into()))?;
            let path = req.payload.get("path").and_then(|v| v.as_str()).ok_or_else(|| RuntimeError::InvalidPath("missing path".into()))?;
            let matches = tokio::task::spawn_blocking({ let pat = pattern.to_string(); let p = path.to_string(); move || fs::grep_files(&pat, &p, WORKSPACE) }).await.map_err(|e| RuntimeError::InvalidPath(e.to_string()))??;
            Ok(serde_json::json!({"matches": matches}))
        }
        "get_file_info" => {
            let path = req.payload.get("path").and_then(|v| v.as_str()).ok_or_else(|| RuntimeError::InvalidPath("missing path".into()))?;
            let info = tokio::task::spawn_blocking({ let p = path.to_string(); move || fs::get_file_info(&p, WORKSPACE) }).await.map_err(|e| RuntimeError::InvalidPath(e.to_string()))??;
            Ok(serde_json::to_value(info).unwrap())
        }
        "watch_directory" => {
            let path = req.payload.get("path").and_then(|v| v.as_str()).ok_or_else(|| RuntimeError::InvalidPath("missing path".into()))?;
            let events = tokio::task::spawn_blocking({ let p = path.to_string(); move || fs::watch_directory(&p, WORKSPACE) }).await.map_err(|e| RuntimeError::InvalidPath(e.to_string()))??;
            Ok(serde_json::json!({"events": events}))
        }
        "edit_file" => {
            let file_path = req.payload.get("file_path").and_then(|v| v.as_str()).ok_or_else(|| RuntimeError::InvalidPath("missing file_path".into()))?;
            let old_string = req.payload.get("old_string").and_then(|v| v.as_str()).unwrap_or("");
            let new_string = req.payload.get("new_string").and_then(|v| v.as_str()).unwrap_or("");
            let replace_all = req.payload.get("replace_all").and_then(|v| v.as_bool()).unwrap_or(false);
            let res = fs::edit_file(file_path, old_string, new_string, replace_all, WORKSPACE).await?;
            Ok(serde_json::to_value(res).unwrap())
        }
        "delete_file" => {
            let path = req.payload.get("path").and_then(|v| v.as_str()).ok_or_else(|| RuntimeError::InvalidPath("missing path".into()))?;
            let msg = fs::delete_file(path, WORKSPACE).await?;
            Ok(serde_json::json!({"message": msg}))
        }
        "delete_directory" => {
            let path = req.payload.get("path").and_then(|v| v.as_str()).ok_or_else(|| RuntimeError::InvalidPath("missing path".into()))?;
            let recursive = req.payload.get("recursive").and_then(|v| v.as_bool()).unwrap_or(false);
            let msg = fs::delete_directory(path, recursive, WORKSPACE).await?;
            Ok(serde_json::json!({"message": msg}))
        }
        "move_file" => {
            let from = req.payload.get("from").and_then(|v| v.as_str()).ok_or_else(|| RuntimeError::InvalidPath("missing from".into()))?;
            let to = req.payload.get("to").and_then(|v| v.as_str()).ok_or_else(|| RuntimeError::InvalidPath("missing to".into()))?;
            let msg = fs::move_file(from, to, WORKSPACE).await?;
            Ok(serde_json::json!({"message": msg}))
        }
        "copy_file" => {
            let from = req.payload.get("from").and_then(|v| v.as_str()).ok_or_else(|| RuntimeError::InvalidPath("missing from".into()))?;
            let to = req.payload.get("to").and_then(|v| v.as_str()).ok_or_else(|| RuntimeError::InvalidPath("missing to".into()))?;
            let msg = fs::copy_file(from, to, WORKSPACE).await?;
            Ok(serde_json::json!({"message": msg}))
        }
        "mkdir" => {
            let path = req.payload.get("path").and_then(|v| v.as_str()).ok_or_else(|| RuntimeError::InvalidPath("missing path".into()))?;
            let msg = fs::mkdir(path, WORKSPACE).await?;
            Ok(serde_json::json!({"message": msg}))
        }
        "extract_pdf_text" => {
            let path = req.payload.get("path").and_then(|v| v.as_str()).ok_or_else(|| RuntimeError::InvalidPath("missing path".into()))?;
            let text = fs::extract_pdf_text(path, WORKSPACE).await?;
            Ok(serde_json::json!({"content": text}))
        }
        "execute_command" => {
            let command = req.payload.get("command").and_then(|v| v.as_str()).ok_or_else(|| RuntimeError::InvalidPath("missing command".into()))?.to_string();
            let args: Vec<String> = req.payload.get("args").and_then(|v| v.as_array()).map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
            let timeout = req.payload.get("timeout").and_then(|v| v.as_u64());
            let truncate_limit = req.payload.get("truncate_limit").and_then(|v| v.as_u64());
            let res = exec_shell_command(&command, args, timeout, truncate_limit).await?;
            Ok(serde_json::to_value(res).unwrap())
        }
        "start_background_process" => {
            let command = req.payload.get("command").and_then(|v| v.as_str()).ok_or_else(|| RuntimeError::InvalidPath("missing command".into()))?.to_string();
            let args: Vec<String> = req.payload.get("args").and_then(|v| v.as_array()).map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
            let job_id = start_background_job(&command, args).await?;
            Ok(serde_json::json!({"jobId": job_id}))
        }
        "list_background_processes" => {
            let jobs = list_jobs()?;
            Ok(serde_json::json!({"jobs": jobs}))
        }
        "get_background_process" => {
            let job_id = req.payload.get("jobId").and_then(|v| v.as_str()).ok_or_else(|| RuntimeError::InvalidPath("missing jobId".into()))?;
            let job = get_job(job_id)?;
            Ok(serde_json::to_value(job).unwrap())
        }
        "cancel_background_process" => {
            let job_id = req.payload.get("jobId").and_then(|v| v.as_str()).ok_or_else(|| RuntimeError::InvalidPath("missing jobId".into()))?;
            let res = cancel_job(job_id)?;
            Ok(serde_json::json!({"status": res}))
        }
        "read_command_output" => {
            let artifact_id = req.payload.get("artifact_id").and_then(|v| v.as_str()).ok_or_else(|| RuntimeError::InvalidPath("missing artifact_id".into()))?;
            let offset = req.payload.get("offset").and_then(|v| v.as_u64()).map(|v| v as usize);
            let limit = req.payload.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize);
            let content = read_job_output(artifact_id, offset, limit)?;
            Ok(serde_json::json!({"content": content}))
        }
        "cleanup_jobs" => {
            let cleaned = cleanup_expired_jobs()?;
            Ok(serde_json::json!({"cleaned": cleaned}))
        }
        _ => Err(RuntimeError::InvalidPath(format!("unknown operation {}", req.operation))),
    }
}



async fn health() -> &'static str {
    "ok"
}


// ── Shell execution with positional args, timeout, bounded output ──────────
#[derive(Serialize, Deserialize)]
struct ExecResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    artifact_id: Option<String>,
}

async fn exec_shell_command(command: &str, args: Vec<String>, timeout: Option<u64>, truncate_limit: Option<u64>) -> Result<ExecResult, RuntimeError> {
    let timeout_dur = Duration::from_secs(timeout.unwrap_or(30));
    let limit = truncate_limit.unwrap_or(4096) as usize;
    let mut cmd = Command::new("sh");
    cmd.arg("-c").arg(command);
    cmd.arg("xihe-shell");
    for a in &args { cmd.arg(a); }
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| RuntimeError::Command(format!("spawn failed: {e}")))?;
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let stdout_handle = tokio::spawn(async move {
        if let Some(mut pipe) = stdout_pipe {
            let mut buf = Vec::new();
            let mut tmp = [0u8; 8192];
            use tokio::io::AsyncReadExt;
            loop {
                match pipe.read(&mut tmp).await {
                    Ok(0) => break,
                    Ok(n) => { if buf.len() < limit + 8192 { buf.extend_from_slice(&tmp[..n]); } },
                    Err(_) => break,
                }
            }
            buf
        } else { Vec::new() }
    });
    let stderr_handle = tokio::spawn(async move {
        if let Some(mut pipe) = stderr_pipe {
            let mut buf = Vec::new();
            let mut tmp = [0u8; 8192];
            use tokio::io::AsyncReadExt;
            loop {
                match pipe.read(&mut tmp).await {
                    Ok(0) => break,
                    Ok(n) => { if buf.len() < limit + 8192 { buf.extend_from_slice(&tmp[..n]); } },
                    Err(_) => break,
                }
            }
            buf
        } else { Vec::new() }
    });
    let wait_fut = child.wait();
    let status = match tokio::time::timeout(timeout_dur, wait_fut).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(RuntimeError::Command(format!("wait failed: {e}"))),
        Err(_) => {
            let pid = child.id();
            if let Some(pid) = pid {
                let _ = Command::new("sh").arg("-c").arg(format!("kill -- -{} 2>/dev/null; kill -9 -- -{} 2>/dev/null; kill -9 {} 2>/dev/null", pid, pid, pid)).status().await;
            }
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            return Err(RuntimeError::Timeout);
        }
    };
    let stdout_bytes = stdout_handle.await.map_err(|e| RuntimeError::Command(e.to_string()))?;
    let stderr_bytes = stderr_handle.await.map_err(|e| RuntimeError::Command(e.to_string()))?;
    let stdout_str = String::from_utf8_lossy(&stdout_bytes).to_string();
    let stderr_str = String::from_utf8_lossy(&stderr_bytes).to_string();
    let (stdout_final, artifact_id) = if stdout_str.len() > limit {
        let truncated = stdout_str[..limit].to_string() + &format!("\n[truncated to {} chars]", limit);
        (truncated, None)
    } else { (stdout_str, None) };
    Ok(ExecResult { stdout: stdout_final, stderr: stderr_str, exit_code: status.code().unwrap_or(-1), success: status.success(), artifact_id })
}

// ── Job management via /tmp/xihe-jobs ────────────────────────────────────
#[derive(Serialize, Deserialize, Clone)]
#[allow(non_snake_case)]
struct JobInfo {
    jobId: String,
    command: String,
    status: String,
    pid: Option<String>,
    exit_code: Option<i32>,
    started_at: String,
}

fn ensure_job_dir() -> std::io::Result<()> { std::fs::create_dir_all(JOB_DIR) }

async fn start_background_job(command: &str, args: Vec<String>) -> Result<String, RuntimeError> {
    ensure_job_dir().map_err(RuntimeError::Io)?;
    let jobs = list_jobs().unwrap_or_default();
    if jobs.len() >= 100 { return Err(RuntimeError::InvalidPath("job limit reached (100)".into())); }
    let job_id = uuid::Uuid::new_v4().to_string();
    let job_path = PathBuf::from(JOB_DIR).join(&job_id);
    std::fs::create_dir_all(&job_path).map_err(RuntimeError::Io)?;
    std::fs::write(job_path.join("meta"), "running").map_err(RuntimeError::Io)?;
    std::fs::write(job_path.join("command"), command).map_err(RuntimeError::Io)?;
    std::fs::write(job_path.join("started_at"), chrono::Utc::now().to_rfc3339()).map_err(RuntimeError::Io)?;
    // Build shell-escaped args for outer sh -c
    let cmd_escaped = format!("'{}'", command.replace('\'', "'\\''"));
    let args_escaped: Vec<String> = args.iter().map(|a| format!("'{}'", a.replace('\'', "'\\''"))).collect();
    let all_args = std::iter::once(cmd_escaped).chain(args_escaped).collect::<Vec<_>>().join(" ");
    let arg_refs: Vec<String> = (2..=args.len()+1).map(|i| format!("\"${}\"", i)).collect();
    let arg_refs_str = arg_refs.join(" ");
    let inner = if arg_refs_str.is_empty() {
        "sh -c \"$1\" xihe-shell".to_string()
    } else {
        format!("sh -c \"$1\" xihe-shell {}", arg_refs_str)
    };
    let wrapper = format!("setsid sh -c 'echo $$ > {job_dir}/pid; {inner} > {job_dir}/stdout 2> {job_dir}/stderr; echo $? > {job_dir}/exit; echo succeeded > {job_dir}/meta' -- {all}", job_dir = job_path.display(), inner = inner, all = all_args);
    let status = Command::new("sh").arg("-c").arg(&wrapper).status().await.map_err(|e| RuntimeError::Command(e.to_string()))?;
    if !status.success() { warn!("failed to start background job wrapper"); }
    tokio::time::sleep(Duration::from_millis(100)).await;
    Ok(job_id)
}

fn list_jobs() -> Result<Vec<JobInfo>, RuntimeError> {
    let mut jobs = Vec::new();
    let job_dir = Path::new(JOB_DIR);
    if !job_dir.exists() { return Ok(jobs); }
    for entry in std::fs::read_dir(job_dir).map_err(RuntimeError::Io)? {
        let entry = entry.map_err(RuntimeError::Io)?;
        let job_id = entry.file_name().to_string_lossy().to_string();
        if let Ok(job) = get_job(&job_id) { jobs.push(job); }
    }
    Ok(jobs)
}

fn get_job(job_id: &str) -> Result<JobInfo, RuntimeError> {
    let job_path = PathBuf::from(JOB_DIR).join(job_id);
    if !job_path.exists() { return Err(RuntimeError::InvalidPath(format!("job not found: {job_id}"))); }
    let meta = std::fs::read_to_string(job_path.join("meta")).unwrap_or_else(|_| "unknown".to_string()).trim().to_string();
    let command = std::fs::read_to_string(job_path.join("command")).unwrap_or_default().trim().to_string();
    let pid = std::fs::read_to_string(job_path.join("pid")).ok().map(|s| s.trim().to_string());
    let started_at = std::fs::read_to_string(job_path.join("started_at")).unwrap_or_default().trim().to_string();
    let exit_code = std::fs::read_to_string(job_path.join("exit")).ok().and_then(|s| s.trim().parse::<i32>().ok());
    let status = if meta == "running" {
        if let Some(pid_str) = &pid {
            if let Ok(pid_num) = pid_str.parse::<i32>() {
                let still_running = std::process::Command::new("sh").arg("-c").arg(format!("kill -0 -- -{} 2>/dev/null || kill -0 {} 2>/dev/null", pid_num, pid_num)).status().map(|s| s.success()).unwrap_or(false);
                if !still_running { if exit_code.is_some() { "succeeded".to_string() } else { "failed".to_string() } } else { "running".to_string() }
            } else { meta }
        } else { meta }
    } else { meta };
    Ok(JobInfo { jobId: job_id.to_string(), command, status, pid, exit_code, started_at })
}

fn cancel_job(job_id: &str) -> Result<String, RuntimeError> {
    let job_path = PathBuf::from(JOB_DIR).join(job_id);
    if !job_path.exists() { return Err(RuntimeError::InvalidPath(format!("job not found: {job_id}"))); }
    let pid_str = std::fs::read_to_string(job_path.join("pid")).map_err(|_| RuntimeError::InvalidPath("pid not found".into()))?;
    let pid_str = pid_str.trim();
    let _ = std::process::Command::new("sh").arg("-c").arg(format!("kill -- -{} 2>/dev/null; kill -TERM -- -{} 2>/dev/null; kill -9 -- -{} 2>/dev/null; kill {} 2>/dev/null; kill -9 {} 2>/dev/null", pid_str, pid_str, pid_str, pid_str, pid_str)).status();
    std::fs::write(job_path.join("meta"), "cancelled").map_err(RuntimeError::Io)?;
    Ok("cancelled".to_string())
}

fn read_job_output(job_id: &str, offset: Option<usize>, limit: Option<usize>) -> Result<String, RuntimeError> {
    let job_path = PathBuf::from(JOB_DIR).join(job_id);
    let stdout_path = job_path.join("stdout");
    if !stdout_path.exists() { return Err(RuntimeError::FileNotFound(format!("output not found for job {job_id}"))); }
    let content = std::fs::read_to_string(&stdout_path).map_err(RuntimeError::Io)?;
    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(content.len());
    let end = (offset + limit).min(content.len());
    if offset >= content.len() { return Ok(String::new()); }
    Ok(content[offset..end].to_string())
}

fn cleanup_expired_jobs() -> Result<usize, RuntimeError> {
    let mut cleaned = 0;
    let job_dir = Path::new(JOB_DIR);
    if !job_dir.exists() { return Ok(0); }
    let now = std::time::SystemTime::now();
    for entry in std::fs::read_dir(job_dir).map_err(RuntimeError::Io)? {
        let entry = entry.map_err(RuntimeError::Io)?;
        let meta = entry.metadata().map_err(RuntimeError::Io)?;
        if let Ok(modified) = meta.modified() { if let Ok(elapsed) = now.duration_since(modified) { if elapsed.as_secs() > JOB_TTL_SECS { let _ = std::fs::remove_dir_all(entry.path()); cleaned += 1; } } }
        let job_id = entry.file_name().to_string_lossy().to_string();
        let job_path = PathBuf::from(JOB_DIR).join(&job_id);
        for fname in ["stdout", "stderr"] {
            let fpath = job_path.join(fname);
            if let Ok(md) = std::fs::metadata(&fpath) { if md.len() > JOB_CAP as u64 { let _ = std::process::Command::new("sh").arg("-c").arg(format!("head -c {} {} > {}.tmp && mv {}.tmp {}", JOB_CAP, fpath.display(), fpath.display(), fpath.display(), fpath.display())).status(); } }
        }
    }
    Ok(cleaned)
}



#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

fn err_response(e: impl ToString) -> (StatusCode, Json<ErrorResponse>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse {
            error: e.to_string(),
        }),
    )
}

// ── /fs/read ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ReadRequest {
    path: String,
}

#[derive(Serialize)]
struct ReadResponse {
    content: String,
}

async fn fs_read(
    Json(req): Json<ReadRequest>,
) -> Result<Json<ReadResponse>, (StatusCode, Json<ErrorResponse>)> {
    fs::read_file(&req.path, WORKSPACE)
        .await
        .map(|content| Json(ReadResponse { content }))
        .map_err(err_response)
}

// ── /fs/read_range ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ReadRangeRequest {
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
}

#[derive(Serialize)]
struct ReadRangeResponse {
    content: String,
    total_lines: usize,
    is_binary: bool,
}

async fn fs_read_range(
    Json(req): Json<ReadRangeRequest>,
) -> Result<Json<ReadRangeResponse>, (StatusCode, Json<ErrorResponse>)> {
    fs::read_file_range(&req.path, req.offset, req.limit, WORKSPACE)
        .await
        .map(|r| {
            Json(ReadRangeResponse {
                content: r.content,
                total_lines: r.total_lines,
                is_binary: r.is_binary,
            })
        })
        .map_err(err_response)
}

// ── /fs/write ──────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct WriteRequest {
    path: String,
    content: String,
}

#[derive(Serialize)]
struct WriteResponse {
    bytes_written: usize,
}

async fn fs_write(
    Json(req): Json<WriteRequest>,
) -> Result<Json<WriteResponse>, (StatusCode, Json<ErrorResponse>)> {
    let len = req.content.len();
    fs::write_file(&req.path, &req.content, WORKSPACE)
        .await
        .map(|_| Json(WriteResponse { bytes_written: len }))
        .map_err(err_response)
}

// ── /fs/edit ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct EditRequest {
    path: String,
    #[serde(rename = "old")]
    old_string: String,
    #[serde(rename = "new")]
    new_string: String,
    replace_all: Option<bool>,
}

#[derive(Serialize)]
struct EditResponse {
    replacements: usize,
    message: String,
}

async fn fs_edit(
    Json(req): Json<EditRequest>,
) -> Result<Json<EditResponse>, (StatusCode, Json<ErrorResponse>)> {
    fs::edit_file(
        &req.path,
        &req.old_string,
        &req.new_string,
        req.replace_all.unwrap_or(false),
        WORKSPACE,
    )
    .await
    .map(|r| {
        Json(EditResponse {
            replacements: r.replacements,
            message: r.message,
        })
    })
    .map_err(err_response)
}

// ── /fs/delete ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct DeleteRequest {
    path: String,
    recursive: Option<bool>,
}

#[derive(Serialize)]
struct DeleteResponse {
    status: String,
}

async fn fs_delete(
    Json(req): Json<DeleteRequest>,
) -> Result<Json<DeleteResponse>, (StatusCode, Json<ErrorResponse>)> {
    if req.recursive.unwrap_or(false) {
        fs::delete_directory(&req.path, true, WORKSPACE)
            .await
            .map(|_| {
                Json(DeleteResponse {
                    status: "deleted".into(),
                })
            })
            .map_err(err_response)
    } else {
        fs::delete_file(&req.path, WORKSPACE)
            .await
            .map(|_| {
                Json(DeleteResponse {
                    status: "deleted".into(),
                })
            })
            .map_err(err_response)
    }
}

// ── /fs/mkdir ──────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct MkdirRequest {
    path: String,
}

#[derive(Serialize)]
struct MkdirResponse {
    status: String,
}

async fn fs_mkdir(
    Json(req): Json<MkdirRequest>,
) -> Result<Json<MkdirResponse>, (StatusCode, Json<ErrorResponse>)> {
    fs::mkdir(&req.path, WORKSPACE)
        .await
        .map(|_| {
            Json(MkdirResponse {
                status: "created".into(),
            })
        })
        .map_err(err_response)
}

// ── /fs/list ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ListRequest {
    path: String,
}

async fn fs_list(
    Json(req): Json<ListRequest>,
) -> Result<Json<Vec<fs::FileInfo>>, (StatusCode, Json<ErrorResponse>)> {
    let entries = tokio::task::spawn_blocking({
        let p = req.path.clone();
        move || fs::list_directory(&p, WORKSPACE)
    })
    .await
    .map_err(|e| err_response(RuntimeError::InvalidPath(e.to_string())))?
    .map_err(err_response)?;
    Ok(Json(entries))
}

// ── /fs/glob ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct GlobRequest {
    pattern: String,
    path: String,
}

#[derive(Serialize)]
struct GlobResponse {
    matches: Vec<String>,
}

async fn fs_glob(
    Json(req): Json<GlobRequest>,
) -> Result<Json<GlobResponse>, (StatusCode, Json<ErrorResponse>)> {
    let matches = tokio::task::spawn_blocking({
        let p = req.pattern.clone();
        let d = req.path.clone();
        move || fs::glob_files(&p, &d, WORKSPACE)
    })
    .await
    .map_err(|e| err_response(RuntimeError::InvalidPath(e.to_string())))?
    .map_err(err_response)?;
    Ok(Json(GlobResponse { matches }))
}

// ── /fs/grep ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct GrepRequest {
    pattern: String,
    path: String,
}

#[derive(Serialize)]
struct GrepResponse {
    matches: Vec<fs::MatchResult>,
}

async fn fs_grep(
    Json(req): Json<GrepRequest>,
) -> Result<Json<GrepResponse>, (StatusCode, Json<ErrorResponse>)> {
    let matches = tokio::task::spawn_blocking({
        let p = req.pattern.clone();
        let d = req.path.clone();
        move || fs::grep_files(&p, &d, WORKSPACE)
    })
    .await
    .map_err(|e| err_response(RuntimeError::InvalidPath(e.to_string())))?
    .map_err(err_response)?;
    Ok(Json(GrepResponse { matches }))
}

// ── /fs/info ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct InfoRequest {
    path: String,
}

async fn fs_info(
    Json(req): Json<InfoRequest>,
) -> Result<Json<fs::FileInfo>, (StatusCode, Json<ErrorResponse>)> {
    let info = tokio::task::spawn_blocking({
        let p = req.path.clone();
        move || fs::get_file_info(&p, WORKSPACE)
    })
    .await
    .map_err(|e| err_response(RuntimeError::InvalidPath(e.to_string())))?
    .map_err(err_response)?;
    Ok(Json(info))
}

// ── /fs/watch ──────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct WatchRequest {
    path: String,
}

#[derive(Serialize)]
struct WatchResponse {
    events: Vec<fs::FileEvent>,
}

async fn fs_watch(
    Json(req): Json<WatchRequest>,
) -> Result<Json<WatchResponse>, (StatusCode, Json<ErrorResponse>)> {
    let events = tokio::task::spawn_blocking({
        let p = req.path.clone();
        move || fs::watch_directory(&p, WORKSPACE)
    })
    .await
    .map_err(|e| err_response(RuntimeError::InvalidPath(e.to_string())))?
    .map_err(err_response)?;
    Ok(Json(WatchResponse { events }))
}

// ── /fs/move ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct MoveRequest {
    from: String,
    to: String,
}

#[derive(Serialize)]
struct MoveResponse {
    status: String,
}

async fn fs_move(
    Json(req): Json<MoveRequest>,
) -> Result<Json<MoveResponse>, (StatusCode, Json<ErrorResponse>)> {
    fs::move_file(&req.from, &req.to, WORKSPACE)
        .await
        .map(|_| {
            Json(MoveResponse {
                status: "moved".into(),
            })
        })
        .map_err(err_response)
}

// ── /fs/copy ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct CopyRequest {
    from: String,
    to: String,
}

#[derive(Serialize)]
struct CopyResponse {
    status: String,
}

async fn fs_copy(
    Json(req): Json<CopyRequest>,
) -> Result<Json<CopyResponse>, (StatusCode, Json<ErrorResponse>)> {
    fs::copy_file(&req.from, &req.to, WORKSPACE)
        .await
        .map(|_| {
            Json(CopyResponse {
                status: "copied".into(),
            })
        })
        .map_err(err_response)
}

// ── /exec ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ExecRequest {
    command: String,
    args: Option<Vec<String>>,
    timeout_secs: Option<u64>,
}

#[derive(Serialize)]
struct ExecResponse {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

async fn exec_command(
    Json(req): Json<ExecRequest>,
) -> Result<Json<ExecResponse>, (StatusCode, Json<ErrorResponse>)> {
    let timeout = Duration::from_secs(req.timeout_secs.unwrap_or(30));

    let mut cmd = Command::new("sh");
    cmd.arg("-c").arg(&req.command);
    if let Some(args) = &req.args {
        cmd.args(args);
    }

    let result = tokio::time::timeout(timeout, cmd.output())
        .await
        .map_err(|_| err_response("command timed out"))?
        .map_err(|e| err_response(format!("exec failed: {e}")))?;

    Ok(Json(ExecResponse {
        stdout: String::from_utf8_lossy(&result.stdout).to_string(),
        stderr: String::from_utf8_lossy(&result.stderr).to_string(),
        exit_code: result.status.code().unwrap_or(-1),
    }))
}
