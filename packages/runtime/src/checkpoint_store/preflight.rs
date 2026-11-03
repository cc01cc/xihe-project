//! P2.0 self-mode preflight (dry-run; no mode switch).
//!
//! Validates the store, backfills `index/refs` from audited dual records, and
//! reports blockers (unmapped refs/slices, symlink manifests, corrupt objects).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use super::audit::{self, DualPendingRecord};
use super::fsck::{FsckAction, fsck_store};
use super::manifest::{FileMode, Manifest};
use super::refs::{self, RefRecord};
use super::store::Store;

#[derive(Debug, Clone, Default)]
pub struct PreflightOptions {
    pub roots: Vec<String>,
    /// Optional shadow git dir per root; when present, verify git_ref -> git_tree.
    pub shadow_git_dirs: HashMap<String, PathBuf>,
    /// Explicit override: symlink blockers become restricted-root warnings.
    pub allow_symlink_override: bool,
    /// P2.0 dry-run leaves this false; the switch path sets true only after
    /// P2.2 read adapters are complete.
    pub enforce_read_paths: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PreflightBlocker {
    pub code: &'static str,
    pub root_id: String,
    pub detail: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub struct RootPreflight {
    pub root_id: String,
    pub store_slices: usize,
    pub mapped_refs: usize,
    pub backfilled_refs: usize,
    pub unmapped_slices: Vec<String>,
    pub symlink_blockers: Vec<String>,
    pub restricted: bool,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub struct PreflightReport {
    pub ok: bool,
    pub store_ok: bool,
    pub fsck_clean: bool,
    pub roots: Vec<RootPreflight>,
    pub blockers: Vec<PreflightBlocker>,
    pub warnings: Vec<String>,
}

pub fn run_preflight(
    store: &Store,
    options: &PreflightOptions,
) -> Result<PreflightReport, std::io::Error> {
    let mut report = PreflightReport {
        store_ok: true,
        ..PreflightReport::default()
    };
    let fsck = fsck_store(store, false)
        .map_err(|error| std::io::Error::other(format!("fsck failed during preflight: {error}")))?;
    report.fsck_clean = fsck.is_clean();
    for finding in &fsck.findings {
        let detail = format!("{:?} {}: {}", finding.kind, finding.path, finding.detail);
        if finding.action == FsckAction::Unrepairable {
            report.blockers.push(PreflightBlocker {
                code: "SELF_STORE_CORRUPT",
                root_id: String::new(),
                detail,
                paths: vec![finding.path.clone()],
            });
        } else {
            report.warnings.push(detail);
        }
    }

    for root_id in &options.roots {
        let root_report = preflight_root(store, root_id, options, &mut report)?;
        report.roots.push(root_report);
    }
    report.ok = report.blockers.is_empty();
    Ok(report)
}

fn preflight_root(
    store: &Store,
    root_id: &str,
    options: &PreflightOptions,
    report: &mut PreflightReport,
) -> Result<RootPreflight, std::io::Error> {
    let mut out = RootPreflight {
        root_id: root_id.to_owned(),
        ..RootPreflight::default()
    };
    let mut slices: BTreeMap<String, String> = BTreeMap::new();
    let dir = store.slice_dir(root_id);
    match fs::read_dir(&dir) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry?;
                let path = entry.path();
                if path.extension().is_none_or(|ext| ext != "json") {
                    continue;
                }
                let bytes = match fs::read(&path) {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        report.blockers.push(PreflightBlocker {
                            code: "SELF_STORE_CORRUPT",
                            root_id: root_id.to_owned(),
                            detail: format!("slice unreadable {}: {error}", path.display()),
                            paths: vec![path.display().to_string()],
                        });
                        continue;
                    }
                };
                let value: serde_json::Value = match serde_json::from_slice(&bytes) {
                    Ok(value) => value,
                    Err(error) => {
                        report.blockers.push(PreflightBlocker {
                            code: "SELF_STORE_CORRUPT",
                            root_id: root_id.to_owned(),
                            detail: format!("slice corrupt {}: {error}", path.display()),
                            paths: vec![path.display().to_string()],
                        });
                        continue;
                    }
                };
                let (Some(id), Some(manifest)) = (
                    value.get("id").and_then(|value| value.as_str()),
                    value.get("manifest").and_then(|value| value.as_str()),
                ) else {
                    report.blockers.push(PreflightBlocker {
                        code: "SELF_STORE_CORRUPT",
                        root_id: root_id.to_owned(),
                        detail: format!("slice missing id/manifest {}", path.display()),
                        paths: vec![path.display().to_string()],
                    });
                    continue;
                };
                slices.insert(id.to_owned(), manifest.to_owned());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    out.store_slices = slices.len();

    // Backfill from audited dual done records.
    for record in list_done(store, root_id)? {
        let Some(git_ref) = record.git_ref.as_deref() else {
            report.blockers.push(PreflightBlocker {
                code: "STORE_SLICE_UNMAPPED",
                root_id: root_id.to_owned(),
                detail: format!("done record {} has no git_ref", record.run_id),
                paths: Vec::new(),
            });
            continue;
        };
        if !slices.contains_key(&record.store_slice_id) {
            report.blockers.push(PreflightBlocker {
                code: "SELF_REF_STORE_MISSING",
                root_id: root_id.to_owned(),
                detail: format!(
                    "done record {} references missing store slice {}",
                    record.run_id, record.store_slice_id
                ),
                paths: vec![record.store_slice_id.clone()],
            });
            continue;
        }
        if let Err(detail) = validate_done(store, &record, git_ref, options) {
            report.blockers.push(PreflightBlocker {
                code: "SELF_REF_INVALID",
                root_id: root_id.to_owned(),
                detail,
                paths: vec![git_ref.to_owned()],
            });
            continue;
        }
        let desired = RefRecord {
            v: 1,
            root_id: root_id.to_owned(),
            git_ref: git_ref.to_owned(),
            git_tree: record.git_tree.clone(),
            store_slice_id: record.store_slice_id.clone(),
            store_manifest_id: record.store_manifest_id.clone(),
            source: "dual_done".into(),
            created_at_ms: record.created_at_ms,
        };
        match refs::read_ref(store, root_id, git_ref)? {
            Some(existing) if existing != desired => {
                report.blockers.push(PreflightBlocker {
                    code: "SELF_REF_CONFLICT",
                    root_id: root_id.to_owned(),
                    detail: format!("existing ref sidecar differs for {git_ref}"),
                    paths: vec![git_ref.to_owned()],
                });
                continue;
            }
            Some(_) => {}
            None => {
                refs::write_ref(store, &desired).map_err(|error| {
                    std::io::Error::other(format!("write ref {git_ref}: {error}"))
                })?;
                out.backfilled_refs += 1;
            }
        }
    }

    let all_refs = refs::list_refs(store, root_id)?;
    out.mapped_refs = all_refs.len();
    let mapped_slices: BTreeSet<&str> = all_refs
        .iter()
        .map(|(_, record)| record.store_slice_id.as_str())
        .collect();
    for slice_id in slices.keys() {
        if !mapped_slices.contains(slice_id.as_str()) {
            out.unmapped_slices.push(slice_id.clone());
        }
    }
    if !out.unmapped_slices.is_empty() {
        report.blockers.push(PreflightBlocker {
            code: "STORE_SLICE_UNMAPPED",
            root_id: root_id.to_owned(),
            detail: format!(
                "{} store slices have no index/refs mapping",
                out.unmapped_slices.len()
            ),
            paths: out.unmapped_slices.clone(),
        });
    }
    for (_, record) in &all_refs {
        if !slices.contains_key(&record.store_slice_id) {
            report.blockers.push(PreflightBlocker {
                code: "SELF_REF_STORE_MISSING",
                root_id: root_id.to_owned(),
                detail: format!("ref {} points to missing store slice", record.git_ref),
                paths: vec![record.store_slice_id.clone()],
            });
        }
    }

    // Symlink scan over every mapped store slice manifest.
    let mut symlink_paths = Vec::new();
    for (slice_id, manifest_id) in &slices {
        let path = store.manifest_path(manifest_id);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) => {
                report.blockers.push(PreflightBlocker {
                    code: "SELF_STORE_CORRUPT",
                    root_id: root_id.to_owned(),
                    detail: format!("manifest unreadable {}: {error}", path.display()),
                    paths: vec![slice_id.clone()],
                });
                continue;
            }
        };
        let manifest = match Manifest::parse_verified(&bytes, manifest_id) {
            Ok(manifest) => manifest,
            Err(error) => {
                report.blockers.push(PreflightBlocker {
                    code: "SELF_STORE_CORRUPT",
                    root_id: root_id.to_owned(),
                    detail: format!("manifest corrupt {}: {error}", path.display()),
                    paths: vec![slice_id.clone()],
                });
                continue;
            }
        };
        for entry in &manifest.entries {
            if entry.mode == FileMode::Symlink {
                symlink_paths.push(format!("{slice_id}:{}", entry.path));
            }
        }
    }
    out.symlink_blockers = symlink_paths;
    if !out.symlink_blockers.is_empty() {
        if options.allow_symlink_override {
            out.restricted = true;
            report.warnings.push(format!(
                "root {root_id} is restricted due to {} symlink entries (override set); restore must fail closed",
                out.symlink_blockers.len()
            ));
        } else {
            report.blockers.push(PreflightBlocker {
                code: "SELF_SYMLINK_BLOCKED",
                root_id: root_id.to_owned(),
                detail: format!(
                    "{} symlink entries; first: {}",
                    out.symlink_blockers.len(),
                    out.symlink_blockers.first().cloned().unwrap_or_default()
                ),
                paths: out.symlink_blockers.clone(),
            });
        }
    }
    Ok(out)
}

fn list_done(store: &Store, root_id: &str) -> Result<Vec<DualPendingRecord>, std::io::Error> {
    fn collect(
        dir: &Path,
        root_id: &str,
        out: &mut Vec<DualPendingRecord>,
    ) -> Result<(), std::io::Error> {
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if entry.file_type()?.is_dir() {
                collect(&path, root_id, out)?;
                continue;
            }
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let bytes = fs::read(&path)?;
            if let Ok(record) = serde_json::from_slice::<DualPendingRecord>(&bytes)
                && record.root_id == root_id
            {
                out.push(record);
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    collect(&audit::done_dir(store), root_id, &mut out)?;
    out.sort_by_key(|left| left.created_at_ms);
    Ok(out)
}

fn validate_done(
    store: &Store,
    record: &DualPendingRecord,
    git_ref: &str,
    options: &PreflightOptions,
) -> Result<(), String> {
    let slice_path = store
        .slice_dir(&record.root_id)
        .join(format!("{}.json", record.store_slice_id));
    let bytes = fs::read(&slice_path).map_err(|error| format!("slice unreadable: {error}"))?;
    let slice: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|error| format!("slice decode: {error}"))?;
    if slice.get("manifest").and_then(|value| value.as_str())
        != Some(record.store_manifest_id.as_str())
    {
        return Err("done record manifest_id does not match store slice".into());
    }
    let manifest_path = store.manifest_path(&record.store_manifest_id);
    let manifest_bytes =
        fs::read(&manifest_path).map_err(|error| format!("manifest unreadable: {error}"))?;
    Manifest::parse_verified(&manifest_bytes, &record.store_manifest_id)
        .map_err(|error| format!("manifest invalid: {error}"))?;
    if let Some(shadow) = options.shadow_git_dirs.get(&record.root_id) {
        let output = Command::new("git")
            .arg("--git-dir")
            .arg(shadow)
            .args(["rev-parse", &format!("{git_ref}^{{tree}}")])
            .output()
            .map_err(|error| format!("git validation spawn failed: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "git ref {git_ref} cannot be resolved: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let tree = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if tree != record.git_tree {
            return Err(format!(
                "git_tree mismatch for {git_ref}: expected {}, git has {tree}",
                record.git_tree
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checkpoint_store::blob::write_blob;
    use crate::checkpoint_store::capture::capture_root;
    use crate::checkpoint_store::manifest::ManifestEntry;

    fn workspace() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    fn write_done(
        store: &Store,
        root_id: &str,
        run_id: &str,
        git_ref: &str,
        slice_id: &str,
        manifest_id: &str,
        git_tree: &str,
    ) {
        let record = DualPendingRecord {
            v: 1,
            root_id: root_id.into(),
            run_id: run_id.into(),
            git_ref: Some(git_ref.into()),
            git_tree: git_tree.into(),
            store_slice_id: slice_id.into(),
            store_manifest_id: manifest_id.into(),
            created_at_ms: 0,
        };
        let path = audit::done_path(store, root_id, run_id).expect("done path");
        fs::create_dir_all(path.parent().expect("parent")).expect("done dir");
        fs::write(path, serde_json::to_vec(&record).expect("record")).expect("done record");
    }

    #[test]
    fn backfills_done_refs_and_leaves_no_unmapped_slices() {
        let temp = workspace();
        let root = temp.path().join("ws");
        fs::create_dir_all(&root).expect("root");
        fs::write(root.join("a.txt"), "a").expect("a");
        let store = Store::init(temp.path().join("store")).expect("store");
        let first = capture_root(&store, &root, "ws-1", None, None).expect("first");
        fs::write(root.join("b.txt"), "b").expect("b");
        let second = capture_root(&store, &root, "ws-1", None, None).expect("second");
        write_done(
            &store,
            "ws-1",
            "run-1",
            "refs/xihe/slices/1",
            &first.slice_id,
            &first.manifest_id,
            "1111111111111111111111111111111111111111",
        );
        write_done(
            &store,
            "ws-1",
            "run-2",
            "refs/xihe/slices/2",
            &second.slice_id,
            &second.manifest_id,
            "2222222222222222222222222222222222222222",
        );
        let report = run_preflight(
            &store,
            &PreflightOptions {
                roots: vec!["ws-1".into()],
                ..PreflightOptions::default()
            },
        )
        .expect("preflight");
        assert!(report.ok, "{report:?}");
        assert_eq!(report.roots[0].backfilled_refs, 2);
        assert_eq!(report.roots[0].mapped_refs, 2);
        assert!(report.roots[0].unmapped_slices.is_empty());
        assert!(
            refs::read_ref(&store, "ws-1", "refs/xihe/slices/1")
                .expect("ref")
                .is_some()
        );
    }

    #[test]
    fn missing_done_mapping_is_explicit_blocker() {
        let temp = workspace();
        let root = temp.path().join("ws");
        fs::create_dir_all(&root).expect("root");
        fs::write(root.join("a.txt"), "a").expect("a");
        let store = Store::init(temp.path().join("store")).expect("store");
        let first = capture_root(&store, &root, "ws-1", None, None).expect("first");
        fs::write(root.join("b.txt"), "b").expect("b");
        let second = capture_root(&store, &root, "ws-1", None, None).expect("second");
        write_done(
            &store,
            "ws-1",
            "run-1",
            "refs/xihe/slices/1",
            &first.slice_id,
            &first.manifest_id,
            "1111111111111111111111111111111111111111",
        );
        let report = run_preflight(
            &store,
            &PreflightOptions {
                roots: vec!["ws-1".into()],
                ..PreflightOptions::default()
            },
        )
        .expect("preflight");
        assert!(!report.ok);
        assert!(
            report.blockers.iter().any(|blocker| {
                blocker.code == "STORE_SLICE_UNMAPPED" && blocker.paths.contains(&second.slice_id)
            }),
            "{report:?}"
        );
    }

    #[test]
    fn symlink_manifest_blocks_or_restricts_with_override() {
        let temp = workspace();
        let store = Store::init(temp.path().join("store")).expect("store");
        let blob = write_blob(store.root(), b"../outside").expect("blob");
        let manifest = Manifest::from_entries(vec![
            ManifestEntry::new("link".to_string(), FileMode::Symlink, 10, blob.hash)
                .expect("entry"),
        ])
        .expect("manifest");
        let manifest_bytes = manifest.canonical_bytes().expect("manifest bytes");
        let manifest_id = manifest.manifest_id().expect("manifest id");
        store
            .write_atomic(&store.manifest_path(&manifest_id), &manifest_bytes)
            .expect("manifest write");
        let slice_id = "0000000000001-symlink";
        let slice = serde_json::json!({
            "v": 1,
            "id": slice_id,
            "manifest": manifest_id,
            "merkle_root": manifest.merkle_root,
            "entry_count": manifest.entries.len(),
            "total_bytes": manifest.total_bytes,
            "state": "captured"
        });
        store
            .write_atomic(
                &store.slice_dir("ws-1").join(format!("{slice_id}.json")),
                &serde_json::to_vec(&slice).expect("slice"),
            )
            .expect("slice write");
        write_done(
            &store,
            "ws-1",
            "run-symlink",
            "refs/xihe/slices/symlink",
            slice_id,
            &manifest_id,
            "3333333333333333333333333333333333333333",
        );

        let blocked = run_preflight(
            &store,
            &PreflightOptions {
                roots: vec!["ws-1".into()],
                ..PreflightOptions::default()
            },
        )
        .expect("preflight");
        assert!(!blocked.ok);
        assert!(
            blocked
                .blockers
                .iter()
                .any(|blocker| blocker.code == "SELF_SYMLINK_BLOCKED")
        );
        assert_eq!(blocked.roots[0].symlink_blockers.len(), 1);
        assert!(blocked.roots[0].symlink_blockers[0].contains("link"));

        let overridden = run_preflight(
            &store,
            &PreflightOptions {
                roots: vec!["ws-1".into()],
                allow_symlink_override: true,
                ..PreflightOptions::default()
            },
        )
        .expect("preflight");
        assert!(overridden.ok, "{overridden:?}");
        assert!(overridden.roots[0].restricted);
    }

    #[test]
    fn enforce_read_paths_passes_after_p22_adapters() {
        let temp = workspace();
        let root = temp.path().join("ws");
        fs::create_dir_all(&root).expect("root");
        fs::write(root.join("a.txt"), "a").expect("a");
        let store = Store::init(temp.path().join("store")).expect("store");
        let first = capture_root(&store, &root, "ws-1", None, None).expect("capture");
        write_done(
            &store,
            "ws-1",
            "run-enforce",
            "refs/xihe/slices/enforce",
            &first.slice_id,
            &first.manifest_id,
            "4444444444444444444444444444444444444444",
        );
        let report = run_preflight(
            &store,
            &PreflightOptions {
                roots: vec!["ws-1".into()],
                enforce_read_paths: true,
                ..PreflightOptions::default()
            },
        )
        .expect("preflight");
        assert!(report.ok, "{report:?}");
        assert!(
            !report
                .blockers
                .iter()
                .any(|blocker| blocker.code == "SELF_READ_PATH_INCOMPLETE")
        );
    }
}
