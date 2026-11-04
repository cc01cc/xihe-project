//! Store-backed capture path (`FORMAT.md` §5/§6, PLAN-0653 T1.7).
//!
//! One capture = one root = one slice. The walker supplies paths/metadata,
//! blobs are content-addressed and deduplicated, the manifest is canonical
//! JSON, and the slice record is the sole visibility commit point. Captures are
//! serialized by the store lock; stat-cache hits reuse a previous blob hash and
//! skip both the file read and the blob write.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use super::blob::{MAX_BLOB_RAW_BYTES, write_blob};
use super::manifest::{FileMode, Manifest, ManifestEntry};
use super::store::{Store, StoreError};
use super::walk::{WalkEntry, WalkEntryKind, WalkIssue, WalkIssueKind, walk_workspace};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CaptureResult {
    pub slice_id: String,
    pub manifest_id: String,
    pub entry_count: usize,
    pub total_bytes: u64,
    pub blobs_new: usize,
    pub blobs_dedup: usize,
    pub cache_hits: usize,
    pub hashed_files: usize,
    pub no_change: bool,
    pub duration_ms: u64,
    pub walk_ms: u64,
    pub blob_write_ms: u64,
    pub manifest_ms: u64,
    pub lock_ms: u64,
    pub cache_read_ms: u64,
    pub cache_write_ms: u64,
    pub slice_write_ms: u64,
    pub entries_ms: u64,
    pub nested_scan_ms: u64,
    pub tail_read_ms: u64,
    pub nested_roots: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum CaptureError {
    #[error("workspace walk failed: {0}")]
    Walk(#[from] super::walk::WalkError),
    #[error("workspace walk reported issues: {0:?}")]
    WalkIssues(Vec<WalkIssue>),
    #[error("blob error: {0}")]
    Blob(#[from] super::blob::BlobError),
    #[error("manifest error: {0}")]
    Manifest(#[from] super::manifest::ManifestError),
    #[error("store error: {0}")]
    Store(#[from] StoreError),
    #[error("failed to read {path:?}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("file disappeared while reading {path:?}")]
    Vanished { path: PathBuf },
    #[error("file {path:?} is {size} bytes, above the {limit}-byte blob limit")]
    TooLarge {
        path: PathBuf,
        size: u64,
        limit: u64,
    },
    #[error("slice {path:?} is corrupt: {reason}")]
    SliceCorrupt { path: PathBuf, reason: String },
    #[error("stat cache {path:?} is corrupt: {reason}")]
    StatCacheCorrupt { path: PathBuf, reason: String },
    #[error("failed to encode capture JSON: {0}")]
    Encode(String),
    #[error("git tree references {path:?} but no changed blob or previous manifest entry exists")]
    MissingGitBlob { path: String },
    #[error("git blob size mismatch for {path:?}: expected {expected}, got {actual}")]
    GitBlobSizeMismatch {
        path: String,
        expected: u64,
        actual: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StatCacheEntry {
    hash: String,
    size: u64,
    mtime_ns: u64,
    #[serde(default)]
    file_id: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StatCacheFile {
    v: u8,
    entries: HashMap<String, StatCacheEntry>,
}

#[derive(Debug, Clone)]
pub(crate) struct TailSlice {
    pub(crate) id: String,
    pub(crate) manifest: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn mtime_ns(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0)
}

#[cfg(unix)]
fn file_identity(metadata: &fs::Metadata, _path: &Path) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    Some(format!("{}:{}", metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
fn file_identity(_metadata: &fs::Metadata, path: &Path) -> Option<String> {
    windows_file_identity(path)
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn windows_file_identity(path: &Path) -> Option<String> {
    use std::ffi::c_void;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;

    const FILE_READ_ATTRIBUTES: u32 = 0x80;
    const FILE_SHARE_READ_WRITE_DELETE: u32 = 0x7;

    #[repr(C)]
    struct ByHandleFileInformation {
        file_attributes: u32,
        creation_time: [u32; 2],
        last_access_time: [u32; 2],
        last_write_time: [u32; 2],
        volume_serial_number: u32,
        file_size_high: u32,
        file_size_low: u32,
        number_of_links: u32,
        file_index_high: u32,
        file_index_low: u32,
    }

    unsafe extern "system" {
        fn GetFileInformationByHandle(
            handle: *mut c_void,
            information: *mut ByHandleFileInformation,
        ) -> i32;
    }

    let file = fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ_WRITE_DELETE)
        .open(path)
        .ok()?;
    let mut information = ByHandleFileInformation {
        file_attributes: 0,
        creation_time: [0; 2],
        last_access_time: [0; 2],
        last_write_time: [0; 2],
        volume_serial_number: 0,
        file_size_high: 0,
        file_size_low: 0,
        number_of_links: 0,
        file_index_high: 0,
        file_index_low: 0,
    };
    // SAFETY: `file` owns a live HANDLE for the duration of the call and
    // `information` is a valid, correctly-sized out-parameter.
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) };
    if ok == 0 {
        return None;
    }
    let index = ((information.file_index_high as u64) << 32) | information.file_index_low as u64;
    Some(format!("{}:{}", information.volume_serial_number, index))
}

#[cfg(not(any(unix, windows)))]
fn file_identity(_metadata: &fs::Metadata, _path: &Path) -> Option<String> {
    None
}

fn file_identity_at(path: &Path) -> Option<String> {
    #[cfg(windows)]
    {
        windows_file_identity(path)
    }
    #[cfg(unix)]
    {
        fs::metadata(path)
            .ok()
            .and_then(|metadata| file_identity(&metadata, path))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        None
    }
}

fn cache_matches(cached: &StatCacheEntry, size: u64, mtime: u64, file_id: Option<&str>) -> bool {
    if cached.size != size || cached.mtime_ns != mtime {
        return false;
    }
    match (cached.file_id.as_deref(), file_id) {
        (Some(cached_id), Some(current_id)) => cached_id == current_id,
        // Old v1 caches did not carry an identity; fall back to size+mtime and
        // record the known risk in FORMAT §6.
        (None, None) => true,
        _ => false,
    }
}

fn read_cache(
    store: &Store,
    root_id: &str,
) -> Result<HashMap<String, StatCacheEntry>, CaptureError> {
    let path = store.stat_cache_path(root_id);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(source) => {
            return Err(CaptureError::Read { path, source });
        }
    };
    let cache: StatCacheFile =
        serde_json::from_slice(&bytes).map_err(|error| CaptureError::StatCacheCorrupt {
            path: path.clone(),
            reason: error.to_string(),
        })?;
    if cache.v != 1 {
        return Err(CaptureError::StatCacheCorrupt {
            path,
            reason: format!("unsupported stat cache version {}", cache.v),
        });
    }
    Ok(cache.entries)
}

fn write_cache(
    store: &Store,
    root_id: &str,
    entries: HashMap<String, StatCacheEntry>,
) -> Result<(), CaptureError> {
    let path = store.stat_cache_path(root_id);
    let bytes = serde_json::to_vec(&StatCacheFile { v: 1, entries })
        .map_err(|error| CaptureError::Encode(error.to_string()))?;
    store.write_atomic(&path, &bytes)?;
    Ok(())
}

pub(crate) fn tail_slice(store: &Store, root_id: &str) -> Result<Option<TailSlice>, CaptureError> {
    let dir = store.slice_dir(root_id);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(CaptureError::Read { path: dir, source });
        }
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    paths.sort();
    let Some(path) = paths.last() else {
        return Ok(None);
    };
    let bytes = fs::read(path).map_err(|source| CaptureError::Read {
        path: path.clone(),
        source,
    })?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|error| CaptureError::SliceCorrupt {
            path: path.clone(),
            reason: error.to_string(),
        })?;
    let id = value
        .get("id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| CaptureError::SliceCorrupt {
            path: path.clone(),
            reason: "missing id".into(),
        })?
        .to_owned();
    let manifest = value
        .get("manifest")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| CaptureError::SliceCorrupt {
            path: path.clone(),
            reason: "missing manifest".into(),
        })?
        .to_owned();
    Ok(Some(TailSlice { id, manifest }))
}

pub(crate) fn read_tail_manifest(
    store: &Store,
    tail: &TailSlice,
) -> Result<Manifest, CaptureError> {
    let path = store.manifest_path(&tail.manifest);
    let bytes = fs::read(&path).map_err(|source| CaptureError::Read {
        path: path.clone(),
        source,
    })?;
    Ok(Manifest::parse(&bytes)?)
}

fn file_metadata(path: &Path) -> Result<fs::Metadata, CaptureError> {
    fs::metadata(path).map_err(|source| {
        if source.kind() == std::io::ErrorKind::NotFound {
            CaptureError::Vanished {
                path: path.to_path_buf(),
            }
        } else {
            CaptureError::Read {
                path: path.to_path_buf(),
                source,
            }
        }
    })
}

fn read_file(path: &Path) -> Result<Vec<u8>, CaptureError> {
    fs::read(path).map_err(|source| {
        if source.kind() == std::io::ErrorKind::NotFound {
            CaptureError::Vanished {
                path: path.to_path_buf(),
            }
        } else {
            CaptureError::Read {
                path: path.to_path_buf(),
                source,
            }
        }
    })
}

/// Fast path: if every file is a stat-cache hit and matches the tail manifest
/// exactly, the slice is unchanged and no manifest needs to be rebuilt.
fn fast_no_change(
    store: &Store,
    tail: &TailSlice,
    entries: &[WalkEntry],
    cache: &HashMap<String, StatCacheEntry>,
) -> Result<Option<usize>, CaptureError> {
    let manifest = read_tail_manifest(store, tail)?;
    if manifest.entries.len() != entries.len() {
        return Ok(None);
    }
    let by_path: HashMap<&str, &ManifestEntry> = manifest
        .entries
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect();
    for entry in entries {
        let Some(tail_entry) = by_path.get(entry.path.as_str()) else {
            return Ok(None);
        };
        if entry.kind != WalkEntryKind::File || entry.mode != tail_entry.mode {
            return Ok(None);
        }
        let size = entry.size;
        let mtime = entry.mtime_ns;
        let file_id = file_identity_at(&entry.absolute_path);
        if size != tail_entry.size {
            return Ok(None);
        }
        let Some(cached) = cache.get(&entry.path) else {
            return Ok(None);
        };
        if !cache_matches(cached, size, mtime, file_id.as_deref())
            || cached.hash != tail_entry.blob_hash
        {
            return Ok(None);
        }
    }
    Ok(Some(entries.len()))
}

fn exclusion_patterns(root: &Path) -> (Vec<String>, Vec<String>) {
    // PLAN-0641 M5: the store capture (self mode) keeps the primary-root table; per-root
    // grading is applied on the git-path capture surface (T6.1 scope).
    let mut patterns: Vec<String> = crate::checkpoint::ExcludeProfile::PrimaryRoot
        .patterns()
        .map(str::to_owned)
        .collect();
    let mut gitignore_files = Vec::new();
    if root.join(".gitignore").is_file() {
        patterns.push("gitignore:.gitignore".into());
        gitignore_files.push(".gitignore".into());
    }
    (patterns, gitignore_files)
}

fn declared_or_child(declared_roots: &[String], path: &str) -> bool {
    declared_roots
        .iter()
        .any(|declared| path == declared || path.starts_with(&format!("{declared}/")))
}

#[cfg(windows)]
fn is_reparse_dir(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    fs::symlink_metadata(path)
        .map(|metadata| {
            metadata.is_dir() && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        })
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn is_reparse_dir(_path: &Path) -> bool {
    false
}

fn has_git_marker(dir: &Path) -> bool {
    let marker = dir.join(".git");
    let Ok(metadata) = fs::symlink_metadata(&marker) else {
        return false;
    };
    if metadata.is_dir() {
        return true;
    }
    if !metadata.is_file() {
        return false;
    }
    fs::read_to_string(&marker)
        .map(|contents| contents.trim_start().starts_with("gitdir:"))
        .unwrap_or(false)
}

fn gitmodule_paths(dir: &Path) -> Vec<String> {
    let Ok(contents) = fs::read_to_string(dir.join(".gitmodules")) else {
        return Vec::new();
    };
    contents
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let rest = line.strip_prefix("path")?.trim_start();
            let value = rest.strip_prefix('=')?.trim();
            if value.is_empty()
                || value.starts_with('/')
                || value.split('/').any(|part| part == "..")
            {
                return None;
            }
            Some(value.replace('\\', "/"))
        })
        .collect()
}

/// Discover nested repositories by reading `.git` markers and `.gitmodules`
/// directly (no git subprocess). Declared roots are excluded because they own
/// their own slice chain (0639 multi-root semantics).
fn discover_nested_roots(
    root: &Path,
    declared_roots: &[String],
) -> Result<Vec<String>, CaptureError> {
    let mut found = std::collections::BTreeSet::new();
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, relative)) = stack.pop() {
        if !relative.is_empty() && has_git_marker(&dir) {
            if !declared_or_child(declared_roots, &relative) {
                found.insert(relative);
            }
            continue;
        }
        for submodule in gitmodule_paths(&dir) {
            let relative_path = if relative.is_empty() {
                submodule
            } else {
                format!("{relative}/{submodule}")
            };
            let absolute = root.join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
            if absolute.is_dir() && !declared_or_child(declared_roots, &relative_path) {
                found.insert(relative_path);
            }
        }
        let entries = fs::read_dir(&dir).map_err(|source| CaptureError::Read {
            path: dir.clone(),
            source,
        })?;
        for entry in entries {
            let entry = entry.map_err(|source| CaptureError::Read {
                path: dir.clone(),
                source,
            })?;
            let name = entry.file_name();
            if name == std::ffi::OsStr::new(".git") {
                continue;
            }
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|source| CaptureError::Read {
                path: path.clone(),
                source,
            })?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() || is_reparse_dir(&path) {
                continue;
            }
            let Some(name) = name.to_str() else {
                continue;
            };
            let child = if relative.is_empty() {
                name.to_owned()
            } else {
                format!("{relative}/{name}")
            };
            if !found.contains(&child) {
                stack.push((path, child));
            }
        }
    }
    Ok(found.into_iter().collect())
}

/// Capture behavior for store callers. `exclude_opaque_nested` is used by the
/// P1 dual-write path: git `Opaque` records only a gitlink, so the store must
/// not add nested contents to entries; nested roots remain in slice metadata.
#[derive(Debug, Clone, Default)]
pub struct CaptureOptions {
    pub declared_roots: Vec<String>,
    pub exclude_opaque_nested: bool,
    /// Test-only crash hook: panic after N files have been hashed in this capture.
    #[cfg(test)]
    pub crash_after_files: Option<usize>,
    /// Test-only crash hook: panic after the manifest rename but before the slice
    /// record is committed, leaving an orphan manifest.
    #[cfg(test)]
    pub crash_before_slice_commit: bool,
}

/// Capture one root into the store. The caller decides which roots exist; this
/// function never combines roots into one slice.
#[allow(clippy::needless_update)]
pub fn capture_root(
    store: &Store,
    root: &Path,
    root_id: &str,
    run_id: Option<&str>,
    principal_id: Option<&str>,
) -> Result<CaptureResult, CaptureError> {
    capture_root_with_options(
        store,
        root,
        root_id,
        run_id,
        principal_id,
        &CaptureOptions::default(),
    )
}

/// Capture one root, excluding workspace-declared roots from `nested_roots`
/// (0639 multi-root semantics: a declared root owns its own slice chain).
#[allow(clippy::needless_update)]
pub fn capture_root_with_declared_roots(
    store: &Store,
    root: &Path,
    root_id: &str,
    run_id: Option<&str>,
    principal_id: Option<&str>,
    declared_roots: &[String],
) -> Result<CaptureResult, CaptureError> {
    capture_root_with_options(
        store,
        root,
        root_id,
        run_id,
        principal_id,
        &CaptureOptions {
            declared_roots: declared_roots.to_vec(),
            exclude_opaque_nested: false,
            ..CaptureOptions::default()
        },
    )
}

pub fn capture_root_with_options(
    store: &Store,
    root: &Path,
    root_id: &str,
    run_id: Option<&str>,
    principal_id: Option<&str>,
    options: &CaptureOptions,
) -> Result<CaptureResult, CaptureError> {
    let started = Instant::now();
    let lock_started = Instant::now();
    let _lock = store.lock_root(root_id)?;
    let lock_ms = lock_started.elapsed().as_millis() as u64;
    let walk_started = Instant::now();
    let walk = walk_workspace(root)?;
    let walk_ms = walk_started.elapsed().as_millis() as u64;
    if !walk.issues.is_empty() {
        return Err(CaptureError::WalkIssues(walk.issues));
    }
    let nested_started = Instant::now();
    let nested_roots = discover_nested_roots(root, &options.declared_roots)?;
    let nested_scan_ms = nested_started.elapsed().as_millis() as u64;
    let walk_entries: Vec<WalkEntry> = if options.exclude_opaque_nested {
        walk.entries
            .into_iter()
            .filter(|entry| {
                let under_nested = nested_roots.iter().any(|nested| {
                    entry.path == *nested || entry.path.starts_with(&format!("{nested}/"))
                });
                let under_declared = options.declared_roots.iter().any(|declared| {
                    entry.path == *declared || entry.path.starts_with(&format!("{declared}/"))
                });
                !under_nested && !under_declared
            })
            .collect()
    } else {
        walk.entries
    };
    let cache_started = Instant::now();
    let cache = read_cache(store, root_id)?;
    let cache_read_ms = cache_started.elapsed().as_millis() as u64;
    let tail_started = Instant::now();
    let tail = tail_slice(store, root_id)?;
    let tail_read_ms = tail_started.elapsed().as_millis() as u64;

    if let Some(tail) = &tail
        && let Some(hits) = fast_no_change(store, tail, &walk_entries, &cache)?
    {
        let manifest = read_tail_manifest(store, tail)?;
        return Ok(CaptureResult {
            slice_id: tail.id.clone(),
            manifest_id: tail.manifest.clone(),
            entry_count: manifest.entries.len(),
            total_bytes: manifest.total_bytes,
            cache_hits: hits,
            hashed_files: 0,
            no_change: true,
            duration_ms: started.elapsed().as_millis() as u64,
            walk_ms,
            blob_write_ms: 0,
            manifest_ms: 0,
            lock_ms,
            cache_read_ms,
            cache_write_ms: 0,
            slice_write_ms: 0,
            entries_ms: 0,
            nested_scan_ms,
            tail_read_ms,
            nested_roots,
            ..CaptureResult::default()
        });
    }

    let mut entries = Vec::with_capacity(walk_entries.len());
    let mut next_cache = HashMap::with_capacity(walk_entries.len());
    let mut blobs_new = 0;
    let mut blobs_dedup = 0;
    let mut cache_hits = 0;
    let mut hashed_files = 0;
    let mut total_bytes = 0u64;
    let mut blob_write_ms = 0u64;

    let entries_started = Instant::now();
    for walk_entry in &walk_entries {
        match walk_entry.kind {
            WalkEntryKind::File => {
                let metadata = file_metadata(&walk_entry.absolute_path)?;
                let size = metadata.len();
                if size > MAX_BLOB_RAW_BYTES {
                    return Err(CaptureError::TooLarge {
                        path: walk_entry.absolute_path.clone(),
                        size,
                        limit: MAX_BLOB_RAW_BYTES,
                    });
                }
                let mtime = mtime_ns(&metadata);
                let file_id = file_identity(&metadata, &walk_entry.absolute_path);
                let hash = match cache.get(&walk_entry.path) {
                    Some(cached) if cache_matches(cached, size, mtime, file_id.as_deref()) => {
                        cache_hits += 1;
                        cached.hash.clone()
                    }
                    _ => {
                        let bytes = read_file(&walk_entry.absolute_path)?;
                        if bytes.len() as u64 > MAX_BLOB_RAW_BYTES {
                            return Err(CaptureError::TooLarge {
                                path: walk_entry.absolute_path.clone(),
                                size: bytes.len() as u64,
                                limit: MAX_BLOB_RAW_BYTES,
                            });
                        }
                        hashed_files += 1;
                        let blob_started = Instant::now();
                        let outcome = write_blob(store.root(), &bytes)?;
                        blob_write_ms += blob_started.elapsed().as_millis() as u64;
                        #[cfg(test)]
                        if let Some(after_files) = options.crash_after_files
                            && hashed_files >= after_files
                        {
                            panic!("injected capture crash after {after_files} files");
                        }
                        if outcome.deduped {
                            blobs_dedup += 1;
                        } else {
                            blobs_new += 1;
                        }
                        outcome.hash
                    }
                };
                next_cache.insert(
                    walk_entry.path.clone(),
                    StatCacheEntry {
                        hash: hash.clone(),
                        size,
                        mtime_ns: mtime,
                        file_id,
                    },
                );
                total_bytes = total_bytes.saturating_add(size);
                entries.push(ManifestEntry::new(
                    walk_entry.path.clone(),
                    walk_entry.mode,
                    size,
                    hash,
                )?);
            }
            WalkEntryKind::Symlink => {
                let Some(target) = walk_entry.symlink_target.as_deref() else {
                    return Err(CaptureError::WalkIssues(vec![WalkIssue {
                        path: Some(walk_entry.path.clone()),
                        kind: WalkIssueKind::ReparseUnreadable,
                        message: "symlink entry has no target".into(),
                    }]));
                };
                let blob_started = Instant::now();
                let outcome = write_blob(store.root(), target.as_bytes())?;
                blob_write_ms += blob_started.elapsed().as_millis() as u64;
                if outcome.deduped {
                    blobs_dedup += 1;
                } else {
                    blobs_new += 1;
                }
                let size = target.len() as u64;
                total_bytes = total_bytes.saturating_add(size);
                entries.push(ManifestEntry::new(
                    walk_entry.path.clone(),
                    FileMode::Symlink,
                    size,
                    outcome.hash,
                )?);
            }
        }
    }

    let entries_ms = (entries_started.elapsed().as_millis() as u64).saturating_sub(blob_write_ms);

    let manifest_started = Instant::now();
    let manifest = Manifest::from_entries(entries)?;
    let manifest_bytes = manifest.canonical_bytes()?;
    let manifest_id = manifest.manifest_id()?;
    let manifest_ms = manifest_started.elapsed().as_millis() as u64;
    store.write_atomic(&store.manifest_path(&manifest_id), &manifest_bytes)?;

    let cache_write = || write_cache(store, root_id, next_cache.clone());
    let mut cache_write_ms = 0u64;
    if let Some(tail) = &tail
        && tail.manifest == manifest_id
    {
        let cache_started = Instant::now();
        if let Err(error) = cache_write() {
            tracing::warn!(root_id, %error, "checkpoint stat cache write failed");
        }
        cache_write_ms = cache_started.elapsed().as_millis() as u64;
        return Ok(CaptureResult {
            slice_id: tail.id.clone(),
            manifest_id,
            entry_count: manifest.entries.len(),
            total_bytes: manifest.total_bytes,
            blobs_new,
            blobs_dedup,
            cache_hits,
            hashed_files,
            no_change: true,
            duration_ms: started.elapsed().as_millis() as u64,
            walk_ms,
            blob_write_ms,
            manifest_ms,
            lock_ms,
            cache_read_ms,
            cache_write_ms,
            slice_write_ms: 0,
            entries_ms,
            nested_scan_ms,
            tail_read_ms,
            nested_roots,
        });
    }

    let captured_at = Utc::now();
    let captured_at_ms = now_ms();
    let slice_id = format!("{captured_at_ms:013}-{}", &manifest_id[..12]);
    let slice_path = store.slice_dir(root_id).join(format!("{slice_id}.json"));
    let (patterns, gitignore_files) = exclusion_patterns(root);
    let stats = serde_json::json!({
        "scanned_files": walk_entries.len(),
        "hashed_files": hashed_files,
        "hashed_bytes": manifest.total_bytes,
        "cache_hits": cache_hits,
        "blobs_new": blobs_new,
        "blobs_dedup": blobs_dedup,
        "reparse_skipped": [],
        "non_utf8_skipped": [],
        "suspects": [],
        "warnings": [],
        "duration_ms": started.elapsed().as_millis() as u64,
        "walk_ms": walk_ms,
        "blob_write_ms": blob_write_ms,
        "manifest_ms": manifest_ms,
        "lock_ms": lock_ms,
        "cache_read_ms": cache_read_ms,
        "cache_write_ms": cache_write_ms,
    });
    let slice = serde_json::json!({
        "v": 1,
        "id": slice_id,
        "parent": tail.as_ref().map(|tail| tail.id.clone()),
        "root_id": root_id,
        "run_id": run_id,
        "principal_id": principal_id,
        "captured_at_ms": captured_at_ms,
        "captured_at": captured_at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        "manifest": manifest_id,
        "merkle_root": manifest.merkle_root,
        "entry_count": manifest.entries.len(),
        "total_bytes": manifest.total_bytes,
        "exclusion_patterns": patterns,
        "gitignore_files": gitignore_files,
        "nested_roots": nested_roots.clone(),
        "stats": stats,
        "state": "captured",
        "migrated_from": serde_json::Value::Null,
    });
    let slice_write_started = Instant::now();
    let slice_bytes =
        serde_json::to_vec(&slice).map_err(|error| CaptureError::Encode(error.to_string()))?;
    #[cfg(test)]
    if options.crash_before_slice_commit {
        panic!("injected capture crash before slice record commit");
    }
    store.write_atomic(&slice_path, &slice_bytes)?;
    let slice_write_ms = slice_write_started.elapsed().as_millis() as u64;
    let cache_started = Instant::now();
    if let Err(error) = cache_write() {
        tracing::warn!(root_id, %error, "checkpoint stat cache write failed");
    }
    cache_write_ms = cache_started.elapsed().as_millis() as u64;

    Ok(CaptureResult {
        slice_id,
        manifest_id,
        entry_count: manifest.entries.len(),
        total_bytes: manifest.total_bytes,
        blobs_new,
        blobs_dedup,
        cache_hits,
        hashed_files,
        no_change: false,
        duration_ms: started.elapsed().as_millis() as u64,
        walk_ms,
        blob_write_ms,
        manifest_ms,
        lock_ms,
        cache_read_ms,
        cache_write_ms,
        slice_write_ms,
        entries_ms,
        nested_scan_ms,
        tail_read_ms,
        nested_roots,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitTreeEntry {
    pub path: String,
    pub mode: FileMode,
    pub size: u64,
    pub oid: String,
}

/// Git-fed capture used only for `dual` + `Opaque`. Entries and sizes come from
/// `git ls-tree`; `changed_blobs` carries raw content for paths whose git tree
/// changed (all paths on the first slice), while unchanged paths reuse the
/// previous store manifest hash.
pub fn capture_from_git_entries(
    store: &Store,
    root_id: &str,
    run_id: Option<&str>,
    principal_id: Option<&str>,
    entries: &[GitTreeEntry],
    changed_blobs: &HashMap<String, Vec<u8>>,
    nested_roots: Vec<String>,
) -> Result<CaptureResult, CaptureError> {
    let started = Instant::now();
    let lock_started = Instant::now();
    let _lock = store.lock_root(root_id)?;
    let lock_ms = lock_started.elapsed().as_millis() as u64;
    let tail = tail_slice(store, root_id)?;
    let previous = match &tail {
        Some(tail) => Some(read_tail_manifest(store, tail)?),
        None => None,
    };
    let previous_entries: HashMap<&str, &ManifestEntry> = previous
        .as_ref()
        .map(|manifest| {
            manifest
                .entries
                .iter()
                .map(|entry| (entry.path.as_str(), entry))
                .collect()
        })
        .unwrap_or_default();

    let mut manifest_entries = Vec::with_capacity(entries.len());
    let mut blobs_new = 0;
    let mut blobs_dedup = 0;
    let mut hashed_files = 0;
    let mut blob_write_ms = 0u64;
    for entry in entries {
        let (hash, size) = if let Some(bytes) = changed_blobs.get(&entry.path) {
            let size = bytes.len() as u64;
            if size != entry.size {
                return Err(CaptureError::GitBlobSizeMismatch {
                    path: entry.path.clone(),
                    expected: entry.size,
                    actual: size,
                });
            }
            let started = Instant::now();
            let outcome = write_blob(store.root(), bytes)?;
            blob_write_ms += started.elapsed().as_millis() as u64;
            if outcome.deduped {
                blobs_dedup += 1;
            } else {
                blobs_new += 1;
            }
            hashed_files += 1;
            (outcome.hash, size)
        } else {
            let Some(previous) = previous_entries.get(entry.path.as_str()) else {
                return Err(CaptureError::MissingGitBlob {
                    path: entry.path.clone(),
                });
            };
            if previous.mode != entry.mode || previous.size != entry.size {
                return Err(CaptureError::GitBlobSizeMismatch {
                    path: entry.path.clone(),
                    expected: entry.size,
                    actual: previous.size,
                });
            }
            (previous.blob_hash.clone(), previous.size)
        };
        manifest_entries.push(ManifestEntry::new(
            entry.path.clone(),
            entry.mode,
            size,
            hash,
        )?);
    }

    let manifest_started = Instant::now();
    let manifest = Manifest::from_entries(manifest_entries)?;
    let manifest_bytes = manifest.canonical_bytes()?;
    let manifest_id = manifest.manifest_id()?;
    let manifest_ms = manifest_started.elapsed().as_millis() as u64;
    store.write_atomic(&store.manifest_path(&manifest_id), &manifest_bytes)?;

    let no_change = tail
        .as_ref()
        .is_some_and(|tail| tail.manifest == manifest_id);
    if no_change {
        return Ok(CaptureResult {
            slice_id: tail
                .as_ref()
                .map(|tail| tail.id.clone())
                .unwrap_or_default(),
            manifest_id,
            entry_count: manifest.entries.len(),
            total_bytes: manifest.total_bytes,
            blobs_new,
            blobs_dedup,
            hashed_files,
            no_change: true,
            duration_ms: started.elapsed().as_millis() as u64,
            blob_write_ms,
            manifest_ms,
            lock_ms,
            slice_write_ms: 0,
            nested_roots,
            ..CaptureResult::default()
        });
    }

    let captured_at = Utc::now();
    let captured_at_ms = now_ms();
    let slice_id = format!("{captured_at_ms:013}-{}", &manifest_id[..12]);
    let slice_path = store.slice_dir(root_id).join(format!("{slice_id}.json"));
    let (patterns, gitignore_files) = exclusion_patterns(Path::new(""));
    let slice = serde_json::json!({
        "v": 1,
        "id": slice_id,
        "parent": tail.as_ref().map(|tail| tail.id.clone()),
        "root_id": root_id,
        "run_id": run_id,
        "principal_id": principal_id,
        "captured_at_ms": captured_at_ms,
        "captured_at": captured_at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        "manifest": manifest_id,
        "merkle_root": manifest.merkle_root,
        "entry_count": manifest.entries.len(),
        "total_bytes": manifest.total_bytes,
        "exclusion_patterns": patterns,
        "gitignore_files": gitignore_files,
        "nested_roots": nested_roots.clone(),
        "stats": {
            "scanned_files": entries.len(),
            "hashed_files": hashed_files,
            "hashed_bytes": manifest.total_bytes,
            "cache_hits": 0,
            "blobs_new": blobs_new,
            "blobs_dedup": blobs_dedup,
            "reparse_skipped": [],
            "non_utf8_skipped": [],
            "suspects": [],
            "warnings": [],
            "duration_ms": started.elapsed().as_millis() as u64,
            "walk_ms": 0,
            "blob_write_ms": blob_write_ms,
            "manifest_ms": manifest_ms,
            "lock_ms": lock_ms,
        },
        "state": "captured",
        "migrated_from": serde_json::Value::Null,
    });
    let slice_write_started = Instant::now();
    let slice_bytes =
        serde_json::to_vec(&slice).map_err(|error| CaptureError::Encode(error.to_string()))?;
    store.write_atomic(&slice_path, &slice_bytes)?;
    let slice_write_ms = slice_write_started.elapsed().as_millis() as u64;

    Ok(CaptureResult {
        slice_id,
        manifest_id,
        entry_count: manifest.entries.len(),
        total_bytes: manifest.total_bytes,
        blobs_new,
        blobs_dedup,
        hashed_files,
        no_change: false,
        duration_ms: started.elapsed().as_millis() as u64,
        blob_write_ms,
        manifest_ms,
        lock_ms,
        slice_write_ms,
        nested_roots,
        ..CaptureResult::default()
    })
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    fn workspace() -> tempfile::TempDir {
        tempfile::tempdir().expect("workspace")
    }

    fn write_file(root: &Path, relative: &str, content: &[u8]) {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent");
        }
        let mut file = fs::File::create(path).expect("file");
        file.write_all(content).expect("content");
    }

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().expect("store");
        let store = Store::init(dir.path()).expect("init");
        (dir, store)
    }

    fn slice_files(store: &Store, root_id: &str) -> usize {
        fs::read_dir(store.slice_dir(root_id))
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
                    .count()
            })
            .unwrap_or(0)
    }

    fn manifest_files(store: &Store) -> usize {
        fn walk(dir: &Path, count: &mut usize) {
            let Ok(entries) = fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, count);
                } else if path.extension().is_some_and(|ext| ext == "json") {
                    *count += 1;
                }
            }
        }
        let mut count = 0;
        walk(&store.root().join("manifests"), &mut count);
        count
    }

    #[test]
    fn crash_after_files_leaves_store_readable_and_committed_slice_intact() {
        let workspace = workspace();
        for index in 0..10 {
            write_file(
                workspace.path(),
                &format!("files/f{index}.txt"),
                format!("file-{index}").as_bytes(),
            );
        }
        let (_store_dir, store) = store();
        let baseline =
            capture_root(&store, workspace.path(), "ws-1", None, None).expect("baseline");
        for index in 0..10 {
            write_file(
                workspace.path(),
                &format!("files/f{index}.txt"),
                format!("changed-{index}").as_bytes(),
            );
        }
        let crash = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            capture_root_with_options(
                &store,
                workspace.path(),
                "ws-1",
                None,
                None,
                &CaptureOptions {
                    crash_after_files: Some(3),
                    ..CaptureOptions::default()
                },
            )
            .expect("injected panic must not return")
        }));
        assert!(crash.is_err(), "crash hook must panic");
        assert_eq!(slice_files(&store, "ws-1"), 1);
        let report = crate::checkpoint_store::fsck::fsck_store(&store, false).expect("fsck");
        assert!(
            report.findings.iter().all(|finding| {
                finding.kind == crate::checkpoint_store::fsck::FsckFindingKind::OrphanBlob
            }),
            "crash may leave orphan blobs, never corrupt references: {report:?}"
        );
        let after = capture_root(&store, workspace.path(), "ws-1", None, None).expect("recover");
        assert_ne!(after.slice_id, baseline.slice_id);
    }

    #[test]
    fn crash_before_slice_commit_leaves_orphan_manifest_only() {
        let workspace = workspace();
        write_file(workspace.path(), "a.txt", b"a");
        let (_store_dir, store) = store();
        capture_root(&store, workspace.path(), "ws-1", None, None).expect("baseline");
        let before_manifests = manifest_files(&store);
        write_file(workspace.path(), "b.txt", b"b");
        let crash = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            capture_root_with_options(
                &store,
                workspace.path(),
                "ws-1",
                None,
                None,
                &CaptureOptions {
                    crash_before_slice_commit: true,
                    ..CaptureOptions::default()
                },
            )
            .expect("injected panic must not return")
        }));
        assert!(crash.is_err(), "crash hook must panic");
        assert_eq!(slice_files(&store, "ws-1"), 1, "no new slice committed");
        assert!(
            manifest_files(&store) > before_manifests,
            "manifest must already be renamed"
        );
        let report = crate::checkpoint_store::fsck::fsck_store(&store, false).expect("fsck");
        assert!(report.is_clean(), "{report:?}");
        capture_root(&store, workspace.path(), "ws-1", None, None).expect("recover");
    }

    #[test]
    fn capture_writes_blobs_manifest_and_one_slice() {
        let workspace = workspace();
        write_file(workspace.path(), "a.txt", b"alpha");
        write_file(workspace.path(), "dir/b.bin", &[0u8; 1024]);
        let (_store_dir, store) = store();

        let result = capture_root(
            &store,
            workspace.path(),
            "ws-1",
            Some("run-1"),
            Some("user-1"),
        )
        .expect("capture");
        assert!(!result.no_change);
        assert_eq!(result.entry_count, 2);
        assert_eq!(result.hashed_files, 2);
        assert_eq!(slice_files(&store, "ws-1"), 1);
        assert!(store.manifest_path(&result.manifest_id).is_file());
        assert!(
            store
                .slice_dir("ws-1")
                .join(format!("{}.json", result.slice_id))
                .is_file()
        );
    }

    #[test]
    fn second_capture_hits_stat_cache_and_reports_no_change() {
        let workspace = workspace();
        for index in 0..64 {
            write_file(
                workspace.path(),
                &format!("dir/{index:03}.txt"),
                format!("file-{index}").as_bytes(),
            );
        }
        let (_store_dir, store) = store();

        let first = capture_root(&store, workspace.path(), "ws-1", None, None).expect("first");
        let second = capture_root(&store, workspace.path(), "ws-1", None, None).expect("second");
        eprintln!(
            "no-change first={}ms second={}ms cache_hits={} hashed_files={}",
            first.duration_ms, second.duration_ms, second.cache_hits, second.hashed_files
        );
        assert!(!first.no_change);
        assert!(second.no_change);
        assert_eq!(second.slice_id, first.slice_id);
        assert_eq!(second.cache_hits, 64);
        assert_eq!(second.hashed_files, 0);
        assert_eq!(second.blobs_new, 0);
        assert_eq!(slice_files(&store, "ws-1"), 1);
    }

    #[test]
    fn capture_fails_on_oversized_file_before_writing_a_slice() {
        let workspace = workspace();
        let huge = workspace.path().join("huge.bin");
        let file = fs::File::create(&huge).expect("huge");
        file.set_len(MAX_BLOB_RAW_BYTES + 1).expect("set_len");
        let (_store_dir, store) = store();

        let error = capture_root(&store, workspace.path(), "ws-1", None, None)
            .expect_err("oversized file must fail");
        assert!(matches!(error, CaptureError::WalkIssues(_)));
        assert_eq!(slice_files(&store, "ws-1"), 0);
    }

    #[test]
    fn missing_file_read_maps_to_vanished() {
        let error = read_file(Path::new("capture-does-not-exist")).expect_err("missing file");
        assert!(matches!(error, CaptureError::Vanished { .. }), "{error:?}");
    }

    #[test]
    fn capture_fails_when_store_cannot_write_manifest() {
        let workspace = workspace();
        write_file(workspace.path(), "a.txt", b"alpha");
        let (_store_dir, store) = store();
        let manifests = store.root().join("manifests");
        fs::remove_dir_all(&manifests).expect("remove manifests dir");
        fs::write(&manifests, b"not a directory").expect("break manifests");

        let error = capture_root(&store, workspace.path(), "ws-1", None, None)
            .expect_err("store write must fail");
        assert!(matches!(error, CaptureError::Store(_)), "{error:?}");
        assert_eq!(slice_files(&store, "ws-1"), 0);
    }

    #[test]
    fn two_roots_capture_independent_slices() {
        let first_workspace = workspace();
        let second_workspace = workspace();
        write_file(first_workspace.path(), "only-a.txt", b"a");
        write_file(second_workspace.path(), "only-b.txt", b"b");
        let (_store_dir, store) = store();

        let a = capture_root(&store, first_workspace.path(), "root-a", None, None).expect("a");
        let b = capture_root(&store, second_workspace.path(), "root-b", None, None).expect("b");
        assert_ne!(a.slice_id, b.slice_id);
        assert_eq!(slice_files(&store, "root-a"), 1);
        assert_eq!(slice_files(&store, "root-b"), 1);
        let slice_a: serde_json::Value = serde_json::from_slice(
            &fs::read(
                store
                    .slice_dir("root-a")
                    .join(format!("{}.json", a.slice_id)),
            )
            .expect("read a"),
        )
        .expect("json a");
        assert_eq!(slice_a["root_id"], "root-a");
    }

    #[test]
    fn failed_root_does_not_write_its_own_slice_or_block_other_roots() {
        let good = workspace();
        write_file(good.path(), "good.txt", b"good");
        let bad = workspace();
        let huge = bad.path().join("huge.bin");
        fs::File::create(&huge)
            .expect("huge")
            .set_len(MAX_BLOB_RAW_BYTES + 1)
            .expect("set_len");
        let (_store_dir, store) = store();

        capture_root(&store, good.path(), "good-root", None, None).expect("good root");
        let error = capture_root(&store, bad.path(), "bad-root", None, None)
            .expect_err("bad root must fail");
        assert!(matches!(error, CaptureError::WalkIssues(_)), "{error:?}");
        assert_eq!(slice_files(&store, "good-root"), 1);
        assert_eq!(slice_files(&store, "bad-root"), 0);
    }

    #[test]
    fn nested_repo_directory_and_git_file_are_reported() {
        let workspace = workspace();
        write_file(workspace.path(), "nested/file.txt", b"nested");
        fs::create_dir_all(workspace.path().join("nested/.git")).expect("nested git dir");
        write_file(workspace.path(), "worktree/file.txt", b"worktree");
        fs::write(
            workspace.path().join("worktree/.git"),
            b"gitdir: ../.git/worktrees/worktree\n",
        )
        .expect("gitdir file");
        let (_store_dir, store) = store();

        let result =
            capture_root_with_declared_roots(&store, workspace.path(), "ws-1", None, None, &[])
                .expect("capture");
        assert_eq!(result.nested_roots, vec!["nested", "worktree"]);
        let slice: serde_json::Value = serde_json::from_slice(
            &fs::read(
                store
                    .slice_dir("ws-1")
                    .join(format!("{}.json", result.slice_id)),
            )
            .expect("slice"),
        )
        .expect("slice json");
        assert_eq!(
            slice["nested_roots"],
            serde_json::json!(["nested", "worktree"])
        );
    }

    #[test]
    fn gitmodules_submodule_path_is_reported() {
        let workspace = workspace();
        fs::write(
            workspace.path().join(".gitmodules"),
            b"[submodule \"dep\"]\n\tpath = vendor/dep\n\turl = https://example.invalid/dep\n",
        )
        .expect("gitmodules");
        write_file(workspace.path(), "vendor/dep/file.txt", b"submodule");
        let (_store_dir, store) = store();

        let result =
            capture_root_with_declared_roots(&store, workspace.path(), "ws-1", None, None, &[])
                .expect("capture");
        assert_eq!(result.nested_roots, vec!["vendor/dep"]);
    }

    #[test]
    fn declared_root_is_not_reported_as_nested() {
        let workspace = workspace();
        write_file(workspace.path(), "nested/file.txt", b"nested");
        fs::create_dir_all(workspace.path().join("nested/.git")).expect("nested git dir");
        let (_store_dir, store) = store();

        let result = capture_root_with_declared_roots(
            &store,
            workspace.path(),
            "ws-1",
            None,
            None,
            &["nested".to_owned()],
        )
        .expect("capture");
        assert!(result.nested_roots.is_empty(), "{:?}", result.nested_roots);
    }

    #[test]
    fn opaque_nested_contents_are_excluded_but_metadata_is_kept() {
        let workspace = workspace();
        write_file(workspace.path(), "root.txt", b"root");
        write_file(workspace.path(), "nested/file.txt", b"nested");
        fs::create_dir_all(workspace.path().join("nested/.git")).expect("nested git dir");
        let (_store_dir, store) = store();

        let result = capture_root_with_options(
            &store,
            workspace.path(),
            "ws-1",
            None,
            None,
            &CaptureOptions {
                declared_roots: Vec::new(),
                exclude_opaque_nested: true,
                ..CaptureOptions::default()
            },
        )
        .expect("dual opaque capture");
        assert_eq!(result.nested_roots, vec!["nested"]);
        assert_eq!(result.entry_count, 1);
        let manifest = read_tail_manifest(
            &store,
            &TailSlice {
                id: result.slice_id.clone(),
                manifest: result.manifest_id.clone(),
            },
        )
        .expect("tail manifest");
        assert_eq!(manifest.entries.len(), 1);
        assert_eq!(manifest.entries[0].path, "root.txt");
        assert!(
            manifest
                .entries
                .iter()
                .all(|entry| !entry.path.starts_with("nested/"))
        );
    }

    #[test]
    fn stat_cache_identity_rejects_replaced_file_with_same_size_and_mtime() {
        let workspace = workspace();
        write_file(workspace.path(), "item.txt", b"aaaa");
        let item = workspace.path().join("item.txt");
        let mtime = fs::metadata(&item)
            .expect("metadata")
            .modified()
            .expect("mtime");
        let (_store_dir, store) = store();

        let first = capture_root(&store, workspace.path(), "ws-1", None, None).expect("first");
        let replacement = workspace.path().join("item.replacement");
        fs::write(&replacement, b"bbbb").expect("replacement content");
        let replacement_file = fs::OpenOptions::new()
            .write(true)
            .open(&replacement)
            .expect("replacement file");
        replacement_file
            .set_modified(mtime)
            .expect("preserve mtime");
        drop(replacement_file);
        fs::remove_file(&item).expect("remove old");
        fs::rename(&replacement, &item).expect("rename replacement");

        let second = capture_root(&store, workspace.path(), "ws-1", None, None).expect("second");
        assert!(
            !second.no_change,
            "identity change must invalidate the cache"
        );
        assert_eq!(second.hashed_files, 1);
        assert_eq!(slice_files(&store, "ws-1"), 2);
        assert_ne!(second.slice_id, first.slice_id);
    }

    #[test]
    #[ignore = "manual 1k/10k capture benchmark; run with --ignored --nocapture"]
    fn benchmark_capture_1k_10k() {
        for count in [1_000usize, 10_000] {
            let workspace = workspace();
            for index in 0..count {
                let path = format!("dir/{:04}/file-{index:05}.txt", index / 100);
                write_file(
                    workspace.path(),
                    &path,
                    format!("payload-{index}").as_bytes(),
                );
            }
            let (_store_dir, store) = store();
            let started = Instant::now();
            let cold = capture_root(&store, workspace.path(), "bench", None, None).expect("cold");
            let cold_wall = started.elapsed().as_millis() as u64;
            let started = Instant::now();
            let warm = capture_root(&store, workspace.path(), "bench", None, None).expect("warm");
            let warm_wall = started.elapsed().as_millis() as u64;
            eprintln!(
                "count={count} cold_wall_ms={cold_wall} cold_total_ms={} walk_ms={} blob_write_ms={} manifest_ms={} entry_count={} | warm_wall_ms={warm_wall} warm_total_ms={} no_change={} cache_hits={} hashed_files={}",
                cold.duration_ms,
                cold.walk_ms,
                cold.blob_write_ms,
                cold.manifest_ms,
                cold.entry_count,
                warm.duration_ms,
                warm.no_change,
                warm.cache_hits,
                warm.hashed_files
            );
            assert_eq!(cold.entry_count, count);
            assert!(warm.no_change);
            assert_eq!(warm.cache_hits, count);
            assert_eq!(warm.hashed_files, 0);
        }
    }

    #[test]
    #[ignore = "manual 200x dual-write phase breakdown; --ignored --nocapture"]
    fn benchmark_dual_phase_breakdown_200x() {
        fn pct(values: &[u64], percent: usize) -> u64 {
            let mut sorted = values.to_vec();
            sorted.sort_unstable();
            sorted[(sorted.len() * percent / 100).min(sorted.len() - 1)]
        }
        fn dir_size(root: &Path) -> u64 {
            let mut total = 0u64;
            let mut stack = vec![root.to_path_buf()];
            while let Some(dir) = stack.pop() {
                let Ok(entries) = fs::read_dir(&dir) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let path = entry.path();
                    let Ok(metadata) = fs::symlink_metadata(&path) else {
                        continue;
                    };
                    if metadata.is_dir() {
                        stack.push(path);
                    } else {
                        total = total.saturating_add(metadata.len());
                    }
                }
            }
            total
        }

        let workspace = workspace();
        for index in 0..1_000usize {
            write_file(
                workspace.path(),
                &format!("dir/{:02}/file-{index:04}.txt", index / 50),
                format!("payload-{index}").as_bytes(),
            );
        }
        let (_store_dir, store) = store();
        let cold = capture_root(&store, workspace.path(), "ws-1", None, None).expect("cold");
        assert!(!cold.no_change);

        let mut walk = Vec::with_capacity(200);
        let mut blob = Vec::with_capacity(200);
        let mut manifest = Vec::with_capacity(200);
        let mut slice = Vec::with_capacity(200);
        let mut cache_read = Vec::with_capacity(200);
        let mut cache_write = Vec::with_capacity(200);
        let mut lock = Vec::with_capacity(200);
        let mut entries = Vec::with_capacity(200);
        let mut nested_scan = Vec::with_capacity(200);
        let mut tail_read = Vec::with_capacity(200);
        let mut total = Vec::with_capacity(200);
        for iteration in 0..200usize {
            write_file(
                workspace.path(),
                "changed.txt",
                format!("changed-{iteration}").as_bytes(),
            );
            let result =
                capture_root(&store, workspace.path(), "ws-1", None, None).expect("phase capture");
            assert!(!result.no_change);
            walk.push(result.walk_ms);
            blob.push(result.blob_write_ms);
            manifest.push(result.manifest_ms);
            slice.push(result.slice_write_ms);
            cache_read.push(result.cache_read_ms);
            cache_write.push(result.cache_write_ms);
            lock.push(result.lock_ms);
            entries.push(result.entries_ms);
            nested_scan.push(result.nested_scan_ms);
            tail_read.push(result.tail_read_ms);
            total.push(result.duration_ms);
        }
        eprintln!(
            "dual_phase_200x entries=1001 lock_p50={} lock_p95={} walk_p50={} walk_p95={} blob_p50={} blob_p95={} manifest_p50={} manifest_p95={} slice_p50={} slice_p95={} cache_read_p50={} cache_read_p95={} cache_write_p50={} cache_write_p95={} entries_p50={} entries_p95={} nested_scan_p50={} nested_scan_p95={} tail_read_p50={} tail_read_p95={} total_p50={} total_p95={} store_bytes={}",
            pct(&lock, 50),
            pct(&lock, 95),
            pct(&walk, 50),
            pct(&walk, 95),
            pct(&blob, 50),
            pct(&blob, 95),
            pct(&manifest, 50),
            pct(&manifest, 95),
            pct(&slice, 50),
            pct(&slice, 95),
            pct(&cache_read, 50),
            pct(&cache_read, 95),
            pct(&cache_write, 50),
            pct(&cache_write, 95),
            pct(&entries, 50),
            pct(&entries, 95),
            pct(&nested_scan, 50),
            pct(&nested_scan, 95),
            pct(&tail_read, 50),
            pct(&tail_read, 95),
            pct(&total, 50),
            pct(&total, 95),
            dir_size(store.root())
        );
    }
}
