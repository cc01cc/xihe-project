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

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use thiserror::Error;
use tokio::process::Command;
use tracing::{debug, info, warn};

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

/// Nested-repository capture policy (PLAN-0338 T1.2; default `Opaque`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NestedRepoPolicy {
    /// Record nested repositories as opaque gitlinks: their contents are not
    /// captured and cannot be restored (default; full support is PLAN-0361).
    Opaque,
    /// Opt-in hard limit: refuse the capture when any nested repository is
    /// present, with an explicit degraded reason (never silent).
    Reject,
}

impl NestedRepoPolicy {
    /// Wire/diagnostics token (`opaque` / `reject`).
    pub fn as_str(self) -> &'static str {
        match self {
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
    active_capture_locks: Arc<AtomicUsize>,
    active_restore_locks: Arc<AtomicUsize>,
    probe_cache: StdMutex<ProbeCache>,
    max_untracked_file_bytes: u64,
    nested_repo_policy: NestedRepoPolicy,
    pub(crate) call_timeout: Duration,
}

impl ShadowGit {
    pub fn new(host_root: impl Into<PathBuf>) -> Self {
        Self {
            host_root: host_root.into(),
            git_binary: "git".to_string(),
            locks: StdMutex::new(HashMap::new()),
            active_capture_locks: Arc::new(AtomicUsize::new(0)),
            active_restore_locks: Arc::new(AtomicUsize::new(0)),
            probe_cache: StdMutex::new(ProbeCache::default()),
            max_untracked_file_bytes: DEFAULT_MAX_UNTRACKED_FILE_BYTES,
            nested_repo_policy: NestedRepoPolicy::Opaque,
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

    pub fn with_call_timeout(mut self, timeout: Duration) -> Self {
        self.call_timeout = timeout;
        self
    }

    pub fn host_root(&self) -> &Path {
        &self.host_root
    }

    /// `<hostRoot>/.xihe-shadow/<workspaceId>.git`.
    pub fn shadow_git_dir(&self, workspace_id: &str) -> Result<PathBuf> {
        validate_workspace_id(workspace_id)?;
        Ok(self
            .host_root
            .join(SHADOW_DIR_NAME)
            .join(format!("{workspace_id}.git")))
    }

    /// `<hostRoot>/<workspaceId>` (same layout as `storage::resolve_host_path`).
    pub fn work_tree(&self, workspace_id: &str) -> Result<PathBuf> {
        validate_workspace_id(workspace_id)?;
        Ok(self.host_root.join(workspace_id))
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
    pub async fn capture(
        &self,
        workspace_id: &str,
        run_id: &str,
        actor: &str,
        call_id: &str,
        abnormal: bool,
    ) -> Result<CaptureOutcome> {
        validate_run_id(run_id)?;
        let shadow = self.shadow_git_dir(workspace_id)?;
        let work_tree = self.work_tree(workspace_id)?;
        let _guard = self.lock_capture(workspace_id).await;
        self.require_git().await?;
        if !work_tree.is_dir() {
            return Err(CheckpointError::WorkspaceMissing(normalize_path_for_git(
                &work_tree,
            )));
        }
        self.ensure_initialized(&shadow, &work_tree).await?;

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
        self.stage_index(&shadow, &work_tree, &index, &excludes, tail_tree.as_deref())
            .await?;
        let index_env = self.isolated_env(&shadow, &work_tree, Some(&index));
        let tree = self.write_tree(&index_env).await?;
        self.save_last_index(&shadow, &index).await?;
        let opaque_nested_repos = self.staged_gitlinks(&index_env).await?;
        if self.nested_repo_policy == NestedRepoPolicy::Reject && !opaque_nested_repos.is_empty() {
            return Err(CheckpointError::NestedRepoLimit {
                paths: opaque_nested_repos,
            });
        }

        if tail_tree.as_deref() == Some(tree.as_str()) {
            debug!(
                workspace_id,
                run_id,
                predecessor = predecessor.as_deref().unwrap_or("none"),
                "shadow checkpoint capture found no change; no slice written"
            );
            return Ok(CaptureOutcome {
                run_id: run_id.to_string(),
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
            run_id,
            slice_ref = %slice_ref,
            changed = changed_files.len(),
            state,
            "shadow checkpoint slice captured"
        );
        Ok(CaptureOutcome {
            run_id: run_id.to_string(),
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
        let stdout = self
            .run_git_checked(
                &["ls-files", "--others", "--exclude-standard", "-z"],
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
        self.write_excludes_file(excludes, &dynamic).await?;
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
        env.push(("GIT_DIR".to_string(), normalize_path_for_git(shadow)));
        env.push((
            "GIT_WORK_TREE".to_string(),
            normalize_path_for_git(work_tree),
        ));
        env.push(("GIT_ATTR_NOSYSTEM".to_string(), "1".to_string()));
        env.push(("GIT_OPTIONAL_LOCKS".to_string(), "0".to_string()));
        env.push(("GIT_TERMINAL_PROMPT".to_string(), "0".to_string()));
        if let Some(index) = index {
            env.push(("GIT_INDEX_FILE".to_string(), normalize_path_for_git(index)));
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
}
