//! Store fsck (`FORMAT.md` §4–§8, PLAN-0653 T1.8).
//!
//! Read-only by default. `repair` only removes objects that are provably not
//! referenced (orphan blobs) or rebuilds the disposable stat cache; it writes a
//! planned journal before any unlink. Missing/truncated referenced blobs and
//! broken slice chains are reported as unrepairable and are never deleted.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

use super::blob::{blob_path, read_blob};
use super::manifest::Manifest;
use super::store::{Store, StoreError};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum FsckFindingKind {
    OrphanBlob,
    MissingBlob,
    TruncatedBlob,
    OrphanSlice,
    CacheStale,
    CorruptManifest,
    CorruptSlice,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum FsckAction {
    ReportOnly,
    AutoRepair,
    Unrepairable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FsckFinding {
    pub kind: FsckFindingKind,
    pub path: String,
    pub detail: String,
    pub action: FsckAction,
    pub repaired: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FsckReport {
    pub findings: Vec<FsckFinding>,
    pub repaired: bool,
    pub journal: Option<PathBuf>,
}

impl FsckReport {
    pub fn is_clean(&self) -> bool {
        self.findings.is_empty()
    }

    pub fn count(&self, kind: FsckFindingKind) -> usize {
        self.findings
            .iter()
            .filter(|finding| finding.kind == kind)
            .count()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum FsckError {
    #[error("store error: {0}")]
    Store(#[from] StoreError),
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

fn io_error(path: &Path, source: std::io::Error) -> FsckError {
    FsckError::Io {
        path: path.to_path_buf(),
        source,
    }
}

fn collect_files(root: &Path, suffix: Option<&str>) -> Result<Vec<PathBuf>, FsckError> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => continue,
            Err(source) => return Err(io_error(&dir, source)),
        };
        for entry in entries {
            let entry = entry.map_err(|source| io_error(&dir, source))?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|source| io_error(&path, source))?;
            if metadata.is_dir() {
                stack.push(path);
            } else if metadata.is_file()
                && suffix.is_none_or(|suffix| path.extension().is_some_and(|ext| ext == suffix))
            {
                out.push(path);
            }
        }
    }
    out.sort();
    Ok(out)
}

fn relative(store: &Store, path: &Path) -> String {
    path.strip_prefix(store.root())
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn read_json(path: &Path) -> Result<Value, FsckError> {
    let bytes = fs::read(path).map_err(|source| io_error(path, source))?;
    serde_json::from_slice(&bytes).map_err(|source| FsckError::Json {
        path: path.to_path_buf(),
        source,
    })
}

struct ManifestScan {
    manifests: HashMap<String, Manifest>,
    findings: Vec<FsckFinding>,
}

fn scan_manifests(store: &Store) -> Result<ManifestScan, FsckError> {
    let mut manifests = HashMap::new();
    let mut findings = Vec::new();
    for path in collect_files(&store.root().join("manifests"), Some("json"))? {
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let bytes = fs::read(&path).map_err(|source| io_error(&path, source))?;
        match Manifest::parse(&bytes) {
            Ok(manifest) => match manifest.manifest_id() {
                Ok(id) if id == stem => {
                    manifests.insert(id, manifest);
                }
                Ok(id) => findings.push(FsckFinding {
                    kind: FsckFindingKind::CorruptManifest,
                    path: relative(store, &path),
                    detail: format!("filename id {stem} != content id {id}"),
                    action: FsckAction::Unrepairable,
                    repaired: false,
                }),
                Err(error) => findings.push(FsckFinding {
                    kind: FsckFindingKind::CorruptManifest,
                    path: relative(store, &path),
                    detail: error.to_string(),
                    action: FsckAction::Unrepairable,
                    repaired: false,
                }),
            },
            Err(error) => findings.push(FsckFinding {
                kind: FsckFindingKind::CorruptManifest,
                path: relative(store, &path),
                detail: error.to_string(),
                action: FsckAction::Unrepairable,
                repaired: false,
            }),
        }
    }
    Ok(ManifestScan {
        manifests,
        findings,
    })
}

fn scan_slices(
    store: &Store,
    manifests: &HashMap<String, Manifest>,
) -> Result<Vec<FsckFinding>, FsckError> {
    let mut findings = Vec::new();
    let root = store.root().join("slices");
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(findings),
        Err(source) => return Err(io_error(&root, source)),
    };
    for root_entry in entries {
        let root_entry = root_entry.map_err(|source| io_error(&root, source))?;
        let root_path = root_entry.path();
        if !root_path.is_dir() {
            continue;
        }
        let root_id = root_entry.file_name().to_string_lossy().to_string();
        let mut slices = collect_files(&root_path, Some("json"))?;
        slices.sort();
        let mut previous: Option<String> = None;
        for slice_path in slices {
            let value = match read_json(&slice_path) {
                Ok(value) => value,
                Err(error) => {
                    findings.push(FsckFinding {
                        kind: FsckFindingKind::CorruptSlice,
                        path: relative(store, &slice_path),
                        detail: error.to_string(),
                        action: FsckAction::Unrepairable,
                        repaired: false,
                    });
                    previous = None;
                    continue;
                }
            };
            let id = value.get("id").and_then(Value::as_str).unwrap_or_default();
            let parent = value.get("parent").and_then(Value::as_str);
            let manifest_id = value
                .get("manifest")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if parent != previous.as_deref() {
                findings.push(FsckFinding {
                    kind: FsckFindingKind::OrphanSlice,
                    path: relative(store, &slice_path),
                    detail: format!(
                        "root {root_id}: parent {parent:?} does not match previous slice {previous:?}"
                    ),
                    action: FsckAction::Unrepairable,
                    repaired: false,
                });
            }
            let Some(manifest) = manifests.get(manifest_id) else {
                findings.push(FsckFinding {
                    kind: FsckFindingKind::OrphanSlice,
                    path: relative(store, &slice_path),
                    detail: format!("slice {id} references missing manifest {manifest_id}"),
                    action: FsckAction::Unrepairable,
                    repaired: false,
                });
                previous = Some(id.to_owned());
                continue;
            };
            let merkle_ok = value.get("merkle_root").and_then(Value::as_str)
                == Some(manifest.merkle_root.as_str());
            let entries_ok = value.get("entry_count").and_then(Value::as_u64)
                == Some(manifest.entries.len() as u64);
            let bytes_ok =
                value.get("total_bytes").and_then(Value::as_u64) == Some(manifest.total_bytes);
            if !merkle_ok || !entries_ok || !bytes_ok {
                findings.push(FsckFinding {
                    kind: FsckFindingKind::OrphanSlice,
                    path: relative(store, &slice_path),
                    detail: format!("slice {id} summary does not match manifest {manifest_id}"),
                    action: FsckAction::Unrepairable,
                    repaired: false,
                });
            }
            previous = Some(id.to_owned());
        }
    }
    Ok(findings)
}

fn referenced_blobs(manifests: &HashMap<String, Manifest>) -> HashMap<String, HashSet<String>> {
    let mut refs: HashMap<String, HashSet<String>> = HashMap::new();
    for (manifest_id, manifest) in manifests {
        for entry in &manifest.entries {
            refs.entry(entry.blob_hash.clone())
                .or_default()
                .insert(manifest_id.clone());
        }
    }
    refs
}

fn scan_blobs(
    store: &Store,
    refs: &HashMap<String, HashSet<String>>,
    corrupt_manifests: bool,
) -> Result<Vec<FsckFinding>, FsckError> {
    let mut findings = Vec::new();
    for path in collect_files(&store.root().join("objects"), None)? {
        let Some(hash) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            continue;
        }
        let referenced = refs.contains_key(hash);
        match read_blob(store.root(), hash) {
            Ok(_) if !referenced => findings.push(FsckFinding {
                kind: FsckFindingKind::OrphanBlob,
                path: relative(store, &path),
                detail: "blob is not referenced by any valid manifest".into(),
                action: if corrupt_manifests {
                    FsckAction::ReportOnly
                } else {
                    FsckAction::AutoRepair
                },
                repaired: false,
            }),
            Ok(_) => {}
            Err(error) => findings.push(FsckFinding {
                kind: FsckFindingKind::TruncatedBlob,
                path: relative(store, &path),
                detail: error.to_string(),
                action: if referenced || corrupt_manifests {
                    FsckAction::Unrepairable
                } else {
                    FsckAction::AutoRepair
                },
                repaired: false,
            }),
        }
    }
    for hash in refs.keys() {
        if !blob_path(store.root(), hash).is_file() {
            findings.push(FsckFinding {
                kind: FsckFindingKind::MissingBlob,
                path: format!("objects/{}/{}/{}", &hash[0..2], &hash[2..4], hash),
                detail: "manifest references a blob that is missing".into(),
                action: FsckAction::Unrepairable,
                repaired: false,
            });
        }
    }
    Ok(findings)
}

fn scan_cache(store: &Store) -> Result<Vec<FsckFinding>, FsckError> {
    let mut findings = Vec::new();
    let dir = store.root().join("index").join("stat");
    for path in collect_files(&dir, Some("json"))? {
        let value = match read_json(&path) {
            Ok(value) => value,
            Err(_) => continue, // corrupt cache is disposable; capture ignores it
        };
        let Some(entries) = value.get("entries").and_then(Value::as_object) else {
            continue;
        };
        let root_id = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("?");
        for (entry_path, entry) in entries {
            let Some(hash) = entry.get("hash").and_then(Value::as_str) else {
                continue;
            };
            if hash.len() != 64 || !blob_path(store.root(), hash).is_file() {
                findings.push(FsckFinding {
                    kind: FsckFindingKind::CacheStale,
                    path: relative(store, &path),
                    detail: format!(
                        "root {root_id}: cache entry {entry_path} points to missing blob {hash}"
                    ),
                    action: FsckAction::AutoRepair,
                    repaired: false,
                });
            }
        }
    }
    Ok(findings)
}

fn write_repair_journal(store: &Store, report: &FsckReport) -> Result<PathBuf, FsckError> {
    let at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let journal_path = store
        .root()
        .join("gc")
        .join(format!("{at_ms:013}-fsck.json"));
    let planned: Vec<String> = report
        .findings
        .iter()
        .filter(|finding| finding.action == FsckAction::AutoRepair)
        .map(|finding| finding.path.clone())
        .collect();
    let body = serde_json::json!({
        "v": 1,
        "state": "planned",
        "at_ms": at_ms,
        "planned": planned,
    });
    let bytes = serde_json::to_vec(&body).map_err(|source| FsckError::Json {
        path: journal_path.clone(),
        source,
    })?;
    store.write_atomic(&journal_path, &bytes)?;
    Ok(journal_path)
}

pub fn fsck_store(store: &Store, repair: bool) -> Result<FsckReport, FsckError> {
    let _lock = store.lock()?;
    let manifest_scan = scan_manifests(store)?;
    let corrupt_manifests = !manifest_scan.findings.is_empty();
    let refs = referenced_blobs(&manifest_scan.manifests);
    let mut findings = manifest_scan.findings;
    findings.extend(scan_slices(store, &manifest_scan.manifests)?);
    findings.extend(scan_blobs(store, &refs, corrupt_manifests)?);
    findings.extend(scan_cache(store)?);
    findings
        .sort_by(|left, right| (left.kind as u8, &left.path).cmp(&(right.kind as u8, &right.path)));

    let mut report = FsckReport {
        findings,
        repaired: false,
        journal: None,
    };
    if !repair || report.is_clean() {
        return Ok(report);
    }
    // Never unlink an orphan blob while a corrupt manifest could still refer to it.
    if corrupt_manifests {
        for finding in &mut report.findings {
            if finding.kind == FsckFindingKind::OrphanBlob
                && finding.action == FsckAction::AutoRepair
            {
                finding.action = FsckAction::ReportOnly;
                finding
                    .detail
                    .push_str(" (repair skipped: corrupt manifest exists)");
            }
        }
    }
    let journal = write_repair_journal(store, &report)?;
    report.journal = Some(journal);
    report.repaired = true;

    for finding in &mut report.findings {
        if finding.action != FsckAction::AutoRepair {
            continue;
        }
        let path = store.root().join(&finding.path);
        if finding.kind == FsckFindingKind::OrphanBlob
            || finding.kind == FsckFindingKind::TruncatedBlob
        {
            match fs::remove_file(&path) {
                Ok(()) => finding.repaired = true,
                Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
                    finding.repaired = true;
                }
                Err(source) => return Err(io_error(&path, source)),
            }
        } else if finding.kind == FsckFindingKind::CacheStale {
            // Cache is disposable; rewrite it after removing stale entries.
            let value = read_json(&path)?;
            let Some(entries) = value.get("entries").and_then(Value::as_object) else {
                continue;
            };
            let mut retained = serde_json::Map::new();
            for (entry_path, entry) in entries {
                let Some(hash) = entry.get("hash").and_then(Value::as_str) else {
                    continue;
                };
                if blob_path(store.root(), hash).is_file() {
                    retained.insert(entry_path.clone(), entry.clone());
                }
            }
            let rewritten = serde_json::json!({ "v": 1, "entries": retained });
            let bytes = serde_json::to_vec(&rewritten).map_err(|source| FsckError::Json {
                path: path.clone(),
                source,
            })?;
            // Cache has no durability contract; missing on crash means full rehash.
            let _ = fs::remove_file(&path);
            store.write_atomic(&path, &bytes)?;
            finding.repaired = true;
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;
    use crate::checkpoint_store::blob::{blob_path, write_blob};
    use crate::checkpoint_store::capture::{CaptureResult, capture_root};
    use crate::checkpoint_store::manifest::Manifest;

    struct Fixture {
        workspace: tempfile::TempDir,
        _store_dir: tempfile::TempDir,
        store: Store,
        result: CaptureResult,
    }

    fn write_file(root: &Path, relative: &str, content: &[u8]) {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent");
        }
        let mut file = fs::File::create(path).expect("file");
        file.write_all(content).expect("content");
    }

    fn fixture() -> Fixture {
        let workspace = tempfile::tempdir().expect("workspace");
        write_file(workspace.path(), "a.txt", b"alpha");
        write_file(workspace.path(), "dir/b.txt", b"beta");
        let store_dir = tempfile::tempdir().expect("store");
        let store = Store::init(store_dir.path()).expect("init store");
        let result = capture_root(&store, workspace.path(), "ws-1", None, None).expect("capture");
        Fixture {
            workspace,
            _store_dir: store_dir,
            store,
            result,
        }
    }

    fn referenced_manifest(store: &Store, result: &CaptureResult) -> Manifest {
        let bytes = fs::read(store.manifest_path(&result.manifest_id)).expect("manifest bytes");
        Manifest::parse(&bytes).expect("parse manifest")
    }

    #[test]
    fn clean_store_reports_nothing() {
        let fixture = fixture();
        let report = fsck_store(&fixture.store, false).expect("fsck");
        assert!(report.is_clean(), "{:?}", report.findings);
        let report = fsck_store(&fixture.store, true).expect("fsck repair");
        assert!(report.is_clean());
        assert!(report.journal.is_none());
    }

    #[test]
    fn orphan_blob_is_read_only_by_default_and_repaired_with_flag() {
        let fixture = fixture();
        let orphan = write_blob(fixture.store.root(), b"orphan-payload").expect("orphan blob");
        let orphan_path = blob_path(fixture.store.root(), &orphan.hash);

        let report = fsck_store(&fixture.store, false).expect("fsck");
        assert_eq!(report.count(FsckFindingKind::OrphanBlob), 1);
        assert!(orphan_path.is_file(), "default fsck must not delete");
        assert!(!report.repaired);

        let repaired = fsck_store(&fixture.store, true).expect("repair");
        assert!(repaired.repaired);
        assert!(repaired.journal.is_some());
        assert!(!orphan_path.exists(), "repair must delete the orphan blob");
        let finding = repaired
            .findings
            .iter()
            .find(|finding| finding.kind == FsckFindingKind::OrphanBlob)
            .expect("orphan finding");
        assert!(finding.repaired);
    }

    #[test]
    fn missing_blob_is_unrepairable_and_never_deleted() {
        let fixture = fixture();
        let manifest = referenced_manifest(&fixture.store, &fixture.result);
        let hash = manifest.entries[0].blob_hash.clone();
        let path = blob_path(fixture.store.root(), &hash);
        fs::remove_file(&path).expect("remove blob");

        let report = fsck_store(&fixture.store, false).expect("fsck");
        assert_eq!(report.count(FsckFindingKind::MissingBlob), 1);
        let repaired = fsck_store(&fixture.store, true).expect("repair");
        let finding = repaired
            .findings
            .iter()
            .find(|finding| finding.kind == FsckFindingKind::MissingBlob)
            .expect("missing finding");
        assert_eq!(finding.action, FsckAction::Unrepairable);
        assert!(!finding.repaired);
        assert!(!path.exists());
    }

    #[test]
    fn truncated_blob_is_unrepairable_when_referenced() {
        let fixture = fixture();
        let manifest = referenced_manifest(&fixture.store, &fixture.result);
        let hash = manifest.entries[0].blob_hash.clone();
        let path = blob_path(fixture.store.root(), &hash);
        fs::write(&path, b"broken").expect("truncate blob");

        let report = fsck_store(&fixture.store, false).expect("fsck");
        assert_eq!(report.count(FsckFindingKind::TruncatedBlob), 1);
        let repaired = fsck_store(&fixture.store, true).expect("repair");
        let finding = repaired
            .findings
            .iter()
            .find(|finding| finding.kind == FsckFindingKind::TruncatedBlob)
            .expect("truncated finding");
        assert_eq!(finding.action, FsckAction::Unrepairable);
        assert!(!finding.repaired);
        assert_eq!(fs::read(&path).expect("blob still exists"), b"broken");
    }

    #[test]
    fn orphan_slice_parent_chain_is_reported_and_not_deleted() {
        let fixture = fixture();
        write_file(fixture.workspace.path(), "a.txt", b"changed-content");
        let second = capture_root(&fixture.store, fixture.workspace.path(), "ws-1", None, None)
            .expect("second capture");
        let slices =
            collect_files(&fixture.store.slice_dir("ws-1"), Some("json")).expect("slice files");
        assert!(slices.len() >= 2);
        fs::remove_file(&slices[0]).expect("remove first slice");

        let report = fsck_store(&fixture.store, false).expect("fsck");
        assert!(report.count(FsckFindingKind::OrphanSlice) >= 1);
        let repaired = fsck_store(&fixture.store, true).expect("repair");
        assert!(repaired.count(FsckFindingKind::OrphanSlice) >= 1);
        assert!(
            fixture
                .store
                .slice_dir("ws-1")
                .join(format!("{}.json", second.slice_id))
                .is_file(),
            "repair must not delete slices"
        );
    }

    #[test]
    fn stale_cache_entry_is_reported_and_repaired() {
        let fixture = fixture();
        let cache_path = fixture.store.stat_cache_path("ws-1");
        let mut cache: Value =
            serde_json::from_slice(&fs::read(&cache_path).expect("cache")).expect("cache json");
        cache["entries"]["stale.txt"] = serde_json::json!({
            "hash": "0".repeat(64),
            "size": 1,
            "mtime_ns": 1,
        });
        fs::write(
            &cache_path,
            serde_json::to_vec(&cache).expect("encode cache"),
        )
        .expect("write cache");

        let report = fsck_store(&fixture.store, false).expect("fsck");
        assert_eq!(report.count(FsckFindingKind::CacheStale), 1);
        let before: Value =
            serde_json::from_slice(&fs::read(&cache_path).expect("cache")).expect("json");
        assert!(
            before["entries"].get("stale.txt").is_some(),
            "default fsck must not edit cache"
        );

        let repaired = fsck_store(&fixture.store, true).expect("repair");
        assert_eq!(repaired.count(FsckFindingKind::CacheStale), 1);
        let after: Value =
            serde_json::from_slice(&fs::read(&cache_path).expect("cache")).expect("json");
        assert!(after["entries"].get("stale.txt").is_none());
        assert!(
            repaired
                .findings
                .iter()
                .filter(|finding| finding.kind == FsckFindingKind::CacheStale)
                .all(|finding| finding.repaired)
        );
    }

    #[test]
    fn referenced_blob_hash_is_still_intact_after_repair_run() {
        // Guard against fsck repair ever deleting referenced content.
        let fixture = fixture();
        let orphan = write_blob(fixture.store.root(), b"orphan-2").expect("orphan");
        let report = fsck_store(&fixture.store, true).expect("repair");
        assert!(report.repaired);
        assert!(!blob_path(fixture.store.root(), &orphan.hash).exists());
        let manifest = referenced_manifest(&fixture.store, &fixture.result);
        for entry in manifest.entries {
            assert!(
                blob_path(fixture.store.root(), &entry.blob_hash).is_file(),
                "referenced blob {} was deleted",
                entry.blob_hash
            );
        }
    }
}
