//! P2 external slice-ref -> store-slice sidecar (`index/refs`).
//!
//! FORMAT v1 keeps store slice JSON frozen, so the mapping from the public git
//! slice ref to the store slice id lives in a separate index sidecar.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::blob::blob_hash;
use super::store::{Store, StoreError, root_id_dir};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RefRecord {
    pub v: u8,
    pub root_id: String,
    pub git_ref: String,
    pub git_tree: String,
    pub store_slice_id: String,
    pub store_manifest_id: String,
    pub source: String,
    pub created_at_ms: u64,
}

pub fn refs_dir(store: &Store, root_id: &str) -> PathBuf {
    store
        .root()
        .join("index")
        .join("refs")
        .join(root_id_dir(root_id))
}

pub fn ref_path(store: &Store, root_id: &str, git_ref: &str) -> PathBuf {
    refs_dir(store, root_id).join(format!("{}.json", blob_hash(git_ref.as_bytes())))
}

pub fn write_ref(store: &Store, record: &RefRecord) -> Result<(), StoreError> {
    let bytes = serde_json::to_vec(record).map_err(|error| StoreError::Io {
        path: refs_dir(store, &record.root_id),
        source: std::io::Error::other(format!("ref encode: {error}")),
    })?;
    store.write_atomic(&ref_path(store, &record.root_id, &record.git_ref), &bytes)
}

pub fn read_ref(
    store: &Store,
    root_id: &str,
    git_ref: &str,
) -> Result<Option<RefRecord>, std::io::Error> {
    let path = ref_path(store, root_id, git_ref);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| std::io::Error::other(format!("ref decode {}: {error}", path.display())))
}

pub fn list_refs(
    store: &Store,
    root_id: &str,
) -> Result<Vec<(PathBuf, RefRecord)>, std::io::Error> {
    let dir = refs_dir(store, root_id);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        let bytes = fs::read(&path)?;
        let record: RefRecord = serde_json::from_slice(&bytes).map_err(|error| {
            std::io::Error::other(format!("ref decode {}: {error}", path.display()))
        })?;
        out.push((path, record));
    }
    out.sort_by(|left, right| left.1.git_ref.cmp(&right.1.git_ref));
    Ok(out)
}

pub fn missing_refs(
    store: &Store,
    root_id: &str,
    git_refs: &[String],
) -> Result<Vec<String>, std::io::Error> {
    let mut missing = Vec::new();
    for git_ref in git_refs {
        if read_ref(store, root_id, git_ref)?.is_none() {
            missing.push(git_ref.clone());
        }
    }
    Ok(missing)
}

pub fn remove_ref(store: &Store, root_id: &str, git_ref: &str) -> Result<(), std::io::Error> {
    let path = ref_path(store, root_id, git_ref);
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}
