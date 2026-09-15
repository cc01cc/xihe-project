//! PLAN-0328 M3: revert (rollback) execution engine.
//!
//! Consumes the M2 shadow-git refs ([`crate::checkpoint`]) and restores the changed
//! path set of one sealed run (spec `snapshot-rollback.md` §9, decisions #41/#43/#44):
//!
//! - classification is three-way per atomic target: `current == target → Noop`,
//!   `current == end → Execute`, otherwise `SkipConflict` with the frozen reason code
//!   and the observed file mtime; a rename splits into a delete (old path) plus an add
//!   (new path) item;
//! - execution is per item: restore via `git checkout <base> -- <path>` on a scratch
//!   `GIT_INDEX_FILE`, delete via fs unlink + bottom-up empty-directory cleanup that
//!   stops at the first non-empty directory; paths outside the run's changed set are
//!   never touched and every mutating item is re-classified immediately before it
//!   mutates (closing the plan → execute window);
//! - the engine is idempotent: a repeated execute reports `Noop` for items already at
//!   target, so a retry after a partial failure only re-runs unfinished work;
//! - every execution appends `refs/xihe/<runId>/rollback/<epochMs>` — a commit of the
//!   base tree with the end commit as parent — carrying counts and per-item results,
//!   never file contents.
//!
//! HTTP wiring (PLAN-0328 M3 W1b) lives in [`crate::checkpoint_revert_api`]:
//! [`ShadowGit::revert_preview`] is read-only and takes no lease, while
//! [`ShadowGit::revert_execute`] fails fast with
//! [`RevertError::LeaseHeld`] while another engine operation owns the workspace; the
//! service layer additionally consults the workspace mutation lease before executing.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tracing::{debug, info, warn};

use crate::checkpoint::{
    ChangedFile, CheckpointError, HeadFingerprint, HeadFingerprintStatus, ShadowGit,
    compare_head_fingerprint, sanitize_message_field, validate_run_id, validate_workspace_id,
};

/// Frozen conflict reason code (spec §9.5): the file changed after the run ended.
pub const CONFLICT_CONTENT_CHANGED: &str = "CONTENT_CHANGED";

/// `Unavailable` reason for a missing or failing host git.
pub const REVERT_REASON_GIT_UNAVAILABLE: &str = "GIT_UNAVAILABLE";
/// `Unavailable` reason for a host git below the frozen minimum version.
pub const REVERT_REASON_GIT_TOO_OLD: &str = "GIT_TOO_OLD";
/// `Unavailable` reason for an unknown workspace directory.
pub const REVERT_REASON_WORKSPACE_UNKNOWN: &str = "WORKSPACE_UNKNOWN";

/// Blob read cap for the checkpoint blob endpoint (plain-text previews only).
pub const MAX_BLOB_BYTES: u64 = 1024 * 1024;

/// Maximum pathspec entries per `git diff` call (command-line size safety).
const PATHSPEC_CHUNK: usize = 128;
/// Collision retries for the `rollback/<epochMs>` leaf.
const MAX_ROLLBACK_REF_ATTEMPTS: i64 = 16;

static SCRATCH_COUNTER: AtomicU64 = AtomicU64::new(0);

/// What reverting one atomic target must do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RevertAction {
    /// Write the base-tree content back to the path.
    Restore,
    /// Remove the path (the run created or renamed it).
    Delete,
}

impl RevertAction {
    /// Frozen wire name (`restore` / `delete`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Restore => "restore",
            Self::Delete => "delete",
        }
    }
}

/// Target state of one atomic revert item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RevertTarget {
    /// The path exists in the run's base tree.
    Base,
    /// The path must be absent after the revert.
    Absent,
}

/// Classification of one atomic item against the current worktree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RevertPlanState {
    /// Already at target; no action needed (idempotent replay).
    Noop,
    /// Safe to execute: the worktree still matches the run's end state.
    Execute,
    /// The path changed after the run ended; never overwritten (decision #7).
    Conflict,
}

/// Per-item execution outcome returned by [`ShadowGit::revert_execute`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RevertItemOutcome {
    Restored,
    Deleted,
    SkippedConflict,
    Failed,
    Noop,
}

/// One entry of a [`RevertPreview`] dry-run list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertPlanItem {
    /// Workspace-relative path with forward slashes.
    pub path: String,
    pub action: RevertAction,
    pub target: RevertTarget,
    pub state: RevertPlanState,
    /// Frozen reason code when `state == Conflict`.
    pub reason: Option<String>,
    /// File mtime (Unix milliseconds) observed while classifying a conflict; absent
    /// when the conflict is a path the user deleted.
    pub observed_at: Option<u64>,
}

/// One entry of a [`RevertResult`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertItemResult {
    pub path: String,
    pub action: RevertAction,
    pub outcome: RevertItemOutcome,
    pub reason: Option<String>,
    pub observed_at: Option<u64>,
}

/// Dry-run counts of a [`RevertPreview`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertPreviewCounts {
    pub restore: usize,
    pub delete: usize,
    pub noop: usize,
    pub conflicts: usize,
    pub total: usize,
}

/// Counts of a [`RevertResult`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertResultCounts {
    pub restored: usize,
    pub deleted: usize,
    pub skipped_conflict: usize,
    pub failed: usize,
    pub noop: usize,
    pub total: usize,
}

/// Read-only revert dry-run for one sealed run (spec §9.2/§9.3, decision #46).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertPreview {
    pub workspace_id: String,
    pub run_id: String,
    pub base_commit: String,
    pub end_commit: String,
    /// User HEAD/branch fingerprint status (decision #41 / S2).
    pub head: HeadFingerprintStatus,
    pub items: Vec<RevertPlanItem>,
    pub counts: RevertPreviewCounts,
}

/// Result of one [`ShadowGit::revert_execute`] call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertResult {
    pub workspace_id: String,
    pub run_id: String,
    pub base_commit: String,
    pub end_commit: String,
    pub head: HeadFingerprintStatus,
    pub items: Vec<RevertItemResult>,
    pub counts: RevertResultCounts,
    pub duration_ms: u64,
    /// `refs/xihe/<runId>/rollback/<epochMs>` recorded for this execution; `None`
    /// when the audit ref could not be written (logged as a warning).
    pub rollback_ref: Option<String>,
}

/// Explicit confirmations for [`ShadowGit::revert_execute`] (decision #46).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RevertAcks {
    /// Confirm proceeding although the preview reported a `changed` head fingerprint.
    pub head_changed: bool,
    /// Conflict paths explicitly acknowledged from the preview (workspace-relative).
    pub conflicts: Vec<String>,
}

/// Which run tree a [`ShadowGit::revert_blob`] read targets (`?ref=base|end`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevertBlobRef {
    /// The run's pre-image tree (`refs/xihe/<runId>/base`).
    Base,
    /// The run's post-image tree (`refs/xihe/<runId>/end`, sealed runs only).
    End,
}

impl RevertBlobRef {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Base => "base",
            Self::End => "end",
        }
    }
}

/// One blob read out of a run's base/end tree (plain-text preview payload).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevertBlob {
    pub path: String,
    /// `base` or `end`.
    pub reference: &'static str,
    /// Raw blob bytes; the caller decides the text/binary policy.
    pub content: Vec<u8>,
}

/// Typed revert failures mapped by the endpoint layer
/// ([`crate::checkpoint_revert_api`]) to 400/404/409/413/503.
#[derive(Debug, Error)]
pub enum RevertError {
    #[error("shadow checkpoint run not found: {0}")]
    NotFound(String),

    #[error("shadow checkpoint run is not sealed: {0}")]
    NotSealed(String),

    #[error("workspace head/branch fingerprint changed since the checkpoint base was created")]
    HeadChanged {
        recorded: Option<HeadFingerprint>,
        observed: Option<HeadFingerprint>,
    },

    #[error("conflicts must be acknowledged before revert: {}", paths.join(", "))]
    ConflictsUnacknowledged { paths: Vec<String> },

    #[error("checkpoint revert unavailable [{reason}]: {detail}")]
    Unavailable {
        reason: &'static str,
        detail: String,
    },

    #[error("workspace mutation lease is held by another run")]
    LeaseHeld,

    #[error("checkpoint revert failed: {0}")]
    Failed(String),

    /// Malformed request content: non-normal path or a non-file tree entry.
    #[error("checkpoint revert request rejected: {detail}")]
    InvalidRequest { detail: String },

    /// The requested path does not exist in the run's tree at that ref.
    #[error("path {path} is not present in the run's {reference} tree")]
    PathNotFound {
        reference: &'static str,
        path: String,
    },

    /// The requested blob exceeds the endpoint read cap.
    #[error("checkpoint blob too large [{reference}]: {path} ({size} bytes > {max} bytes)")]
    BlobTooLarge {
        reference: &'static str,
        path: String,
        size: u64,
        max: u64,
    },
}

type Result<T> = std::result::Result<T, RevertError>;

/// One atomic revert target derived from the run's name-status change set.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RevertItem {
    path: String,
    target: RevertTarget,
    base_has_path: bool,
    end_has_path: bool,
}

/// Worktree observation used for the three-way classification.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CurrentState {
    exists: bool,
    /// Current state equals the base-tree state (absent counts as equal when the
    /// base tree does not contain the path).
    equals_base: bool,
    /// Current state equals the end-tree state.
    equals_end: bool,
    mtime_ms: Option<u64>,
}

/// Classification of one item.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ClassifiedItem {
    state: RevertPlanState,
    reason: Option<String>,
    observed_at: Option<u64>,
}

struct PlannedItem {
    item: RevertItem,
    classified: ClassifiedItem,
}

struct FileStat {
    mtime_ms: Option<u64>,
}

/// Per-call scratch `GIT_INDEX_FILE`; removed on drop (never the user index).
struct ScratchIndex {
    path: PathBuf,
}

impl ScratchIndex {
    fn create(shadow: &Path, run_id: &str) -> Self {
        let counter = SCRATCH_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = shadow.join(format!(
            "revert-index.{run_id}.{}.{counter}",
            std::process::id()
        ));
        Self { path }
    }
}

impl Drop for ScratchIndex {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_file(&self.path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            debug!(
                path = %self.path.display(),
                %error,
                "failed to remove revert scratch index"
            );
        }
    }
}

/// Shadow/worktree/env resolution shared by all revert reads, before refs are
/// resolved (blob reads at `base` do not require a sealed `end` ref).
struct RevertContext {
    workspace_id: String,
    run_id: String,
    shadow: PathBuf,
    work_tree: PathBuf,
    env: Vec<(String, String)>,
}

/// One resolved revert target: refs, paths and the isolated git environment.
struct RevertRun {
    workspace_id: String,
    run_id: String,
    shadow: PathBuf,
    work_tree: PathBuf,
    base_commit: String,
    end_commit: String,
    env: Vec<(String, String)>,
}

impl ShadowGit {
    /// Read-only dry-run of reverting one sealed run (spec §9.2–9.3).
    ///
    /// Takes no mutation lease and never writes to the workspace; the only side
    /// effect is a short-lived scratch index inside the shadow repository.
    pub async fn revert_preview(&self, workspace_id: &str, run_id: &str) -> Result<RevertPreview> {
        validate_revert_identifiers(workspace_id, run_id)?;
        let run = self.resolve_revert_run(workspace_id, run_id).await?;
        let head = self.head_fingerprint_status_of(&run).await?.0;
        let planned = self.plan_revert(&run).await?;
        let items: Vec<RevertPlanItem> = planned.iter().map(RevertPlanItem::from_planned).collect();
        let counts = preview_counts(&items);
        Ok(RevertPreview {
            workspace_id: run.workspace_id.clone(),
            run_id: run.run_id.clone(),
            base_commit: run.base_commit.clone(),
            end_commit: run.end_commit.clone(),
            head,
            items,
            counts,
        })
    }

    /// Execute the revert of one sealed run, item by item (spec §9.4).
    ///
    /// `acks` must cover every conflict the plan reports
    /// ([`RevertError::ConflictsUnacknowledged`] otherwise) and any `changed` head
    /// fingerprint ([`RevertError::HeadChanged`] otherwise). Per-item failures are
    /// returned inside the result; only engine-level failures are `Err`.
    pub async fn revert_execute(
        &self,
        workspace_id: &str,
        run_id: &str,
        acks: &RevertAcks,
    ) -> Result<RevertResult> {
        let started = Instant::now();
        validate_revert_identifiers(workspace_id, run_id)?;
        let _guard = self
            .try_lock_workspace(workspace_id)
            .ok_or(RevertError::LeaseHeld)?;
        let run = self.resolve_revert_run(workspace_id, run_id).await?;
        let (head, recorded, observed) = self.head_fingerprint_status_of(&run).await?;
        if head == HeadFingerprintStatus::Changed && !acks.head_changed {
            return Err(RevertError::HeadChanged { recorded, observed });
        }
        let planned = self.plan_revert(&run).await?;
        ensure_conflicts_acknowledged(&planned, acks)?;

        let scratch = ScratchIndex::create(&run.shadow, &run.run_id);
        let mut results = Vec::with_capacity(planned.len());
        for plan in &planned {
            results.push(self.execute_item(&run, plan, &scratch).await?);
        }
        let counts = result_counts(&results);
        let rollback_ref = match self.record_rollback_ref(&run, &results, &counts).await {
            Ok(reference) => Some(reference),
            Err(error) => {
                warn!(
                    workspace_id,
                    run_id,
                    error = %error,
                    "failed to record revert rollback ref (audit gap; per-item results are authoritative)"
                );
                None
            }
        };
        info!(
            workspace_id,
            run_id,
            restored = counts.restored,
            deleted = counts.deleted,
            skipped_conflict = counts.skipped_conflict,
            failed = counts.failed,
            noop = counts.noop,
            "run revert executed"
        );
        Ok(RevertResult {
            workspace_id: run.workspace_id.clone(),
            run_id: run.run_id.clone(),
            base_commit: run.base_commit.clone(),
            end_commit: run.end_commit.clone(),
            head,
            items: results,
            counts,
            duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            rollback_ref,
        })
    }

    /// HEAD/branch fingerprint comparison for one run (decision #41 / S2).
    ///
    /// `ok` when the recorded and current fingerprints are identical, `changed`
    /// when HEAD, the branch or repository presence moved, `unknown` for legacy
    /// bases whose message predates the fingerprint, `not_repo` when the workspace
    /// has no user `.git`.
    pub async fn head_fingerprint_status(
        &self,
        workspace_id: &str,
        run_id: &str,
    ) -> Result<HeadFingerprintStatus> {
        Ok(self.head_fingerprint_details(workspace_id, run_id).await?.0)
    }

    /// HEAD/branch fingerprint comparison with the compared values (preview contract).
    ///
    /// Returns `(status, recorded, current)`; the status is the frozen vocabulary
    /// documented on [`Self::head_fingerprint_status`].
    pub async fn head_fingerprint_details(
        &self,
        workspace_id: &str,
        run_id: &str,
    ) -> Result<(
        HeadFingerprintStatus,
        Option<HeadFingerprint>,
        Option<HeadFingerprint>,
    )> {
        validate_revert_identifiers(workspace_id, run_id)?;
        let run = self.resolve_revert_run(workspace_id, run_id).await?;
        self.head_fingerprint_status_of(&run).await
    }

    /// Read one blob out of a run's base/end tree (checkpoint blob endpoint).
    ///
    /// The path must be workspace-relative and normal, and must name a regular file
    /// in that tree; blobs above `max_bytes` are rejected before any content is
    /// read. `base` works for any run with a base ref, `end` only for sealed runs.
    pub async fn revert_blob(
        &self,
        workspace_id: &str,
        run_id: &str,
        reference: RevertBlobRef,
        path: &str,
        max_bytes: u64,
    ) -> Result<RevertBlob> {
        validate_revert_identifiers(workspace_id, run_id)?;
        validate_relative_path(path).map_err(|detail| RevertError::InvalidRequest { detail })?;
        let context = self.resolve_revert_context(workspace_id, run_id).await?;
        let base = self
            .rev_parse(&context.env, &format!("refs/xihe/{run_id}/base"))
            .await
            .map_err(revert_git_failure)?;
        let Some(base_commit) = base else {
            return Err(RevertError::NotFound(run_id.to_string()));
        };
        let commit = match reference {
            RevertBlobRef::Base => base_commit,
            RevertBlobRef::End => {
                let end = self
                    .rev_parse(&context.env, &format!("refs/xihe/{run_id}/end"))
                    .await
                    .map_err(revert_git_failure)?;
                match end {
                    Some(end_commit) => end_commit,
                    None => return Err(RevertError::NotSealed(run_id.to_string())),
                }
            }
        };
        let spec = literal_pathspec(path);
        let listing = self
            .run_git_checked(
                &["ls-tree", "-l", "-z", &commit, "--", spec.as_str()],
                &context.env,
                None,
                self.call_timeout,
            )
            .await
            .map_err(revert_git_failure)?;
        let entry = parse_tree_entry(&listing, reference, path)?;
        if entry.size > max_bytes {
            return Err(RevertError::BlobTooLarge {
                reference: reference.as_str(),
                path: path.to_string(),
                size: entry.size,
                max: max_bytes,
            });
        }
        let content = self
            .run_git_checked(
                &["cat-file", "blob", &entry.oid],
                &context.env,
                None,
                self.call_timeout,
            )
            .await
            .map_err(revert_git_failure)?;
        Ok(RevertBlob {
            path: path.to_string(),
            reference: reference.as_str(),
            content,
        })
    }

    async fn resolve_revert_run(&self, workspace_id: &str, run_id: &str) -> Result<RevertRun> {
        let context = self.resolve_revert_context(workspace_id, run_id).await?;
        let base = self
            .rev_parse(&context.env, &format!("refs/xihe/{run_id}/base"))
            .await
            .map_err(revert_git_failure)?;
        let Some(base_commit) = base else {
            return Err(RevertError::NotFound(run_id.to_string()));
        };
        let end = self
            .rev_parse(&context.env, &format!("refs/xihe/{run_id}/end"))
            .await
            .map_err(revert_git_failure)?;
        let Some(end_commit) = end else {
            return Err(RevertError::NotSealed(run_id.to_string()));
        };
        Ok(RevertRun {
            workspace_id: context.workspace_id,
            run_id: context.run_id,
            shadow: context.shadow,
            work_tree: context.work_tree,
            base_commit,
            end_commit,
            env: context.env,
        })
    }

    /// Git availability, workspace directory and shadow resolution shared by every
    /// revert read (refs are resolved by each caller against `context.env`).
    async fn resolve_revert_context(
        &self,
        workspace_id: &str,
        run_id: &str,
    ) -> Result<RevertContext> {
        let capability = self.probe().await;
        if !capability.available {
            return Err(RevertError::Unavailable {
                reason: git_unavailable_reason(&capability.version),
                detail: capability.detail,
            });
        }
        let work_tree = self.work_tree(workspace_id).map_err(revert_git_failure)?;
        if !work_tree.is_dir() {
            return Err(RevertError::Unavailable {
                reason: REVERT_REASON_WORKSPACE_UNKNOWN,
                detail: format!(
                    "workspace directory does not exist: {}",
                    normalize_for_message(&work_tree)
                ),
            });
        }
        let shadow = self
            .shadow_git_dir(workspace_id)
            .map_err(revert_git_failure)?;
        if !shadow.is_dir() {
            return Err(RevertError::NotFound(run_id.to_string()));
        }
        let env = self.isolated_env(&shadow, &work_tree, None);
        Ok(RevertContext {
            workspace_id: workspace_id.to_string(),
            run_id: run_id.to_string(),
            shadow,
            work_tree,
            env,
        })
    }

    /// `(status, recorded, observed)`; an unreadable HEAD with a recorded
    /// fingerprint fails closed as `changed`.
    async fn head_fingerprint_status_of(
        &self,
        run: &RevertRun,
    ) -> Result<(
        HeadFingerprintStatus,
        Option<HeadFingerprint>,
        Option<HeadFingerprint>,
    )> {
        let recorded = self
            .base_head_fingerprint(&run.env, &run.base_commit)
            .await
            .map_err(revert_git_failure)?;
        let observed = self.read_workspace_head(&run.work_tree).await;
        let status = match (&recorded, &observed) {
            (None, _) => HeadFingerprintStatus::Unknown,
            (Some(_), None) => HeadFingerprintStatus::Changed,
            (Some(recorded), Some(observed)) => compare_head_fingerprint(Some(recorded), observed),
        };
        Ok((status, recorded, observed))
    }

    /// Batched three-way classification of the whole changed set (one diff call per
    /// tree, chunked pathspecs).
    async fn plan_revert(&self, run: &RevertRun) -> Result<Vec<PlannedItem>> {
        let changed = self
            .changed_files_for(&run.env, &run.base_commit, &run.end_commit)
            .await
            .map_err(revert_git_failure)?;
        let items = atomic_items(&changed);
        if items.is_empty() {
            return Ok(Vec::new());
        }
        let paths: Vec<&str> = items.iter().map(|item| item.path.as_str()).collect();
        let scratch = ScratchIndex::create(&run.shadow, &run.run_id);
        let differs_base = self
            .differing_paths(run, &run.base_commit, &paths, &scratch)
            .await?;
        let differs_end = self
            .differing_paths(run, &run.end_commit, &paths, &scratch)
            .await?;
        let mut planned = Vec::with_capacity(items.len());
        for item in items {
            let stat = stat_worktree_path(&run.work_tree, &item.path)
                .await
                .map_err(RevertError::Failed)?;
            let current = current_state(
                &item,
                stat.as_ref(),
                differs_base.contains(&item.path),
                differs_end.contains(&item.path),
            );
            planned.push(PlannedItem {
                classified: classify_item(&item, &current),
                item,
            });
        }
        Ok(planned)
    }

    /// Execute one planned item, re-checking mutating items right before the write.
    async fn execute_item(
        &self,
        run: &RevertRun,
        plan: &PlannedItem,
        scratch: &ScratchIndex,
    ) -> Result<RevertItemResult> {
        let result = |outcome: RevertItemOutcome,
                      reason: Option<String>,
                      observed_at: Option<u64>| RevertItemResult {
            path: plan.item.path.clone(),
            action: plan.item.target.action(),
            outcome,
            reason,
            observed_at,
        };
        if plan.classified.state != RevertPlanState::Execute {
            // No mutation: a planned Noop/Conflict needs no window re-check.
            return Ok(match plan.classified.state {
                RevertPlanState::Noop => result(RevertItemOutcome::Noop, None, None),
                _ => result(
                    RevertItemOutcome::SkippedConflict,
                    plan.classified.reason.clone(),
                    plan.classified.observed_at,
                ),
            });
        }
        // Immediate per-item re-check: close the window between plan and mutation.
        let fresh = self.classify_single_item(run, &plan.item, scratch).await?;
        match fresh.state {
            RevertPlanState::Noop => Ok(result(RevertItemOutcome::Noop, None, None)),
            RevertPlanState::Conflict => Ok(result(
                RevertItemOutcome::SkippedConflict,
                fresh.reason.clone(),
                fresh.observed_at,
            )),
            RevertPlanState::Execute => {
                let mutation = match plan.item.target {
                    RevertTarget::Base => self.restore_path(run, &plan.item.path, scratch).await,
                    RevertTarget::Absent => self.delete_path(run, &plan.item.path).await,
                };
                match (mutation, plan.item.target) {
                    (Ok(()), RevertTarget::Base) => {
                        Ok(result(RevertItemOutcome::Restored, None, None))
                    }
                    (Ok(()), RevertTarget::Absent) => {
                        Ok(result(RevertItemOutcome::Deleted, None, None))
                    }
                    (Err(detail), _) => Ok(result(RevertItemOutcome::Failed, Some(detail), None)),
                }
            }
        }
    }

    /// Fresh single-item classification (three-way state for one path only).
    async fn classify_single_item(
        &self,
        run: &RevertRun,
        item: &RevertItem,
        scratch: &ScratchIndex,
    ) -> Result<ClassifiedItem> {
        let stat = stat_worktree_path(&run.work_tree, &item.path)
            .await
            .map_err(RevertError::Failed)?;
        let differs_base = if item.base_has_path {
            self.path_differs(run, &run.base_commit, &item.path, scratch)
                .await?
        } else {
            false
        };
        let differs_end = if item.end_has_path {
            self.path_differs(run, &run.end_commit, &item.path, scratch)
                .await?
        } else {
            false
        };
        let current = current_state(item, stat.as_ref(), differs_base, differs_end);
        Ok(classify_item(item, &current))
    }

    /// `true` when the worktree path differs from the tree's blob (index-vs-worktree
    /// diff after `read-tree <tree>`); untracked-in-tree paths are the caller's
    /// existence check.
    async fn path_differs(
        &self,
        run: &RevertRun,
        tree: &str,
        path: &str,
        scratch: &ScratchIndex,
    ) -> Result<bool> {
        let paths = [path];
        Ok(self
            .differing_paths(run, tree, &paths, scratch)
            .await?
            .contains(path))
    }

    /// Paths that differ from `tree`, computed with one `read-tree` plus chunked
    /// `diff --name-only` calls on the scratch index.
    async fn differing_paths(
        &self,
        run: &RevertRun,
        tree: &str,
        paths: &[&str],
        scratch: &ScratchIndex,
    ) -> Result<HashSet<String>> {
        let env = self.isolated_env(&run.shadow, &run.work_tree, Some(&scratch.path));
        self.run_git_checked(&["read-tree", tree], &env, None, self.call_timeout)
            .await
            .map_err(revert_git_failure)?;
        let mut differing = HashSet::new();
        for chunk in paths.chunks(PATHSPEC_CHUNK) {
            let specs: Vec<String> = chunk.iter().map(|path| literal_pathspec(path)).collect();
            let mut args: Vec<&str> = vec!["diff", "--no-renames", "--name-only", "-z", "--"];
            args.extend(specs.iter().map(String::as_str));
            let stdout = self
                .run_git_checked(&args, &env, Some(&run.work_tree), self.call_timeout)
                .await
                .map_err(revert_git_failure)?;
            for raw in stdout.split(|byte| *byte == 0) {
                if !raw.is_empty() {
                    differing.insert(String::from_utf8_lossy(raw).into_owned());
                }
            }
        }
        Ok(differing)
    }

    /// Restore one path from the run's base tree with a scratch index.
    async fn restore_path(
        &self,
        run: &RevertRun,
        path: &str,
        scratch: &ScratchIndex,
    ) -> std::result::Result<(), String> {
        validate_relative_path(path)?;
        let env = self.isolated_env(&run.shadow, &run.work_tree, Some(&scratch.path));
        let spec = literal_pathspec(path);
        let args = ["checkout", run.base_commit.as_str(), "--", spec.as_str()];
        self.run_git_checked(&args, &env, Some(&run.work_tree), self.call_timeout)
            .await
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// Delete one run-created path (fs unlink) and prune directories it left empty.
    async fn delete_path(&self, run: &RevertRun, path: &str) -> std::result::Result<(), String> {
        let absolute = join_worktree_path(&run.work_tree, path)?;
        tokio::fs::remove_file(&absolute)
            .await
            .map_err(|error| format!("failed to delete {path}: {error}"))?;
        prune_empty_dirs(&run.work_tree, path).await;
        Ok(())
    }

    /// Append the audit ref for this execution: `commit-tree` of the base tree with
    /// the end commit as parent; the message carries counts and per-item results.
    async fn record_rollback_ref(
        &self,
        run: &RevertRun,
        results: &[RevertItemResult],
        counts: &RevertResultCounts,
    ) -> std::result::Result<String, CheckpointError> {
        let tree = self
            .rev_parse(&run.env, &format!("{}^{{tree}}", run.base_commit))
            .await?
            .ok_or_else(|| CheckpointError::GitCommand {
                command: "rev-parse".to_string(),
                detail: format!("base tree missing for run {}", run.run_id),
            })?;
        let epoch_ms = wall_clock_ms();
        let mut reference = None;
        for offset in 0..MAX_ROLLBACK_REF_ATTEMPTS {
            let candidate = format!("refs/xihe/{}/rollback/{}", run.run_id, epoch_ms + offset);
            if self.rev_parse(&run.env, &candidate).await?.is_none() {
                reference = Some(candidate);
                break;
            }
        }
        let reference = reference.ok_or_else(|| CheckpointError::GitCommand {
            command: "update-ref".to_string(),
            detail: format!("rollback ref name space exhausted for run {}", run.run_id),
        })?;
        let message = rollback_message(&run.run_id, &reference, counts, results);
        let commit = self
            .commit_tree(&run.env, &tree, Some(&run.end_commit), &message)
            .await?;
        self.update_ref(&run.env, &reference, &commit).await?;
        Ok(reference)
    }
}

/// Flatten the name-status change set into atomic targets: `M`/`D`/rename-old
/// restore base content, `A`/rename-new must become absent (spec §9.3).
fn atomic_items(changed: &[ChangedFile]) -> Vec<RevertItem> {
    let mut items: Vec<RevertItem> = Vec::with_capacity(changed.len());
    let mut seen: HashSet<String> = HashSet::new();
    let push = |items: &mut Vec<RevertItem>, seen: &mut HashSet<String>, item: RevertItem| {
        if !seen.insert(item.path.clone()) {
            debug!(path = %item.path, "duplicate revert target ignored");
            return;
        }
        items.push(item);
    };
    for file in changed {
        let class = file.status.chars().next().unwrap_or('?');
        match class {
            'R' | 'C' => {
                if let Some(old_path) = &file.old_path {
                    push(
                        &mut items,
                        &mut seen,
                        RevertItem {
                            path: old_path.clone(),
                            target: RevertTarget::Base,
                            base_has_path: true,
                            end_has_path: false,
                        },
                    );
                }
                push(
                    &mut items,
                    &mut seen,
                    RevertItem {
                        path: file.path.clone(),
                        target: RevertTarget::Absent,
                        base_has_path: false,
                        end_has_path: true,
                    },
                );
            }
            'A' => push(
                &mut items,
                &mut seen,
                RevertItem {
                    path: file.path.clone(),
                    target: RevertTarget::Absent,
                    base_has_path: false,
                    end_has_path: true,
                },
            ),
            'D' => push(
                &mut items,
                &mut seen,
                RevertItem {
                    path: file.path.clone(),
                    target: RevertTarget::Base,
                    base_has_path: true,
                    end_has_path: false,
                },
            ),
            // `M`, `T` (typechange) and any unknown class: the path stays in place and
            // is restored from base. Unknown classes never delete or invent paths.
            _ => push(
                &mut items,
                &mut seen,
                RevertItem {
                    path: file.path.clone(),
                    target: RevertTarget::Base,
                    base_has_path: true,
                    end_has_path: true,
                },
            ),
        }
    }
    items
}

/// Three-way classification (frozen algorithm): target → `Noop`, end → `Execute`,
/// anything else → `Conflict` with the observed mtime.
fn classify_item(item: &RevertItem, current: &CurrentState) -> ClassifiedItem {
    let matches_target = match item.target {
        RevertTarget::Base => current.equals_base,
        RevertTarget::Absent => !current.exists,
    };
    if matches_target {
        ClassifiedItem {
            state: RevertPlanState::Noop,
            reason: None,
            observed_at: None,
        }
    } else if current.equals_end {
        ClassifiedItem {
            state: RevertPlanState::Execute,
            reason: None,
            observed_at: None,
        }
    } else {
        ClassifiedItem {
            state: RevertPlanState::Conflict,
            reason: Some(CONFLICT_CONTENT_CHANGED.to_string()),
            observed_at: current.mtime_ms,
        }
    }
}

fn current_state(
    item: &RevertItem,
    stat: Option<&FileStat>,
    differs_base: bool,
    differs_end: bool,
) -> CurrentState {
    let exists = stat.is_some();
    CurrentState {
        exists,
        equals_base: if item.base_has_path {
            !differs_base
        } else {
            !exists
        },
        equals_end: if item.end_has_path {
            !differs_end
        } else {
            !exists
        },
        mtime_ms: stat.and_then(|stat| stat.mtime_ms),
    }
}

async fn stat_worktree_path(
    work_tree: &Path,
    relative: &str,
) -> std::result::Result<Option<FileStat>, String> {
    let absolute = join_worktree_path(work_tree, relative)?;
    match tokio::fs::symlink_metadata(&absolute).await {
        Ok(metadata) => Ok(Some(FileStat {
            mtime_ms: metadata.modified().ok().and_then(system_time_ms),
        })),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("failed to stat {relative}: {error}")),
    }
}

/// Remove the file's parent directories bottom-up while they are empty; the first
/// directory that cannot be removed (non-empty, permission, workspace root) stops
/// the walk. Never removes the workspace root itself.
async fn prune_empty_dirs(work_tree: &Path, relative_file: &str) {
    let Some(parent) = Path::new(relative_file).parent() else {
        return;
    };
    let mut current = work_tree.to_path_buf();
    for component in parent.components() {
        current.push(component.as_os_str());
    }
    while current != work_tree && current.starts_with(work_tree) {
        if tokio::fs::remove_dir(&current).await.is_err() {
            return;
        }
        if !current.pop() {
            return;
        }
    }
}

fn preview_counts(items: &[RevertPlanItem]) -> RevertPreviewCounts {
    let mut counts = RevertPreviewCounts::default();
    for item in items {
        match item.state {
            RevertPlanState::Execute => match item.action {
                RevertAction::Restore => counts.restore += 1,
                RevertAction::Delete => counts.delete += 1,
            },
            RevertPlanState::Noop => counts.noop += 1,
            RevertPlanState::Conflict => counts.conflicts += 1,
        }
    }
    counts.total = items.len();
    counts
}

fn result_counts(results: &[RevertItemResult]) -> RevertResultCounts {
    let mut counts = RevertResultCounts::default();
    for result in results {
        match result.outcome {
            RevertItemOutcome::Restored => counts.restored += 1,
            RevertItemOutcome::Deleted => counts.deleted += 1,
            RevertItemOutcome::SkippedConflict => counts.skipped_conflict += 1,
            RevertItemOutcome::Failed => counts.failed += 1,
            RevertItemOutcome::Noop => counts.noop += 1,
        }
    }
    counts.total = results.len();
    counts
}

fn ensure_conflicts_acknowledged(planned: &[PlannedItem], acks: &RevertAcks) -> Result<()> {
    let acknowledged: HashSet<String> = acks
        .conflicts
        .iter()
        .map(|path| normalize_ack_path(path))
        .collect();
    let mut unacknowledged = Vec::new();
    for plan in planned {
        if plan.classified.state == RevertPlanState::Conflict
            && !acknowledged.contains(&plan.item.path)
        {
            unacknowledged.push(plan.item.path.clone());
        }
    }
    if unacknowledged.is_empty() {
        Ok(())
    } else {
        Err(RevertError::ConflictsUnacknowledged {
            paths: unacknowledged,
        })
    }
}

/// Acknowledge paths may arrive with Windows separators or a `./` prefix.
fn normalize_ack_path(path: &str) -> String {
    let trimmed = path.trim().replace('\\', "/");
    trimmed.strip_prefix("./").unwrap_or(&trimmed).to_string()
}

/// Message of a rollback ref: counts plus per-item results, never file contents.
fn rollback_message(
    run_id: &str,
    reference: &str,
    counts: &RevertResultCounts,
    results: &[RevertItemResult],
) -> String {
    let leaf = reference.rsplit('/').next().unwrap_or("0");
    let mut message = format!(
        "run/{run_id} rollback/{leaf}\n\nrestored: {}\ndeleted: {}\nskipped-conflict: {}\nfailed: {}\nnoop: {}\ntotal: {}\n\n",
        counts.restored,
        counts.deleted,
        counts.skipped_conflict,
        counts.failed,
        counts.noop,
        counts.total
    );
    for result in results {
        let label = match result.outcome {
            RevertItemOutcome::Restored => "restored",
            RevertItemOutcome::Deleted => "deleted",
            RevertItemOutcome::SkippedConflict => "skipped-conflict",
            RevertItemOutcome::Failed => "failed",
            RevertItemOutcome::Noop => "noop",
        };
        message.push_str(label);
        message.push(' ');
        message.push_str(&sanitize_message_field(&result.path));
        if result.outcome == RevertItemOutcome::SkippedConflict
            && let Some(reason) = &result.reason
        {
            message.push(' ');
            message.push_str(&sanitize_message_field(reason));
        }
        message.push('\n');
    }
    message
}

impl RevertPlanItem {
    fn from_planned(planned: &PlannedItem) -> Self {
        Self {
            path: planned.item.path.clone(),
            action: planned.item.target.action(),
            target: planned.item.target,
            state: planned.classified.state,
            reason: planned.classified.reason.clone(),
            observed_at: planned.classified.observed_at,
        }
    }
}

impl RevertTarget {
    fn action(self) -> RevertAction {
        match self {
            RevertTarget::Base => RevertAction::Restore,
            RevertTarget::Absent => RevertAction::Delete,
        }
    }
}

fn validate_revert_identifiers(workspace_id: &str, run_id: &str) -> Result<()> {
    validate_workspace_id(workspace_id)
        .map_err(|error| RevertError::NotFound(error.to_string()))?;
    validate_run_id(run_id).map_err(|error| RevertError::NotFound(error.to_string()))?;
    Ok(())
}

/// Reject absolute paths, drive prefixes, backslashes, empty segments and `.`/`..`
/// before any fs or pathspec use (defence in depth: paths come from the shadow diff,
/// which never emits them).
fn validate_relative_path(path: &str) -> std::result::Result<(), String> {
    if path.is_empty() {
        return Err("empty revert path rejected".to_string());
    }
    if path.contains('\\') {
        return Err(format!("backslash in revert path rejected: {path:?}"));
    }
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        return Err(format!("absolute revert path rejected: {path}"));
    }
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(format!(
                "non-normal path segment {segment:?} rejected in revert path {path:?}"
            ));
        }
    }
    for component in candidate.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(format!(
                "non-normal path component {component:?} rejected in revert path {path:?}"
            ));
        }
    }
    Ok(())
}

fn join_worktree_path(work_tree: &Path, relative: &str) -> std::result::Result<PathBuf, String> {
    validate_relative_path(relative)?;
    Ok(work_tree.join(Path::new(relative)))
}

/// `:(literal)` disables glob interpretation so `[`, `*` or spaces in a path cannot
/// widen a pathspec.
fn literal_pathspec(path: &str) -> String {
    format!(":(literal){path}")
}

/// One `git ls-tree -l` entry reduced to what a blob read needs.
struct TreeEntry {
    oid: String,
    size: u64,
}

/// Parse the single `git ls-tree -l -z <commit> -- :(literal)<path>` record.
///
/// A missing record is [`RevertError::PathNotFound`]; a record whose listed path is
/// not the requested one (a directory pathspec expands to its children) or whose
/// entry is not a regular file (tree, symlink, gitlink) is
/// [`RevertError::InvalidRequest`].
fn parse_tree_entry(listing: &[u8], reference: RevertBlobRef, path: &str) -> Result<TreeEntry> {
    let field = listing
        .split(|byte| *byte == 0)
        .find(|field| !field.is_empty());
    let Some(field) = field else {
        return Err(RevertError::PathNotFound {
            reference: reference.as_str(),
            path: path.to_string(),
        });
    };
    // Entry format: `<mode> <type> <oid> <size>\t<path>` (size is `-` for trees).
    let Some(tab) = field.iter().position(|byte| *byte == b'\t') else {
        return Err(RevertError::InvalidRequest {
            detail: format!("unparsable tree entry for {path}"),
        });
    };
    let (header, listed_path) = (&field[..tab], &field[tab + 1..]);
    if listed_path != path.as_bytes() {
        return Err(RevertError::InvalidRequest {
            detail: format!(
                "{path} is not a file in the run's {} tree",
                reference.as_str()
            ),
        });
    }
    let header = String::from_utf8_lossy(header);
    let mut parts = header.split_whitespace();
    let mode = parts.next().unwrap_or_default();
    let kind = parts.next().unwrap_or_default();
    let oid = parts.next().unwrap_or_default().to_string();
    if kind != "blob" || !(mode == "100644" || mode == "100755") {
        return Err(RevertError::InvalidRequest {
            detail: format!("unsupported tree entry ({mode} {kind}) at {path}"),
        });
    }
    let size = parts
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| RevertError::InvalidRequest {
            detail: format!("missing blob size for {path}"),
        })?;
    Ok(TreeEntry { oid, size })
}

fn system_time_ms(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
}

fn wall_clock_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn git_unavailable_reason(version: &Option<String>) -> &'static str {
    if version.is_some() {
        REVERT_REASON_GIT_TOO_OLD
    } else {
        REVERT_REASON_GIT_UNAVAILABLE
    }
}

fn revert_git_failure(error: CheckpointError) -> RevertError {
    match error {
        CheckpointError::RunNotFound(run_id) => RevertError::NotFound(run_id),
        CheckpointError::NotSealed(run_id) => RevertError::NotSealed(run_id),
        CheckpointError::GitUnavailable(detail) => RevertError::Unavailable {
            reason: REVERT_REASON_GIT_UNAVAILABLE,
            detail,
        },
        CheckpointError::WorkspaceMissing(detail) => RevertError::Unavailable {
            reason: REVERT_REASON_WORKSPACE_UNKNOWN,
            detail,
        },
        CheckpointError::InvalidIdentifier {
            kind,
            value,
            detail,
        } => RevertError::NotFound(format!("invalid {kind} {value:?}: {detail}")),
        other => RevertError::Failed(other.to_string()),
    }
}

fn normalize_for_message(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const WS: &str = "ws1";

    struct Fixture {
        temp: TempDir,
        engine: ShadowGit,
    }

    impl Fixture {
        async fn new() -> Self {
            let temp = TempDir::new().expect("fixture tempdir");
            std::fs::create_dir_all(temp.path().join(WS)).expect("fixture workspace dir");
            let engine = ShadowGit::new(temp.path());
            let capability = engine.probe().await;
            assert!(
                capability.available,
                "M3 revert tests require a real host git >= 2.20 (spec §6.0): {capability:?}"
            );
            Self { temp, engine }
        }

        fn root(&self) -> &Path {
            self.temp.path()
        }

        fn ws(&self) -> PathBuf {
            self.root().join(WS)
        }

        fn write(&self, relative: &str, content: &str) {
            let absolute = self.ws().join(relative);
            if let Some(parent) = absolute.parent() {
                std::fs::create_dir_all(parent).expect("fixture dirs");
            }
            std::fs::write(&absolute, content).expect("fixture write");
        }

        fn read(&self, relative: &str) -> String {
            std::fs::read_to_string(self.ws().join(relative)).expect("fixture read")
        }

        fn exists(&self, relative: &str) -> bool {
            self.ws().join(relative).exists()
        }

        fn remove(&self, relative: &str) {
            std::fs::remove_file(self.ws().join(relative)).expect("fixture remove");
        }

        fn rename(&self, from: &str, to: &str) {
            std::fs::rename(self.ws().join(from), self.ws().join(to)).expect("fixture rename");
        }

        fn mtime_ms(&self, relative: &str) -> u64 {
            let metadata = std::fs::metadata(self.ws().join(relative)).expect("fixture metadata");
            metadata
                .modified()
                .expect("fixture mtime")
                .duration_since(UNIX_EPOCH)
                .expect("mtime after epoch")
                .as_millis() as u64
        }

        async fn create_base(&self, run_id: &str) {
            self.engine
                .create_base(WS, run_id, "fixture", "call-fixture")
                .await
                .expect("fixture create base");
        }

        async fn seal(&self, run_id: &str) {
            self.engine.seal(WS, run_id).await.expect("fixture seal");
        }

        fn shadow_env(&self) -> Vec<(String, String)> {
            let shadow = self.engine.shadow_git_dir(WS).expect("fixture shadow dir");
            self.engine.isolated_env(&shadow, &self.ws(), None)
        }

        async fn git(&self, args: &[&str]) -> String {
            let stdout = self
                .engine
                .run_git_checked(args, &self.shadow_env(), None, self.engine.call_timeout)
                .await
                .expect("fixture git command");
            String::from_utf8_lossy(&stdout).into_owned()
        }

        async fn refs(&self, prefix: &str) -> Vec<String> {
            self.git(&["for-each-ref", "--format=%(refname)", prefix])
                .await
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect()
        }

        async fn ref_commit(&self, name: &str) -> String {
            self.git(&["rev-parse", name]).await.trim().to_string()
        }
    }

    fn null_device_for_tests() -> &'static str {
        #[cfg(windows)]
        {
            "NUL"
        }
        #[cfg(not(windows))]
        {
            "/dev/null"
        }
    }

    fn git_in(dir: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", null_device_for_tests())
            .env("GIT_CONFIG_SYSTEM", null_device_for_tests())
            .env("GIT_AUTHOR_NAME", "fixture-user")
            .env("GIT_AUTHOR_EMAIL", "fixture@example.com")
            .env("GIT_COMMITTER_NAME", "fixture-user")
            .env("GIT_COMMITTER_EMAIL", "fixture@example.com")
            .output()
            .expect("spawn fixture git");
        assert!(
            output.status.success(),
            "git {args:?} failed in {}: {}",
            dir.display(),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn changed(status: &str, path: &str, old_path: Option<&str>) -> ChangedFile {
        ChangedFile {
            status: status.to_string(),
            path: path.to_string(),
            old_path: old_path.map(str::to_string),
        }
    }

    #[test]
    fn checkpoint_revert_atomic_items_split_renames_and_keep_unknown_classes_in_place() {
        let change_set = vec![
            changed("M", "m.txt", None),
            changed("A", "a.txt", None),
            changed("D", "d.txt", None),
            changed("R100", "new.txt", Some("old.txt")),
            changed("C75", "copy.txt", Some("src.txt")),
            changed("T", "type.txt", None),
        ];
        let items = atomic_items(&change_set);
        let summary: Vec<(&str, RevertTarget, bool, bool)> = items
            .iter()
            .map(|item| {
                (
                    item.path.as_str(),
                    item.target,
                    item.base_has_path,
                    item.end_has_path,
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                ("m.txt", RevertTarget::Base, true, true),
                ("a.txt", RevertTarget::Absent, false, true),
                ("d.txt", RevertTarget::Base, true, false),
                ("old.txt", RevertTarget::Base, true, false),
                ("new.txt", RevertTarget::Absent, false, true),
                ("src.txt", RevertTarget::Base, true, false),
                ("copy.txt", RevertTarget::Absent, false, true),
                ("type.txt", RevertTarget::Base, true, true),
            ]
        );
        assert!(atomic_items(&[]).is_empty());
    }

    #[test]
    fn checkpoint_revert_classification_matrix_is_three_way_for_m_d_a_and_rename_halves() {
        let change_set = vec![
            changed("M", "m.txt", None),
            changed("D", "d.txt", None),
            changed("A", "a.txt", None),
            changed("R100", "r_new.txt", Some("r_old.txt")),
        ];
        let items = atomic_items(&change_set);
        let noop = ClassifiedItem {
            state: RevertPlanState::Noop,
            reason: None,
            observed_at: None,
        };
        let execute = ClassifiedItem {
            state: RevertPlanState::Execute,
            reason: None,
            observed_at: None,
        };
        let conflict_ts = Some(1_700_000_123_456_u64);
        let conflict = |mtime: Option<u64>| ClassifiedItem {
            state: RevertPlanState::Conflict,
            reason: Some(CONFLICT_CONTENT_CHANGED.to_string()),
            observed_at: mtime,
        };

        for item in &items {
            // current == target
            let at_target = CurrentState {
                exists: item.target == RevertTarget::Base,
                equals_base: true,
                equals_end: false,
                mtime_ms: None,
            };
            assert_eq!(
                classify_item(item, &at_target),
                noop,
                "{} must be Noop at target",
                item.path
            );
            // current == end
            let at_end = CurrentState {
                exists: item.end_has_path,
                equals_base: false,
                equals_end: true,
                mtime_ms: Some(7),
            };
            assert_eq!(
                classify_item(item, &at_end),
                execute,
                "{} must Execute at end",
                item.path
            );
            // current == other (user/editor changed it after the run)
            let other = CurrentState {
                exists: true,
                equals_base: false,
                equals_end: false,
                mtime_ms: conflict_ts,
            };
            assert_eq!(
                classify_item(item, &other),
                conflict(conflict_ts),
                "{} must SkipConflict when it differs from both sides",
                item.path
            );
        }

        // An "other" state where the user deleted the modified path: conflict without
        // an observed mtime.
        let deleted_after_run = CurrentState {
            exists: false,
            equals_base: false,
            equals_end: false,
            mtime_ms: None,
        };
        assert_eq!(classify_item(&items[0], &deleted_after_run), conflict(None));
    }

    #[test]
    fn checkpoint_revert_conflict_gate_requires_exact_acknowledged_paths() {
        let item = |path: &str, state: RevertPlanState| PlannedItem {
            item: RevertItem {
                path: path.to_string(),
                target: RevertTarget::Base,
                base_has_path: true,
                end_has_path: true,
            },
            classified: ClassifiedItem {
                state,
                reason: (state == RevertPlanState::Conflict)
                    .then(|| CONFLICT_CONTENT_CHANGED.to_string()),
                observed_at: None,
            },
        };
        let planned = vec![
            item("a/b.txt", RevertPlanState::Conflict),
            item("ok.txt", RevertPlanState::Execute),
        ];
        match ensure_conflicts_acknowledged(&planned, &RevertAcks::default()) {
            Err(RevertError::ConflictsUnacknowledged { paths }) => {
                assert_eq!(paths, vec!["a/b.txt".to_string()]);
            }
            other => panic!("expected ConflictsUnacknowledged, got {other:?}"),
        }
        // Windows separators and `./` prefixes are normalized before matching.
        let acks = RevertAcks {
            head_changed: false,
            conflicts: vec!["./a\\b.txt".to_string()],
        };
        assert!(ensure_conflicts_acknowledged(&planned, &acks).is_ok());
        // Acknowledging unrelated paths does not satisfy the gate.
        let acks = RevertAcks {
            head_changed: false,
            conflicts: vec!["other.txt".to_string()],
        };
        assert!(matches!(
            ensure_conflicts_acknowledged(&planned, &acks),
            Err(RevertError::ConflictsUnacknowledged { .. })
        ));
    }

    #[test]
    fn checkpoint_revert_path_validation_and_literal_pathspec() {
        assert!(validate_relative_path("dir/file.txt").is_ok());
        assert!(validate_relative_path("we ird[1].txt").is_ok());
        assert_eq!(literal_pathspec("we ird[1].txt"), ":(literal)we ird[1].txt");
        for bad in [
            "",
            "../escape.txt",
            "dir/../../escape",
            "/abs.txt",
            "dir/./file",
            "dir/",
            "a//b",
            "dir\\file",
            "..",
        ] {
            assert!(
                validate_relative_path(bad).is_err(),
                "{bad:?} must be rejected"
            );
        }
        assert!(join_worktree_path(Path::new("/tmp/ws"), "../x").is_err());
        #[cfg(windows)]
        assert!(validate_relative_path("C:/abs.txt").is_err());
    }

    #[test]
    fn checkpoint_revert_rollback_message_carries_counts_and_results_only() {
        let results = vec![
            RevertItemResult {
                path: "restored.txt".to_string(),
                action: RevertAction::Restore,
                outcome: RevertItemOutcome::Restored,
                reason: None,
                observed_at: None,
            },
            RevertItemResult {
                path: "failed.txt".to_string(),
                action: RevertAction::Delete,
                outcome: RevertItemOutcome::Failed,
                reason: Some("io detail".to_string()),
                observed_at: None,
            },
            RevertItemResult {
                path: "conflict.txt".to_string(),
                action: RevertAction::Restore,
                outcome: RevertItemOutcome::SkippedConflict,
                reason: Some(CONFLICT_CONTENT_CHANGED.to_string()),
                observed_at: Some(1),
            },
        ];
        let counts = result_counts(&results);
        assert_eq!(counts.restored, 1);
        assert_eq!(counts.failed, 1);
        assert_eq!(counts.skipped_conflict, 1);
        assert_eq!(counts.total, 3);
        let message = rollback_message(
            "run-1",
            "refs/xihe/run-1/rollback/1700000000000",
            &counts,
            &results,
        );
        assert!(message.starts_with("run/run-1 rollback/1700000000000"));
        assert!(message.contains("restored: 1"));
        assert!(message.contains("failed: 1"));
        assert!(message.contains("skipped-conflict: 1"));
        assert!(message.contains("restored restored.txt"));
        assert!(message.contains("skipped-conflict conflict.txt CONTENT_CHANGED"));
    }

    #[tokio::test]
    async fn checkpoint_revert_matrix_plan_execute_idempotency_and_scope() {
        let fixture = Fixture::new().await;
        for (path, content) in [
            ("m_noop.txt", "m-noop-base"),
            ("m_exec.txt", "m-exec-base"),
            ("m_gone.txt", "m-gone-base"),
            ("m_conf.txt", "m-conf-base"),
            ("d_noop.txt", "d-noop-base"),
            ("d_exec.txt", "d-exec-base"),
            ("d_conf.txt", "d-conf-base"),
            ("r_noop_old.txt", "r-noop-base"),
            ("r_exec_old.txt", "r-exec-base"),
            ("r_conf_old.txt", "r-conf-base"),
            ("keep/keep.txt", "keep-base"),
            ("outside.txt", "outside-base"),
        ] {
            fixture.write(path, content);
        }
        fixture.create_base("run-matrix").await;

        // Run writes: modify / delete / add / rename.
        fixture.write("m_noop.txt", "m-noop-end");
        fixture.write("m_exec.txt", "m-exec-end");
        fixture.write("m_gone.txt", "m-gone-end");
        fixture.write("m_conf.txt", "m-conf-end");
        fixture.remove("d_noop.txt");
        fixture.remove("d_exec.txt");
        fixture.remove("d_conf.txt");
        fixture.rename("r_noop_old.txt", "r_noop_new.txt");
        fixture.rename("r_exec_old.txt", "r_exec_new.txt");
        fixture.rename("r_conf_old.txt", "r_conf_new.txt");
        fixture.write("a_noop.txt", "a-noop-end");
        fixture.write("a_exec.txt", "a-exec-end");
        fixture.write("a_conf.txt", "a-conf-end");
        fixture.write("keep/keep.txt", "keep-end");
        fixture.seal("run-matrix").await;

        // Arrange one current state per kind: target / end / other.
        fixture.write("m_noop.txt", "m-noop-base");
        fixture.remove("m_gone.txt");
        fixture.write("m_conf.txt", "m-conf-user");
        fixture.write("d_noop.txt", "d-noop-base");
        fixture.write("d_conf.txt", "d-conf-user");
        fixture.remove("a_noop.txt");
        fixture.write("a_conf.txt", "a-conf-user");
        fixture.write("r_noop_old.txt", "r-noop-base");
        fixture.remove("r_noop_new.txt");
        fixture.write("r_conf_old.txt", "r-conf-user");
        let outside_mtime = fixture.mtime_ms("outside.txt");
        let outside_content = fixture.read("outside.txt");

        let plan_of = |preview: &RevertPreview, path: &str| {
            preview
                .items
                .iter()
                .find(|item| item.path == path)
                .map(|item| (item.state, item.action))
                .unwrap_or_else(|| panic!("no plan item for {path}"))
        };

        let preview = fixture
            .engine
            .revert_preview(WS, "run-matrix")
            .await
            .expect("preview");
        assert_eq!(preview.head, HeadFingerprintStatus::NotRepo);
        assert_eq!(preview.counts.total, 17);
        assert_eq!(preview.counts.noop, 5);
        assert_eq!(preview.counts.conflicts, 5);
        assert_eq!(preview.counts.restore, 4);
        assert_eq!(preview.counts.delete, 3);
        for path in [
            "m_noop.txt",
            "d_noop.txt",
            "a_noop.txt",
            "r_noop_old.txt",
            "r_noop_new.txt",
        ] {
            assert_eq!(
                plan_of(&preview, path).0,
                RevertPlanState::Noop,
                "{path} is already at target"
            );
        }
        for path in [
            "m_exec.txt",
            "d_exec.txt",
            "keep/keep.txt",
            "r_exec_old.txt",
        ] {
            assert_eq!(
                plan_of(&preview, path),
                (RevertPlanState::Execute, RevertAction::Restore),
                "{path} is restorable"
            );
        }
        for path in ["a_exec.txt", "r_exec_new.txt", "r_conf_new.txt"] {
            assert_eq!(
                plan_of(&preview, path),
                (RevertPlanState::Execute, RevertAction::Delete),
                "{path} is deletable"
            );
        }
        for path in [
            "m_gone.txt",
            "m_conf.txt",
            "d_conf.txt",
            "a_conf.txt",
            "r_conf_old.txt",
        ] {
            assert_eq!(
                plan_of(&preview, path).0,
                RevertPlanState::Conflict,
                "{path} differs from base and end"
            );
        }
        let m_conf = preview
            .items
            .iter()
            .find(|item| item.path == "m_conf.txt")
            .expect("m_conf plan");
        assert_eq!(m_conf.reason.as_deref(), Some(CONFLICT_CONTENT_CHANGED));
        assert_eq!(m_conf.observed_at, Some(fixture.mtime_ms("m_conf.txt")));
        let m_gone = preview
            .items
            .iter()
            .find(|item| item.path == "m_gone.txt")
            .expect("m_gone plan");
        assert_eq!(m_gone.observed_at, None, "a deleted path has no mtime");

        // Unacknowledged conflicts gate the execution before any mutation.
        let conflict_paths = [
            "m_gone.txt",
            "m_conf.txt",
            "d_conf.txt",
            "a_conf.txt",
            "r_conf_old.txt",
        ];
        match fixture
            .engine
            .revert_execute(WS, "run-matrix", &RevertAcks::default())
            .await
        {
            Err(RevertError::ConflictsUnacknowledged { mut paths }) => {
                let mut expected: Vec<String> =
                    conflict_paths.iter().map(|path| path.to_string()).collect();
                paths.sort();
                expected.sort();
                assert_eq!(paths, expected);
            }
            other => panic!("expected ConflictsUnacknowledged, got {other:?}"),
        }
        assert_eq!(
            fixture.read("m_exec.txt"),
            "m-exec-end",
            "gate must precede mutation"
        );

        let acks = RevertAcks {
            head_changed: false,
            conflicts: conflict_paths.iter().map(|path| path.to_string()).collect(),
        };
        let result = fixture
            .engine
            .revert_execute(WS, "run-matrix", &acks)
            .await
            .expect("execute");
        assert_eq!(result.counts.restored, 4);
        assert_eq!(result.counts.deleted, 3);
        assert_eq!(result.counts.skipped_conflict, 5);
        assert_eq!(result.counts.noop, 5);
        assert_eq!(result.counts.failed, 0);
        assert_eq!(result.counts.total, 17);
        assert!(
            result.rollback_ref.is_some(),
            "execution records an audit ref"
        );

        let outcome_of = |result: &RevertResult, path: &str| {
            result
                .items
                .iter()
                .find(|item| item.path == path)
                .map(|item| item.outcome)
                .unwrap_or_else(|| panic!("no result item for {path}"))
        };
        for path in [
            "m_exec.txt",
            "d_exec.txt",
            "keep/keep.txt",
            "r_exec_old.txt",
        ] {
            assert_eq!(outcome_of(&result, path), RevertItemOutcome::Restored);
        }
        for path in ["a_exec.txt", "r_exec_new.txt", "r_conf_new.txt"] {
            assert_eq!(outcome_of(&result, path), RevertItemOutcome::Deleted);
        }
        for path in [
            "m_noop.txt",
            "d_noop.txt",
            "a_noop.txt",
            "r_noop_old.txt",
            "r_noop_new.txt",
        ] {
            assert_eq!(outcome_of(&result, path), RevertItemOutcome::Noop);
        }
        for path in conflict_paths {
            assert_eq!(
                outcome_of(&result, path),
                RevertItemOutcome::SkippedConflict
            );
        }

        assert_eq!(fixture.read("m_exec.txt"), "m-exec-base");
        assert_eq!(fixture.read("m_noop.txt"), "m-noop-base");
        assert_eq!(fixture.read("d_exec.txt"), "d-exec-base");
        assert!(!fixture.exists("a_exec.txt"));
        assert!(!fixture.exists("a_noop.txt"));
        assert_eq!(fixture.read("r_exec_old.txt"), "r-exec-base");
        assert!(!fixture.exists("r_exec_new.txt"));
        assert_eq!(fixture.read("r_noop_old.txt"), "r-noop-base");
        assert!(!fixture.exists("r_noop_new.txt"));
        assert_eq!(fixture.read("keep/keep.txt"), "keep-base");
        // Conflicts stay untouched (decision #7/#52).
        assert_eq!(fixture.read("m_conf.txt"), "m-conf-user");
        assert!(!fixture.exists("m_gone.txt"));
        assert_eq!(fixture.read("d_conf.txt"), "d-conf-user");
        assert_eq!(fixture.read("a_conf.txt"), "a-conf-user");
        assert_eq!(fixture.read("r_conf_old.txt"), "r-conf-user");
        assert!(!fixture.exists("r_conf_new.txt"));
        // Paths outside the run's changed set are never touched.
        assert_eq!(fixture.read("outside.txt"), outside_content);
        assert_eq!(fixture.mtime_ms("outside.txt"), outside_mtime);

        // Idempotent second execution: finished items are Noops, conflicts stable.
        let second = fixture
            .engine
            .revert_execute(WS, "run-matrix", &acks)
            .await
            .expect("second execute");
        assert_eq!(second.counts.noop, 12);
        assert_eq!(second.counts.skipped_conflict, 5);
        assert_eq!(second.counts.restored, 0);
        assert_eq!(second.counts.deleted, 0);
        assert_eq!(second.counts.failed, 0);
        assert_eq!(second.counts.total, 17);
    }

    #[tokio::test]
    async fn checkpoint_revert_double_execute_is_all_noop_and_appends_rollback_refs() {
        let fixture = Fixture::new().await;
        fixture.write("mod.txt", "mod-base");
        fixture.write("del.txt", "del-base");
        fixture.create_base("run-idem").await;
        fixture.write("mod.txt", "mod-end");
        fixture.remove("del.txt");
        fixture.write("new.txt", "new-end");
        fixture.seal("run-idem").await;

        let first = fixture
            .engine
            .revert_execute(WS, "run-idem", &RevertAcks::default())
            .await
            .expect("first execute");
        assert_eq!(first.counts.restored, 2);
        assert_eq!(first.counts.deleted, 1);
        assert_eq!(first.counts.failed, 0);
        let after_first = [fixture.mtime_ms("mod.txt"), fixture.mtime_ms("del.txt")];
        assert!(!fixture.exists("new.txt"));

        let second = fixture
            .engine
            .revert_execute(WS, "run-idem", &RevertAcks::default())
            .await
            .expect("second execute");
        assert_eq!(second.counts.noop, 3);
        assert_eq!(second.counts.restored, 0);
        assert_eq!(second.counts.deleted, 0);
        assert_eq!(second.counts.failed, 0);
        assert!(
            second
                .items
                .iter()
                .all(|item| item.outcome == RevertItemOutcome::Noop),
            "a repeated execute is all-Noop: {:?}",
            second.items
        );
        assert_eq!(
            [fixture.mtime_ms("mod.txt"), fixture.mtime_ms("del.txt")],
            after_first,
            "a repeated execute must not rewrite restored files"
        );
        let refs = fixture.refs("refs/xihe/run-idem/rollback/").await;
        assert_eq!(
            refs.len(),
            2,
            "each execution appends a rollback ref: {refs:?}"
        );
    }

    #[tokio::test]
    async fn checkpoint_revert_rollback_refs_are_recorded_then_cleaned_by_retention_and_drop() {
        let fixture = Fixture::new().await;
        fixture.write("secret.txt", "ROLLBACK-SENTINEL-CONTENT");
        fixture.write("m.txt", "m-base");
        fixture.create_base("run-refs").await;
        fixture.write("m.txt", "m-end");
        fixture.remove("secret.txt");
        fixture.write("added.txt", "added-end");
        fixture.seal("run-refs").await;

        let result = fixture
            .engine
            .revert_execute(WS, "run-refs", &RevertAcks::default())
            .await
            .expect("execute");
        let reference = result.rollback_ref.clone().expect("rollback ref recorded");
        assert!(reference.starts_with("refs/xihe/run-refs/rollback/"));

        let base_commit = fixture.ref_commit("refs/xihe/run-refs/base").await;
        let end_commit = fixture.ref_commit("refs/xihe/run-refs/end").await;
        let rollback_commit = fixture.ref_commit(&reference).await;
        assert_eq!(
            fixture.ref_commit(&format!("{rollback_commit}^")).await,
            end_commit,
            "rollback commit parent is the end commit"
        );
        assert_eq!(
            fixture
                .ref_commit(&format!("{rollback_commit}^{{tree}}"))
                .await,
            fixture.ref_commit(&format!("{base_commit}^{{tree}}")).await,
            "rollback commit tree is the base tree"
        );
        let message = fixture.git(&["cat-file", "commit", &rollback_commit]).await;
        assert!(message.contains("restored: 2"));
        assert!(message.contains("deleted: 1"));
        assert!(message.contains("restored m.txt"));
        assert!(message.contains("deleted added.txt"));
        assert!(
            !message.contains("ROLLBACK-SENTINEL-CONTENT"),
            "rollback message must never carry file contents"
        );

        fixture
            .engine
            .revert_execute(WS, "run-refs", &RevertAcks::default())
            .await
            .expect("second execute");
        assert_eq!(fixture.refs("refs/xihe/run-refs/rollback/").await.len(), 2);

        let report = fixture
            .engine
            .retention_gc(WS, 0, 30)
            .await
            .expect("retention");
        assert_eq!(report.deleted_runs, vec!["run-refs".to_string()]);
        assert!(report.gc_ran);
        assert!(
            fixture.refs("refs/xihe/run-refs/").await.is_empty(),
            "base/end/rollback refs are all removed (no object leak)"
        );

        fixture.write("other.txt", "other-base");
        fixture.create_base("run-drop").await;
        fixture.write("other.txt", "other-end");
        fixture.seal("run-drop").await;
        fixture
            .engine
            .revert_execute(WS, "run-drop", &RevertAcks::default())
            .await
            .expect("execute drop run");
        assert_eq!(fixture.refs("refs/xihe/run-drop/rollback/").await.len(), 1);
        let dropped = fixture
            .engine
            .drop_refs(WS, "run-drop")
            .await
            .expect("drop refs");
        assert!(dropped.iter().any(|name| name == "refs/xihe/run-drop/base"));
        assert!(dropped.iter().any(|name| name == "refs/xihe/run-drop/end"));
        assert!(
            dropped
                .iter()
                .any(|name| name.starts_with("refs/xihe/run-drop/rollback/")),
            "drop_refs removes rollback refs too: {dropped:?}"
        );
        assert!(fixture.refs("refs/xihe/run-drop/").await.is_empty());
    }

    #[tokio::test]
    async fn checkpoint_revert_execute_never_touches_paths_outside_the_changed_set() {
        let fixture = Fixture::new().await;
        fixture.write("target.txt", "target-base");
        fixture.write("outside.txt", "outside-base");
        fixture.write("nested/other.txt", "nested-base");
        fixture.write("node_modules/dependency.txt", "excluded-base");
        fixture.create_base("run-scope").await;
        fixture.write("target.txt", "target-end");
        fixture.seal("run-scope").await;

        // Post-seal user edits outside the run's changed set.
        fixture.write("outside.txt", "outside-user");
        fixture.write("nested/other.txt", "nested-user");
        fixture.write("node_modules/dependency.txt", "excluded-user");
        let watched = [
            ("outside.txt", fixture.mtime_ms("outside.txt")),
            ("nested/other.txt", fixture.mtime_ms("nested/other.txt")),
            (
                "node_modules/dependency.txt",
                fixture.mtime_ms("node_modules/dependency.txt"),
            ),
        ];

        let result = fixture
            .engine
            .revert_execute(WS, "run-scope", &RevertAcks::default())
            .await
            .expect("execute");
        assert_eq!(result.counts.total, 1, "only the changed path is an item");
        assert_eq!(result.counts.restored, 1);
        assert_eq!(fixture.read("target.txt"), "target-base");
        assert_eq!(fixture.read("outside.txt"), "outside-user");
        assert_eq!(fixture.read("nested/other.txt"), "nested-user");
        assert_eq!(fixture.read("node_modules/dependency.txt"), "excluded-user");
        for (path, mtime) in watched {
            assert_eq!(fixture.mtime_ms(path), mtime, "{path} must keep its mtime");
        }
        assert!(
            !fixture.ws().join(".xihe-shadow").exists(),
            "the shadow repository stays outside the workspace"
        );
    }

    #[tokio::test]
    async fn checkpoint_revert_delete_prunes_only_empty_directories() {
        let fixture = Fixture::new().await;
        fixture.write("keep/peer.txt", "peer-base");
        fixture.write("stop/x/y/file.txt", "stop-base");
        fixture.create_base("run-dirs").await;
        fixture.write("keep/peer.txt", "peer-end");
        fixture.write("keep/child.txt", "child-end");
        fixture.write("deep/a/b/c/added.txt", "added-end");
        fixture.remove("stop/x/y/file.txt");
        fixture.seal("run-dirs").await;

        // A post-seal sibling keeps `stop/x` non-empty.
        fixture.write("stop/x/other.txt", "other-user");

        let result = fixture
            .engine
            .revert_execute(WS, "run-dirs", &RevertAcks::default())
            .await
            .expect("execute");
        assert_eq!(result.counts.restored, 2);
        assert_eq!(result.counts.deleted, 2);
        assert_eq!(result.counts.failed, 0);
        assert!(
            !fixture.exists("deep"),
            "empty directory chain is pruned bottom-up"
        );
        assert!(
            !fixture.exists("keep/child.txt"),
            "the added file is deleted"
        );
        assert_eq!(fixture.read("keep/peer.txt"), "peer-base");
        assert!(
            fixture.exists("keep"),
            "a non-empty directory is never removed"
        );
        assert_eq!(fixture.read("stop/x/y/file.txt"), "stop-base");
        assert_eq!(fixture.read("stop/x/other.txt"), "other-user");
        assert!(
            fixture.exists("stop/x"),
            "a non-empty directory stops the walk"
        );
        assert!(fixture.ws().is_dir(), "the workspace root is never removed");
    }

    #[tokio::test]
    async fn checkpoint_revert_literal_pathspec_handles_spaces_brackets_hash_and_unicode() {
        let fixture = Fixture::new().await;
        fixture.write("dir with space/file.txt", "space-base");
        fixture.write("we ird[1].txt", "bracket-base");
        fixture.write("hash#file.txt", "hash-base");
        fixture.write("正则文件.txt", "unicode-base");
        fixture.create_base("run-names").await;
        fixture.write("dir with space/file.txt", "space-end");
        fixture.remove("we ird[1].txt");
        fixture.write("hash#file.txt", "hash-end");
        fixture.remove("正则文件.txt");
        fixture.seal("run-names").await;

        let result = fixture
            .engine
            .revert_execute(WS, "run-names", &RevertAcks::default())
            .await
            .expect("execute");
        assert_eq!(result.counts.restored, 4);
        assert_eq!(result.counts.deleted, 0);
        assert_eq!(result.counts.failed, 0);
        assert_eq!(fixture.read("dir with space/file.txt"), "space-base");
        assert_eq!(fixture.read("we ird[1].txt"), "bracket-base");
        assert_eq!(fixture.read("hash#file.txt"), "hash-base");
        assert_eq!(fixture.read("正则文件.txt"), "unicode-base");
    }

    #[tokio::test]
    async fn checkpoint_revert_preview_is_read_only_and_reports_unsealed_and_unknown_runs() {
        let fixture = Fixture::new().await;
        fixture.write("a.txt", "a-base");
        fixture.create_base("run-open").await;
        fixture.write("a.txt", "a-end");

        match fixture.engine.revert_preview(WS, "run-open").await {
            Err(RevertError::NotSealed(run_id)) => assert_eq!(run_id, "run-open"),
            other => panic!("expected NotSealed, got {other:?}"),
        }
        match fixture
            .engine
            .revert_execute(WS, "run-open", &RevertAcks::default())
            .await
        {
            Err(RevertError::NotSealed(_)) => {}
            other => panic!("expected NotSealed, got {other:?}"),
        }
        assert_eq!(
            fixture.read("a.txt"),
            "a-end",
            "a rejected call must not mutate"
        );
        match fixture.engine.revert_preview(WS, "run-missing").await {
            Err(RevertError::NotFound(run_id)) => assert_eq!(run_id, "run-missing"),
            other => panic!("expected NotFound, got {other:?}"),
        }
        match fixture.engine.revert_preview(WS, "../escape").await {
            Err(RevertError::NotFound(_)) => {}
            other => panic!("expected NotFound for invalid run id, got {other:?}"),
        }

        fixture.seal("run-open").await;
        let mtime = fixture.mtime_ms("a.txt");
        let before = fixture.refs("refs/xihe/run-open/rollback/").await;
        let preview = fixture
            .engine
            .revert_preview(WS, "run-open")
            .await
            .expect("preview");
        assert_eq!(preview.counts.restore, 1);
        assert_eq!(preview.counts.conflicts, 0);
        assert_eq!(
            fixture.read("a.txt"),
            "a-end",
            "preview must not touch the worktree"
        );
        assert_eq!(fixture.mtime_ms("a.txt"), mtime);
        assert_eq!(
            fixture.refs("refs/xihe/run-open/rollback/").await,
            before,
            "preview must not append refs"
        );
    }

    #[tokio::test]
    async fn checkpoint_revert_blob_reads_base_and_end_and_rejects_caps_and_non_files() {
        let fixture = Fixture::new().await;
        fixture.write("notes.md", "before\n");
        fixture.create_base("run-blob").await;
        fixture.write("notes.md", "after\n");
        fixture.write("src/new.txt", "created\n");
        let oversized = "a".repeat(usize::try_from(MAX_BLOB_BYTES).expect("cap fits usize") + 1);
        fixture.write("big.txt", &oversized);
        fixture.seal("run-blob").await;

        let end = fixture
            .engine
            .revert_blob(
                WS,
                "run-blob",
                RevertBlobRef::End,
                "notes.md",
                MAX_BLOB_BYTES,
            )
            .await
            .expect("end blob");
        assert_eq!(end.reference, "end");
        assert_eq!(String::from_utf8(end.content).expect("utf8"), "after\n");

        let base = fixture
            .engine
            .revert_blob(
                WS,
                "run-blob",
                RevertBlobRef::Base,
                "notes.md",
                MAX_BLOB_BYTES,
            )
            .await
            .expect("base blob");
        assert_eq!(base.reference, "base");
        assert_eq!(String::from_utf8(base.content).expect("utf8"), "before\n");

        // A path the run created has no blob in the base tree.
        match fixture
            .engine
            .revert_blob(
                WS,
                "run-blob",
                RevertBlobRef::Base,
                "src/new.txt",
                MAX_BLOB_BYTES,
            )
            .await
        {
            Err(RevertError::PathNotFound { reference, path }) => {
                assert_eq!(reference, "base");
                assert_eq!(path, "src/new.txt");
            }
            other => panic!("expected PathNotFound, got {other:?}"),
        }
        match fixture
            .engine
            .revert_blob(
                WS,
                "run-blob",
                RevertBlobRef::End,
                "missing.txt",
                MAX_BLOB_BYTES,
            )
            .await
        {
            Err(RevertError::PathNotFound { .. }) => {}
            other => panic!("expected PathNotFound, got {other:?}"),
        }

        // The read cap is enforced before any content is read.
        match fixture
            .engine
            .revert_blob(WS, "run-blob", RevertBlobRef::End, "notes.md", 3)
            .await
        {
            Err(RevertError::BlobTooLarge { size, max, .. }) => {
                assert_eq!(size, 6);
                assert_eq!(max, 3);
            }
            other => panic!("expected BlobTooLarge, got {other:?}"),
        }

        // Non-normal paths and non-file entries are rejected as requests.
        for path in ["../escape.txt", "dir\\file.txt", "/abs.txt"] {
            match fixture
                .engine
                .revert_blob(WS, "run-blob", RevertBlobRef::End, path, MAX_BLOB_BYTES)
                .await
            {
                Err(RevertError::InvalidRequest { .. }) => {}
                other => panic!("expected InvalidRequest for {path:?}, got {other:?}"),
            }
        }
        match fixture
            .engine
            .revert_blob(WS, "run-blob", RevertBlobRef::End, "src", MAX_BLOB_BYTES)
            .await
        {
            Err(RevertError::InvalidRequest { detail }) => {
                assert!(
                    detail.contains("tree"),
                    "directory entry rejected: {detail}"
                );
            }
            other => panic!("expected InvalidRequest for a directory, got {other:?}"),
        }

        // `base` works before the run is sealed; `end` reports the missing seal.
        fixture.write("open.txt", "open\n");
        fixture.create_base("run-open-blob").await;
        let open_base = fixture
            .engine
            .revert_blob(
                WS,
                "run-open-blob",
                RevertBlobRef::Base,
                "open.txt",
                MAX_BLOB_BYTES,
            )
            .await
            .expect("base blob of an unsealed run");
        assert_eq!(
            String::from_utf8(open_base.content).expect("utf8"),
            "open\n"
        );
        match fixture
            .engine
            .revert_blob(
                WS,
                "run-open-blob",
                RevertBlobRef::End,
                "open.txt",
                MAX_BLOB_BYTES,
            )
            .await
        {
            Err(RevertError::NotSealed(run_id)) => assert_eq!(run_id, "run-open-blob"),
            other => panic!("expected NotSealed, got {other:?}"),
        }
        match fixture
            .engine
            .revert_blob(
                WS,
                "run-unknown-blob",
                RevertBlobRef::Base,
                "notes.md",
                MAX_BLOB_BYTES,
            )
            .await
        {
            Err(RevertError::NotFound(run_id)) => assert_eq!(run_id, "run-unknown-blob"),
            other => panic!("expected NotFound, got {other:?}"),
        }

        // Details expose the compared fingerprints alongside the status.
        let (status, recorded, current) = fixture
            .engine
            .head_fingerprint_details(WS, "run-blob")
            .await
            .expect("head details");
        assert_eq!(status, HeadFingerprintStatus::NotRepo);
        assert!(recorded.is_some_and(|head| !head.is_repo));
        assert!(current.is_some_and(|head| !head.is_repo));
        assert_eq!(
            fixture
                .engine
                .head_fingerprint_status(WS, "run-blob")
                .await
                .expect("status"),
            status
        );
    }

    #[tokio::test]
    async fn checkpoint_revert_execute_reports_lease_held_while_another_engine_operation_owns_the_workspace()
     {
        let fixture = Fixture::new().await;
        fixture.write("a.txt", "a-base");
        fixture.create_base("run-lease").await;
        fixture.write("a.txt", "a-end");
        fixture.seal("run-lease").await;

        let guard = fixture.engine.lock_workspace(WS).await;
        // Preview is read-only and takes no lease.
        let preview = fixture
            .engine
            .revert_preview(WS, "run-lease")
            .await
            .expect("preview while locked");
        assert_eq!(preview.counts.restore, 1);
        match fixture
            .engine
            .revert_execute(WS, "run-lease", &RevertAcks::default())
            .await
        {
            Err(RevertError::LeaseHeld) => {}
            other => panic!("expected LeaseHeld, got {other:?}"),
        }
        drop(guard);
        let result = fixture
            .engine
            .revert_execute(WS, "run-lease", &RevertAcks::default())
            .await
            .expect("execute after release");
        assert_eq!(result.counts.restored, 1);
    }

    #[tokio::test]
    async fn checkpoint_revert_head_fingerprint_ok_changed_unknown_and_not_repo() {
        let fixture = Fixture::new().await;
        fixture.write("a.txt", "a-v1");

        // (a) non-repo workspace: explicit not_repo, revert proceeds without acks.
        fixture.create_base("run-norepo").await;
        fixture.write("a.txt", "a-v2");
        fixture.seal("run-norepo").await;
        assert_eq!(
            fixture
                .engine
                .head_fingerprint_status(WS, "run-norepo")
                .await
                .expect("status"),
            HeadFingerprintStatus::NotRepo
        );
        let preview = fixture
            .engine
            .revert_preview(WS, "run-norepo")
            .await
            .expect("preview");
        assert_eq!(preview.head, HeadFingerprintStatus::NotRepo);
        let result = fixture
            .engine
            .revert_execute(WS, "run-norepo", &RevertAcks::default())
            .await
            .expect("execute non-repo");
        assert_eq!(result.counts.restored, 1);
        assert_eq!(fixture.read("a.txt"), "a-v1");

        // (b) user repository: ok until HEAD moves, then gated by an explicit ack.
        git_in(&fixture.ws(), &["init"]);
        git_in(&fixture.ws(), &["add", "-A"]);
        git_in(&fixture.ws(), &["commit", "-m", "init"]);
        fixture.create_base("run-repo").await;
        fixture.write("a.txt", "a-v3");
        fixture.seal("run-repo").await;
        let sealed_changes = fixture
            .engine
            .changed_files(WS, "run-repo")
            .await
            .expect("sealed changes");
        assert!(
            sealed_changes
                .iter()
                .all(|file| !file.path.starts_with(".git")),
            "the user .git must never enter the shadow snapshot: {sealed_changes:?}"
        );
        assert_eq!(
            fixture
                .engine
                .head_fingerprint_status(WS, "run-repo")
                .await
                .expect("status"),
            HeadFingerprintStatus::Ok
        );

        fixture.write("b.txt", "b-v1");
        git_in(&fixture.ws(), &["add", "-A"]);
        git_in(&fixture.ws(), &["commit", "-m", "user commit"]);
        assert_eq!(
            fixture
                .engine
                .head_fingerprint_status(WS, "run-repo")
                .await
                .expect("status"),
            HeadFingerprintStatus::Changed
        );
        match fixture
            .engine
            .revert_execute(WS, "run-repo", &RevertAcks::default())
            .await
        {
            Err(RevertError::HeadChanged { recorded, observed }) => {
                assert!(recorded.is_some_and(|head| head.is_repo));
                assert!(observed.is_some_and(|head| head.is_repo));
            }
            other => panic!("expected HeadChanged, got {other:?}"),
        }
        assert_eq!(
            fixture.read("a.txt"),
            "a-v3",
            "the head gate precedes mutation"
        );
        let acks = RevertAcks {
            head_changed: true,
            conflicts: Vec::new(),
        };
        let result = fixture
            .engine
            .revert_execute(WS, "run-repo", &acks)
            .await
            .expect("acknowledged execute");
        assert_eq!(result.head, HeadFingerprintStatus::Changed);
        assert_eq!(result.counts.restored, 1);
        assert_eq!(fixture.read("a.txt"), "a-v1");

        // (c) legacy base without fingerprint lines: unknown, reported but not blocked.
        fixture.write("legacy.txt", "legacy-v1");
        craft_legacy_base(&fixture, "run-legacy").await;
        fixture.write("legacy.txt", "legacy-v2");
        fixture.seal("run-legacy").await;
        assert_eq!(
            fixture
                .engine
                .head_fingerprint_status(WS, "run-legacy")
                .await
                .expect("status"),
            HeadFingerprintStatus::Unknown
        );
        let preview = fixture
            .engine
            .revert_preview(WS, "run-legacy")
            .await
            .expect("legacy preview");
        assert_eq!(preview.head, HeadFingerprintStatus::Unknown);
        let result = fixture
            .engine
            .revert_execute(WS, "run-legacy", &RevertAcks::default())
            .await
            .expect("legacy execute");
        assert_eq!(result.head, HeadFingerprintStatus::Unknown);
        assert_eq!(result.counts.restored, 1);
        assert_eq!(fixture.read("legacy.txt"), "legacy-v1");
    }

    /// Write a base ref with the pre-M3 message format (no head fingerprint lines).
    async fn craft_legacy_base(fixture: &Fixture, run_id: &str) {
        let shadow = fixture.engine.shadow_git_dir(WS).expect("shadow dir");
        let ws = fixture.ws();
        let index = shadow.join(format!("legacy-index.{run_id}"));
        let stage_env = fixture.engine.isolated_env(&shadow, &ws, Some(&index));
        fixture
            .engine
            .run_git_checked(
                &["add", "-A"],
                &stage_env,
                Some(&ws),
                fixture.engine.call_timeout,
            )
            .await
            .expect("stage legacy tree");
        let tree = String::from_utf8_lossy(
            &fixture
                .engine
                .run_git_checked(
                    &["write-tree"],
                    &stage_env,
                    None,
                    fixture.engine.call_timeout,
                )
                .await
                .expect("write legacy tree"),
        )
        .trim()
        .to_string();
        let env = fixture.engine.isolated_env(&shadow, &ws, None);
        let message = format!("run/{run_id} base\n\nactor: legacy\ncallId: legacy\n");
        let commit = String::from_utf8_lossy(
            &fixture
                .engine
                .run_git_checked(
                    &["commit-tree", &tree, "-m", &message],
                    &env,
                    None,
                    fixture.engine.call_timeout,
                )
                .await
                .expect("commit legacy base"),
        )
        .trim()
        .to_string();
        fixture
            .engine
            .run_git_checked(
                &["update-ref", &format!("refs/xihe/{run_id}/base"), &commit],
                &env,
                None,
                fixture.engine.call_timeout,
            )
            .await
            .expect("update legacy base ref");
        std::fs::remove_file(&index).ok();
    }

    #[test]
    fn checkpoint_revert_wire_vocabulary_is_camel_case_and_frozen() {
        for (status, expected) in [
            (HeadFingerprintStatus::Ok, "ok"),
            (HeadFingerprintStatus::Changed, "changed"),
            (HeadFingerprintStatus::Unknown, "unknown"),
            (HeadFingerprintStatus::NotRepo, "not_repo"),
        ] {
            assert_eq!(
                serde_json::to_value(status).expect("status json"),
                serde_json::json!(expected)
            );
        }
        for (outcome, expected) in [
            (RevertItemOutcome::Restored, "restored"),
            (RevertItemOutcome::Deleted, "deleted"),
            (RevertItemOutcome::SkippedConflict, "skippedConflict"),
            (RevertItemOutcome::Failed, "failed"),
            (RevertItemOutcome::Noop, "noop"),
        ] {
            assert_eq!(
                serde_json::to_value(outcome).expect("outcome json"),
                serde_json::json!(expected)
            );
        }

        let preview = RevertPreview {
            workspace_id: "ws1".to_string(),
            run_id: "run-1".to_string(),
            base_commit: "base".to_string(),
            end_commit: "end".to_string(),
            head: HeadFingerprintStatus::Ok,
            items: vec![RevertPlanItem {
                path: "a.txt".to_string(),
                action: RevertAction::Restore,
                target: RevertTarget::Base,
                state: RevertPlanState::Execute,
                reason: None,
                observed_at: None,
            }],
            counts: RevertPreviewCounts {
                restore: 1,
                delete: 0,
                noop: 0,
                conflicts: 0,
                total: 1,
            },
        };
        let value = serde_json::to_value(&preview).expect("preview json");
        assert_eq!(value["workspaceId"], serde_json::json!("ws1"));
        assert_eq!(value["baseCommit"], serde_json::json!("base"));
        assert_eq!(value["head"], serde_json::json!("ok"));
        assert_eq!(value["items"][0]["action"], serde_json::json!("restore"));
        assert_eq!(value["items"][0]["target"], serde_json::json!("base"));
        assert_eq!(value["items"][0]["state"], serde_json::json!("execute"));
        assert_eq!(value["items"][0]["observedAt"], serde_json::Value::Null);
        assert_eq!(value["counts"]["conflicts"], serde_json::json!(0));

        let acks: RevertAcks =
            serde_json::from_str(r#"{"headChanged":true,"conflicts":["a.txt"]}"#).expect("acks");
        assert!(acks.head_changed);
        assert_eq!(acks.conflicts, vec!["a.txt".to_string()]);
        assert_eq!(
            serde_json::from_str::<RevertAcks>("{}").expect("empty acks"),
            RevertAcks::default()
        );
    }
}
