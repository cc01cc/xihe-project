//! Host-side shadow-git checkpoint engine (PLAN-0338 slice model).
//!
//! Operating model (spec `slice-model.md`):
//!
//! - the shadow repository lives at `<hostRoot>/.xihe-shadow/<workspaceId>.git`,
//!   outside the workspace and never bind-mounted into the sandbox;
//! - `GIT_DIR` is the shadow and `core.worktree` points at `<hostRoot>/<workspaceId>`,
//!   so the user's own `.git` is never read or written;
//! - every git call runs with an isolated environment (`GIT_CONFIG_GLOBAL` /
//!   `GIT_CONFIG_SYSTEM` pointed at the OS null device, `--no-optional-locks`) and a
//!   short-lived `GIT_INDEX_FILE`, so no user config, hook or lock is involved;
//! - one slice per capture: `add -A` → `write-tree` → `commit-tree` (no parent) →
//!   `refs/xihe/slices/<capturedAtEpochMs>-<commitHash>`; a capture whose tree equals
//!   the chain tail writes no ref at all (`noChange`); the predecessor of a slice is
//!   the lexicographically newest pre-existing slice ref;
//! - captures serialize per workspace through a short capture lock
//!   ([`ShadowGit::lock_capture`]); restore execution uses a separate restore lock
//!   ([`ShadowGit::try_lock_restore`]), so concurrent workspace writes stay allowed.
//!
//! Restore execution lives in [`crate::checkpoint_revert`]; this module owns the
//! primitives it consumes (isolated env, scratch index/excludes, git plumbing).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use thiserror::Error;
use tokio::process::Command;
use tracing::{debug, info, warn};

use crate::checkpoint_store::audit::{self, AuditFinding, AuditReport, DualPendingRecord};
use crate::checkpoint_store::capture::{
    CaptureOptions, CaptureResult, GitTreeEntry, capture_from_git_entries,
    capture_root_with_options,
};
use crate::checkpoint_store::manifest::{FileMode, Manifest};
use crate::checkpoint_store::refs::{self, RefRecord};
use crate::checkpoint_store::store::{Store, StoreError};
use crate::checkpoint_store::walk::{WalkEntryKind, walk_workspace};
use crate::error::RuntimeError;
use crate::storage;

/// Directory under `hostRoot` that holds all shadow repositories.
pub const SHADOW_DIR_NAME: &str = ".xihe-shadow";

/// Minimum usable host git version (spec §6.0).
pub const MIN_GIT_VERSION: (u32, u32) = (2, 20);

/// Ref namespace of checkpoint slices: `refs/xihe/slices/<epochMs>-<hash>`.
pub const SLICE_REF_PREFIX: &str = "refs/xihe/slices/";

/// Default retention: keep the newest N slices per workspace (decision #10).
pub const DEFAULT_RETENTION_MAX_SLICES: usize = 50;

/// Default retention: delete slices older than this (decision #10).
pub const DEFAULT_RETENTION_TTL_DAYS: u64 = 30;

/// Default size cap for untracked files entering the snapshot (decision #14).
pub const DEFAULT_MAX_UNTRACKED_FILE_BYTES: u64 = 10 * 1024 * 1024;

/// P1 checkpoint storage selector (D53-05). `Git` is the default and performs
/// no store access; `Dual` writes the store after the authoritative git slice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CheckpointStorageMode {
    #[default]
    Git,
    Dual,
    Self_,
}

impl CheckpointStorageMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Git => "git",
            Self::Dual => "dual",
            Self::Self_ => "self",
        }
    }

    pub fn parse(value: &str) -> std::result::Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "git" => Ok(Self::Git),
            "dual" => Ok(Self::Dual),
            "self" => Ok(Self::Self_),
            other => Err(format!(
                "invalid checkpoint storage {other:?}; expected git|dual|self"
            )),
        }
    }
}

/// Capture context shared by the dual-write and consistency helpers.
struct DualWriteContext<'a> {
    workspace_id: &'a str,
    root_id: &'a str,
    run_id: &'a str,
    actor: &'a str,
    work_tree: &'a Path,
    git_tree: &'a str,
    previous_tree: Option<&'a str>,
    changed_paths: Option<&'a HashSet<String>>,
    git_ref: Option<&'a str>,
    env: &'a [(String, String)],
    git_ms: u64,
}

#[derive(Debug, Clone)]
struct CachedGitTree {
    tree: String,
    entries: Vec<GitTreeEntry>,
    nested_roots: Vec<String>,
}

fn parse_git_tree_output(output: &[u8]) -> (Vec<GitTreeEntry>, Vec<String>) {
    let mut entries = Vec::new();
    let mut nested_roots = Vec::new();
    for record in output.split(|byte| *byte == 0) {
        if record.is_empty() {
            continue;
        }
        let Some(tab) = record.iter().position(|byte| *byte == b'\t') else {
            continue;
        };
        let header = String::from_utf8_lossy(&record[..tab]);
        let path = String::from_utf8_lossy(&record[tab + 1..]).replace('\\', "/");
        let mut fields = header.split_whitespace();
        let mode = fields.next().unwrap_or_default();
        let kind = fields.next().unwrap_or_default();
        let oid = fields.next().unwrap_or_default().to_owned();
        let size = fields.next().unwrap_or_default();
        if kind == "commit" {
            nested_roots.push(path);
            continue;
        }
        if kind != "blob" {
            continue;
        }
        let mode = match mode {
            "100644" => FileMode::Regular,
            "100755" => FileMode::Executable,
            "120000" => FileMode::Symlink,
            _ => continue,
        };
        let Ok(size) = size.parse::<u64>() else {
            continue;
        };
        entries.push(GitTreeEntry {
            path,
            mode,
            size,
            oid,
        });
    }
    (entries, nested_roots)
}

/// Explicit exclusion patterns beyond the workspace `.gitignore` (decision #14).
///
/// Credential material must never enter the shadow object store; generated and
/// Runtime-infrastructure paths are excluded so checkpoints stay noise-free.
pub const STATIC_EXCLUDE_PATTERNS: &[&str] = &[
    "*.pem",
    "*.key",
    "*.p12",
    ".npmrc",
    ".netrc",
    "id_rsa*",
    "node_modules/",
    "dist/",
    "build/",
    ".cache/",
    ".tmp/",
    ".env",
    ".xihe-sentinel",
    ".xihe-probe-writable",
    ".xihe-container-runtime.log",
    ".xihe-container-runtime.pid",
    ".xihe-bridge-*.pid",
    ".xihe-shadow/",
    ".xihe-store/",
    ".xhs-restore-inprogress",
    ".xhs-restore-trash/",
];

const BOOTSTRAP_MARKER: &str = ".xihe-bootstrapped";

/// Persisted index with valid stat cache (PLAN-0358): seeded into the next
/// scratch index so `add -A` skips re-hashing unchanged files.
const LAST_INDEX_NAME: &str = "last-index";
const PROBE_RETRY_BACKOFF: Duration = Duration::from_secs(60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const GIT_CALL_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_RUN_ID_LEN: usize = 128;
const MAX_DYNAMIC_EXCLUDES: usize = 4096;
const LOCK_MAP_PRUNE_THRESHOLD: usize = 1024;

/// Nested-repository capture policy (PLAN-0361; default `Flatten`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NestedRepoPolicy {
    /// L1 file-level flatten (default, PLAN-0361): each nested repository's files
    /// are staged as ordinary blobs in the parent slice, so their contents are
    /// captured and restorable per file. Any `.git` entry (directory or `gitdir:`
    /// pointer) is skipped and never enters the shadow object store.
    Flatten,
    /// Legacy (PLAN-0338): record nested repositories as opaque gitlinks whose
    /// contents are neither captured nor restorable.
    Opaque,
    /// Opt-in hard limit: refuse the capture when any nested repository is
    /// present, with an explicit degraded reason (never silent).
    Reject,
}

impl NestedRepoPolicy {
    /// Wire/diagnostics token (`flatten` / `opaque` / `reject`).
    pub fn as_str(self) -> &'static str {
        match self {
            NestedRepoPolicy::Flatten => "flatten",
            NestedRepoPolicy::Opaque => "opaque",
            NestedRepoPolicy::Reject => "reject",
        }
    }
}

#[derive(Debug, Error)]
pub enum CheckpointError {
    #[error("host git is unavailable for checkpointing: {0}")]
    GitUnavailable(String),

    #[error("invalid {kind} {value:?}: {detail}")]
    InvalidIdentifier {
        kind: &'static str,
        value: String,
        detail: String,
    },

    #[error("workspace directory does not exist: {0}")]
    WorkspaceMissing(String),

    #[error("git command failed [{command}]: {detail}")]
    GitCommand { command: String, detail: String },

    #[error("checkpoint io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("nested repositories present and the hard limit is enabled: {paths:?}")]
    NestedRepoLimit { paths: Vec<String> },

    #[error("self-mode store capture failed: {detail}")]
    StoreCaptureFailed { detail: String },

    /// Fail-closed store/self adapter failure with an open-set reason token.
    /// Known values use `STORE_*`/`SELF_*`; unknown values are carried through
    /// unchanged (never normalized to `GIT_FAILED`).
    #[error("checkpoint store failure [{reason}]: {detail}")]
    StoreFailure { reason: String, detail: String },

    #[error("checkpoint cleanup rejected: a capture or restore owns workspace {0}")]
    CleanupBusy(String),
}

impl From<CheckpointError> for RuntimeError {
    fn from(error: CheckpointError) -> Self {
        match error {
            CheckpointError::Io(io) => RuntimeError::Io(io),
            other => RuntimeError::Command(other.to_string()),
        }
    }
}

pub type Result<T> = std::result::Result<T, CheckpointError>;

/// Structured host-git capability result (spec §6.0; never panics).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitCapability {
    pub available: bool,
    pub version: Option<String>,
    pub detail: String,
}

/// One entry of a checkpoint change set (`git diff --name-status`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChangedFile {
    /// Raw git status, e.g. `M`, `A`, `D`; the first character is the class.
    pub status: String,
    /// Workspace-relative path with forward slashes.
    pub path: String,
    /// Source path of a rename/copy; rename detection is disabled on the wire
    /// path, so this stays `None` for captures and is omitted from the JSON.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
}

/// One checkpoint slice ref: `refs/xihe/slices/<epochMs>-<hash>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SliceRef {
    /// Full ref name.
    pub name: String,
    /// Capture time in Unix milliseconds (parsed out of the leaf).
    pub epoch_ms: i64,
    /// Full commit hash of the slice.
    pub commit: String,
}

/// Result of one capture. Serialized verbatim as the frozen HTTP body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureOutcome {
    pub run_id: String,
    /// PLAN-0639 M7 (VM11): the root this slice was captured from. Equals
    /// `workspaceId` for the primary root (primary-root invariant), so a
    /// single-root body is unchanged; `#[serde(default)]` keeps old readers and
    /// pre-M7 fixtures deserializing.
    #[serde(default)]
    pub root_id: String,
    /// `true` when the captured tree equals the chain tail: no ref was written.
    pub no_change: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slice_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub captured_at: Option<String>,
    /// `captured` or `abnormal-captured`.
    pub state: String,
    pub changed_files: Vec<ChangedFile>,
    /// Sub-directories recorded as opaque gitlinks (mode 160000); their contents
    /// are not captured and cannot be restored.
    pub opaque_nested_repos: Vec<String>,
    /// Slice ref this capture was compared against / created on top of.
    pub predecessor: Option<String>,
}

/// Retention result (counts slices; abnormal slices participate equally).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionReport {
    /// Slice ref names deleted oldest-first.
    pub deleted_slices: Vec<String>,
    /// Slices kept by this sweep.
    pub kept: usize,
    pub gc_ran: bool,
}

/// Result of one explicit shadow-repository cleanup (frozen plan B).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupOutcome {
    /// `true` when a shadow repository existed and was removed.
    pub removed: bool,
}

/// One entry of the user repository's porcelain status (`GET .../git-status`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    /// Raw two-character porcelain code (`" M"`, `"??"`, `"R "`), unmodified.
    pub status: String,
    /// Workspace-relative path with forward slashes.
    pub path: String,
}

/// `GET .../git-status` body: the user repository's own pending changes.
///
/// This is the "待提交" side of the dual-diff separation (spec §6.4 / S4): the
/// shadow slice change set and the user repository status are two independent
/// projections and must never be mixed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitStatus {
    /// `false` when the workspace root has no user `.git` (non-Git workspaces work).
    pub is_repository: bool,
    pub entries: Vec<GitStatusEntry>,
}

/// PLAN-0340 L1b git half: stable facts only (branch + short HEAD), no dirty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitFacts {
    pub is_repository: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
}

struct GitOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

#[derive(Default)]
struct ProbeCache {
    capability: Option<GitCapability>,
    checked_at: Option<Instant>,
}

/// Guard for one short engine lock (capture or restore); keeps the diagnostics
/// counters accurate on every exit path, panics included.
pub struct LockGuard {
    _guard: tokio::sync::OwnedMutexGuard<()>,
    counter: Arc<AtomicUsize>,
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Short-lived scratch files (temp index / dynamic excludes) removed on drop.
pub(crate) struct ScratchFiles {
    paths: Vec<PathBuf>,
}

impl ScratchFiles {
    pub(crate) fn new(paths: Vec<PathBuf>) -> Self {
        Self { paths }
    }
}

impl Drop for ScratchFiles {
    fn drop(&mut self) {
        for path in &self.paths {
            if let Err(error) = std::fs::remove_file(path)
                && error.kind() != std::io::ErrorKind::NotFound
            {
                debug!(
                    path = %path.display(),
                    %error,
                    "failed to remove shadow checkpoint scratch file"
                );
            }
        }
    }
}

/// Shadow-git checkpoint engine for one host root.
///
/// All operations serialize per workspace through an in-process mutex map:
/// capture locks use the plain workspace key, restore locks a `#restore` suffix
/// so a restore never blocks workspace writes (and vice versa).
pub struct ShadowGit {
    host_root: PathBuf,
    git_binary: String,
    locks: StdMutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// PLAN-0470 (decision #17): per-workspace effective work-tree overrides.
    /// Handlers refresh these from the validated `ExecutionSpec`/materialized
    /// instance path before each operation, so direct-attach workspaces whose
    /// `hostPath` is not `<hostRoot>/<workspaceId>` capture/restore the real
    /// directory. Empty map falls back to the legacy `<hostRoot>/<workspaceId>`.
    work_tree_overrides: StdMutex<HashMap<String, PathBuf>>,
    /// PLAN-0639 M7 (VM13): ordered declared roots (`(root_id, host_path)`) per
    /// workspace, registered by the same seam that refreshes the work tree.
    /// Capture uses them to (a) route to the requested root and (b) keep a parent
    /// root's slice from flattening/overwriting a nested declared root, which is
    /// captured by its own shadow repo (D39-5b①).
    declared_roots: StdMutex<HashMap<String, Vec<(String, String)>>>,
    git_tree_cache: StdMutex<HashMap<String, CachedGitTree>>,
    active_capture_locks: Arc<AtomicUsize>,
    active_restore_locks: Arc<AtomicUsize>,
    probe_cache: StdMutex<ProbeCache>,
    max_untracked_file_bytes: u64,
    nested_repo_policy: NestedRepoPolicy,
    checkpoint_storage: CheckpointStorageMode,
    store: Option<Store>,
    store_failures: Arc<AtomicU64>,
    pub(crate) call_timeout: Duration,
}

impl ShadowGit {
    pub fn new(host_root: impl Into<PathBuf>) -> Self {
        let host_root = absolutize_host_root_lossy(host_root.into());
        Self {
            host_root,
            git_binary: "git".to_string(),
            locks: StdMutex::new(HashMap::new()),
            work_tree_overrides: StdMutex::new(HashMap::new()),
            declared_roots: StdMutex::new(HashMap::new()),
            git_tree_cache: StdMutex::new(HashMap::new()),
            active_capture_locks: Arc::new(AtomicUsize::new(0)),
            active_restore_locks: Arc::new(AtomicUsize::new(0)),
            probe_cache: StdMutex::new(ProbeCache::default()),
            max_untracked_file_bytes: DEFAULT_MAX_UNTRACKED_FILE_BYTES,
            nested_repo_policy: NestedRepoPolicy::Flatten,
            checkpoint_storage: CheckpointStorageMode::Git,
            store: None,
            store_failures: Arc::new(AtomicU64::new(0)),
            call_timeout: GIT_CALL_TIMEOUT,
        }
    }

    pub fn with_git_binary(mut self, git_binary: impl Into<String>) -> Self {
        self.git_binary = git_binary.into();
        self
    }

    pub fn with_max_untracked_file_bytes(mut self, max_bytes: u64) -> Self {
        self.max_untracked_file_bytes = max_bytes;
        self
    }

    pub fn with_nested_repo_policy(mut self, policy: NestedRepoPolicy) -> Self {
        self.nested_repo_policy = policy;
        self
    }

    pub fn nested_repo_policy(&self) -> NestedRepoPolicy {
        self.nested_repo_policy
    }

    pub fn checkpoint_storage(&self) -> CheckpointStorageMode {
        self.checkpoint_storage
    }

    pub fn store_failures(&self) -> u64 {
        self.store_failures.load(Ordering::SeqCst)
    }

    pub fn store_root(&self) -> Option<&Path> {
        self.store.as_ref().map(Store::root)
    }

    /// Configure P1 dual-write. `Git` never opens/creates a store; `Dual`/`Self_`
    /// initialize the store now so a bad path or VERSION fails at startup.
    pub fn configure_checkpoint_storage(
        &mut self,
        mode: CheckpointStorageMode,
        store_root: impl AsRef<Path>,
    ) -> std::result::Result<(), StoreError> {
        self.checkpoint_storage = mode;
        match mode {
            CheckpointStorageMode::Git => {
                self.store = None;
            }
            CheckpointStorageMode::Dual | CheckpointStorageMode::Self_ => {
                self.store = Some(Store::init(store_root)?);
            }
        }
        Ok(())
    }

    pub fn with_call_timeout(mut self, timeout: Duration) -> Self {
        self.call_timeout = timeout;
        self
    }

    pub fn host_root(&self) -> &Path {
        &self.host_root
    }

    /// `<hostRoot>/.xihe-shadow/<rootId>.git`.
    ///
    /// PLAN-0639 M1: the parameter is a **root id** (not a workspace id).  For the primary
    /// root the root id equals the workspace id, so the legacy single-root shadow path
    /// `<hostRoot>/.xihe-shadow/<workspaceId>.git` is byte-for-byte unchanged.  Additional
    /// roots get their own shadow repo under the same directory.
    pub fn shadow_git_dir(&self, root_id: &str) -> Result<PathBuf> {
        validate_workspace_id(root_id)?;
        Ok(self
            .host_root
            .join(SHADOW_DIR_NAME)
            .join(format!("{root_id}.git")))
    }

    /// Effective workspace work tree: the validated ExecutionSpec/materialized
    /// path registered by the handler (PLAN-0470 decision #17), falling back to
    /// the legacy `<hostRoot>/<workspaceId>` layout when no override is set.
    pub fn work_tree(&self, workspace_id: &str) -> Result<PathBuf> {
        validate_workspace_id(workspace_id)?;
        let overrides = self
            .work_tree_overrides
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(path) = overrides.get(workspace_id) {
            return Ok(path.clone());
        }
        Ok(self.host_root.join(workspace_id))
    }

    /// Registers the effective work tree for one workspace (callers refresh it
    /// from the registry before every checkpoint operation).
    pub fn set_work_tree_override(&self, workspace_id: &str, path: PathBuf) {
        if validate_workspace_id(workspace_id).is_err() {
            return;
        }
        self.work_tree_overrides
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(workspace_id.to_string(), path);
    }

    /// Drops a stale override (workspace destroyed or no longer materialized).
    pub fn clear_work_tree_override(&self, workspace_id: &str) {
        self.work_tree_overrides
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(workspace_id);
    }

    /// PLAN-0639 M1: the effective work tree for one **root** of a multi-root workspace.
    /// Falls back to the workspace-wide override, then to the legacy
    /// `<hostRoot>/<rootId>` layout.
    pub fn work_tree_for_root(&self, root_id: &str) -> Result<PathBuf> {
        validate_workspace_id(root_id)?;
        let overrides = self
            .work_tree_overrides
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(path) = overrides.get(root_id) {
            return Ok(path.clone());
        }
        Ok(self.host_root.join(root_id))
    }

    /// PLAN-0639 M1: registers the effective work tree for one root.
    pub fn set_work_tree_override_for_root(&self, root_id: &str, path: PathBuf) {
        if validate_workspace_id(root_id).is_err() {
            return;
        }
        self.work_tree_overrides
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(root_id.to_string(), path);
    }

    /// PLAN-0639 M7 (VM11/VM13): registers the ordered declared roots of one
    /// workspace `(root_id, host_path)` and points the per-root work-tree map at
    /// each of them. This is the single registration seam for per-root capture:
    /// before it, `work_tree_for_root` had no production caller and every capture
    /// silently used the workspace path.
    pub fn set_declared_roots(&self, workspace_id: &str, roots: Vec<(String, String)>) {
        if validate_workspace_id(workspace_id).is_err() {
            return;
        }
        {
            let mut map = self
                .declared_roots
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            map.insert(workspace_id.to_string(), roots.clone());
        }
        for (root_id, host_path) in roots {
            if host_path.trim().is_empty() {
                continue;
            }
            self.set_work_tree_override_for_root(&root_id, PathBuf::from(host_path));
        }
    }

    /// Drops the declared-root registration of a destroyed/unmaterialized workspace.
    ///
    /// The per-root work-tree overrides are intentionally left in place: they are
    /// keyed by root id (not workspace id) and a root may outlive one runtime
    /// process's view of the workspace; a stale path is only ever read by a
    /// capture for that same root id.
    pub fn clear_declared_roots(&self, workspace_id: &str) {
        self.declared_roots
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(workspace_id);
    }

    /// The declared roots registered for one workspace (empty = none registered).
    pub fn declared_roots(&self, workspace_id: &str) -> Vec<(String, String)> {
        self.declared_roots
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(workspace_id)
            .cloned()
            .unwrap_or_default()
    }

    /// PLAN-0639 M7 (VM13): declared roots that live **strictly inside**
    /// `work_tree`, as workspace-relative POSIX prefixes (`sub/root`).
    ///
    /// Lookup is across every registered workspace rather than one id: the
    /// exclusion has to be identical on the capture path (which knows the
    /// workspace) and on the restore path (which only knows the work tree), and
    /// two roots declaring the same host path is not a supported shape.
    pub(crate) fn nested_declared_root_prefixes(&self, work_tree: &Path) -> Vec<String> {
        let roots: Vec<(String, String)> = {
            let map = self
                .declared_roots
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            map.values().flat_map(|rows| rows.iter().cloned()).collect()
        };
        let base = normalize_path_for_git(work_tree).to_ascii_lowercase();
        let base = base.trim_end_matches('/').to_string();
        if base.is_empty() {
            return Vec::new();
        }
        let mut prefixes: Vec<String> = Vec::new();
        for (_, host_path) in roots {
            if host_path.trim().is_empty() {
                continue;
            }
            let candidate = normalize_path_for_git(Path::new(&host_path)).to_ascii_lowercase();
            if candidate == base {
                continue; // the captured root itself
            }
            let Some(rest) = candidate.strip_prefix(&base) else {
                continue;
            };
            let rest = rest.trim_start_matches('/').trim_end_matches('/');
            if rest.is_empty() || rest.starts_with("..") {
                continue;
            }
            if !prefixes.iter().any(|existing| existing == rest) {
                prefixes.push(rest.to_string());
            }
        }
        prefixes.sort();
        prefixes
    }

    /// PLAN-0639 M8: is `root_id` routable for this workspace?
    ///
    /// Accepts the primary root (`root_id == workspace_id`, the primary-root
    /// invariant) and any **registered declared root**. Restore/preview call this so
    /// a caller-supplied id cannot address an unregistered directory under the host
    /// root: without the check the resolver would join `<hostRoot>/<id>`
    /// unconditionally, which turns a bad `rootId` into a path probe.
    pub(crate) fn is_routable_root(&self, workspace_id: &str, root_id: &str) -> bool {
        if root_id == workspace_id {
            return true;
        }
        self.declared_roots(workspace_id)
            .iter()
            .any(|(id, _)| id == root_id)
    }

    /// Cached host-git probe (`git --version` ≥ 2.20). Failures are retried after a
    /// backoff; the result is a structured value and never panics, even when git is
    /// missing entirely.
    pub async fn probe(&self) -> GitCapability {
        {
            let cache = self
                .probe_cache
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if let Some(capability) = &cache.capability {
                if capability.available {
                    return capability.clone();
                }
                if cache
                    .checked_at
                    .is_some_and(|at| at.elapsed() < PROBE_RETRY_BACKOFF)
                {
                    return capability.clone();
                }
            }
        }
        let capability = self.run_probe().await;
        let mut cache = self
            .probe_cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        cache.capability = Some(capability.clone());
        cache.checked_at = Some(Instant::now());
        capability
    }

    /// Capture the workspace as one checkpoint slice.
    ///
    /// A single short-lived temp index (`GIT_INDEX_FILE`) stages the whole
    /// workspace with the usual exclusions (`add -A`), `write-tree` produces the
    /// tree hash, and — only when it differs from the chain tail — a root commit
    /// is written as `refs/xihe/slices/<epochMs>-<hash>`. A capture that detects
    /// no change writes no commit and no ref.
    ///
    /// PLAN-0639 M7 (VM11): this is the **primary-root** form; it delegates to
    /// [`Self::capture_for_root`] with `root_id = workspace_id`, which is
    /// byte-for-byte the pre-M7 behavior (primary-root invariant
    /// `root[0].id == workspaceId`).
    pub async fn capture(
        &self,
        workspace_id: &str,
        run_id: &str,
        actor: &str,
        call_id: &str,
        abnormal: bool,
    ) -> Result<CaptureOutcome> {
        self.capture_for_root(workspace_id, workspace_id, run_id, actor, call_id, abnormal)
            .await
    }

    /// PLAN-0639 M7 (VM11): capture **one declared root** of a workspace.
    ///
    /// `root_id` selects both the shadow repository
    /// (`<hostRoot>/.xihe-shadow/<rootId>.git`) and the work tree
    /// ([`Self::work_tree_for_root`]), so a declared non-primary root gets its own
    /// slice chain instead of silently re-capturing the primary root.
    ///
    /// VM13 (D39-5b①): declared roots nested **inside** the captured root are
    /// excluded from this root's slice, because each of them is captured by its own
    /// shadow repo. Without it the parent's `add -A` would flatten/overwrite the
    /// child's content, and the two chains would disagree about who owns those
    /// files.
    /// P1 shadow write: git is authoritative, store failure only increments
    /// `store_failures` and logs. `Opaque` dual mirrors git's gitlink by
    /// excluding nested contents from store entries while keeping metadata.
    async fn git_tree_snapshot(
        &self,
        env: &[(String, String)],
        tree: &str,
    ) -> Result<(Vec<GitTreeEntry>, Vec<String>)> {
        let output = self
            .run_git_checked(
                &["ls-tree", "-r", "-l", "-z", tree],
                env,
                None,
                self.call_timeout,
            )
            .await?;
        let (mut entries, mut nested_roots) = parse_git_tree_output(&output);
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        nested_roots.sort();
        Ok((entries, nested_roots))
    }

    async fn git_tree_paths(
        &self,
        env: &[(String, String)],
        tree: &str,
        paths: &HashSet<String>,
    ) -> Result<HashMap<String, GitTreeEntry>> {
        let mut out = HashMap::new();
        for path in paths {
            let output = self
                .run_git_checked(
                    &["ls-tree", "-r", "-l", "-z", tree, "--", path.as_str()],
                    env,
                    None,
                    self.call_timeout,
                )
                .await?;
            let (entries, _) = parse_git_tree_output(&output);
            if let Some(entry) = entries.into_iter().next() {
                out.insert(entry.path.clone(), entry);
            }
        }
        Ok(out)
    }

    async fn git_fed_entries(
        &self,
        context: &DualWriteContext<'_>,
    ) -> Result<(Vec<GitTreeEntry>, Vec<String>)> {
        let cached = self
            .git_tree_cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(context.root_id)
            .cloned();
        if let Some(cached) = &cached
            && cached.tree == context.git_tree
        {
            return Ok((cached.entries.clone(), cached.nested_roots.clone()));
        }
        let can_increment = context
            .changed_paths
            .is_some_and(|paths| paths.len() <= 256)
            && context.previous_tree.is_some();
        if can_increment
            && let (Some(changed), Some(previous_tree), Some(cached)) =
                (context.changed_paths, context.previous_tree, &cached)
            && cached.tree == previous_tree
            && !changed.iter().any(|path| {
                cached
                    .nested_roots
                    .iter()
                    .any(|nested| path == nested || path.starts_with(&format!("{nested}/")))
            })
        {
            let mut entries: HashMap<String, GitTreeEntry> = cached
                .entries
                .iter()
                .cloned()
                .map(|entry| (entry.path.clone(), entry))
                .collect();
            let refreshed = self
                .git_tree_paths(context.env, context.git_tree, changed)
                .await?;
            for path in changed {
                if let Some(entry) = refreshed.get(path) {
                    entries.insert(path.clone(), entry.clone());
                } else {
                    entries.remove(path);
                }
            }
            let mut entries: Vec<GitTreeEntry> = entries.into_values().collect();
            entries.sort_by(|left, right| left.path.cmp(&right.path));
            let nested_roots = cached.nested_roots.clone();
            self.git_tree_cache
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(
                    context.root_id.to_owned(),
                    CachedGitTree {
                        tree: context.git_tree.to_owned(),
                        entries: entries.clone(),
                        nested_roots: nested_roots.clone(),
                    },
                );
            return Ok((entries, nested_roots));
        }
        let (entries, nested_roots) = self
            .git_tree_snapshot(context.env, context.git_tree)
            .await?;
        self.git_tree_cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(
                context.root_id.to_owned(),
                CachedGitTree {
                    tree: context.git_tree.to_owned(),
                    entries: entries.clone(),
                    nested_roots: nested_roots.clone(),
                },
            );
        Ok((entries, nested_roots))
    }

    async fn git_changed_paths(
        &self,
        env: &[(String, String)],
        previous_tree: Option<&str>,
        tree: &str,
        entries: &[GitTreeEntry],
    ) -> Result<HashSet<String>> {
        let Some(previous_tree) = previous_tree else {
            return Ok(entries.iter().map(|entry| entry.path.clone()).collect());
        };
        if previous_tree == tree {
            return Ok(HashSet::new());
        }
        let output = self
            .run_git_checked(
                &[
                    "diff-tree",
                    "--no-commit-id",
                    "--name-only",
                    "-r",
                    "-z",
                    previous_tree,
                    tree,
                ],
                env,
                None,
                self.call_timeout,
            )
            .await?;
        Ok(output
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .map(|path| String::from_utf8_lossy(path).replace('\\', "/"))
            .collect())
    }

    async fn read_git_blob(
        &self,
        env: &[(String, String)],
        tree: &str,
        path: &str,
    ) -> Result<Vec<u8>> {
        let spec = format!("{tree}:{path}");
        self.run_git_checked(
            &["cat-file", "blob", spec.as_str()],
            env,
            None,
            self.call_timeout,
        )
        .await
    }

    async fn git_fed_capture(&self, context: &DualWriteContext<'_>) -> Result<CaptureResult> {
        let (entries, nested_roots) = self.git_fed_entries(context).await?;
        let changed = match context.changed_paths {
            Some(paths) => paths.clone(),
            None => {
                self.git_changed_paths(
                    context.env,
                    context.previous_tree,
                    context.git_tree,
                    &entries,
                )
                .await?
            }
        };
        let mut changed_blobs = HashMap::new();
        for entry in &entries {
            if changed.contains(&entry.path) {
                changed_blobs.insert(
                    entry.path.clone(),
                    self.read_git_blob(context.env, context.git_tree, &entry.path)
                        .await?,
                );
            }
        }
        let Some(store) = self.store.clone() else {
            return Err(CheckpointError::Io(std::io::Error::other(
                "store disappeared during git-fed capture",
            )));
        };
        let root_id = context.root_id.to_owned();
        let run_id = context.run_id.to_owned();
        let actor = context.actor.to_owned();
        tokio::task::spawn_blocking(move || {
            capture_from_git_entries(
                &store,
                &root_id,
                Some(&run_id),
                Some(&actor),
                &entries,
                &changed_blobs,
                nested_roots,
            )
        })
        .await
        .map_err(|error| {
            CheckpointError::Io(std::io::Error::other(format!(
                "git-fed store task failed: {error}"
            )))
        })?
        .map_err(|error| CheckpointError::Io(std::io::Error::other(error.to_string())))
    }

    async fn dual_write_store(
        &self,
        context: DualWriteContext<'_>,
    ) -> Result<Option<CaptureResult>> {
        let workspace_id = context.workspace_id;
        let root_id = context.root_id;
        let run_id = context.run_id;
        let actor = context.actor;
        let work_tree = context.work_tree;
        let git_ms = context.git_ms;
        let is_self = self.checkpoint_storage == CheckpointStorageMode::Self_;
        if !matches!(
            self.checkpoint_storage,
            CheckpointStorageMode::Dual | CheckpointStorageMode::Self_
        ) {
            return Ok(None);
        }
        let Some(store) = self.store.clone() else {
            self.store_failures.fetch_add(1, Ordering::SeqCst);
            warn!(
                workspace_id,
                root_id,
                run_id,
                store_error = "store_not_configured",
                "checkpoint dual-write skipped"
            );
            if is_self {
                return Err(CheckpointError::StoreCaptureFailed {
                    detail: "self mode requires a configured checkpoint store".into(),
                });
            }
            return Ok(None);
        };
        let store_for_check = store.clone();
        let use_git_fed = self.nested_repo_policy == NestedRepoPolicy::Opaque;
        let started = Instant::now();
        let outcome: Result<CaptureResult> = if use_git_fed {
            self.git_fed_capture(&context).await
        } else {
            let declared_roots = self
                .declared_roots(workspace_id)
                .into_iter()
                .map(|(root, _)| root)
                .collect();
            let options = CaptureOptions {
                declared_roots,
                exclude_opaque_nested: false,
            };
            let root_id_owned = root_id.to_owned();
            let run_id_owned = run_id.to_owned();
            let actor_owned = actor.to_owned();
            let work_tree = work_tree.to_path_buf();
            let store_for_walk = store.clone();
            tokio::task::spawn_blocking(move || {
                capture_root_with_options(
                    &store_for_walk,
                    &work_tree,
                    &root_id_owned,
                    Some(&run_id_owned),
                    Some(&actor_owned),
                    &options,
                )
            })
            .await
            .map_err(|error| {
                CheckpointError::Io(std::io::Error::other(format!(
                    "store capture task failed: {error}"
                )))
            })
            .and_then(|result| {
                result
                    .map_err(|error| CheckpointError::Io(std::io::Error::other(error.to_string())))
            })
        };
        let store_ms = started.elapsed().as_millis() as u64;
        match outcome {
            Ok(result) => {
                info!(
                    workspace_id,
                    root_id,
                    run_id,
                    git_ms,
                    store_ms,
                    store_slice = %result.slice_id,
                    store_entries = result.entry_count,
                    blobs_new = result.blobs_new,
                    blobs_dedup = result.blobs_dedup,
                    store_error = "none",
                    "checkpoint dual-write completed"
                );
                let record = DualPendingRecord {
                    v: 1,
                    root_id: root_id.to_owned(),
                    run_id: run_id.to_owned(),
                    git_ref: context.git_ref.map(str::to_owned),
                    git_tree: context.git_tree.to_owned(),
                    store_slice_id: result.slice_id.clone(),
                    store_manifest_id: result.manifest_id.clone(),
                    created_at_ms: SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|duration| duration.as_millis() as u64)
                        .unwrap_or(0),
                };
                if let Err(error) = audit::write_pending(&store_for_check, &record) {
                    self.store_failures.fetch_add(1, Ordering::SeqCst);
                    warn!(
                        workspace_id,
                        root_id,
                        run_id,
                        %error,
                        "checkpoint dual-write pending audit record failed"
                    );
                }
                if let Some(git_ref) = context.git_ref {
                    let ref_record = RefRecord {
                        v: 1,
                        root_id: root_id.to_owned(),
                        git_ref: git_ref.to_owned(),
                        git_tree: context.git_tree.to_owned(),
                        store_slice_id: result.slice_id.clone(),
                        store_manifest_id: result.manifest_id.clone(),
                        source: "capture".into(),
                        created_at_ms: record.created_at_ms,
                    };
                    if let Err(error) = refs::write_ref(&store_for_check, &ref_record) {
                        self.store_failures.fetch_add(1, Ordering::SeqCst);
                        warn!(
                            workspace_id,
                            root_id,
                            run_id,
                            %error,
                            "checkpoint ref sidecar write failed; store slice is unmapped"
                        );
                        if is_self {
                            return Err(CheckpointError::StoreCaptureFailed {
                                detail: format!(
                                    "store slice {} written but refs sidecar failed: {error}",
                                    result.slice_id
                                ),
                            });
                        }
                    }
                }
                Ok(Some(result))
            }
            Err(error) => {
                self.store_failures.fetch_add(1, Ordering::SeqCst);
                warn!(
                    workspace_id,
                    root_id,
                    run_id,
                    git_ms,
                    store_ms,
                    store_error = "capture_failed",
                    "checkpoint dual-write failed; git slice remains authoritative"
                );
                debug!(%error, "checkpoint dual-write error detail");
                if is_self {
                    return Err(CheckpointError::StoreCaptureFailed {
                        detail: error.to_string(),
                    });
                }
                Ok(None)
            }
        }
    }

    #[allow(dead_code)]
    async fn check_store_git_consistency(
        &self,
        context: &DualWriteContext<'_>,
        store: &Store,
        result: &CaptureResult,
    ) {
        let workspace_id = context.workspace_id;
        let root_id = context.root_id;
        let run_id = context.run_id;
        let git_tree = context.git_tree;
        let env = context.env;
        let manifest_path = store.manifest_path(&result.manifest_id);
        let store_manifest = match std::fs::read(&manifest_path)
            .ok()
            .map(|bytes| Manifest::parse(&bytes))
        {
            Some(Ok(manifest)) => manifest,
            _ => {
                warn!(
                    workspace_id,
                    root_id,
                    run_id,
                    kind = "path_set",
                    path = "<manifest>",
                    expected = "readable store manifest",
                    actual = "unreadable",
                    "store-git-mismatch"
                );
                return;
            }
        };
        let output = match self
            .run_git_checked(
                &["ls-tree", "-r", "-l", "-z", git_tree],
                env,
                None,
                self.call_timeout,
            )
            .await
        {
            Ok(output) => output,
            Err(error) => {
                debug!(%error, "store-git consistency check skipped: ls-tree failed");
                return;
            }
        };
        let mut git_entries: HashMap<String, (String, u64)> = HashMap::new();
        for record in output.split(|byte| *byte == 0) {
            if record.is_empty() {
                continue;
            }
            let Some(tab) = record.iter().position(|byte| *byte == b'\t') else {
                continue;
            };
            let header = String::from_utf8_lossy(&record[..tab]);
            let path = String::from_utf8_lossy(&record[tab + 1..]).replace('\\', "/");
            let mut fields = header.split_whitespace();
            let mode = fields.next().unwrap_or_default();
            let kind = fields.next().unwrap_or_default();
            let _oid = fields.next();
            let size = fields.next().unwrap_or("-");
            if kind != "blob" {
                continue;
            }
            if result.nested_roots.contains(&path) {
                continue;
            }
            let Ok(size) = size.parse::<u64>() else {
                continue;
            };
            git_entries.insert(path, (mode.to_owned(), size));
        }

        if git_entries.len() != store_manifest.entries.len() {
            let path = git_entries
                .keys()
                .find(|path| {
                    !store_manifest
                        .entries
                        .iter()
                        .any(|entry| entry.path == **path)
                })
                .cloned()
                .unwrap_or_else(|| "<set>".to_owned());
            warn!(
                workspace_id,
                root_id,
                run_id,
                kind = "count",
                path = %path,
                expected = git_entries.len(),
                actual = store_manifest.entries.len(),
                "store-git-mismatch"
            );
        }

        for entry in &store_manifest.entries {
            let expected_mode = match entry.mode {
                FileMode::Regular => "100644",
                FileMode::Executable => "100755",
                FileMode::Symlink => "120000",
            };
            match git_entries.get(&entry.path) {
                Some((mode, size)) => {
                    if mode != expected_mode {
                        warn!(
                            workspace_id,
                            root_id,
                            run_id,
                            kind = "path_set",
                            path = %entry.path,
                            expected = expected_mode,
                            actual = %mode,
                            "store-git-mismatch"
                        );
                    }
                    if *size != entry.size {
                        warn!(
                            workspace_id,
                            root_id,
                            run_id,
                            kind = "size",
                            path = %entry.path,
                            expected = *size,
                            actual = entry.size,
                            "store-git-mismatch"
                        );
                    }
                }
                None => warn!(
                    workspace_id,
                    root_id,
                    run_id,
                    kind = "path_set",
                    path = %entry.path,
                    expected = "present in git tree",
                    actual = "missing",
                    "store-git-mismatch"
                ),
            }
        }
        for path in git_entries.keys() {
            if !store_manifest
                .entries
                .iter()
                .any(|entry| entry.path == *path)
            {
                warn!(
                    workspace_id,
                    root_id,
                    run_id,
                    kind = "path_set",
                    path = %path,
                    expected = "present in store manifest",
                    actual = "missing",
                    "store-git-mismatch"
                );
            }
        }
    }

    /// Replay pending dual-write audit records. This is a harness entry, not a
    /// product CLI: capture never performs this synchronous comparison.
    pub async fn audit_dual_pending(
        &self,
        root_filter: Option<&str>,
        run_filter: Option<&str>,
    ) -> Result<AuditReport> {
        let Some(store) = self.store.clone() else {
            return Err(CheckpointError::Io(std::io::Error::other(
                "audit requires a configured checkpoint store",
            )));
        };
        let pending =
            audit::list_pending(&store, root_filter, run_filter).map_err(CheckpointError::Io)?;
        let mut report = AuditReport::default();
        for (_path, record) in pending {
            report.audited += 1;
            let shadow = self.shadow_git_dir(&record.root_id)?;
            let work_tree = self.work_tree_for_root(&record.root_id)?;
            let env = self.isolated_env(&shadow, &work_tree, None);
            let (git_entries, _) = self.git_tree_snapshot(&env, &record.git_tree).await?;
            let manifest_bytes = std::fs::read(store.manifest_path(&record.store_manifest_id))
                .map_err(CheckpointError::Io)?;
            let manifest = Manifest::parse(&manifest_bytes).map_err(|error| {
                CheckpointError::Io(std::io::Error::other(format!(
                    "audit manifest parse failed: {error}"
                )))
            })?;
            let mut expected = BTreeMap::new();
            for entry in git_entries {
                expected.insert(entry.path, (entry.mode.as_str(), entry.size));
            }
            let mut actual = BTreeMap::new();
            for entry in &manifest.entries {
                actual.insert(entry.path.clone(), (entry.mode.as_str(), entry.size));
            }
            let mut findings = Vec::new();
            if expected.len() != actual.len() {
                findings.push(AuditFinding {
                    kind: "count",
                    path: String::new(),
                    expected: expected.len().to_string(),
                    actual: actual.len().to_string(),
                });
            }
            for path in expected.keys().chain(actual.keys()) {
                match (expected.get(path), actual.get(path)) {
                    (Some(expected), Some(actual)) if expected != actual => {
                        findings.push(AuditFinding {
                            kind: "size",
                            path: path.clone(),
                            expected: format!("{}:{}", expected.0, expected.1),
                            actual: format!("{}:{}", actual.0, actual.1),
                        });
                    }
                    (None, Some(actual)) => findings.push(AuditFinding {
                        kind: "path_set",
                        path: path.clone(),
                        expected: "absent".to_string(),
                        actual: format!("{}:{}", actual.0, actual.1),
                    }),
                    (Some(expected), None) => findings.push(AuditFinding {
                        kind: "path_set",
                        path: path.clone(),
                        expected: format!("{}:{}", expected.0, expected.1),
                        actual: "absent".to_string(),
                    }),
                    _ => {}
                }
            }
            findings.sort_by(|left, right| {
                left.path
                    .cmp(&right.path)
                    .then_with(|| left.kind.cmp(right.kind))
            });
            findings.dedup();
            if findings.is_empty() {
                audit::move_to_done(&store, &record).map_err(CheckpointError::Io)?;
                report.passed += 1;
            } else {
                audit::write_failure(&store, &record, &findings).map_err(CheckpointError::Io)?;
                report.failed += 1;
                report.findings.extend(findings);
            }
        }
        Ok(report)
    }

    pub async fn capture_for_root(
        &self,
        workspace_id: &str,
        root_id: &str,
        run_id: &str,
        actor: &str,
        call_id: &str,
        abnormal: bool,
    ) -> Result<CaptureOutcome> {
        let capture_started = Instant::now();
        validate_run_id(run_id)?;
        validate_workspace_id(root_id)?;
        // PLAN-0639 M8: only the primary root and registered declared roots are
        // routable. Without this, a caller-supplied id would be joined under the host
        // root and could capture an unrelated directory.
        if !self.is_routable_root(workspace_id, root_id) {
            return Err(CheckpointError::InvalidIdentifier {
                kind: "rootId",
                value: root_id.to_string(),
                detail: format!("root id {root_id:?} is not a declared root of {workspace_id:?}"),
            });
        }
        let shadow = self.shadow_git_dir(root_id)?;
        let work_tree = self.work_tree_for_root(root_id)?;
        let _guard = self.lock_capture(root_id).await;
        self.require_git().await?;
        if !work_tree.is_dir() {
            return Err(CheckpointError::WorkspaceMissing(normalize_path_for_git(
                &work_tree,
            )));
        }
        self.ensure_initialized(&shadow, &work_tree).await?;

        let excluded_prefixes = self.nested_declared_root_prefixes(&work_tree);
        let index = scratch_index_path(&shadow, run_id);
        let excludes = scratch_excludes_path(&shadow, run_id);
        let _scratch = ScratchFiles::new(vec![index.clone(), excludes.clone()]);
        let env = self.isolated_env(&shadow, &work_tree, None);
        let state = if abnormal {
            "abnormal-captured"
        } else {
            "captured"
        };
        let tail = self.slice_tail(&env).await?;
        let (tail_tree, predecessor) = match &tail {
            Some(row) => (
                Some(self.tree_of(&env, &row.commit).await?),
                Some(row.name.clone()),
            ),
            None => (None, None),
        };
        // The temp index starts from the chain tail so the size cap and the
        // exclusion rules only judge genuinely new (untracked) paths: paths the
        // previous slice already indexed stay included even when they grew.
        let (tree, opaque_nested_repos) = self
            .stage_workspace(&shadow, &work_tree, &index, &excludes, tail_tree.as_deref())
            .await?;
        self.save_last_index(&shadow, &index).await?;

        if tail_tree.as_deref() == Some(tree.as_str()) {
            debug!(
                workspace_id,
                root_id,
                run_id,
                predecessor = predecessor.as_deref().unwrap_or("none"),
                excluded_roots = excluded_prefixes.len(),
                "shadow checkpoint capture found no change; no slice written"
            );
            let git_ms = capture_started.elapsed().as_millis() as u64;
            self.dual_write_store(DualWriteContext {
                workspace_id,
                root_id,
                run_id,
                actor,
                work_tree: &work_tree,
                git_tree: &tree,
                previous_tree: tail_tree.as_deref(),
                changed_paths: None,
                git_ref: predecessor.as_deref(),
                env: &env,
                git_ms,
            })
            .await?;
            return Ok(CaptureOutcome {
                run_id: run_id.to_string(),
                root_id: root_id.to_string(),
                no_change: true,
                slice_ref: None,
                commit: None,
                captured_at: None,
                state: state.to_string(),
                changed_files: Vec::new(),
                opaque_nested_repos: Vec::new(),
                predecessor,
            });
        }

        let epoch_ms = wall_clock_ms();
        let message = slice_message(run_id, actor, call_id);
        let commit = self.commit_tree(&env, &tree, None, &message).await?;
        let slice_ref = format!("{SLICE_REF_PREFIX}{epoch_ms}-{commit}");
        self.update_ref(&env, &slice_ref, &commit).await?;
        let changed_files = match &tail_tree {
            Some(tail_tree) => self.changed_files_for(&env, tail_tree, &tree).await?,
            None => Vec::new(),
        };
        info!(
            workspace_id,
            root_id,
            run_id,
            slice_ref = %slice_ref,
            changed = changed_files.len(),
            excluded_roots = excluded_prefixes.len(),
            state,
            "shadow checkpoint slice captured"
        );
        let git_ms = capture_started.elapsed().as_millis() as u64;
        let changed_paths: Option<HashSet<String>> = tail_tree
            .as_ref()
            .map(|_| changed_files.iter().map(|file| file.path.clone()).collect());
        self.dual_write_store(DualWriteContext {
            workspace_id,
            root_id,
            run_id,
            actor,
            work_tree: &work_tree,
            git_tree: &tree,
            previous_tree: tail_tree.as_deref(),
            changed_paths: changed_paths.as_ref(),
            git_ref: Some(slice_ref.as_str()),
            env: &env,
            git_ms,
        })
        .await?;
        Ok(CaptureOutcome {
            run_id: run_id.to_string(),
            root_id: root_id.to_string(),
            no_change: false,
            slice_ref: Some(slice_ref),
            commit: Some(commit),
            captured_at: Some(rfc3339_ms(epoch_ms)),
            state: state.to_string(),
            changed_files,
            opaque_nested_repos,
            predecessor,
        })
    }

    /// Resolve a slice ref to its commit; `None` when the ref does not exist.
    pub async fn slice_commit(
        &self,
        workspace_id: &str,
        slice_ref: &str,
    ) -> Result<Option<String>> {
        let shadow = self.shadow_git_dir(workspace_id)?;
        let work_tree = self.work_tree(workspace_id)?;
        if !shadow.is_dir() {
            return Ok(None);
        }
        self.require_git().await?;
        if parse_slice_ref(slice_ref).is_none() {
            return Ok(None);
        }
        let env = self.isolated_env(&shadow, &work_tree, None);
        self.rev_parse(&env, slice_ref).await
    }

    /// The lexicographically newest slice ref (chain tail), if any.
    pub(crate) async fn slice_tail(&self, env: &[(String, String)]) -> Result<Option<SliceRef>> {
        let rows = self.list_slices(env).await?;
        Ok(rows
            .into_iter()
            .max_by(|left, right| left.name.cmp(&right.name)))
    }

    async fn list_slices(&self, env: &[(String, String)]) -> Result<Vec<SliceRef>> {
        let stdout = self
            .run_git_checked(
                &["for-each-ref", "--format=%(refname)", SLICE_REF_PREFIX],
                env,
                None,
                self.call_timeout,
            )
            .await?;
        Ok(parse_slice_refs(&stdout))
    }

    pub(crate) async fn tree_of(&self, env: &[(String, String)], commit: &str) -> Result<String> {
        let expression = format!("{commit}^{{tree}}");
        self.rev_parse(env, &expression)
            .await?
            .ok_or_else(|| CheckpointError::GitCommand {
                command: "rev-parse".to_string(),
                detail: format!("slice commit {commit} has no resolvable tree"),
            })
    }

    /// Retention (decision #10, slice model): delete slices oldest-first beyond
    /// `max_slices` or older than `ttl_days`, then `reflog expire` + `gc --prune=now`.
    ///
    /// Slice age is parsed out of the ref leaf (`<epochMs>-<hash>`), so abnormal
    /// slices participate exactly like normal ones. Slices with identical
    /// timestamps are ordered by ref name so oldest-first deletion stays
    /// deterministic.
    pub async fn retention_gc(
        &self,
        workspace_id: &str,
        max_slices: usize,
        ttl_days: u64,
    ) -> Result<RetentionReport> {
        let shadow = self.shadow_git_dir(workspace_id)?;
        let work_tree = self.work_tree(workspace_id)?;
        let _guard = self.lock_workspace(workspace_id).await;
        self.require_git().await?;
        let mut report = RetentionReport::default();
        if !shadow.is_dir() {
            return Ok(report);
        }
        // A restore owns the workspace only for its execution; retention never
        // queues behind it (and never prunes the slice it is restoring from).
        let Some(_restore_guard) = self.try_lock_restore(workspace_id) else {
            debug!(
                workspace_id,
                "checkpoint retention skipped: a restore currently owns the workspace"
            );
            return Ok(report);
        };
        let env = self.isolated_env(&shadow, &work_tree, None);
        let mut slices = self.list_slices(&env).await?;
        slices.sort_by(|left, right| {
            left.epoch_ms
                .cmp(&right.epoch_ms)
                .then_with(|| left.name.cmp(&right.name))
        });

        let now = wall_clock_ms();
        let ttl_ms = i64::try_from(ttl_days.saturating_mul(86_400_000)).unwrap_or(i64::MAX);
        let expired_before = now.saturating_sub(ttl_ms);
        let excess = slices.len().saturating_sub(max_slices);
        for (index, row) in slices.iter().enumerate() {
            if index < excess || row.epoch_ms <= expired_before {
                report.deleted_slices.push(row.name.clone());
            } else {
                report.kept += 1;
            }
        }

        for name in &report.deleted_slices {
            self.run_git_checked(&["update-ref", "-d", name], &env, None, self.call_timeout)
                .await?;
        }
        if !report.deleted_slices.is_empty() {
            self.run_git_checked(
                &["reflog", "expire", "--expire=now", "--all"],
                &env,
                None,
                self.call_timeout,
            )
            .await?;
            self.run_git_checked(
                &["gc", "--prune=now", "--quiet"],
                &env,
                None,
                self.call_timeout,
            )
            .await?;
            report.gc_ran = true;
        }
        info!(
            workspace_id,
            deleted = report.deleted_slices.len(),
            kept = report.kept,
            "shadow checkpoint retention completed"
        );
        Ok(report)
    }

    /// Short capture lock: blocks concurrent captures of the same workspace for
    /// the duration of the scan + ref write, then releases.
    pub async fn lock_capture(&self, workspace_id: &str) -> LockGuard {
        let guard = self.workspace_lock(workspace_id).lock_owned().await;
        self.active_capture_locks.fetch_add(1, Ordering::SeqCst);
        LockGuard {
            _guard: guard,
            counter: self.active_capture_locks.clone(),
        }
    }

    /// Fail-fast restore lock: `None` means another restore currently owns the
    /// workspace (the caller reports `CHECKPOINT_RESTORE_LOCKED`; no queueing).
    pub fn try_lock_restore(&self, workspace_id: &str) -> Option<LockGuard> {
        let guard = self
            .workspace_lock(&restore_lock_key(workspace_id))
            .try_lock_owned()
            .ok()?;
        self.active_restore_locks.fetch_add(1, Ordering::SeqCst);
        Some(LockGuard {
            _guard: guard,
            counter: self.active_restore_locks.clone(),
        })
    }

    /// Fail-fast capture lock (used by cleanup): `None` means a capture
    /// currently owns the workspace.
    pub fn try_lock_capture(&self, workspace_id: &str) -> Option<LockGuard> {
        let guard = self.workspace_lock(workspace_id).try_lock_owned().ok()?;
        self.active_capture_locks.fetch_add(1, Ordering::SeqCst);
        Some(LockGuard {
            _guard: guard,
            counter: self.active_capture_locks.clone(),
        })
    }

    pub fn active_capture_locks(&self) -> usize {
        self.active_capture_locks.load(Ordering::SeqCst)
    }

    pub fn active_restore_locks(&self) -> usize {
        self.active_restore_locks.load(Ordering::SeqCst)
    }

    /// Explicit cleanup (frozen plan B): delete the whole shadow repository of
    /// one workspace. Serialized against capture and restore with fail-fast
    /// locks (a busy workspace is rejected, never queued). Idempotent: a missing
    /// shadow repo reports `removed=false`, and the next capture bootstraps a
    /// fresh repository through the normal path.
    pub async fn cleanup_workspace(&self, workspace_id: &str) -> Result<CleanupOutcome> {
        let shadow = self.shadow_git_dir(workspace_id)?;
        let Some(_capture_guard) = self.try_lock_capture(workspace_id) else {
            return Err(CheckpointError::CleanupBusy(workspace_id.to_string()));
        };
        let Some(_restore_guard) = self.try_lock_restore(workspace_id) else {
            return Err(CheckpointError::CleanupBusy(workspace_id.to_string()));
        };
        let removed = match tokio::fs::remove_dir_all(&shadow).await {
            Ok(()) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(CheckpointError::Io(error)),
        };
        info!(
            workspace_id,
            removed, "shadow checkpoint repository cleaned"
        );
        Ok(CleanupOutcome { removed })
    }

    /// Per-workspace serialization seam for engine operations that are not
    /// captures (retention sweep).
    pub(crate) async fn lock_workspace(
        &self,
        workspace_id: &str,
    ) -> tokio::sync::OwnedMutexGuard<()> {
        self.workspace_lock(workspace_id).lock_owned().await
    }

    fn workspace_lock(&self, workspace_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.locks.lock().unwrap_or_else(PoisonError::into_inner);
        if locks.len() > LOCK_MAP_PRUNE_THRESHOLD {
            locks.retain(|_, value| Arc::strong_count(value) > 1);
        }
        locks
            .entry(workspace_id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    async fn require_git(&self) -> Result<()> {
        let capability = self.probe().await;
        if capability.available {
            Ok(())
        } else {
            Err(CheckpointError::GitUnavailable(capability.detail))
        }
    }
    async fn run_probe(&self) -> GitCapability {
        let env = self.null_config_env();
        match self
            .run_git(&["--version"], &env, None, PROBE_TIMEOUT)
            .await
        {
            Ok(output) if output.status.success() => {
                let version_text = String::from_utf8_lossy(&output.stdout).trim().to_string();
                match parse_git_version(&version_text) {
                    Some(version) if version >= MIN_GIT_VERSION => GitCapability {
                        available: true,
                        version: Some(version_text),
                        detail: "host git is available".to_string(),
                    },
                    Some(version) => GitCapability {
                        available: false,
                        version: Some(version_text),
                        detail: format!(
                            "host git {}.{} is below the required {}.{}",
                            version.0, version.1, MIN_GIT_VERSION.0, MIN_GIT_VERSION.1
                        ),
                    },
                    None => GitCapability {
                        available: false,
                        version: Some(version_text.clone()),
                        detail: format!("could not parse `git --version` output {version_text:?}"),
                    },
                }
            }
            Ok(output) => GitCapability {
                available: false,
                version: None,
                detail: format!(
                    "`git --version` exited with {:?}: {}",
                    output.status.code(),
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
            },
            Err(error) => GitCapability {
                available: false,
                version: None,
                detail: error.to_string(),
            },
        }
    }

    async fn ensure_initialized(&self, shadow: &Path, work_tree: &Path) -> Result<()> {
        if shadow.join(BOOTSTRAP_MARKER).is_file() {
            return Ok(());
        }
        tokio::fs::create_dir_all(shadow.join("empty-hooks")).await?;
        let shadow_display = normalize_path_for_git(shadow);
        self.run_git_checked(
            &[
                "-c",
                "advice.defaultBranchName=false",
                "init",
                "--bare",
                &shadow_display,
            ],
            &self.null_config_env(),
            None,
            self.call_timeout,
        )
        .await?;

        let env = self.isolated_env(shadow, work_tree, None);
        let configs = [
            ("core.worktree", normalize_path_for_git(work_tree)),
            ("core.bare", "false".to_string()),
            ("core.autocrlf", "false".to_string()),
            ("core.filemode", "false".to_string()),
            ("core.symlinks", "true".to_string()),
            (
                "core.hooksPath",
                normalize_path_for_git(&shadow.join("empty-hooks")),
            ),
            ("gc.auto", "0".to_string()),
            ("commit.gpgsign", "false".to_string()),
            ("user.name", "xihe-checkpoint".to_string()),
            ("user.email", "checkpoint@xihe.local".to_string()),
            (
                "core.excludesFile",
                normalize_path_for_git(&shadow.join("exclude")),
            ),
            // PLAN-0358: persist untracked cache in the saved index so the next
            // capture can skip a full untracked rescan when the tree is quiet.
            ("core.untrackedCache", "true".to_string()),
        ];
        for (key, value) in configs {
            self.run_git_checked(&["config", key, &value], &env, None, self.call_timeout)
                .await?;
        }
        self.write_static_excludes(shadow).await?;
        tokio::fs::write(shadow.join(BOOTSTRAP_MARKER), b"bootstrapped\n").await?;
        info!(shadow = %shadow.display(), "shadow git repository bootstrapped");
        Ok(())
    }

    async fn write_static_excludes(&self, shadow: &Path) -> Result<()> {
        let mut content =
            String::from("# Xihe shadow checkpoint excludes (PLAN-0328 decision #14)\n");
        for pattern in STATIC_EXCLUDE_PATTERNS {
            content.push_str(pattern);
            content.push('\n');
        }
        tokio::fs::write(shadow.join("exclude"), content).await?;
        Ok(())
    }

    pub(crate) async fn write_excludes_file(&self, path: &Path, dynamic: &[String]) -> Result<()> {
        let mut content = String::from("# Xihe shadow checkpoint excludes (static + dynamic)\n");
        for pattern in STATIC_EXCLUDE_PATTERNS {
            content.push_str(pattern);
            content.push('\n');
        }
        for relative in dynamic {
            content.push_str(&gitignore_literal(relative));
            content.push('\n');
        }
        tokio::fs::write(path, content).await?;
        Ok(())
    }

    pub(crate) async fn collect_oversized_untracked(
        &self,
        shadow: &Path,
        work_tree: &Path,
        reference_index: Option<&Path>,
    ) -> Result<Vec<String>> {
        let env = self.isolated_env(shadow, work_tree, reference_index);
        let excludes = format!(
            "core.excludesFile={}",
            normalize_path_for_git(&shadow.join("exclude"))
        );
        let stdout = self
            .run_git_checked(
                &[
                    "-c",
                    excludes.as_str(),
                    "ls-files",
                    "--others",
                    "--exclude-standard",
                    "-z",
                ],
                &env,
                Some(work_tree),
                self.call_timeout,
            )
            .await?;
        let mut oversized = Vec::new();
        for raw in stdout.split(|byte| *byte == 0) {
            if raw.is_empty() {
                continue;
            }
            let relative = String::from_utf8_lossy(raw).into_owned();
            if relative.ends_with('/') {
                continue;
            }
            let absolute = work_tree.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
            let Ok(metadata) = std::fs::symlink_metadata(&absolute) else {
                continue;
            };
            if metadata.is_file() && metadata.len() > self.max_untracked_file_bytes {
                if oversized.len() >= MAX_DYNAMIC_EXCLUDES {
                    warn!(
                        work_tree = %work_tree.display(),
                        cap = MAX_DYNAMIC_EXCLUDES,
                        "oversized untracked file cap reached; remaining oversized files stay included"
                    );
                    break;
                }
                oversized.push(relative);
            }
        }
        Ok(oversized)
    }

    /// Stage the whole workspace into `index` with the static + dynamic excludes
    /// (`git add -A`); the caller owns the temp index lifetime.
    ///
    /// When `reference_tree` is given (the chain tail), the index is seeded from
    /// that tree first, so `git ls-files --others` — and therefore the dynamic
    /// size cap — only sees genuinely new paths.
    pub(crate) async fn stage_index(
        &self,
        shadow: &Path,
        work_tree: &Path,
        index: &Path,
        excludes: &Path,
        reference_tree: Option<&str>,
    ) -> Result<()> {
        let env = self.isolated_env(shadow, work_tree, Some(index));
        // Prefer the persisted last-index (valid stat + untracked cache) over a
        // bare `read-tree` (zeroed stats → full re-hash on `add -A`). PLAN-0358.
        let last_index = shadow.join(LAST_INDEX_NAME);
        if last_index.is_file() {
            tokio::fs::copy(&last_index, index).await?;
        } else if let Some(tree) = reference_tree {
            self.run_git_checked(&["read-tree", tree], &env, None, self.call_timeout)
                .await?;
        }
        let dynamic = self
            .collect_oversized_untracked(shadow, work_tree, Some(index))
            .await?;
        // PLAN-0639 M7 (VM13 / D39-5b①): a declared root nested inside this one is
        // captured by its own shadow repo, so it must not enter this root's tree.
        // The exclusion is expressed through the same `core.excludesFile` that
        // `add -A` already honours, which keeps one exclusion implementation.
        let mut excludes_entries = dynamic;
        excludes_entries.extend(self.nested_declared_root_prefixes(work_tree));
        self.write_excludes_file(excludes, &excludes_entries)
            .await?;
        let config = format!("core.excludesFile={}", normalize_path_for_git(excludes));
        self.run_git_checked(
            &["-c", &config, "add", "-A"],
            &env,
            Some(work_tree),
            self.call_timeout,
        )
        .await?;
        Ok(())
    }

    /// Persist the scratch index as the next capture's stat-cache seed.
    pub(crate) async fn save_last_index(&self, shadow: &Path, index: &Path) -> Result<()> {
        if !index.is_file() {
            return Ok(());
        }
        let last_index = shadow.join(LAST_INDEX_NAME);
        tokio::fs::copy(index, &last_index).await?;
        Ok(())
    }

    /// Stage the whole workspace into `index` and write its tree, applying the
    /// nested-repository policy (PLAN-0361): `Flatten` drops each nested repo's
    /// gitlink and stages its files as ordinary blobs (restorable per file),
    /// `Opaque` keeps the legacy gitlinks, `Reject` fails with
    /// [`CheckpointError::NestedRepoLimit`]. Returns the tree hash and the opaque
    /// nested-repo paths (always empty under `Flatten`).
    ///
    /// Both capture and restore planning go through this so the "current" tree
    /// they compare is built identically.
    pub(crate) async fn stage_workspace(
        &self,
        shadow: &Path,
        work_tree: &Path,
        index: &Path,
        excludes: &Path,
        reference_tree: Option<&str>,
    ) -> Result<(String, Vec<String>)> {
        self.stage_index(shadow, work_tree, index, excludes, reference_tree)
            .await?;
        let index_env = self.isolated_env(shadow, work_tree, Some(index));
        let detected = self.staged_gitlinks(&index_env).await?;
        let opaque = match self.nested_repo_policy {
            NestedRepoPolicy::Reject if !detected.is_empty() => {
                return Err(CheckpointError::NestedRepoLimit { paths: detected });
            }
            NestedRepoPolicy::Flatten => {
                let excluded = self.nested_declared_root_prefixes(work_tree);
                self.flatten_nested_repos(shadow, work_tree, index, excludes, &detected, &excluded)
                    .await?;
                Vec::new()
            }
            NestedRepoPolicy::Opaque | NestedRepoPolicy::Reject => detected,
        };
        let tree = self.write_tree(&index_env).await?;
        Ok((tree, opaque))
    }

    /// L1 (PLAN-0361): flatten each detected nested repository into the parent
    /// index as ordinary blobs so its contents are captured and restorable per
    /// file. The repo-root gitlink is dropped and every file below is staged by
    /// path with the same exclusion semantics as the workspace (static + dynamic
    /// excludes and the workspace `.gitignore`), while any `.git` entry is skipped
    /// and never enters the shadow object store. Returns the flattened repo roots.
    async fn flatten_nested_repos(
        &self,
        shadow: &Path,
        work_tree: &Path,
        index: &Path,
        excludes: &Path,
        nested_roots: &[String],
        excluded_prefixes: &[String],
    ) -> Result<Vec<String>> {
        if nested_roots.is_empty() {
            return Ok(Vec::new());
        }
        let env = self.isolated_env(shadow, work_tree, Some(index));
        let mut flattened = Vec::new();
        for root in nested_roots {
            // PLAN-0639 M7 (VM13): a nested repo that is itself a declared root is
            // captured by its own shadow repo; flattening it here would make the
            // parent chain own the child's files (and fight the child's chain).
            if excluded_prefixes
                .iter()
                .any(|prefix| root == prefix || root.starts_with(&format!("{prefix}/")))
            {
                continue;
            }
            let absolute_root = work_tree.join(root.replace('/', std::path::MAIN_SEPARATOR_STR));
            // Drop the opaque gitlink for the repo root before staging its files.
            self.run_git_checked(
                &["update-index", "--force-remove", "--", root],
                &env,
                None,
                self.call_timeout,
            )
            .await?;

            let mut relative_files = Vec::new();
            let outcome = walk_workspace(&absolute_root).map_err(|error| {
                std::io::Error::other(format!("nested repository walk failed: {error}"))
            })?;
            for issue in &outcome.issues {
                warn!(
                    root = %root,
                    path = ?issue.path,
                    kind = ?issue.kind,
                    message = %issue.message,
                    "nested walker reported an issue"
                );
            }
            relative_files.extend(outcome.entries.iter().map(|entry| entry.path.clone()));
            if relative_files.is_empty() {
                continue;
            }
            let repo_relative: Vec<String> = relative_files
                .iter()
                .map(|relative| format!("{root}/{relative}"))
                .collect();
            let ignored = self
                .ignored_paths(&env, excludes, work_tree, &repo_relative)
                .await?;

            for entry in &outcome.entries {
                let repo_path = format!("{root}/{}", entry.path);
                if ignored.contains(&repo_path) {
                    continue;
                }
                match entry.kind {
                    WalkEntryKind::Symlink => {
                        let Some(target) = entry.symlink_target.as_deref() else {
                            warn!(path = %repo_path, "nested symlink has no target; skipped");
                            continue;
                        };
                        let oid = self.hash_object_stdin(&env, target.as_bytes()).await?;
                        self.update_index_cacheinfo(&env, "120000", &oid, &repo_path)
                            .await?;
                    }
                    WalkEntryKind::File => {
                        if entry.size > self.max_untracked_file_bytes {
                            warn!(
                                path = %repo_path,
                                bytes = entry.size,
                                cap = self.max_untracked_file_bytes,
                                "oversized nested-repo file skipped by the size cap"
                            );
                            continue;
                        }
                        let mode = match entry.mode {
                            FileMode::Executable => "100755",
                            FileMode::Regular | FileMode::Symlink => "100644",
                        };
                        let oid = self.hash_object_file(&env, &entry.absolute_path).await?;
                        self.update_index_cacheinfo(&env, mode, &oid, &repo_path)
                            .await?;
                    }
                }
            }
            flattened.push(root.clone());
        }
        Ok(flattened)
    }

    /// Paths (workspace-relative) the current excludes mark as ignored, via a
    /// single batched `git check-ignore` against the same excludesFile used by
    /// `add -A` (static + dynamic) plus any in-tree `.gitignore`.
    async fn ignored_paths(
        &self,
        env: &[(String, String)],
        excludes: &Path,
        work_tree: &Path,
        paths: &[String],
    ) -> Result<std::collections::HashSet<String>> {
        let mut payload = Vec::new();
        for path in paths {
            payload.extend_from_slice(path.as_bytes());
            payload.push(0);
        }
        let config = format!("core.excludesFile={}", normalize_path_for_git(excludes));
        let output = self
            .run_git_with_stdin(
                &["-c", &config, "check-ignore", "--no-index", "-z", "--stdin"],
                env,
                Some(work_tree),
                &payload,
                self.call_timeout,
            )
            .await?;
        // Exit code 1 means "nothing ignored" (not an error); 0 means matches.
        if !output.status.success() && output.status.code() != Some(1) {
            return Err(CheckpointError::GitCommand {
                command: "check-ignore".to_string(),
                detail: String::from_utf8_lossy(&output.stderr).trim().to_string(),
            });
        }
        let mut ignored = std::collections::HashSet::new();
        for raw in output.stdout.split(|byte| *byte == 0) {
            if raw.is_empty() {
                continue;
            }
            ignored.insert(String::from_utf8_lossy(raw).into_owned());
        }
        Ok(ignored)
    }

    async fn hash_object_file(&self, env: &[(String, String)], path: &Path) -> Result<String> {
        let normalized = normalize_path_for_git(path);
        let stdout = self
            .run_git_checked(
                &["hash-object", "-w", "--no-filters", &normalized],
                env,
                None,
                self.call_timeout,
            )
            .await?;
        Ok(String::from_utf8_lossy(&stdout).trim().to_string())
    }

    async fn hash_object_stdin(&self, env: &[(String, String)], content: &[u8]) -> Result<String> {
        let output = self
            .run_git_with_stdin(
                &["hash-object", "-w", "--no-filters", "-t", "blob", "--stdin"],
                env,
                None,
                content,
                self.call_timeout,
            )
            .await?;
        if !output.status.success() {
            return Err(CheckpointError::GitCommand {
                command: "hash-object".to_string(),
                detail: String::from_utf8_lossy(&output.stderr).trim().to_string(),
            });
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    async fn update_index_cacheinfo(
        &self,
        env: &[(String, String)],
        mode: &str,
        oid: &str,
        path: &str,
    ) -> Result<()> {
        self.run_git_checked(
            &["update-index", "--add", "--cacheinfo", mode, oid, path],
            env,
            None,
            self.call_timeout,
        )
        .await?;
        Ok(())
    }

    pub(crate) async fn write_tree(&self, env: &[(String, String)]) -> Result<String> {
        let stdout = self
            .run_git_checked(&["write-tree"], env, None, self.call_timeout)
            .await?;
        Ok(String::from_utf8_lossy(&stdout).trim().to_string())
    }

    async fn staged_gitlinks(&self, env: &[(String, String)]) -> Result<Vec<String>> {
        let stdout = self
            .run_git_checked(&["ls-files", "--stage", "-z"], env, None, self.call_timeout)
            .await?;
        Ok(parse_staged_gitlinks(&stdout))
    }

    pub(crate) async fn commit_tree(
        &self,
        env: &[(String, String)],
        tree: &str,
        parent: Option<&str>,
        message: &str,
    ) -> Result<String> {
        let mut args = vec!["commit-tree", tree];
        if let Some(parent) = parent {
            args.push("-p");
            args.push(parent);
        }
        args.push("-m");
        args.push(message);
        let stdout = self
            .run_git_checked(&args, env, None, self.call_timeout)
            .await?;
        Ok(String::from_utf8_lossy(&stdout).trim().to_string())
    }

    pub(crate) async fn update_ref(
        &self,
        env: &[(String, String)],
        name: &str,
        commit: &str,
    ) -> Result<()> {
        self.run_git_checked(&["update-ref", name, commit], env, None, self.call_timeout)
            .await?;
        Ok(())
    }

    pub(crate) async fn rev_parse(
        &self,
        env: &[(String, String)],
        reference: &str,
    ) -> Result<Option<String>> {
        let output = self
            .run_git(
                &["rev-parse", "--verify", "--quiet", reference],
                env,
                None,
                self.call_timeout,
            )
            .await?;
        if !output.status.success() {
            return Ok(None);
        }
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok((!value.is_empty()).then_some(value))
    }

    /// Change set between two trees (`--no-renames`, so statuses stay M/A/D).
    pub(crate) async fn changed_files_for(
        &self,
        env: &[(String, String)],
        from_tree: &str,
        to_tree: &str,
    ) -> Result<Vec<ChangedFile>> {
        let stdout = self
            .run_git_checked(
                &[
                    "diff",
                    "--name-status",
                    "--no-renames",
                    "-z",
                    from_tree,
                    to_tree,
                ],
                env,
                None,
                self.call_timeout,
            )
            .await?;
        parse_name_status_z(&stdout)
    }

    /// Read-only porcelain status of the user repository (dual-diff "待提交" side).
    ///
    /// Never mutates the user repository: global/system config is nulled,
    /// `--no-optional-locks` / `GIT_OPTIONAL_LOCKS=0` suppress index refreshes and
    /// `core.hooksPath` points at the shadow's empty hooks directory, so no user or
    /// global hook can execute. A workspace without `.git` reports
    /// `is_repository: false` without spawning git; a missing workspace directory is
    /// an explicit [`CheckpointError::WorkspaceMissing`] (no silent degradation).
    pub async fn workspace_git_status(&self, workspace_id: &str) -> Result<WorkspaceGitStatus> {
        let work_tree = self.work_tree(workspace_id)?;
        if !work_tree.is_dir() {
            return Err(CheckpointError::WorkspaceMissing(normalize_path_for_git(
                &work_tree,
            )));
        }
        let Some(git_dir) = resolve_user_git_dir(&work_tree).await else {
            return Ok(WorkspaceGitStatus {
                is_repository: false,
                entries: Vec::new(),
            });
        };
        self.require_git().await?;
        let mut env = self.null_config_env();
        env.push(("GIT_DIR".to_string(), normalize_path_for_git(&git_dir)));
        env.push((
            "GIT_WORK_TREE".to_string(),
            normalize_path_for_git(&work_tree),
        ));
        env.push(("GIT_OPTIONAL_LOCKS".to_string(), "0".to_string()));
        env.push(("GIT_TERMINAL_PROMPT".to_string(), "0".to_string()));
        let hooks = self.shadow_git_dir(workspace_id)?.join("empty-hooks");
        let hooks_config = format!("core.hooksPath={}", normalize_path_for_git(&hooks));
        let stdout = self
            .run_git_checked(
                &[
                    "-c",
                    &hooks_config,
                    "status",
                    "--porcelain=v1",
                    "-z",
                    "--untracked-files=all",
                ],
                &env,
                None,
                self.call_timeout,
            )
            .await?;
        Ok(WorkspaceGitStatus {
            is_repository: true,
            entries: parse_porcelain_status_z(&stdout),
        })
    }

    /// PLAN-0340 T1.2: `branch` + short `HEAD` for L1b (no dirty list).
    pub async fn workspace_git_facts(&self, workspace_id: &str) -> Result<WorkspaceGitFacts> {
        let work_tree = self.work_tree(workspace_id)?;
        if !work_tree.is_dir() {
            return Err(CheckpointError::WorkspaceMissing(normalize_path_for_git(
                &work_tree,
            )));
        }
        let Some(git_dir) = resolve_user_git_dir(&work_tree).await else {
            return Ok(WorkspaceGitFacts {
                is_repository: false,
                branch: None,
                head: None,
            });
        };
        self.require_git().await?;
        let mut env = self.null_config_env();
        env.push(("GIT_DIR".to_string(), normalize_path_for_git(&git_dir)));
        env.push((
            "GIT_WORK_TREE".to_string(),
            normalize_path_for_git(&work_tree),
        ));
        env.push(("GIT_OPTIONAL_LOCKS".to_string(), "0".to_string()));
        env.push(("GIT_TERMINAL_PROMPT".to_string(), "0".to_string()));
        let hooks = self.shadow_git_dir(workspace_id)?.join("empty-hooks");
        let hooks_config = format!("core.hooksPath={}", normalize_path_for_git(&hooks));
        let branch_out = self
            .run_git_checked(
                &["-c", &hooks_config, "rev-parse", "--abbrev-ref", "HEAD"],
                &env,
                None,
                self.call_timeout,
            )
            .await?;
        let head_out = self
            .run_git_checked(
                &["-c", &hooks_config, "rev-parse", "--short", "HEAD"],
                &env,
                None,
                self.call_timeout,
            )
            .await?;
        let branch = String::from_utf8_lossy(&branch_out).trim().to_string();
        let head = String::from_utf8_lossy(&head_out).trim().to_string();
        Ok(WorkspaceGitFacts {
            is_repository: true,
            branch: if branch.is_empty() || branch == "HEAD" {
                None
            } else {
                Some(branch)
            },
            head: if head.is_empty() { None } else { Some(head) },
        })
    }

    fn null_config_env(&self) -> Vec<(String, String)> {
        let mut env = platform_env();
        env.push(("GIT_CONFIG_GLOBAL".to_string(), null_device().to_string()));
        env.push(("GIT_CONFIG_SYSTEM".to_string(), null_device().to_string()));
        env
    }

    pub(crate) fn isolated_env(
        &self,
        shadow: &Path,
        work_tree: &Path,
        index: Option<&Path>,
    ) -> Vec<(String, String)> {
        let mut env = self.null_config_env();
        env.push(("GIT_DIR".to_string(), absolute_for_git(shadow)));
        env.push(("GIT_WORK_TREE".to_string(), absolute_for_git(work_tree)));
        env.push(("GIT_ATTR_NOSYSTEM".to_string(), "1".to_string()));
        env.push(("GIT_OPTIONAL_LOCKS".to_string(), "0".to_string()));
        env.push(("GIT_TERMINAL_PROMPT".to_string(), "0".to_string()));
        if let Some(index) = index {
            env.push(("GIT_INDEX_FILE".to_string(), absolute_for_git(index)));
        }
        env
    }

    async fn run_git(
        &self,
        args: &[&str],
        envs: &[(String, String)],
        cwd: Option<&Path>,
        timeout: Duration,
    ) -> Result<GitOutput> {
        let mut command = Command::new(&self.git_binary);
        command.arg("--no-optional-locks");
        command.args(args);
        command.env_clear();
        for (key, value) in envs {
            command.env(key, value);
        }
        if let Some(dir) = cwd {
            command.current_dir(dir);
        }
        command.stdin(Stdio::null());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        command.kill_on_drop(true);
        let child = command.spawn().map_err(|error| {
            CheckpointError::GitUnavailable(format!(
                "failed to spawn git ({}): {error}",
                self.git_binary
            ))
        })?;
        let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
            Ok(result) => result?,
            Err(_) => {
                return Err(CheckpointError::GitCommand {
                    command: args.join(" "),
                    detail: format!("timed out after {timeout:?}"),
                });
            }
        };
        Ok(GitOutput {
            status: output.status,
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }

    /// Run git with a byte payload piped to stdin (PLAN-0361 L1: `hash-object`
    /// for symlink targets and `check-ignore` for batched ignore checks). The
    /// payload is written on a separate task so a full stdout pipe cannot
    /// deadlock the writer.
    async fn run_git_with_stdin(
        &self,
        args: &[&str],
        envs: &[(String, String)],
        cwd: Option<&Path>,
        stdin_bytes: &[u8],
        timeout: Duration,
    ) -> Result<GitOutput> {
        use tokio::io::AsyncWriteExt;

        let mut command = Command::new(&self.git_binary);
        command.arg("--no-optional-locks");
        command.args(args);
        command.env_clear();
        for (key, value) in envs {
            command.env(key, value);
        }
        if let Some(dir) = cwd {
            command.current_dir(dir);
        }
        command.stdin(Stdio::piped());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        command.kill_on_drop(true);
        let mut child = command.spawn().map_err(|error| {
            CheckpointError::GitUnavailable(format!(
                "failed to spawn git ({}): {error}",
                self.git_binary
            ))
        })?;
        if let Some(mut stdin) = child.stdin.take() {
            let payload = stdin_bytes.to_vec();
            tokio::spawn(async move {
                let _ = stdin.write_all(&payload).await;
                let _ = stdin.shutdown().await;
            });
        }
        let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
            Ok(result) => result?,
            Err(_) => {
                return Err(CheckpointError::GitCommand {
                    command: args.join(" "),
                    detail: format!("timed out after {timeout:?}"),
                });
            }
        };
        Ok(GitOutput {
            status: output.status,
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }

    pub(crate) async fn run_git_checked(
        &self,
        args: &[&str],
        envs: &[(String, String)],
        cwd: Option<&Path>,
        timeout: Duration,
    ) -> Result<Vec<u8>> {
        let output = self.run_git(args, envs, cwd, timeout).await?;
        if !output.status.success() {
            return Err(CheckpointError::GitCommand {
                command: args.join(" "),
                detail: format!(
                    "exit code {:?}: {}",
                    output.status.code(),
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
            });
        }
        if !output.stderr.is_empty() {
            debug!(
                command = %args.join(" "),
                stderr = %String::from_utf8_lossy(&output.stderr).trim(),
                "git stderr"
            );
        }
        Ok(output.stdout)
    }
}

/// Validate a workspace id against the storage-ref contract (W2 API surface).
pub fn validate_workspace_id(workspace_id: &str) -> Result<()> {
    if storage::is_valid_storage_ref(workspace_id) {
        Ok(())
    } else {
        Err(CheckpointError::InvalidIdentifier {
            kind: "workspace id",
            value: workspace_id.to_string(),
            detail:
                "must match ^[A-Za-z0-9_-]{1,64}$ (same contract as WorkspaceStorage storageRef)"
                    .to_string(),
        })
    }
}

/// Validate a run id as a safe single ref/file component (W2 API surface).
///
/// The reserved C0 capture id `"c0"` (workspace materialization baseline) is a
/// plain 2-character id and passes this validation unchanged.
pub fn validate_run_id(run_id: &str) -> Result<()> {
    let safe = !run_id.is_empty()
        && run_id.len() <= MAX_RUN_ID_LEN
        && !run_id.contains("..")
        && !run_id.starts_with('.')
        && !run_id.ends_with('.')
        && !run_id.ends_with(".lock")
        && run_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if safe {
        Ok(())
    } else {
        Err(CheckpointError::InvalidIdentifier {
            kind: "run id",
            value: run_id.to_string(),
            detail: format!("must be a safe single ref component (1..={MAX_RUN_ID_LEN} chars)"),
        })
    }
}

fn parse_git_version(output: &str) -> Option<(u32, u32)> {
    let after = output.trim().strip_prefix("git version ")?;
    let numbers: Vec<&str> = after.split_whitespace().next()?.split('.').collect();
    let major = numbers.first()?.parse::<u32>().ok()?;
    let minor = numbers.get(1)?.parse::<u32>().ok()?;
    Some((major, minor))
}

/// Parse `refs/xihe/slices/<epochMs>-<sha1>`; only canonical leaves are accepted.
pub(crate) fn parse_slice_ref(name: &str) -> Option<SliceRef> {
    let leaf = name.strip_prefix(SLICE_REF_PREFIX)?;
    let (epoch, hash) = leaf.split_once('-')?;
    if hash.len() != 40
        || !hash
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, 'a'..='f'))
    {
        return None;
    }
    if epoch.is_empty() || !epoch.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let epoch_ms = epoch.parse::<i64>().ok()?;
    Some(SliceRef {
        name: name.to_string(),
        epoch_ms,
        commit: hash.to_string(),
    })
}

fn parse_slice_refs(stdout: &[u8]) -> Vec<SliceRef> {
    String::from_utf8_lossy(stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let parsed = parse_slice_ref(line);
            if parsed.is_none() {
                debug!(refname = line, "unrecognized ref under the slice namespace");
            }
            parsed
        })
        .collect()
}

fn parse_name_status_z(bytes: &[u8]) -> Result<Vec<ChangedFile>> {
    let tokens: Vec<String> = bytes
        .split(|byte| *byte == 0)
        .filter(|token| !token.is_empty())
        .map(|token| String::from_utf8_lossy(token).into_owned())
        .collect();
    let mut changed = Vec::new();
    let mut cursor = 0;
    while cursor < tokens.len() {
        let status = tokens[cursor].clone();
        cursor += 1;
        let class = status.chars().next().unwrap_or('?');
        if class == 'R' || class == 'C' {
            let old_path = tokens.get(cursor).cloned();
            let path = tokens.get(cursor + 1).cloned();
            match (old_path, path) {
                (Some(old_path), Some(path)) => {
                    changed.push(ChangedFile {
                        status,
                        path,
                        old_path: Some(old_path),
                    });
                }
                _ => {
                    return Err(CheckpointError::GitCommand {
                        command: "git diff --name-status".to_string(),
                        detail: format!("truncated rename entry in {status:?}"),
                    });
                }
            }
            cursor += 2;
        } else {
            match tokens.get(cursor) {
                Some(path) => changed.push(ChangedFile {
                    status,
                    path: path.clone(),
                    old_path: None,
                }),
                None => {
                    return Err(CheckpointError::GitCommand {
                        command: "git diff --name-status".to_string(),
                        detail: format!("truncated entry in {status:?}"),
                    });
                }
            }
            cursor += 1;
        }
    }
    Ok(changed)
}

/// Parse `git ls-files --stage -z` output for mode 160000 (gitlink) entries.
///
/// Records look like `160000 <oid> 0\t<path>\0`; nested repository directories
/// are recorded as opaque gitlinks whose contents are neither captured nor
/// restorable (PLAN-0338 §1 / PLAN-0361).
fn parse_staged_gitlinks(bytes: &[u8]) -> Vec<String> {
    let mut paths = Vec::new();
    for field in bytes.split(|byte| *byte == 0) {
        if field.is_empty() {
            continue;
        }
        let Some(tab) = field.iter().position(|byte| *byte == b'\t') else {
            continue;
        };
        let header = String::from_utf8_lossy(&field[..tab]);
        let mut parts = header.split_whitespace();
        let mode = parts.next().unwrap_or_default();
        if mode == "160000" {
            paths.push(String::from_utf8_lossy(&field[tab + 1..]).into_owned());
        }
    }
    paths
}

/// Parse `git status --porcelain=v1 -z` output into wire entries.
///
/// Records are `XY <path>\0`; rename/copy records (`R`/`C` in either column) carry
/// the original path as the next NUL field, which is consumed but not reported
/// (the wire entry is `{status, path}` only). Malformed trailing fragments are
/// skipped rather than failing the whole status read.
fn parse_porcelain_status_z(bytes: &[u8]) -> Vec<GitStatusEntry> {
    let mut entries = Vec::new();
    let mut fields = bytes
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    while let Some(field) = fields.next() {
        if field.len() < 3 || field[2] != b' ' {
            continue;
        }
        let status = String::from_utf8_lossy(&field[..2]).into_owned();
        let path = String::from_utf8_lossy(&field[3..]).into_owned();
        let class = |index: usize| status.as_bytes().get(index).copied().map(char::from);
        if matches!(class(0), Some('R' | 'C')) || matches!(class(1), Some('R' | 'C')) {
            let _ = fields.next();
        }
        entries.push(GitStatusEntry { status, path });
    }
    entries
}

/// Commit message of one slice: provenance only, never file contents.
fn slice_message(run_id: &str, actor: &str, call_id: &str) -> String {
    format!(
        "slice\n\nrunId: {}\nactor: {}\ncallId: {}\n",
        sanitize_message_field(run_id),
        sanitize_message_field(actor),
        sanitize_message_field(call_id)
    )
}

pub(crate) fn sanitize_message_field(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    sanitized.chars().take(200).collect()
}

pub(crate) fn scratch_index_path(shadow: &Path, token: &str) -> PathBuf {
    shadow.join(format!("index.{token}.capture"))
}

pub(crate) fn scratch_excludes_path(shadow: &Path, token: &str) -> PathBuf {
    shadow.join(format!("exclude.{token}.capture"))
}

fn restore_lock_key(workspace_id: &str) -> String {
    // Workspace ids cannot contain `#` (storage-ref contract), so the key is
    // unambiguous and distinct from the capture lock key.
    format!("{workspace_id}#restore")
}

/// gitignore line that matches exactly one workspace-relative path.
pub(crate) fn gitignore_literal(relative: &str) -> String {
    let mut pattern = String::from("/");
    for c in relative.chars() {
        match c {
            '\\' | '*' | '?' | '[' | ']' | '!' | '#' => {
                pattern.push('\\');
                pattern.push(c);
            }
            _ => pattern.push(c),
        }
    }
    pattern
}

fn normalize_path_for_git(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let stripped = raw.strip_prefix(r"\\?\").unwrap_or(&raw);
    stripped.replace('\\', "/")
}

/// Absolute path for a git env value. `checkpoint.rs` runs git with
/// `cwd=Some(work_tree)` for some commands, so a relative `GIT_DIR` would be
/// interpreted against the work tree (BL-118). Keep the invariant local to the
/// engine so embedders/tests cannot violate it.
fn absolute_for_git(path: &Path) -> String {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        match std::path::absolute(path) {
            Ok(absolute) => absolute,
            Err(_) => path.to_path_buf(),
        }
    };
    normalize_path_for_git(&absolute)
}

fn absolutize_host_root_lossy(path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        return path;
    }
    match std::path::absolute(&path) {
        Ok(absolute) => {
            tracing::warn!(
                raw = %path.display(),
                resolved = %absolute.display(),
                "checkpoint host root is relative; resolved against the process working directory"
            );
            absolute
        }
        Err(_) => path,
    }
}

fn null_device() -> &'static str {
    #[cfg(windows)]
    {
        "NUL"
    }
    #[cfg(not(windows))]
    {
        "/dev/null"
    }
}

fn platform_env() -> Vec<(String, String)> {
    const KEYS: &[&str] = &[
        "PATH",
        "PATHEXT",
        "SystemRoot",
        "SystemDrive",
        "windir",
        "COMSPEC",
        "TEMP",
        "TMP",
        "HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "LANG",
    ];
    KEYS.iter()
        .filter_map(|key| {
            std::env::var(key)
                .ok()
                .map(|value| (key.to_string(), value))
        })
        .collect()
}

/// Resolve `<workTree>/.git` (directory or `gitdir:` pointer file) for read-only
/// HEAD introspection in `git-status`; `None` when the workspace is not a repo.
async fn resolve_user_git_dir(work_tree: &Path) -> Option<PathBuf> {
    let dot_git = work_tree.join(".git");
    let metadata = tokio::fs::symlink_metadata(&dot_git).await.ok()?;
    if metadata.is_dir() {
        return Some(dot_git);
    }
    if metadata.is_file() {
        let content = tokio::fs::read_to_string(&dot_git).await.ok()?;
        let target = content.lines().next()?.strip_prefix("gitdir:")?.trim();
        if target.is_empty() {
            return None;
        }
        let path = Path::new(target);
        return Some(if path.is_absolute() {
            path.to_path_buf()
        } else {
            work_tree.join(path)
        });
    }
    None
}

fn wall_clock_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn rfc3339_ms(epoch_ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(epoch_ms)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| format!("epoch-ms:{epoch_ms}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn require_git(engine: &ShadowGit) -> bool {
        let capability = engine.probe().await;
        assert!(
            capability.available,
            "checkpoint shadow-git tests require a real host git >= 2.20 (spec/test-migration §8): {capability:?}"
        );
        true
    }

    #[test]
    fn checkpoint_parse_git_version_accepts_platform_suffixes() {
        assert_eq!(
            parse_git_version("git version 2.55.0.windows.2"),
            Some((2, 55))
        );
        assert_eq!(parse_git_version("git version 2.20.1"), Some((2, 20)));
        assert_eq!(
            parse_git_version("git version 2.39.3 (Apple Git-145)"),
            Some((2, 39))
        );
        assert_eq!(parse_git_version("git version 3.0"), Some((3, 0)));
        assert_eq!(parse_git_version("not git"), None);
        assert_eq!(parse_git_version("git version"), None);
        assert_eq!(parse_git_version("git version abc.def"), None);
    }

    #[test]
    fn checkpoint_parse_name_status_z_covers_modify_add_delete_rename() {
        let bytes =
            b"M\0modified.txt\0A\0added.txt\0D\0deleted.txt\0R100\0old.txt\0new.txt\0".to_vec();
        let changed = parse_name_status_z(&bytes).expect("parse");
        assert_eq!(changed.len(), 4);
        assert_eq!(changed[0].status, "M");
        assert_eq!(changed[0].path, "modified.txt");
        assert_eq!(changed[0].old_path, None);
        assert_eq!(changed[1].status, "A");
        assert_eq!(changed[1].path, "added.txt");
        assert_eq!(changed[2].status, "D");
        assert_eq!(changed[2].path, "deleted.txt");
        assert_eq!(changed[3].status, "R100");
        assert_eq!(changed[3].old_path.as_deref(), Some("old.txt"));
        assert_eq!(changed[3].path, "new.txt");
        assert_eq!(parse_name_status_z(b"").expect("empty"), Vec::new());
    }

    #[test]
    fn checkpoint_parse_name_status_z_rejects_truncated_rename() {
        let error = parse_name_status_z(b"R100\0only-one.txt\0").expect_err("truncated");
        assert!(error.to_string().contains("truncated"));
    }

    #[test]
    fn checkpoint_parse_slice_ref_accepts_only_canonical_leaves() {
        let hash = "0123456789abcdef0123456789abcdef01234567";
        let name = format!("refs/xihe/slices/1700000000000-{hash}");
        let parsed = parse_slice_ref(&name).expect("canonical slice ref");
        assert_eq!(parsed.epoch_ms, 1_700_000_000_000);
        assert_eq!(parsed.commit, hash);
        assert_eq!(parsed.name, name);

        for rejected in [
            format!("refs/xihe/slices/{hash}-1700000000000"),
            format!("refs/xihe/slices/1700000000000-{}", hash.to_uppercase()),
            format!("refs/xihe/slices/1700000000000-{}", &hash[..39]),
            "refs/xihe/slices/1700000000000-".to_string(),
            "refs/xihe/slices/-0123456789abcdef0123456789abcdef01234567".to_string(),
            "refs/xihe/slices/not-a-slice".to_string(),
            "refs/xihe/run-1/base".to_string(),
            "refs/heads/main".to_string(),
        ] {
            assert!(
                parse_slice_ref(&rejected).is_none(),
                "{rejected:?} must not parse as a slice ref"
            );
        }
        // A short epoch is still a valid, if unusual, capture instant.
        let short = format!("refs/xihe/slices/1-{hash}");
        assert_eq!(parse_slice_ref(&short).expect("short epoch").epoch_ms, 1);
    }

    #[test]
    fn checkpoint_parse_slice_refs_skips_unknown_namespace_entries() {
        let hash = "0123456789abcdef0123456789abcdef01234567";
        let raw = format!(
            "refs/xihe/slices/1700000000001-{hash}\nrefs/xihe/slices/not-a-slice\nrefs/heads/main\nrefs/xihe/slices/1700000000002-{hash}\n"
        );
        let rows = parse_slice_refs(raw.as_bytes());
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].epoch_ms, 1_700_000_000_001);
        assert_eq!(rows[1].epoch_ms, 1_700_000_000_002);
    }

    #[test]
    fn checkpoint_parse_staged_gitlinks_extracts_only_mode_160000() {
        let raw = b"100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 0\tfile.txt\0\
160000 0123456789abcdef0123456789abcdef01234567 0\tsub/nested\0\
120000 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0\tlink\0";
        assert_eq!(parse_staged_gitlinks(raw), vec!["sub/nested".to_string()]);
        assert!(parse_staged_gitlinks(b"").is_empty());
    }

    #[test]
    fn checkpoint_gitignore_literal_is_anchored_and_escaped() {
        assert_eq!(gitignore_literal("dir/file.bin"), "/dir/file.bin");
        assert_eq!(gitignore_literal("a[1]*?.txt"), "/a\\[1\\]\\*\\?.txt");
    }

    #[test]
    fn checkpoint_rejects_invalid_identifiers() {
        assert!(validate_run_id("0192abcd-1234-7abc-9def-0123456789ab").is_ok());
        assert!(validate_run_id("run.2026-09-15_01").is_ok());
        // The reserved C0 capture id must pass unchanged.
        assert!(validate_run_id("c0").is_ok());
        let mut bad_run_ids = vec![
            String::new(),
            "../evil".to_string(),
            "..".to_string(),
            ".hidden".to_string(),
            "trailing.".to_string(),
            "branch.lock".to_string(),
            "a/b".to_string(),
            "a b".to_string(),
            "a~b".to_string(),
            "a^b".to_string(),
            "a:b".to_string(),
        ];
        bad_run_ids.push("x".repeat(MAX_RUN_ID_LEN + 1));
        for bad in bad_run_ids {
            assert!(
                validate_run_id(&bad).is_err(),
                "run id {bad:?} must be rejected"
            );
        }

        assert!(validate_workspace_id("ws1").is_ok());
        for bad in ["", ".xihe-shadow", "a/b", "a.b", "has space"] {
            assert!(
                validate_workspace_id(bad).is_err(),
                "workspace id {bad:?} must be rejected"
            );
        }
    }

    #[tokio::test]
    async fn checkpoint_probe_reports_unavailable_without_panic() {
        let temp = TempDir::new().expect("tempdir");
        let engine = ShadowGit::new(temp.path()).with_git_binary("xihe-runtime-missing-git-binary");
        let capability = engine.probe().await;
        assert!(!capability.available);
        assert!(capability.version.is_none());
        assert!(!capability.detail.is_empty());
        assert_eq!(engine.probe().await, capability);
    }

    #[test]
    fn checkpoint_isolated_env_absolutizes_git_paths() {
        let engine = ShadowGit::new(PathBuf::from(".xihe-workspaces"));
        let env = engine.isolated_env(
            Path::new(".xihe-workspaces/.xihe-shadow/ws1.git"),
            Path::new(".xihe-workspaces/ws1"),
            Some(Path::new(".xihe-workspaces/.xihe-shadow/ws1.git/index")),
        );
        for key in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] {
            let value = env
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value)
                .unwrap_or_else(|| panic!("{key} missing from isolated env"));
            assert!(
                Path::new(value).is_absolute(),
                "{key} must be absolute, got {value:?}"
            );
        }
    }

    #[tokio::test]
    async fn checkpoint_capture_works_with_relative_host_root() {
        let cwd = std::env::current_dir().expect("cwd");
        let temp = TempDir::new_in(&cwd).expect("tempdir in cwd");
        let relative_root = temp
            .path()
            .strip_prefix(&cwd)
            .expect("tempdir is under cwd")
            .to_path_buf();
        let workspace = temp.path().join("ws1");
        std::fs::create_dir_all(workspace.join("src")).expect("workspace");
        std::fs::write(workspace.join("src/main.txt"), "hello\n").expect("fixture file");

        let engine = ShadowGit::new(&relative_root);
        if !require_git(&engine).await {
            return;
        }
        let outcome = engine
            .capture("ws1", "run-relative-root", "tester", "call-relative", false)
            .await
            .expect("capture must work with a relative host root");
        assert!(
            outcome.slice_ref.is_some(),
            "capture must write a slice ref: {outcome:?}"
        );
    }

    #[tokio::test]
    async fn checkpoint_capture_fails_explicitly_without_git() {
        let temp = TempDir::new().expect("tempdir");
        std::fs::create_dir_all(temp.path().join("ws1")).expect("workspace");
        let engine = ShadowGit::new(temp.path()).with_git_binary("xihe-runtime-missing-git-binary");
        let error = engine
            .capture("ws1", "run-1", "tester", "call-1", false)
            .await
            .expect_err("capture must fail without git");
        assert!(matches!(error, CheckpointError::GitUnavailable(_)));
        let error = engine
            .retention_gc("ws1", 50, 30)
            .await
            .expect_err("retention must fail without git");
        assert!(matches!(error, CheckpointError::GitUnavailable(_)));
    }

    #[tokio::test]
    async fn checkpoint_invalid_run_id_fails_before_any_git_work() {
        let temp = TempDir::new().expect("tempdir");
        let engine = ShadowGit::new(temp.path()).with_git_binary("xihe-runtime-missing-git-binary");
        let error = engine
            .capture("ws1", "../escape", "tester", "call", false)
            .await
            .expect_err("invalid run id must fail");
        assert!(matches!(
            error,
            CheckpointError::InvalidIdentifier { kind: "run id", .. }
        ));
    }

    #[tokio::test]
    async fn checkpoint_lock_counters_track_capture_and_restore_guards() {
        let temp = TempDir::new().expect("tempdir");
        let engine = ShadowGit::new(temp.path());
        assert_eq!(engine.active_capture_locks(), 0);
        assert_eq!(engine.active_restore_locks(), 0);

        let capture = engine.lock_capture("ws1").await;
        assert_eq!(engine.active_capture_locks(), 1);
        assert_eq!(engine.active_restore_locks(), 0);

        let restore = engine.try_lock_restore("ws1").expect("restore lock");
        assert_eq!(engine.active_restore_locks(), 1);
        assert!(
            engine.try_lock_restore("ws1").is_none(),
            "a second restore lock must fail fast"
        );
        drop(restore);
        assert_eq!(engine.active_restore_locks(), 0);
        assert!(engine.try_lock_restore("ws1").is_some());
        drop(capture);
        assert_eq!(engine.active_capture_locks(), 0);
    }

    #[test]
    fn work_tree_override_uses_registered_path_and_falls_back_to_host_root() {
        let temp = TempDir::new().expect("tempdir");
        let engine = ShadowGit::new(temp.path());
        assert_eq!(
            engine.work_tree("ws1").expect("legacy path"),
            temp.path().join("ws1")
        );

        let direct = temp.path().join("direct-attach").join("ws1");
        engine.set_work_tree_override("ws1", direct.clone());
        assert_eq!(engine.work_tree("ws1").expect("override path"), direct);

        engine.clear_work_tree_override("ws1");
        assert_eq!(
            engine.work_tree("ws1").expect("fallback path"),
            temp.path().join("ws1")
        );

        // Invalid identifiers never install an override.
        engine.set_work_tree_override("../escape", direct);
        assert!(
            engine.work_tree("../escape").is_err(),
            "invalid id must not resolve"
        );
    }

    #[tokio::test]
    async fn checkpoint_capture_no_change_writes_no_ref_and_change_writes_a_slice() {
        let temp = TempDir::new().expect("tempdir");
        let workspace = temp.path().join("ws1");
        std::fs::create_dir_all(workspace.join("src")).expect("workspace");
        std::fs::write(workspace.join("src/main.txt"), "hello\n").expect("fixture file");
        let engine = ShadowGit::new(temp.path());
        if !require_git(&engine).await {
            return;
        }

        let first = engine
            .capture("ws1", "run-smoke", "tester", "call-1", false)
            .await
            .expect("first capture");
        assert!(!first.no_change);
        assert_eq!(first.state, "captured");
        let slice_ref = first.slice_ref.clone().expect("slice ref");
        assert!(slice_ref.starts_with(SLICE_REF_PREFIX));
        let parsed = parse_slice_ref(&slice_ref).expect("canonical slice ref");
        assert_eq!(parsed.commit, first.commit.clone().expect("commit"));
        assert_eq!(first.changed_files, Vec::new(), "no tail means no diff");
        assert_eq!(first.predecessor, None);
        assert!(
            first
                .captured_at
                .as_deref()
                .is_some_and(|value| value.ends_with('Z')),
            "capturedAt must be RFC3339 UTC: {:?}",
            first.captured_at
        );

        // A second capture of the same tree: no change, no ref.
        let second = engine
            .capture("ws1", "run-second", "tester", "call-2", false)
            .await
            .expect("second capture");
        assert!(second.no_change, "identical tree must not write a slice");
        assert_eq!(second.slice_ref, None);
        assert_eq!(second.commit, None);
        assert_eq!(second.changed_files, Vec::new());
        assert_eq!(second.predecessor.as_deref(), Some(slice_ref.as_str()));

        // A real change: new slice with the changed file and the tail as predecessor.
        std::fs::write(workspace.join("src/main.txt"), "hello again\n").expect("write");
        std::fs::write(workspace.join("added.txt"), "added\n").expect("write");
        let third = engine
            .capture("ws1", "run-third", "tester", "call-3", true)
            .await
            .expect("third capture");
        assert!(!third.no_change);
        assert_eq!(third.state, "abnormal-captured");
        assert_eq!(third.predecessor.as_deref(), Some(slice_ref.as_str()));
        let mut changed: Vec<(String, String)> = third
            .changed_files
            .iter()
            .map(|file| (file.status.clone(), file.path.clone()))
            .collect();
        changed.sort();
        assert_eq!(
            changed,
            vec![
                ("A".to_string(), "added.txt".to_string()),
                ("M".to_string(), "src/main.txt".to_string()),
            ]
        );

        // The slice commit is a root commit (no parent).
        let shadow = engine.shadow_git_dir("ws1").expect("shadow dir");
        let env = engine.isolated_env(&shadow, &workspace, None);
        let commit = third.commit.clone().expect("commit");
        let parents = engine
            .run_git_checked(
                &["rev-list", "--parents", "-n", "1", &commit],
                &env,
                None,
                engine.call_timeout,
            )
            .await
            .expect("rev-list");
        let parents = String::from_utf8_lossy(&parents);
        assert_eq!(
            parents.split_whitespace().count(),
            1,
            "slice commits have no parent: {parents}"
        );
    }

    #[tokio::test]
    async fn checkpoint_retention_counts_slices_and_keeps_the_newest() {
        let temp = TempDir::new().expect("tempdir");
        let workspace = temp.path().join("ws1");
        std::fs::create_dir_all(&workspace).expect("workspace");
        let engine = ShadowGit::new(temp.path());
        if !require_git(&engine).await {
            return;
        }

        let mut slice_refs = Vec::new();
        for index in 1..=4 {
            std::fs::write(workspace.join("file.txt"), format!("version {index}\n"))
                .expect("fixture write");
            let outcome = engine
                .capture("ws1", &format!("run-{index:02}"), "tester", "call", false)
                .await
                .expect("capture");
            slice_refs.push(outcome.slice_ref.expect("slice written"));
        }

        let report = engine.retention_gc("ws1", 2, 30).await.expect("retention");
        assert_eq!(report.deleted_slices.len(), 2);
        assert_eq!(report.deleted_slices[0], slice_refs[0], "oldest first");
        assert_eq!(report.kept, 2);
        assert!(report.gc_ran);

        let shadow = engine.shadow_git_dir("ws1").expect("shadow dir");
        let env = engine.isolated_env(&shadow, &workspace, None);
        let remaining = String::from_utf8_lossy(
            &engine
                .run_git_checked(
                    &["for-each-ref", "--format=%(refname)", SLICE_REF_PREFIX],
                    &env,
                    None,
                    engine.call_timeout,
                )
                .await
                .expect("for-each-ref"),
        )
        .to_string();
        assert!(!remaining.contains(&slice_refs[0]));
        assert!(remaining.contains(&slice_refs[3]));

        // TTL-only sweep deletes every slice older than the cutoff.
        let ttl_report = engine.retention_gc("ws1", 50, 0).await.expect("ttl sweep");
        assert_eq!(ttl_report.deleted_slices.len(), 2);
        assert_eq!(ttl_report.kept, 0);
    }

    #[test]
    fn checkpoint_porcelain_status_parser_handles_renames_and_malformed_tails() {
        let entries = parse_porcelain_status_z(b" M tracked.txt\0?? new.txt\0R  b.txt\0a.txt\0");
        assert_eq!(
            entries,
            vec![
                GitStatusEntry {
                    status: " M".to_string(),
                    path: "tracked.txt".to_string(),
                },
                GitStatusEntry {
                    status: "??".to_string(),
                    path: "new.txt".to_string(),
                },
                GitStatusEntry {
                    status: "R ".to_string(),
                    path: "b.txt".to_string(),
                },
            ],
            "rename records consume the original-path field without reporting it"
        );
        assert!(parse_porcelain_status_z(b"").is_empty());
        assert!(parse_porcelain_status_z(b"X\0").is_empty());
    }

    #[tokio::test]
    async fn checkpoint_workspace_git_status_reports_repo_non_repo_and_missing_dir() {
        let temp = TempDir::new().expect("tempdir");
        let workspace = temp.path().join("ws1");
        std::fs::create_dir_all(&workspace).expect("workspace");
        let engine = ShadowGit::new(temp.path());
        let capability = engine.probe().await;
        assert!(
            capability.available,
            "git-status requires a real host git: {capability:?}"
        );

        let non_repo = engine
            .workspace_git_status("ws1")
            .await
            .expect("non-repo status");
        assert!(!non_repo.is_repository);
        assert!(non_repo.entries.is_empty());

        let missing = TempDir::new().expect("tempdir");
        let error = ShadowGit::new(missing.path())
            .workspace_git_status("ws1")
            .await
            .expect_err("missing workspace must fail explicitly");
        assert!(matches!(error, CheckpointError::WorkspaceMissing(_)));
    }

    #[tokio::test]
    async fn checkpoint_dual_write_covers_no_change_and_git_mode_creates_no_store() {
        let temp = TempDir::new().expect("tempdir");
        let workspace = temp.path().join("ws1");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::write(workspace.join("a.txt"), "alpha\n").expect("file");
        let store_root = temp.path().join(".xihe-store");
        let mut engine = ShadowGit::new(temp.path());
        if !require_git(&engine).await {
            return;
        }

        let first = engine
            .capture("ws1", "run-git", "tester", "call-git", false)
            .await
            .expect("git capture");
        assert!(!first.no_change);
        assert!(!store_root.exists(), "git mode must not create a store");
        assert!(engine.store_root().is_none());
        assert_eq!(engine.store_failures(), 0);

        engine
            .configure_checkpoint_storage(CheckpointStorageMode::Dual, &store_root)
            .expect("configure dual store");
        let store = Store::open(&store_root).expect("open store");
        let second = engine
            .capture("ws1", "run-dual", "tester", "call-dual", false)
            .await
            .expect("dual capture");
        assert!(
            second.no_change,
            "git no-change still needs the first store slice"
        );
        let slices: Vec<_> = std::fs::read_dir(store.slice_dir("ws1"))
            .expect("slice dir")
            .flatten()
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
            .collect();
        assert_eq!(
            slices.len(),
            1,
            "first dual capture must write one store slice"
        );
        assert_eq!(engine.store_failures(), 0);
    }

    #[tokio::test]
    async fn checkpoint_dual_store_failure_does_not_fail_git_capture() {
        let temp = TempDir::new().expect("tempdir");
        let workspace = temp.path().join("ws1");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::write(workspace.join("a.txt"), "alpha\n").expect("file");
        let store_root = temp.path().join(".xihe-store");
        let mut engine = ShadowGit::new(temp.path());
        if !require_git(&engine).await {
            return;
        }
        engine
            .configure_checkpoint_storage(CheckpointStorageMode::Dual, &store_root)
            .expect("configure dual");
        let store = Store::open(&store_root).expect("open store");
        let guard = store.lock().expect("hold store lock");

        let outcome = engine
            .capture("ws1", "run-locked", "tester", "call-locked", false)
            .await
            .expect("git capture must remain authoritative");
        assert!(!outcome.no_change);
        assert_eq!(
            engine.store_failures(),
            1,
            "locked store must count one failure"
        );
        drop(guard);

        let retry = engine
            .capture("ws1", "run-retry", "tester", "call-retry", false)
            .await
            .expect("retry capture");
        assert!(retry.no_change);
        assert_eq!(engine.store_failures(), 1);
        let slices = std::fs::read_dir(store.slice_dir("ws1"))
            .expect("slice dir")
            .count();
        assert_eq!(slices, 1, "next capture backfills the store slice");
    }

    #[tokio::test]
    async fn self_capture_writes_store_and_refs_sidecar() {
        use crate::checkpoint_store::preflight::{PreflightOptions, run_preflight};

        let temp = TempDir::new().expect("tempdir");
        let workspace = temp.path().join("ws1");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::write(workspace.join("a.txt"), "self").expect("file");
        let store_root = temp.path().join(".xihe-store");
        let mut engine =
            ShadowGit::new(temp.path()).with_nested_repo_policy(NestedRepoPolicy::Opaque);
        if !require_git(&engine).await {
            return;
        }
        engine
            .configure_checkpoint_storage(CheckpointStorageMode::Self_, &store_root)
            .expect("configure self");
        let outcome = engine
            .capture("ws1", "run-self-1", "tester", "call-self-1", false)
            .await
            .expect("self capture");
        let git_ref = outcome.slice_ref.expect("git ref");
        let store = Store::open(&store_root).expect("store");
        let record = refs::read_ref(&store, "ws1", &git_ref)
            .expect("ref read")
            .expect("ref sidecar");
        assert_eq!(record.source, "capture");
        assert_eq!(record.git_ref, git_ref);
        assert!(!record.git_tree.is_empty());
        assert!(
            store
                .slice_dir("ws1")
                .join(format!("{}.json", record.store_slice_id))
                .is_file()
        );

        let shadow = engine.shadow_git_dir("ws1").expect("shadow");
        let mut shadows = HashMap::new();
        shadows.insert("ws1".to_string(), shadow);
        let report = run_preflight(
            &store,
            &PreflightOptions {
                roots: vec!["ws1".into()],
                shadow_git_dirs: shadows,
                ..PreflightOptions::default()
            },
        )
        .expect("preflight");
        assert!(report.ok, "{report:?}");
        assert_eq!(report.roots[0].mapped_refs, 1);
        assert_eq!(report.roots[0].unmapped_slices.len(), 0);
    }

    #[tokio::test]
    async fn self_capture_store_failure_is_hard_failure() {
        let temp = TempDir::new().expect("tempdir");
        let workspace = temp.path().join("ws1");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::write(workspace.join("a.txt"), "self").expect("file");
        let store_root = temp.path().join(".xihe-store");
        let mut engine = ShadowGit::new(temp.path());
        if !require_git(&engine).await {
            return;
        }
        engine
            .configure_checkpoint_storage(CheckpointStorageMode::Self_, &store_root)
            .expect("configure self");
        std::fs::remove_dir_all(&store_root).expect("remove store");
        let error = engine
            .capture("ws1", "run-self-fail", "tester", "call-self-fail", false)
            .await
            .expect_err("store failure must fail capture");
        assert!(
            matches!(error, CheckpointError::StoreCaptureFailed { .. }),
            "{error:?}"
        );
        assert!(engine.store_failures() > 0);
    }

    #[tokio::test]
    async fn self_capture_refs_failure_fails_then_retry_repairs_mapping() {
        let temp = TempDir::new().expect("tempdir");
        let workspace = temp.path().join("ws1");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::write(workspace.join("a.txt"), "self").expect("file");
        let store_root = temp.path().join(".xihe-store");
        let mut engine =
            ShadowGit::new(temp.path()).with_nested_repo_policy(NestedRepoPolicy::Opaque);
        if !require_git(&engine).await {
            return;
        }
        engine
            .configure_checkpoint_storage(CheckpointStorageMode::Self_, &store_root)
            .expect("configure self");
        std::fs::write(store_root.join("index/refs"), "not a directory").expect("refs blocker");
        let error = engine
            .capture("ws1", "run-refs-fail", "tester", "call-refs-fail", false)
            .await
            .expect_err("refs failure must fail capture");
        assert!(
            matches!(error, CheckpointError::StoreCaptureFailed { .. }),
            "{error:?}"
        );
        let store = Store::open(&store_root).expect("store");
        let slices: Vec<_> = std::fs::read_dir(store.slice_dir("ws1"))
            .expect("slice dir")
            .flatten()
            .map(|entry| entry.path())
            .collect();
        assert_eq!(slices.len(), 1, "store slice remains explicitly orphaned");
        std::fs::remove_file(store_root.join("index/refs")).expect("remove refs blocker");

        let repaired = engine
            .capture(
                "ws1",
                "run-refs-repair",
                "tester",
                "call-refs-repair",
                false,
            )
            .await
            .expect("retry capture");
        assert!(repaired.no_change);
        let git_ref = repaired
            .predecessor
            .expect("predecessor ref for no-change retry");
        let record = refs::read_ref(&store, "ws1", &git_ref)
            .expect("ref read")
            .expect("repaired ref");
        assert_eq!(record.source, "capture");
    }

    #[tokio::test]
    #[ignore = "P2.0 real dual-backfill fixture; run with --ignored --nocapture"]
    async fn p2_real_dual_backfill_fixture() {
        use crate::checkpoint_store::preflight::{PreflightOptions, run_preflight};

        let temp = TempDir::new().expect("tempdir");
        let workspace = temp.path().join("ws1");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::write(workspace.join("a.txt"), "one").expect("a");
        let store_root = temp.path().join(".xihe-store");
        let mut engine =
            ShadowGit::new(temp.path()).with_nested_repo_policy(NestedRepoPolicy::Opaque);
        if !require_git(&engine).await {
            return;
        }
        engine
            .configure_checkpoint_storage(CheckpointStorageMode::Dual, &store_root)
            .expect("configure dual");
        engine
            .capture("ws1", "real-1", "tester", "real-call-1", false)
            .await
            .expect("capture 1");
        std::fs::write(workspace.join("b.txt"), "two").expect("b");
        engine
            .capture("ws1", "real-2", "tester", "real-call-2", false)
            .await
            .expect("capture 2");
        let audit = engine
            .audit_dual_pending(Some("ws1"), None)
            .await
            .expect("audit");
        assert_eq!(audit.failed, 0, "{audit:?}");
        assert!(audit.passed >= 2);
        let store = Store::open(&store_root).expect("store");
        // Simulate historical dual slices from before P2.1: no refs sidecars.
        let refs_dir = store.root().join("index").join("refs");
        if refs_dir.exists() {
            std::fs::remove_dir_all(&refs_dir).expect("remove refs for backfill");
        }
        let shadow = engine.shadow_git_dir("ws1").expect("shadow");
        let mut shadows = HashMap::new();
        shadows.insert("ws1".to_string(), shadow.clone());
        let report = run_preflight(
            &store,
            &PreflightOptions {
                roots: vec!["ws1".into()],
                shadow_git_dirs: shadows,
                ..PreflightOptions::default()
            },
        )
        .expect("preflight");
        assert!(report.ok, "{report:?}");
        assert_eq!(report.roots[0].backfilled_refs, audit.passed);
        assert!(report.roots[0].unmapped_slices.is_empty());
        assert_eq!(
            report.roots[0].mapped_refs,
            std::fs::read_dir(store.slice_dir("ws1"))
                .expect("slices")
                .flatten()
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
                .count()
        );

        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let evidence = manifest_dir
            .join("..")
            .join("..")
            .join(".local")
            .join("evidence")
            .join("plan-0653")
            .join("p2.0-real-backfill");
        if evidence.exists() {
            std::fs::remove_dir_all(&evidence).expect("clean fixture");
        }
        fn copy_dir(from: &Path, to: &Path) {
            std::fs::create_dir_all(to).expect("copy dir");
            for entry in std::fs::read_dir(from).expect("copy read") {
                let entry = entry.expect("copy entry");
                let source = entry.path();
                let target = to.join(entry.file_name());
                if entry.file_type().expect("copy type").is_dir() {
                    copy_dir(&source, &target);
                } else {
                    std::fs::copy(&source, &target).expect("copy file");
                }
            }
        }
        copy_dir(&store_root, &evidence.join("store"));
        copy_dir(&shadow, &evidence.join("shadow.git"));
        copy_dir(&workspace, &evidence.join("workspace"));
        std::fs::write(
            evidence.join("preflight.json"),
            serde_json::to_vec_pretty(&report).expect("report json"),
        )
        .expect("write report");
        eprintln!(
            "P2_REAL_BACKFILL {}",
            serde_json::to_string(&report).expect("report")
        );
    }

    #[test]
    #[ignore = "P2.4 real dev-store preflight + GC dry run; env-driven"]
    fn p24_real_store_checks() {
        use crate::checkpoint_store::gc::{GcOptions, gc};
        use crate::checkpoint_store::preflight::{PreflightOptions, run_preflight};

        let store_path = std::env::var("P24_STORE").expect("P24_STORE");
        let roots = std::env::var("P24_ROOTS")
            .expect("P24_ROOTS")
            .split(',')
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let shadow_root = std::env::var("P24_SHADOW_ROOT").expect("P24_SHADOW_ROOT");
        let store = Store::open(&store_path).expect("open store");
        let mut shadows = HashMap::new();
        for root in &roots {
            let shadow = Path::new(&shadow_root).join(format!("{root}.git"));
            if shadow.is_dir() {
                shadows.insert(root.clone(), shadow);
            }
        }
        let preflight = run_preflight(
            &store,
            &PreflightOptions {
                roots: roots.clone(),
                shadow_git_dirs: shadows,
                enforce_read_paths: true,
                ..PreflightOptions::default()
            },
        )
        .expect("preflight");
        assert!(preflight.ok, "{preflight:?}");
        for root in &preflight.roots {
            assert_eq!(root.unmapped_slices.len(), 0, "{root:?}");
            assert_eq!(root.mapped_refs, root.store_slices, "{root:?}");
        }
        let gc = gc(
            &store,
            &GcOptions {
                repair: false,
                ..GcOptions::default()
            },
        )
        .expect("gc dry run");
        assert!(gc.dry_run);
        let payload = serde_json::json!({
            "preflight": preflight,
            "gc": gc,
            "storePath": store_path,
        });
        if let Ok(out) = std::env::var("P24_OUT") {
            std::fs::write(&out, serde_json::to_vec_pretty(&payload).expect("json"))
                .expect("write P24_OUT");
        }
        eprintln!(
            "P24_REAL {}",
            serde_json::to_string(&payload).expect("payload")
        );
    }

    #[test]
    #[ignore = "P2.4 real store orphan GC dry-run; env-driven"]
    fn p24_real_gc_orphan_dry_run() {
        use crate::checkpoint_store::blob::{blob_path, write_blob};
        use crate::checkpoint_store::gc::{GcOptions, gc};

        let store_path = std::env::var("P24_STORE").expect("P24_STORE");
        let store = Store::open(&store_path).expect("open store");
        let content = format!(
            "p24-unreferenced-orphan-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        );
        let orphan = write_blob(store.root(), content.as_bytes()).expect("write orphan");
        let orphan_path = blob_path(store.root(), &orphan.hash);
        let report = gc(
            &store,
            &GcOptions {
                repair: false,
                grace_seconds: 0,
                ..GcOptions::default()
            },
        )
        .expect("gc dry run");
        assert!(report.dry_run);
        assert!(report.candidates >= 1, "{report:?}");
        assert!(report.candidate_bytes > 0, "{report:?}");
        assert!(orphan_path.exists(), "dry-run must not delete the orphan");
        // Remove only the orphan this test created; never run repair on the
        // real store from this harness.
        std::fs::remove_file(&orphan_path).expect("cleanup seeded orphan");
        let payload = serde_json::json!({
            "orphanHash": orphan.hash,
            "orphanBytes": content.len(),
            "orphanRemovedAfterEvidence": true,
            "gc": report,
            "atUtc": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or(0),
        });
        if let Ok(out) = std::env::var("P24_OUT") {
            std::fs::write(&out, serde_json::to_vec_pretty(&payload).expect("json"))
                .expect("write P24_OUT");
        }
        eprintln!(
            "P24_ORPHAN {}",
            serde_json::to_string(&payload).expect("payload")
        );
    }

    #[tokio::test]
    #[ignore = "V6: three self->git->self rounds; every store slice restores"]
    async fn v6_three_rounds_self_git_self_restore_history() {
        use crate::checkpoint_store::restore_full::{FullRestoreOptions, restore_full};

        let temp = TempDir::new().expect("tempdir");
        let host = temp.path().join("host");
        let store_root = temp.path().join("v6-store");
        std::fs::create_dir_all(host.join("ws-v6")).expect("worktree");
        let mut self_engine =
            ShadowGit::new(&host).with_nested_repo_policy(NestedRepoPolicy::Opaque);
        self_engine
            .configure_checkpoint_storage(CheckpointStorageMode::Self_, &store_root)
            .expect("self store");
        let git_engine = ShadowGit::new(&host).with_nested_repo_policy(NestedRepoPolicy::Opaque);
        if !require_git(&self_engine).await {
            return;
        }
        let work = host.join("ws-v6");
        let store = Store::open(&store_root).expect("store");
        let mut store_slices = Vec::new();
        let mut git_refs = Vec::new();
        for round in 0..3usize {
            let first = format!("round-{round}-self-a");
            std::fs::write(work.join("version.txt"), &first).expect("a");
            let first_capture = self_engine
                .capture(
                    "ws-v6",
                    &format!("v6-{round}-a"),
                    "v6",
                    &format!("v6-call-{round}-a"),
                    false,
                )
                .await
                .expect("self capture a");
            let first_ref = first_capture.slice_ref.expect("slice ref");
            let first_record = refs::read_ref(&store, "ws-v6", &first_ref)
                .expect("first ref read")
                .expect("first ref exists");
            store_slices.push((first_record.store_slice_id, first.clone()));

            let git_version = format!("round-{round}-git");
            std::fs::write(work.join("version.txt"), &git_version).expect("git");
            let git_capture = git_engine
                .capture(
                    "ws-v6",
                    &format!("v6-{round}-git"),
                    "v6",
                    &format!("v6-call-{round}-git"),
                    false,
                )
                .await
                .expect("git capture");
            git_refs.push(git_capture.slice_ref.expect("git ref"));

            let second = format!("round-{round}-self-b");
            std::fs::write(work.join("version.txt"), &second).expect("b");
            let second_capture = self_engine
                .capture(
                    "ws-v6",
                    &format!("v6-{round}-b"),
                    "v6",
                    &format!("v6-call-{round}-b"),
                    false,
                )
                .await
                .expect("self capture b");
            let second_ref = second_capture.slice_ref.expect("slice ref");
            let second_record = refs::read_ref(&store, "ws-v6", &second_ref)
                .expect("second ref read")
                .expect("second ref exists");
            store_slices.push((second_record.store_slice_id, second));
        }
        assert_eq!(store_slices.len(), 6);
        assert_eq!(git_refs.len(), 3);
        for (index, (slice_id, expected)) in store_slices.iter().enumerate() {
            let target = temp.path().join(format!("restore-{index}"));
            std::fs::create_dir_all(&target).expect("target");
            restore_full(
                &store,
                "ws-v6",
                slice_id,
                &target,
                &FullRestoreOptions::default(),
            )
            .unwrap_or_else(|error| panic!("restore {slice_id}: {error}"));
            let actual = std::fs::read_to_string(target.join("version.txt")).expect("version");
            assert_eq!(&actual, expected, "slice {slice_id}");
        }
        eprintln!(
            "V6_ROUNDS store_slices={} git_refs={}",
            store_slices.len(),
            git_refs.len()
        );
    }

    #[tokio::test]
    async fn checkpoint_dual_source_manifest_matches_for_opaque() {
        let temp = TempDir::new().expect("tempdir");
        let workspace = temp.path().join("ws1");
        std::fs::create_dir_all(workspace.join("nested")).expect("nested dir");
        let nested_init = std::process::Command::new("git")
            .args(["init", "-q"])
            .arg(workspace.join("nested"))
            .status()
            .expect("git init nested");
        assert!(nested_init.success(), "nested git init failed");
        std::fs::write(workspace.join("root.txt"), "root\n").expect("root file");
        std::fs::write(workspace.join("nested/nested.txt"), "nested\n").expect("nested file");
        for args in [
            vec!["config", "user.email", "test@example.invalid"],
            vec!["config", "user.name", "test"],
            vec!["add", "-A"],
            vec!["commit", "-qm", "nested base"],
        ] {
            let status = std::process::Command::new("git")
                .arg("-C")
                .arg(workspace.join("nested"))
                .args(&args)
                .status()
                .expect("nested git command");
            assert!(status.success(), "nested git {args:?} failed");
        }
        let store_root = temp.path().join(".xihe-store");
        let walker_store_dir = temp.path().join("walker-store");
        let mut engine =
            ShadowGit::new(temp.path()).with_nested_repo_policy(NestedRepoPolicy::Opaque);
        if !require_git(&engine).await {
            return;
        }
        engine
            .configure_checkpoint_storage(CheckpointStorageMode::Dual, &store_root)
            .expect("configure dual");
        engine
            .capture("ws1", "run-gitfed", "tester", "call-gitfed", false)
            .await
            .expect("git-fed capture");

        let store = Store::open(&store_root).expect("open store");
        let mut slices: Vec<_> = std::fs::read_dir(store.slice_dir("ws1"))
            .expect("slice dir")
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
            .collect();
        slices.sort();
        let slice: serde_json::Value = serde_json::from_slice(
            &std::fs::read(slices.last().expect("store slice")).expect("slice bytes"),
        )
        .expect("slice json");
        let gitfed_manifest = slice["manifest"].as_str().expect("manifest id").to_owned();
        let gitfed_bytes = std::fs::read(store.manifest_path(&gitfed_manifest)).expect("manifest");

        let walker_store = Store::init(&walker_store_dir).expect("walker store");
        let walker = capture_root_with_options(
            &walker_store,
            &workspace,
            "ws1",
            None,
            None,
            &CaptureOptions {
                declared_roots: Vec::new(),
                exclude_opaque_nested: true,
            },
        )
        .expect("walker capture");
        let walker_bytes = std::fs::read(walker_store.manifest_path(&walker.manifest_id))
            .expect("walker manifest");
        assert_eq!(
            gitfed_bytes, walker_bytes,
            "git-fed and walker manifests must be byte-identical for Opaque"
        );
        assert_eq!(walker.nested_roots, vec!["nested".to_string()]);
        assert_eq!(slice["nested_roots"], serde_json::json!(["nested"]));

        // Second capture exercises the incremental git-tree cache.
        std::fs::write(workspace.join("root.txt"), "root-2\n").expect("root change");
        engine
            .capture("ws1", "run-gitfed-2", "tester", "call-gitfed-2", false)
            .await
            .expect("incremental git-fed capture");
        let mut slices: Vec<_> = std::fs::read_dir(store.slice_dir("ws1"))
            .expect("slice dir")
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
            .collect();
        slices.sort();
        let slice: serde_json::Value = serde_json::from_slice(
            &std::fs::read(slices.last().expect("second store slice")).expect("slice bytes"),
        )
        .expect("slice json");
        let gitfed_manifest = slice["manifest"].as_str().expect("manifest id").to_owned();
        let gitfed_bytes = std::fs::read(store.manifest_path(&gitfed_manifest)).expect("manifest");
        let walker = capture_root_with_options(
            &walker_store,
            &workspace,
            "ws1",
            None,
            None,
            &CaptureOptions {
                declared_roots: Vec::new(),
                exclude_opaque_nested: true,
            },
        )
        .expect("second walker capture");
        let walker_bytes = std::fs::read(walker_store.manifest_path(&walker.manifest_id))
            .expect("second walker manifest");
        assert_eq!(
            gitfed_bytes, walker_bytes,
            "incremental git-fed and walker manifests must be byte-identical"
        );
        let report = engine
            .audit_dual_pending(Some("ws1"), None)
            .await
            .expect("audit pending");
        assert_eq!(report.failed, 0, "audit findings: {:?}", report.findings);
        assert!(report.passed >= 2, "expected both pending records to audit");
    }

    #[tokio::test]
    #[ignore = "manual 200x dual-write audit gate; --ignored --nocapture"]
    async fn audit_dual_pending_200x() {
        let temp = TempDir::new().expect("tempdir");
        let workspace = temp.path().join("ws1");
        for index in 0..1_000usize {
            let path = workspace.join(format!("dir/{:02}/file-{index:04}.txt", index / 50));
            std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
            std::fs::write(path, format!("payload-{index}")).expect("seed");
        }
        let store_root = temp.path().join(".xihe-store");
        let mut engine =
            ShadowGit::new(temp.path()).with_nested_repo_policy(NestedRepoPolicy::Opaque);
        if !require_git(&engine).await {
            return;
        }
        engine
            .configure_checkpoint_storage(CheckpointStorageMode::Dual, &store_root)
            .expect("configure dual");
        engine
            .capture("ws1", "audit-warm", "tester", "audit-warm-call", false)
            .await
            .expect("warm capture");
        for iteration in 0..200usize {
            std::fs::write(
                workspace.join("changed.txt"),
                format!("changed-{iteration}"),
            )
            .expect("change");
            engine
                .capture(
                    "ws1",
                    &format!("audit-{iteration}"),
                    "tester",
                    &format!("audit-call-{iteration}"),
                    false,
                )
                .await
                .expect("audit capture");
        }
        let report = engine
            .audit_dual_pending(Some("ws1"), None)
            .await
            .expect("audit pending");
        eprintln!(
            "audit_200x audited={} passed={} failed={} findings={}",
            report.audited,
            report.passed,
            report.failed,
            report.findings.len()
        );
        assert_eq!(report.failed, 0, "audit findings: {:?}", report.findings);
        assert!(report.audited >= 200, "expected >=200 pending records");
        assert_eq!(report.passed, report.audited);
    }

    #[tokio::test]
    #[ignore = "manual 200x dual-write overhead benchmark; --ignored --nocapture"]
    async fn benchmark_dual_write_overhead_200x() {
        use std::time::Instant;

        fn dir_size(root: &Path) -> u64 {
            let mut total = 0u64;
            let mut stack = vec![root.to_path_buf()];
            while let Some(dir) = stack.pop() {
                let Ok(entries) = std::fs::read_dir(&dir) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let path = entry.path();
                    let Ok(metadata) = std::fs::symlink_metadata(&path) else {
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

        fn seed_workspace(root: &Path) {
            let workspace = root.join("ws1");
            for index in 0..1_000usize {
                let relative = format!("dir/{:02}/file-{index:04}.txt", index / 50);
                let path = workspace.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
                std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
                std::fs::write(path, format!("payload-{index}")).expect("seed file");
            }
            std::fs::create_dir_all(&workspace).expect("workspace");
            std::fs::write(workspace.join("changed.txt"), "initial\n").expect("changed");
        }

        let git_root = TempDir::new().expect("git root");
        let dual_root = TempDir::new().expect("dual root");
        seed_workspace(git_root.path());
        seed_workspace(dual_root.path());
        let store_root = dual_root.path().join(".xihe-store");
        let git_engine = ShadowGit::new(git_root.path());
        let mut dual_engine =
            ShadowGit::new(dual_root.path()).with_nested_repo_policy(NestedRepoPolicy::Opaque);
        if !require_git(&git_engine).await {
            return;
        }
        require_git(&dual_engine).await;
        dual_engine
            .configure_checkpoint_storage(CheckpointStorageMode::Dual, &store_root)
            .expect("configure dual");

        let _ = git_engine
            .capture("ws1", "run-warm", "tester", "call-warm", false)
            .await
            .expect("git warm capture");
        let _ = dual_engine
            .capture("ws1", "run-warm", "tester", "call-warm", false)
            .await
            .expect("dual warm capture");

        let iterations = 200usize;
        let mut git_total = 0u128;
        let mut dual_total = 0u128;
        let mut extras_ms = Vec::with_capacity(iterations);
        for iteration in 0..iterations {
            let value = format!("changed-{iteration}\n");
            std::fs::write(git_root.path().join("ws1/changed.txt"), &value).expect("git change");
            std::fs::write(dual_root.path().join("ws1/changed.txt"), &value).expect("dual change");
            let run_id = format!("run-{iteration:04}");

            let started = Instant::now();
            let git_capture = git_engine
                .capture("ws1", &run_id, "tester", "call-git", false)
                .await
                .expect("git capture");
            let git_ms = started.elapsed().as_millis();
            let started = Instant::now();
            let dual_capture = dual_engine
                .capture("ws1", &run_id, "tester", "call-dual", false)
                .await
                .expect("dual capture");
            let dual_ms = started.elapsed().as_millis();
            assert!(!git_capture.no_change);
            assert!(!dual_capture.no_change);
            git_total += git_ms;
            dual_total += dual_ms;
            extras_ms.push(dual_ms as i64 - git_ms as i64);
        }
        extras_ms.sort_unstable();
        let p50 = extras_ms[extras_ms.len() / 2];
        let p95 = extras_ms[(extras_ms.len() * 95 / 100).min(extras_ms.len() - 1)];
        let store_bytes = dir_size(&store_root);
        eprintln!(
            "dual_overhead iterations={iterations} files=1000 git_total_ms={git_total} dual_total_ms={dual_total} extra_p50_ms={p50} extra_p95_ms={p95} extra_total_ms={} store_bytes={store_bytes} store_failures={}",
            dual_total as i64 - git_total as i64,
            dual_engine.store_failures()
        );
        assert_eq!(
            dual_engine.store_failures(),
            0,
            "P2 gate requires zero store failures"
        );
    }
}
