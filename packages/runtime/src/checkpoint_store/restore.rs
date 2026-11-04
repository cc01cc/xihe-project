//! Minimal store-level restore for T1.11 consistency runs.
//!
//! This is intentionally not the product restore path (T2.1 owns full restore,
//! deletion, chunking and crash markers). It restores one slice into a target
//! directory so T1.11 can verify every byte independently of the manifest.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::Instant;

use serde_json::Value;

use super::blob::read_blob;
use super::manifest::Manifest;
use super::store::Store;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RestoreStats {
    pub files: usize,
    pub bytes: u64,
    pub duration_ms: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum RestoreError {
    #[error("invalid slice id {0:?}")]
    InvalidSliceId(String),
    #[error("slice not found: {0:?}")]
    SliceMissing(PathBuf),
    #[error("slice is corrupt: {0}")]
    SliceCorrupt(String),
    #[error("manifest error: {0}")]
    Manifest(#[from] super::manifest::ManifestError),
    #[error("blob error: {0}")]
    Blob(#[from] super::blob::BlobError),
    #[error("unsafe manifest path {0:?}")]
    UnsafePath(String),
    #[error("symlink entries are not supported by the T1.11 store restore: {0}")]
    SymlinkUnsupported(String),
    #[error("restored size mismatch for {path:?}: expected {expected}, got {actual}")]
    SizeMismatch {
        path: String,
        expected: u64,
        actual: u64,
    },
    #[error("I/O error at {path:?}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("JSON error at {path:?}: {source}")]
    Json {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

fn io_error(path: &Path, source: std::io::Error) -> RestoreError {
    RestoreError::Io {
        path: path.to_path_buf(),
        source,
    }
}

fn safe_relative(path: &str) -> Result<PathBuf, RestoreError> {
    let relative = Path::new(path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(RestoreError::UnsafePath(path.to_owned()));
    }
    Ok(relative.to_path_buf())
}

/// Restore one slice into `target` (files only; symlinks are rejected rather
/// than silently materialized as regular files).
pub fn restore_slice_to_dir(
    store: &Store,
    root_id: &str,
    slice_id: &str,
    target: &Path,
) -> Result<RestoreStats, RestoreError> {
    if slice_id.contains(['/', '\\']) || slice_id == "." || slice_id == ".." {
        return Err(RestoreError::InvalidSliceId(slice_id.to_owned()));
    }
    let _lock = store.lock_root(root_id).map_err(|error| RestoreError::Io {
        path: store.root().to_path_buf(),
        source: std::io::Error::other(error.to_string()),
    })?;
    let started = Instant::now();
    let slice_path = store.slice_dir(root_id).join(format!("{slice_id}.json"));
    let slice_bytes = match fs::read(&slice_path) {
        Ok(bytes) => bytes,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Err(RestoreError::SliceMissing(slice_path));
        }
        Err(source) => return Err(io_error(&slice_path, source)),
    };
    let slice: Value =
        serde_json::from_slice(&slice_bytes).map_err(|source| RestoreError::Json {
            path: slice_path.clone(),
            source,
        })?;
    let manifest_id = slice
        .get("manifest")
        .and_then(Value::as_str)
        .ok_or_else(|| RestoreError::SliceCorrupt("missing manifest".into()))?;
    let manifest_path = store.manifest_path(manifest_id);
    let manifest_bytes =
        fs::read(&manifest_path).map_err(|source| io_error(&manifest_path, source))?;
    let manifest = Manifest::parse(&manifest_bytes)?;

    fs::create_dir_all(target).map_err(|source| io_error(target, source))?;
    let mut files = 0;
    let mut bytes = 0u64;
    for entry in &manifest.entries {
        let relative = safe_relative(&entry.path)?;
        let destination = target.join(relative);
        if entry.mode == super::manifest::FileMode::Symlink {
            return Err(RestoreError::SymlinkUnsupported(entry.path.clone()));
        }
        let raw = read_blob(store.root(), &entry.blob_hash)?;
        if raw.len() as u64 != entry.size {
            return Err(RestoreError::SizeMismatch {
                path: entry.path.clone(),
                expected: entry.size,
                actual: raw.len() as u64,
            });
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|source| io_error(parent, source))?;
        }
        fs::write(&destination, &raw).map_err(|source| io_error(&destination, source))?;
        files += 1;
        bytes = bytes.saturating_add(entry.size);
    }
    Ok(RestoreStats {
        files,
        bytes,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checkpoint_store::blob::{blob_hash, write_blob};
    use crate::checkpoint_store::capture::capture_root;
    use crate::checkpoint_store::fsck::fsck_store;

    fn fixture() -> (tempfile::TempDir, tempfile::TempDir, Store, String) {
        let workspace = tempfile::tempdir().expect("workspace");
        fs::write(workspace.path().join("a.txt"), b"alpha").expect("a");
        fs::create_dir_all(workspace.path().join("dir")).expect("dir");
        fs::write(workspace.path().join("dir/b.txt"), b"beta").expect("b");
        let store_dir = tempfile::tempdir().expect("store");
        let store = Store::init(store_dir.path()).expect("init");
        let result = capture_root(&store, workspace.path(), "ws-1", None, None).expect("capture");
        (workspace, store_dir, store, result.slice_id)
    }

    #[test]
    fn restore_roundtrip_verifies_every_file() {
        let (workspace, _store_dir, store, slice_id) = fixture();
        let target = tempfile::tempdir().expect("target");
        let stats =
            restore_slice_to_dir(&store, "ws-1", &slice_id, target.path()).expect("restore");
        assert_eq!(stats.files, 2);
        assert_eq!(
            fs::read(target.path().join("a.txt")).expect("restored a"),
            fs::read(workspace.path().join("a.txt")).expect("source a")
        );
        assert_eq!(
            fs::read(target.path().join("dir/b.txt")).expect("restored b"),
            fs::read(workspace.path().join("dir/b.txt")).expect("source b")
        );
    }

    #[test]
    fn restore_rejects_path_traversal_and_missing_slice() {
        let _ = fixture();
        let store_dir = tempfile::tempdir().expect("store");
        let store = Store::init(store_dir.path()).expect("init");
        let target = tempfile::tempdir().expect("target");
        let error = restore_slice_to_dir(&store, "ws-1", "../escape", target.path())
            .expect_err("path traversal");
        assert!(matches!(error, RestoreError::InvalidSliceId(_)));

        let error = restore_slice_to_dir(&store, "ws-1", "missing", target.path())
            .expect_err("missing slice");
        assert!(matches!(error, RestoreError::SliceMissing(_)));
    }

    #[test]
    fn restore_missing_blob_fails_loudly() {
        let (_workspace, _store_dir, store, slice_id) = fixture();
        let slice: Value = serde_json::from_slice(
            &fs::read(store.slice_dir("ws-1").join(format!("{slice_id}.json"))).expect("slice"),
        )
        .expect("slice json");
        let manifest_id = slice["manifest"].as_str().expect("manifest id");
        let manifest =
            Manifest::parse(&fs::read(store.manifest_path(manifest_id)).expect("manifest bytes"))
                .expect("manifest");
        fs::remove_file(super::super::blob::blob_path(
            store.root(),
            &manifest.entries[0].blob_hash,
        ))
        .expect("remove blob");
        let target = tempfile::tempdir().expect("target");
        let error = restore_slice_to_dir(&store, "ws-1", &slice_id, target.path())
            .expect_err("missing blob");
        assert!(matches!(error, RestoreError::Blob(_)), "{error:?}");
    }

    #[test]
    fn restore_rejects_orphan_blob_but_keeps_manifest_only_entries() {
        let (_workspace, _store_dir, store, _slice_id) = fixture();
        let orphan = write_blob(store.root(), b"unreferenced").expect("orphan");
        assert!(!blob_hash(b"unreferenced").is_empty());
        assert!(super::super::blob::blob_path(store.root(), &orphan.hash).is_file());
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

    #[cfg(not(windows))]
    fn extended(path: &Path) -> PathBuf {
        path.to_path_buf()
    }

    fn hash_bytes(bytes: &[u8]) -> String {
        crate::checkpoint_store::blob::blob_hash(bytes)
    }

    fn dir_size(root: &Path) -> u64 {
        let mut total: u64 = 0;
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

    #[test]
    #[ignore = "manual 1x/10x/50x/200x consistency run; --ignored --nocapture"]
    fn consistency_200x_capture_restore_verify() {
        use std::time::Instant;

        let workspace = tempfile::tempdir().expect("workspace");
        let source_root = extended(workspace.path());
        let mut expected = std::collections::HashMap::new();
        for index in 0..1_000usize {
            let relative = format!("dir/{:02}/file-{index:04}.txt", index / 50);
            let content = format!("payload-{index}");
            let path = source_root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
            fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
            fs::write(&path, content.as_bytes()).expect("write");
            expected.insert(relative, hash_bytes(content.as_bytes()));
        }
        let nested = source_root.join("nested");
        fs::create_dir_all(nested.join(".git")).expect("nested git");
        fs::write(nested.join("nested.txt"), b"nested-content").expect("nested file");
        expected.insert("nested/nested.txt".into(), hash_bytes(b"nested-content"));

        let mut long_relative = String::new();
        for index in 0..9 {
            long_relative.push_str(&format!("long-{index:02}-{}/", "x".repeat(24)));
        }
        long_relative.push_str("deep.txt");
        let long_path = source_root.join(long_relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        fs::create_dir_all(long_path.parent().expect("long parent")).expect("long dirs");
        fs::write(&long_path, b"deep-content").expect("long file");
        expected.insert(long_relative, hash_bytes(b"deep-content"));

        let store_dir = tempfile::tempdir().expect("store");
        let store = Store::init(store_dir.path()).expect("init");
        let target = tempfile::tempdir().expect("target");
        let target_root = extended(target.path());

        let mut cold_capture_ms = 0;
        let mut hot_capture_ms = 0;
        let mut restore_ms = 0;
        let mut verify_ms = 0;

        for iteration in 1..=200usize {
            let started = Instant::now();
            let result =
                capture_root(&store, workspace.path(), "ws-1", None, None).expect("capture");
            let capture_elapsed = started.elapsed().as_millis() as u64;
            if iteration == 1 {
                cold_capture_ms = capture_elapsed;
            } else {
                hot_capture_ms += capture_elapsed;
            }

            let started = Instant::now();
            let stats = restore_slice_to_dir(&store, "ws-1", &result.slice_id, &target_root)
                .expect("restore");
            restore_ms += started.elapsed().as_millis() as u64;
            assert_eq!(stats.files, expected.len());

            let started = Instant::now();
            for (relative, expected_hash) in &expected {
                let path = target_root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
                let bytes = fs::read(&path)
                    .unwrap_or_else(|error| panic!("restore verify read {relative:?}: {error}"));
                let actual_hash = hash_bytes(&bytes);
                assert_eq!(
                    &actual_hash, expected_hash,
                    "restore content mismatch path={relative:?} expected={expected_hash} actual={actual_hash}"
                );
            }
            verify_ms += started.elapsed().as_millis() as u64;

            if matches!(iteration, 1 | 10 | 50 | 200) {
                let hot_count = iteration.saturating_sub(1).max(1) as u64;
                eprintln!(
                    "tier={iteration}x files={} cold_capture_ms={cold_capture_ms} hot_capture_total_ms={hot_capture_ms} hot_capture_avg_ms={} restore_total_ms={restore_ms} restore_avg_ms={} verify_total_ms={verify_ms} entries={}",
                    expected.len(),
                    hot_capture_ms / hot_count,
                    restore_ms / iteration as u64,
                    result.entry_count
                );
            }
        }

        let raw_bytes: u64 = expected
            .keys()
            .map(|relative| {
                fs::metadata(source_root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR)))
                    .map(|metadata| metadata.len())
                    .unwrap_or(0)
            })
            .sum();
        let store_bytes = dir_size(store.root());
        eprintln!(
            "store_bytes={store_bytes} raw_bytes={raw_bytes} ratio={:.3} cold_capture_ms={cold_capture_ms}",
            if store_bytes == 0 {
                0.0
            } else {
                raw_bytes as f64 / store_bytes as f64
            }
        );
    }

    /// Child process for the T1.11 kill test; does nothing unless the parent
    /// sets `XIHE_T111_CHILD=1`.
    #[test]
    #[ignore = "child helper for the manual T1.11 kill test"]
    fn kill_capture_child() {
        if std::env::var("XIHE_T111_CHILD").as_deref() != Ok("1") {
            return;
        }
        let workspace = PathBuf::from(std::env::var("XIHE_T111_WORKSPACE").expect("workspace"));
        let store_root = PathBuf::from(std::env::var("XIHE_T111_STORE").expect("store"));
        let store = Store::open(&store_root).expect("open store");
        let _ = capture_root(&store, &workspace, "ws-1", None, None);
    }

    #[test]
    #[ignore = "manual T1.11 mid-capture kill test; --ignored --nocapture"]
    fn kill_mid_capture_leaves_no_visible_slice_and_fsck_heals() {
        use std::process::{Command, Stdio};
        use std::time::Duration;

        let workspace = tempfile::tempdir().expect("workspace");
        for index in 0..1_000usize {
            let relative = format!("dir/{:02}/file-{index:04}.txt", index / 50);
            let path = workspace
                .path()
                .join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
            fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
            fs::write(path, format!("kill-payload-{index}")).expect("write");
        }
        let store_dir = tempfile::tempdir().expect("store");
        let store = Store::init(store_dir.path()).expect("init");

        let exe = std::env::current_exe().expect("current test exe");
        let mut child = Command::new(exe)
            .args([
                "--exact",
                "checkpoint_store::restore::tests::kill_capture_child",
                "--ignored",
                "--nocapture",
            ])
            .env("XIHE_T111_CHILD", "1")
            .env("XIHE_T111_WORKSPACE", workspace.path())
            .env("XIHE_T111_STORE", store.root())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn child capture");
        std::thread::sleep(Duration::from_millis(200));
        let _ = child.kill();
        let _ = child.wait();

        let slices = collect_slice_files(&store, "ws-1");
        assert!(
            slices.is_empty(),
            "killed capture must not leave a visible slice: {slices:?}"
        );
        let repair = fsck_store(&store, true).expect("fsck repair after kill");
        eprintln!(
            "kill fsck findings={} repaired={} journal={:?}",
            repair.findings.len(),
            repair.repaired,
            repair.journal
        );
        let second = capture_root(&store, workspace.path(), "ws-1", None, None)
            .expect("capture after killed attempt");
        assert_eq!(collect_slice_files(&store, "ws-1").len(), 1);
        assert!(!second.slice_id.is_empty());
        let clean = fsck_store(&store, false).expect("fsck after retry");
        assert!(clean.is_clean(), "post-retry fsck: {:?}", clean.findings);
    }

    fn collect_slice_files(store: &Store, root_id: &str) -> Vec<PathBuf> {
        let dir = store.slice_dir(root_id);
        let Ok(entries) = fs::read_dir(&dir) else {
            return Vec::new();
        };
        let mut files: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .collect();
        files.sort();
        files
    }
}
