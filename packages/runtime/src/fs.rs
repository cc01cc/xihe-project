use std::path::{Component, Path, PathBuf};

use chrono::{DateTime, Utc};
use globset::Glob;
use ignore::Walk;
use notify::Watcher;
use regex::Regex;
use rmcp::schemars;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use walkdir::WalkDir;

// PDF text extraction
use pdf_extract;

// Base64 encoding for binary files
use base64::Engine;

use crate::error::{Result, RuntimeError};

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

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GrepResults {
    pub matches: Vec<MatchResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct FileEventList {
    pub events: Vec<FileEvent>,
}

/// Stage 1: Lexical validation — no filesystem access.
/// Rejects absolute paths, resolves `.` and `..` lexically,
/// and ensures the normalized path stays within the workspace root.
fn lexically_safe(path: &str, workspace: &Path) -> Result<PathBuf> {
    if Path::new(path).is_absolute() {
        return Err(RuntimeError::PathTraversal { path: path.to_string() });
    }

    let joined = workspace.join(path);

    let normalized: PathBuf = joined
        .components()
        .fold(PathBuf::new(), |mut acc, c| {
            match c {
                Component::ParentDir => { acc.pop(); }
                Component::CurDir => {}
                other => acc.push(other.as_os_str()),
            }
            acc
        });

    if !normalized.starts_with(workspace) {
        return Err(RuntimeError::PathTraversal { path: path.to_string() });
    }

    Ok(normalized)
}

/// Stage 2: Filesystem validation — canonicalize resolves symlinks,
/// then check the real path still lies within the workspace root.
fn resolve_canonical(path: &Path, workspace: &Path) -> Result<PathBuf> {
    let canonical = path
        .canonicalize()
        .map_err(|_| RuntimeError::PathTraversal {
            path: path.to_string_lossy().to_string(),
        })?;

    let ws_canonical = workspace.canonicalize().map_err(|_| {
        RuntimeError::WorkspaceNotFound(workspace.to_string_lossy().to_string())
    })?;

    if !canonical.starts_with(&ws_canonical) {
        return Err(RuntimeError::SymlinkEscape {
            path: path.to_string_lossy().to_string(),
            resolved: canonical.to_string_lossy().to_string(),
        });
    }

    Ok(canonical)
}

/// Resolve a path for read operations.
/// Two-stage check: lexical ⇒ filesystem (canonicalize).
pub fn resolve_read_path(path: &str, workspace: &str) -> Result<PathBuf> {
    let ws = Path::new(workspace);
    let normalized = lexically_safe(path, ws)?;
    resolve_canonical(&normalized, ws)
}

/// Resolve a path for write operations.
/// Since the target file may not exist yet, we canonicalize the first existing
/// ancestor directory instead, then re-check the ancestor lies within workspace.
pub fn resolve_write_path(path: &str, workspace: &str) -> Result<PathBuf> {
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

pub fn strip_workspace<'a>(full_path: &'a Path, workspace: &str) -> &'a Path {
    full_path.strip_prefix(workspace).unwrap_or(full_path)
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
    writer.write_all(buf.as_bytes()).await.map_err(|e| {
        RuntimeError::InvalidPath(format!("file service write: {e}"))
    })?;
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
        return Err(RuntimeError::InvalidPath("empty response from file service".into()));
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
        return Err(RuntimeError::InvalidPath("old_string cannot be empty".into()));
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

    // Use resolve_write_path for the write, but pass through the resolved full path
    // to ensure it's within workspace
    let _ = resolve_write_path(file_path, workspace)?;
    tokio::fs::write(&full_path, &new_content).await?;

    Ok(EditFileResult {
        success: true,
        replacements: replacement_count,
        message: format!(
            "Replaced {replacement_count} occurrence(s) in {file_path}"
        ),
    })
}

pub async fn delete_file(path: &str, workspace: &str) -> Result<String> {
    let socket = file_socket_path(workspace);
    if socket.exists() {
        call_file_service(&socket, "rm", path, None).await?;
        return Ok(format!("Deleted file: {path}"));
    }
    let full_path = resolve_write_path(path, workspace)?;
    if !full_path.exists() {
        return Err(RuntimeError::FileNotFound(format!("File not found: {path}")));
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
        return Ok(format!("Deleted directory{}: {}", if recursive { " (recursive)" } else { "" }, path));
    }
    let full_path = resolve_write_path(path, workspace)?;
    if !full_path.exists() {
        return Err(RuntimeError::FileNotFound(format!("Directory not found: {path}")));
    }
    if !full_path.is_dir() {
        return Err(RuntimeError::InvalidPath(format!("Not a directory: {path}")));
    }
    if full_path == Path::new(workspace) {
        return Err(RuntimeError::InvalidPath("Cannot delete workspace root".into()));
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
    let src = resolve_write_path(from, workspace)?;
    let dst = resolve_write_path(to, workspace)?;
    if !src.exists() {
        return Err(RuntimeError::FileNotFound(format!("Source not found: {from}")));
    }
    if let Some(parent) = dst.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::rename(&src, &dst).await?;
    Ok(format!("Moved {from} to {to}"))
}

pub async fn copy_file(from: &str, to: &str, workspace: &str) -> Result<String> {
    let src = resolve_read_path(from, workspace)?;
    let dst = resolve_write_path(to, workspace)?;
    if !src.exists() {
        return Err(RuntimeError::FileNotFound(format!("Source not found: {from}")));
    }
    if let Some(parent) = dst.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::copy(&src, &dst).await?;
    Ok(format!("Copied {from} to {to}"))
}

pub async fn mkdir(path: &str, workspace: &str) -> Result<String> {
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
        return Err(RuntimeError::InvalidPath(format!("Not a directory: {path}")));
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
        .map(|e| strip_workspace(e.path(), &ws_str).to_string_lossy().to_string())
        .collect();

    Ok(matches)
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
        // resolve_read_path requires the path to exist (canonicalize).
        // For pure lexical tests, use lexically_safe directly.
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        fs::write(dir.path().join("bar.txt"), "data").unwrap();
        let result = resolve_read_path("bar.txt", ws).unwrap();
        assert_eq!(result, dir.path().join("bar.txt"));
    }

    #[test]
    fn test_resolve_path_accepts_subdir() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub/file.md"), "data").unwrap();
        let result = resolve_read_path("sub/file.md", ws).unwrap();
        assert_eq!(result, dir.path().join("sub/file.md"));
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
        let content = rt
            .block_on(read_file("hello.txt", ws))
            .unwrap();
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
        let err = rt
            .block_on(delete_file("nonexistent.txt", ws))
            .unwrap_err();
        assert!(matches!(err, RuntimeError::FileNotFound(_)));
    }

    #[test]
    fn test_delete_file_traversal_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = rt
            .block_on(delete_file("../outside.txt", ws))
            .unwrap_err();
        assert!(matches!(err, RuntimeError::PathTraversal { .. }));
    }

    #[test]
    fn test_delete_directory_empty() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        std::fs::create_dir(dir.path().join("emptydir")).unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(delete_directory("emptydir", false, ws)).unwrap();
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
        rt.block_on(write_file("life.txt", "hello world", ws)).unwrap();
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
        rt.block_on(copy_file("life.txt", "life_copy.txt", ws)).unwrap();
        assert!(dir.path().join("life_copy.txt").exists());

        // Move
        rt.block_on(move_file("life_copy.txt", "life_moved.txt", ws)).unwrap();
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
        let content = (1..=100).map(|i| format!("line {}", i)).collect::<Vec<_>>().join("\n");
        std::fs::write(dir.path().join("range.txt"), &content).unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(read_file_range("range.txt", Some(5), Some(3), ws)).unwrap();
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
        let result = rt.block_on(read_file_range("defaults.txt", None, None, ws)).unwrap();
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
        let result = rt.block_on(read_file_range("binary.bin", None, None, ws)).unwrap();
        assert!(result.is_binary);
        assert!(result.content.len() > 4);
    }

    #[test]
    fn test_read_file_range_offset_overflow() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("short.txt"), "only one line").unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(read_file_range("short.txt", Some(999), Some(10), ws)).unwrap();
        assert_eq!(result.content, ""); // offset past end → empty
        assert_eq!(result.total_lines, 1);
    }

    #[test]
    fn test_read_file_range_traversal_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_str().unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = rt.block_on(read_file_range("../outside.txt", None, None, ws)).unwrap_err();
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
