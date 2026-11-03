//! Manifest codec, merkle root, and path-set diff (`FORMAT.md` §4).
//!
//! The manifest is the canonical, content-addressed description of one slice's
//! file set. Writers sort entries by UTF-8 path bytes and emit compact JSON
//! with a fixed key order; readers reject anything that is not canonical,
//! sorted, unique, and internally consistent. That strictness is what makes
//! `manifest_id = SHA-256(canonical bytes)` usable as an object name.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::blob::is_valid_blob_hash;

pub const MANIFEST_VERSION: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileMode {
    Regular,
    Executable,
    Symlink,
}

impl FileMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Regular => "100644",
            Self::Executable => "100755",
            Self::Symlink => "120000",
        }
    }

    fn parse(value: &str, path: &str) -> Result<Self, ManifestError> {
        match value {
            "100644" => Ok(Self::Regular),
            "100755" => Ok(Self::Executable),
            "120000" => Ok(Self::Symlink),
            _ => Err(ManifestError::InvalidMode {
                path: path.to_owned(),
                mode: value.to_owned(),
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestEntry {
    pub path: String,
    pub mode: FileMode,
    pub size: u64,
    pub blob_hash: String,
}

impl ManifestEntry {
    pub fn new(
        path: impl Into<String>,
        mode: FileMode,
        size: u64,
        blob_hash: impl Into<String>,
    ) -> Result<Self, ManifestError> {
        let path = path.into();
        let blob_hash = blob_hash.into();
        validate_path(&path)?;
        if !is_valid_blob_hash(&blob_hash) {
            return Err(ManifestError::InvalidBlobHash {
                path,
                hash: blob_hash,
            });
        }
        Ok(Self {
            path,
            mode,
            size,
            blob_hash,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    pub entries: Vec<ManifestEntry>,
    pub merkle_root: String,
    pub total_bytes: u64,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ManifestDiff {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub modified: Vec<String>,
}

impl ManifestDiff {
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && self.modified.is_empty()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("manifest JSON is invalid: {reason}")]
    Json { reason: String },
    #[error("manifest version {version} is not supported (expected 1)")]
    UnsupportedVersion { version: u8 },
    #[error("manifest entry path {path:?} is invalid: {reason}")]
    InvalidPath { path: String, reason: String },
    #[error("manifest entry {path:?} has unsupported mode {mode:?}")]
    InvalidMode { path: String, mode: String },
    #[error("manifest entry {path:?} has invalid blob hash {hash:?}")]
    InvalidBlobHash { path: String, hash: String },
    #[error("manifest entries are not strictly sorted by path")]
    UnsortedEntries,
    #[error("manifest contains duplicate path {path:?}")]
    DuplicatePath { path: String },
    #[error("manifest total_bytes {declared} does not match sum {actual}")]
    TotalBytesMismatch { declared: u64, actual: u64 },
    #[error("manifest merkle_root {declared:?} does not match computed {actual:?}")]
    MerkleMismatch { declared: String, actual: String },
    #[error("manifest bytes are not canonical")]
    NonCanonical,
    #[error("manifest id mismatch: expected {expected}, got {actual}")]
    ManifestIdMismatch { expected: String, actual: String },
    #[error("manifest size sum overflows u64")]
    SizeOverflow,
    #[error("manifest JSON serialization failed: {reason}")]
    Serialize { reason: String },
}

/// Shared raw shape: field order is the canonical key order, and tuple entries
/// serialize as `[path, mode, size, blob_hash]`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawManifest {
    v: u8,
    entries: Vec<(String, String, u64, String)>,
    merkle_root: String,
    total_bytes: u64,
}

fn validate_path(path: &str) -> Result<(), ManifestError> {
    if path.is_empty() {
        return Err(ManifestError::InvalidPath {
            path: path.to_owned(),
            reason: "path is empty".into(),
        });
    }
    if path.starts_with('/') {
        return Err(ManifestError::InvalidPath {
            path: path.to_owned(),
            reason: "path must be relative".into(),
        });
    }
    if path.contains('\\') {
        return Err(ManifestError::InvalidPath {
            path: path.to_owned(),
            reason: "path must use '/' separators".into(),
        });
    }
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(ManifestError::InvalidPath {
                path: path.to_owned(),
                reason: "path contains an empty, '.', or '..' segment".into(),
            });
        }
    }
    Ok(())
}

fn checked_total(entries: &[ManifestEntry]) -> Result<u64, ManifestError> {
    let mut total = 0u64;
    for entry in entries {
        total = total
            .checked_add(entry.size)
            .ok_or(ManifestError::SizeOverflow)?;
    }
    Ok(total)
}

fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(out, "{byte:02x}").expect("writing to String cannot fail");
    }
    out
}

fn sha256_hex(bytes: &[u8]) -> String {
    to_hex(&Sha256::digest(bytes))
}

fn leaf_hash(entry: &ManifestEntry) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update([0u8]);
    hasher.update(entry.path.as_bytes());
    hasher.update([0u8]);
    hasher.update(entry.mode.as_str().as_bytes());
    hasher.update([0u8]);
    hasher.update(entry.size.to_string().as_bytes());
    hasher.update([0u8]);
    hasher.update(entry.blob_hash.as_bytes());
    hasher.finalize().into()
}

fn node_hash(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update([1u8]);
    hasher.update(left);
    hasher.update(right);
    hasher.finalize().into()
}

/// Empty-tree root is 32 zero bytes, i.e. 64 `0` characters.
pub fn empty_merkle_root() -> String {
    "0".repeat(64)
}

/// Merkle root over sorted entries. Odd nodes are promoted unchanged.
pub fn merkle_root(entries: &[ManifestEntry]) -> String {
    if entries.is_empty() {
        return empty_merkle_root();
    }
    let mut level: Vec<[u8; 32]> = entries.iter().map(leaf_hash).collect();
    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        for pair in level.chunks(2) {
            next.push(match pair {
                [left, right] => node_hash(left, right),
                [only] => *only,
                _ => unreachable!("chunks(2) yields one or two elements"),
            });
        }
        level = next;
    }
    to_hex(&level[0])
}

fn entry_from_raw(
    path: String,
    mode: String,
    size: u64,
    blob_hash: String,
) -> Result<ManifestEntry, ManifestError> {
    validate_path(&path)?;
    let mode = FileMode::parse(&mode, &path)?;
    if !is_valid_blob_hash(&blob_hash) {
        return Err(ManifestError::InvalidBlobHash {
            path,
            hash: blob_hash,
        });
    }
    Ok(ManifestEntry {
        path,
        mode,
        size,
        blob_hash,
    })
}

impl Manifest {
    /// Writer path: accepts any order, sorts, validates, and computes the
    /// derived fields. The result's [`Self::canonical_bytes`] is deterministic.
    pub fn from_entries(mut entries: Vec<ManifestEntry>) -> Result<Self, ManifestError> {
        entries.sort_by(|left, right| left.path.as_bytes().cmp(right.path.as_bytes()));
        for (index, entry) in entries.iter().enumerate() {
            validate_path(&entry.path)?;
            if !is_valid_blob_hash(&entry.blob_hash) {
                return Err(ManifestError::InvalidBlobHash {
                    path: entry.path.clone(),
                    hash: entry.blob_hash.clone(),
                });
            }
            if index > 0 && entries[index - 1].path == entry.path {
                return Err(ManifestError::DuplicatePath {
                    path: entry.path.clone(),
                });
            }
        }
        let total_bytes = checked_total(&entries)?;
        let merkle_root = merkle_root(&entries);
        Ok(Self {
            entries,
            merkle_root,
            total_bytes,
        })
    }

    fn to_raw(&self) -> RawManifest {
        RawManifest {
            v: MANIFEST_VERSION,
            entries: self
                .entries
                .iter()
                .map(|entry| {
                    (
                        entry.path.clone(),
                        entry.mode.as_str().to_owned(),
                        entry.size,
                        entry.blob_hash.clone(),
                    )
                })
                .collect(),
            merkle_root: self.merkle_root.clone(),
            total_bytes: self.total_bytes,
        }
    }

    /// Compact, fixed-key-order JSON without trailing newline.
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, ManifestError> {
        serde_json::to_vec(&self.to_raw()).map_err(|error| ManifestError::Serialize {
            reason: error.to_string(),
        })
    }

    /// `SHA-256(canonical bytes)`, lowercase hex.
    pub fn manifest_id(&self) -> Result<String, ManifestError> {
        Ok(sha256_hex(&self.canonical_bytes()?))
    }

    /// Strict reader: JSON shape, version, paths/modes/hashes, sorted/unique
    /// order, total bytes, merkle root, and canonical byte representation.
    pub fn parse(bytes: &[u8]) -> Result<Self, ManifestError> {
        let raw: RawManifest =
            serde_json::from_slice(bytes).map_err(|error| ManifestError::Json {
                reason: error.to_string(),
            })?;
        if raw.v != MANIFEST_VERSION {
            return Err(ManifestError::UnsupportedVersion { version: raw.v });
        }

        let mut entries = Vec::with_capacity(raw.entries.len());
        for (path, mode, size, blob_hash) in raw.entries {
            entries.push(entry_from_raw(path, mode, size, blob_hash)?);
        }

        for pair in entries.windows(2) {
            let left = pair[0].path.as_bytes();
            let right = pair[1].path.as_bytes();
            if left == right {
                return Err(ManifestError::DuplicatePath {
                    path: pair[0].path.clone(),
                });
            }
            if left > right {
                return Err(ManifestError::UnsortedEntries);
            }
        }

        let actual_total = checked_total(&entries)?;
        if actual_total != raw.total_bytes {
            return Err(ManifestError::TotalBytesMismatch {
                declared: raw.total_bytes,
                actual: actual_total,
            });
        }
        let manifest = Self {
            entries,
            merkle_root: raw.merkle_root,
            total_bytes: raw.total_bytes,
        };
        let actual_merkle = merkle_root(&manifest.entries);
        if actual_merkle != manifest.merkle_root {
            return Err(ManifestError::MerkleMismatch {
                declared: manifest.merkle_root.clone(),
                actual: actual_merkle,
            });
        }

        let canonical = manifest.canonical_bytes()?;
        if canonical.as_slice() != bytes {
            return Err(ManifestError::NonCanonical);
        }
        Ok(manifest)
    }

    /// Parse and verify the content-addressed file name (`SHA-256(bytes)`).
    pub fn parse_verified(bytes: &[u8], expected_id: &str) -> Result<Self, ManifestError> {
        let manifest = Self::parse(bytes)?;
        let actual = manifest.manifest_id()?;
        if actual != expected_id {
            return Err(ManifestError::ManifestIdMismatch {
                expected: expected_id.to_owned(),
                actual,
            });
        }
        Ok(manifest)
    }

    /// Path-set diff: added/removed by path, modified by any of
    /// `(mode, size, blob_hash)`. Inputs are sorted by construction.
    pub fn diff(&self, other: &Self) -> ManifestDiff {
        let mut diff = ManifestDiff::default();
        let mut left = 0usize;
        let mut right = 0usize;
        while left < self.entries.len() && right < other.entries.len() {
            let left_entry = &self.entries[left];
            let right_entry = &other.entries[right];
            match left_entry.path.as_bytes().cmp(right_entry.path.as_bytes()) {
                std::cmp::Ordering::Less => {
                    diff.removed.push(left_entry.path.clone());
                    left += 1;
                }
                std::cmp::Ordering::Greater => {
                    diff.added.push(right_entry.path.clone());
                    right += 1;
                }
                std::cmp::Ordering::Equal => {
                    if left_entry.mode != right_entry.mode
                        || left_entry.size != right_entry.size
                        || left_entry.blob_hash != right_entry.blob_hash
                    {
                        diff.modified.push(left_entry.path.clone());
                    }
                    left += 1;
                    right += 1;
                }
            }
        }
        diff.removed
            .extend(self.entries[left..].iter().map(|entry| entry.path.clone()));
        diff.added.extend(
            other.entries[right..]
                .iter()
                .map(|entry| entry.path.clone()),
        );
        diff
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    use super::*;
    use crate::checkpoint_store::blob::blob_hash;

    #[derive(serde::Deserialize)]
    struct MerkleFixture {
        vectors: Vec<MerkleVector>,
    }

    #[derive(serde::Deserialize)]
    struct MerkleVector {
        name: String,
        entries: Vec<MerkleEntry>,
        merkle_root: String,
    }

    #[derive(serde::Deserialize)]
    struct MerkleEntry {
        path: String,
        mode: String,
        size: u64,
        blob_hash: String,
    }

    fn hash(marker: u8) -> String {
        format!("{marker:064x}")
    }

    fn entry(path: &str, size: u64, marker: u8) -> ManifestEntry {
        ManifestEntry::new(path, FileMode::Regular, size, hash(marker)).expect("valid test entry")
    }

    fn manifest(entries: Vec<ManifestEntry>) -> Manifest {
        Manifest::from_entries(entries).expect("valid test manifest")
    }

    fn canonical(entries: Vec<ManifestEntry>) -> Vec<u8> {
        manifest(entries)
            .canonical_bytes()
            .expect("canonical bytes")
    }

    fn raw_bytes(
        entries: Vec<(String, String, u64, String)>,
        merkle_root: String,
        total_bytes: u64,
    ) -> Vec<u8> {
        serde_json::to_vec(&RawManifest {
            v: MANIFEST_VERSION,
            entries,
            merkle_root,
            total_bytes,
        })
        .expect("raw json")
    }

    #[test]
    fn canonical_bytes_are_stable_across_input_order() {
        let left = canonical(vec![entry("b.txt", 2, 2), entry("a.txt", 1, 1)]);
        let right = canonical(vec![entry("a.txt", 1, 1), entry("b.txt", 2, 2)]);
        assert_eq!(left, right);

        let left_manifest = manifest(vec![entry("b.txt", 2, 2), entry("a.txt", 1, 1)]);
        let right_manifest = manifest(vec![entry("a.txt", 1, 1), entry("b.txt", 2, 2)]);
        assert_eq!(
            left_manifest.manifest_id().expect("id"),
            right_manifest.manifest_id().expect("id")
        );
        assert_eq!(left_manifest.entries[0].path, "a.txt");
    }

    #[test]
    fn canonical_json_shape_is_frozen() {
        let bytes = canonical(vec![entry("src/main.rs", 1234, 0xab)]);
        let text = String::from_utf8(bytes).expect("utf8");
        assert!(text.starts_with("{\"v\":1,\"entries\":[[\"src/main.rs\",\"100644\",1234,\""));
        assert!(text.contains("\"merkle_root\":\""));
        assert!(text.contains("\"total_bytes\":1234}"));
        assert!(!text.contains('\n'));
        assert!(!text.contains(' '));
    }

    #[test]
    fn parse_accepts_own_canonical_bytes() {
        let original = manifest(vec![entry("a.txt", 1, 1), entry("b.txt", 2, 2)]);
        let bytes = original.canonical_bytes().expect("canonical");
        let parsed = Manifest::parse(&bytes).expect("parse");
        assert_eq!(parsed, original);
        assert_eq!(
            parsed.manifest_id().expect("id"),
            original.manifest_id().expect("id")
        );
    }

    #[test]
    fn parse_rejects_unsorted_entries() {
        let sorted = manifest(vec![entry("a.txt", 1, 1), entry("b.txt", 2, 2)]);
        let raw = raw_bytes(
            vec![
                ("b.txt".into(), "100644".into(), 2, hash(2)),
                ("a.txt".into(), "100644".into(), 1, hash(1)),
            ],
            sorted.merkle_root.clone(),
            sorted.total_bytes,
        );
        assert!(matches!(
            Manifest::parse(&raw),
            Err(ManifestError::UnsortedEntries)
        ));
    }

    #[test]
    fn parse_rejects_duplicate_entries() {
        let raw = raw_bytes(
            vec![
                ("a.txt".into(), "100644".into(), 1, hash(1)),
                ("a.txt".into(), "100644".into(), 1, hash(1)),
            ],
            empty_merkle_root(),
            2,
        );
        assert!(matches!(
            Manifest::parse(&raw),
            Err(ManifestError::DuplicatePath { .. })
        ));
    }

    #[test]
    fn parse_rejects_bad_paths() {
        for path in [
            "../escape.txt",
            "a\\b.txt",
            "/absolute.txt",
            "a//b.txt",
            "a/./b.txt",
        ] {
            let raw = raw_bytes(
                vec![(path.into(), "100644".into(), 1, hash(1))],
                empty_merkle_root(),
                1,
            );
            assert!(
                matches!(
                    Manifest::parse(&raw),
                    Err(ManifestError::InvalidPath { .. })
                ),
                "path {path:?} must be rejected"
            );
        }
    }

    #[test]
    fn parse_rejects_bad_mode_and_hash() {
        let raw = raw_bytes(
            vec![("a.txt".into(), "100600".into(), 1, hash(1))],
            empty_merkle_root(),
            1,
        );
        assert!(matches!(
            Manifest::parse(&raw),
            Err(ManifestError::InvalidMode { .. })
        ));

        let raw = raw_bytes(
            vec![("a.txt".into(), "100644".into(), 1, "not-a-hash".into())],
            empty_merkle_root(),
            1,
        );
        assert!(matches!(
            Manifest::parse(&raw),
            Err(ManifestError::InvalidBlobHash { .. })
        ));
    }

    #[test]
    fn parse_rejects_total_and_merkle_mismatch() {
        let source = manifest(vec![entry("a.txt", 1, 1)]);
        let entries = vec![("a.txt".into(), "100644".into(), 1, hash(1))];

        let raw = raw_bytes(entries.clone(), source.merkle_root.clone(), 2);
        assert!(matches!(
            Manifest::parse(&raw),
            Err(ManifestError::TotalBytesMismatch {
                declared: 2,
                actual: 1
            })
        ));

        let raw = raw_bytes(entries, empty_merkle_root(), 1);
        assert!(matches!(
            Manifest::parse(&raw),
            Err(ManifestError::MerkleMismatch { .. })
        ));
    }

    #[test]
    fn parse_rejects_non_canonical_and_bad_json() {
        let bytes = canonical(vec![entry("a.txt", 1, 1)]);
        let mut with_space = bytes.clone();
        with_space.insert(1, b' ');
        assert!(matches!(
            Manifest::parse(&with_space),
            Err(ManifestError::NonCanonical)
        ));

        assert!(matches!(
            Manifest::parse(b"not json"),
            Err(ManifestError::Json { .. })
        ));
    }

    #[test]
    fn parse_verified_rejects_wrong_id() {
        let bytes = canonical(vec![entry("a.txt", 1, 1)]);
        let error =
            Manifest::parse_verified(&bytes, &empty_merkle_root()).expect_err("wrong id must fail");
        assert!(matches!(error, ManifestError::ManifestIdMismatch { .. }));
    }

    #[test]
    fn empty_manifest_root_is_64_zeros() {
        assert_eq!(merkle_root(&[]), empty_merkle_root());
        assert_eq!(empty_merkle_root().len(), 64);
        assert!(empty_merkle_root().bytes().all(|byte| byte == b'0'));
    }

    #[test]
    fn changing_one_file_changes_merkle_root_and_id() {
        let before = manifest(vec![entry("a.txt", 1, 1), entry("b.txt", 2, 2)]);
        let after = manifest(vec![entry("a.txt", 1, 1), entry("b.txt", 3, 2)]);
        assert_ne!(before.merkle_root, after.merkle_root);
        assert_ne!(
            before.manifest_id().expect("id"),
            after.manifest_id().expect("id")
        );
    }

    #[test]
    fn diff_reports_add_remove_and_modify() {
        let left = manifest(vec![
            entry("keep.txt", 1, 1),
            entry("modify.txt", 2, 2),
            entry("remove.txt", 3, 3),
        ]);
        let right = manifest(vec![
            entry("add.txt", 4, 4),
            entry("keep.txt", 1, 1),
            entry("modify.txt", 2, 9),
        ]);
        let diff = left.diff(&right);
        assert_eq!(diff.added, vec!["add.txt"]);
        assert_eq!(diff.removed, vec!["remove.txt"]);
        assert_eq!(diff.modified, vec!["modify.txt"]);
        assert!(!diff.is_empty());
    }

    #[test]
    fn diff_of_equal_manifests_is_empty() {
        let left = manifest(vec![entry("a.txt", 1, 1)]);
        let right = manifest(vec![entry("a.txt", 1, 1)]);
        assert!(left.diff(&right).is_empty());
        assert_eq!(left.merkle_root, right.merkle_root);
    }

    fn write_fixture_file(root: &Path, rel: &str, content: &[u8]) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().expect("fixture parent")).expect("fixture dir");
        fs::write(path, content).expect("fixture file");
    }

    fn manifest_from_files(root: &Path, names: &[&str]) -> Manifest {
        let entries = names
            .iter()
            .map(|name| {
                let bytes = fs::read(root.join(name)).expect("fixture file bytes");
                ManifestEntry::new(
                    *name,
                    FileMode::Regular,
                    bytes.len() as u64,
                    blob_hash(&bytes),
                )
                .expect("fixture entry")
            })
            .collect();
        Manifest::from_entries(entries).expect("fixture manifest")
    }

    fn sorted(mut paths: Vec<String>) -> Vec<String> {
        paths.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
        paths
    }

    fn git_name_status(root: &Path) -> Option<Vec<(String, String)>> {
        let output = Command::new("git")
            .current_dir(root)
            .args([
                "diff",
                "--no-index",
                "--no-renames",
                "--name-status",
                "--",
                "left",
                "right",
            ])
            .output()
            .ok()?;
        if !output.status.success() && output.status.code() != Some(1) {
            panic!(
                "git diff --no-index failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut statuses = Vec::new();
        for line in stdout.lines() {
            let mut parts = line.split('\t');
            let status = parts.next().expect("git status");
            let path = parts.next().expect("git path");
            let relative = path
                .strip_prefix("left/")
                .or_else(|| path.strip_prefix("right/"))
                .unwrap_or(path);
            statuses.push((status.to_owned(), relative.to_owned()));
        }
        Some(statuses)
    }

    #[test]
    fn merkle_fixture_vectors_match() {
        let fixture: MerkleFixture = serde_json::from_str(include_str!(
            "../../tests/fixtures/checkpoint-store/merkle-vectors.json"
        ))
        .expect("merkle fixture json");
        for vector in fixture.vectors {
            let entries = vector
                .entries
                .into_iter()
                .map(|raw| {
                    let mode = FileMode::parse(&raw.mode, &raw.path).expect("fixture vector mode");
                    ManifestEntry::new(raw.path, mode, raw.size, raw.blob_hash)
                        .expect("fixture vector entry")
                })
                .collect::<Vec<_>>();
            assert_eq!(
                merkle_root(&entries),
                vector.merkle_root,
                "vector {}",
                vector.name
            );
        }
    }

    #[test]
    fn diff_matches_git_no_index_fixture_without_renames() {
        let dir = tempfile::tempdir().expect("tempdir");
        let left = dir.path().join("left");
        let right = dir.path().join("right");
        write_fixture_file(&left, "keep.txt", b"keep");
        write_fixture_file(&left, "modify.txt", b"v1");
        write_fixture_file(&left, "remove.txt", b"gone");
        write_fixture_file(&left, "old.txt", b"rename-me");
        write_fixture_file(&right, "keep.txt", b"keep");
        write_fixture_file(&right, "modify.txt", b"v2");
        write_fixture_file(&right, "add.txt", b"new");
        write_fixture_file(&right, "new.txt", b"rename-me");

        let Some(statuses) = git_name_status(dir.path()) else {
            eprintln!("SKIP: git not available; cannot compare ManifestDiff with git");
            return;
        };

        let mut git_added = HashSet::new();
        let mut git_removed = HashSet::new();
        let mut git_modified = HashSet::new();
        for (status, path) in statuses {
            match status.as_str() {
                "A" => {
                    git_added.insert(path);
                }
                "D" => {
                    git_removed.insert(path);
                }
                "M" => {
                    git_modified.insert(path);
                }
                other => panic!("unexpected git status {other:?} for {path:?}"),
            }
        }

        let left_manifest =
            manifest_from_files(&left, &["keep.txt", "modify.txt", "remove.txt", "old.txt"]);
        let right_manifest =
            manifest_from_files(&right, &["keep.txt", "modify.txt", "add.txt", "new.txt"]);
        let diff = left_manifest.diff(&right_manifest);

        assert_eq!(
            sorted(diff.added.clone()),
            sorted(git_added.into_iter().collect())
        );
        assert_eq!(
            sorted(diff.removed.clone()),
            sorted(git_removed.into_iter().collect())
        );
        assert_eq!(
            sorted(diff.modified.clone()),
            sorted(git_modified.into_iter().collect())
        );
        // v1 deliberately has no rename detection: old.txt -> new.txt is D + A.
        assert!(diff.removed.contains(&"old.txt".to_owned()));
        assert!(diff.added.contains(&"new.txt".to_owned()));
    }

    #[test]
    fn symlink_entry_size_is_target_length_and_roundtrips() {
        let target = "dir/target.txt";
        let target_bytes = target.as_bytes();
        let entry = ManifestEntry::new(
            "link",
            FileMode::Symlink,
            target_bytes.len() as u64,
            blob_hash(target_bytes),
        )
        .expect("symlink entry");
        let manifest = Manifest::from_entries(vec![entry]).expect("manifest");
        let canonical = manifest.canonical_bytes().expect("canonical");
        let text = String::from_utf8(canonical.clone()).expect("utf8");
        assert!(text.contains("\"120000\""));
        let parsed = Manifest::parse(&canonical).expect("parse");
        assert_eq!(parsed.entries[0].mode, FileMode::Symlink);
        assert_eq!(parsed.entries[0].size, target_bytes.len() as u64);
        assert_eq!(parsed.entries[0].blob_hash, blob_hash(target_bytes));
        // Deliberately no OS symlink creation: Windows dev-mode/privilege-free.
    }
}
