//! Durable dual-write audit records (`index/dual/pending`, T1.10 harness).
//!
//! Capture writes only the small pair record in the hot path; a separate
//! replay compares it with the git tree and moves it to `done/` on success.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::store::{Store, StoreError};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DualPendingRecord {
    pub v: u8,
    pub root_id: String,
    pub run_id: String,
    pub git_ref: Option<String>,
    pub git_tree: String,
    pub store_slice_id: String,
    pub store_manifest_id: String,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AuditFinding {
    pub kind: &'static str,
    pub path: String,
    pub expected: String,
    pub actual: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuditReport {
    pub audited: usize,
    pub passed: usize,
    pub failed: usize,
    pub findings: Vec<AuditFinding>,
}

fn safe_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains('/')
        && !value.contains('\\')
}

pub fn pending_dir(store: &Store) -> PathBuf {
    store.root().join("index").join("dual").join("pending")
}

pub fn done_dir(store: &Store) -> PathBuf {
    store.root().join("index").join("dual").join("done")
}

pub fn pending_path(store: &Store, root_id: &str, run_id: &str) -> Option<PathBuf> {
    if !safe_component(root_id) || !safe_component(run_id) {
        return None;
    }
    Some(
        pending_dir(store)
            .join(root_id)
            .join(format!("{run_id}.json")),
    )
}

pub fn done_path(store: &Store, root_id: &str, run_id: &str) -> Option<PathBuf> {
    if !safe_component(root_id) || !safe_component(run_id) {
        return None;
    }
    Some(done_dir(store).join(root_id).join(format!("{run_id}.json")))
}

pub fn write_pending(store: &Store, record: &DualPendingRecord) -> Result<(), StoreError> {
    let Some(path) = pending_path(store, &record.root_id, &record.run_id) else {
        return Err(StoreError::Io {
            path: store.root().to_path_buf(),
            source: std::io::Error::other(format!(
                "invalid audit record path {}/{}",
                record.root_id, record.run_id
            )),
        });
    };
    let bytes = serde_json::to_vec(record).map_err(|error| StoreError::Io {
        path,
        source: std::io::Error::other(format!("pending encode: {error}")),
    })?;
    store.write_atomic(
        &pending_path(store, &record.root_id, &record.run_id).expect("validated path"),
        &bytes,
    )
}

pub fn list_pending(
    store: &Store,
    root_filter: Option<&str>,
    run_filter: Option<&str>,
) -> Result<Vec<(PathBuf, DualPendingRecord)>, std::io::Error> {
    let root = pending_dir(store);
    let mut out = Vec::new();
    collect_pending(&root, root_filter, run_filter, &mut out)?;
    out.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(out)
}

fn collect_pending(
    dir: &Path,
    root_filter: Option<&str>,
    run_filter: Option<&str>,
    out: &mut Vec<(PathBuf, DualPendingRecord)>,
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
            collect_pending(&path, root_filter, run_filter, out)?;
            continue;
        }
        if path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        let Some(root) = path
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
        else {
            continue;
        };
        let Some(run) = path.file_stem().and_then(|name| name.to_str()) else {
            continue;
        };
        if root_filter.is_some_and(|filter| filter != root)
            || run_filter.is_some_and(|filter| filter != run)
        {
            continue;
        }
        let bytes = fs::read(&path)?;
        if let Ok(record) = serde_json::from_slice::<DualPendingRecord>(&bytes) {
            out.push((path, record));
        }
    }
    Ok(())
}

pub fn move_to_done(store: &Store, record: &DualPendingRecord) -> Result<(), std::io::Error> {
    let Some(done) = done_path(store, &record.root_id, &record.run_id) else {
        return Err(std::io::Error::other("invalid audit record path"));
    };
    if let Some(parent) = done.parent() {
        fs::create_dir_all(parent)?;
    }
    let Some(pending) = pending_path(store, &record.root_id, &record.run_id) else {
        return Err(std::io::Error::other("invalid audit pending path"));
    };
    fs::rename(pending, done)
}

pub fn write_failure(
    store: &Store,
    record: &DualPendingRecord,
    findings: &[AuditFinding],
) -> Result<(), std::io::Error> {
    let Some(pending) = pending_path(store, &record.root_id, &record.run_id) else {
        return Err(std::io::Error::other("invalid audit pending path"));
    };
    let path = pending.with_extension("error.json");
    let body = serde_json::json!({
        "v": 1,
        "root_id": record.root_id,
        "run_id": record.run_id,
        "findings": findings,
    });
    let bytes = serde_json::to_vec(&body).map_err(std::io::Error::other)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, bytes)
}
