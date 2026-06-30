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
use xihe_runtime::fs;

const WORKSPACE: &str = "/workspace";
const LISTEN_ADDR: &str = "127.0.0.1:39001";

#[derive(Clone)]
struct AppState;

#[tokio::main]
async fn main() {
    let log_dir = std::env::var("XIHE_LOG_DIR").unwrap_or_else(|_| "logs".to_string());
    let file_appender = tracing_appender::rolling::daily(&log_dir, "container-runtime.log");
    let (non_blocking_file, _guard) = tracing_appender::non_blocking(file_appender);

    let env_filter = std::env::var("XIHE_LOG_LEVEL_RUNTIME")
        .or_else(|_| std::env::var("XIHE_LOG_LEVEL"))
        .or_else(|_| std::env::var("RUST_LOG"))
        .unwrap_or_else(|_| "info".to_string());

    tracing_subscriber::registry()
        .with(EnvFilter::new(env_filter))
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stdout).with_ansi(false))
        .with(tracing_subscriber::fmt::layer().with_writer(non_blocking_file).with_ansi(false).json())
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
    axum::serve(listener, app)
        .await
        .expect("server error");
}

async fn health() -> &'static str {
    "ok"
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

fn err_response(e: impl ToString) -> (StatusCode, Json<ErrorResponse>) {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorResponse { error: e.to_string() }))
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

async fn fs_read(Json(req): Json<ReadRequest>) -> Result<Json<ReadResponse>, (StatusCode, Json<ErrorResponse>)> {
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
        .map(|r| Json(ReadRangeResponse {
            content: r.content,
            total_lines: r.total_lines,
            is_binary: r.is_binary,
        }))
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
    fs::edit_file(&req.path, &req.old_string, &req.new_string, req.replace_all.unwrap_or(false), WORKSPACE)
        .await
        .map(|r| Json(EditResponse { replacements: r.replacements, message: r.message }))
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
            .map(|_| Json(DeleteResponse { status: "deleted".into() }))
            .map_err(err_response)
    } else {
        fs::delete_file(&req.path, WORKSPACE)
            .await
            .map(|_| Json(DeleteResponse { status: "deleted".into() }))
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
        .map(|_| Json(MkdirResponse { status: "created".into() }))
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
        .map(|_| Json(MoveResponse { status: "moved".into() }))
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
        .map(|_| Json(CopyResponse { status: "copied".into() }))
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
