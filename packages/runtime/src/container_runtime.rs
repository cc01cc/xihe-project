use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tracing::info;

use tokio::io::{AsyncBufReadExt, BufReader};
use xihe_runtime::error::RuntimeError;
use xihe_runtime::fs;

const WORKSPACE: &str = "/workspace";
const JOB_DIR: &str = "/tmp/xihe-jobs";
const JOB_CAP: usize = 1024 * 1024;
const JOB_TTL_SECS: u64 = 15 * 60;
// Coding/Isolated gateways reach this service through a Docker-assigned loopback
// host port. Binding all container interfaces is required because Windows native
// hosts cannot route directly to Docker Desktop's Linux bridge IP.

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
        .arg(format!("/bin/kill -TERM -- -{pgid} 2>/dev/null"))
        .status()
        .await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let _ = Command::new("sh")
        .arg("-c")
        .arg(format!(
            "/bin/kill -9 -- -{pgid} 2>/dev/null; kill -9 {pgid} 2>/dev/null"
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
    eprintln!("xihe-container-runtime daemon mode retired (PLAN-0347 T1.5); use --oneshot");
    std::process::exit(2);
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
        Ok(val) => OperationResponse {
            ok: true,
            result: val,
            error: None,
            error_code: None,
        },
        Err(e) => {
            let (code, msg) = map_runtime_error(&e);
            OperationResponse {
                ok: false,
                result: serde_json::Value::Null,
                error: Some(OperationError {
                    code: code.clone(),
                    message: msg.clone(),
                }),
                error_code: Some(code),
            }
        }
    };
    let out = serde_json::to_string(&resp)?;
    println!("{out}");
    Ok(())
}

fn map_runtime_error(e: &RuntimeError) -> (String, String) {
    match e {
        RuntimeError::PathTraversal { path } => ("PATH_TRAVERSAL".to_string(), path.clone()),
        RuntimeError::SymlinkEscape { path, resolved } => (
            "SYMLINK_ESCAPE".to_string(),
            format!("{path} -> {resolved}"),
        ),
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
            let path = req
                .payload
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing path".into()))?;
            let content = fs::read_file(path, WORKSPACE).await?;
            Ok(serde_json::json!({"content": content}))
        }
        // PLAN-292 T6: binary-safe read for image previews — fs::read_file_range
        // detects binary content and returns base64 with is_binary=true.
        "read_file_range" => {
            let path = req
                .payload
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing path".into()))?;
            let offset = req
                .payload
                .get("offset")
                .and_then(|v| v.as_u64())
                .map(|v| v as usize);
            let limit = req
                .payload
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|v| v as usize);
            let result = fs::read_file_range(path, offset, limit, WORKSPACE).await?;
            Ok(serde_json::json!({
                "content": result.content,
                "total_lines": result.total_lines,
                "is_binary": result.is_binary,
            }))
        }
        "write_file" => {
            let path = req
                .payload
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing path".into()))?;
            let content = req
                .payload
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let msg = fs::write_file(path, content, WORKSPACE).await?;
            Ok(serde_json::json!({"message": msg}))
        }
        "list_directory" => {
            let path = req
                .payload
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing path".into()))?;
            let entries = tokio::task::spawn_blocking({
                let p = path.to_string();
                move || fs::list_directory(&p, WORKSPACE)
            })
            .await
            .map_err(|e| RuntimeError::InvalidPath(e.to_string()))??;
            Ok(serde_json::json!({"entries": entries}))
        }
        "glob" => {
            let pattern = req
                .payload
                .get("pattern")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing pattern".into()))?;
            let path = req
                .payload
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing path".into()))?;
            let matches = tokio::task::spawn_blocking({
                let pat = pattern.to_string();
                let p = path.to_string();
                move || fs::glob_files(&pat, &p, WORKSPACE)
            })
            .await
            .map_err(|e| RuntimeError::InvalidPath(e.to_string()))??;
            Ok(serde_json::json!({"matches": matches}))
        }
        "grep" => {
            let pattern = req
                .payload
                .get("pattern")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing pattern".into()))?;
            let path = req
                .payload
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing path".into()))?;
            let matches = tokio::task::spawn_blocking({
                let pat = pattern.to_string();
                let p = path.to_string();
                move || fs::grep_files(&pat, &p, WORKSPACE)
            })
            .await
            .map_err(|e| RuntimeError::InvalidPath(e.to_string()))??;
            Ok(serde_json::json!({"matches": matches}))
        }
        "get_file_info" => {
            let path = req
                .payload
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing path".into()))?;
            let info = tokio::task::spawn_blocking({
                let p = path.to_string();
                move || fs::get_file_info(&p, WORKSPACE)
            })
            .await
            .map_err(|e| RuntimeError::InvalidPath(e.to_string()))??;
            Ok(serde_json::to_value(info).unwrap())
        }
        "watch_directory" => {
            let path = req
                .payload
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing path".into()))?;
            let events = tokio::task::spawn_blocking({
                let p = path.to_string();
                move || fs::watch_directory(&p, WORKSPACE)
            })
            .await
            .map_err(|e| RuntimeError::InvalidPath(e.to_string()))??;
            Ok(serde_json::json!({"events": events}))
        }
        "edit_file" => {
            let file_path = req
                .payload
                .get("file_path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing file_path".into()))?;
            let old_string = req
                .payload
                .get("old_string")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let new_string = req
                .payload
                .get("new_string")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let replace_all = req
                .payload
                .get("replace_all")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let res =
                fs::edit_file(file_path, old_string, new_string, replace_all, WORKSPACE).await?;
            Ok(serde_json::to_value(res).unwrap())
        }
        "delete_file" => {
            let path = req
                .payload
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing path".into()))?;
            let msg = fs::delete_file(path, WORKSPACE).await?;
            Ok(serde_json::json!({"message": msg}))
        }
        "delete_directory" => {
            let path = req
                .payload
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing path".into()))?;
            let recursive = req
                .payload
                .get("recursive")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let msg = fs::delete_directory(path, recursive, WORKSPACE).await?;
            Ok(serde_json::json!({"message": msg}))
        }
        "move_file" => {
            let from = req
                .payload
                .get("from")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing from".into()))?;
            let to = req
                .payload
                .get("to")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing to".into()))?;
            let msg = fs::move_file(from, to, WORKSPACE).await?;
            Ok(serde_json::json!({"message": msg}))
        }
        "copy_file" => {
            let from = req
                .payload
                .get("from")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing from".into()))?;
            let to = req
                .payload
                .get("to")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing to".into()))?;
            let msg = fs::copy_file(from, to, WORKSPACE).await?;
            Ok(serde_json::json!({"message": msg}))
        }
        "mkdir" => {
            let path = req
                .payload
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing path".into()))?;
            let msg = fs::mkdir(path, WORKSPACE).await?;
            Ok(serde_json::json!({"message": msg}))
        }
        "extract_pdf_text" => {
            let path = req
                .payload
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing path".into()))?;
            let text = fs::extract_pdf_text(path, WORKSPACE).await?;
            Ok(serde_json::json!({"content": text}))
        }
        "execute_command" => {
            // PLAN-0381 T2.1：workspaceId 随请求落到 bundle 归属（读侧校验用）。
            let workspace_id = req
                .payload
                .get("workspaceId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing workspaceId".into()))?
                .to_string();
            let command = req
                .payload
                .get("command")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing command".into()))?
                .to_string();
            let args: Vec<String> = req
                .payload
                .get("args")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            let timeout = req.payload.get("timeout").and_then(|v| v.as_u64());
            let truncate_limit = req.payload.get("truncate_limit").and_then(|v| v.as_u64());
            let res =
                exec_shell_command(&command, args, timeout, truncate_limit, &workspace_id).await?;
            Ok(serde_json::to_value(res).unwrap())
        }
        "start_background_process" => {
            let workspace_id = req
                .payload
                .get("workspaceId")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            let command = req
                .payload
                .get("command")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing command".into()))?
                .to_string();
            let args: Vec<String> = req
                .payload
                .get("args")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            // PLAN-0317 T3.3（决策 #3）：timeout 落实为任务运行时限（None→60 分钟默认，0→不限）。
            let timeout_secs =
                resolve_job_timeout(req.payload.get("timeoutSecs").and_then(|v| v.as_u64()));
            let job_id = start_background_job(&workspace_id, &command, args, timeout_secs).await?;
            Ok(serde_json::json!({"jobId": job_id}))
        }
        "list_background_processes" => {
            let jobs = list_jobs()?;
            Ok(serde_json::json!({"jobs": jobs}))
        }
        "get_background_process" => {
            let job_id = req
                .payload
                .get("jobId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing jobId".into()))?;
            let job = get_job(job_id)?;
            Ok(serde_json::to_value(job).unwrap())
        }
        "cancel_background_process" => {
            let job_id = req
                .payload
                .get("jobId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing jobId".into()))?;
            let res = cancel_job(job_id)?;
            Ok(serde_json::json!({"status": res}))
        }
        "read_command_output" => {
            // PLAN-0381 T2.2（m2-contract.md §2）：stream 选择 + workspace 归属
            // 校验 + 结构化分页直出（offset/nextOffset/sizeBytes/truncated/…）。
            let artifact_id = req
                .payload
                .get("artifact_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing artifact_id".into()))?;
            let workspace_id = req
                .payload
                .get("workspaceId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing workspaceId".into()))?;
            let stream = req
                .payload
                .get("stream")
                .and_then(|v| v.as_str())
                .unwrap_or("stdout");
            let offset = req
                .payload
                .get("offset")
                .and_then(|v| v.as_u64())
                .map(|v| v as usize);
            let limit = req
                .payload
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|v| v as usize);
            read_command_output_page(
                Path::new(JOB_DIR),
                artifact_id,
                stream,
                offset,
                limit,
                workspace_id,
            )
        }
        // PLAN-0344 T1.2：CP 续看端点的结构化分页读（字节游标 + UTF-8 边界）。
        "read_job_output" => {
            let job_id = req
                .payload
                .get("jobId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| RuntimeError::InvalidPath("missing jobId".into()))?;
            let stream = req
                .payload
                .get("stream")
                .and_then(|v| v.as_str())
                .unwrap_or("stdout");
            let offset = req
                .payload
                .get("offset")
                .and_then(|v| v.as_u64())
                .map(|v| v as usize);
            let limit = req
                .payload
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|v| v as usize);
            read_job_output_json_at(Path::new(JOB_DIR), job_id, stream, offset, limit)
        }
        "cleanup_jobs" => {
            let cleaned = cleanup_expired_jobs()?;
            // PLAN-0317 T3.3：同一通道顺带落实运行时限（宿主每 5 分钟驱动一次）。
            let timed_out = enforce_job_timeouts()?;
            Ok(serde_json::json!({"cleaned": cleaned, "timedOut": timed_out}))
        }
        // PLAN-0344 T1.3（决策 #3）：暂停/恢复时的 job 计时记账。
        "mark_jobs_paused" => {
            let marked =
                mark_jobs_paused_at(Path::new(JOB_DIR), chrono::Utc::now(), process_group_alive)?;
            Ok(serde_json::json!({"marked": marked}))
        }
        "resume_jobs_paused" => {
            let resumed = resume_jobs_paused_at(Path::new(JOB_DIR), chrono::Utc::now())?;
            Ok(serde_json::json!({"resumed": resumed}))
        }
        "apply_patch" => {
            let patches = req
                .payload
                .get("patches")
                .and_then(|v| v.as_array())
                .ok_or_else(|| RuntimeError::InvalidPath("missing patches array".into()))?;
            let result = apply_patch(patches)?;
            Ok(serde_json::to_value(result).unwrap())
        }
        _ => Err(RuntimeError::InvalidPath(format!(
            "unknown operation {}",
            req.operation
        ))),
    }
}

#[derive(Serialize)]
struct ExecResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    artifact_id: Option<String>,
    /// PLAN-0381 T2.1：该 stream 的 wire 预览是否被截断（缺省 false 不序列化，
    /// 旧读者按缺省读）。`stdout_truncated||stderr_truncated` ≡ 超过预览阈值
    /// ≡ retained bundle 同一触发条件（m2-contract.md §1）。
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    stdout_truncated: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    stderr_truncated: bool,
}

/// PLAN-0381 T2.1（m2-contract.md §1）：wire 预览 + retained bundle 落盘。
///
/// 两 stream 均未超预览阈值 → 原文直出、无 bundle；任一超限 → 两 stream 的
/// 完整捕获字节写入既有 TTL 载体（`JOB_DIR/<uuid>`，无 `command` 文件的
/// 判别物），超限 stream 按 `truncate_limit` 字节 UTF-8 安全截断进 wire，
/// 并回传 `*_truncated` 标志。bundle 写失败（预算满/IO）→ `artifact_id=None`
/// 但标志仍为 true——调用方必须能看到「被截断且无引用」的显式状态。
fn retain_sync_output(
    job_root: &Path,
    workspace_id: &str,
    stdout: &[u8],
    stderr: &[u8],
    limit: usize,
) -> (String, String, Option<String>, bool, bool) {
    let stdout_over = stdout.len() > limit;
    let stderr_over = stderr.len() > limit;
    let stdout_text = String::from_utf8_lossy(stdout).to_string();
    let stderr_text = String::from_utf8_lossy(stderr).to_string();
    let (stdout_final, _) = if stdout_over {
        truncate_utf8_safe(&stdout_text, limit)
    } else {
        (stdout_text, false)
    };
    let (stderr_final, _) = if stderr_over {
        truncate_utf8_safe(&stderr_text, limit)
    } else {
        (stderr_text, false)
    };
    let artifact_id = if stdout_over || stderr_over {
        write_sync_artifact(job_root, workspace_id, stdout, stderr)
    } else {
        None
    };
    (
        stdout_final,
        stderr_final,
        artifact_id,
        stdout_over,
        stderr_over,
    )
}

/// 既有 100 目录上限的具名化：后台 job 与同步 bundle **各自独立**计数到
/// 100（同一注册数值，两个计数器，m2-contract.md §4）。
const JOB_DIR_SLOTS: usize = 100;

/// PLAN-0381 T2.1：把同步命令的完整（有捕获上限）输出写进既有 job 载体。
///
/// 先跑一次 TTL 回收腾槽；无 `command` 文件的目录即 bundle（§1.3 判别物），
/// 与后台 job 预算互不挤占。任何写失败清理半成品并返回 None——不得把
/// 不完整 bundle 当作可读引用。
fn write_sync_artifact(
    job_root: &Path,
    workspace_id: &str,
    stdout: &[u8],
    stderr: &[u8],
) -> Option<String> {
    std::fs::create_dir_all(job_root).ok()?;
    // best-effort：先回收过期目录给 bundle 让出槽位（读不到/杀不掉都不阻塞写）。
    let _ = cleanup_expired_jobs_with(job_root, JOB_TTL_SECS, process_group_alive);
    let bundles = std::fs::read_dir(job_root)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| {
            let path = entry.path();
            path.is_dir() && !path.join("command").exists()
        })
        .count();
    if bundles >= JOB_DIR_SLOTS {
        return None;
    }
    let artifact_id = uuid::Uuid::new_v4().to_string();
    let dir = job_root.join(&artifact_id);
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    let now = chrono::Utc::now().to_rfc3339();
    let writes = [
        std::fs::write(dir.join("stdout"), stdout),
        std::fs::write(dir.join("stderr"), stderr),
        std::fs::write(dir.join("meta"), "succeeded"),
        std::fs::write(dir.join("workspace_id"), workspace_id),
        std::fs::write(dir.join("started_at"), &now),
        std::fs::write(dir.join("updated_at"), &now),
    ];
    if writes.into_iter().any(|result| result.is_err()) {
        let _ = std::fs::remove_dir_all(&dir);
        return None;
    }
    Some(artifact_id)
}

/// PLAN-0381 T2.2（m2-contract.md §2）：带 workspace 归属校验的分页读。
///
/// 目录存在 → `workspace_id` 文件必须等于调用方 workspace（缺失/不等 =
/// fail-closed 拒绝）；目录不存在 → 交给 `read_job_output_json_at` 返回
/// 结构化 `available:false/job_missing`（过期、容器重建的显式不可用语义）。
fn read_command_output_page(
    job_root: &Path,
    artifact_id: &str,
    stream: &str,
    offset: Option<usize>,
    limit: Option<usize>,
    workspace_id: &str,
) -> Result<serde_json::Value, RuntimeError> {
    if !is_safe_job_id(artifact_id) {
        return Err(RuntimeError::InvalidPath(format!(
            "invalid artifact id: {artifact_id}"
        )));
    }
    let dir = job_root.join(artifact_id);
    if dir.exists() {
        let owner = std::fs::read_to_string(dir.join("workspace_id"))
            .map(|raw| raw.trim().to_string())
            .unwrap_or_default();
        if owner.is_empty() || owner != workspace_id {
            return Err(RuntimeError::InvalidPath(format!(
                "artifact {artifact_id} is not readable from this workspace"
            )));
        }
    }
    read_job_output_json_at(job_root, artifact_id, stream, offset, limit)
}

async fn exec_shell_command(
    command: &str,
    args: Vec<String>,
    timeout: Option<u64>,
    truncate_limit: Option<u64>,
    workspace_id: &str,
) -> Result<ExecResult, RuntimeError> {
    let timeout_dur = Duration::from_secs(timeout.unwrap_or(30));
    let limit = truncate_limit.unwrap_or(4096) as usize;
    let mut cmd = Command::new("sh");
    cmd.arg("-c").arg(command);
    cmd.arg("xihe-shell");
    for a in &args {
        cmd.arg(a);
    }
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    // PLAN-0317 T2.2 修正：显式让命令成为新进程组的组长——否则它继承 oneshot
    // 会话的 PGID，`kill -- -pid` 打空（还会误杀容器内服务），子进程变孤儿。
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd
        .spawn()
        .map_err(|e| RuntimeError::Command(format!("spawn failed: {e}")))?;
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
                    Ok(n) => {
                        // PLAN-0381 T2.1：捕获预算 = 既有 JOB_CAP（1 MiB/stream，
                        // Frozen #2）——超过阈值的完整输出要落 retained bundle，
                        // 但载体本身按 JOB_CAP 封顶；超出部分继续排空、不入内存。
                        // 按剩余容量截读（review P2-5：整块 extend 会超封顶一个读块）。
                        if buf.len() < JOB_CAP {
                            let take = n.min(JOB_CAP - buf.len());
                            buf.extend_from_slice(&tmp[..take]);
                        }
                    }
                    Err(_) => break,
                }
            }
            buf
        } else {
            Vec::new()
        }
    });
    let stderr_handle = tokio::spawn(async move {
        if let Some(mut pipe) = stderr_pipe {
            let mut buf = Vec::new();
            let mut tmp = [0u8; 8192];
            use tokio::io::AsyncReadExt;
            loop {
                match pipe.read(&mut tmp).await {
                    Ok(0) => break,
                    Ok(n) => {
                        // PLAN-0381 T2.1：捕获预算 = 既有 JOB_CAP（1 MiB/stream，
                        // Frozen #2）——超过阈值的完整输出要落 retained bundle，
                        // 但载体本身按 JOB_CAP 封顶；超出部分继续排空、不入内存。
                        // 按剩余容量截读（review P2-5：整块 extend 会超封顶一个读块）。
                        if buf.len() < JOB_CAP {
                            let take = n.min(JOB_CAP - buf.len());
                            buf.extend_from_slice(&tmp[..take]);
                        }
                    }
                    Err(_) => break,
                }
            }
            buf
        } else {
            Vec::new()
        }
    });
    let wait_fut = child.wait();
    let status = match tokio::time::timeout(timeout_dur, wait_fut).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(RuntimeError::Command(format!("wait failed: {e}"))),
        Err(_) => {
            let pid = child.id();
            if let Some(pid) = pid {
                // Phase 1: SIGTERM (graceful)
                let _ = Command::new("sh")
                    .arg("-c")
                    .arg(format!("/bin/kill -TERM -- -{pid} 2>/dev/null"))
                    .status()
                    .await;
                // Phase 2: Wait 1s for graceful termination
                let graceful = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
                if graceful.is_err() {
                    // Phase 3: SIGKILL (force)
                    let _ = Command::new("sh")
                        .arg("-c")
                        .arg(format!(
                            "/bin/kill -9 -- -{pid} 2>/dev/null; kill -9 {pid} 2>/dev/null"
                        ))
                        .status()
                        .await;
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
    let stdout_bytes = stdout_handle
        .await
        .map_err(|e| RuntimeError::Command(e.to_string()))?;
    let stderr_bytes = stderr_handle
        .await
        .map_err(|e| RuntimeError::Command(e.to_string()))?;
    // PLAN-0381 T2.1/T2.2：wire 预览（stderr 对齐同一阈值）+ 超限时完整输出
    // 落 retained bundle 并回传 artifact_id（B3 修复点，m2-contract.md §1）。
    let (stdout_final, stderr_final, artifact_id, stdout_truncated, stderr_truncated) =
        retain_sync_output(
            Path::new(JOB_DIR),
            workspace_id,
            &stdout_bytes,
            &stderr_bytes,
            limit,
        );
    Ok(ExecResult {
        stdout: stdout_final,
        stderr: stderr_final,
        exit_code: status.code().unwrap_or(-1),
        success: status.success(),
        artifact_id,
        stdout_truncated,
        stderr_truncated,
    })
}

// ── Job management via /tmp/xihe-jobs ────────────────────────────────────
// PLAN-0344 T1.2：序列化契约对齐 `sandbox::BackgroundProcess`（camelCase）。
// 此前 field 名混用 snake/camel（`workspace_id` vs `workspaceId`），导致 MCP
// `get/list_background_process` 解析必然缺字段报错——以本测试钉死契约。
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JobInfo {
    job_id: String,
    workspace_id: String,
    command: String,
    status: String,
    pid: Option<String>,
    exit_code: Option<i32>,
    created_at: String,
    updated_at: Option<String>,
    stdout_preview: Option<String>,
    stderr_preview: Option<String>,
    /// PLAN-0344：CP 档案的 `timeoutSecs`（0/缺省 = 不限）。
    timeout_secs: Option<u64>,
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
        && job_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

async fn start_background_job(
    workspace_id: &str,
    command: &str,
    args: Vec<String>,
    timeout_secs: u64,
) -> Result<String, RuntimeError> {
    start_background_job_at(
        Path::new(JOB_DIR),
        workspace_id,
        command,
        args,
        timeout_secs,
    )
    .await
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
shift 2
printf '%s\n' "$$" > "$job_dir/pid"
sh -c "$command" xihe-shell "$@"
exit_code=$?
printf '%s\n' "$exit_code" > "$job_dir/exit"
printf '%s\n' succeeded > "$job_dir/meta"
"#;

fn background_wrapper_args(job_dir: &Path, command: &str, args: &[String]) -> Vec<OsString> {
    let mut wrapper_args = vec![
        OsString::from("sh"),
        OsString::from("-c"),
        OsString::from(BACKGROUND_JOB_WRAPPER),
        OsString::from("xihe-job-wrapper"),
        job_dir.as_os_str().to_owned(),
        OsString::from(command),
    ];
    wrapper_args.extend(args.iter().map(OsString::from));
    wrapper_args
}

fn build_background_command(
    job_dir: &Path,
    command: &str,
    args: &[String],
    stdout: std::fs::File,
    stderr: std::fs::File,
) -> Command {
    // 作业必须用 `setsid` 建立**独立会话**：否则它是 docker exec 会话的成员，
    // 随 oneshot 进程退出被一并杀掉（实测作业秒死）。会话首领的 PGID = `pid`
    // 文件里的 `$$`，`/bin/kill -- -<pid>` 可整组终止（见 T2.2/T3.3）。
    let mut cmd = Command::new("setsid");
    cmd.args(background_wrapper_args(job_dir, command, args))
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
    // PLAN-0381 T2.1：预算只数含 `command` 的目录——同步输出 bundle 走独立
    // 100 槽（JOB_DIR_SLOTS），不挤占后台 job 槽位（m2-contract.md §1.1）。
    let jobs = count_background_jobs(job_dir);
    if jobs >= JOB_DIR_SLOTS {
        return Err(RuntimeError::InvalidPath(format!(
            "job limit reached ({JOB_DIR_SLOTS})"
        )));
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
    let mut cmd = build_background_command(&job_path, command, &args, stdout, stderr);
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
    list_jobs_at(Path::new(JOB_DIR))
}

fn list_jobs_at(job_dir: &Path) -> Result<Vec<JobInfo>, RuntimeError> {
    let mut jobs = Vec::new();
    if !job_dir.exists() {
        return Ok(jobs);
    }
    // PLAN-0381 T2.1：无 `command` 文件的目录是同步输出 bundle，不是后台
    // 进程——不得经 `list_background_processes` 冒充 job（m2-contract.md §1.3）。
    let job_ids: Vec<String> = std::fs::read_dir(job_dir)
        .map_err(RuntimeError::Io)?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir() && entry.path().join("command").exists())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    for job_id in job_ids {
        if let Ok(job) = get_job_at(job_dir, &job_id) {
            jobs.push(job);
        }
    }
    Ok(jobs)
}

/// 后台 job 槽位计数：只数含 `command` 的目录（同步 bundle 走独立预算）。
fn count_background_jobs(job_dir: &Path) -> usize {
    std::fs::read_dir(job_dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| entry.path().is_dir() && entry.path().join("command").exists())
                .count()
        })
        .unwrap_or_default()
}

fn get_job(job_id: &str) -> Result<JobInfo, RuntimeError> {
    get_job_at(Path::new(JOB_DIR), job_id)
}

fn get_job_at(job_dir: &Path, job_id: &str) -> Result<JobInfo, RuntimeError> {
    if !is_safe_job_id(job_id) {
        return Err(RuntimeError::InvalidPath(format!(
            "invalid job id: {job_id}"
        )));
    }
    let job_path = job_dir.join(job_id);
    if !job_path.exists() {
        return Err(RuntimeError::InvalidPath(format!(
            "job not found: {job_id}"
        )));
    }
    // PLAN-0381 T2.1（review P2-1）：无 `command` 文件的目录是同步输出
    // bundle——按后台 job 直读会返回「空命令伪 job」，显式拒绝（§1.3 判别物）。
    if !job_path.join("command").exists() {
        return Err(RuntimeError::InvalidPath(format!(
            "not a background job: {job_id}"
        )));
    }
    let meta = std::fs::read_to_string(job_path.join("meta"))
        .unwrap_or_else(|_| "unknown".to_string())
        .trim()
        .to_string();
    let command = std::fs::read_to_string(job_path.join("command"))
        .unwrap_or_default()
        .trim()
        .to_string();
    let workspace_id = std::fs::read_to_string(job_path.join("workspace_id"))
        .unwrap_or_default()
        .trim()
        .to_string();
    let pid = std::fs::read_to_string(job_path.join("pid"))
        .ok()
        .map(|s| s.trim().to_string());
    let started_at = std::fs::read_to_string(job_path.join("started_at"))
        .unwrap_or_default()
        .trim()
        .to_string();
    let updated_at = std::fs::read_to_string(job_path.join("updated_at"))
        .ok()
        .map(|s| s.trim().to_string());
    let exit_code = std::fs::read_to_string(job_path.join("exit"))
        .ok()
        .and_then(|s| s.trim().parse::<i32>().ok());
    let timeout_secs = std::fs::read_to_string(job_path.join("timeout_secs"))
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok());
    let stdout_preview = std::fs::read(job_path.join("stdout")).ok().map(|bytes| {
        let preview =
            String::from_utf8_lossy(&bytes[..bytes.len().min(JOB_PREVIEW_BYTES)]).to_string();
        if bytes.len() > JOB_PREVIEW_BYTES {
            preview + "..."
        } else {
            preview
        }
    });
    let stderr_preview = std::fs::read(job_path.join("stderr")).ok().map(|bytes| {
        let preview =
            String::from_utf8_lossy(&bytes[..bytes.len().min(JOB_PREVIEW_BYTES)]).to_string();
        if bytes.len() > JOB_PREVIEW_BYTES {
            preview + "..."
        } else {
            preview
        }
    });
    let status = if meta == "running" {
        if let Some(pid_str) = &pid {
            if let Ok(pid_num) = pid_str.parse::<i32>() {
                let still_running = std::process::Command::new("sh")
                    .arg("-c")
                    .arg(format!(
                        "/bin/kill -0 -- -{pid_num} 2>/dev/null || kill -0 {pid_num} 2>/dev/null"
                    ))
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);
                if !still_running {
                    if exit_code.is_some() {
                        "succeeded".to_string()
                    } else {
                        "failed".to_string()
                    }
                } else {
                    "running".to_string()
                }
            } else {
                meta
            }
        } else {
            meta
        }
    } else {
        meta
    };
    Ok(JobInfo {
        job_id: job_id.to_string(),
        workspace_id,
        command,
        status,
        pid,
        exit_code,
        created_at: started_at,
        updated_at,
        stdout_preview,
        stderr_preview,
        timeout_secs,
    })
}

fn cancel_job(job_id: &str) -> Result<String, RuntimeError> {
    if !is_safe_job_id(job_id) {
        return Err(RuntimeError::InvalidPath(format!(
            "invalid job id: {job_id}"
        )));
    }
    let job_path = PathBuf::from(JOB_DIR).join(job_id);
    if !job_path.exists() {
        return Err(RuntimeError::InvalidPath(format!(
            "job not found: {job_id}"
        )));
    }
    let pid_str = std::fs::read_to_string(job_path.join("pid"))
        .map_err(|_| RuntimeError::InvalidPath("pid not found".into()))?;
    let pid_str = pid_str.trim();
    let pid_num: i32 = pid_str
        .parse()
        .map_err(|_| RuntimeError::InvalidPath("invalid pid".into()))?;

    // Phase 1: SIGTERM to process group (graceful shutdown)
    let _ = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!("/bin/kill -TERM -- -{pid_num} 2>/dev/null"))
        .status();

    // Phase 2: Wait up to 3 seconds for graceful termination
    let mut terminated = false;
    for _ in 0..6 {
        std::thread::sleep(Duration::from_millis(500));
        if !process_group_alive(pid_num) {
            terminated = true;
            break;
        }
    }

    // Phase 3: SIGKILL if still running (force kill)
    if !terminated {
        let _ = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!(
                "/bin/kill -9 -- -{pid_num} 2>/dev/null; kill -9 {pid_num} 2>/dev/null"
            ))
            .status();
        std::thread::sleep(Duration::from_millis(200));
    }

    // Phase 4: Verify process is gone (zombies do not count as alive)
    let still_alive = process_group_alive(pid_num);

    let status = if still_alive { "failed" } else { "cancelled" };
    std::fs::write(job_path.join("meta"), status).map_err(RuntimeError::Io)?;
    std::fs::write(job_path.join("updated_at"), chrono::Utc::now().to_rfc3339())
        .map_err(RuntimeError::Io)?;
    Ok(status.to_string())
}

/// PLAN-0344 T1.2：字节游标的 UTF-8 边界判定。
/// 续看协议约定 `nextOffset` 恒为 rune 边界，客户端回传该值即可无损分页；
/// 任意畸形 offset 会向前对齐到最近边界并在响应中显式返回实际 `offset`。
fn is_utf8_boundary(bytes: &[u8], index: usize) -> bool {
    index >= bytes.len() || (bytes[index] & 0b1100_0000) != 0b1000_0000
}

/// 把 `[offset, offset+limit)` 收缩到完整 rune 范围：起点向前对齐，终点回退。
fn utf8_safe_chunk(bytes: &[u8], offset: Option<usize>, limit: Option<usize>) -> (usize, usize) {
    let mut start = offset.unwrap_or(0).min(bytes.len());
    while start < bytes.len() && !is_utf8_boundary(bytes, start) {
        start += 1;
    }
    let end_limit = limit.map_or(bytes.len(), |limit| start.saturating_add(limit));
    let mut end = end_limit.min(bytes.len());
    while end > start && !is_utf8_boundary(bytes, end) {
        end -= 1;
    }
    (start, end)
}

/// PLAN-0344 T1.2：结构化 job 输出分页（CP 续看端点的 Runtime 单一修点）。
///
/// * `stream` = `stdout`（缺省）或 `stderr`；
/// * `limit` 按字节，缺省读到文件末尾；
/// * job 目录/输出文件缺失时返回 `available=false`（由 CP 决定 LOST/EXPIRED，
///   Runtime 不替调用方下结论）；
/// * `truncated` = 文件已达 `JOB_CAP`（周期清理用 `head -c` 封顶）。
fn read_job_output_json_at(
    job_root: &Path,
    job_id: &str,
    stream: &str,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<serde_json::Value, RuntimeError> {
    if !is_safe_job_id(job_id) {
        return Err(RuntimeError::InvalidPath(format!(
            "invalid job id: {job_id}"
        )));
    }
    let stream = match stream {
        "" | "stdout" => "stdout",
        "stderr" => "stderr",
        other => {
            return Err(RuntimeError::InvalidPath(format!(
                "invalid stream: {other} (expected stdout|stderr)"
            )));
        }
    };
    let job_path = job_root.join(job_id);
    if !job_path.exists() {
        return Ok(serde_json::json!({
            "available": false,
            "jobId": job_id,
            "stream": stream,
            "reason": "job_missing",
        }));
    }
    let bytes = match std::fs::read(job_path.join(stream)) {
        Ok(bytes) => bytes,
        Err(_) => {
            return Ok(serde_json::json!({
                "available": false,
                "jobId": job_id,
                "stream": stream,
                "reason": "output_missing",
            }));
        }
    };
    let (start, end) = utf8_safe_chunk(&bytes, offset, limit);
    let job_status = std::fs::read_to_string(job_path.join("meta"))
        .map(|value| value.trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string());
    Ok(serde_json::json!({
        "available": true,
        "jobId": job_id,
        "stream": stream,
        "data": String::from_utf8_lossy(&bytes[start..end]),
        "offset": start,
        "nextOffset": end,
        "sizeBytes": bytes.len(),
        "truncated": bytes.len() >= JOB_CAP,
        "jobStatus": job_status,
    }))
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
                let _ = std::process::Command::new("sh")
                    .arg("-c")
                    .arg(format!(
                        "head -c {} {} > {}.tmp && mv {}.tmp {}",
                        JOB_CAP,
                        fpath.display(),
                        fpath.display(),
                        fpath.display(),
                        fpath.display()
                    ))
                    .status();
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
    // PLAN-0366 T1.3 实证：容器 PID1 不回收子进程，退出后的 `<defunct>` 会让
    // `kill -0` 继续成功 → 真实取消恒报 `failed`（终止未确认）。按 PGID 匹配
    // 非 Z 状态进程才算存活。
    std::process::Command::new("sh")
        .arg("-c")
        .arg(format!(
            "ps -eo pgid=,stat= 2>/dev/null | awk -v pgid={pid} '$1==pgid && $2 !~ /^Z/ {{found=1}} END {{exit found?0:1}}'"
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

/// PLAN-0317 T3.3（决策 #3）：对超过运行时限的 job 执行终止并落 `timeout` 终态。
/// 由宿主的清理通道（`cleanup_jobs` op）周期驱动——不在容器内留常驻看门狗进程。
fn enforce_job_timeouts() -> Result<Vec<String>, RuntimeError> {
    enforce_job_timeouts_with(
        Path::new(JOB_DIR),
        chrono::Utc::now(),
        |pid| {
            std::process::Command::new("sh")
                .arg("-c")
                .arg(format!(
                    "/bin/kill -0 -- -{pid} 2>/dev/null || kill -0 {pid} 2>/dev/null"
                ))
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        },
        |pid| {
            let _ = std::process::Command::new("sh")
                .arg("-c")
                .arg(format!("/bin/kill -TERM -- -{pid} 2>/dev/null"))
                .status();
            std::thread::sleep(Duration::from_secs(1));
            let _ = std::process::Command::new("sh")
                .arg("-c")
                .arg(format!(
                    "/bin/kill -9 -- -{pid} 2>/dev/null; kill -9 {pid} 2>/dev/null"
                ))
                .status();
        },
    )
}

fn enforce_job_timeouts_with(
    job_dir: &Path,
    now: chrono::DateTime<chrono::Utc>,
    alive: impl Fn(i32) -> bool,
    kill: impl Fn(i32),
) -> Result<Vec<String>, RuntimeError> {
    let mut enforced = Vec::new();
    if !job_dir.exists() {
        return Ok(enforced);
    }
    for entry in std::fs::read_dir(job_dir).map_err(RuntimeError::Io)? {
        let entry = entry.map_err(RuntimeError::Io)?;
        let job_path = entry.path();
        if !job_path.is_dir() || !job_is_running_with(&job_path, &alive) {
            continue;
        }
        let limit = std::fs::read_to_string(job_path.join("timeout_secs"))
            .ok()
            .and_then(|raw| raw.trim().parse::<u64>().ok())
            .unwrap_or(0);
        if limit == 0 {
            continue;
        }
        let started = std::fs::read_to_string(job_path.join("started_at"))
            .ok()
            .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw.trim()).ok())
            .map(|parsed| parsed.with_timezone(&chrono::Utc));
        let Some(started) = started else { continue };
        let elapsed = (now - started).num_seconds().max(0) as u64;
        // PLAN-0344 T1.3（决策 #3）：运行时限按**累计运行时间**判定——
        // 容器暂停（docker pause / 空闲回收）期间冻结的时长从 elapsed 扣除。
        let paused_total = std::fs::read_to_string(job_path.join("paused_total_secs"))
            .ok()
            .and_then(|raw| raw.trim().parse::<u64>().ok())
            .unwrap_or(0);
        let effective_elapsed = elapsed.saturating_sub(paused_total);
        // 到达时限即终止（`num_seconds` 截断到秒：elapsed==limit 时已到点）。
        if effective_elapsed < limit {
            continue;
        }
        let pid = std::fs::read_to_string(job_path.join("pid"))
            .ok()
            .and_then(|raw| raw.trim().parse::<i32>().ok());
        if let Some(pid) = pid {
            kill(pid);
        }
        let _ = std::fs::write(job_path.join("meta"), "timeout");
        let _ = std::fs::write(job_path.join("exit"), "143");
        let _ = std::fs::write(job_path.join("updated_at"), chrono::Utc::now().to_rfc3339());
        enforced.push(entry.file_name().to_string_lossy().to_string());
    }
    Ok(enforced)
}

/// PLAN-0344 T1.3（决策 #3）：容器暂停前给运行中 job 打 `paused_at` 标记。
/// 由宿主在 `pause_container` 之前调用（容器尚可 exec）。
fn mark_jobs_paused_at(
    job_dir: &Path,
    now: chrono::DateTime<chrono::Utc>,
    alive: impl Fn(i32) -> bool,
) -> Result<usize, RuntimeError> {
    let mut marked = 0;
    if !job_dir.exists() {
        return Ok(0);
    }
    for entry in std::fs::read_dir(job_dir).map_err(RuntimeError::Io)? {
        let entry = entry.map_err(RuntimeError::Io)?;
        let job_path = entry.path();
        if !job_path.is_dir() || !job_is_running_with(&job_path, &alive) {
            continue;
        }
        if job_path.join("paused_at").exists() {
            continue;
        }
        let _ = std::fs::write(job_path.join("paused_at"), now.to_rfc3339());
        marked += 1;
    }
    Ok(marked)
}

/// 容器恢复后把暂停时长累加进 `paused_total_secs` 并清除标记；
/// 暂停期不要求进程可探活（冻结中的探活必然失败）。
fn resume_jobs_paused_at(
    job_dir: &Path,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<usize, RuntimeError> {
    let mut resumed = 0;
    if !job_dir.exists() {
        return Ok(0);
    }
    for entry in std::fs::read_dir(job_dir).map_err(RuntimeError::Io)? {
        let entry = entry.map_err(RuntimeError::Io)?;
        let job_path = entry.path();
        if !job_path.is_dir() {
            continue;
        }
        let paused_at_path = job_path.join("paused_at");
        let Ok(raw) = std::fs::read_to_string(&paused_at_path) else {
            continue;
        };
        let delta = chrono::DateTime::parse_from_rfc3339(raw.trim())
            .map(|parsed| {
                (now - parsed.with_timezone(&chrono::Utc))
                    .num_seconds()
                    .max(0) as u64
            })
            .unwrap_or(0);
        let total = std::fs::read_to_string(job_path.join("paused_total_secs"))
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
            .unwrap_or(0)
            .saturating_add(delta);
        let _ = std::fs::write(job_path.join("paused_total_secs"), total.to_string());
        let _ = std::fs::remove_file(&paused_at_path);
        resumed += 1;
    }
    Ok(resumed)
}

// ── Patch (PLAN-275 M2) ────────────────────────────────────────────────

const PATCH_DIFF_MAX_BYTES: usize = 256 * 1024;

fn is_safe_relative_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.starts_with('\\')
        && !path.contains("..")
        && !path.contains('\0')
}

fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
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

fn apply_patch(patches: &[serde_json::Value]) -> Result<PatchResult, RuntimeError> {
    apply_patch_at(Path::new(WORKSPACE), patches)
}

fn apply_patch_at(
    workspace: &Path,
    patches: &[serde_json::Value],
) -> Result<PatchResult, RuntimeError> {
    if patches.is_empty() {
        return Err(RuntimeError::InvalidPath("empty patches array".into()));
    }

    let mut prepared = Vec::with_capacity(patches.len());
    let mut seen_paths = std::collections::HashSet::new();

    // Phase 1: validate and compute all new contents before applying any patch.
    for patch in patches {
        let rel_path = patch
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| RuntimeError::InvalidPath("missing path in patch".to_string()))?;
        let expected_hash = patch
            .get("expectedHash")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                RuntimeError::InvalidPath("missing expectedHash in patch".to_string())
            })?;

        if !is_safe_relative_path(rel_path) {
            return Err(RuntimeError::PathTraversal {
                path: rel_path.to_string(),
            });
        }
        if !seen_paths.insert(rel_path.to_string()) {
            return Err(RuntimeError::InvalidPath(format!(
                "duplicate patch path: {rel_path}"
            )));
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

        let hunks = patch
            .get("hunks")
            .and_then(|v| v.as_array())
            .ok_or_else(|| RuntimeError::InvalidPath("missing hunks in patch".to_string()))?;
        if hunks.is_empty() {
            return Err(RuntimeError::InvalidPath(format!(
                "empty hunks for {rel_path}"
            )));
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

    let diff = diff_lines.join("\n");
    info!("patch_applied files={}", changed.len());
    Ok(PatchResult {
        changed,
        diff,
        new_hashes,
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::time::Instant;
    use tempfile::TempDir;
    #[test]
    fn background_wrapper_keeps_user_values_out_of_shell_script() {
        let command = r#"printf '%s' "$1""#;
        let argument = "value; touch injected-file".to_string();
        let wrapper_args = background_wrapper_args(
            Path::new("/tmp/job with spaces"),
            command,
            std::slice::from_ref(&argument),
        );

        assert_eq!(wrapper_args[2], OsString::from(BACKGROUND_JOB_WRAPPER));
        assert_eq!(wrapper_args[5], OsString::from(command));
        assert_eq!(wrapper_args[6], OsString::from(argument));
        assert!(!wrapper_args[2].to_string_lossy().contains("injected-file"));
    }

    #[test]
    fn apply_patch_rolls_back_previous_files_when_later_write_fails() {
        let tmp = TempDir::new().expect("temporary workspace");
        let workspace = tmp.path().join("workspace");
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

        assert!(apply_patch_at(&workspace, &patches).is_err());
        assert_eq!(
            std::fs::read_to_string(workspace.join("first.txt")).unwrap(),
            "before"
        );
        assert!(!workspace.join("blocked/second.txt").exists());
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
        let result = apply_patch_at(&workspace, &patches).expect("large patch should apply");

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
        let job_id =
            start_background_job_at(tmp.path(), r#"printf '%s' "$1""#, vec![argument.clone()], 0)
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

    // ── PLAN-0366 T1.3：僵尸不得被判定为存活（真实取消恒 failed 的根因） ──

    #[cfg(unix)]
    #[test]
    fn process_group_alive_ignores_zombies() {
        use std::os::unix::process::CommandExt;

        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .expect("spawn sleep in its own process group");
        let pid = child.id() as i32;
        assert!(
            process_group_alive(pid),
            "live process group must read alive"
        );

        let _ = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("/bin/kill -9 -- -{pid} 2>/dev/null"))
            .status();
        std::thread::sleep(Duration::from_millis(200));
        // 未 wait() 的子进程此刻是僵尸：`kill -0` 会成功，但必须判为已终止。
        assert!(
            !process_group_alive(pid),
            "zombie process group must not read alive"
        );
        let _ = child.wait();
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
        assert!(
            !text.contains('\u{fffd}'),
            "must not split a char: {text:?}"
        );
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

    // ── T1.2（PLAN-0344）：续看游标与 UTF-8 边界 ──────────────────────────

    #[test]
    fn utf8_safe_chunk_rolls_back_to_rune_boundary() {
        let bytes = "你好abc".as_bytes(); // 3 + 3 + 1 + 1 + 1 = 9 bytes
        assert_eq!(utf8_safe_chunk(bytes, None, Some(4)), (0, 3));
        assert_eq!(utf8_safe_chunk(bytes, Some(3), Some(4)), (3, 7));
        // 畸形 offset（落在 rune 中部）向前对齐到最近边界
        assert_eq!(utf8_safe_chunk(bytes, Some(4), Some(2)), (6, 8));
        // 越过 EOF
        assert_eq!(utf8_safe_chunk(bytes, Some(99), None), (9, 9));
    }

    #[test]
    fn utf8_safe_chunk_handles_empty_input() {
        assert_eq!(utf8_safe_chunk(b"", None, None), (0, 0));
    }

    #[test]
    fn read_job_output_json_at_pages_without_splitting_runes() {
        let tmp = TempDir::new().unwrap();
        let job = write_fake_job(tmp.path(), "job-out", "running", Some("1234"), 0);
        std::fs::write(job.join("stdout"), "你好世界").unwrap();
        std::fs::write(job.join("stderr"), "错误").unwrap();

        let first =
            read_job_output_json_at(tmp.path(), "job-out", "stdout", None, Some(4)).unwrap();
        assert_eq!(first["available"], true);
        assert_eq!(first["data"], "你");
        assert_eq!(first["offset"], 0);
        assert_eq!(first["nextOffset"], 3);
        assert_eq!(first["sizeBytes"], 12);
        assert_eq!(first["jobStatus"], "running");

        let second = read_job_output_json_at(
            tmp.path(),
            "job-out",
            "stdout",
            first["nextOffset"].as_u64().map(|value| value as usize),
            Some(4),
        )
        .unwrap();
        assert_eq!(second["data"], "好");
        assert_eq!(second["nextOffset"], 6);

        let stderr = read_job_output_json_at(tmp.path(), "job-out", "stderr", None, None).unwrap();
        assert_eq!(stderr["data"], "错误");
    }

    #[test]
    fn job_info_serializes_to_background_process_contract() {
        let info = JobInfo {
            job_id: "job-1".to_string(),
            workspace_id: "ws-1".to_string(),
            command: "sleep 1".to_string(),
            status: "running".to_string(),
            pid: Some("42".to_string()),
            exit_code: None,
            created_at: "2026-09-18T00:00:00Z".to_string(),
            updated_at: None,
            stdout_preview: Some("out".to_string()),
            stderr_preview: Some("err".to_string()),
            timeout_secs: Some(600),
        };
        let value = serde_json::to_value(&info).unwrap();
        assert_eq!(value["workspaceId"], "ws-1");
        assert_eq!(value["timeoutSecs"], 600);
        let parsed: xihe_runtime::sandbox::BackgroundProcess =
            serde_json::from_value(value).expect("MCP BackgroundProcess contract must parse");
        assert_eq!(parsed.job_id, "job-1");
        assert_eq!(parsed.workspace_id, "ws-1");
        assert_eq!(parsed.stdout_preview.as_deref(), Some("out"));
    }

    #[test]
    fn read_job_output_json_at_reports_missing_job_without_error() {
        let tmp = TempDir::new().unwrap();
        let missing =
            read_job_output_json_at(tmp.path(), "job-missing", "stdout", None, None).unwrap();
        assert_eq!(missing["available"], false);
        assert_eq!(missing["reason"], "job_missing");
    }

    // ── PLAN-0381 M2（T2.1/T2.2/T2.4）：同步输出 retained bundle 与分页读 ────

    #[test]
    fn retain_sync_output_keeps_small_output_untouched() {
        let tmp = TempDir::new().unwrap();
        let (stdout, stderr, artifact, stdout_cut, stderr_cut) =
            retain_sync_output(tmp.path(), "ws-1", b"ok\n", b"", 4096);
        assert_eq!(stdout, "ok\n");
        assert_eq!(stderr, "");
        assert!(artifact.is_none(), "in-threshold output needs no bundle");
        assert!(!stdout_cut && !stderr_cut);
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
    }

    #[test]
    fn retain_sync_output_writes_full_bundle_and_cuts_wire_on_overflow() {
        let tmp = TempDir::new().unwrap();
        let big = vec![b'x'; 4096 + 2048];
        let (stdout, stderr, artifact, stdout_cut, stderr_cut) =
            retain_sync_output(tmp.path(), "ws-1", &big, b"tail-err", 4096);
        let artifact = artifact.expect("over-limit output must produce a ref (B3 regression)");
        assert!(stdout_cut && !stderr_cut);
        assert!(stdout.starts_with(&"x".repeat(4096)));
        assert!(stdout.ends_with("[truncated to 4096 bytes]"));
        assert_eq!(stderr, "tail-err");

        let dir = tmp.path().join(&artifact);
        assert_eq!(
            std::fs::read(dir.join("stdout")).unwrap(),
            big,
            "bundle must retain the full captured bytes, not the wire preview"
        );
        assert_eq!(std::fs::read(dir.join("stderr")).unwrap(), b"tail-err");
        assert_eq!(
            std::fs::read_to_string(dir.join("meta")).unwrap(),
            "succeeded"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("workspace_id")).unwrap(),
            "ws-1"
        );
        assert!(
            !dir.join("command").exists(),
            "bundle 判别物缺失 command——不得被 list_background_processes 当成 job"
        );
    }

    #[test]
    fn retain_sync_output_aligns_stderr_to_the_same_threshold() {
        // T2.2：stderr 现状不截断，M2 与 stdout 对齐同一阈值并显式标记。
        let tmp = TempDir::new().unwrap();
        let big_err = vec![b'e'; 4096 + 10];
        let (stdout, stderr, artifact, stdout_cut, stderr_cut) =
            retain_sync_output(tmp.path(), "ws-1", b"fine", &big_err, 4096);
        assert!(
            !stdout_cut && stderr_cut,
            "stderr truncation must be explicit"
        );
        assert!(stderr.starts_with(&"e".repeat(4096)));
        assert!(stderr.ends_with("[truncated to 4096 bytes]"));
        assert_eq!(stdout, "fine");
        assert!(artifact.is_some());
    }

    #[test]
    fn retain_wire_preview_never_splits_multibyte_chars() {
        let tmp = TempDir::new().unwrap();
        let text = "汉".repeat(3000); // 9000 bytes > 4096
        let (stdout, _, _, stdout_cut, _) =
            retain_sync_output(tmp.path(), "ws-1", text.as_bytes(), b"", 4096);
        assert!(stdout_cut);
        assert!(
            !stdout.contains('\u{fffd}'),
            "wire preview must stay on a UTF-8 boundary: {stdout:?}"
        );
        // limit=4096 落在第二个「汉」(3B) 中间 → 回退到 4095 字节边界。
        assert!(stdout.ends_with("[truncated to 4095 bytes]"));
    }

    #[test]
    fn write_sync_artifact_fails_when_bundle_slots_are_exhausted() {
        let tmp = TempDir::new().unwrap();
        for i in 0..JOB_DIR_SLOTS {
            std::fs::create_dir_all(tmp.path().join(format!("bundle-{i}"))).unwrap();
        }
        let (stdout, _, artifact, stdout_cut, _) =
            retain_sync_output(tmp.path(), "ws-1", &vec![b'x'; 5000], b"", 4096);
        assert!(stdout_cut, "truncation stays explicit even without a ref");
        assert!(
            artifact.is_none(),
            "exhausted bundle slots must fail open (flags, no ref), never a half bundle"
        );
        assert!(stdout.ends_with("[truncated to 4096 bytes]"));
    }

    #[test]
    fn retain_sync_output_reports_failure_when_bundle_root_unusable() {
        let tmp = TempDir::new().unwrap();
        let root_file = tmp.path().join("root-is-a-file");
        std::fs::write(&root_file, b"not a dir").unwrap();
        let (stdout, _, artifact, stdout_cut, _) =
            retain_sync_output(&root_file, "ws-1", &vec![b'x'; 5000], b"", 4096);
        assert!(
            stdout_cut && artifact.is_none(),
            "IO failure → 显式无引用截断"
        );
        assert!(stdout.ends_with("[truncated to 4096 bytes]"));
    }

    #[test]
    fn list_jobs_and_budget_ignore_sync_bundle_dirs() {
        let tmp = TempDir::new().unwrap();
        let bundle =
            write_sync_artifact(tmp.path(), "ws-1", b"out", b"err").expect("bundle should write");
        let job = tmp.path().join("job-1");
        std::fs::create_dir_all(&job).unwrap();
        std::fs::write(job.join("command"), "sleep 1").unwrap();
        std::fs::write(job.join("meta"), "succeeded").unwrap();

        let jobs = list_jobs_at(tmp.path()).unwrap();
        assert_eq!(jobs.len(), 1, "bundle must not appear as a background job");
        assert_eq!(jobs[0].job_id, "job-1");
        assert_eq!(
            count_background_jobs(tmp.path()),
            1,
            "bundles must not consume background job slots"
        );
        assert!(
            is_safe_job_id(&bundle),
            "bundle id must be an opaque safe ref"
        );
    }

    #[test]
    fn read_command_output_page_scopes_to_own_workspace() {
        let tmp = TempDir::new().unwrap();
        let id = write_sync_artifact(tmp.path(), "ws-1", b"hello", b"err-out").unwrap();

        let page = read_command_output_page(tmp.path(), &id, "stderr", None, None, "ws-1").unwrap();
        assert_eq!(page["available"], true);
        assert_eq!(page["stream"], "stderr");
        assert_eq!(page["data"], "err-out");
        assert_eq!(page["sizeBytes"], 7);

        let err = read_command_output_page(tmp.path(), &id, "stdout", None, None, "ws-2")
            .expect_err("cross-workspace read must be rejected");
        assert!(
            err.to_string().contains("not readable from this workspace"),
            "{err}"
        );
    }

    #[test]
    fn read_command_output_page_rejects_workspace_id_missing_bundle() {
        // legacy/手工目录缺 workspace_id → fail-closed（m2-contract.md §2）。
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("orphan-1");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("stdout"), b"data").unwrap();
        let err = read_command_output_page(tmp.path(), "orphan-1", "stdout", None, None, "ws-1")
            .expect_err("missing owner must fail closed");
        assert!(
            err.to_string().contains("not readable from this workspace"),
            "{err}"
        );
    }

    #[test]
    fn read_command_output_page_reports_missing_bundle_as_explicit_unavailable() {
        let tmp = TempDir::new().unwrap();
        let page =
            read_command_output_page(tmp.path(), "gone-1", "stdout", None, None, "ws-1").unwrap();
        assert_eq!(page["available"], false);
        assert_eq!(page["reason"], "job_missing");
    }

    #[test]
    fn read_command_output_page_rejects_unknown_stream_and_bad_id() {
        let tmp = TempDir::new().unwrap();
        let id = write_sync_artifact(tmp.path(), "ws-1", b"out", b"err").unwrap();
        let err = read_command_output_page(tmp.path(), &id, "stdin", None, None, "ws-1")
            .expect_err("unknown stream must be rejected");
        assert!(err.to_string().contains("invalid stream"), "{err}");
        let err = read_command_output_page(tmp.path(), "../escape", "stdout", None, None, "ws-1")
            .expect_err("path traversal id must be rejected");
        assert!(err.to_string().contains("invalid artifact id"), "{err}");
    }

    #[test]
    fn read_command_output_page_paginates_with_byte_offset() {
        let tmp = TempDir::new().unwrap();
        let id = write_sync_artifact(tmp.path(), "ws-1", b"hello", b"").unwrap();
        let page =
            read_command_output_page(tmp.path(), &id, "stdout", Some(1), Some(3), "ws-1").unwrap();
        assert_eq!(page["data"], "ell");
        assert_eq!(page["offset"], 1);
        assert_eq!(page["nextOffset"], 4);
        assert_eq!(page["sizeBytes"], 5);
        assert_eq!(page["truncated"], false);
    }

    #[test]
    fn read_command_output_page_flags_capped_bundle_as_truncated() {
        let tmp = TempDir::new().unwrap();
        let id = write_sync_artifact(tmp.path(), "ws-1", &vec![b'z'; JOB_CAP], b"").unwrap();
        let page = read_command_output_page(tmp.path(), &id, "stdout", None, None, "ws-1").unwrap();
        assert_eq!(page["sizeBytes"], JOB_CAP as u64);
        assert_eq!(
            page["truncated"], true,
            "JOB_CAP-capped retained output must report truncated"
        );
    }

    #[test]
    fn sync_bundle_is_reclaimed_by_ttl_cleanup() {
        // 判别物保证：meta=succeeded（非 running）→ 不进运行保护，按 TTL 回收。
        let tmp = TempDir::new().unwrap();
        let id = write_sync_artifact(tmp.path(), "ws-1", b"out", b"err").unwrap();
        let dir = tmp.path().join(&id);
        let fresh_cleaned = cleanup_expired_jobs_with(tmp.path(), 900, |_pid| {
            panic!("bundle must never probe process liveness")
        })
        .unwrap();
        assert_eq!(
            fresh_cleaned, 0,
            "fresh bundle must survive a 900s TTL sweep"
        );
        assert!(dir.exists(), "fresh bundle must survive a 900s TTL sweep");

        // 伪造成过期（写伪 mtime）：复用 write_fake_job 的老化语义。
        // 注意：老化后不得再写该目录内任何文件——TTL 按目录内最新文件 mtime 计。
        let aged = write_fake_job(tmp.path(), "bundle-aged", "succeeded", None, 86400);
        let cleaned = cleanup_expired_jobs_with(tmp.path(), 900, |_pid| false).unwrap();
        assert_eq!(
            cleaned, 1,
            "aged bundle must be reclaimed with its job dirs"
        );
        assert!(!aged.exists());
        assert!(
            tmp.path().join(&id).exists(),
            "fresh bundle must not be swept with the aged one"
        );
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
    fn enforce_job_timeouts_kills_only_overdue_running_jobs() {
        let tmp = TempDir::new().unwrap();
        let now = chrono::Utc::now();

        let overdue = write_fake_job(tmp.path(), "job-overdue", "running", Some("4321"), 0);
        std::fs::write(overdue.join("timeout_secs"), "2").unwrap();
        std::fs::write(
            overdue.join("started_at"),
            (now - chrono::Duration::seconds(30)).to_rfc3339(),
        )
        .unwrap();

        let fresh = write_fake_job(tmp.path(), "job-fresh", "running", Some("4321"), 0);
        std::fs::write(fresh.join("timeout_secs"), "600").unwrap();
        std::fs::write(fresh.join("started_at"), now.to_rfc3339()).unwrap();

        let unlimited = write_fake_job(tmp.path(), "job-unlimited", "running", Some("4321"), 0);
        std::fs::write(
            unlimited.join("started_at"),
            (now - chrono::Duration::seconds(3600)).to_rfc3339(),
        )
        .unwrap();

        let finished = write_fake_job(tmp.path(), "job-done", "succeeded", None, 0);
        std::fs::write(finished.join("timeout_secs"), "2").unwrap();
        std::fs::write(
            finished.join("started_at"),
            (now - chrono::Duration::seconds(60)).to_rfc3339(),
        )
        .unwrap();

        let killed: std::sync::Mutex<Vec<i32>> = std::sync::Mutex::new(Vec::new());
        let enforced = enforce_job_timeouts_with(
            tmp.path(),
            now,
            |_pid| true,
            |pid| killed.lock().unwrap().push(pid),
        )
        .unwrap();

        assert_eq!(enforced, vec!["job-overdue".to_string()]);
        assert_eq!(*killed.lock().unwrap(), vec![4321]);
        assert_eq!(
            std::fs::read_to_string(overdue.join("meta"))
                .unwrap()
                .trim(),
            "timeout"
        );
        assert_eq!(
            std::fs::read_to_string(fresh.join("meta")).unwrap().trim(),
            "running",
            "a job inside its limit must not be terminated"
        );
        assert_eq!(
            std::fs::read_to_string(unlimited.join("meta"))
                .unwrap()
                .trim(),
            "running",
            "a job without a limit (or timeout 0) must not be terminated"
        );
        assert_eq!(
            std::fs::read_to_string(finished.join("meta"))
                .unwrap()
                .trim(),
            "succeeded",
            "finished jobs are not touched"
        );
    }

    // ── T1.3（PLAN-0344 决策 #3）：paused 期间不计入运行时限 ──────────────

    #[test]
    fn paused_seconds_are_subtracted_from_runtime_budget() {
        let tmp = TempDir::new().unwrap();
        let now = chrono::Utc::now();

        let job = write_fake_job(tmp.path(), "job-paused", "running", Some("4321"), 0);
        std::fs::write(job.join("timeout_secs"), "60").unwrap();
        std::fs::write(
            job.join("started_at"),
            (now - chrono::Duration::seconds(100)).to_rfc3339(),
        )
        .unwrap();
        std::fs::write(job.join("paused_total_secs"), "50").unwrap();

        let killed: std::sync::Mutex<Vec<i32>> = std::sync::Mutex::new(Vec::new());
        let enforced = enforce_job_timeouts_with(
            tmp.path(),
            now,
            |_pid| true,
            |pid| killed.lock().unwrap().push(pid),
        )
        .unwrap();

        assert!(
            enforced.is_empty(),
            "50s of 100s was paused; still inside 60s budget"
        );
        assert_eq!(
            std::fs::read_to_string(job.join("meta")).unwrap().trim(),
            "running"
        );

        // 清零暂停抵扣后立即到点
        std::fs::write(job.join("paused_total_secs"), "0").unwrap();
        let enforced = enforce_job_timeouts_with(
            tmp.path(),
            now,
            |_pid| true,
            |pid| killed.lock().unwrap().push(pid),
        )
        .unwrap();
        assert_eq!(enforced, vec!["job-paused".to_string()]);
    }

    #[test]
    fn pause_mark_and_resume_accumulate_total_paused_seconds() {
        let tmp = TempDir::new().unwrap();
        let job = write_fake_job(tmp.path(), "job-1", "running", Some("4321"), 0);
        let t0 = chrono::Utc::now();

        let marked = mark_jobs_paused_at(tmp.path(), t0, |_pid| true).unwrap();
        assert_eq!(marked, 1);
        assert!(job.join("paused_at").exists());
        // 重复标记不叠加
        assert_eq!(mark_jobs_paused_at(tmp.path(), t0, |_pid| true).unwrap(), 0);

        let t1 = t0 + chrono::Duration::seconds(30);
        assert_eq!(resume_jobs_paused_at(tmp.path(), t1).unwrap(), 1);
        assert!(!job.join("paused_at").exists());
        assert_eq!(
            std::fs::read_to_string(job.join("paused_total_secs"))
                .unwrap()
                .trim(),
            "30"
        );

        // 再暂停 10s 累计到 40
        let t2 = t1 + chrono::Duration::seconds(5);
        mark_jobs_paused_at(tmp.path(), t2, |_pid| true).unwrap();
        resume_jobs_paused_at(tmp.path(), t2 + chrono::Duration::seconds(10)).unwrap();
        assert_eq!(
            std::fs::read_to_string(job.join("paused_total_secs"))
                .unwrap()
                .trim(),
            "40"
        );
    }
}
