//! P2.2 store read adapters: list slices and diff by external git ref.

use std::fs;

use serde::Serialize;

use super::manifest::{Manifest, ManifestDiff, ManifestError};
use super::refs;
use super::store::Store;
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StoreSliceSummary {
    pub slice_id: String,
    pub manifest_id: String,
    pub captured_at_ms: u64,
    pub state: String,
    pub entry_count: u64,
    pub total_bytes: u64,
    pub git_ref: Option<String>,
    pub mapped: bool,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct SliceList {
    pub slices: Vec<StoreSliceSummary>,
    /// Refs that exist in `index/refs` but have no store slice; API must surface
    /// them instead of silently showing a shorter history.
    pub dangling_refs: Vec<String>,
    pub unmapped_slices: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ReadError {
    #[error("STORE_SLICE_UNMAPPED: git ref {0:?} has no index/refs mapping")]
    UnmappedRef(String),
    #[error("STORE_SLICE_MISSING: store slice {0:?} is missing")]
    SliceMissing(String),
    #[error("STORE_CORRUPT: {0}")]
    StoreCorrupt(String),
    #[error("STORE_IO: {0}")]
    Io(#[from] std::io::Error),
}

pub fn list_slices(store: &Store, root_id: &str) -> Result<SliceList, ReadError> {
    let mut slices = Vec::new();
    let dir = store.slice_dir(root_id);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SliceList::default());
        }
        Err(error) => return Err(ReadError::Io(error)),
    };
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        let value: serde_json::Value = serde_json::from_slice(&fs::read(&path)?)
            .map_err(|error| ReadError::StoreCorrupt(format!("{}: {error}", path.display())))?;
        let Some(slice_id) = value.get("id").and_then(|value| value.as_str()) else {
            return Err(ReadError::StoreCorrupt(format!(
                "{} missing slice id",
                path.display()
            )));
        };
        let Some(manifest_id) = value.get("manifest").and_then(|value| value.as_str()) else {
            return Err(ReadError::StoreCorrupt(format!(
                "{} missing manifest id",
                path.display()
            )));
        };
        slices.push(StoreSliceSummary {
            slice_id: slice_id.to_owned(),
            manifest_id: manifest_id.to_owned(),
            captured_at_ms: value
                .get("captured_at_ms")
                .and_then(|value| value.as_u64())
                .unwrap_or(0),
            state: value
                .get("state")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown")
                .to_owned(),
            entry_count: value
                .get("entry_count")
                .and_then(|value| value.as_u64())
                .unwrap_or(0),
            total_bytes: value
                .get("total_bytes")
                .and_then(|value| value.as_u64())
                .unwrap_or(0),
            git_ref: None,
            mapped: false,
        });
    }
    slices.sort_by(|left, right| left.slice_id.cmp(&right.slice_id));

    let refs = refs::list_refs(store, root_id)?;
    let mut dangling_refs = Vec::new();
    for (_, record) in &refs {
        match slices
            .iter_mut()
            .find(|slice| slice.slice_id == record.store_slice_id)
        {
            Some(slice) => {
                slice.git_ref = Some(record.git_ref.clone());
                slice.mapped = true;
            }
            None => dangling_refs.push(record.git_ref.clone()),
        }
    }
    let unmapped_slices = slices
        .iter()
        .filter(|slice| !slice.mapped)
        .map(|slice| slice.slice_id.clone())
        .collect();
    Ok(SliceList {
        slices,
        dangling_refs,
        unmapped_slices,
    })
}

pub fn diff_refs(
    store: &Store,
    root_id: &str,
    from_ref: &str,
    to_ref: &str,
) -> Result<ManifestDiff, ReadError> {
    let from = resolve_ref(store, root_id, from_ref)?;
    let to = resolve_ref(store, root_id, to_ref)?;
    let from_manifest = read_manifest(store, &from.store_manifest_id)?;
    let to_manifest = read_manifest(store, &to.store_manifest_id)?;
    Ok(from_manifest.diff(&to_manifest))
}

fn resolve_ref(store: &Store, root_id: &str, git_ref: &str) -> Result<refs::RefRecord, ReadError> {
    refs::read_ref(store, root_id, git_ref)?
        .ok_or_else(|| ReadError::UnmappedRef(git_ref.to_owned()))
}

fn read_manifest(store: &Store, manifest_id: &str) -> Result<Manifest, ReadError> {
    let path = store.manifest_path(manifest_id);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(ReadError::SliceMissing(manifest_id.to_owned()));
        }
        Err(error) => return Err(ReadError::Io(error)),
    };
    Manifest::parse_verified(&bytes, manifest_id)
        .map_err(|error: ManifestError| ReadError::StoreCorrupt(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checkpoint_store::capture::capture_root;
    use crate::checkpoint_store::refs::RefRecord;

    fn ref_record(root_id: &str, git_ref: &str, slice_id: &str, manifest_id: &str) -> RefRecord {
        RefRecord {
            v: 1,
            root_id: root_id.into(),
            git_ref: git_ref.into(),
            git_tree: "0".repeat(40),
            store_slice_id: slice_id.into(),
            store_manifest_id: manifest_id.into(),
            source: "capture".into(),
            created_at_ms: 0,
        }
    }

    fn fixture() -> (tempfile::TempDir, Store, String, String, String, String) {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("ws");
        fs::create_dir_all(&root).expect("root");
        fs::write(root.join("a.txt"), "a").expect("a");
        let store = Store::init(temp.path().join("store")).expect("store");
        let first = capture_root(&store, &root, "ws-1", None, None).expect("first");
        fs::write(root.join("b.txt"), "b").expect("b");
        let second = capture_root(&store, &root, "ws-1", None, None).expect("second");
        (
            temp,
            store,
            first.slice_id,
            first.manifest_id,
            second.slice_id,
            second.manifest_id,
        )
    }

    #[test]
    fn list_exposes_unmapped_slices_and_refs() {
        let (_temp, store, first, first_manifest, second, _) = fixture();
        let before = list_slices(&store, "ws-1").expect("list");
        assert_eq!(before.slices.len(), 2);
        assert_eq!(before.unmapped_slices.len(), 2);
        refs::write_ref(
            &store,
            &ref_record("ws-1", "refs/xihe/slices/s1", &first, &first_manifest),
        )
        .expect("ref");
        let after = list_slices(&store, "ws-1").expect("list");
        assert_eq!(after.slices.iter().filter(|slice| slice.mapped).count(), 1);
        assert!(after.unmapped_slices.contains(&second));
        assert!(after.dangling_refs.is_empty());
    }

    #[test]
    fn diff_resolves_refs_and_rejects_unmapped() {
        let (_temp, store, first, first_manifest, second, second_manifest) = fixture();
        let from = "refs/xihe/slices/from";
        let to = "refs/xihe/slices/to";
        refs::write_ref(&store, &ref_record("ws-1", from, &first, &first_manifest)).expect("from");
        refs::write_ref(&store, &ref_record("ws-1", to, &second, &second_manifest)).expect("to");
        let diff = diff_refs(&store, "ws-1", from, to).expect("diff");
        assert_eq!(diff.added, vec!["b.txt"]);
        assert!(diff.is_empty() == false);
        let error =
            diff_refs(&store, "ws-1", "refs/xihe/slices/missing", to).expect_err("unmapped");
        assert!(matches!(error, ReadError::UnmappedRef(_)), "{error:?}");
    }
}
