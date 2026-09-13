use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tracing::info;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::prelude::*;

use xihe_runtime::error::RuntimeError;
use tokio::io::{AsyncBufReadExt, BufReader};
use xihe_runtime::fs;

const WORKSPACE: &str = "/workspace";
const JOB_DIR: &str = "/tmp/xihe-jobs";
const JOB_CAP: usize = 1024 * 1024;
const JOB_TTL_SECS: u64 = 15 * 60;
// Coding/Isolated gateways reach this service through a Docker-assigned loopback
// host port. Binding all container interfaces is required because Windows native
// hosts cannot route directly to Docker Desktop's Linux bridge IP.
const LISTEN_ADDR: &str = "0.0.0.0:39001";

/// PLAN-0317 T2.2（决策 #13）：oneshot 执行期间的中止信号。
/// 宿主在超时/取消时向 stdin 写中止帧（EOF 兜底）；容器侧监听后对当前进程组
/// 执行两阶段终止。oneshot 进程一次只执行一个操作，故用进程级静态状态。
static ONESHOT_ABORTED: AtomicBool = AtomicBool::new(false);
static ONESHOT_PGID: StdMutex<Option<i32>> = StdMutex::new(None);

fn abort_requested() -> bool {
    ONESHOT_ABORTED.load(Ordering::SeqCst)
}

/// 标记中止并对已登记的进程组执行两阶段终止（SIGTERM → 1s → SIGKILL）。
fn mark_oneshot_aborted(reason: &str) {
    if ONESHOT_ABORTED.swap(true, Ordering::SeqCst) {
        return;
    }
    info!(target: "timeout", reason, "oneshot abort received");
    let pgid = *ONESHOT_PGID.lock().expect("oneshot pgid poisoned");
    if let Some(pgid) = pgid {
        tokio::spawn(terminate_process_group(pgid));
    }
}

async fn terminate_process_group(pgid: i32) {
    let _ = Command::new("sh")
        .arg("-c")
        .arg(format!("kill -TERM -- -{pgid} 2>/dev/null"))
        .status()
        .await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let _ = Command::new("sh")
        .arg("-c")
        .arg(format!(
            "kill -9 -- -{pgid} 2>/dev/null; kill -9 {pgid} 2>/dev/null"
        ))
        .status()
        .await;
}

fn register_oneshot_pgid(pgid: Option<i32>) {
    *ONESHOT_PGID.lock().expect("oneshot pgid poisoned") = pgid;
}

fn cancelled_error() -> RuntimeError {
    RuntimeError::Cancelled {
        detail: "container runtime aborted by host request".to_string(),
        confirmed: true,
    }
}

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
    // PLAN-0317 T2.2：宿主在执行期间保持 stdin 打开；并发监听中止帧/EOF，
    // 命中即对当前操作登记过的进程组执行两阶段终止。
    tokio::spawn(async move {
        let mut extra = String::new();
        loop {
            extra.clear();
            match reader.read_line(&mut extra).await {
                Ok(0) => {
                    mark_oneshot_aborted("stdin closed");
                    break;
                }
                Ok(_) => {
                    if extra.contains("\"abort\"") {
                        mark_oneshot_aborted("abort frame");
                        break;
                    }
                }
                Err(_) => {
                    mark_oneshot_aborted("stdin read error");
                    break;
                }
            }
        }
    });
    // 中止在操作开始前到达：不执行操作，直接回 CANCELLED（confirmed=true）。
    let result = if abort_requested() {
        Err(cancelled_error())
    } else {
        dispatch_operation(&req).await
    };
    let resp = match result {
        Ok(val) => OperationResponse { ok: true, result: val, error: None, error_code: None },
        Err(e) => {
            let (code, msg) = map_runtime_error(&e);
            OperationResponse { ok: false, result: serde_json::Value::Null, error: Some(OperationError { code: code.clone(), message: msg.clone() }), error_code: Some(code) }
        }
    };
    let out = serde_json::to_string(&resp)?;
    println!("{out}");
    Ok(())
}

fn map_runtime_error(e: &RuntimeError) -> (String, String) {
    match e {
        RuntimeError::PathTraversal { path } => ("PATH_TRAVERSAL".to_string(), path.clone()),
        RuntimeError::SymlinkEscape { path, resolved } => ("SYMLINK_ESCAPE".to_string(), format!("{path} -> {resolved}")),
        RuntimeError::InvalidPath(msg) => ("INVALID_PATH".to_string(), msg.clone()),
        RuntimeError::FileNotFound(msg) => ("FILE_NOT_FOUND".to_string(), msg.clone()),
        RuntimeError::WorkspaceNotFound(msg) => ("WORKSPACE_NOT_FOUND".to_string(), msg.clone()),
        // PLAN-0308 T3.4（决策 #31）：守卫到界必须是独立错误码，host 侧据此补全署名并保持
        // Timeout 语义（此前落到 EXEC_FAILED，被 host 归成 Docker 错误、丢掉超时归因）。
        RuntimeError::Timeout { .. } => ("TIMEOUT".to_string(), e.to_string()),
        RuntimeError::Cancelled { .. } => ("CANCELLED".to_string(), e.to_string()),
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
        // PLAN-292 T6: binary-safe read for image previews — fs::read_file_range
        // detects binary content and returns base64 with is_binary=true.
        "read_file_range" => {
            let path = req.payload.get("path").and_then(|v| v.as_str()).ok_or_else(|| RuntimeError::InvalidPath("missing path".into()))?;
            let offset = req.payload.get("offset").and_then(|v| v.as_u64()).map(|v| v as usize);
            let limit = req.payload.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize);
            let result = fs::read_file_range(path, offset, limit, WORKSPACE).await?;
            Ok(serde_json::json!({
                "content": result.content,
                "total_lines": result.total_lines,
                "is_binary": result.is_binary,
            }))
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
            let workspace_id = req.payload.get("workspaceId").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
            let command = req.payload.get("command").and_then(|v| v.as_str()).ok_or_else(|| RuntimeError::InvalidPath("missing command".into()))?.to_string();
            let args: Vec<String> = req.payload.get("args").and_then(|v| v.as_array()).map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
            // PLAN-0317 T3.3（决策 #3）：timeout 落实为任务运行时限（None→60 分钟默认，0→不限）。
            let timeout_secs = resolve_job_timeout(req.payload.get("timeoutSecs").and_then(|v| v.as_u64()));
            let job_id = start_background_job(&workspace_id, &command, args, timeout_secs).await?;
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
        "create_snapshot" => {
            let snapshot_id = req.payload.get("snapshotId").and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing snapshotId".into()))?;
            let files = req.payload.get("files").and_then(|v| v.as_array())
                .ok_or_else(|| RuntimeError::InvalidPath("missing files array".into()))?;
            let result = create_snapshot(snapshot_id, files)?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "revert_snapshot" => {
            let snapshot_id = req.payload.get("snapshotId").and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing snapshotId".into()))?;
            let result = revert_snapshot(snapshot_id)?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "apply_patch" => {
            let patches = req.payload.get("patches").and_then(|v| v.as_array())
                .ok_or_else(|| RuntimeError::InvalidPath("missing patches array".into()))?;
            let snapshot_id = req.payload.get("snapshotId").and_then(|v| v.as_str());
            let result = apply_patch(snapshot_id, patches)?;
            Ok(serde_json::to_value(result).unwrap())
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
    // PLAN-0317 T2.2: 登记进程组供中止信号使用；若中止已到达则立即终止。
    let pgid = child.id().map(|id| id as i32);
    register_oneshot_pgid(pgid);
    if abort_requested() {
        if let Some(pgid) = pgid {
            terminate_process_group(pgid).await;
        }
        register_oneshot_pgid(None);
        return Err(cancelled_error());
    }
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
                // Phase 1: SIGTERM (graceful)
                let _ = Command::new("sh").arg("-c").arg(format!("kill -TERM -- -{pid} 2>/dev/null")).status().await;
                // Phase 2: Wait 1s for graceful termination
                let graceful = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
                if graceful.is_err() {
                    // Phase 3: SIGKILL (force)
                    let _ = Command::new("sh").arg("-c").arg(format!("kill -9 -- -{pid} 2>/dev/null; kill -9 {pid} 2>/dev/null")).status().await;
                    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
                }
            }
            register_oneshot_pgid(None);
            // 中止信号先于守卫到界时，语义是"被取消"而非"超时"。
            if abort_requested() {
                return Err(cancelled_error());
            }
            // PLAN-0308 T3.4（决策 #31①）：守卫值来自授权（host 派生后下发）；
            // 沙盒只报它能确知的：层名 + 机制 + 守卫秒数。
            return Err(RuntimeError::guard_timeout(timeout_dur.as_secs()));
        }
    };
    register_oneshot_pgid(None);
    // 进程已结束时中止信号不再有意义（未被杀死就不是取消）。
    if abort_requested() && !status.success() {
        return Err(cancelled_error());
    }
    let stdout_bytes = stdout_handle.await.map_err(|e| RuntimeError::Command(e.to_string()))?;
    let stderr_bytes = stderr_handle.await.map_err(|e| RuntimeError::Command(e.to_string()))?;
    let stdout_str = String::from_utf8_lossy(&stdout_bytes).to_string();
    let stderr_str = String::from_utf8_lossy(&stderr_bytes).to_string();
    let (stdout_final, artifact_id) = if stdout_str.len() > limit {
        // 截断点必须是字符边界（此前按字节下标切片，多字节内容会 panic）。
        let (truncated, _) = truncate_utf8_safe(&stdout_str, limit);
        (truncated, None)
    } else { (stdout_str, None) };
    Ok(ExecResult { stdout: stdout_final, stderr: stderr_str, exit_code: status.code().unwrap_or(-1), success: status.success(), artifact_id })
}

// ── Job management via /tmp/xihe-jobs ────────────────────────────────────
#[derive(Serialize, Deserialize, Clone)]
#[allow(non_snake_case)]
struct JobInfo {
    jobId: String,
    workspace_id: String,
    command: String,
    status: String,
    pid: Option<String>,
    exit_code: Option<i32>,
    created_at: String,
    updated_at: Option<String>,
    stdout_preview: Option<String>,
    stderr_preview: Option<String>,
}

const JOB_PREVIEW_BYTES: usize = 256;

/// PLAN-0308 T3.4（决策 #31②）：按**字节**上限截断，且截断点必须落在字符边界上
/// （此前按字节下标直接切片，多字节内容会 panic）。返回 (文本, 是否发生截断)。
fn truncate_utf8_safe(text: &str, limit: usize) -> (String, bool) {
    if text.len() <= limit {
        return (text.to_string(), false);
    }
    let mut cut = limit;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    (
        format!("{}\n[truncated to {cut} bytes]", &text[..cut]),
        true,
    )
}

fn is_safe_job_id(job_id: &str) -> bool {
    !job_id.is_empty()
        && !job_id.contains('/')
        && !job_id.contains('\\')
        && !job_id.contains("..")
        && !job_id.contains('\0')
        && job_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

async fn start_background_job(
    workspace_id: &str,
    command: &str,
    args: Vec<String>,
    timeout_secs: u64,
) -> Result<String, RuntimeError> {
    start_background_job_at(Path::new(JOB_DIR), workspace_id, command, args, timeout_secs).await
}

// Keep the wrapper script fixed and pass all user-controlled values as
// positional arguments. This preserves the explicit shell-command contract
// without interpolating command text, arguments, or paths into shell syntax.
/// 后台任务默认运行时限（PLAN-0317 T3.3 / 决策 #3：60 分钟、可覆盖）。
/// 调用方显式传 0 表示不设时限（opt-out）。
const DEFAULT_JOB_TIMEOUT_SECS: u64 = 60 * 60;

fn resolve_job_timeout(requested: Option<u64>) -> u64 {
    match requested {
        None => DEFAULT_JOB_TIMEOUT_SECS,
        Some(0) => 0,
        Some(secs) => secs,
    }
}

const BACKGROUND_JOB_WRAPPER: &str = r#"job_dir="$1"
command="$2"
timeout_secs="$3"
shift 3
printf '%s\n' "$$" > "$job_dir/pid"
# PLAN-0317 T3.3：到点终止整个进程组并落 timeout 终态。看门狗放进独立会话
# （setsid），否则组杀会连它一起干掉、没人写终态。
if [ -n "$timeout_secs" ] && [ "$timeout_secs" != "0" ]; then
  setsid sh -c '
    sleep "$1"
    printf "%s\n" timeout > "$2/meta"
    printf "%s\n" 143 > "$2/exit"
    kill -TERM -- -"$3" 2>/dev/null || kill -TERM "$3" 2>/dev/null
    sleep 5
    kill -9 -- -"$3" 2>/dev/null || kill -9 "$3" 2>/dev/null
  ' xihe-job-timeout "$timeout_secs" "$job_dir" "$$" &
fi
sh -c "$command" xihe-shell "$@"
exit_code=$?
printf '%s\n' "$exit_code" > "$job_dir/exit"
printf '%s\n' succeeded > "$job_dir/meta"
"#;

fn background_wrapper_args(
    job_dir: &Path,
    command: &str,
    args: &[String],
    timeout_secs: u64,
) -> Vec<OsString> {
    let mut wrapper_args = vec![
        OsString::from("sh"),
        OsString::from("-c"),
        OsString::from(BACKGROUND_JOB_WRAPPER),
        OsString::from("xihe-job-wrapper"),
        job_dir.as_os_str().to_owned(),
        OsString::from(command),
        OsString::from(timeout_secs.to_string()),
    ];
    wrapper_args.extend(args.iter().map(OsString::from));
    wrapper_args
}

fn build_background_command(
    job_dir: &Path,
    command: &str,
    args: &[String],
    timeout_secs: u64,
    stdout: std::fs::File,
    stderr: std::fs::File,
) -> Command {
    let mut cmd = Command::new("setsid");
    cmd.args(background_wrapper_args(job_dir, command, args, timeout_secs))
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        // Dropping the Tokio child handle must not terminate the detached job.
        .kill_on_drop(false);
    cmd
}

async fn start_background_job_at(
    job_dir: &Path,
    workspace_id: &str,
    command: &str,
    args: Vec<String>,
    timeout_secs: u64,
) -> Result<String, RuntimeError> {
    std::fs::create_dir_all(job_dir).map_err(RuntimeError::Io)?;
    let jobs = std::fs::read_dir(job_dir)
        .map(|entries| entries.filter_map(Result::ok).count())
        .unwrap_or_default();
    if jobs >= 100 {
        return Err(RuntimeError::InvalidPath("job limit reached (100)".into()));
    }
    let job_id = uuid::Uuid::new_v4().to_string();
    let job_path = job_dir.join(&job_id);
    std::fs::create_dir_all(&job_path).map_err(RuntimeError::Io)?;
    let now = chrono::Utc::now().to_rfc3339();
    std::fs::write(job_path.join("meta"), "running").map_err(RuntimeError::Io)?;
    std::fs::write(job_path.join("command"), command).map_err(RuntimeError::Io)?;
    std::fs::write(job_path.join("workspace_id"), workspace_id).map_err(RuntimeError::Io)?;
    std::fs::write(job_path.join("started_at"), &now).map_err(RuntimeError::Io)?;
    std::fs::write(job_path.join("updated_at"), &now).map_err(RuntimeError::Io)?;
    if timeout_secs > 0 {
        std::fs::write(job_path.join("timeout_secs"), timeout_secs.to_string())
            .map_err(RuntimeError::Io)?;
    }
    let stdout = std::fs::File::create(job_path.join("stdout")).map_err(RuntimeError::Io)?;
    let stderr = std::fs::File::create(job_path.join("stderr")).map_err(RuntimeError::Io)?;
    let mut cmd = build_background_command(&job_path, command, &args, timeout_secs, stdout, stderr);
    let child = cmd
        .spawn()
        .map_err(|e| RuntimeError::Command(format!("failed to detach background job: {e}")))?;
    let pid = child
        .id()
        .ok_or_else(|| RuntimeError::Command("detached background job has no pid".into()))?;
    // `setsid` makes this PID both the process-group leader and its PGID on
    // Linux. Write it before dropping the handle so cancel/status can race
    // safely with the wrapper's own metadata initialization.
    std::fs::write(job_path.join("pid"), pid.to_string()).map_err(RuntimeError::Io)?;
    drop(child);
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
    if !is_safe_job_id(job_id) {
        return Err(RuntimeError::InvalidPath(format!("invalid job id: {job_id}")));
    }
    let job_path = PathBuf::from(JOB_DIR).join(job_id);
    if !job_path.exists() { return Err(RuntimeError::InvalidPath(format!("job not found: {job_id}"))); }
    let meta = std::fs::read_to_string(job_path.join("meta")).unwrap_or_else(|_| "unknown".to_string()).trim().to_string();
    let command = std::fs::read_to_string(job_path.join("command")).unwrap_or_default().trim().to_string();
    let workspace_id = std::fs::read_to_string(job_path.join("workspace_id")).unwrap_or_default().trim().to_string();
    let pid = std::fs::read_to_string(job_path.join("pid")).ok().map(|s| s.trim().to_string());
    let started_at = std::fs::read_to_string(job_path.join("started_at")).unwrap_or_default().trim().to_string();
    let updated_at = std::fs::read_to_string(job_path.join("updated_at")).ok().map(|s| s.trim().to_string());
    let exit_code = std::fs::read_to_string(job_path.join("exit")).ok().and_then(|s| s.trim().parse::<i32>().ok());
    let stdout_preview = std::fs::read(job_path.join("stdout")).ok().map(|bytes| {
        let preview = String::from_utf8_lossy(&bytes[..bytes.len().min(JOB_PREVIEW_BYTES)]).to_string();
        if bytes.len() > JOB_PREVIEW_BYTES { preview + "..." } else { preview }
    });
    let stderr_preview = std::fs::read(job_path.join("stderr")).ok().map(|bytes| {
        let preview = String::from_utf8_lossy(&bytes[..bytes.len().min(JOB_PREVIEW_BYTES)]).to_string();
        if bytes.len() > JOB_PREVIEW_BYTES { preview + "..." } else { preview }
    });
    let status = if meta == "running" {
        if let Some(pid_str) = &pid {
            if let Ok(pid_num) = pid_str.parse::<i32>() {
                let still_running = std::process::Command::new("sh").arg("-c").arg(format!("kill -0 -- -{pid_num} 2>/dev/null || kill -0 {pid_num} 2>/dev/null")).status().map(|s| s.success()).unwrap_or(false);
                if !still_running { if exit_code.is_some() { "succeeded".to_string() } else { "failed".to_string() } } else { "running".to_string() }
            } else { meta }
        } else { meta }
    } else { meta };
    Ok(JobInfo { jobId: job_id.to_string(), workspace_id, command, status, pid, exit_code, created_at: started_at, updated_at, stdout_preview, stderr_preview })
}

fn cancel_job(job_id: &str) -> Result<String, RuntimeError> {
    if !is_safe_job_id(job_id) {
        return Err(RuntimeError::InvalidPath(format!("invalid job id: {job_id}")));
    }
    let job_path = PathBuf::from(JOB_DIR).join(job_id);
    if !job_path.exists() { return Err(RuntimeError::InvalidPath(format!("job not found: {job_id}"))); }
    let pid_str = std::fs::read_to_string(job_path.join("pid")).map_err(|_| RuntimeError::InvalidPath("pid not found".into()))?;
    let pid_str = pid_str.trim();
    let pid_num: i32 = pid_str.parse().map_err(|_| RuntimeError::InvalidPath("invalid pid".into()))?;

    // Phase 1: SIGTERM to process group (graceful shutdown)
    let _ = std::process::Command::new("sh").arg("-c")
        .arg(format!("kill -TERM -- -{pid_num} 2>/dev/null"))
        .status();

    // Phase 2: Wait up to 3 seconds for graceful termination
    let mut terminated = false;
    for _ in 0..6 {
        std::thread::sleep(Duration::from_millis(500));
        let still_running = std::process::Command::new("sh").arg("-c")
            .arg(format!("kill -0 -- -{pid_num} 2>/dev/null || kill -0 {pid_num} 2>/dev/null"))
            .status().map(|s| s.success()).unwrap_or(false);
        if !still_running { terminated = true; break; }
    }

    // Phase 3: SIGKILL if still running (force kill)
    if !terminated {
        let _ = std::process::Command::new("sh").arg("-c")
            .arg(format!("kill -9 -- -{pid_num} 2>/dev/null; kill -9 {pid_num} 2>/dev/null"))
            .status();
        std::thread::sleep(Duration::from_millis(200));
    }

    // Phase 4: Verify process is gone
    let still_alive = std::process::Command::new("sh").arg("-c")
        .arg(format!("kill -0 -- -{pid_num} 2>/dev/null || kill -0 {pid_num} 2>/dev/null"))
        .status().map(|s| s.success()).unwrap_or(false);

    let status = if still_alive { "failed" } else { "cancelled" };
    std::fs::write(job_path.join("meta"), status).map_err(RuntimeError::Io)?;
    std::fs::write(job_path.join("updated_at"), chrono::Utc::now().to_rfc3339()).map_err(RuntimeError::Io)?;
    Ok(status.to_string())
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
    cleanup_expired_jobs_with(Path::new(JOB_DIR), JOB_TTL_SECS, process_group_alive)
}

/// Reclaims finished jobs whose last file activity is older than `ttl_secs`.
///
/// Guards (PLAN-0317 decision #15):
///   * running jobs are never touched — liveness is decided by the job's
///     `meta` state plus a `kill -0` probe on the process group, never by a
///     directory mtime (long-running jobs do not update it);
///   * the expiry clock uses the newest **file** mtime inside the job dir
///     (meta/exit/stdout/...), not the directory entry itself.
fn cleanup_expired_jobs_with(
    job_dir: &Path,
    ttl_secs: u64,
    alive: impl Fn(i32) -> bool,
) -> Result<usize, RuntimeError> {
    let mut cleaned = 0;
    if !job_dir.exists() {
        return Ok(0);
    }
    let now = std::time::SystemTime::now();
    for entry in std::fs::read_dir(job_dir).map_err(RuntimeError::Io)? {
        let entry = entry.map_err(RuntimeError::Io)?;
        let job_path = entry.path();
        if !job_path.is_dir() {
            continue;
        }
        if job_is_running_with(&job_path, &alive) {
            continue;
        }
        let expired = job_last_file_activity(&job_path)
            .and_then(|last| now.duration_since(last).ok())
            .is_some_and(|elapsed| elapsed.as_secs() > ttl_secs);
        if expired {
            let _ = std::fs::remove_dir_all(&job_path);
            cleaned += 1;
            continue;
        }
        for fname in ["stdout", "stderr"] {
            let fpath = job_path.join(fname);
            if let Ok(md) = std::fs::metadata(&fpath)
                && md.len() > JOB_CAP as u64
            {
                let _ = std::process::Command::new("sh").arg("-c").arg(format!("head -c {} {} > {}.tmp && mv {}.tmp {}", JOB_CAP, fpath.display(), fpath.display(), fpath.display(), fpath.display())).status();
            }
        }
    }
    Ok(cleaned)
}

/// A job is running when its recorded state says so and its process group is
/// still alive. Unknown or unreadable state is treated as running (fail safe:
/// never delete metadata we cannot judge).
fn job_is_running_with(job_path: &Path, alive: &impl Fn(i32) -> bool) -> bool {
    let meta = std::fs::read_to_string(job_path.join("meta")).unwrap_or_default();
    if meta.trim() != "running" {
        return false;
    }
    let Ok(pid) = std::fs::read_to_string(job_path.join("pid")) else {
        return true;
    };
    let pid = pid.trim();
    let Ok(pid_num) = pid.parse::<i32>() else {
        return true;
    };
    alive(pid_num)
}

fn process_group_alive(pid: i32) -> bool {
    std::process::Command::new("sh")
        .arg("-c")
        .arg(format!(
            "kill -0 -- -{pid} 2>/dev/null || kill -0 {pid} 2>/dev/null"
        ))
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Newest mtime across the job directory's files (never the directory itself).
fn job_last_file_activity(job_path: &Path) -> Option<std::time::SystemTime> {
    let entries = std::fs::read_dir(job_path).ok()?;
    let mut latest: Option<std::time::SystemTime> = None;
    for entry in entries.flatten() {
        if let Ok(md) = entry.metadata()
            && md.is_file()
            && let Ok(modified) = md.modified()
        {
            latest = Some(match latest {
                Some(prev) if prev >= modified => prev,
                _ => modified,
            });
        }
    }
    latest
}

// ── Snapshot/Revert/Patch (PLAN-275 M2) ────────────────────────────────

const SNAPSHOT_DIR: &str = "/workspace/.xihe-snapshots";
const SNAPSHOT_MAX_FILES: usize = 200;
const SNAPSHOT_MAX_SIZE: usize = 10 * 1024 * 1024; // 10MB per file
const PATCH_DIFF_MAX_BYTES: usize = 256 * 1024;

fn is_safe_relative_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.starts_with('\\')
        && !path.contains("..")
        && !path.contains('\0')
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotResult {
    snapshot_id: String,
    files_captured: usize,
    files: Vec<SnapshotFileInfo>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotFileInfo {
    relative_path: String,
    existed_before: bool,
    content_hash: String,
    post_content_hash: Option<String>,
    size_bytes: u64,
}

#[derive(Serialize, Deserialize)]
struct SnapshotManifest {
    files: Vec<SnapshotFileInfo>,
}

fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Sha256, Digest};
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

fn create_snapshot(snapshot_id: &str, files: &[serde_json::Value]) -> Result<SnapshotResult, RuntimeError> {
    create_snapshot_at(Path::new(SNAPSHOT_DIR), Path::new(WORKSPACE), snapshot_id, files)
}

fn create_snapshot_at(
    snapshot_root: &Path,
    workspace: &Path,
    snapshot_id: &str,
    files: &[serde_json::Value],
) -> Result<SnapshotResult, RuntimeError> {
    if !is_safe_job_id(snapshot_id) {
        return Err(RuntimeError::InvalidPath(format!("invalid snapshot id: {snapshot_id}")));
    }
    if files.len() > SNAPSHOT_MAX_FILES {
        return Err(RuntimeError::InvalidPath(format!("snapshot file limit exceeded: {} > {}", files.len(), SNAPSHOT_MAX_FILES)));
    }

    let snapshot_dir = snapshot_root.join(snapshot_id);
    std::fs::create_dir_all(&snapshot_dir).map_err(RuntimeError::Io)?;

    let mut captured = Vec::new();

    for file_entry in files {
        let rel_path = file_entry.get("relativePath")
            .and_then(|v| v.as_str())
            .ok_or_else(|| RuntimeError::InvalidPath("missing relativePath in snapshot file entry".to_string()))?;

        if !is_safe_relative_path(rel_path) {
            return Err(RuntimeError::PathTraversal { path: rel_path.to_string() });
        }

        let abs_path = workspace.join(rel_path);
        let existed_before = abs_path.exists();

        if existed_before {
            let content = std::fs::read(&abs_path).map_err(RuntimeError::Io)?;
            if content.len() > SNAPSHOT_MAX_SIZE {
                return Err(RuntimeError::InvalidPath(format!("snapshot file too large: {} ({})", rel_path, content.len())));
            }
            let hash = sha256_hex(&content);
            let dest = snapshot_dir.join(rel_path);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(RuntimeError::Io)?;
            }
            std::fs::write(&dest, &content).map_err(RuntimeError::Io)?;

            captured.push(SnapshotFileInfo {
                relative_path: rel_path.to_string(),
                existed_before: true,
                content_hash: hash,
                post_content_hash: None,
                size_bytes: content.len() as u64,
            });
        } else {
            captured.push(SnapshotFileInfo {
                relative_path: rel_path.to_string(),
                existed_before: false,
                content_hash: String::new(),
                post_content_hash: None,
                size_bytes: 0,
            });
        }
    }

    let manifest = SnapshotManifest {
        files: captured.clone(),
    };
    let manifest_payload = serde_json::to_vec(&manifest)
        .map_err(|e| RuntimeError::Command(format!("failed to serialize snapshot manifest: {e}")))?;
    std::fs::write(snapshot_dir.join(".manifest.json"), manifest_payload)
        .map_err(RuntimeError::Io)?;

    let files_captured = captured.len();
    info!("snapshot_created id={} files={}", snapshot_id, files_captured);
    Ok(SnapshotResult { snapshot_id: snapshot_id.to_string(), files_captured, files: captured })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RevertResult {
    snapshot_id: String,
    files_reverted: usize,
    conflicts: Vec<String>,
}

fn revert_snapshot(snapshot_id: &str) -> Result<RevertResult, RuntimeError> {
    revert_snapshot_at(Path::new(SNAPSHOT_DIR), Path::new(WORKSPACE), snapshot_id)
}

fn revert_snapshot_at(
    snapshot_root: &Path,
    workspace: &Path,
    snapshot_id: &str,
) -> Result<RevertResult, RuntimeError> {
    if !is_safe_job_id(snapshot_id) {
        return Err(RuntimeError::InvalidPath(format!("invalid snapshot id: {snapshot_id}")));
    }

    let snapshot_dir = snapshot_root.join(snapshot_id);
    if !snapshot_dir.exists() {
        return Err(RuntimeError::FileNotFound(format!("snapshot not found: {snapshot_id}")));
    }

    let manifest_path = snapshot_dir.join(".manifest.json");
    let manifest_payload = std::fs::read(&manifest_path).map_err(RuntimeError::Io)?;
    let manifest: SnapshotManifest = serde_json::from_slice(&manifest_payload)
        .map_err(|e| RuntimeError::InvalidPath(format!("invalid snapshot manifest: {e}")))?;
    if manifest.files.len() > SNAPSHOT_MAX_FILES {
        return Err(RuntimeError::InvalidPath("snapshot manifest file limit exceeded".into()));
    }

    let mut reverted = 0;
    let mut conflicts = Vec::new();

    for file in manifest.files {
        let rel_path = file.relative_path;
        if !is_safe_relative_path(&rel_path) {
            return Err(RuntimeError::PathTraversal { path: rel_path });
        }

        let abs_path = workspace.join(&rel_path);

        if !file.existed_before {
            if abs_path.exists() {
                if abs_path.is_file() && file.post_content_hash.as_deref().is_some_and(|hash| {
                    std::fs::read(&abs_path)
                        .map(|content| sha256_hex(&content) == hash)
                        .unwrap_or(false)
                }) {
                    std::fs::remove_file(&abs_path).map_err(RuntimeError::Io)?;
                    reverted += 1;
                } else {
                    conflicts.push(rel_path);
                }
            }
            continue;
        }

        let snapshot_file = snapshot_dir.join(&rel_path);
        let pre_image = std::fs::read(&snapshot_file).map_err(RuntimeError::Io)?;
        let pre_hash = sha256_hex(&pre_image);
        if pre_hash != file.content_hash {
            return Err(RuntimeError::InvalidPath(format!(
                "snapshot manifest hash mismatch for {rel_path}"
            )));
        }

        if abs_path.exists() {
            let current = std::fs::read(&abs_path).map_err(RuntimeError::Io)?;
            let current_hash = sha256_hex(&current);
            let already_reverted = current_hash == file.content_hash;
            let matches_post_image = file.post_content_hash.as_deref() == Some(current_hash.as_str());
            if !already_reverted && !matches_post_image {
                conflicts.push(rel_path);
                continue;
            }
        }

        if let Some(parent) = abs_path.parent() {
            std::fs::create_dir_all(parent).map_err(RuntimeError::Io)?;
        }
        std::fs::write(&abs_path, &pre_image).map_err(RuntimeError::Io)?;
        reverted += 1;
    }

    info!("snapshot_reverted id={} reverted={} conflicts={}", snapshot_id, reverted, conflicts.len());
    Ok(RevertResult { snapshot_id: snapshot_id.to_string(), files_reverted: reverted, conflicts })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PatchResult {
    changed: Vec<String>,
    diff: String,
    new_hashes: std::collections::HashMap<String, String>,
}

struct PreparedPatch {
    relative_path: String,
    absolute_path: PathBuf,
    original_exists: bool,
    original_content: String,
    content: String,
}

fn apply_patch(snapshot_id: Option<&str>, patches: &[serde_json::Value]) -> Result<PatchResult, RuntimeError> {
    apply_patch_at(Path::new(WORKSPACE), Path::new(SNAPSHOT_DIR), snapshot_id, patches)
}

fn apply_patch_at(
    workspace: &Path,
    snapshot_root: &Path,
    snapshot_id: Option<&str>,
    patches: &[serde_json::Value],
) -> Result<PatchResult, RuntimeError> {
    if patches.is_empty() {
        return Err(RuntimeError::InvalidPath("empty patches array".into()));
    }

    let mut prepared = Vec::with_capacity(patches.len());
    let mut seen_paths = std::collections::HashSet::new();

    // Phase 1: validate and compute all new contents before applying any patch.
    for patch in patches {
        let rel_path = patch.get("path").and_then(|v| v.as_str())
            .ok_or_else(|| RuntimeError::InvalidPath("missing path in patch".to_string()))?;
        let expected_hash = patch.get("expectedHash").and_then(|v| v.as_str())
            .ok_or_else(|| RuntimeError::InvalidPath("missing expectedHash in patch".to_string()))?;

        if !is_safe_relative_path(rel_path) {
            return Err(RuntimeError::PathTraversal { path: rel_path.to_string() });
        }
        if !seen_paths.insert(rel_path.to_string()) {
            return Err(RuntimeError::InvalidPath(format!("duplicate patch path: {rel_path}")));
        }

        let abs_path = workspace.join(rel_path);
        let original_exists = abs_path.exists();
        let original_content = if original_exists {
            std::fs::read_to_string(&abs_path).map_err(RuntimeError::Io)?
        } else {
            String::new()
        };
        if original_exists {
            let current_hash = sha256_hex(original_content.as_bytes());
            if current_hash != expected_hash {
                return Err(RuntimeError::InvalidPath(format!(
                    "hash mismatch for {rel_path}: expected {expected_hash}, got {current_hash}"
                )));
            }
        } else if !expected_hash.is_empty() {
            return Err(RuntimeError::FileNotFound(format!(
                "file not found for patch: {rel_path}"
            )));
        }

        let hunks = patch.get("hunks").and_then(|v| v.as_array())
            .ok_or_else(|| RuntimeError::InvalidPath("missing hunks in patch".to_string()))?;
        if hunks.is_empty() {
            return Err(RuntimeError::InvalidPath(format!("empty hunks for {rel_path}")));
        }

        let mut content = original_content.clone();
        for hunk in hunks {
            let before = hunk.get("before").and_then(|v| v.as_str()).unwrap_or("");
            let after = hunk.get("after").and_then(|v| v.as_str()).unwrap_or("");

            if before.is_empty() && content.is_empty() {
                // New file creation
                content = after.to_string();
            } else if let Some(pos) = content.find(before) {
                content.replace_range(pos..pos + before.len(), after);
            } else {
                return Err(RuntimeError::InvalidPath(format!(
                    "hunk not found in {rel_path}: {before:?}"
                )));
            }
        }

        prepared.push(PreparedPatch {
            relative_path: rel_path.to_string(),
            absolute_path: abs_path,
            original_exists,
            original_content,
            content,
        });
    }

    let prepared_manifest = snapshot_id
        .map(|id| prepare_snapshot_post_hashes(snapshot_root, id, &prepared))
        .transpose()?;

    // Phase 2: apply all patches and restore already-written files on failure.
    let mut applied = Vec::with_capacity(prepared.len());
    for (index, patch) in prepared.iter().enumerate() {
        applied.push(index);
        let write_result = (|| {
            if let Some(parent) = patch.absolute_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&patch.absolute_path, &patch.content)
        })();
        if let Err(error) = write_result {
            if let Err(rollback_error) = rollback_patches(&prepared, &applied) {
                tracing::error!(
                    error = %error,
                    rollback_error = %rollback_error,
                    "patch application and rollback both failed"
                );
                return Err(RuntimeError::Command(format!(
                    "patch failed and rollback failed: {error}; {rollback_error}"
                )));
            }
            return Err(RuntimeError::Io(error));
        }
    }

    let mut changed = Vec::with_capacity(prepared.len());
    let mut new_hashes = std::collections::HashMap::new();
    let mut diff_lines = Vec::new();
    for patch in &prepared {
        let new_hash = sha256_hex(patch.content.as_bytes());
        new_hashes.insert(patch.relative_path.clone(), new_hash);
        changed.push(patch.relative_path.clone());

        // Build a bounded diff so large file contents are never returned in full.
        diff_lines.push(format!("--- a/{}", patch.relative_path));
        diff_lines.push(format!("+++ b/{}", patch.relative_path));
        diff_lines.push(format!("@@ -0,0 +1,{} @@", patch.content.lines().count()));
        let mut diff_bytes = diff_lines.iter().map(|line| line.len() + 1).sum::<usize>();
        let truncation_marker = format!("[diff truncated at {PATCH_DIFF_MAX_BYTES} bytes]");
        let content_limit = PATCH_DIFF_MAX_BYTES.saturating_sub(truncation_marker.len() + 1);
        for line in patch.content.lines() {
            let rendered = format!("+{line}");
            if diff_bytes + rendered.len() + 1 > content_limit {
                diff_lines.push(truncation_marker.clone());
                break;
            }
            diff_bytes += rendered.len() + 1;
            diff_lines.push(rendered);
        }
    }

    if let Some((manifest_path, manifest_payload)) = prepared_manifest
        && let Err(error) = std::fs::write(&manifest_path, manifest_payload)
    {
        if let Err(rollback_error) = rollback_patches(&prepared, &applied) {
            tracing::error!(
                error = %error,
                rollback_error = %rollback_error,
                "snapshot manifest update and patch rollback both failed"
            );
            return Err(RuntimeError::Command(format!(
                "snapshot manifest update failed and rollback failed: {error}; {rollback_error}"
            )));
        }
        return Err(RuntimeError::Io(error));
    }

    let diff = diff_lines.join("\n");
    info!("patch_applied files={}", changed.len());
    Ok(PatchResult { changed, diff, new_hashes })
}

fn prepare_snapshot_post_hashes(
    snapshot_root: &Path,
    snapshot_id: &str,
    changes: &[PreparedPatch],
) -> Result<(PathBuf, Vec<u8>), RuntimeError> {
    if !is_safe_job_id(snapshot_id) {
        return Err(RuntimeError::InvalidPath(format!("invalid snapshot id: {snapshot_id}")));
    }
    let snapshot_dir = snapshot_root.join(snapshot_id);
    let manifest_path = snapshot_dir.join(".manifest.json");
    let manifest_payload = std::fs::read(&manifest_path).map_err(RuntimeError::Io)?;
    let mut manifest: SnapshotManifest = serde_json::from_slice(&manifest_payload)
        .map_err(|e| RuntimeError::InvalidPath(format!("invalid snapshot manifest: {e}")))?;
    for change in changes {
        let hash = sha256_hex(change.content.as_bytes());
        let entry = manifest
            .files
            .iter_mut()
            .find(|file| file.relative_path == change.relative_path)
            .ok_or_else(|| RuntimeError::InvalidPath(format!(
                "snapshot manifest missing patch path: {}", change.relative_path
            )))?;
        entry.post_content_hash = Some(hash);
    }
    let updated = serde_json::to_vec(&manifest)
        .map_err(|e| RuntimeError::Command(format!("failed to serialize snapshot manifest: {e}")))?;
    Ok((manifest_path, updated))
}

fn rollback_patches(changes: &[PreparedPatch], applied: &[usize]) -> Result<(), std::io::Error> {
    for index in applied.iter().rev() {
        let patch = &changes[*index];
        if patch.original_exists {
            std::fs::write(&patch.absolute_path, &patch.original_content)?;
        } else if patch.absolute_path.exists() {
            std::fs::remove_file(&patch.absolute_path)?;
        }
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    #[cfg(unix)]
    use std::time::Instant;
    #[test]
    fn background_wrapper_keeps_user_values_out_of_shell_script() {
        let command = r#"printf '%s' "$1""#;
        let argument = "value; touch injected-file".to_string();
        let wrapper_args = background_wrapper_args(
            Path::new("/tmp/job with spaces"),
            command,
            std::slice::from_ref(&argument),
            0,
        );

        assert_eq!(wrapper_args[2], OsString::from(BACKGROUND_JOB_WRAPPER));
        assert_eq!(wrapper_args[5], OsString::from(command));
        // PLAN-0317 T3.3：timeout 是第三个位置参数，用户参数紧随其后。
        assert_eq!(wrapper_args[6], OsString::from("0"));
        assert_eq!(wrapper_args[7], OsString::from(argument));
        assert!(!wrapper_args[2].to_string_lossy().contains("injected-file"));
    }

    #[test]
    fn snapshot_manifest_reverts_nested_and_new_files() {
        let tmp = TempDir::new().expect("temporary snapshot directory");
        let workspace = tmp.path().join("workspace");
        let snapshot_root = tmp.path().join("snapshots");
        std::fs::create_dir_all(workspace.join("src")).unwrap();
        std::fs::write(workspace.join("src/main.rs"), "before").unwrap();

        let files = vec![
            serde_json::json!({"relativePath": "src/main.rs"}),
            serde_json::json!({"relativePath": "created.txt"}),
        ];
        let snapshot = create_snapshot_at(&snapshot_root, &workspace, "snapshot-1", &files)
            .expect("snapshot should be created");
        assert_eq!(snapshot.files_captured, 2);
        assert!(snapshot_root.join("snapshot-1/.manifest.json").exists());

        let patches = vec![
            serde_json::json!({
                "path": "src/main.rs",
                "expectedHash": sha256_hex(b"before"),
                "hunks": [{"before": "before", "after": "after"}]
            }),
            serde_json::json!({
                "path": "created.txt",
                "expectedHash": "",
                "hunks": [{"before": "", "after": "created"}]
            }),
        ];
        apply_patch_at(&workspace, &snapshot_root, Some("snapshot-1"), &patches)
            .expect("patch should update the snapshot post-images");

        let reverted = revert_snapshot_at(&snapshot_root, &workspace, "snapshot-1")
            .expect("snapshot should be reverted");
        assert_eq!(reverted.files_reverted, 2);
        assert!(reverted.conflicts.is_empty());
        assert_eq!(
            std::fs::read_to_string(workspace.join("src/main.rs")).unwrap(),
            "before"
        );
        assert!(!workspace.join("created.txt").exists());
    }

    #[test]
    fn apply_patch_rolls_back_previous_files_when_later_write_fails() {
        let tmp = TempDir::new().expect("temporary workspace");
        let workspace = tmp.path().join("workspace");
        let snapshot_root = tmp.path().join("snapshots");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join("first.txt"), "before").unwrap();
        std::fs::write(workspace.join("blocked"), "not a directory").unwrap();

        let patches = vec![
            serde_json::json!({
                "path": "first.txt",
                "expectedHash": sha256_hex(b"before"),
                "hunks": [{"before": "before", "after": "after"}]
            }),
            serde_json::json!({
                "path": "blocked/second.txt",
                "expectedHash": "",
                "hunks": [{"before": "", "after": "new file"}]
            }),
        ];

        assert!(apply_patch_at(&workspace, &snapshot_root, None, &patches).is_err());
        assert_eq!(
            std::fs::read_to_string(workspace.join("first.txt")).unwrap(),
            "before"
        );
        assert!(!workspace.join("blocked/second.txt").exists());
    }

    #[test]
    fn revert_snapshot_reports_external_modification_conflict() {
        let tmp = TempDir::new().expect("temporary snapshot directory");
        let workspace = tmp.path().join("workspace");
        let snapshot_root = tmp.path().join("snapshots");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join("file.txt"), "before").unwrap();

        let files = vec![serde_json::json!({"relativePath": "file.txt"})];
        create_snapshot_at(&snapshot_root, &workspace, "snapshot-2", &files)
            .expect("snapshot should be created");
        let patches = vec![serde_json::json!({
            "path": "file.txt",
            "expectedHash": sha256_hex(b"before"),
            "hunks": [{"before": "before", "after": "after"}]
        })];
        apply_patch_at(&workspace, &snapshot_root, Some("snapshot-2"), &patches)
            .expect("patch should apply");
        std::fs::write(workspace.join("file.txt"), "external").unwrap();

        let reverted = revert_snapshot_at(&snapshot_root, &workspace, "snapshot-2")
            .expect("revert should return a conflict result");
        assert_eq!(reverted.files_reverted, 0);
        assert_eq!(reverted.conflicts, vec!["file.txt"]);
        assert_eq!(
            std::fs::read_to_string(workspace.join("file.txt")).unwrap(),
            "external"
        );
    }

    #[test]
    fn apply_patch_bounds_unified_diff_output() {
        let tmp = TempDir::new().expect("temporary workspace");
        let workspace = tmp.path().join("workspace");
        let original = "before";
        let replacement = "x\n".repeat(PATCH_DIFF_MAX_BYTES / 2);
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join("large.txt"), original).unwrap();

        let patches = vec![serde_json::json!({
            "path": "large.txt",
            "expectedHash": sha256_hex(original.as_bytes()),
            "hunks": [{"before": original, "after": replacement}]
        })];
        let result = apply_patch_at(&workspace, tmp.path(), None, &patches)
            .expect("large patch should apply");

        assert!(result.diff.len() <= PATCH_DIFF_MAX_BYTES);
        assert!(result.diff.contains("diff truncated"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn background_job_detaches_and_completes_metadata_asynchronously() {
        let tmp = TempDir::new().expect("temporary job directory");
        let started = Instant::now();
        let job_id = start_background_job_at(tmp.path(), "sleep 2", Vec::new(), 0)
            .await
            .expect("background job should spawn");
        let job_path = tmp.path().join(&job_id);

        assert!(
            started.elapsed() < Duration::from_secs(1),
            "detached start waited for the child: {:?}",
            started.elapsed()
        );
        assert_eq!(
            std::fs::read_to_string(job_path.join("meta"))
                .unwrap()
                .trim(),
            "running"
        );
        let pid = std::fs::read_to_string(job_path.join("pid")).unwrap();
        assert!(!pid.trim().is_empty());
        assert!(
            std::process::Command::new("kill")
                .args(["-0", pid.trim()])
                .status()
                .unwrap()
                .success(),
            "detached process should still be alive"
        );
        assert!(!job_path.join("exit").exists());

        for _ in 0..30 {
            if job_path.join("exit").exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        assert_eq!(
            std::fs::read_to_string(job_path.join("exit"))
                .unwrap()
                .trim(),
            "0"
        );
        assert_eq!(
            std::fs::read_to_string(job_path.join("meta"))
                .unwrap()
                .trim(),
            "succeeded"
        );
        assert!(job_path.join("stdout").exists());
        assert!(job_path.join("stderr").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn background_job_passes_arguments_without_shell_injection() {
        let tmp = TempDir::new().expect("temporary job directory");
        let marker = tmp.path().join("injected");
        let argument = format!("safe; touch {}", marker.display());
        let job_id = start_background_job_at(tmp.path(), r#"printf '%s' "$1""#, vec![argument.clone()], 0)
            .await
            .expect("background job should spawn");
        let job_path = tmp.path().join(&job_id);

        for _ in 0..20 {
            if job_path.join("exit").exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        assert_eq!(
            std::fs::read_to_string(job_path.join("stdout")).unwrap(),
            argument
        );
        assert!(
            !marker.exists(),
            "argument text was interpreted as shell syntax"
        );
        assert_eq!(
            std::fs::read_to_string(job_path.join("exit"))
                .unwrap()
                .trim(),
            "0"
        );
    }

    // ── T3.4（决策 #31②）：字节上限截断必须 UTF-8 安全 ──────────────────────

    #[test]
    fn truncate_keeps_short_output_verbatim() {
        let (text, truncated) = truncate_utf8_safe("hello", 4096);
        assert_eq!(text, "hello");
        assert!(!truncated);
    }

    #[test]
    fn truncate_marks_byte_limit() {
        let input = "a".repeat(100);
        let (text, truncated) = truncate_utf8_safe(&input, 10);
        assert!(truncated);
        assert_eq!(text, format!("{}\n[truncated to 10 bytes]", "a".repeat(10)));
    }

    #[test]
    fn truncate_never_splits_multibyte_chars() {
        // 每个汉字 3 字节：limit=4 落在第二个字中间，必须回退到 3 字节边界。
        let input = "汉字内容";
        let (text, truncated) = truncate_utf8_safe(input, 4);
        assert!(truncated);
        assert!(text.starts_with("汉"), "got {text:?}");
        assert!(!text.contains('\u{fffd}'), "must not split a char: {text:?}");
        assert!(text.ends_with("[truncated to 3 bytes]"), "got {text:?}");
    }

    // ── T1.1（决策 #15）：清理不得误伤运行中的 job，且不得用目录 mtime ──────

    fn write_fake_job(
        dir: &Path,
        job_id: &str,
        meta: &str,
        pid: Option<&str>,
        age_secs: u64,
    ) -> PathBuf {
        let job = dir.join(job_id);
        std::fs::create_dir_all(&job).unwrap();
        std::fs::write(job.join("meta"), format!("{meta}\n")).unwrap();
        if let Some(pid) = pid {
            std::fs::write(job.join("pid"), format!("{pid}\n")).unwrap();
        }
        std::fs::write(job.join("stdout"), b"out").unwrap();
        let stamp = std::time::SystemTime::now() - std::time::Duration::from_secs(age_secs);
        for f in ["meta", "pid", "stdout"] {
            let p = job.join(f);
            if p.exists() {
                std::fs::File::options()
                    .write(true)
                    .open(&p)
                    .unwrap()
                    .set_modified(stamp)
                    .unwrap();
            }
        }
        job
    }

    #[test]
    fn cleanup_keeps_running_job_even_when_expired() {
        let tmp = TempDir::new().unwrap();
        let job = write_fake_job(tmp.path(), "job-running", "running", Some("4321"), 86400);
        let cleaned = cleanup_expired_jobs_with(tmp.path(), 900, |_pid| true).unwrap();
        assert_eq!(cleaned, 0);
        assert!(job.join("meta").exists());
    }

    #[test]
    fn cleanup_keeps_running_job_without_readable_pid() {
        let tmp = TempDir::new().unwrap();
        let job = write_fake_job(tmp.path(), "job-unknown", "running", None, 86400);
        let cleaned = cleanup_expired_jobs_with(tmp.path(), 900, |_pid| false).unwrap();
        assert_eq!(cleaned, 0);
        assert!(job.exists());
    }

    #[test]
    fn cleanup_reclaims_expired_finished_job() {
        let tmp = TempDir::new().unwrap();
        let job = write_fake_job(tmp.path(), "job-done", "succeeded", None, 86400);
        let cleaned = cleanup_expired_jobs_with(tmp.path(), 900, |_pid| false).unwrap();
        assert_eq!(cleaned, 1);
        assert!(!job.exists());
    }

    #[test]
    fn cleanup_keeps_recent_finished_job() {
        let tmp = TempDir::new().unwrap();
        let job = write_fake_job(tmp.path(), "job-recent", "succeeded", None, 3);
        let cleaned = cleanup_expired_jobs_with(tmp.path(), 900, |_pid| false).unwrap();
        assert_eq!(cleaned, 0);
        assert!(job.exists());
    }

    #[test]
    fn cleanup_treats_dead_pid_as_finished() {
        let tmp = TempDir::new().unwrap();
        let job = write_fake_job(tmp.path(), "job-dead", "running", Some("99999999"), 86400);
        let cleaned = cleanup_expired_jobs_with(tmp.path(), 900, |_pid| false).unwrap();
        assert_eq!(cleaned, 1);
        assert!(!job.exists());
    }

    // ── T2.2（决策 #13）：中止信号必须闩锁，且无进程组时安全 ────────────────

    #[test]
    fn oneshot_abort_signal_is_latched_and_safe_without_pgid() {
        register_oneshot_pgid(None);
        assert!(!abort_requested(), "abort must start unset in this binary");
        mark_oneshot_aborted("test frame");
        assert!(abort_requested());
        // Second abort is a no-op and must not panic when no group is registered.
        mark_oneshot_aborted("duplicate frame");
        assert!(abort_requested());
    }

    // ── T3.3（决策 #3）：后台任务运行时限 ────────────────────────────────

    #[test]
    fn job_timeout_defaults_to_sixty_minutes_and_zero_opts_out() {
        assert_eq!(resolve_job_timeout(None), 60 * 60);
        assert_eq!(resolve_job_timeout(Some(0)), 0, "explicit 0 = no limit");
        assert_eq!(resolve_job_timeout(Some(120)), 120);
    }

    #[test]
    fn wrapper_enforces_timeout_in_a_separate_session() {
        assert!(
            BACKGROUND_JOB_WRAPPER.contains("shift 3"),
            "wrapper must take the timeout as its third positional argument"
        );
        assert!(
            BACKGROUND_JOB_WRAPPER.contains("setsid sh -c"),
            "watchdog must escape the job's process group to survive the group kill"
        );
        assert!(
            BACKGROUND_JOB_WRAPPER.contains("timeout") && BACKGROUND_JOB_WRAPPER.contains("/meta"),
            "watchdog must record the timeout terminal state"
        );
    }
}
