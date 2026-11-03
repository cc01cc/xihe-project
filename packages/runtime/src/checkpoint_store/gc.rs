//! P2.3 conservative store GC (PLAN-0653).
//!
//! Only unreferenced blobs older than the grace window are candidates. Referenced
//! means: any slice manifest, `index/refs`, `index/dual/pending|done`, or an
//! active capture/restore lease (the store lock). Slices/manifests are never
//! deleted. Deletion is dry-run by default and journaled before any unlink.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::audit;
use super::manifest::Manifest;
use super::store::{Store, StoreError};

#[derive(Debug, Clone)]
pub struct GcOptions {
    pub repair: bool,
    /// Blobs with mtime younger than this are never deleted.
    pub grace_seconds: u64,
    #[cfg(test)]
    pub crash_after_plan: bool,
}

impl Default for GcOptions {
    fn default() -> Self {
        Self {
            repair: false,
            grace_seconds: 3_600,
            #[cfg(test)]
            crash_after_plan: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GcCandidate {
    pub hash: String,
    pub path: String,
    pub size: u64,
    pub mtime_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GcJournal {
    pub v: u8,
    pub phase: String,
    pub created_at_ms: u64,
    pub grace_seconds: u64,
    pub referenced_blobs: usize,
    pub candidates: Vec<GcCandidate>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct GcReport {
    pub dry_run: bool,
    pub grace_seconds: u64,
    pub referenced_manifests: usize,
    pub referenced_blobs: usize,
    pub candidates: usize,
    pub candidate_bytes: u64,
    pub skipped_grace: usize,
    pub deleted: usize,
    pub bytes_freed: u64,
    pub cache_entries_removed: usize,
    pub recovered_journals: usize,
    pub journal_path: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum GcError {
    #[error("GC_STORE_BUSY: capture/restore holds the store lease")]
    Busy,
    #[error("GC_REFERENCE_CORRUPT: {0}")]
    ReferenceCorrupt(String),
    #[error("GC_IO: {0}")]
    Io(#[from] std::io::Error),
    #[error("GC_STORE: {0}")]
    Store(#[from] StoreError),
    #[error("GC_CRASH_INJECTED: planned journal left for recovery")]
    InjectedCrash,
}

pub fn gc(store: &Store, options: &GcOptions) -> Result<GcReport, GcError> {
    let _lease = store.lock().map_err(|error| match error {
        StoreError::Busy { .. } => GcError::Busy,
        other => GcError::Store(other),
    })?;
    let now = now_ms();
    let grace_ms = options.grace_seconds.saturating_mul(1000);
    let (referenced, manifest_count) = collect_references(store)?;
    let mut candidates = Vec::new();
    let mut skipped_grace = 0usize;
    for (hash, path) in list_blobs(store)? {
        if referenced.contains(&hash) {
            continue;
        }
        let metadata = fs::symlink_metadata(&path)?;
        let mtime = metadata.modified().ok();
        let mtime_ms = mtime
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(now);
        if now.saturating_sub(mtime_ms) < grace_ms {
            skipped_grace += 1;
            continue;
        }
        candidates.push(GcCandidate {
            hash,
            path: path.display().to_string(),
            size: metadata.len(),
            mtime_ms,
        });
    }
    // Recover candidates from any incomplete planned journal, then re-apply the
    // reference/grace filters. This is how a crash after planning is continued.
    let mut recovered_journals = 0usize;
    let gc_dir = store.root().join("gc");
    if gc_dir.is_dir() {
        for entry in fs::read_dir(&gc_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let Ok(value) = serde_json::from_slice::<GcJournal>(&fs::read(&path)?) else {
                continue;
            };
            if value.phase == "completed" {
                continue;
            }
            recovered_journals += 1;
            for candidate in value.candidates {
                if referenced.contains(&candidate.hash) {
                    continue;
                }
                if !Path::new(&candidate.path).exists() {
                    continue;
                }
                if !candidates.iter().any(|item| item.hash == candidate.hash) {
                    candidates.push(candidate);
                }
            }
        }
    }
    candidates.sort_by(|left, right| left.hash.cmp(&right.hash));
    let candidate_bytes = candidates.iter().map(|item| item.size).sum();
    let mut report = GcReport {
        dry_run: !options.repair,
        grace_seconds: options.grace_seconds,
        referenced_manifests: manifest_count,
        referenced_blobs: referenced.len(),
        candidates: candidates.len(),
        candidate_bytes,
        skipped_grace,
        recovered_journals,
        ..GcReport::default()
    };
    if !options.repair || candidates.is_empty() {
        return Ok(report);
    }

    let journal_path = gc_dir.join(format!("{now}-gc.json"));
    let planned = GcJournal {
        v: 1,
        phase: "planned".into(),
        created_at_ms: now,
        grace_seconds: options.grace_seconds,
        referenced_blobs: referenced.len(),
        candidates: candidates.clone(),
    };
    write_journal(store, &journal_path, &planned)?;
    report.journal_path = Some(journal_path.display().to_string());
    #[cfg(test)]
    if options.crash_after_plan {
        return Err(GcError::InjectedCrash);
    }

    let mut deleted_hashes = BTreeSet::new();
    for candidate in &candidates {
        let path = Path::new(&candidate.path);
        match fs::remove_file(path) {
            Ok(()) => {
                report.deleted += 1;
                report.bytes_freed = report.bytes_freed.saturating_add(candidate.size);
                deleted_hashes.insert(candidate.hash.clone());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                // Leave the journal planned; the error tells the operator which
                // object failed, and a retry re-checks existence.
                return Err(GcError::Io(error));
            }
        }
    }
    report.cache_entries_removed = clean_cache_entries(store, &deleted_hashes)?;
    let completed = GcJournal {
        phase: "completed".into(),
        ..planned
    };
    write_journal(store, &journal_path, &completed)?;
    Ok(report)
}

fn collect_references(store: &Store) -> Result<(BTreeSet<String>, usize), GcError> {
    let mut manifests = BTreeMap::<String, ()>::new();
    let slices_dir = store.root().join("slices");
    if slices_dir.is_dir() {
        for root in fs::read_dir(&slices_dir)? {
            let root = root?;
            if !root.file_type()?.is_dir() {
                continue;
            }
            for entry in fs::read_dir(root.path())? {
                let path = entry?.path();
                if path.extension().is_none_or(|ext| ext != "json") {
                    continue;
                }
                let value: serde_json::Value =
                    serde_json::from_slice(&fs::read(&path)?).map_err(|error| {
                        GcError::ReferenceCorrupt(format!("{}: {error}", path.display()))
                    })?;
                let manifest = value
                    .get("manifest")
                    .and_then(|value| value.as_str())
                    .ok_or_else(|| {
                        GcError::ReferenceCorrupt(format!("{} missing manifest", path.display()))
                    })?;
                manifests.insert(manifest.to_owned(), ());
            }
        }
    }
    let refs_dir = store.root().join("index").join("refs");
    if refs_dir.is_dir() {
        for root in fs::read_dir(&refs_dir)? {
            let root = root?;
            if !root.file_type()?.is_dir() {
                continue;
            }
            for entry in fs::read_dir(root.path())? {
                let path = entry?.path();
                if path.extension().is_none_or(|ext| ext != "json") {
                    continue;
                }
                let record: super::refs::RefRecord = serde_json::from_slice(&fs::read(&path)?)
                    .map_err(|error| {
                        GcError::ReferenceCorrupt(format!("{}: {error}", path.display()))
                    })?;
                manifests.insert(record.store_manifest_id, ());
            }
        }
    }
    for dir in [audit::pending_dir(store), audit::done_dir(store)] {
        collect_dual_manifests(&dir, &mut manifests)?;
    }
    let mut referenced = BTreeSet::new();
    for manifest_id in manifests.keys() {
        let path = store.manifest_path(manifest_id);
        let bytes = fs::read(&path).map_err(|error| {
            GcError::ReferenceCorrupt(format!("manifest {manifest_id} unreadable: {error}"))
        })?;
        let manifest = Manifest::parse_verified(&bytes, manifest_id).map_err(|error| {
            GcError::ReferenceCorrupt(format!("manifest {manifest_id} invalid: {error}"))
        })?;
        for entry in manifest.entries {
            referenced.insert(entry.blob_hash);
        }
    }
    Ok((referenced, manifests.len()))
}

fn collect_dual_manifests(dir: &Path, manifests: &mut BTreeMap<String, ()>) -> Result<(), GcError> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(GcError::Io(error)),
    };
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            collect_dual_manifests(&path, manifests)?;
            continue;
        }
        if path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        let record: audit::DualPendingRecord = serde_json::from_slice(&fs::read(&path)?)
            .map_err(|error| GcError::ReferenceCorrupt(format!("{}: {error}", path.display())))?;
        manifests.insert(record.store_manifest_id, ());
    }
    Ok(())
}

fn list_blobs(store: &Store) -> Result<Vec<(String, PathBuf)>, GcError> {
    let mut out = Vec::new();
    let objects = store.root().join("objects");
    if !objects.is_dir() {
        return Ok(out);
    }
    for first in fs::read_dir(&objects)? {
        let first = first?;
        if !first.file_type()?.is_dir() {
            continue;
        }
        for second in fs::read_dir(first.path())? {
            let second = second?;
            if !second.file_type()?.is_dir() {
                continue;
            }
            for blob in fs::read_dir(second.path())? {
                let blob = blob?;
                let path = blob.path();
                if !blob.file_type()?.is_file() {
                    continue;
                }
                let Some(hash) = path.file_name().and_then(|name| name.to_str()) else {
                    continue;
                };
                if hash.len() == 64 && hash.chars().all(|ch| ch.is_ascii_hexdigit()) {
                    out.push((hash.to_owned(), path));
                }
            }
        }
    }
    Ok(out)
}

fn write_journal(store: &Store, path: &Path, journal: &GcJournal) -> Result<(), GcError> {
    let bytes = serde_json::to_vec_pretty(journal)
        .map_err(|error| GcError::ReferenceCorrupt(format!("journal encode: {error}")))?;
    store.write_atomic(path, &bytes)?;
    Ok(())
}

fn clean_cache_entries(store: &Store, deleted: &BTreeSet<String>) -> Result<usize, GcError> {
    let dir = store.root().join("index").join("stat");
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(GcError::Io(error)),
    };
    let mut removed = 0usize;
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(&fs::read(&path)?) else {
            continue; // disposable cache; corrupt cache is fsck's concern
        };
        let Some(entries_map) = value
            .get_mut("entries")
            .and_then(|value| value.as_object_mut())
        else {
            continue;
        };
        let before = entries_map.len();
        entries_map.retain(|_, value| {
            value
                .get("hash")
                .and_then(|hash| hash.as_str())
                .is_none_or(|hash| !deleted.contains(hash))
        });
        let changed = before - entries_map.len();
        if changed > 0 {
            removed += changed;
            let bytes = serde_json::to_vec(&value)
                .map_err(|error| GcError::ReferenceCorrupt(format!("cache encode: {error}")))?;
            store.write_atomic(&path, &bytes)?;
        }
    }
    Ok(removed)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checkpoint_store::blob::{blob_path, write_blob};
    use crate::checkpoint_store::capture::capture_root;
    use crate::checkpoint_store::manifest::{FileMode, ManifestEntry};

    fn fixture() -> (tempfile::TempDir, Store, PathBuf) {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("ws");
        fs::create_dir_all(&root).expect("root");
        fs::write(root.join("a.txt"), "referenced").expect("a");
        let store = Store::init(temp.path().join("store")).expect("store");
        capture_root(&store, &root, "ws-1", None, None).expect("capture");
        (temp, store, root)
    }

    fn orphan(store: &Store, content: &[u8]) -> (String, PathBuf) {
        let outcome = write_blob(store.root(), content).expect("orphan blob");
        let path = blob_path(store.root(), &outcome.hash);
        (outcome.hash, path)
    }

    fn pending_manifest_reference(store: &Store, blob_hash: &str) -> String {
        let manifest = Manifest::from_entries(vec![
            ManifestEntry::new(
                "referenced-by-pending".to_string(),
                FileMode::Regular,
                b"pending-referenced".len() as u64,
                blob_hash.to_owned(),
            )
            .expect("entry"),
        ])
        .expect("manifest");
        let bytes = manifest.canonical_bytes().expect("manifest bytes");
        let manifest_id = manifest.manifest_id().expect("manifest id");
        store
            .write_atomic(&store.manifest_path(&manifest_id), &bytes)
            .expect("write manifest");
        let record = audit::DualPendingRecord {
            v: 1,
            root_id: "ws-1".into(),
            run_id: "pending-run".into(),
            git_ref: Some("refs/xihe/slices/pending".into()),
            git_tree: "0".repeat(40),
            store_slice_id: "001-pending".into(),
            store_manifest_id: manifest_id.clone(),
            created_at_ms: 0,
        };
        audit::write_pending(store, &record).expect("pending record");
        manifest_id
    }

    #[test]
    fn dry_run_reports_only_unreferenced_and_pending_refs_are_kept() {
        let (_temp, store, _root) = fixture();
        let referenced = write_blob(store.root(), b"referenced").expect("blob");
        let (pending_blob, pending_path) = orphan(&store, b"pending-referenced");
        pending_manifest_reference(&store, &pending_blob);
        let (_orphan_hash, _orphan_path) = orphan(&store, b"true-orphan");
        let report = gc(
            &store,
            &GcOptions {
                grace_seconds: 0,
                ..GcOptions::default()
            },
        )
        .expect("dry run");
        assert!(report.dry_run);
        assert!(report.candidate_bytes > 0);
        assert!(report.candidates >= 1, "{report:?}");
        assert!(pending_path.exists(), "pending reference must protect blob");
        assert!(blob_path(store.root(), &referenced.hash).exists());
    }

    #[test]
    fn grace_window_keeps_fresh_orphans() {
        let (_temp, store, _root) = fixture();
        let (_hash, path) = orphan(&store, b"fresh-orphan");
        let report = gc(
            &store,
            &GcOptions {
                grace_seconds: 3_600,
                ..GcOptions::default()
            },
        )
        .expect("grace dry run");
        assert!(path.exists());
        assert_eq!(report.candidates, 0, "{report:?}");
        assert!(report.skipped_grace >= 1);
    }

    #[test]
    fn repair_deletes_orphans_and_keeps_referenced_objects() {
        let (_temp, store, _root) = fixture();
        let (orphan_hash, orphan_path) = orphan(&store, b"delete-me");
        let referenced_count = gc(
            &store,
            &GcOptions {
                grace_seconds: 0,
                ..GcOptions::default()
            },
        )
        .expect("dry")
        .referenced_blobs;
        let report = gc(
            &store,
            &GcOptions {
                repair: true,
                grace_seconds: 0,
                ..GcOptions::default()
            },
        )
        .expect("repair");
        assert!(!orphan_path.exists());
        assert!(report.deleted >= 1);
        assert!(report.bytes_freed > 0);
        assert_eq!(report.referenced_blobs, referenced_count);
        assert!(report.journal_path.is_some());
        assert!(!blob_path(store.root(), &orphan_hash).exists());
    }

    #[test]
    fn gc_refuses_when_store_lease_is_held() {
        let (_temp, store, _root) = fixture();
        let _lease = store.lock().expect("lease");
        let error = gc(&store, &GcOptions::default()).expect_err("busy");
        assert!(matches!(error, GcError::Busy), "{error:?}");
    }

    #[test]
    fn crashed_planned_journal_is_recovered_and_continued() {
        let (_temp, store, _root) = fixture();
        let (hash, path) = orphan(&store, b"crash-orphan");
        let error = gc(
            &store,
            &GcOptions {
                repair: true,
                grace_seconds: 0,
                crash_after_plan: true,
            },
        )
        .expect_err("injected crash");
        assert!(matches!(error, GcError::InjectedCrash));
        assert!(path.exists());
        let journal_dir = store.root().join("gc");
        assert_eq!(fs::read_dir(&journal_dir).expect("journal dir").count(), 1);

        let recovered = gc(
            &store,
            &GcOptions {
                repair: false,
                grace_seconds: 0,
                ..GcOptions::default()
            },
        )
        .expect("recover dry");
        assert!(recovered.recovered_journals >= 1);
        assert!(recovered.candidates >= 1);
        let report = gc(
            &store,
            &GcOptions {
                repair: true,
                grace_seconds: 0,
                ..GcOptions::default()
            },
        )
        .expect("recover repair");
        assert!(report.deleted >= 1);
        assert!(!blob_path(store.root(), &hash).exists());
    }
}
