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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StatCacheEntry {
    hash: String,
    size: u64,
    mtime_ns: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StatCacheFile {
    v: u8,
    entries: HashMap<String, StatCacheEntry>,
}

#[derive(Debug, Clone)]
struct TailSlice {
    id: String,
    manifest: String,
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

fn tail_slice(store: &Store, root_id: &str) -> Result<Option<TailSlice>, CaptureError> {
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

fn read_tail_manifest(store: &Store, tail: &TailSlice) -> Result<Manifest, CaptureError> {
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
        let metadata = file_metadata(&entry.absolute_path)?;
        let size = metadata.len();
        let mtime = mtime_ns(&metadata);
        if size != tail_entry.size || entry.size != size {
            return Ok(None);
        }
        let Some(cached) = cache.get(&entry.path) else {
            return Ok(None);
        };
        if cached.size != size || cached.mtime_ns != mtime || cached.hash != tail_entry.blob_hash {
            return Ok(None);
        }
    }
    Ok(Some(entries.len()))
}

fn exclusion_patterns(root: &Path) -> (Vec<String>, Vec<String>) {
    let mut patterns: Vec<String> = crate::checkpoint::STATIC_EXCLUDE_PATTERNS
        .iter()
        .map(|pattern| (*pattern).to_owned())
        .collect();
    let mut gitignore_files = Vec::new();
    if root.join(".gitignore").is_file() {
        patterns.push("gitignore:.gitignore".into());
        gitignore_files.push(".gitignore".into());
    }
    (patterns, gitignore_files)
}

/// Capture one root into the store. The caller decides which roots exist; this
/// function never combines roots into one slice.
pub fn capture_root(
    store: &Store,
    root: &Path,
    root_id: &str,
    run_id: Option<&str>,
    principal_id: Option<&str>,
) -> Result<CaptureResult, CaptureError> {
    let started = Instant::now();
    let _lock = store.lock()?;
    let walk = walk_workspace(root)?;
    if !walk.issues.is_empty() {
        return Err(CaptureError::WalkIssues(walk.issues));
    }
    let cache = read_cache(store, root_id)?;
    let tail = tail_slice(store, root_id)?;

    if let Some(tail) = &tail
        && let Some(hits) = fast_no_change(store, tail, &walk.entries, &cache)?
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
            ..CaptureResult::default()
        });
    }

    let mut entries = Vec::with_capacity(walk.entries.len());
    let mut next_cache = HashMap::with_capacity(walk.entries.len());
    let mut blobs_new = 0;
    let mut blobs_dedup = 0;
    let mut cache_hits = 0;
    let mut hashed_files = 0;
    let mut total_bytes = 0u64;

    for walk_entry in &walk.entries {
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
                let hash = match cache.get(&walk_entry.path) {
                    Some(cached) if cached.size == size && cached.mtime_ns == mtime => {
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
                        let outcome = write_blob(store.root(), &bytes)?;
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
                let outcome = write_blob(store.root(), target.as_bytes())?;
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

    let manifest = Manifest::from_entries(entries)?;
    let manifest_bytes = manifest.canonical_bytes()?;
    let manifest_id = manifest.manifest_id()?;
    store.write_atomic(&store.manifest_path(&manifest_id), &manifest_bytes)?;

    let cache_write = || write_cache(store, root_id, next_cache.clone());
    if let Some(tail) = &tail
        && tail.manifest == manifest_id
    {
        if let Err(error) = cache_write() {
            tracing::warn!(root_id, %error, "checkpoint stat cache write failed");
        }
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
        });
    }

    let captured_at = Utc::now();
    let captured_at_ms = now_ms();
    let slice_id = format!("{captured_at_ms:013}-{}", &manifest_id[..12]);
    let slice_path = store.slice_dir(root_id).join(format!("{slice_id}.json"));
    let (patterns, gitignore_files) = exclusion_patterns(root);
    let stats = serde_json::json!({
        "scanned_files": walk.entries.len(),
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
        "nested_roots": [],
        "stats": stats,
        "state": "captured",
        "migrated_from": serde_json::Value::Null,
    });
    let slice_bytes =
        serde_json::to_vec(&slice).map_err(|error| CaptureError::Encode(error.to_string()))?;
    store.write_atomic(&slice_path, &slice_bytes)?;
    if let Err(error) = cache_write() {
        tracing::warn!(root_id, %error, "checkpoint stat cache write failed");
    }

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
}
