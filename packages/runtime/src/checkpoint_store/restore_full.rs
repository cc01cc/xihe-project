//! T2.1 product full restore (PLAN-0653).
//!
//! Safety model (D53-26): deletion candidates come only from the current store
//! tail manifest; modified files are preserved unless explicitly forced; deleted
//! files are quarantined; symlinks are rejected before any mutation.

use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;

use super::blob::{BlobError, blob_hash, read_blob};
use super::capture::{TailSlice, read_tail_manifest, tail_slice};
use super::manifest::{FileMode, Manifest, ManifestError};
use super::store::{Store, StoreError};

pub const RESTORE_MARKER: &str = ".xhs-restore-inprogress";
pub const RESTORE_TRASH: &str = ".xhs-restore-trash";

#[derive(Debug, Clone, Default)]
pub struct FullRestoreOptions {
    /// Explicitly allow deleting a path whose current content differs from the
    /// tail manifest. Default is to preserve it and report it.
    pub force_modified_deletions: bool,
    /// Test-only fault injection after the destructive deletion phase.
    #[cfg(test)]
    pub fail_after_deletes: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FullRestoreStats {
    pub restored: usize,
    pub deleted: usize,
    pub pruned_dirs: usize,
    pub skipped_already_absent: usize,
    pub skipped_modified_deletions: Vec<String>,
    pub bytes: u64,
    pub duration_ms: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum FullRestoreError {
    #[error("invalid slice id {0:?}")]
    InvalidSliceId(String),
    #[error("slice not found: {0:?}")]
    SliceMissing(PathBuf),
    #[error("slice is corrupt: {0}")]
    SliceCorrupt(String),
    #[error("manifest error: {0}")]
    Manifest(#[from] ManifestError),
    #[error("blob error: {0}")]
    Blob(#[from] BlobError),
    #[error("store error: {0}")]
    Store(#[from] StoreError),
    #[error("unsafe restore path {0:?}")]
    UnsafePath(String),
    #[error("symlink entries are not supported by T2.1: {0}")]
    SymlinkUnsupported(String),
    #[error("type conflict at {path:?}: {detail}")]
    TypeConflict { path: String, detail: String },
    #[error("another restore is incomplete; marker exists at {0:?}")]
    RestoreIncomplete(PathBuf),
    #[error("modified since capture (tail {expected:?}, current {actual:?}): {path:?}")]
    ModifiedDeletion {
        path: String,
        expected: String,
        actual: String,
    },
    #[error("restored size/hash mismatch at {path:?}")]
    VerifyFailed { path: String },
    #[error("I/O error at {path:?}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

fn io_error(path: &Path, source: std::io::Error) -> FullRestoreError {
    FullRestoreError::Io {
        path: path.to_path_buf(),
        source,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn validate_path(path: &str) -> Result<(), FullRestoreError> {
    if path.is_empty() || path.contains('\\') {
        return Err(FullRestoreError::UnsafePath(path.to_owned()));
    }
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        return Err(FullRestoreError::UnsafePath(path.to_owned()));
    }
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(FullRestoreError::UnsafePath(path.to_owned()));
        }
        #[cfg(windows)]
        {
            if segment.ends_with('.') || segment.ends_with(' ') || segment.contains(':') {
                return Err(FullRestoreError::UnsafePath(path.to_owned()));
            }
            let stem = segment.split('.').next().unwrap_or(segment);
            let upper = stem.to_ascii_uppercase();
            let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || (upper.len() == 4
                    && (upper.starts_with("COM") || upper.starts_with("LPT"))
                    && upper.as_bytes()[3].is_ascii_digit()
                    && upper.as_bytes()[3] != b'0');
            if reserved {
                return Err(FullRestoreError::UnsafePath(path.to_owned()));
            }
        }
        if segment.eq_ignore_ascii_case(".git") {
            return Err(FullRestoreError::UnsafePath(path.to_owned()));
        }
    }
    for component in candidate.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(FullRestoreError::UnsafePath(path.to_owned()));
        }
    }
    if path.len() > 240 {
        return Err(FullRestoreError::UnsafePath(path.to_owned()));
    }
    Ok(())
}

fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, FullRestoreError> {
    validate_path(relative)?;
    Ok(root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR)))
}

fn is_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn check_ancestors(root: &Path, relative: &str) -> Result<(), FullRestoreError> {
    let mut current = root.to_path_buf();
    let mut parts = relative.split('/').peekable();
    while let Some(part) = parts.next() {
        if parts.peek().is_none() {
            break;
        }
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if is_reparse(&metadata) {
                    return Err(FullRestoreError::UnsafePath(relative.to_owned()));
                }
                if !metadata.is_dir() {
                    return Err(FullRestoreError::TypeConflict {
                        path: relative.to_owned(),
                        detail: "ancestor is not a directory".into(),
                    });
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(io_error(&current, error)),
        }
    }
    Ok(())
}

fn mode_matches(entry: &super::manifest::ManifestEntry, metadata: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let executable = metadata.permissions().mode() & 0o111 != 0;
        matches!(
            (entry.mode, executable),
            (FileMode::Executable, true) | (FileMode::Regular, false)
        )
    }
    #[cfg(not(unix))]
    {
        let _ = (entry, metadata);
        true
    }
}

fn prune_empty_dirs(root: &Path, relative: &str, pruned: &mut usize) {
    let Some(parent) = Path::new(relative).parent() else {
        return;
    };
    let mut current = root.to_path_buf();
    for component in parent.components() {
        current.push(component.as_os_str());
    }
    while current != root && current.starts_with(root) {
        if fs::remove_dir(&current).is_err() {
            break;
        }
        *pruned += 1;
        if !current.pop() {
            break;
        }
    }
}

fn read_target_manifest(
    store: &Store,
    root_id: &str,
    slice_id: &str,
) -> Result<(Manifest, String), FullRestoreError> {
    if slice_id.is_empty() || slice_id.contains(['/', '\\']) || slice_id == "." || slice_id == ".."
    {
        return Err(FullRestoreError::InvalidSliceId(slice_id.to_owned()));
    }
    let slice_path = store.slice_dir(root_id).join(format!("{slice_id}.json"));
    let bytes = fs::read(&slice_path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            FullRestoreError::SliceMissing(slice_path.clone())
        } else {
            io_error(&slice_path, error)
        }
    })?;
    let slice: Value = serde_json::from_slice(&bytes)
        .map_err(|error| FullRestoreError::SliceCorrupt(error.to_string()))?;
    let manifest_id = slice
        .get("manifest")
        .and_then(Value::as_str)
        .ok_or_else(|| FullRestoreError::SliceCorrupt("missing manifest".into()))?
        .to_owned();
    let manifest_path = store.manifest_path(&manifest_id);
    let manifest_bytes =
        fs::read(&manifest_path).map_err(|error| io_error(&manifest_path, error))?;
    let manifest = Manifest::parse_verified(&manifest_bytes, &manifest_id)?;
    Ok((manifest, manifest_id))
}

fn preflight(
    store: &Store,
    target: &Manifest,
    tail: Option<&Manifest>,
) -> Result<(), FullRestoreError> {
    for entry in &target.entries {
        validate_path(&entry.path)?;
        if entry.mode == FileMode::Symlink {
            return Err(FullRestoreError::SymlinkUnsupported(entry.path.clone()));
        }
        let raw = read_blob(store.root(), &entry.blob_hash)?;
        if raw.len() as u64 != entry.size {
            return Err(FullRestoreError::VerifyFailed {
                path: entry.path.clone(),
            });
        }
        if blob_hash(&raw) != entry.blob_hash {
            return Err(FullRestoreError::VerifyFailed {
                path: entry.path.clone(),
            });
        }
    }
    if let Some(tail) = tail {
        for entry in &tail.entries {
            if entry.mode == FileMode::Symlink {
                return Err(FullRestoreError::SymlinkUnsupported(entry.path.clone()));
            }
        }
    }
    Ok(())
}

fn mark_incomplete(
    work_tree: &Path,
    root_id: &str,
    slice_id: &str,
    restore_id: &str,
    tail: Option<&TailSlice>,
) -> Result<PathBuf, FullRestoreError> {
    let path = work_tree.join(RESTORE_MARKER);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                FullRestoreError::RestoreIncomplete(path.clone())
            } else {
                io_error(&path, error)
            }
        })?;
    let body = serde_json::json!({
        "v": 1,
        "restore_id": restore_id,
        "root_id": root_id,
        "target_slice": slice_id,
        "tail_slice": tail.map(|tail| tail.id.as_str()),
        "pid": std::process::id(),
        "started_at_ms": now_ms(),
    });
    file.write_all(&serde_json::to_vec(&body).map_err(|error| {
        io_error(
            &path,
            std::io::Error::other(format!("marker encode: {error}")),
        )
    })?)
    .map_err(|error| io_error(&path, error))?;
    file.sync_all().map_err(|error| io_error(&path, error))?;
    Ok(path)
}

fn clear_marker(path: &Path) -> Result<(), FullRestoreError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error(path, error)),
    }
}

/// Full restore of one slice into `work_tree`.
pub fn restore_full(
    store: &Store,
    root_id: &str,
    slice_id: &str,
    work_tree: &Path,
    options: &FullRestoreOptions,
) -> Result<FullRestoreStats, FullRestoreError> {
    let started = Instant::now();
    if !work_tree.is_dir() {
        return Err(FullRestoreError::TypeConflict {
            path: work_tree.display().to_string(),
            detail: "work tree is not a directory".into(),
        });
    }
    let (target, _manifest_id) = read_target_manifest(store, root_id, slice_id)?;
    let tail_slice = tail_slice(store, root_id).map_err(|error| {
        FullRestoreError::SliceCorrupt(format!("tail slice read failed: {error}"))
    })?;
    let tail_manifest = match &tail_slice {
        Some(tail) => Some(read_tail_manifest(store, tail).map_err(|error| {
            FullRestoreError::SliceCorrupt(format!("tail manifest read failed: {error}"))
        })?),
        None => None,
    };
    preflight(store, &target, tail_manifest.as_ref())?;

    let target_paths: BTreeSet<&str> = target
        .entries
        .iter()
        .map(|entry| entry.path.as_str())
        .collect();
    let mut deletion_candidates = Vec::new();
    if let Some(tail) = &tail_manifest {
        for entry in &tail.entries {
            if !target_paths.contains(entry.path.as_str()) {
                deletion_candidates.push(entry);
            }
        }
    }

    // Preflight type conflicts and deletion safety before creating a marker or
    // mutating any path.
    for entry in &target.entries {
        check_ancestors(work_tree, &entry.path)?;
        if let Ok(metadata) = fs::symlink_metadata(
            work_tree.join(entry.path.replace('/', std::path::MAIN_SEPARATOR_STR)),
        ) {
            if is_reparse(&metadata) {
                return Err(FullRestoreError::UnsafePath(entry.path.clone()));
            }
            if metadata.is_dir() {
                return Err(FullRestoreError::TypeConflict {
                    path: entry.path.clone(),
                    detail: "directory exists where a file is expected".into(),
                });
            }
        }
    }

    let restore_id = format!("{}-{}", std::process::id(), now_ms());
    let marker = mark_incomplete(
        work_tree,
        root_id,
        slice_id,
        &restore_id,
        tail_slice.as_ref(),
    )?;
    let trash_root = work_tree.join(RESTORE_TRASH).join(&restore_id);
    let mut stats = FullRestoreStats::default();
    let result = (|| -> Result<(), FullRestoreError> {
        fs::create_dir_all(&trash_root).map_err(|error| io_error(&trash_root, error))?;
        for entry in deletion_candidates {
            validate_path(&entry.path)?;
            check_ancestors(work_tree, &entry.path)?;
            let current = safe_join(work_tree, &entry.path)?;
            let metadata = match fs::symlink_metadata(&current) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    stats.skipped_already_absent += 1;
                    continue;
                }
                Err(error) => return Err(io_error(&current, error)),
            };
            if is_reparse(&metadata) || metadata.is_dir() {
                stats.skipped_modified_deletions.push(entry.path.clone());
                continue;
            }
            let raw = fs::read(&current).map_err(|error| io_error(&current, error))?;
            let actual = blob_hash(&raw);
            if raw.len() as u64 != entry.size
                || actual != entry.blob_hash
                || !mode_matches(entry, &metadata)
            {
                if options.force_modified_deletions {
                    // force still only removes a regular file, never a symlink/dir
                    if is_reparse(&metadata) || metadata.is_dir() {
                        return Err(FullRestoreError::UnsafePath(entry.path.clone()));
                    }
                } else {
                    stats.skipped_modified_deletions.push(entry.path.clone());
                    continue;
                }
            }
            let trash_path = safe_join(&trash_root, &entry.path)?;
            if let Some(parent) = trash_path.parent() {
                fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
            }
            fs::rename(&current, &trash_path).map_err(|error| FullRestoreError::Io {
                path: current.clone(),
                source: std::io::Error::other(format!(
                    "quarantine rename failed (refusing to unlink): {error}"
                )),
            })?;
            stats.deleted += 1;
            prune_empty_dirs(work_tree, &entry.path, &mut stats.pruned_dirs);
        }
        #[cfg(test)]
        if options.fail_after_deletes {
            return Err(FullRestoreError::Io {
                path: work_tree.to_path_buf(),
                source: std::io::Error::other("injected failure after deletes"),
            });
        }

        for entry in &target.entries {
            validate_path(&entry.path)?;
            check_ancestors(work_tree, &entry.path)?;
            let destination = safe_join(work_tree, &entry.path)?;
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
            }
            check_ancestors(work_tree, &entry.path)?;
            if let Ok(metadata) = fs::symlink_metadata(&destination)
                && (is_reparse(&metadata) || metadata.is_dir())
            {
                return Err(FullRestoreError::UnsafePath(entry.path.clone()));
            }
            let raw = read_blob(store.root(), &entry.blob_hash)?;
            if raw.len() as u64 != entry.size {
                return Err(FullRestoreError::VerifyFailed {
                    path: entry.path.clone(),
                });
            }
            let tmp = destination
                .with_file_name(format!(".xhs-restore-tmp-{restore_id}-{}", stats.restored));
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp)
                .map_err(|error| io_error(&tmp, error))?;
            file.write_all(&raw)
                .map_err(|error| io_error(&tmp, error))?;
            drop(file);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = if entry.mode == FileMode::Executable {
                    0o755
                } else {
                    0o644
                };
                fs::set_permissions(&tmp, fs::Permissions::from_mode(mode))
                    .map_err(|error| io_error(&tmp, error))?;
            }
            // No per-file fsync: tmp->rename only guarantees no half-written
            // file after a process crash, not power-loss durability (D53-18).
            if let Err(error) = fs::rename(&tmp, &destination) {
                let _ = fs::remove_file(&tmp);
                return Err(io_error(&destination, error));
            }
            let verified = fs::read(&destination).map_err(|error| io_error(&destination, error))?;
            if verified.len() as u64 != entry.size || blob_hash(&verified) != entry.blob_hash {
                return Err(FullRestoreError::VerifyFailed {
                    path: entry.path.clone(),
                });
            }
            stats.restored += 1;
            stats.bytes = stats.bytes.saturating_add(entry.size);
        }
        Ok(())
    })();
    if result.is_err() {
        // Deliberately leave the marker and quarantine for T2.3/manual recovery.
        return result.map(|()| stats);
    }
    // Successful restore: remove the quarantine and only then the marker.
    if trash_root.exists() {
        fs::remove_dir_all(&trash_root).map_err(|error| io_error(&trash_root, error))?;
    }
    if let Some(parent) = trash_root.parent() {
        let _ = fs::remove_dir(parent);
    }
    clear_marker(&marker)?;
    stats.duration_ms = started.elapsed().as_millis() as u64;
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checkpoint_store::blob::write_blob;
    use crate::checkpoint_store::capture::capture_root;
    use crate::checkpoint_store::manifest::ManifestEntry;

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().expect("parent")).expect("parent");
        fs::write(path, content).expect("write");
    }

    fn workspace() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    fn symlink_slice(store: &Store, root_id: &str, slice_id: &str) -> String {
        let outcome = write_blob(store.root(), b"../outside").expect("symlink blob");
        let manifest = Manifest::from_entries(vec![
            ManifestEntry::new("link".to_string(), FileMode::Symlink, 10, outcome.hash)
                .expect("entry"),
        ])
        .expect("manifest");
        let manifest_bytes = manifest.canonical_bytes().expect("manifest bytes");
        let manifest_id = manifest.manifest_id().expect("manifest id");
        store
            .write_atomic(&store.manifest_path(&manifest_id), &manifest_bytes)
            .expect("write manifest");
        let slice = serde_json::json!({
            "v": 1,
            "id": slice_id,
            "manifest": manifest_id,
        });
        store
            .write_atomic(
                &store.slice_dir(root_id).join(format!("{slice_id}.json")),
                &serde_json::to_vec(&slice).expect("slice json"),
            )
            .expect("write slice");
        slice_id.to_string()
    }

    #[test]
    fn full_restore_writes_and_deletes_only_tail_paths() {
        let workspace = workspace();
        let root = workspace.path().join("ws");
        let store_dir = workspace.path().join("store");
        fs::create_dir_all(&root).expect("root");
        write(&root.join("a.txt"), "one");
        write(&root.join(".gitignore"), "ignored.txt\n");
        let store = Store::init(&store_dir).expect("store");
        let first = capture_root(&store, &root, "ws-1", None, None).expect("first");
        write(&root.join("b.txt"), "two");
        write(&root.join("dir/c.txt"), "three");
        let second = capture_root(&store, &root, "ws-1", None, None).expect("second");
        assert!(!first.no_change && !second.no_change);
        write(&root.join("new.txt"), "new");
        write(&root.join("ignored.txt"), "ignored");

        let stats = restore_full(
            &store,
            "ws-1",
            &first.slice_id,
            &root,
            &FullRestoreOptions::default(),
        )
        .expect("restore");
        assert_eq!(stats.deleted, 2, "b and dir/c");
        assert_eq!(fs::read_to_string(root.join("a.txt")).expect("a"), "one");
        assert!(!root.join("b.txt").exists());
        assert!(!root.join("dir").exists(), "empty dir must be pruned");
        assert_eq!(
            fs::read_to_string(root.join("new.txt")).expect("new"),
            "new"
        );
        assert_eq!(
            fs::read_to_string(root.join("ignored.txt")).expect("ignored"),
            "ignored"
        );
        assert!(!root.join(RESTORE_MARKER).exists());
        assert!(!root.join(RESTORE_TRASH).exists());
    }

    #[test]
    fn modified_deletion_is_preserved_unless_forced() {
        let workspace = workspace();
        let root = workspace.path().join("ws");
        let store_dir = workspace.path().join("store");
        fs::create_dir_all(&root).expect("root");
        write(&root.join("a.txt"), "one");
        let store = Store::init(&store_dir).expect("store");
        let first = capture_root(&store, &root, "ws-1", None, None).expect("first");
        write(&root.join("b.txt"), "two");
        capture_root(&store, &root, "ws-1", None, None).expect("second");
        write(&root.join("b.txt"), "modified");

        let stats = restore_full(
            &store,
            "ws-1",
            &first.slice_id,
            &root,
            &FullRestoreOptions::default(),
        )
        .expect("restore");
        assert_eq!(stats.deleted, 0);
        assert_eq!(stats.skipped_modified_deletions, vec!["b.txt"]);
        assert_eq!(
            fs::read_to_string(root.join("b.txt")).expect("modified preserved"),
            "modified"
        );

        let forced = restore_full(
            &store,
            "ws-1",
            &first.slice_id,
            &root,
            &FullRestoreOptions {
                force_modified_deletions: true,
                ..FullRestoreOptions::default()
            },
        )
        .expect("forced restore");
        assert_eq!(forced.deleted, 1);
        assert!(!root.join("b.txt").exists());
    }

    #[test]
    fn symlink_manifest_fails_before_marker_or_mutation() {
        let workspace = workspace();
        let root = workspace.path().join("ws");
        fs::create_dir_all(&root).expect("root");
        write(&root.join("keep.txt"), "keep");
        let store = Store::init(workspace.path().join("store")).expect("store");
        let slice_id = "0000000000001-symlink";
        symlink_slice(&store, "ws-1", slice_id);
        let error = restore_full(
            &store,
            "ws-1",
            slice_id,
            &root,
            &FullRestoreOptions::default(),
        )
        .expect_err("symlink must fail");
        assert!(
            matches!(error, FullRestoreError::SymlinkUnsupported(_)),
            "{error:?}"
        );
        assert_eq!(
            fs::read_to_string(root.join("keep.txt")).expect("keep"),
            "keep"
        );
        assert!(!root.join(RESTORE_MARKER).exists());
    }

    #[test]
    fn capture_static_excludes_restore_marker_and_trash() {
        let workspace = workspace();
        let root = workspace.path().join("ws");
        fs::create_dir_all(&root).expect("root");
        write(&root.join("a.txt"), "one");
        write(&root.join(RESTORE_MARKER), "{}");
        write(&root.join(RESTORE_TRASH).join("old.txt"), "trash");
        let store = Store::init(workspace.path().join("store")).expect("store");
        let capture = capture_root(&store, &root, "ws-1", None, None).expect("capture");
        let bytes = fs::read(store.manifest_path(&capture.manifest_id)).expect("manifest");
        let manifest = Manifest::parse_verified(&bytes, &capture.manifest_id).expect("parse");
        assert_eq!(
            manifest
                .entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec!["a.txt"]
        );
    }

    #[test]
    fn failed_restore_leaves_marker_and_quarantine_for_recovery() {
        let workspace = workspace();
        let root = workspace.path().join("ws");
        fs::create_dir_all(&root).expect("root");
        write(&root.join("a.txt"), "one");
        let store = Store::init(workspace.path().join("store")).expect("store");
        let first = capture_root(&store, &root, "ws-1", None, None).expect("first");
        write(&root.join("b.txt"), "two");
        capture_root(&store, &root, "ws-1", None, None).expect("second");
        let error = restore_full(
            &store,
            "ws-1",
            &first.slice_id,
            &root,
            &FullRestoreOptions {
                fail_after_deletes: true,
                ..FullRestoreOptions::default()
            },
        )
        .expect_err("injected failure");
        assert!(matches!(error, FullRestoreError::Io { .. }), "{error:?}");
        assert!(!root.join("b.txt").exists(), "b was quarantined");
        assert!(root.join(RESTORE_MARKER).exists(), "marker must remain");
        let trash = root.join(RESTORE_TRASH);
        let mut recovered = None;
        for entry in fs::read_dir(&trash).expect("trash dir") {
            let restore_dir = entry.expect("trash entry").path();
            let candidate = restore_dir.join("b.txt");
            if candidate.exists() {
                recovered = Some(fs::read_to_string(candidate).expect("quarantined b"));
            }
        }
        assert_eq!(recovered.as_deref(), Some("two"));
    }

    #[test]
    fn existing_marker_blocks_restore() {
        let workspace = workspace();
        let root = workspace.path().join("ws");
        fs::create_dir_all(&root).expect("root");
        write(&root.join("a.txt"), "one");
        fs::write(root.join(RESTORE_MARKER), "{}").expect("marker");
        let store = Store::init(workspace.path().join("store")).expect("store");
        let first = capture_root(&store, &root, "ws-1", None, None).expect("capture");
        let error = restore_full(
            &store,
            "ws-1",
            &first.slice_id,
            &root,
            &FullRestoreOptions::default(),
        )
        .expect_err("marker must block");
        assert!(
            matches!(error, FullRestoreError::RestoreIncomplete(_)),
            "{error:?}"
        );
        assert_eq!(fs::read_to_string(root.join("a.txt")).expect("a"), "one");
    }

    #[test]
    fn full_restore_replaces_existing_file_without_tmp_leftovers() {
        let workspace = workspace();
        let root = workspace.path().join("ws");
        let store_dir = workspace.path().join("store");
        fs::create_dir_all(&root).expect("root");
        write(&root.join("a.txt"), "target");
        let store = Store::init(&store_dir).expect("store");
        let first = capture_root(&store, &root, "ws-1", None, None).expect("capture");
        write(&root.join("a.txt"), "user-change");
        restore_full(
            &store,
            "ws-1",
            &first.slice_id,
            &root,
            &FullRestoreOptions::default(),
        )
        .expect("restore");
        assert_eq!(fs::read_to_string(root.join("a.txt")).expect("a"), "target");
        for entry in fs::read_dir(&root).expect("read root") {
            let name = entry.expect("entry").file_name();
            assert!(
                !name.to_string_lossy().starts_with(".xhs-restore-tmp-"),
                "temp leftover: {name:?}"
            );
        }
    }
}
