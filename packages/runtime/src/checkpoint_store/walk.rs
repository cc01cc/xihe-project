//! Workspace walker for checkpoint capture (`FORMAT.md` §2/§4, PLAN-0653 T1.6).
//!
//! The walker is intentionally separate from the legacy shadow-git capture:
//! capture consumes `WalkEntry` values and later hashes them into store blobs.
//! It reproduces the frozen exclusion semantics (`STATIC_EXCLUDE_PATTERNS` plus
//! in-tree `.gitignore`, including negation), never descends into `.git` or a
//! directory reparse point/junction, and reports per-path failures instead of
//! silently returning a partial list.

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use ignore::WalkBuilder;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use serde::Serialize;

use super::blob::MAX_BLOB_RAW_BYTES;
use super::manifest::FileMode;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum WalkEntryKind {
    File,
    Symlink,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WalkEntry {
    /// Workspace-relative, forward-slash path.
    pub path: String,
    pub absolute_path: PathBuf,
    pub kind: WalkEntryKind,
    pub mode: FileMode,
    pub size: u64,
    /// File mtime in nanoseconds since the Unix epoch (0 for symlinks).
    pub mtime_ns: u64,
    /// Present for `Symlink` entries (file symlinks and directory junctions).
    pub symlink_target: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum WalkIssueKind {
    PermissionDenied,
    Vanished,
    TooLarge,
    NonUtf8,
    ReparseUnreadable,
    WalkError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WalkIssue {
    pub path: Option<String>,
    pub kind: WalkIssueKind,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WalkOutcome {
    pub entries: Vec<WalkEntry>,
    pub issues: Vec<WalkIssue>,
}

#[derive(Debug, thiserror::Error)]
pub enum WalkError {
    #[error("workspace root does not exist: {path:?}")]
    RootMissing { path: PathBuf },
    #[error("workspace root is not a directory: {path:?}")]
    RootNotDir { path: PathBuf },
    #[error("workspace root cannot be canonicalized at {path:?}: {source}")]
    RootIo {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to build static exclude matcher: {reason}")]
    ExcludeMatcher { reason: String },
}

fn relative_utf8(path: &Path, root: &Path) -> Result<String, WalkIssue> {
    let relative = path.strip_prefix(root).map_err(|_| WalkIssue {
        path: Some(path.display().to_string()),
        kind: WalkIssueKind::WalkError,
        message: "walked path is outside the workspace root".into(),
    })?;
    let text = relative.to_str().ok_or_else(|| WalkIssue {
        path: Some(relative.to_string_lossy().into_owned()),
        kind: WalkIssueKind::NonUtf8,
        message: "non-UTF-8 path skipped".into(),
    })?;
    Ok(text.replace('\\', "/"))
}

fn issue_for_io(path: Option<&Path>, source: &std::io::Error) -> WalkIssue {
    let kind = match source.kind() {
        std::io::ErrorKind::PermissionDenied => WalkIssueKind::PermissionDenied,
        std::io::ErrorKind::NotFound => WalkIssueKind::Vanished,
        _ => WalkIssueKind::WalkError,
    };
    WalkIssue {
        path: path.map(|path| path.display().to_string()),
        kind,
        message: source.to_string(),
    }
}

fn first_ignore_error_path(error: &ignore::Error) -> Option<&Path> {
    match error {
        ignore::Error::WithPath { path, .. } => Some(path),
        ignore::Error::WithLineNumber { err, .. } | ignore::Error::WithDepth { err, .. } => {
            first_ignore_error_path(err)
        }
        ignore::Error::Partial(errors) => errors.iter().find_map(first_ignore_error_path),
        _ => None,
    }
}

fn issue_path(path: &Path, root: &Path) -> String {
    relative_utf8(path, root).unwrap_or_else(|_| path.display().to_string())
}

fn ignore_error_issue(error: &ignore::Error, root: &Path) -> WalkIssue {
    let path = first_ignore_error_path(error);
    let relative = path.map(|path| issue_path(path, root));
    match error.io_error() {
        Some(source) => WalkIssue {
            path: relative,
            kind: match source.kind() {
                std::io::ErrorKind::PermissionDenied => WalkIssueKind::PermissionDenied,
                std::io::ErrorKind::NotFound => WalkIssueKind::Vanished,
                _ => WalkIssueKind::WalkError,
            },
            message: source.to_string(),
        },
        None => WalkIssue {
            path: relative,
            kind: WalkIssueKind::WalkError,
            message: error.to_string(),
        },
    }
}

/// Windows reparse points include junctions and both file/directory symlinks.
/// Treat every reparse point as a symlink entry and never descend into it.
#[cfg(windows)]
fn is_reparse_point(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn is_reparse_point(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
}

fn file_mode(_metadata: &fs::Metadata) -> FileMode {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if _metadata.permissions().mode() & 0o111 != 0 {
            return FileMode::Executable;
        }
    }
    FileMode::Regular
}

fn symlink_entry(path: &Path, root: &Path) -> Result<WalkEntry, WalkIssue> {
    let relative = relative_utf8(path, root)?;
    let target = fs::read_link(path).map_err(|source| WalkIssue {
        path: Some(relative.clone()),
        kind: WalkIssueKind::ReparseUnreadable,
        message: source.to_string(),
    })?;
    let target = target.to_string_lossy().replace('\\', "/");
    Ok(WalkEntry {
        path: relative,
        absolute_path: path.to_path_buf(),
        kind: WalkEntryKind::Symlink,
        mode: FileMode::Symlink,
        size: target.len() as u64,
        mtime_ns: 0,
        symlink_target: Some(target),
    })
}

fn static_exclude_matcher(root: &Path) -> Result<Gitignore, WalkError> {
    let mut builder = GitignoreBuilder::new(root);
    for pattern in crate::checkpoint::STATIC_EXCLUDE_PATTERNS {
        builder
            .add_line(None, pattern)
            .map_err(|error| WalkError::ExcludeMatcher {
                reason: error.to_string(),
            })?;
    }
    builder.build().map_err(|error| WalkError::ExcludeMatcher {
        reason: error.to_string(),
    })
}

/// Walk `root` and return files/symlinks plus per-path issues. The root is
/// canonicalized first so Windows long paths use the `\\?\` form throughout.
pub fn walk_workspace(root: &Path) -> Result<WalkOutcome, WalkError> {
    walk_workspace_with_hook(root, |_| {})
}

fn walk_workspace_with_hook<H>(root: &Path, hook: H) -> Result<WalkOutcome, WalkError>
where
    H: Fn(&Path) + Send + Sync + 'static,
{
    let root = fs::canonicalize(root).map_err(|source| {
        if source.kind() == std::io::ErrorKind::NotFound {
            WalkError::RootMissing {
                path: root.to_path_buf(),
            }
        } else {
            WalkError::RootIo {
                path: root.to_path_buf(),
                source,
            }
        }
    })?;
    if !root.is_dir() {
        return Err(WalkError::RootNotDir { path: root });
    }

    let matcher = Arc::new(static_exclude_matcher(&root)?);
    let entries = Arc::new(Mutex::new(Vec::new()));
    let issues = Arc::new(Mutex::new(Vec::new()));

    let root_for_filter = root.clone();
    let entries_for_filter = Arc::clone(&entries);
    let issues_for_filter = Arc::clone(&issues);
    let matcher_for_filter = Arc::clone(&matcher);
    let hook = Arc::new(hook);
    let hook_for_filter = Arc::clone(&hook);
    let mut builder = WalkBuilder::new(&root);
    builder
        .hidden(false)
        .follow_links(false)
        .parents(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(false)
        .ignore(false)
        .require_git(false);
    builder.filter_entry(move |entry| {
        // T1.6 test hook: lets the mid-walk-deletion test remove a sibling
        // after the first entry is observed. Production passes a no-op.
        hook_for_filter(entry.path());
        if entry.depth() == 0 {
            return true;
        }
        if entry.file_name() == OsStr::new(".git") {
            return false;
        }
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        let Ok(relative) = entry.path().strip_prefix(&root_for_filter) else {
            return false;
        };
        if matcher_for_filter
            .matched_path_or_any_parents(relative, is_dir)
            .is_ignore()
        {
            return false;
        }
        if is_reparse_point(entry.path())
            || entry
                .file_type()
                .map(|kind| kind.is_symlink())
                .unwrap_or(false)
        {
            match symlink_entry(entry.path(), &root_for_filter) {
                Ok(entry) => entries_for_filter
                    .lock()
                    .expect("walker entries mutex")
                    .push(entry),
                Err(issue) => issues_for_filter
                    .lock()
                    .expect("walker issues mutex")
                    .push(issue),
            }
            return false;
        }
        true
    });

    for result in builder.build() {
        let entry = match result {
            Ok(entry) => entry,
            Err(error) => {
                issues
                    .lock()
                    .expect("walker issues mutex")
                    .push(ignore_error_issue(&error, &root));
                continue;
            }
        };
        if entry.depth() == 0 {
            continue;
        }
        let file_type = match entry.file_type() {
            Some(file_type) => file_type,
            None => continue,
        };
        if file_type.is_dir() {
            continue;
        }
        let path = entry.path();
        let relative = match relative_utf8(path, &root) {
            Ok(relative) => relative,
            Err(issue) => {
                issues.lock().expect("walker issues mutex").push(issue);
                continue;
            }
        };
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(source) => {
                let mut issue = issue_for_io(Some(path), &source);
                issue.path = Some(relative.clone());
                issues.lock().expect("walker issues mutex").push(issue);
                continue;
            }
        };
        if metadata.file_type().is_symlink() || is_reparse_point(path) {
            match symlink_entry(path, &root) {
                Ok(entry) => entries.lock().expect("walker entries mutex").push(entry),
                Err(issue) => issues.lock().expect("walker issues mutex").push(issue),
            }
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        if metadata.len() > MAX_BLOB_RAW_BYTES {
            issues.lock().expect("walker issues mutex").push(WalkIssue {
                path: Some(relative),
                kind: WalkIssueKind::TooLarge,
                message: format!(
                    "file is {} bytes, above the {} byte blob limit",
                    metadata.len(),
                    MAX_BLOB_RAW_BYTES
                ),
            });
            continue;
        }
        entries
            .lock()
            .expect("walker entries mutex")
            .push(WalkEntry {
                path: relative,
                absolute_path: path.to_path_buf(),
                kind: WalkEntryKind::File,
                mode: file_mode(&metadata),
                size: metadata.len(),
                mtime_ns: metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_nanos() as u64)
                    .unwrap_or(0),
                symlink_target: None,
            });
    }

    let mut result = WalkOutcome {
        entries: entries.lock().expect("walker entries mutex").clone(),
        issues: issues.lock().expect("walker issues mutex").clone(),
    };
    result
        .entries
        .sort_by(|left, right| left.path.as_bytes().cmp(right.path.as_bytes()));
    result
        .issues
        .sort_by(|left, right| left.path.cmp(&right.path));
    Ok(result)
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    fn write_file(root: &Path, relative: &str, content: &[u8]) {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("fixture parent");
        }
        let mut file = fs::File::create(path).expect("fixture file");
        file.write_all(content).expect("fixture content");
    }

    #[test]
    fn walker_uses_the_frozen_static_excludes() {
        let expected: &[&str] = &[
            "*.pem",
            "*.key",
            "*.p12",
            ".npmrc",
            ".netrc",
            "id_rsa*",
            "node_modules/",
            "dist/",
            "build/",
            ".cache/",
            ".tmp/",
            ".env",
            ".xihe-sentinel",
            ".xihe-probe-writable",
            ".xihe-container-runtime.log",
            ".xihe-container-runtime.pid",
            ".xihe-bridge-*.pid",
            ".xihe-shadow/",
            ".xihe-store/",
            ".xhs-restore-inprogress",
            ".xhs-restore-trash/",
        ];
        assert_eq!(crate::checkpoint::STATIC_EXCLUDE_PATTERNS, expected);
    }

    #[test]
    fn walk_applies_gitignore_negation_and_static_patterns() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        write_file(root, ".gitignore", b"*.log\n!keep.log\n");
        write_file(root, "keep.log", b"keep");
        write_file(root, "drop.log", b"drop");
        write_file(root, "src/main.rs", b"fn main() {}");
        write_file(root, ".env", b"SECRET=1");
        write_file(root, "secret.pem", b"pem");
        write_file(root, "node_modules/pkg/index.js", b"x");
        write_file(root, ".xihe-shadow/x", b"x");

        let outcome = walk_workspace(root).expect("walk");
        let paths: Vec<_> = outcome
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect();
        assert_eq!(paths, vec![".gitignore", "keep.log", "src/main.rs"]);
        assert!(outcome.issues.is_empty(), "{:?}", outcome.issues);
    }

    #[test]
    fn walk_skips_git_and_reports_oversized_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        write_file(root, "normal.txt", b"ok");
        write_file(root, ".git/HEAD", b"ref");
        let sparse = root.join("huge.bin");
        let file = fs::File::create(&sparse).expect("sparse file");
        file.set_len(MAX_BLOB_RAW_BYTES + 1).expect("set_len");

        let outcome = walk_workspace(root).expect("walk");
        assert!(
            outcome
                .entries
                .iter()
                .all(|entry| entry.path != "huge.bin" && !entry.path.starts_with(".git/"))
        );
        assert!(outcome.issues.iter().any(|issue| {
            issue.kind == WalkIssueKind::TooLarge && issue.path.as_deref() == Some("huge.bin")
        }));
    }

    #[cfg(windows)]
    fn extended(path: &Path) -> PathBuf {
        let text = path.to_string_lossy();
        if text.starts_with(r"\\?\") {
            path.to_path_buf()
        } else {
            PathBuf::from(format!(r"\\?\{text}"))
        }
    }

    #[cfg(windows)]
    #[test]
    fn walk_handles_long_paths_and_trailing_dot_space_names() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = extended(dir.path());
        let mut deep = root.clone();
        for index in 0..8 {
            deep.push(format!("segment-{index:02}-{}", "x".repeat(20)));
        }
        fs::create_dir_all(&deep).expect("long dirs");
        fs::write(deep.join("deep.txt"), b"deep").expect("deep file");
        assert!(deep.as_os_str().len() > 260);

        let dotted = root.join("foo.");
        let spaced = root.join("bar ");
        fs::create_dir_all(&dotted).expect("dot dir");
        fs::create_dir_all(&spaced).expect("space dir");
        fs::write(dotted.join("a.txt"), b"a").expect("dot file");
        fs::write(spaced.join("b.txt"), b"b").expect("space file");

        let outcome = walk_workspace(&root).expect("walk");
        let paths: Vec<_> = outcome
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect();
        assert!(
            paths
                .iter()
                .any(|path| path.ends_with("/deep.txt") && path.len() > 260),
            "long path missing: {paths:?}"
        );
        assert!(
            paths.contains(&"foo./a.txt"),
            "trailing-dot dir missing: {paths:?}"
        );
        assert!(
            paths.contains(&"bar /b.txt"),
            "trailing-space dir missing: {paths:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn walk_records_junction_without_following_it() {
        use std::process::Command;

        let dir = tempfile::tempdir().expect("tempdir");
        let root = extended(dir.path());
        let real = root.join("real");
        fs::create_dir_all(&real).expect("real dir");
        fs::write(real.join("file.txt"), b"x").expect("real file");
        let junction = root.join("link");
        let status = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&real)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if status.map(|status| !status.success()).unwrap_or(true) {
            eprintln!("SKIP: cannot create junction (no privilege or cmd unavailable)");
            return;
        }
        let loop_link = root.join("loop");
        let _ = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&loop_link)
            .arg(&root)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();

        let outcome = walk_workspace(&root).expect("walk");
        let junction_entry = outcome
            .entries
            .iter()
            .find(|entry| entry.path == "link")
            .expect("junction entry recorded");
        assert_eq!(junction_entry.kind, WalkEntryKind::Symlink);
        assert_eq!(junction_entry.mode, FileMode::Symlink);
        assert!(junction_entry.symlink_target.is_some());
        assert!(
            outcome
                .entries
                .iter()
                .any(|entry| entry.path == "real/file.txt")
        );
        assert!(
            outcome
                .entries
                .iter()
                .all(|entry| !entry.path.starts_with("link/")),
            "junction must not be followed"
        );
        if outcome.entries.iter().any(|entry| entry.path == "loop") {
            assert!(
                outcome
                    .entries
                    .iter()
                    .all(|entry| !entry.path.starts_with("loop/")),
                "junction to root must not recurse"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn walk_reports_permission_denied_directory() {
        use std::os::unix::fs::PermissionsExt;

        struct Restore(PathBuf);
        impl Drop for Restore {
            fn drop(&mut self) {
                let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o755));
            }
        }

        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let denied = root.join("denied");
        fs::create_dir_all(&denied).expect("denied dir");
        fs::write(denied.join("hidden.txt"), b"x").expect("hidden file");
        fs::set_permissions(&denied, fs::Permissions::from_mode(0o000)).expect("chmod");
        let _restore = Restore(denied.clone());

        let outcome = walk_workspace(root).expect("walk");
        assert!(outcome.issues.iter().any(|issue| {
            issue.kind == WalkIssueKind::PermissionDenied
                && issue
                    .path
                    .as_deref()
                    .is_some_and(|path| path.contains("denied"))
        }));
    }

    #[test]
    fn io_error_classification_is_identifiable() {
        let permission = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let issue = issue_for_io(Some(Path::new("secret")), &permission);
        assert_eq!(issue.kind, WalkIssueKind::PermissionDenied);

        let vanished = std::io::Error::from(std::io::ErrorKind::NotFound);
        let issue = issue_for_io(Some(Path::new("gone")), &vanished);
        assert_eq!(issue.kind, WalkIssueKind::Vanished);
        assert_eq!(issue.path.as_deref(), Some("gone"));
    }

    #[test]
    fn walker_classifies_a_vanished_entry_from_the_walk_error() {
        let error = ignore::Error::WithPath {
            path: PathBuf::from("gone.txt"),
            err: Box::new(ignore::Error::Io(std::io::Error::from(
                std::io::ErrorKind::NotFound,
            ))),
        };
        let issue = ignore_error_issue(&error, Path::new(""));
        assert_eq!(issue.kind, WalkIssueKind::Vanished);
        assert_eq!(issue.path.as_deref(), Some("gone.txt"));
    }

    #[test]
    fn walk_reports_vanished_entry_when_file_disappears_mid_walk() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        write_file(root, "000-marker.txt", b"marker");
        write_file(root, "zzz-victim.txt", b"victim");
        let victim = root.join("zzz-victim.txt");

        let outcome = walk_workspace_with_hook(root, move |path| {
            if path.file_name() == Some(OsStr::new("000-marker.txt")) {
                let _ = fs::remove_file(&victim);
            }
        })
        .expect("walk");

        assert!(
            outcome.issues.iter().any(|issue| {
                issue.kind == WalkIssueKind::Vanished
                    && issue.path.as_deref() == Some("zzz-victim.txt")
            }),
            "expected a Vanished issue, got {:?}",
            outcome.issues
        );
    }
}
