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
    /// Resume a marker left by an interrupted restore of the same target.
    pub resume_same_target: bool,
    /// T2.2 subtree scope: `None` = full workspace; `Some("dir")` = that path
    /// and its children (literal path semantics, no wildcard).
    pub path_prefix: Option<String>,
    /// Test-only fault injection after the destructive deletion phase.
    #[cfg(test)]
    pub fail_after_deletes: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum FullRestoreAction {
    Restore,
    Delete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum FullRestoreState {
    Execute,
    SkippedModified,
    AlreadyAbsent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FullRestorePreviewEntry {
    pub path: String,
    pub action: FullRestoreAction,
    pub state: FullRestoreState,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FullRestorePreview {
    pub entries: Vec<FullRestorePreviewEntry>,
    pub restore: usize,
    pub delete: usize,
    pub skipped_modified: Vec<String>,
    pub already_absent: usize,
    pub bytes: u64,
}

struct FullRestorePlan {
    tail_slice: Option<TailSlice>,
    writes: Vec<super::manifest::ManifestEntry>,
    deletions: Vec<super::manifest::ManifestEntry>,
    skipped_modified: Vec<String>,
    already_absent: usize,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub struct RestoreMarker {
    pub v: u32,
    pub restore_id: String,
    pub root_id: String,
    pub target_slice: String,
    pub tail_slice: Option<String>,
    pub pid: u32,
    pub started_at_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RestoreStatus {
    pub incomplete: bool,
    pub marker: Option<RestoreMarker>,
    pub marker_path: PathBuf,
    pub trash_entries: Vec<String>,
    pub message: Option<String>,
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
    #[error("restore marker is corrupt: {0}")]
    MarkerCorrupt(String),
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

fn read_marker(work_tree: &Path) -> Result<Option<RestoreMarker>, FullRestoreError> {
    let path = work_tree.join(RESTORE_MARKER);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(&path, error)),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| FullRestoreError::MarkerCorrupt(error.to_string()))
}

fn trash_entries(work_tree: &Path) -> Vec<String> {
    fn walk(root: &Path, current: &Path, out: &mut Vec<String>) {
        let Ok(entries) = fs::read_dir(current) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.is_dir() && !is_reparse(&metadata) {
                walk(root, &path, out);
            } else if metadata.is_file() {
                out.push(
                    path.strip_prefix(root)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
    }
    let base = work_tree.join(RESTORE_TRASH);
    let mut out = Vec::new();
    walk(&base, &base, &mut out);
    out.sort();
    out
}

/// Report whether an interrupted restore left a marker/trash. This is the
/// T2.3 status primitive consumed by the runtime/CP projection later.
pub fn restore_status(work_tree: &Path) -> Result<RestoreStatus, FullRestoreError> {
    let marker_path = work_tree.join(RESTORE_MARKER);
    let trash_entries = trash_entries(work_tree);
    match read_marker(work_tree) {
        Ok(Some(marker)) => Ok(RestoreStatus {
            incomplete: true,
            message: Some(format!(
                "restore {} for slice {} was interrupted; rerun the same target with resume_same_target=true; quarantined files: {}",
                marker.restore_id,
                marker.target_slice,
                trash_entries.len()
            )),
            marker: Some(marker),
            marker_path,
            trash_entries,
        }),
        Ok(None) => Ok(RestoreStatus {
            incomplete: false,
            marker: None,
            marker_path,
            trash_entries,
            message: None,
        }),
        Err(error) => Ok(RestoreStatus {
            incomplete: true,
            marker: None,
            marker_path,
            trash_entries,
            message: Some(format!("restore marker cannot be parsed: {error}")),
        }),
    }
}

fn ensure_trash_base(work_tree: &Path) -> Result<PathBuf, FullRestoreError> {
    let base = work_tree.join(RESTORE_TRASH);
    match fs::symlink_metadata(&base) {
        Ok(metadata) if is_reparse(&metadata) || !metadata.is_dir() => {
            return Err(FullRestoreError::UnsafePath(RESTORE_TRASH.to_owned()));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error(&base, error)),
    }
    fs::create_dir_all(&base).map_err(|error| io_error(&base, error))?;
    let metadata = fs::symlink_metadata(&base).map_err(|error| io_error(&base, error))?;
    if is_reparse(&metadata) || !metadata.is_dir() {
        return Err(FullRestoreError::UnsafePath(RESTORE_TRASH.to_owned()));
    }
    Ok(base)
}

fn remove_trash(trash_root: &Path) -> Result<(), FullRestoreError> {
    if !trash_root.exists() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(trash_root).map_err(|error| io_error(trash_root, error))?;
    if is_reparse(&metadata) || !metadata.is_dir() {
        return Err(FullRestoreError::UnsafePath(RESTORE_TRASH.to_owned()));
    }
    fs::remove_dir_all(trash_root).map_err(|error| io_error(trash_root, error))?;
    if let Some(parent) = trash_root.parent() {
        let _ = fs::remove_dir(parent);
    }
    Ok(())
}

fn in_scope(path: &str, prefix: Option<&str>) -> bool {
    match prefix {
        None => true,
        Some(prefix) => path == prefix || path.starts_with(&format!("{prefix}/")),
    }
}

fn build_plan(
    store: &Store,
    root_id: &str,
    slice_id: &str,
    work_tree: &Path,
    options: &FullRestoreOptions,
) -> Result<FullRestorePlan, FullRestoreError> {
    if !work_tree.is_dir() {
        return Err(FullRestoreError::TypeConflict {
            path: work_tree.display().to_string(),
            detail: "work tree is not a directory".into(),
        });
    }
    if let Some(prefix) = options.path_prefix.as_deref() {
        validate_path(prefix)?;
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
    let prefix = options.path_prefix.as_deref();
    let target_paths: BTreeSet<&str> = target
        .entries
        .iter()
        .filter(|entry| in_scope(&entry.path, prefix))
        .map(|entry| entry.path.as_str())
        .collect();
    let mut writes = Vec::new();
    for entry in &target.entries {
        if !in_scope(&entry.path, prefix) {
            continue;
        }
        check_ancestors(work_tree, &entry.path)?;
        let destination = safe_join(work_tree, &entry.path)?;
        if let Ok(metadata) = fs::symlink_metadata(&destination) {
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
        writes.push(entry.clone());
    }
    let mut deletions = Vec::new();
    let mut skipped_modified = Vec::new();
    let mut already_absent = 0usize;
    if let Some(tail) = &tail_manifest {
        for entry in &tail.entries {
            if target_paths.contains(entry.path.as_str()) || !in_scope(&entry.path, prefix) {
                continue;
            }
            validate_path(&entry.path)?;
            check_ancestors(work_tree, &entry.path)?;
            let current = safe_join(work_tree, &entry.path)?;
            let metadata = match fs::symlink_metadata(&current) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    already_absent += 1;
                    continue;
                }
                Err(error) => return Err(io_error(&current, error)),
            };
            if is_reparse(&metadata) || metadata.is_dir() {
                skipped_modified.push(entry.path.clone());
                continue;
            }
            let raw = fs::read(&current).map_err(|error| io_error(&current, error))?;
            let modified = raw.len() as u64 != entry.size
                || blob_hash(&raw) != entry.blob_hash
                || !mode_matches(entry, &metadata);
            if modified && !options.force_modified_deletions {
                skipped_modified.push(entry.path.clone());
            } else {
                deletions.push(entry.clone());
            }
        }
    }
    Ok(FullRestorePlan {
        tail_slice,
        writes,
        deletions,
        skipped_modified,
        already_absent,
    })
}

/// Preview the same plan that [`restore_full`] executes. Read-only.
pub fn preview_full(
    store: &Store,
    root_id: &str,
    slice_id: &str,
    work_tree: &Path,
    options: &FullRestoreOptions,
) -> Result<FullRestorePreview, FullRestoreError> {
    let plan = build_plan(store, root_id, slice_id, work_tree, options)?;
    let mut preview = FullRestorePreview::default();
    for entry in &plan.writes {
        preview.restore += 1;
        preview.bytes = preview.bytes.saturating_add(entry.size);
        preview.entries.push(FullRestorePreviewEntry {
            path: entry.path.clone(),
            action: FullRestoreAction::Restore,
            state: FullRestoreState::Execute,
            detail: None,
        });
    }
    for entry in &plan.deletions {
        preview.delete += 1;
        preview.entries.push(FullRestorePreviewEntry {
            path: entry.path.clone(),
            action: FullRestoreAction::Delete,
            state: FullRestoreState::Execute,
            detail: None,
        });
    }
    // The plan also carries skipped/missing decisions; recompute their labels
    // from the same tail/worktree inputs without another mutation pass.
    if let Some(prefix) = options.path_prefix.as_deref() {
        preview
            .entries
            .retain(|entry| in_scope(&entry.path, Some(prefix)));
    }
    for path in &plan.skipped_modified {
        preview.skipped_modified.push(path.clone());
        preview.entries.push(FullRestorePreviewEntry {
            path: path.clone(),
            action: FullRestoreAction::Delete,
            state: FullRestoreState::SkippedModified,
            detail: Some("modified since capture; preserved by default".into()),
        });
    }
    preview.already_absent = plan.already_absent;
    preview.entries.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| left.action.cmp(&right.action))
    });
    Ok(preview)
}

/// T2.2 single-path/subtree restore; reuses the full plan and safety rules.
pub fn restore_path(
    store: &Store,
    root_id: &str,
    slice_id: &str,
    work_tree: &Path,
    path: &str,
    options: &FullRestoreOptions,
) -> Result<FullRestoreStats, FullRestoreError> {
    validate_path(path)?;
    let mut scoped = options.clone();
    scoped.path_prefix = Some(path.to_owned());
    restore_full(store, root_id, slice_id, work_tree, &scoped)
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
    let plan = build_plan(store, root_id, slice_id, work_tree, options)?;
    let tail_slice = plan.tail_slice.clone();

    let trash_base = ensure_trash_base(work_tree)?;
    let marker_path = work_tree.join(RESTORE_MARKER);
    let existing = read_marker(work_tree)?;
    let (marker, restore_id) = match existing {
        Some(marker) => {
            if !options.resume_same_target
                || marker.root_id != root_id
                || marker.target_slice != slice_id
            {
                return Err(FullRestoreError::RestoreIncomplete(marker_path));
            }
            (marker_path, marker.restore_id)
        }
        None => {
            let restore_id = format!("{}-{}", std::process::id(), now_ms());
            let marker = mark_incomplete(
                work_tree,
                root_id,
                slice_id,
                &restore_id,
                tail_slice.as_ref(),
            )?;
            (marker, restore_id)
        }
    };
    let trash_root = trash_base.join(&restore_id);
    let mut stats = FullRestoreStats {
        skipped_already_absent: plan.already_absent,
        skipped_modified_deletions: plan.skipped_modified.clone(),
        ..FullRestoreStats::default()
    };
    let result = (|| -> Result<(), FullRestoreError> {
        fs::create_dir_all(&trash_root).map_err(|error| io_error(&trash_root, error))?;
        for entry in &plan.deletions {
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

        for entry in &plan.writes {
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
    remove_trash(&trash_root)?;
    clear_marker(&marker)?;
    stats.duration_ms = started.elapsed().as_millis() as u64;
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checkpoint_store::blob::write_blob;
    use crate::checkpoint_store::capture::{
        CaptureOptions, capture_root, capture_root_with_options,
    };
    use crate::checkpoint_store::manifest::ManifestEntry;
    use std::collections::BTreeMap;
    use std::process::Command;

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
        let second = capture_root(&store, &root, "ws-1", None, None).expect("second");
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
        let status = restore_status(&root).expect("status");
        assert!(status.incomplete);
        assert_eq!(
            status.marker.as_ref().expect("marker").target_slice,
            first.slice_id
        );
        assert!(
            status
                .message
                .as_deref()
                .is_some_and(|message| message.contains("quarantined"))
        );
        let blocked = restore_full(
            &store,
            "ws-1",
            &second.slice_id,
            &root,
            &FullRestoreOptions {
                resume_same_target: true,
                ..FullRestoreOptions::default()
            },
        )
        .expect_err("different target must not resume");
        assert!(
            matches!(blocked, FullRestoreError::RestoreIncomplete(_)),
            "{blocked:?}"
        );
        assert!(root.join(RESTORE_MARKER).exists());
        let resumed = restore_full(
            &store,
            "ws-1",
            &first.slice_id,
            &root,
            &FullRestoreOptions {
                resume_same_target: true,
                ..FullRestoreOptions::default()
            },
        )
        .expect("resume same target");
        assert_eq!(resumed.restored, 1);
        assert!(!root.join(RESTORE_MARKER).exists());
        assert!(!root.join(RESTORE_TRASH).exists());
        assert!(!restore_status(&root).expect("status").incomplete);
    }

    #[test]
    fn preview_and_restore_share_the_same_plan() {
        let workspace = workspace();
        let root = workspace.path().join("ws");
        fs::create_dir_all(&root).expect("root");
        write(&root.join("a.txt"), "one");
        let store = Store::init(workspace.path().join("store")).expect("store");
        let first = capture_root(&store, &root, "ws-1", None, None).expect("first");
        write(&root.join("b.txt"), "two");
        capture_root(&store, &root, "ws-1", None, None).expect("second");
        write(&root.join("b.txt"), "modified");

        let preview = preview_full(
            &store,
            "ws-1",
            &first.slice_id,
            &root,
            &FullRestoreOptions::default(),
        )
        .expect("preview");
        assert_eq!(preview.restore, 1, "a.txt");
        assert_eq!(preview.delete, 0, "b.txt is modified and preserved");
        assert_eq!(preview.skipped_modified, vec!["b.txt"]);

        let stats = restore_full(
            &store,
            "ws-1",
            &first.slice_id,
            &root,
            &FullRestoreOptions::default(),
        )
        .expect("restore");
        assert_eq!(preview.restore, stats.restored);
        assert_eq!(preview.delete, stats.deleted);
        assert_eq!(preview.skipped_modified, stats.skipped_modified_deletions);

        let preview_force = preview_full(
            &store,
            "ws-1",
            &first.slice_id,
            &root,
            &FullRestoreOptions {
                force_modified_deletions: true,
                ..FullRestoreOptions::default()
            },
        )
        .expect("preview force");
        assert_eq!(preview_force.delete, 1);
        let force = restore_full(
            &store,
            "ws-1",
            &first.slice_id,
            &root,
            &FullRestoreOptions {
                force_modified_deletions: true,
                ..FullRestoreOptions::default()
            },
        )
        .expect("force restore");
        assert_eq!(preview_force.delete, force.deleted);
    }

    #[test]
    fn single_restore_reuses_safety_and_rejects_escape() {
        let workspace = workspace();
        let root = workspace.path().join("ws");
        fs::create_dir_all(&root).expect("root");
        write(&root.join("a.txt"), "one");
        let store = Store::init(workspace.path().join("store")).expect("store");
        let first = capture_root(&store, &root, "ws-1", None, None).expect("first");
        write(&root.join("b.txt"), "two");
        capture_root(&store, &root, "ws-1", None, None).expect("second");
        write(&root.join("b.txt"), "modified");

        let scoped = restore_path(
            &store,
            "ws-1",
            &first.slice_id,
            &root,
            "b.txt",
            &FullRestoreOptions::default(),
        )
        .expect("single restore");
        assert_eq!(scoped.skipped_modified_deletions, vec!["b.txt"]);
        assert_eq!(
            fs::read_to_string(root.join("b.txt")).expect("b"),
            "modified"
        );
        assert_eq!(fs::read_to_string(root.join("a.txt")).expect("a"), "one");

        let forced = restore_path(
            &store,
            "ws-1",
            &first.slice_id,
            &root,
            "b.txt",
            &FullRestoreOptions {
                force_modified_deletions: true,
                ..FullRestoreOptions::default()
            },
        )
        .expect("single force");
        assert_eq!(forced.deleted, 1);
        assert!(!root.join("b.txt").exists());

        write(&root.join("b.txt"), "quarantine-me");
        let failure = restore_path(
            &store,
            "ws-1",
            &first.slice_id,
            &root,
            "b.txt",
            &FullRestoreOptions {
                force_modified_deletions: true,
                fail_after_deletes: true,
                ..FullRestoreOptions::default()
            },
        )
        .expect_err("injected failure");
        assert!(
            matches!(failure, FullRestoreError::Io { .. }),
            "{failure:?}"
        );
        assert!(!root.join("b.txt").exists());
        assert!(root.join(RESTORE_MARKER).exists());
        assert!(
            trash_entries(&root)
                .iter()
                .any(|path| path.ends_with("b.txt"))
        );
        fs::remove_file(root.join(RESTORE_MARKER)).expect("clear recovered marker");
        fs::remove_dir_all(root.join(RESTORE_TRASH)).expect("clear recovered trash");

        let escape = restore_path(
            &store,
            "ws-1",
            &first.slice_id,
            &root,
            "../escape",
            &FullRestoreOptions::default(),
        )
        .expect_err("escape must fail");
        assert!(
            matches!(escape, FullRestoreError::UnsafePath(_)),
            "{escape:?}"
        );
        assert!(!root.join(RESTORE_MARKER).exists());
    }

    #[test]
    fn unsafe_trash_base_fails_before_marker() {
        let workspace = workspace();
        let root = workspace.path().join("ws");
        fs::create_dir_all(&root).expect("root");
        write(&root.join("a.txt"), "one");
        fs::write(root.join(RESTORE_TRASH), "not a directory").expect("trash file");
        let store = Store::init(workspace.path().join("store")).expect("store");
        let first = capture_root(&store, &root, "ws-1", None, None).expect("capture");
        let error = restore_full(
            &store,
            "ws-1",
            &first.slice_id,
            &root,
            &FullRestoreOptions::default(),
        )
        .expect_err("trash file must fail");
        assert!(
            matches!(error, FullRestoreError::UnsafePath(_)),
            "{error:?}"
        );
        assert!(!root.join(RESTORE_MARKER).exists());
        assert_eq!(fs::read_to_string(root.join("a.txt")).expect("a"), "one");
    }

    #[test]
    fn existing_marker_blocks_restore() {
        let workspace = workspace();
        let root = workspace.path().join("ws");
        fs::create_dir_all(&root).expect("root");
        write(&root.join("a.txt"), "one");
        let store = Store::init(workspace.path().join("store")).expect("store");
        let first = capture_root(&store, &root, "ws-1", None, None).expect("capture");
        fs::write(
            root.join(RESTORE_MARKER),
            serde_json::to_vec(&serde_json::json!({
                "v": 1,
                "restore_id": "stale",
                "root_id": "ws-1",
                "target_slice": first.slice_id,
                "tail_slice": null,
                "pid": 1,
                "started_at_ms": 0,
            }))
            .expect("marker json"),
        )
        .expect("marker");
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

        let status = restore_status(&root).expect("status");
        assert!(status.incomplete);
        assert!(status.marker.is_some());
        assert!(
            status
                .message
                .as_deref()
                .is_some_and(|message| message.contains("interrupted"))
        );
        let resumed = restore_full(
            &store,
            "ws-1",
            &first.slice_id,
            &root,
            &FullRestoreOptions {
                resume_same_target: true,
                ..FullRestoreOptions::default()
            },
        )
        .expect("resume");
        assert_eq!(resumed.restored, 1);
        assert!(!root.join(RESTORE_MARKER).exists());
        assert!(!restore_status(&root).expect("status").incomplete);
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

    #[test]
    #[ignore = "V3 git-checkout parity: 3 tiers x 3 slices + negative expectations"]
    fn v3_git_checkout_parity() {
        let temp = tempfile::tempdir().expect("tempdir");
        let mut tiers = Vec::new();
        for tier in ["small", "medium", "large"] {
            tiers.push(run_v3_tier(temp.path(), tier));
        }
        let negatives = run_v3_negatives(temp.path());
        let report = serde_json::json!({
            "v": 1,
            "tiers": tiers,
            "negatives": negatives,
            "expected_exceptions": {
                "nested_gitlink": "git tree gitlinks are not materialized; store Opaque excludes nested contents; only regular-file paths are compared",
                "empty_dirs": "directories are not compared as entries; T2.1 only prunes empty parents left by its own deletions",
                "line_endings": "fixture forces core.autocrlf=false and core.eol=lf",
                "modified_deletion": "negative case is intentionally preserved by store restore and would be covered by git checkout; recorded in negatives.expectations"
            },
            "gate": {
                "tiers": 3,
                "slices_per_tier": 3,
                "positive_findings": 0,
                "negative_cases": 3
            }
        });
        eprintln!(
            "V3_REPORT {}",
            serde_json::to_string_pretty(&report).expect("report json")
        );
        if let Ok(path) = std::env::var("V3_REPORT_PATH") {
            fs::write(
                path,
                serde_json::to_vec_pretty(&report).expect("report json bytes"),
            )
            .expect("write V3 report");
        }
        assert!(
            tiers
                .iter()
                .all(|tier| tier["findings"].as_array().is_some_and(Vec::is_empty)),
            "positive parity findings: {report}"
        );
        assert!(
            negatives.iter().all(|item| item["status"] == "pass"),
            "negative expectations failed: {report}"
        );
    }

    fn run_v3_tier(base: &Path, tier: &str) -> Value {
        let root = base.join(format!("v3-{tier}"));
        let store_dir = base.join(format!("v3-{tier}-store"));
        let target_base = base.join(format!("v3-{tier}-targets"));
        fs::create_dir_all(&root).expect("root");
        fs::create_dir_all(&target_base).expect("targets");
        git(&root, &["init", "-q"]);
        git(&root, &["config", "user.email", "v3@example.invalid"]);
        git(&root, &["config", "user.name", "v3"]);
        git(&root, &["config", "core.autocrlf", "false"]);
        git(&root, &["config", "core.eol", "lf"]);
        seed_v3_files(&root, tier);
        write(&root.join(".gitignore"), "ignored.txt\n");
        if tier == "large" {
            seed_nested_repo(&root);
        }
        let files = files_under(&root);
        let first = files.keys().next().expect("file").clone();
        let second = files.keys().nth(1).expect("second").clone();
        let store = Store::init(&store_dir).expect("store");
        let mut commits = Vec::new();
        let mut slices = Vec::new();
        commits.push(commit_all(&root, "S1"));
        slices.push(
            capture_root_with_options(
                &store,
                &root,
                "ws-1",
                None,
                None,
                &CaptureOptions {
                    declared_roots: Vec::new(),
                    exclude_opaque_nested: true,
                },
            )
            .expect("capture S1")
            .slice_id,
        );
        fs::write(root.join(&first), b"v3-modified").expect("modify");
        fs::remove_file(root.join(&second)).expect("delete");
        commits.push(commit_all(&root, "S2"));
        slices.push(
            capture_root_with_options(
                &store,
                &root,
                "ws-1",
                None,
                None,
                &CaptureOptions {
                    declared_roots: Vec::new(),
                    exclude_opaque_nested: true,
                },
            )
            .expect("capture S2")
            .slice_id,
        );
        write(&root.join("added/new-file.txt"), "added");
        commits.push(commit_all(&root, "S3"));
        slices.push(
            capture_root_with_options(
                &store,
                &root,
                "ws-1",
                None,
                None,
                &CaptureOptions {
                    declared_roots: Vec::new(),
                    exclude_opaque_nested: true,
                },
            )
            .expect("capture S3")
            .slice_id,
        );
        let mut findings = Vec::new();
        let mut comparisons = Vec::new();
        for (commit, slice_id) in commits.iter().zip(&slices) {
            let store_target = target_base.join(format!("{slice_id}-store"));
            let git_target = target_base.join(format!("{slice_id}-git"));
            fs::create_dir_all(&store_target).expect("store target");
            restore_full(
                &store,
                "ws-1",
                slice_id,
                &store_target,
                &FullRestoreOptions::default(),
            )
            .expect("store restore");
            git(
                &root,
                &[
                    "worktree",
                    "add",
                    "--detach",
                    git_target.to_str().expect("target path"),
                    commit,
                ],
            );
            let target_findings =
                compare_v3_targets(&root, &store, slice_id, &store_target, &git_target, commit);
            findings.extend(target_findings);
            comparisons.push(serde_json::json!({
                "slice": slice_id,
                "commit": commit,
                "status": if findings.is_empty() { "pass" } else { "fail" },
            }));
            git(
                &root,
                &[
                    "worktree",
                    "remove",
                    "--force",
                    git_target.to_str().expect("target path"),
                ],
            );
        }
        serde_json::json!({
            "tier": tier,
            "slices": slices,
            "comparisons": comparisons,
            "findings": findings,
        })
    }

    fn run_v3_negatives(base: &Path) -> Vec<Value> {
        let root = base.join("v3-negative");
        let store_dir = base.join("v3-negative-store");
        fs::create_dir_all(&root).expect("root");
        git(&root, &["init", "-q"]);
        git(&root, &["config", "user.email", "v3@example.invalid"]);
        git(&root, &["config", "user.name", "v3"]);
        git(&root, &["config", "core.autocrlf", "false"]);
        git(&root, &["config", "core.eol", "lf"]);
        write(&root.join("a.txt"), "a");
        write(&root.join(".gitignore"), "ignored.txt\n");
        commit_all(&root, "S1");
        let store = Store::init(&store_dir).expect("store");
        let first = capture_root(&store, &root, "ws-1", None, None).expect("capture S1");
        write(&root.join("doomed.txt"), "original");
        commit_all(&root, "S2");
        capture_root(&store, &root, "ws-1", None, None).expect("capture S2");
        write(&root.join("doomed.txt"), "modified-after-capture");
        write(&root.join("new.txt"), "new");
        write(&root.join("ignored.txt"), "ignored");
        let target = base.join("v3-negative-target");
        copy_tree(&root, &target);
        restore_full(
            &store,
            "ws-1",
            &first.slice_id,
            &target,
            &FullRestoreOptions::default(),
        )
        .expect("negative restore");
        let cases = [
            (
                "modified_deletion",
                fs::read_to_string(target.join("doomed.txt"))
                    .ok()
                    .as_deref()
                    == Some("modified-after-capture"),
                fs::read_to_string(target.join("doomed.txt")).ok(),
            ),
            (
                "new_file",
                target.join("new.txt").is_file(),
                fs::read_to_string(target.join("new.txt")).ok(),
            ),
            (
                "ignored_file",
                target.join("ignored.txt").is_file(),
                fs::read_to_string(target.join("ignored.txt")).ok(),
            ),
        ];
        cases
            .into_iter()
            .map(|(case, passed, actual)| {
                serde_json::json!({
                    "case": case,
                    "status": if passed { "pass" } else { "fail" },
                    "expected": match case {
                        "modified_deletion" => "preserved (store intentionally differs from git restore)",
                        "new_file" => "preserved",
                        _ => "preserved",
                    },
                    "actual": actual,
                })
            })
            .collect()
    }

    fn seed_v3_files(root: &Path, tier: &str) {
        match tier {
            "small" => {
                for index in 0..10 {
                    write(
                        &root.join(format!("files/file-{index:02}.txt")),
                        &format!("small-{index}"),
                    );
                }
            }
            "medium" => {
                for index in 0..1000 {
                    write(
                        &root.join(format!("dir/{:02}/file-{index:04}.txt", index / 50)),
                        &format!("medium-{index}"),
                    );
                }
            }
            _ => {
                for index in 0..40 {
                    write(
                        &root.join(format!("files/file-{index:02}.txt")),
                        &format!("large-{index}"),
                    );
                }
                let long_segment = "a".repeat(100);
                write(
                    &root.join(format!("long/{long_segment}/file.txt")),
                    "long-path",
                );
                fs::create_dir_all(root.join("binary")).expect("binary dir");
                fs::write(
                    root.join("binary/blob.bin"),
                    (0u8..=255).collect::<Vec<_>>(),
                )
                .expect("binary");
            }
        }
    }

    fn seed_nested_repo(root: &Path) {
        let nested = root.join("nested");
        fs::create_dir_all(&nested).expect("nested");
        git(&nested, &["init", "-q"]);
        git(&nested, &["config", "user.email", "v3@example.invalid"]);
        git(&nested, &["config", "user.name", "v3"]);
        write(&nested.join("inner.txt"), "inner");
        commit_all(&nested, "nested base");
    }

    fn commit_all(root: &Path, message: &str) -> String {
        git(root, &["add", "-A"]);
        git(root, &["commit", "-qm", message]);
        git(root, &["rev-parse", "HEAD"])
    }

    fn git(root: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .unwrap_or_else(|error| panic!("git {args:?} spawn failed: {error}"));
        assert!(
            output.status.success(),
            "git -C {} {args:?} failed: {}",
            root.display(),
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn files_under(root: &Path) -> BTreeMap<String, PathBuf> {
        fn walk(root: &Path, current: &Path, out: &mut BTreeMap<String, PathBuf>) {
            let Ok(entries) = fs::read_dir(current) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name();
                if name == ".git" {
                    continue;
                }
                let Ok(metadata) = fs::symlink_metadata(&path) else {
                    continue;
                };
                if metadata.is_dir() {
                    walk(root, &path, out);
                } else if metadata.is_file() {
                    let relative = path
                        .strip_prefix(root)
                        .expect("relative")
                        .to_string_lossy()
                        .replace('\\', "/");
                    out.insert(relative, path);
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(root, root, &mut out);
        out
    }

    fn copy_tree(from: &Path, to: &Path) {
        for (relative, source) in files_under(from) {
            let destination = to.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).expect("copy parent");
            }
            fs::copy(source, destination).expect("copy file");
        }
    }

    fn git_tree_entries(root: &Path, commit: &str) -> BTreeMap<String, (String, u64)> {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["ls-tree", "-r", "-l", "-z", commit])
            .output()
            .expect("ls-tree");
        assert!(output.status.success(), "ls-tree failed");
        let mut out = BTreeMap::new();
        for record in output.stdout.split(|byte| *byte == 0) {
            let Some(tab) = record.iter().position(|byte| *byte == b'\t') else {
                continue;
            };
            let header = String::from_utf8_lossy(&record[..tab]);
            let path = String::from_utf8_lossy(&record[tab + 1..]).replace('\\', "/");
            let mut fields = header.split_whitespace();
            let mode = fields.next().unwrap_or_default();
            let kind = fields.next().unwrap_or_default();
            let _oid = fields.next().unwrap_or_default();
            let size = fields.next().unwrap_or_default();
            if kind != "blob" {
                continue;
            }
            out.insert(path, (mode.to_owned(), size.parse().unwrap_or(0)));
        }
        out
    }

    fn compare_v3_targets(
        root: &Path,
        store: &Store,
        slice_id: &str,
        store_target: &Path,
        git_target: &Path,
        commit: &str,
    ) -> Vec<Value> {
        let mut findings = Vec::new();
        let store_files = files_under(store_target);
        let git_files = files_under(git_target);
        for path in store_files.keys().chain(git_files.keys()) {
            match (store_files.get(path), git_files.get(path)) {
                (Some(_), None) => findings.push(serde_json::json!({
                    "kind": "path_set", "path": path.as_str(),
                    "expected": "present-in-git", "actual": "absent-in-git"
                })),
                (None, Some(_)) => findings.push(serde_json::json!({
                    "kind": "path_set", "path": path.as_str(),
                    "expected": "absent-in-store", "actual": "present-in-git"
                })),
                _ => {}
            }
        }
        let git_tree = git_tree_entries(root, commit);
        let slice_path = store.slice_dir("ws-1").join(format!("{slice_id}.json"));
        let slice: Value =
            serde_json::from_slice(&fs::read(slice_path).expect("slice")).expect("slice json");
        let manifest_id = slice["manifest"].as_str().expect("manifest id");
        let manifest = Manifest::parse_verified(
            &fs::read(store.manifest_path(manifest_id)).expect("manifest"),
            manifest_id,
        )
        .expect("manifest");
        let manifest_by_path: BTreeMap<String, &ManifestEntry> = manifest
            .entries
            .iter()
            .map(|entry| (entry.path.clone(), entry))
            .collect();
        for path in git_tree.keys().chain(manifest_by_path.keys()) {
            match (git_tree.get(path), manifest_by_path.get(path)) {
                (Some((git_mode, git_size)), Some(entry)) => {
                    if *git_mode != entry.mode.as_str() {
                        findings.push(serde_json::json!({
                            "kind": "mode", "path": path.as_str(),
                            "expected": git_mode, "actual": entry.mode.as_str()
                        }));
                    }
                    if *git_size != entry.size {
                        findings.push(serde_json::json!({
                            "kind": "size", "path": path.as_str(),
                            "expected": git_size, "actual": entry.size
                        }));
                    }
                }
                (None, Some(entry)) => findings.push(serde_json::json!({
                    "kind": "path_set", "path": path.as_str(),
                    "expected": "absent-in-git", "actual": entry.path
                })),
                (Some((_, _)), None) => findings.push(serde_json::json!({
                    "kind": "path_set", "path": path.as_str(),
                    "expected": "present-in-git", "actual": "absent-in-manifest"
                })),
                (None, None) => {}
            }
        }
        for (path, store_file) in &store_files {
            let Some(git_file) = git_files.get(path) else {
                continue;
            };
            let store_bytes = fs::read(store_file).expect("store file");
            let git_bytes = fs::read(git_file).expect("git file");
            if blob_hash(&store_bytes) != blob_hash(&git_bytes) {
                findings.push(serde_json::json!({
                    "kind": "content", "path": path.as_str(),
                    "expected": blob_hash(&git_bytes), "actual": blob_hash(&store_bytes)
                }));
            }
        }
        findings
    }
}
