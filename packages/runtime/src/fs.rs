use std::path::{Component, Path, PathBuf};

use chrono::{DateTime, Utc};
use globset::Glob;
use ignore::Walk;
use ignore::WalkBuilder;
use notify::Watcher;
use regex::Regex;
use rmcp::schemars;
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[cfg(unix)]
use tokio::net::UnixStream;
use walkdir::WalkDir;

// PDF text extraction
use pdf_extract;

// Base64 encoding for binary files
use base64::Engine;

use crate::error::{Result, RuntimeError};

#[cfg(target_os = "linux")]
use rustix::fs as rustix_fs;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct FileInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified: String,
    pub created: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct MatchResult {
    pub file: String,
    pub line: usize,
    pub column: usize,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct FileEvent {
    pub kind: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct DirectoryListing {
    pub entries: Vec<FileInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GlobResults {
    pub matches: Vec<String>,
}
/// task-77: one hit of a filename search. `isDir` is carried because users
/// search by name and a matching directory is a legitimate result.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct FileSearchItem {
    pub path: String,
    pub name: String,
    #[serde(rename = "isDir")]
    pub is_dir: bool,
}

/// task-77: which ignore rule pruned part of the tree and where it came from.
/// A bare `ignoredSkipped` count is unactionable: the user learns that files
/// were skipped but not WHICH declaration skipped them.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct FileSearchIgnoredRule {
    pub pattern: String,
    pub source: String,
}

/// task-77: one-shot filename search result.
///
/// `truncated` means the hit limit was reached and `items` is a PREFIX, never
/// a silently shortened complete answer. `ignoredSkipped` / `ignoredRules`
/// explain the ignore surface (a file that exists but is not found).
/// `scannedFiles` / `elapsedMs` report the work actually done so a fast
/// truncated answer is not mistaken for a full scan.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct FileSearchResult {
    pub items: Vec<FileSearchItem>,
    pub truncated: bool,
    #[serde(rename = "ignoredSkipped")]
    pub ignored_skipped: usize,
    #[serde(rename = "ignoredRules")]
    pub ignored_rules: Vec<FileSearchIgnoredRule>,
    #[serde(rename = "scannedFiles")]
    pub scanned_files: usize,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GrepResults {
    pub matches: Vec<MatchResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct FileEventList {
    pub events: Vec<FileEvent>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchResult {
    pub changed: Vec<String>,
    pub diff: String,
    pub new_hashes: std::collections::HashMap<String, String>,
}

/// Shared safe-coding-loop patch core used by Docker and the MXC file worker.
pub async fn apply_patch_at(workspace: &str, patches: &[serde_json::Value]) -> Result<PatchResult> {
    const DIFF_LIMIT: usize = 256 * 1024;
    if patches.is_empty() {
        return Err(RuntimeError::InvalidPath("empty patches array".into()));
    }
    let mut prepared = Vec::with_capacity(patches.len());
    let mut seen = std::collections::HashSet::new();
    for patch in patches {
        let relative = patch
            .get("path")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| RuntimeError::InvalidPath("missing path in patch".into()))?;
        let expected = patch
            .get("expectedHash")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| RuntimeError::InvalidPath("missing expectedHash in patch".into()))?;
        if !seen.insert(relative.to_string()) {
            return Err(RuntimeError::InvalidPath("duplicate patch path".into()));
        }
        let absolute = resolve_write_path(relative, workspace)?;
        let original_exists = absolute.exists();
        let original = if original_exists {
            tokio::fs::read_to_string(&absolute).await?
        } else {
            String::new()
        };
        if (original_exists && sha256_text(&original) != expected)
            || (!original_exists && !expected.is_empty())
        {
            return Err(RuntimeError::InvalidPath("patch hash mismatch".into()));
        }
        let hunks = patch
            .get("hunks")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| RuntimeError::InvalidPath("missing hunks in patch".into()))?;
        let mut content = original.clone();
        for hunk in hunks {
            let before = hunk
                .get("before")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let after = hunk
                .get("after")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            if before.is_empty() && content.is_empty() {
                content = after.to_string();
            } else if let Some(index) = content.find(before) {
                content.replace_range(index..index + before.len(), after);
            } else {
                return Err(RuntimeError::InvalidPath("patch hunk not found".into()));
            }
        }
        prepared.push((
            relative.to_string(),
            absolute,
            original_exists,
            original,
            content,
        ));
    }
    let mut applied = Vec::new();
    for (index, (_, absolute, _, _, content)) in prepared.iter().enumerate() {
        let result = async {
            if let Some(parent) = absolute.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            tokio::fs::write(absolute, content).await
        }
        .await;
        if let Err(error) = result {
            let mut rollback_indices = applied.clone();
            rollback_indices.push(index);
            let mut rollback_errors = Vec::new();
            for applied_index in rollback_indices.iter().rev() {
                let (_, previous, existed, original, _) = &prepared[*applied_index];
                if *existed {
                    if let Err(rollback_error) = tokio::fs::write(previous, original).await {
                        rollback_errors.push(rollback_error.to_string());
                    }
                } else {
                    if let Err(rollback_error) = tokio::fs::remove_file(previous).await {
                        rollback_errors.push(rollback_error.to_string());
                    }
                }
            }
            if !rollback_errors.is_empty() {
                return Err(RuntimeError::PartialRollbackFailed {
                    detail: rollback_errors.join("; "),
                });
            }
            return Err(RuntimeError::Io(error));
        }
        applied.push(index);
    }
    let changed = prepared
        .iter()
        .map(|(path, _, _, _, _)| path.clone())
        .collect();
    let new_hashes = prepared
        .iter()
        .map(|(path, _, _, _, content)| (path.clone(), sha256_text(content)))
        .collect();
    let mut diff = String::new();
    for (path, _, _, _, content) in &prepared {
        diff.push_str(&format!("--- a/{path}\n+++ b/{path}\n"));
        for line in content.lines() {
            if diff.len() + line.len() + 2 > DIFF_LIMIT {
                diff.push_str("[diff truncated]\n");
                break;
            }
            diff.push('+');
            diff.push_str(line);
            diff.push('\n');
        }
    }
    Ok(PatchResult {
        changed,
        diff,
        new_hashes,
    })
}

fn sha256_text(value: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Stage 1: Lexical validation — no filesystem access.
/// Rejects absolute paths, resolves `.` and `..` lexically,
/// and ensures the normalized path stays within the workspace root.
fn lexically_safe(path: &str, workspace: &Path) -> Result<PathBuf> {
    if Path::new(path).is_absolute() {
        return Err(RuntimeError::PathTraversal {
            path: path.to_string(),
        });
    }

    let joined = workspace.join(path);

    let normalized: PathBuf = joined.components().fold(PathBuf::new(), |mut acc, c| {
        match c {
            Component::ParentDir => {
                acc.pop();
            }
            Component::CurDir => {}
            other => acc.push(other.as_os_str()),
        }
        acc
    });

    if !normalized.starts_with(workspace) {
        return Err(RuntimeError::PathTraversal {
            path: path.to_string(),
        });
    }

    Ok(normalized)
}

/// task-544: the file-worker identifies itself through its argv, not through an
/// environment marker. The marker had to be injected into the MXC policy, which
/// was what made every file operation carry the Runtime's environment.
fn running_as_file_worker() -> bool {
    std::env::args().any(|argument| argument == "--file-worker")
}

/// Stage 2: Filesystem validation — canonicalize resolves symlinks,
/// then check the real path still lies within the workspace root.
fn resolve_canonical(path: &Path, workspace: &Path) -> Result<PathBuf> {
    if running_as_file_worker() {
        // The outer Runtime has already performed path preflight and assembled
        // the MXC filesystem policy. The data-plane worker must not resolve
        // host ancestors or discover paths outside its authorized root.
        return Ok(path.to_path_buf());
    }
    let canonical = match path.canonicalize() {
        Ok(canonical) => canonical,
        // PLAN-0427 T1.1: ENOENT is absence, not a traversal. Classifying the
        // missing file (or missing parent) as FileNotFound lets REST answer
        // `200 {found:false}` and keeps ELOOP/EACCES/other canonicalize
        // failures as PathTraversal (403). Security boundaries (lexical,
        // in-bounds, openat2) are unchanged.
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(RuntimeError::FileNotFound(
                path.to_string_lossy().to_string(),
            ));
        }
        Err(_) => {
            return Err(RuntimeError::PathTraversal {
                path: path.to_string_lossy().to_string(),
            });
        }
    };

    let ws_canonical = match workspace.canonicalize() {
        Ok(canonical) => canonical,
        Err(_) => {
            return Err(RuntimeError::WorkspaceNotFound(
                workspace.to_string_lossy().to_string(),
            ));
        }
    };

    if !windows_path_within(&canonical, &ws_canonical) {
        return Err(RuntimeError::SymlinkEscape {
            path: path.to_string_lossy().to_string(),
            resolved: canonical.to_string_lossy().to_string(),
        });
    }

    Ok(canonical)
}

fn windows_path_within(path: &Path, root: &Path) -> bool {
    #[cfg(windows)]
    {
        let normalize = |value: &Path| {
            value
                .to_string_lossy()
                .replace('\\', "/")
                .trim_start_matches("//?/")
                .trim_end_matches('/')
                .to_ascii_lowercase()
        };
        let path = normalize(path);
        let root = normalize(root);
        path == root || path.starts_with(&(root + "/"))
    }
    #[cfg(not(windows))]
    {
        path.starts_with(root)
    }
}

/// PLAN-0639 D39-5 (先定根、再解析): the declared root selected for one path
/// operation. `host_path` is the declared root's host path and becomes the
/// resolution boundary for both validation stages — it is NOT necessarily the
/// workspace's primary root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootBoundary {
    /// Selected declared root id. `None` marks the primary root for legacy
    /// callers that never saw a rootId (root[0].id == workspaceId invariant).
    pub root_id: Option<String>,
    /// Host path of the selected root — pass this as the `workspace` argument
    /// of `resolve_read_path_for_root` / `resolve_write_path_for_root`.
    pub host_path: PathBuf,
}

/// PLAN-0639 D39-5 先定根: select the declared root boundary for a path op.
///
/// * `workspace` — the materialized primary root path (root[0], id ==
///   workspaceId), always available from the Workspace registry.
/// * `roots` — ordered `spec.roots` as `(root_id, host_path)` pairs. Ignored
///   when `root_id` is `None`.
/// * `root_id = None` — primary root (legacy single-root callers): the
///   boundary is `workspace` itself, byte-identical to pre-0639 behavior.
/// * `root_id = Some(id)` — the declared root with that id; its hostPath
///   becomes the boundary, NOT the primary root. Unknown ids, blank ids, and
///   empty/relative hostPaths all fail closed (`InvalidPath`).
///
/// D39-5: a relative path declared in root A must never resolve into root B —
/// the returned boundary is the single source of truth handed to the
/// two-stage resolution.
pub fn select_root_boundary(
    workspace: &str,
    roots: &[(String, String)],
    root_id: Option<&str>,
) -> Result<RootBoundary> {
    let Some(root_id) = root_id else {
        if workspace.trim().is_empty() {
            return Err(RuntimeError::InvalidPath(
                "primary root boundary is empty".into(),
            ));
        }
        return Ok(RootBoundary {
            root_id: None,
            host_path: PathBuf::from(workspace),
        });
    };
    if root_id.trim().is_empty() {
        return Err(RuntimeError::InvalidPath("rootId must not be blank".into()));
    }
    let (_, host_path) = roots
        .iter()
        .find(|(id, _)| id == root_id)
        .ok_or_else(|| RuntimeError::InvalidPath(format!("unknown rootId {root_id:?}")))?;
    if host_path.trim().is_empty() {
        return Err(RuntimeError::InvalidPath(format!(
            "declared root {root_id:?} has an empty hostPath"
        )));
    }
    let path = PathBuf::from(host_path);
    if !path.is_absolute() {
        return Err(RuntimeError::InvalidPath(format!(
            "declared root {root_id:?} hostPath is not absolute: {host_path:?}"
        )));
    }
    Ok(RootBoundary {
        root_id: Some(root_id.to_string()),
        host_path: path,
    })
}

/// PLAN-0639 D39-5: reject malformed root ids before resolution (fail closed).
fn reject_malformed_root_id(root_id: Option<&str>) -> Result<()> {
    if let Some(id) = root_id
        && id.trim().is_empty()
    {
        return Err(RuntimeError::InvalidPath("rootId must not be blank".into()));
    }
    Ok(())
}

/// Resolve a path for read operations.
/// Two-stage check: lexical ⇒ filesystem (canonicalize).
pub fn resolve_read_path(path: &str, workspace: &str) -> Result<PathBuf> {
    resolve_read_path_for_root(path, workspace, None)
}

/// PLAN-0639 D39-5 (先定根、再解析): resolve a read path against the DECLARED
/// ROOT boundary. `workspace` must be the declared root's host path (see
/// [`select_root_boundary`]) — for `root_id = None` that is the primary root
/// and behavior is byte-identical to pre-0639. The two-stage validation is
/// unchanged; only the boundary root moved from "always the primary root" to
/// "the root the path was declared in". `root_id` is validated (blank ids fail
/// closed) and carried as the attribution for this resolution.
pub fn resolve_read_path_for_root(
    path: &str,
    workspace: &str,
    root_id: Option<&str>,
) -> Result<PathBuf> {
    reject_malformed_root_id(root_id)?;
    let ws = Path::new(workspace);
    let normalized = lexically_safe(path, ws)?;
    resolve_canonical(&normalized, ws)
}

/// Resolve a path for write operations.
/// Since the target file may not exist yet, we canonicalize the first existing
/// ancestor directory instead, then re-check the ancestor lies within workspace.
pub fn resolve_write_path(path: &str, workspace: &str) -> Result<PathBuf> {
    resolve_write_path_for_root(path, workspace, None)
}

/// PLAN-0639 D39-5 (先定根、再解析): write-side variant of
/// [`resolve_read_path_for_root`] — same declared-root boundary semantics.
pub fn resolve_write_path_for_root(
    path: &str,
    workspace: &str,
    root_id: Option<&str>,
) -> Result<PathBuf> {
    reject_malformed_root_id(root_id)?;
    let ws = Path::new(workspace);
    let target = lexically_safe(path, ws)?;

    let mut ancestor = target
        .parent()
        .ok_or_else(|| RuntimeError::InvalidPath("no parent".into()))?;
    while !ancestor.exists() {
        ancestor = ancestor
            .parent()
            .ok_or_else(|| RuntimeError::InvalidPath("no parent".into()))?;
    }

    resolve_canonical(ancestor, ws)?;
    Ok(target)
}

#[cfg(target_os = "linux")]
#[allow(dead_code)]
fn secure_beneath_check(path: &str, workspace: &str) -> Result<()> {
    use std::os::unix::io::AsFd;
    // Lexical already done by caller; now use openat2 to verify no symlink escape
    let ws_file = std::fs::File::open(workspace).map_err(|e| RuntimeError::Io(e))?;
    let ws_fd = ws_file.as_fd();
    // Relative path inside workspace (strip leading / if any, lexical already ensures no absolute)
    let rel = Path::new(path);
    // Try to open with RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV
    let flags = rustix_fs::OFlags::empty();
    let mode = rustix_fs::Mode::empty();
    let resolve = rustix_fs::ResolveFlags::BENEATH
        | rustix_fs::ResolveFlags::NO_SYMLINKS
        | rustix_fs::ResolveFlags::NO_MAGICLINKS;
    match rustix_fs::openat2(ws_fd, rel, flags, mode, resolve) {
        Ok(_) => Ok(()),
        Err(e) => {
            if e == rustix::io::Errno::NOSYS || e == rustix::io::Errno::INVAL {
                return Err(RuntimeError::InvalidPath(format!(
                    "openat2 not supported: {e} – blocked"
                )));
            }
            // If file doesn't exist, we check parent instead
            if e == rustix::io::Errno::NOENT {
                if let Some(parent) = rel.parent() {
                    if parent.as_os_str().is_empty() {
                        return Ok(());
                    }
                    return secure_beneath_check(parent.to_str().unwrap_or("."), workspace);
                }
                return Ok(());
            }
            // Symlink escape or outside -> map to SymlinkEscape
            Err(RuntimeError::SymlinkEscape {
                path: path.to_string(),
                resolved: format!("openat2 blocked: {e}"),
            })
        }
    }
}

#[cfg(target_os = "linux")]
#[allow(dead_code)]
fn secure_write_beneath(path: &str, workspace: &str) -> Result<PathBuf> {
    let target = lexically_safe(path, Path::new(workspace))?;
    // Verify parent/target stays beneath via openat2
    secure_beneath_check(path, workspace)?;
    // Also verify existing target if exists is not symlink outside
    if target.exists() {
        // Check via openat2 again with NO_SYMLINKS should fail if symlink
        secure_beneath_check(path, workspace)?;
    }
    Ok(target)
}

#[cfg(not(target_os = "linux"))]
#[allow(dead_code)]
fn secure_write_beneath(path: &str, workspace: &str) -> Result<PathBuf> {
    // Fallback to lexical + canonical ancestor check on non-linux (should not happen in container)
    resolve_write_path(path, workspace)
}

pub fn strip_workspace<'a>(full_path: &'a Path, workspace: &str) -> &'a Path {
    if let Ok(relative) = full_path.strip_prefix(workspace) {
        return relative;
    }

    // Windows canonicalize() uses the extended \\?\ prefix. Compare against
    // a canonical workspace as well so callers still receive relative paths.
    #[cfg(windows)]
    if let Ok(canonical_workspace) = Path::new(workspace).canonicalize()
        && let Ok(relative) = full_path.strip_prefix(canonical_workspace)
    {
        return relative;
    }

    full_path
}

fn to_rfc3339(time: std::time::SystemTime) -> String {
    let dt: DateTime<Utc> = time.into();
    dt.to_rfc3339()
}

/// Check if the container file service socket exists for this workspace.
fn file_socket_path(workspace: &str) -> PathBuf {
    Path::new(workspace).join(".xihe-file.sock")
}

/// Send a line-based request to the container file service via Unix socket.
/// Protocol: first line = action, second line = path, optional third line = content.
/// Response: first line = "ok" or "error", remaining lines = payload.
#[cfg(unix)]
async fn call_file_service(
    socket_path: &Path,
    action: &str,
    path: &str,
    content: Option<&str>,
) -> Result<Vec<String>> {
    let stream = UnixStream::connect(socket_path)
        .await
        .map_err(|e| RuntimeError::InvalidPath(format!("file service socket: {e}")))?;
    let (reader, mut writer) = stream.into_split();

    let mut buf = format!("{action}\n{path}\n");
    if let Some(c) = content {
        buf.push_str(c);
        buf.push('\n');
    }
    writer
        .write_all(buf.as_bytes())
        .await
        .map_err(|e| RuntimeError::InvalidPath(format!("file service write: {e}")))?;
    writer.shutdown().await.ok();

    let mut lines = Vec::new();
    let mut buf_reader = BufReader::new(reader);
    let mut line = String::new();
    loop {
        line.clear();
        let n = buf_reader
            .read_line(&mut line)
            .await
            .map_err(|e| RuntimeError::InvalidPath(format!("file service read: {e}")))?;
        if n == 0 {
            break;
        }
        lines.push(line.trim_end().to_string());
    }

    if lines.is_empty() {
        return Err(RuntimeError::InvalidPath(
            "empty response from file service".into(),
        ));
    }
    if lines[0] == "error" && lines.len() > 1 {
        return Err(RuntimeError::InvalidPath(lines[1..].join("\n")));
    }
    if lines[0] != "ok" {
        return Err(RuntimeError::InvalidPath(format!(
            "file service unexpected status: {}",
            lines[0]
        )));
    }
    Ok(lines[1..].to_vec())
}

#[cfg(not(unix))]
async fn call_file_service(
    _socket_path: &Path,
    _action: &str,
    _path: &str,
    _content: Option<&str>,
) -> Result<Vec<String>> {
    Err(RuntimeError::InvalidPath(
        "file service Unix socket is unavailable on this platform".into(),
    ))
}

pub async fn read_file(path: &str, workspace: &str) -> Result<String> {
    // Prefer container file service socket when available
    let socket = file_socket_path(workspace);
    if socket.exists() {
        let lines = call_file_service(&socket, "read", path, None).await?;
        return Ok(lines.join("\n"));
    }
    let full_path = resolve_read_path(path, workspace)?;
    Ok(tokio::fs::read_to_string(&full_path).await?)
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ReadFileRangeRequest {
    pub path: String,
    pub offset: Option<usize>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ReadFileRangeResult {
    pub content: String,
    pub total_lines: usize,
    pub is_binary: bool,
}

pub async fn read_file_range(
    path: &str,
    offset: Option<usize>,
    limit: Option<usize>,
    workspace: &str,
) -> Result<ReadFileRangeResult> {
    let full_path = resolve_read_path(path, workspace)?;
    let bytes = tokio::fs::read(&full_path).await?;

    // Binary detection: check first 8KB for null bytes
    let check_len = bytes.len().min(8192);
    let is_binary = bytes[..check_len].contains(&0x00);

    if is_binary {
        // PLAN-292 T6: base64 previews target images/docs opened in the UI;
        // cap the payload so an accidental huge binary cannot inflate the
        // MCP response (16 MiB raw ≈ 22 MiB base64).
        const BINARY_PREVIEW_MAX_BYTES: usize = 16 * 1024 * 1024;
        if bytes.len() > BINARY_PREVIEW_MAX_BYTES {
            return Err(RuntimeError::InvalidPath(format!(
                "file too large for binary preview: {} bytes (limit {} bytes)",
                bytes.len(),
                BINARY_PREVIEW_MAX_BYTES
            )));
        }
        let content = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Ok(ReadFileRangeResult {
            content,
            total_lines: 0,
            is_binary: true,
        });
    }

    let text = String::from_utf8(bytes)
        .map_err(|e| RuntimeError::InvalidPath(format!("Not valid UTF-8: {e}")))?;
    let lines: Vec<&str> = text.lines().collect();
    let total_lines = lines.len();

    let offset = offset.unwrap_or(1).max(1);
    let limit = limit.unwrap_or(total_lines);

    let start = (offset - 1).min(total_lines);
    let end = (start + limit).min(total_lines);

    let content: String = lines[start..end]
        .iter()
        .enumerate()
        .map(|(i, line)| format!("{} | {}", start + i + 1, line))
        .collect::<Vec<_>>()
        .join("\n");

    Ok(ReadFileRangeResult {
        content,
        total_lines,
        is_binary: false,
    })
}

pub async fn write_file_binary(path: &str, data: &[u8], workspace: &str) -> Result<String> {
    #[cfg(target_os = "linux")]
    let full_path = secure_write_beneath(path, workspace)?;
    #[cfg(not(target_os = "linux"))]
    let full_path = resolve_write_path(path, workspace)?;
    if let Some(parent) = full_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&full_path, data).await?;
    Ok(format!("Written {} bytes to {}", data.len(), path))
}

pub async fn write_file(path: &str, content: &str, workspace: &str) -> Result<String> {
    let socket = file_socket_path(workspace);
    if socket.exists() {
        call_file_service(&socket, "write", path, Some(content)).await?;
        return Ok(format!("Written {} bytes to {}", content.len(), path));
    }
    #[cfg(target_os = "linux")]
    let full_path = secure_write_beneath(path, workspace)?;
    #[cfg(not(target_os = "linux"))]
    let full_path = resolve_write_path(path, workspace)?;
    if let Some(parent) = full_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&full_path, content).await?;
    Ok(format!("Written {} bytes to {}", content.len(), path))
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct EditFileRequest {
    pub file_path: String,
    pub old_string: String,
    pub new_string: String,
    pub replace_all: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct EditFileResult {
    pub success: bool,
    pub replacements: usize,
    pub message: String,
}

pub async fn edit_file(
    file_path: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
    workspace: &str,
) -> Result<EditFileResult> {
    let full_path = resolve_read_path(file_path, workspace)?;
    let content = tokio::fs::read_to_string(&full_path).await?;

    if old_string.is_empty() {
        return Err(RuntimeError::InvalidPath(
            "old_string cannot be empty".into(),
        ));
    }

    let replacements: Vec<String> = content
        .match_indices(old_string)
        .map(|(pos, _)| format!("match at position {pos}"))
        .collect();

    if replacements.is_empty() {
        return Err(RuntimeError::FileNotFound(format!(
            "No match found for: {old_string}"
        )));
    }

    if !replace_all && replacements.len() > 1 {
        return Err(RuntimeError::InvalidPath(format!(
            "Found {} matches for '{}'. Set replace_all=true or narrow the pattern.",
            replacements.len(),
            old_string
        )));
    }

    let new_content = if replace_all {
        content.replace(old_string, new_string)
    } else {
        content.replacen(old_string, new_string, 1)
    };

    let replacement_count = new_content
        .match_indices(new_string)
        .count()
        .saturating_sub(content.match_indices(old_string).count())
        .saturating_add(if replace_all { replacements.len() } else { 1 });

    #[cfg(target_os = "linux")]
    let _ = secure_write_beneath(file_path, workspace)?;
    #[cfg(not(target_os = "linux"))]
    let _ = resolve_write_path(file_path, workspace)?;
    tokio::fs::write(&full_path, &new_content).await?;

    Ok(EditFileResult {
        success: true,
        replacements: replacement_count,
        message: format!("Replaced {replacement_count} occurrence(s) in {file_path}"),
    })
}

pub async fn delete_file(path: &str, workspace: &str) -> Result<String> {
    #[cfg(target_os = "linux")]
    secure_beneath_check(path, workspace)?;
    let socket = file_socket_path(workspace);
    if socket.exists() {
        call_file_service(&socket, "rm", path, None).await?;
        return Ok(format!("Deleted file: {path}"));
    }
    let full_path = resolve_write_path(path, workspace)?;
    if !full_path.exists() {
        return Err(RuntimeError::FileNotFound(format!(
            "File not found: {path}"
        )));
    }
    if !full_path.is_file() {
        return Err(RuntimeError::InvalidPath(format!("Not a file: {path}")));
    }
    tokio::fs::remove_file(&full_path).await?;
    Ok(format!("Deleted file: {path}"))
}

pub async fn delete_directory(path: &str, recursive: bool, workspace: &str) -> Result<String> {
    let socket = file_socket_path(workspace);
    if socket.exists() {
        let action = if recursive { "rmdir" } else { "rm" };
        call_file_service(&socket, action, path, None).await?;
        return Ok(format!(
            "Deleted directory{}: {}",
            if recursive { " (recursive)" } else { "" },
            path
        ));
    }
    let full_path = resolve_write_path(path, workspace)?;
    if !full_path.exists() {
        return Err(RuntimeError::FileNotFound(format!(
            "Directory not found: {path}"
        )));
    }
    if !full_path.is_dir() {
        return Err(RuntimeError::InvalidPath(format!(
            "Not a directory: {path}"
        )));
    }
    if full_path == Path::new(workspace) {
        return Err(RuntimeError::InvalidPath(
            "Cannot delete workspace root".into(),
        ));
    }
    if recursive {
        tokio::fs::remove_dir_all(&full_path).await?;
        Ok(format!("Deleted directory (recursive): {path}"))
    } else {
        tokio::fs::remove_dir(&full_path).await?;
        Ok(format!("Deleted directory: {path}"))
    }
}

pub async fn move_file(from: &str, to: &str, workspace: &str) -> Result<String> {
    #[cfg(target_os = "linux")]
    {
        secure_beneath_check(from, workspace)?;
        secure_beneath_check(to, workspace)?;
    }
    let src = resolve_write_path(from, workspace)?;
    let dst = resolve_write_path(to, workspace)?;
    if !src.exists() {
        return Err(RuntimeError::FileNotFound(format!(
            "Source not found: {from}"
        )));
    }
    if let Some(parent) = dst.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::rename(&src, &dst).await?;
    Ok(format!("Moved {from} to {to}"))
}

pub async fn copy_file(from: &str, to: &str, workspace: &str) -> Result<String> {
    #[cfg(target_os = "linux")]
    {
        secure_beneath_check(from, workspace)?;
        secure_beneath_check(to, workspace)?;
    }
    let src = resolve_read_path(from, workspace)?;
    let dst = resolve_write_path(to, workspace)?;
    if !src.exists() {
        return Err(RuntimeError::FileNotFound(format!(
            "Source not found: {from}"
        )));
    }
    if let Some(parent) = dst.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::copy(&src, &dst).await?;
    Ok(format!("Copied {from} to {to}"))
}

pub async fn mkdir(path: &str, workspace: &str) -> Result<String> {
    #[cfg(target_os = "linux")]
    secure_beneath_check(path, workspace)?;
    let socket = file_socket_path(workspace);
    if socket.exists() {
        call_file_service(&socket, "mkdir", path, None).await?;
        return Ok(format!("Created directory: {path}"));
    }
    let full_path = resolve_write_path(path, workspace)?;
    tokio::fs::create_dir_all(&full_path).await?;
    Ok(format!("Created directory: {path}"))
}

pub async fn extract_pdf_text(path: &str, workspace: &str) -> Result<String> {
    let full_path = resolve_read_path(path, workspace)?;
    let bytes = tokio::fs::read(&full_path).await?;
    let text = pdf_extract::extract_text_from_mem(&bytes)
        .map_err(|e| RuntimeError::InvalidPath(format!("PDF extract failed: {e}")))?;
    Ok(text)
}

pub fn list_directory(path: &str, workspace: &str) -> Result<Vec<FileInfo>> {
    let socket = file_socket_path(workspace);
    if socket.exists() {
        let rt = tokio::runtime::Handle::current();
        let lines = rt.block_on(call_file_service(&socket, "list", path, None))?;
        let entries = lines
            .iter()
            .map(|name| {
                let full = Path::new(workspace).join(name);
                let meta = full.metadata().ok();
                FileInfo {
                    name: name.clone(),
                    path: name.clone(),
                    is_dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                    is_symlink: meta.as_ref().map(|m| m.is_symlink()).unwrap_or(false),
                    size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                    modified: meta
                        .as_ref()
                        .and_then(|m| m.modified().ok())
                        .map(to_rfc3339)
                        .unwrap_or_default(),
                    created: meta.as_ref().and_then(|m| m.created().ok()).map(to_rfc3339),
                }
            })
            .collect();
        return Ok(entries);
    }
    let full_path = resolve_read_path(path, workspace)?;

    if !full_path.is_dir() {
        return Err(RuntimeError::InvalidPath(format!(
            "Not a directory: {path}"
        )));
    }

    let ws_str = workspace.to_string();
    let entries = WalkDir::new(&full_path)
        .max_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .skip(1)
        .map(|entry| {
            let meta = entry.metadata().ok();
            FileInfo {
                name: entry.file_name().to_string_lossy().to_string(),
                path: strip_workspace(entry.path(), &ws_str)
                    .to_string_lossy()
                    .to_string(),
                is_dir: entry.file_type().is_dir(),
                is_symlink: entry.file_type().is_symlink(),
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                modified: meta
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .map(to_rfc3339)
                    .unwrap_or_default(),
                created: meta.as_ref().and_then(|m| m.created().ok()).map(to_rfc3339),
            }
        })
        .collect();

    Ok(entries)
}

pub fn glob_files(pattern: &str, path: &str, workspace: &str) -> Result<Vec<String>> {
    let full_path = resolve_read_path(path, workspace)?;
    let glob = Glob::new(pattern)?.compile_matcher();
    let ws_str = workspace.to_string();

    let matches = Walk::new(&full_path)
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
        .filter(|e| {
            let rel = strip_workspace(e.path(), &ws_str);
            glob.is_match(rel)
        })
        .map(|e| {
            strip_workspace(e.path(), &ws_str)
                .to_string_lossy()
                .to_string()
        })
        .collect();

    Ok(matches)
}

/// task-77: one-shot filename search over a workspace subtree.
///
/// This is the REST twin of the Agent-facing `glob` tool: it answers "which
/// names contain this substring", which `glob_files` cannot do without turning
/// into a glob-pattern matcher — and it must not, because that is the existing
/// tool contract. `glob_files` is left byte-identical on purpose.
///
/// Traversal reuses the SAME engine as [`glob_files`] (`ignore::Walk`, i.e.
/// ripgrep walker) so `.gitignore` / global excludes / `.git/info/exclude`
/// semantics are identical; a bare `walkdir` would drag `node_modules`, build
/// output and `.git` into the result set.
///
/// `query` is a case-insensitive substring on the entry NAME. There is
/// deliberately no glob parameter: glob has its own endpoint.
pub fn search_files(
    query: &str,
    path: &str,
    workspace: &str,
    limit: Option<usize>,
) -> Result<FileSearchResult> {
    let full_path = resolve_read_path(path, workspace)?;

    if !full_path.is_dir() {
        return Err(RuntimeError::InvalidPath(format!(
            "Not a directory: {path}"
        )));
    }

    let needle = query.to_lowercase();
    let ws_str = workspace.to_string();
    let cap = limit.filter(|n| *n > 0);

    let mut items: Vec<FileSearchItem> = Vec::new();
    let mut scanned = 0usize;
    let mut truncated = false;
    let mut seek_more = false;
    let started = std::time::Instant::now();

    let walker = WalkBuilder::new(&full_path)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .build();

    for entry in walker.filter_map(|e| e.ok()) {
        let file_type = match entry.file_type() {
            Some(t) => t,
            None => continue,
        };
        // Directories are hits too: a folder whose name matches is a result the
        // caller asked for (hence `isDir` on the wire).
        if !file_type.is_file() && !file_type.is_dir() {
            continue;
        }
        if entry.depth() == 0 {
            continue; // the searched directory itself is never a hit
        }
        scanned += 1;
        let name = match entry.file_name().to_str() {
            Some(n) => n,
            None => continue,
        };
        if !name.to_lowercase().contains(&needle) {
            continue;
        }
        if seek_more {
            // One hit beyond the cap proves the answer is a prefix.
            truncated = true;
            break;
        }
        items.push(FileSearchItem {
            path: strip_workspace(entry.path(), &ws_str)
                .to_string_lossy()
                .to_string(),
            name: name.to_string(),
            is_dir: file_type.is_dir(),
        });
        if let Some(cap) = cap
            && items.len() >= cap
        {
            seek_more = true;
        }
    }
    // `truncated` means "there are MORE hits than returned". Breaking the
    // instant the cap is reached cannot tell that apart from "the cap happens
    // to equal the total" — that would claim truncation on an exact fit and
    // send the user hunting for results that do not exist. So the cap stops
    // the COLLECTION but the scan continues until one more hit is actually
    // observed (or the tree ends).

    let (ignored_skipped, ignored_rules) = count_ignored_surface(&full_path, &ws_str);

    Ok(FileSearchResult {
        items,
        truncated,
        ignored_skipped,
        ignored_rules,
        scanned_files: scanned,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// task-77: exact ignore-surface accounting.
///
/// Why a second pass instead of reading it off the search walk: `ignore` prunes
/// an ignored directory BEFORE yielding it (`Walk::filter_entry` sees 21,382
/// calls for 21,383 yielded entries — ratio 1.00 over the `one` workspace), so
/// the search walk can never report what it skipped. This pass disables the
/// built-in rules and drives the same `Gitignore` matcher by hand, counting
/// nodes that match and NOT descending there — so its cost stays proportional
/// to the visible tree (measured 133 ms) instead of the ignored one (4.4 s for
/// a full descent).
///
/// The matcher is built from exactly `.gitignore` + `.git/info/exclude` of the
/// searched root. Nested per-directory `.gitignore` files below the root are
/// NOT loaded here: the root-level rules are what explain "my file is inside an
/// ignored area" for the common case, and claiming per-nested-file fidelity
/// would require a matcher stack the walker does not expose. This is a known,
/// stated approximation — it can under-report, never over-report.
fn count_ignored_surface(full_path: &Path, ws_str: &str) -> (usize, Vec<FileSearchIgnoredRule>) {
    let mut builder = ignore::gitignore::GitignoreBuilder::new(full_path);
    let mut loaded = false;
    for candidate in [
        full_path.join(".gitignore"),
        full_path.join(".git").join("info").join("exclude"),
    ] {
        if candidate.exists() && builder.add(&candidate).is_none() {
            loaded = true;
        }
    }
    if !loaded {
        return (0, Vec::new());
    }
    let matcher = match builder.build() {
        Ok(m) => std::sync::Arc::new(m),
        Err(_) => return (0, Vec::new()),
    };

    // `filter_entry` is a shared `Fn`, so the counters and the collected rules
    // live behind mutexes. Contention is irrelevant here: the walker calls
    // them from its own thread(s) and each visit is a handful of nanoseconds.
    let state = std::sync::Arc::new(std::sync::Mutex::new((
        0usize,
        Vec::<FileSearchIgnoredRule>::new(),
    )));
    let prune = {
        let matcher = std::sync::Arc::clone(&matcher);
        let state = std::sync::Arc::clone(&state);
        let ws_owned = ws_str.to_string();
        WalkBuilder::new(full_path)
            .hidden(false)
            .git_ignore(false)
            .git_global(false)
            .git_exclude(false)
            .require_git(false)
            .filter_entry(move |entry| {
                if entry.depth() == 0 {
                    return true;
                }
                let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
                match matcher.matched_path_or_any_parents(entry.path(), is_dir) {
                    ignore::Match::Ignore(glob) => {
                        let pattern = glob.original().to_string();
                        let source = glob
                            .from()
                            .map(|p| strip_workspace(p, &ws_owned).to_string_lossy().to_string())
                            .unwrap_or_default();
                        if let Ok(mut guard) = state.lock() {
                            guard.0 += 1;
                            if !guard.1.iter().any(|r| r.pattern == pattern) {
                                guard.1.push(FileSearchIgnoredRule { pattern, source });
                            }
                        }
                        false
                    }
                    _ => true,
                }
            })
            .build()
    };
    for _ in prune.filter_map(|e| e.ok()) {}

    let mut state = state.lock().map(|g| g.clone()).unwrap_or((0, Vec::new()));
    state.1.sort_by(|a, b| a.pattern.cmp(&b.pattern));
    (state.0, state.1)
}

pub fn grep_files(pattern: &str, path: &str, workspace: &str) -> Result<Vec<MatchResult>> {
    let full_path = resolve_read_path(path, workspace)?;
    let re = Regex::new(pattern)?;
    let ws_str = workspace.to_string();

    let mut results = Vec::new();

    for entry in Walk::new(&full_path).filter_map(|e| e.ok()) {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }

        let rel_path = strip_workspace(entry.path(), &ws_str)
            .to_string_lossy()
            .to_string();

        if let Ok(content) = std::fs::read_to_string(entry.path()) {
            for (i, line) in content.lines().enumerate() {
                if let Some(mat) = re.find(line) {
                    results.push(MatchResult {
                        file: rel_path.clone(),
                        line: i + 1,
                        column: mat.start() + 1,
                        content: line.to_string(),
                    });
                }
            }
        }
    }

    Ok(results)
}

pub fn get_file_info(path: &str, workspace: &str) -> Result<FileInfo> {
    let socket = file_socket_path(workspace);
    if socket.exists() {
        let rt = tokio::runtime::Handle::current();
        let lines = rt.block_on(call_file_service(&socket, "stat", path, None))?;
        return Ok(FileInfo {
            name: Path::new(path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            path: path.to_string(),
            is_dir: lines.iter().any(|l| l.contains('d') && l.starts_with('d')),
            is_symlink: lines.iter().any(|l| l.starts_with('l')),
            size: 0,
            modified: String::new(),
            created: None,
        });
    }
    let full_path = resolve_read_path(path, workspace)?;

    if !full_path.exists() {
        return Err(RuntimeError::FileNotFound(path.to_string()));
    }

    let meta = full_path.metadata()?;

    Ok(FileInfo {
        name: full_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        path: path.to_string(),
        is_dir: meta.is_dir(),
        is_symlink: full_path.is_symlink(),
        size: meta.len(),
        modified: meta.modified().ok().map(to_rfc3339).unwrap_or_default(),
        created: meta.created().ok().map(to_rfc3339),
    })
}

pub fn watch_directory(path: &str, workspace: &str) -> Result<Vec<FileEvent>> {
    let full_path = resolve_read_path(path, workspace)?;

    let (tx, rx) = std::sync::mpsc::channel();

    let mut watcher = notify::RecommendedWatcher::new(
        move |res| {
            if let Ok(event) = res {
                let _ = tx.send(event);
            }
        },
        notify::Config::default(),
    )
    .map_err(|e| RuntimeError::Watch(e.to_string()))?;

    watcher
        .watch(&full_path, notify::RecursiveMode::Recursive)
        .map_err(|e| RuntimeError::Watch(e.to_string()))?;

    let start = std::time::Instant::now();
    let duration = std::time::Duration::from_secs(2);
    let mut events = Vec::new();

    while start.elapsed() < duration {
        match rx.try_recv() {
            Ok(event) => {
                for ep in event.paths {
                    events.push(FileEvent {
                        kind: format!("{:?}", event.kind),
                        path: ep.to_string_lossy().to_string(),
                    });
                }
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
        }
    }

    drop(watcher);
    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[cfg(windows)]
    #[test]
    fn windows_path_comparison_normalizes_case_and_extended_prefix() {
        assert!(windows_path_within(
            Path::new(r"\\?\H:\Work\Workspace\file.txt"),
            Path::new(r"h:\work\workspace")
        ));
        assert!(!windows_path_within(
            Path::new(r"h:\work\workspace-other\file.txt"),
            Path::new(r"h:\work\workspace")
        ));
    }

    #[test]
    fn test_resolve_path_rejects_absolute() {
        let err = resolve_read_path("/etc/passwd", "/tmp/ws").unwrap_err();
        assert!(
            matches!(err, RuntimeError::PathTraversal { .. }),
            "expected PathTraversal, got {err}"
        );
    }

    #[test]
    fn test_resolve_path_rejects_absolute_double_slash() {
        let err = resolve_read_path("//etc/shadow", "/tmp/ws").unwrap_err();
        assert!(matches!(err, RuntimeError::PathTraversal { .. }));
    }

    #[test]
    fn test_resolve_path_rejects_traversal_dot_dot() {
        let err = resolve_read_path("../../../etc", "/tmp/ws").unwrap_err();
        assert!(matches!(err, RuntimeError::PathTraversal { .. }));
    }

    #[test]
    fn test_resolve_path_rejects_deep_traversal() {
        let err = resolve_read_path("foo/bar/../../../../etc", "/tmp/ws").unwrap_err();
        assert!(matches!(err, RuntimeError::PathTraversal { .. }));
    }

    #[test]
    fn test_resolve_path_rejects_traversal_inside() {
        let err = resolve_read_path("foo/../../etc/passwd", "/tmp/ws").unwrap_err();
        assert!(matches!(err, RuntimeError::PathTraversal { .. }));
    }

    #[test]
    fn test_resolve_path_accepts_relative() {
        // resolve_read_path canonicalizes the path; a missing path returns
        // FileNotFound (PLAN-0427), while pure lexical checks use lexically_safe.
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        fs::write(dir.path().join("bar.txt"), "data").unwrap();
        let result = resolve_read_path("bar.txt", ws).unwrap();
        assert_eq!(
            result,
            fs::canonicalize(dir.path().join("bar.txt")).unwrap()
        );
    }

    // PLAN-0427 T1.3: ENOENT classifies as FileNotFound (absence), not PathTraversal.
    #[test]
    fn test_resolve_read_missing_file_is_file_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        let err = resolve_read_path("does_not_exist.txt", ws).unwrap_err();
        assert!(
            matches!(err, RuntimeError::FileNotFound(_)),
            "expected FileNotFound for missing file, got {err}"
        );
    }

    #[test]
    fn test_resolve_read_missing_parent_is_file_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        let err = resolve_read_path("missing_dir/nested.txt", ws).unwrap_err();
        assert!(
            matches!(err, RuntimeError::FileNotFound(_)),
            "expected FileNotFound for missing parent dir, got {err}"
        );
    }

    // PLAN-0427 T1.3/B4: a symlink loop canonicalizes with ELOOP (not NotFound)
    // and must stay PathTraversal -> REST 403.
    #[cfg(unix)]
    #[test]
    fn test_resolve_read_symlink_loop_stays_path_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        std::os::unix::fs::symlink(dir.path().join("loop-b"), dir.path().join("loop-a")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("loop-a"), dir.path().join("loop-b")).unwrap();
        let err = resolve_read_path("loop-a", ws).unwrap_err();
        assert!(
            matches!(err, RuntimeError::PathTraversal { .. }),
            "expected PathTraversal for symlink loop (ELOOP), got {err}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn test_resolve_read_symlink_loop_stays_path_traversal_windows() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        std::os::windows::fs::symlink_file(dir.path().join("loop-b"), dir.path().join("loop-a"))
            .expect("create symlink loop a->b");
        std::os::windows::fs::symlink_file(dir.path().join("loop-a"), dir.path().join("loop-b"))
            .expect("create symlink loop b->a");
        let err = resolve_read_path("loop-a", ws).unwrap_err();
        assert!(
            matches!(err, RuntimeError::PathTraversal { .. }),
            "expected PathTraversal for symlink loop (ELOOP), got {err}"
        );
    }

    // ---- PLAN-0639 D39-5: per-root resolution (先定根、再解析) ----

    #[test]
    fn select_root_boundary_defaults_to_primary_root() {
        let boundary = select_root_boundary("H:/ws/primary", &[], None).unwrap();
        assert_eq!(boundary.root_id, None);
        assert_eq!(boundary.host_path, PathBuf::from("H:/ws/primary"));
    }

    #[test]
    fn select_root_boundary_picks_declared_root_not_primary() {
        let roots = vec![
            ("ws-1".to_string(), "H:/ws/primary".to_string()),
            ("root-b".to_string(), "H:/other/root-b".to_string()),
        ];
        let boundary = select_root_boundary("H:/ws/primary", &roots, Some("root-b")).unwrap();
        assert_eq!(boundary.root_id, Some("root-b".to_string()));
        assert_eq!(boundary.host_path, PathBuf::from("H:/other/root-b"));
    }

    #[test]
    fn select_root_boundary_rejects_unknown_root_id() {
        let roots = vec![("ws-1".to_string(), "H:/ws/primary".to_string())];
        let err = select_root_boundary("H:/ws/primary", &roots, Some("root-x")).unwrap_err();
        assert!(
            err.to_string().contains("unknown rootId"),
            "unknown rootId must fail closed, got {err}"
        );
    }

    #[test]
    fn select_root_boundary_rejects_blank_and_malformed_declarations() {
        let err = select_root_boundary("H:/ws/primary", &[], Some("   ")).unwrap_err();
        assert!(err.to_string().contains("blank"), "got {err}");
        let roots = vec![("r".to_string(), String::new())];
        let err = select_root_boundary("H:/ws/primary", &roots, Some("r")).unwrap_err();
        assert!(err.to_string().contains("empty hostPath"), "got {err}");
        let roots = vec![("r".to_string(), "relative/path".to_string())];
        let err = select_root_boundary("H:/ws/primary", &roots, Some("r")).unwrap_err();
        assert!(err.to_string().contains("not absolute"), "got {err}");
    }

    #[test]
    fn resolve_read_path_for_root_matches_legacy_default() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        fs::write(dir.path().join("bar.txt"), "data").unwrap();
        let legacy = resolve_read_path("bar.txt", ws).unwrap();
        let per_root = resolve_read_path_for_root("bar.txt", ws, None).unwrap();
        assert_eq!(
            legacy, per_root,
            "root_id = None must be byte-identical to the legacy shim"
        );
    }

    #[test]
    fn resolve_read_path_for_root_resolves_inside_declared_root() {
        let primary = tempfile::tempdir().unwrap();
        let declared = tempfile::tempdir().unwrap();
        fs::write(declared.path().join("in-root.txt"), "data").unwrap();
        let boundary = select_root_boundary(
            primary.path().to_str().unwrap(),
            &[
                (
                    "ws-1".to_string(),
                    primary.path().to_string_lossy().into_owned(),
                ),
                (
                    "root-b".to_string(),
                    declared.path().to_string_lossy().into_owned(),
                ),
            ],
            Some("root-b"),
        )
        .unwrap();
        let resolved = resolve_read_path_for_root(
            "in-root.txt",
            boundary.host_path.to_str().unwrap(),
            Some("root-b"),
        )
        .unwrap();
        assert!(
            windows_path_within(&resolved, &declared.path().canonicalize().unwrap()),
            "resolved path must stay inside the declared root, got {resolved:?}"
        );
    }

    #[test]
    fn resolve_read_path_for_root_rejects_lexical_escape_from_declared_root() {
        // base/outside.txt is a real file sitting NEXT TO the declared root.
        // Declared in root-b, the path "../outside.txt" must not reach it —
        // the lexical stage pins every resolution to its declared root (D39-5).
        let base = tempfile::tempdir().unwrap();
        let declared = base.path().join("declared");
        std::fs::create_dir_all(&declared).unwrap();
        fs::write(base.path().join("outside.txt"), "data").unwrap();
        let boundary = select_root_boundary(
            base.path().to_str().unwrap(),
            &[(
                "root-b".to_string(),
                declared.to_string_lossy().into_owned(),
            )],
            Some("root-b"),
        )
        .unwrap();
        let err = resolve_read_path_for_root(
            "../outside.txt",
            boundary.host_path.to_str().unwrap(),
            Some("root-b"),
        )
        .unwrap_err();
        assert!(
            matches!(err, RuntimeError::PathTraversal { .. }),
            "lexical escape out of the declared root must be PathTraversal, got {err}"
        );
    }

    #[test]
    fn resolve_read_path_for_root_rejects_blank_root_id() {
        let dir = tempfile::tempdir().unwrap();
        let err = resolve_read_path_for_root("x.txt", dir.path().to_str().unwrap(), Some("  "))
            .unwrap_err();
        assert!(err.to_string().contains("blank"), "got {err}");
    }

    // D39-5 #2/#3: a symlink inside the declared root that points into another
    // root canonicalizes outside the declared root → SymlinkEscape, same code
    // and meaning as the legacy single-root symlink escape.
    #[test]
    fn resolve_read_path_for_root_rejects_cross_root_symlink() {
        let primary = tempfile::tempdir().unwrap();
        let declared = tempfile::tempdir().unwrap();
        fs::write(primary.path().join("secret.txt"), "data").unwrap();
        let link_path = declared.path().join("link-to-primary");
        #[cfg(windows)]
        let sym_res = std::os::windows::fs::symlink_dir(primary.path(), &link_path);
        #[cfg(not(windows))]
        let sym_res = std::os::unix::fs::symlink(primary.path(), &link_path);
        if sym_res.is_err() {
            println!("symlink creation not permitted, skipping test: {sym_res:?}");
            return;
        }
        let boundary = select_root_boundary(
            primary.path().to_str().unwrap(),
            &[(
                "root-b".to_string(),
                declared.path().to_string_lossy().into_owned(),
            )],
            Some("root-b"),
        )
        .unwrap();
        let err = resolve_read_path_for_root(
            "link-to-primary/secret.txt",
            boundary.host_path.to_str().unwrap(),
            Some("root-b"),
        )
        .unwrap_err();
        assert!(
            matches!(err, RuntimeError::SymlinkEscape { .. }),
            "cross-root symlink must be SymlinkEscape, got {err}"
        );
        // The symlink target itself resolves fine under the primary-root
        // boundary: the boundary, not the path string, is what D39-5 pins down.
        let legacy =
            resolve_read_path_for_root("secret.txt", primary.path().to_str().unwrap(), None);
        assert!(
            legacy.is_ok(),
            "primary-root resolution of its own file must succeed: {legacy:?}"
        );
    }

    #[test]
    fn resolve_write_path_for_root_matches_legacy_default() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        let legacy = resolve_write_path("new_file.txt", ws).unwrap();
        let per_root = resolve_write_path_for_root("new_file.txt", ws, None).unwrap();
        assert_eq!(legacy, per_root);
    }

    fn minimal_pdf_with_text(text: &str) -> Vec<u8> {
        use std::io::Write as _;

        let stream = format!("BT /F1 12 Tf 72 720 Td ({text}) Tj ET\n");
        let mut stream_object = format!("<< /Length {} >>\nstream\n", stream.len()).into_bytes();
        stream_object.extend_from_slice(stream.as_bytes());
        stream_object.extend_from_slice(b"endstream");

        let objects = [
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".to_vec(),
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_vec(),
            stream_object,
        ];

        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = vec![0usize];
        for (index, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            writeln!(&mut pdf, "{} 0 obj", index + 1).unwrap();
            pdf.extend_from_slice(object);
            pdf.extend_from_slice(b"\nendobj\n");
        }

        let xref_offset = pdf.len();
        write!(&mut pdf, "xref\n0 {}\n0000000000 65535 f \n", offsets.len()).unwrap();
        for offset in offsets.iter().skip(1) {
            writeln!(&mut pdf, "{offset:010} 00000 n ").unwrap();
        }
        write!(
            &mut pdf,
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
            offsets.len()
        )
        .unwrap();
        pdf
    }

    #[tokio::test]
    async fn extract_pdf_text_reads_minimal_pdf_text() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();
        fs::write(
            dir.path().join("minimal.pdf"),
            minimal_pdf_with_text("XH_PDF_EXTRACT_OK"),
        )
        .unwrap();

        let text = extract_pdf_text("minimal.pdf", workspace).await.unwrap();
        assert!(
            text.contains("XH_PDF_EXTRACT_OK"),
            "unexpected PDF extraction output: {text:?}"
        );
    }

    // PLAN-292 T6: binary-safe read wired to the sandbox op and Gateway tool.
    #[tokio::test]
    async fn read_file_range_detects_binary_and_returns_base64() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        let payload: &[u8] = &[0x89, b'P', b'N', b'G', 0x00, 0xFF, b'd', b'a'];
        fs::write(dir.path().join("tiny.png"), payload).unwrap();

        let result = read_file_range("tiny.png", None, None, ws).await.unwrap();
        assert!(result.is_binary);
        assert_eq!(result.total_lines, 0);
        use base64::Engine as _;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&result.content)
            .unwrap();
        assert_eq!(decoded, payload);
    }

    #[tokio::test]
    async fn read_file_range_text_keeps_line_numbers() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        fs::write(dir.path().join("note.txt"), "alpha\nbeta\ngamma\n").unwrap();

        let result = read_file_range("note.txt", Some(2), Some(1), ws)
            .await
            .unwrap();
        assert!(!result.is_binary);
        assert_eq!(result.total_lines, 3);
        assert_eq!(result.content, "2 | beta");
    }

    // ---- task-77: filename search ----------------

    fn search_fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("alpha-report.md"), "a").unwrap();
        std::fs::write(dir.path().join("Beta-Report.TXT"), "b").unwrap();
        std::fs::write(dir.path().join("unrelated.log"), "c").unwrap();
        std::fs::create_dir(dir.path().join("nested")).unwrap();
        std::fs::write(dir.path().join("nested").join("report-2026.md"), "d").unwrap();
        std::fs::create_dir(dir.path().join("report-dir")).unwrap();
        dir
    }

    /// Substring match is case-insensitive and covers BOTH files and
    /// directories (`isDir` is what lets the UI render a folder hit).
    #[test]
    fn test_search_files_matches_names_case_insensitively() {
        let dir = search_fixture();
        let ws = dir.path().to_str().unwrap();
        let result = search_files("report", ".", ws, None).unwrap();
        assert!(!result.truncated);
        let mut names: Vec<&str> = result.items.iter().map(|i| i.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(
            names,
            vec![
                "Beta-Report.TXT",
                "alpha-report.md",
                "report-2026.md",
                "report-dir"
            ],
            "case-insensitive substring must hit files and directories alike"
        );
        let dir_hit = result
            .items
            .iter()
            .find(|i| i.name == "report-dir")
            .unwrap();
        assert!(dir_hit.is_dir, "a matching directory must be flagged isDir");
        let file_hit = result
            .items
            .iter()
            .find(|i| i.name == "alpha-report.md")
            .unwrap();
        assert!(!file_hit.is_dir);
    }

    /// A file inside an ignored area exists on disk but must NOT be returned —
    /// and the response must say which rule hid it. This is the exact scenario
    /// from the card: "file is there, search does not find it".
    #[test]
    fn test_search_files_skips_gitignored_area_and_names_the_rule() {
        let dir = search_fixture();
        std::fs::write(dir.path().join(".gitignore"), "ignored-area/\n").unwrap();
        std::fs::create_dir(dir.path().join("ignored-area")).unwrap();
        std::fs::write(
            dir.path().join("ignored-area").join("report-hidden.md"),
            "h",
        )
        .unwrap();

        // The file IS on disk:
        assert!(
            dir.path()
                .join("ignored-area")
                .join("report-hidden.md")
                .exists()
        );

        let ws = dir.path().to_str().unwrap();
        let result = search_files("report", ".", ws, None).unwrap();
        assert!(
            !result.items.iter().any(|i| i.name == "report-hidden.md"),
            "a gitignored file must not appear in results"
        );
        assert!(
            result.ignored_skipped > 0,
            "the ignore surface must be reported, not silent"
        );
        assert_eq!(
            result
                .ignored_rules
                .iter()
                .map(|r| r.pattern.as_str())
                .collect::<Vec<_>>(),
            vec!["ignored-area/"],
            "the response must name the rule that hid the file"
        );
    }

    /// Hitting the limit must be visible (`truncated`), never a silent prefix.
    #[test]
    fn test_search_files_reports_truncation() {
        let dir = tempfile::tempdir().unwrap();
        for n in 0..6 {
            std::fs::write(dir.path().join(format!("report-{n}.md")), "x").unwrap();
        }
        let ws = dir.path().to_str().unwrap();

        let capped = search_files("report", ".", ws, Some(3)).unwrap();
        assert_eq!(capped.items.len(), 3);
        assert!(
            capped.truncated,
            "limit reached must be reported as truncated"
        );

        let full = search_files("report", ".", ws, None).unwrap();
        assert_eq!(full.items.len(), 6);
        assert!(!full.truncated, "an uncapped search is not truncated");

        // A limit at or above the hit count is NOT truncation.
        let exact = search_files("report", ".", ws, Some(6)).unwrap();
        assert_eq!(exact.items.len(), 6);
        assert!(!exact.truncated, "reaching the last hit is not truncation");
    }

    /// `scannedFiles` / `elapsedMs` are the work actually done: a truncated fast
    /// answer must not look like a full scan.
    #[test]
    fn test_search_files_reports_scan_cost() {
        let dir = search_fixture();
        let ws = dir.path().to_str().unwrap();
        let result = search_files("unrelated", ".", ws, None).unwrap();
        assert_eq!(result.items.len(), 1);
        assert!(
            result.scanned_files >= result.items.len(),
            "scannedFiles counts entries visited, not hits"
        );
    }

    /// Search must reject a non-directory start path instead of silently
    /// returning an empty list (which would read as "no such file").
    #[test]
    fn test_search_files_rejects_non_directory_root() {
        let dir = search_fixture();
        let ws = dir.path().to_str().unwrap();
        let err = search_files("report", "alpha-report.md", ws, None).unwrap_err();
        assert!(
            matches!(err, RuntimeError::InvalidPath(_)),
            "expected InvalidPath, got {err}"
        );
    }

    /// Zero-match is an empty list plus an intact ignore surface — not an error
    /// and not an `ignoredSkipped` that pretends to explain a miss.
    #[test]
    fn test_search_files_empty_query_result_is_not_an_error() {
        let dir = search_fixture();
        let ws = dir.path().to_str().unwrap();
        let result = search_files("zzz-no-such-name", ".", ws, None).unwrap();
        assert!(result.items.is_empty());
        assert!(!result.truncated);
        assert_eq!(
            result.ignored_skipped, 0,
            "no .gitignore here means nothing is skipped"
        );
        assert!(result.ignored_rules.is_empty());
    }

    /// task-77 guard: `glob_files` semantics must stay byte-identical — the card
    /// forbids turning it into a search function.
    #[test]
    fn test_glob_files_semantics_unchanged_by_search_feature() {
        let dir = search_fixture();
        let ws = dir.path().to_str().unwrap();
        let matches = glob_files("*.md", ".", ws).unwrap();
        // `glob_files` returns host-separated relative paths, so on Windows the
        // separator is a backslash: split on both or the "basename" silently
        // stays the whole path and this guard asserts the wrong thing.
        let mut names: Vec<String> = matches
            .iter()
            .filter_map(|p| p.rsplit(['/', '\\']).next().map(|n| n.to_string()))
            .collect();
        names.sort();
        assert_eq!(names, vec!["alpha-report.md", "report-2026.md"]);
    }

    #[test]
    fn test_resolve_path_accepts_subdir() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub/file.md"), "data").unwrap();
        let result = resolve_read_path("sub/file.md", ws).unwrap();
        assert_eq!(
            result,
            fs::canonicalize(dir.path().join("sub/file.md")).unwrap()
        );
    }

    #[test]
    fn test_resolve_write_path_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();

        let result = resolve_write_path("new_file.txt", ws).unwrap();
        assert_eq!(result, dir.path().join("new_file.txt"));
    }

    #[test]
    fn test_resolve_write_path_nested_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();

        fs::create_dir(dir.path().join("existing")).unwrap();

        let result = resolve_write_path("existing/new_file.txt", ws).unwrap();
        assert_eq!(result, dir.path().join("existing/new_file.txt"));
    }

    #[test]
    fn test_resolve_write_path_traversal_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();

        let err = resolve_write_path("../outside", ws).unwrap_err();
        assert!(matches!(err, RuntimeError::PathTraversal { .. }));

        let err = resolve_write_path("foo/../../../outside", ws).unwrap_err();
        assert!(matches!(err, RuntimeError::PathTraversal { .. }));
    }

    #[cfg(unix)]
    #[test]
    fn test_symlink_escape_rejected() {
        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("/etc", dir.path().join("link-to-etc")).unwrap();

        let ws = dir.path().to_str().unwrap();
        let err = resolve_read_path("link-to-etc/shadow", ws).unwrap_err();
        assert!(
            matches!(err, RuntimeError::SymlinkEscape { .. }),
            "expected SymlinkEscape, got {err}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_symlink_to_other_workspace_rejected() {
        let ws1 = tempfile::tempdir().unwrap();
        let ws2 = tempfile::tempdir().unwrap();
        fs::write(ws2.path().join("secret.txt"), "data").unwrap();

        std::os::unix::fs::symlink(ws2.path(), ws1.path().join("link-to-ws2")).unwrap();

        let ws = ws1.path().to_str().unwrap();
        let err = resolve_read_path("link-to-ws2/secret.txt", ws).unwrap_err();
        assert!(matches!(err, RuntimeError::SymlinkEscape { .. }));
    }

    #[cfg(unix)]
    #[test]
    fn test_symlink_chain_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret"), "data").unwrap();

        std::os::unix::fs::symlink(outside.path(), dir.path().join("a")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("a"), dir.path().join("b")).unwrap();

        let ws = dir.path().to_str().unwrap();
        let err = resolve_read_path("b/secret", ws).unwrap_err();
        assert!(matches!(err, RuntimeError::SymlinkEscape { .. }));
    }

    #[cfg(unix)]
    #[test]
    fn test_write_path_parent_symlink_escape_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escape")).unwrap();

        let ws = dir.path().to_str().unwrap();
        let err = resolve_write_path("escape/newfile.txt", ws).unwrap_err();
        assert!(matches!(err, RuntimeError::SymlinkEscape { .. }));
    }

    #[test]
    fn test_write_path_ancestor_outside_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();

        let err = resolve_write_path("../outside/file.txt", ws).unwrap_err();
        assert!(matches!(err, RuntimeError::PathTraversal { .. }));
    }

    #[test]
    fn test_read_file() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        fs::write(dir.path().join("hello.txt"), "Hello, World!").unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let content = rt.block_on(read_file("hello.txt", ws)).unwrap();
        assert_eq!(content, "Hello, World!");
    }

    #[test]
    fn test_read_file_absolute_rejected() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        let result = rt.block_on(read_file("/etc/passwd", ws));
        assert!(result.is_err());
    }

    #[test]
    fn test_write_file() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt
            .block_on(write_file("newfile.txt", "test content", ws))
            .unwrap();
        assert!(result.contains("Written"));
        assert!(result.contains("newfile.txt"));

        let content = fs::read_to_string(dir.path().join("newfile.txt")).unwrap();
        assert_eq!(content, "test content");
    }

    #[test]
    fn test_write_file_creates_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(write_file("sub/dir/file.txt", "nested content", ws))
            .unwrap();

        let content = fs::read_to_string(dir.path().join("sub/dir/file.txt")).unwrap();
        assert_eq!(content, "nested content");
    }

    #[test]
    fn test_write_file_traversal_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(write_file("../outside.txt", "data", ws));
        assert!(result.is_err());
    }

    #[test]
    fn test_list_directory() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), "aaa").unwrap();
        fs::write(dir.path().join("b.txt"), "bbb").unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();

        let ws = dir.path().to_str().unwrap();
        let entries = list_directory(".", ws).unwrap();

        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"a.txt"));
        assert!(names.contains(&"b.txt"));
        assert!(names.contains(&"sub"));
        assert_eq!(entries.len(), 3);
    }

    #[test]
    fn test_list_directory_not_a_dir() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        fs::write(dir.path().join("file.txt"), "x").unwrap();

        let result = list_directory("file.txt", ws);
        assert!(result.is_err());
    }

    #[test]
    fn test_glob_pattern() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("readme.md"), "").unwrap();
        fs::write(dir.path().join("main.rs"), "").unwrap();
        fs::write(dir.path().join("lib.rs"), "").unwrap();
        fs::write(dir.path().join("Cargo.toml"), "").unwrap();

        let ws = dir.path().to_str().unwrap();
        let matches = glob_files("*.rs", ".", ws).unwrap();

        assert!(matches.contains(&"main.rs".to_string()));
        assert!(matches.contains(&"lib.rs".to_string()));
        assert!(!matches.contains(&"readme.md".to_string()));
        assert!(!matches.contains(&"Cargo.toml".to_string()));
    }

    #[test]
    fn test_grep_content() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("app.rs"),
            "fn main() {\n    println!(\"Hello\");\n}\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("lib.rs"),
            "pub fn greet() {\n    // noop\n}\n",
        )
        .unwrap();

        let ws = dir.path().to_str().unwrap();
        let results = grep_files("fn ", ".", ws).unwrap();

        assert_eq!(results.len(), 2);
        assert!(results.iter().any(|r| r.file == "app.rs"));
        assert!(results.iter().any(|r| r.file == "lib.rs"));
        assert!(results.iter().all(|r| r.content.contains("fn")));
    }

    #[test]
    fn test_grep_match_line_numbers() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("test.txt"),
            "first line\nsecond line\nthird line\n",
        )
        .unwrap();

        let ws = dir.path().to_str().unwrap();
        let results = grep_files("second", ".", ws).unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].line, 2);
        assert_eq!(results[0].content, "second line");
    }

    #[test]
    fn test_get_file_info() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("info.txt");
        fs::write(&file_path, "metadata test").unwrap();

        let ws = dir.path().to_str().unwrap();
        let info = get_file_info("info.txt", ws).unwrap();

        assert_eq!(info.name, "info.txt");
        assert!(!info.is_dir);
        assert!(!info.is_symlink);
        assert!(info.size > 0);
        assert!(!info.modified.is_empty());
    }

    #[test]
    fn test_get_file_info_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        let result = get_file_info("nonexistent.txt", ws);
        assert!(result.is_err());
    }

    #[test]
    fn test_edit_file_single_replace() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("test.txt"), "hello world").unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt
            .block_on(edit_file("test.txt", "world", "rust", false, ws))
            .unwrap();
        assert!(result.success);
        assert_eq!(result.replacements, 1);

        let content = std::fs::read_to_string(dir.path().join("test.txt")).unwrap();
        assert_eq!(content, "hello rust");
    }

    #[test]
    fn test_edit_file_no_match_error() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("test.txt"), "hello world").unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = rt
            .block_on(edit_file("test.txt", "zzz", "rust", false, ws))
            .unwrap_err();
        assert!(matches!(err, RuntimeError::FileNotFound(_)));
    }

    #[test]
    fn test_edit_file_multiple_requires_replace_all() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("test.txt"), "a a a").unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = rt
            .block_on(edit_file("test.txt", "a", "b", false, ws))
            .unwrap_err();
        assert!(matches!(err, RuntimeError::InvalidPath(_)));
    }

    #[test]
    fn test_edit_file_replace_all() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("test.txt"), "a a a").unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt
            .block_on(edit_file("test.txt", "a", "b", true, ws))
            .unwrap();
        assert!(result.success);
        assert_eq!(result.replacements, 3);

        let content = std::fs::read_to_string(dir.path().join("test.txt")).unwrap();
        assert_eq!(content, "b b b");
    }

    #[test]
    fn test_delete_file() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("del.txt"), "data").unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(delete_file("del.txt", ws)).unwrap();
        assert!(result.contains("Deleted"));
        assert!(!dir.path().join("del.txt").exists());
    }

    #[test]
    fn test_delete_file_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = rt.block_on(delete_file("nonexistent.txt", ws)).unwrap_err();
        assert!(matches!(err, RuntimeError::FileNotFound(_)));
    }

    #[test]
    fn test_delete_file_traversal_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = rt.block_on(delete_file("../outside.txt", ws)).unwrap_err();
        assert!(matches!(err, RuntimeError::PathTraversal { .. }));
    }

    #[test]
    fn test_delete_directory_empty() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        std::fs::create_dir(dir.path().join("emptydir")).unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt
            .block_on(delete_directory("emptydir", false, ws))
            .unwrap();
        assert!(result.contains("Deleted"));
    }

    #[test]
    fn test_delete_directory_recursive() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        std::fs::create_dir_all(dir.path().join("parent/sub")).unwrap();
        std::fs::write(dir.path().join("parent/sub/file.txt"), "data").unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt
            .block_on(delete_directory("parent/sub", true, ws))
            .unwrap();
        assert!(result.contains("Deleted"));
    }

    #[test]
    fn test_delete_directory_nonrecursive_rejects_nonempty() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        std::fs::create_dir(dir.path().join("mydir")).unwrap();
        std::fs::write(dir.path().join("mydir/file.txt"), "data").unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = rt
            .block_on(delete_directory("mydir", false, ws))
            .unwrap_err();
        assert!(matches!(err, RuntimeError::Io(_)));
    }

    #[test]
    fn test_move_file() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("src.txt"), "move me").unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(move_file("src.txt", "dst.txt", ws)).unwrap();
        assert!(result.contains("Moved"));
        assert!(!dir.path().join("src.txt").exists());
        assert!(dir.path().join("dst.txt").exists());
    }

    #[test]
    fn test_copy_file() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("original.txt"), "copy me").unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt
            .block_on(copy_file("original.txt", "copy.txt", ws))
            .unwrap();
        assert!(result.contains("Copied"));
        assert!(dir.path().join("original.txt").exists());
        assert!(dir.path().join("copy.txt").exists());
    }

    #[test]
    fn test_mkdir() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(mkdir("newdir", ws)).unwrap();
        assert!(result.contains("Created"));
        assert!(dir.path().join("newdir").is_dir());
    }

    #[test]
    fn test_mkdir_recursive() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(mkdir("a/b/c", ws)).unwrap();
        assert!(result.contains("Created"));
        assert!(dir.path().join("a/b/c").is_dir());
    }

    #[test]
    fn test_mkdir_traversal_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = rt.block_on(mkdir("../outside", ws)).unwrap_err();
        assert!(matches!(err, RuntimeError::PathTraversal { .. }));
    }

    #[test]
    fn test_file_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();

        // Write
        rt.block_on(write_file("life.txt", "hello world", ws))
            .unwrap();
        assert!(dir.path().join("life.txt").exists());

        // Edit
        let result = rt
            .block_on(edit_file("life.txt", "world", "rust", false, ws))
            .unwrap();
        assert_eq!(result.replacements, 1);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("life.txt")).unwrap(),
            "hello rust"
        );

        // Copy
        rt.block_on(copy_file("life.txt", "life_copy.txt", ws))
            .unwrap();
        assert!(dir.path().join("life_copy.txt").exists());

        // Move
        rt.block_on(move_file("life_copy.txt", "life_moved.txt", ws))
            .unwrap();
        assert!(!dir.path().join("life_copy.txt").exists());
        assert!(dir.path().join("life_moved.txt").exists());

        // Delete
        rt.block_on(delete_file("life.txt", ws)).unwrap();
        assert!(!dir.path().join("life.txt").exists());
    }

    #[test]
    fn test_read_file_range() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        let content = (1..=100)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(dir.path().join("range.txt"), &content).unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt
            .block_on(read_file_range("range.txt", Some(5), Some(3), ws))
            .unwrap();
        assert!(!result.is_binary);
        assert_eq!(result.total_lines, 100);
        assert_eq!(result.content, "5 | line 5\n6 | line 6\n7 | line 7");
    }

    #[test]
    fn test_read_file_range_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        let content = "line a\nline b\nline c";
        std::fs::write(dir.path().join("defaults.txt"), content).unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt
            .block_on(read_file_range("defaults.txt", None, None, ws))
            .unwrap();
        assert_eq!(result.total_lines, 3);
        assert!(result.content.contains("1 | line a"));
        assert!(result.content.contains("3 | line c"));
    }

    #[test]
    fn test_read_file_range_binary() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        let bin: Vec<u8> = vec![0x00, 0x01, 0x02, 0xFF];
        std::fs::write(dir.path().join("binary.bin"), &bin).unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt
            .block_on(read_file_range("binary.bin", None, None, ws))
            .unwrap();
        assert!(result.is_binary);
        assert!(result.content.len() > 4);
    }

    #[test]
    fn test_read_file_range_offset_overflow() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("short.txt"), "only one line").unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt
            .block_on(read_file_range("short.txt", Some(999), Some(10), ws))
            .unwrap();
        assert_eq!(result.content, ""); // offset past end → empty
        assert_eq!(result.total_lines, 1);
    }

    #[test]
    fn test_read_file_range_traversal_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = rt
            .block_on(read_file_range("../outside.txt", None, None, ws))
            .unwrap_err();
        assert!(matches!(err, RuntimeError::PathTraversal { .. }));
    }

    #[test]
    fn test_strip_workspace() {
        let stripped = strip_workspace(Path::new("/ws/foo/bar"), "/ws");
        assert_eq!(stripped, Path::new("foo/bar"));
    }

    #[test]
    fn test_strip_workspace_outside() {
        let stripped = strip_workspace(Path::new("/other/file"), "/ws");
        assert_eq!(stripped, Path::new("/other/file"));
    }
}
