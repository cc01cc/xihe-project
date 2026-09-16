//! PLAN-0338 slice model: restore execution engine.
//!
//! Restore = "go back to the target slice" (spec `slice-model.md` §4):
//!
//! - the plan is git-native: stage the current workspace into a short-lived temp
//!   index (`add -A`, so excluded paths never enter the tree and are therefore
//!   never touched), then `git diff --name-status <sliceTree> <currentTree>` gives
//!   `M`/`D` → restore and `A` → delete;
//! - type changes (file ↔ directory, file ↔ symlink) are reported as
//!   `type_conflict` and are only executed after an explicit acknowledgement;
//! - execution is per path: `git checkout <sliceCommit> -- :(literal)<path>` for
//!   `M`/`D`, fs unlink plus empty-directory pruning for `A`; failures are reported
//!   per path and never abort the remaining plan;
//! - no attribution and no content-conflict skipping: every difference to the
//!   target slice is a restore target. The restore lock is held for the execution
//!   only (a second concurrent restore fails fast with
//!   [`RestoreError::RestoreLocked`]); workspace writes stay allowed, so each
//!   restored/deleted path is re-checked against the slice afterwards and reported
//!   as `suspect` when a concurrent write won the race;
//! - no rollback/audit refs are written (the CP slice projection is the durable
//!   record).
//!
//! Blob reads for the slice detail endpoint live here too ([`ShadowGit::slice_blob`]).
//! HTTP wiring lives in [`crate::checkpoint_revert_api`].

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use serde::Serialize;
use thiserror::Error;
use tracing::{debug, info, warn};

use crate::checkpoint::{
    CheckpointError, ScratchFiles, ShadowGit, parse_slice_ref, scratch_excludes_path,
    scratch_index_path, validate_workspace_id,
};

/// Frozen type-conflict reason code (spec §5).
pub const TYPE_CHANGE_REASON: &str = "TYPE_CHANGE";

/// `Unavailable` reason for a missing or failing host git.
pub const RESTORE_REASON_GIT_UNAVAILABLE: &str = "GIT_UNAVAILABLE";
/// `Unavailable` reason for a host git below the frozen minimum version.
pub const RESTORE_REASON_GIT_TOO_OLD: &str = "GIT_TOO_OLD";
/// `Unavailable` reason for an unknown workspace directory.
pub const RESTORE_REASON_WORKSPACE_UNKNOWN: &str = "WORKSPACE_UNKNOWN";

/// Blob read cap for the slice blob endpoint (plain-text previews only).
pub const MAX_BLOB_BYTES: u64 = 1024 * 1024;

/// Maximum pathspec entries per `git diff` call (command-line size safety).
const PATHSPEC_CHUNK: usize = 128;

static SCRATCH_COUNTER: AtomicU64 = AtomicU64::new(0);

/// What restoring one plan entry must do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RestoreAction {
    /// Write the slice-tree content back to the path (`M`/`D`).
    Restore,
    /// Remove the path (it exists in the workspace but not in the slice).
    Delete,
}

impl RestoreAction {
    /// Frozen wire name (`restore` / `delete`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Restore => "restore",
            Self::Delete => "delete",
        }
    }
}

/// State of one plan entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreEntryState {
    /// Safe to execute.
    Execute,
    /// Already at target; no action needed (reserved for idempotent replays).
    Noop,
    /// File ↔ directory or file ↔ symlink change: requires an explicit ack.
    TypeConflict,
}

impl RestoreEntryState {
    /// Frozen wire name (`execute` / `noop` / `type_conflict`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Execute => "execute",
            Self::Noop => "noop",
            Self::TypeConflict => "type_conflict",
        }
    }
}

/// Per-path execution outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RestoreItemOutcome {
    Restored,
    Deleted,
    Failed,
    /// The operation ran, but the path no longer matches the target slice when
    /// re-checked (a concurrent write won the race).
    Suspect,
}

/// One entry of a [`RestorePreview`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestorePreviewEntry {
    /// Workspace-relative path with forward slashes.
    pub path: String,
    pub action: RestoreAction,
    pub state: RestoreEntryState,
    /// Frozen reason code when `state == TypeConflict`.
    pub reason: Option<String>,
}

/// Dry-run counts of a [`RestorePreview`] (full plan, before any truncation).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RestorePreviewCounts {
    pub restore: usize,
    pub delete: usize,
    pub type_conflict: usize,
}

/// Read-only restore dry-run for one slice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestorePreview {
    pub slice_ref: String,
    pub commit: String,
    pub entries: Vec<RestorePreviewEntry>,
    pub counts: RestorePreviewCounts,
}

/// One executed path of a [`RestoreResult`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreItemResult {
    pub path: String,
    pub action: RestoreAction,
    pub outcome: RestoreItemOutcome,
    pub reason: Option<String>,
}

/// Counts of a [`RestoreResult`] (suspects are listed separately).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RestoreResultCounts {
    pub restored: usize,
    pub deleted: usize,
    pub failed: usize,
}

/// Result of one [`ShadowGit::restore_execute`] call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreResult {
    pub slice_ref: String,
    pub commit: String,
    pub entries: Vec<RestoreItemResult>,
    pub counts: RestoreResultCounts,
    pub duration_ms: u64,
    /// Executed paths that no longer match the target slice (concurrent write).
    pub suspects: Vec<String>,
}

/// One blob read out of a slice tree (plain-text preview payload).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SliceBlob {
    pub path: String,
    pub content: Vec<u8>,
}

/// Typed restore failures mapped by the endpoint layer
/// ([`crate::checkpoint_revert_api`]) to 400/404/409/413/503.
#[derive(Debug, Error)]
pub enum RestoreError {
    #[error("checkpoint slice not found: {0}")]
    SliceNotFound(String),

    #[error("another checkpoint restore is already running for this workspace")]
    RestoreLocked,

    #[error("type changes must be acknowledged before restore: {}", paths.join(", "))]
    TypeChangesUnacknowledged { paths: Vec<String> },

    #[error("checkpoint restore unavailable [{reason}]: {detail}")]
    Unavailable {
        reason: &'static str,
        detail: String,
    },

    /// Malformed request content: non-normal path.
    #[error("checkpoint restore request rejected: {detail}")]
    InvalidRequest { detail: String },

    /// The requested path does not exist in the slice tree.
    #[error("path {path} is not present in the slice tree")]
    PathNotFound { path: String },

    /// The requested blob exceeds the endpoint read cap.
    #[error("checkpoint blob too large: {path} ({size} bytes > {max} bytes)")]
    BlobTooLarge { path: String, size: u64, max: u64 },

    #[error("checkpoint restore failed: {0}")]
    Failed(String),
}

type Result<T> = std::result::Result<T, RestoreError>;

/// One atomic restore plan entry.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PlannedEntry {
    path: String,
    action: RestoreAction,
    state: RestoreEntryState,
    reason: Option<String>,
}

/// Shadow/worktree/env resolution shared by every restore read.
struct RestoreContext {
    shadow: PathBuf,
    work_tree: PathBuf,
    env: Vec<(String, String)>,
}

/// One resolved target slice.
struct SliceTarget {
    slice_ref: String,
    commit: String,
    tree: String,
}

/// One resolved `git ls-tree -l` entry reduced to what a blob read needs.
struct TreeEntry {
    oid: String,
    size: u64,
}

/// Per-call scratch `GIT_INDEX_FILE`; removed on drop (never the user index).
struct ScratchIndex {
    path: PathBuf,
}

impl ScratchIndex {
    fn create(shadow: &Path) -> Self {
        let counter = SCRATCH_COUNTER.fetch_add(1, Ordering::Relaxed);
        let token = format!("restore.{}.{}", std::process::id(), counter);
        Self {
            path: scratch_index_path(shadow, &token),
        }
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
                "failed to remove restore scratch index"
            );
        }
    }
}

impl ShadowGit {
    /// Read-only restore dry-run for one slice: every difference between the
    /// slice tree and the current workspace tree, with type changes flagged.
    pub async fn restore_preview(
        &self,
        workspace_id: &str,
        slice_ref: &str,
    ) -> Result<RestorePreview> {
        let context = self
            .resolve_restore_context(workspace_id, slice_ref)
            .await?;
        let target = self.resolve_slice_target(&context, slice_ref).await?;
        let planned = self.plan_restore(&context, &target).await?;
        let entries: Vec<RestorePreviewEntry> = planned
            .iter()
            .map(|entry| RestorePreviewEntry {
                path: entry.path.clone(),
                action: entry.action,
                state: entry.state,
                reason: entry.reason.clone(),
            })
            .collect();
        let counts = preview_counts(&entries);
        debug!(
            workspace_id,
            slice_ref,
            restore = counts.restore,
            delete = counts.delete,
            type_conflict = counts.type_conflict,
            "checkpoint restore preview computed"
        );
        Ok(RestorePreview {
            slice_ref: target.slice_ref,
            commit: target.commit,
            entries,
            counts,
        })
    }

    /// Execute the restore of one slice, path by path.
    ///
    /// Every `type_conflict` entry must be acknowledged
    /// ([`RestoreError::TypeChangesUnacknowledged`] otherwise); a second
    /// concurrent restore fails fast with [`RestoreError::RestoreLocked`]. Per-path
    /// failures are returned inside the result; only engine-level failures are
    /// `Err`. After execution each touched path is re-checked against the slice and
    /// reported as `suspect` when it no longer matches (concurrent write).
    pub async fn restore_execute(
        &self,
        workspace_id: &str,
        slice_ref: &str,
        acknowledge_type_changes: &[String],
    ) -> Result<RestoreResult> {
        let started = Instant::now();
        let context = self
            .resolve_restore_context(workspace_id, slice_ref)
            .await?;
        let target = self.resolve_slice_target(&context, slice_ref).await?;
        let _lock = self
            .try_lock_restore(workspace_id)
            .ok_or(RestoreError::RestoreLocked)?;
        let planned = self.plan_restore(&context, &target).await?;
        ensure_type_changes_acknowledged(&planned, acknowledge_type_changes)?;

        let scratch = ScratchIndex::create(&context.shadow);
        let mut results = Vec::with_capacity(planned.len());
        // Deletes run before restores: a slice file that is currently a directory
        // (acked type change) only materializes after the added children (which
        // sort after it) are removed and the empty directory is pruned.
        let mut ordered: Vec<&PlannedEntry> = Vec::with_capacity(planned.len());
        ordered.extend(
            planned
                .iter()
                .filter(|entry| entry.action == RestoreAction::Delete),
        );
        ordered.extend(
            planned
                .iter()
                .filter(|entry| entry.action == RestoreAction::Restore),
        );
        for entry in ordered {
            let outcome = match entry.action {
                RestoreAction::Restore => {
                    match self
                        .restore_path(&context, &target.commit, &entry.path, &scratch.path)
                        .await
                    {
                        Ok(()) => RestoreItemResult {
                            path: entry.path.clone(),
                            action: entry.action,
                            outcome: RestoreItemOutcome::Restored,
                            reason: None,
                        },
                        Err(detail) => RestoreItemResult {
                            path: entry.path.clone(),
                            action: entry.action,
                            outcome: RestoreItemOutcome::Failed,
                            reason: Some(detail),
                        },
                    }
                }
                RestoreAction::Delete => match self.delete_path(&context, &entry.path).await {
                    Ok(()) => RestoreItemResult {
                        path: entry.path.clone(),
                        action: entry.action,
                        outcome: RestoreItemOutcome::Deleted,
                        reason: None,
                    },
                    Err(detail) => RestoreItemResult {
                        path: entry.path.clone(),
                        action: entry.action,
                        outcome: RestoreItemOutcome::Failed,
                        reason: Some(detail),
                    },
                },
            };
            results.push(outcome);
        }

        // Concurrent writes are allowed during restore (no write lock), so every
        // executed path is re-checked against the target slice and flagged.
        let suspects = match self.find_suspects(&context, &target, &results).await {
            Ok(suspects) => suspects,
            Err(error) => {
                warn!(
                    workspace_id,
                    slice_ref,
                    error = %error,
                    "restore suspect verification failed (per-path results are authoritative)"
                );
                Vec::new()
            }
        };
        let suspect_set: HashSet<&str> = suspects.iter().map(String::as_str).collect();
        for result in &mut results {
            if suspect_set.contains(result.path.as_str()) {
                result.outcome = RestoreItemOutcome::Suspect;
            }
        }
        let counts = result_counts(&results);
        info!(
            workspace_id,
            slice_ref,
            restored = counts.restored,
            deleted = counts.deleted,
            failed = counts.failed,
            suspects = suspects.len(),
            "checkpoint restore executed"
        );
        Ok(RestoreResult {
            slice_ref: target.slice_ref,
            commit: target.commit,
            entries: results,
            counts,
            duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            suspects,
        })
    }

    /// Read one blob out of a slice tree (slice detail endpoint).
    ///
    /// The path must be workspace-relative and normal, and must name a regular
    /// file in the slice tree; blobs above `max_bytes` are rejected before any
    /// content is read.
    pub async fn slice_blob(
        &self,
        workspace_id: &str,
        slice_ref: &str,
        path: &str,
        max_bytes: u64,
    ) -> Result<SliceBlob> {
        validate_relative_path(path).map_err(|detail| RestoreError::InvalidRequest { detail })?;
        let context = self
            .resolve_restore_context(workspace_id, slice_ref)
            .await?;
        let target = self.resolve_slice_target(&context, slice_ref).await?;
        let spec = literal_pathspec(path);
        let listing = self
            .run_git_checked(
                &["ls-tree", "-l", "-z", &target.commit, "--", spec.as_str()],
                &context.env,
                None,
                self.call_timeout,
            )
            .await
            .map_err(restore_git_failure)?;
        let entry = parse_tree_entry(&listing, path)?;
        if entry.size > max_bytes {
            return Err(RestoreError::BlobTooLarge {
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
            .map_err(restore_git_failure)?;
        Ok(SliceBlob {
            path: path.to_string(),
            content,
        })
    }

    /// Git availability, workspace directory and shadow resolution shared by every
    /// restore read (the slice ref is resolved by the caller against `context.env`).
    async fn resolve_restore_context(
        &self,
        workspace_id: &str,
        slice_ref: &str,
    ) -> Result<RestoreContext> {
        let capability = self.probe().await;
        if !capability.available {
            return Err(RestoreError::Unavailable {
                reason: git_unavailable_reason(&capability.version),
                detail: capability.detail,
            });
        }
        if validate_workspace_id(workspace_id).is_err() {
            return Err(RestoreError::SliceNotFound(slice_ref.to_string()));
        }
        let work_tree = self
            .work_tree(workspace_id)
            .map_err(|error| RestoreError::Failed(error.to_string()))?;
        if !work_tree.is_dir() {
            return Err(RestoreError::Unavailable {
                reason: RESTORE_REASON_WORKSPACE_UNKNOWN,
                detail: format!(
                    "workspace directory does not exist: {}",
                    normalize_for_message(&work_tree)
                ),
            });
        }
        let shadow = self
            .shadow_git_dir(workspace_id)
            .map_err(|error| RestoreError::Failed(error.to_string()))?;
        if !shadow.is_dir() {
            return Err(RestoreError::SliceNotFound(slice_ref.to_string()));
        }
        let env = self.isolated_env(&shadow, &work_tree, None);
        Ok(RestoreContext {
            shadow,
            work_tree,
            env,
        })
    }

    /// Resolve the target slice commit + tree; unknown or malformed refs are 404.
    async fn resolve_slice_target(
        &self,
        context: &RestoreContext,
        slice_ref: &str,
    ) -> Result<SliceTarget> {
        if parse_slice_ref(slice_ref).is_none() {
            return Err(RestoreError::SliceNotFound(slice_ref.to_string()));
        }
        let commit = self
            .rev_parse(&context.env, slice_ref)
            .await
            .map_err(restore_git_failure)?
            .ok_or_else(|| RestoreError::SliceNotFound(slice_ref.to_string()))?;
        let tree = self
            .rev_parse(&context.env, &format!("{commit}^{{tree}}"))
            .await
            .map_err(restore_git_failure)?
            .ok_or_else(|| RestoreError::SliceNotFound(slice_ref.to_string()))?;
        Ok(SliceTarget {
            slice_ref: slice_ref.to_string(),
            commit,
            tree,
        })
    }
    /// Batched plan: stage the current workspace into a temp index with the usual
    /// exclusions, then diff the target slice tree against that current tree.
    async fn plan_restore(
        &self,
        context: &RestoreContext,
        target: &SliceTarget,
    ) -> Result<Vec<PlannedEntry>> {
        let token = format!(
            "plan.{}.{}",
            std::process::id(),
            SCRATCH_COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let index = scratch_index_path(&context.shadow, &token);
        let excludes = scratch_excludes_path(&context.shadow, &token);
        let _scratch = ScratchFiles::new(vec![index.clone(), excludes.clone()]);
        // Seed the temp index from the chain tail so the current tree is exactly
        // what a capture would write now (dynamic size cap and exclusions only
        // judge genuinely new paths; already-indexed paths stay included).
        let reference_tree = match self
            .slice_tail(&context.env)
            .await
            .map_err(restore_git_failure)?
        {
            Some(row) => Some(
                self.tree_of(&context.env, &row.commit)
                    .await
                    .map_err(restore_git_failure)?,
            ),
            None => None,
        };
        self.stage_index(
            &context.shadow,
            &context.work_tree,
            &index,
            &excludes,
            reference_tree.as_deref(),
        )
        .await
        .map_err(restore_git_failure)?;
        let index_env = self.isolated_env(&context.shadow, &context.work_tree, Some(&index));
        let current_tree = self
            .write_tree(&index_env)
            .await
            .map_err(restore_git_failure)?;
        let changed = self
            .changed_files_for(&index_env, &target.tree, &current_tree)
            .await
            .map_err(restore_git_failure)?;

        let mut planned = Vec::with_capacity(changed.len());
        for file in changed {
            let class = file.status.chars().next().unwrap_or('?');
            let action = if class == 'A' {
                RestoreAction::Delete
            } else {
                RestoreAction::Restore
            };
            let (state, reason) = self
                .classify_entry(&context.work_tree, action, class, &file.path)
                .await;
            planned.push(PlannedEntry {
                path: file.path,
                action,
                state,
                reason,
            });
        }
        Ok(planned)
    }

    /// Classify one diff entry: `T` is a git-level type change, and a file that
    /// now sits where the slice has a directory (or a file blocking a slice
    /// directory) is a file ↔ directory type change.
    async fn classify_entry(
        &self,
        work_tree: &Path,
        action: RestoreAction,
        class: char,
        path: &str,
    ) -> (RestoreEntryState, Option<String>) {
        if class == 'T' {
            return (
                RestoreEntryState::TypeConflict,
                Some(TYPE_CHANGE_REASON.to_string()),
            );
        }
        if action == RestoreAction::Restore {
            if let Ok(metadata) = tokio::fs::symlink_metadata(worktree_path(work_tree, path)).await
                && metadata.is_dir()
            {
                return (
                    RestoreEntryState::TypeConflict,
                    Some(TYPE_CHANGE_REASON.to_string()),
                );
            }
            if ancestor_is_not_a_directory(work_tree, path).await {
                return (
                    RestoreEntryState::TypeConflict,
                    Some(TYPE_CHANGE_REASON.to_string()),
                );
            }
        }
        (RestoreEntryState::Execute, None)
    }

    /// Restore one path from the target slice commit with the scratch index.
    async fn restore_path(
        &self,
        context: &RestoreContext,
        commit: &str,
        path: &str,
        index: &Path,
    ) -> std::result::Result<(), String> {
        validate_relative_path(path)?;
        let env = self.isolated_env(&context.shadow, &context.work_tree, Some(index));
        let spec = literal_pathspec(path);
        let args = ["checkout", commit, "--", spec.as_str()];
        self.run_git_checked(&args, &env, Some(&context.work_tree), self.call_timeout)
            .await
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// Delete one workspace path (fs unlink) and prune directories it left empty.
    async fn delete_path(
        &self,
        context: &RestoreContext,
        path: &str,
    ) -> std::result::Result<(), String> {
        let absolute = join_worktree_path(&context.work_tree, path)?;
        tokio::fs::remove_file(&absolute)
            .await
            .map_err(|error| format!("failed to delete {path}: {error}"))?;
        prune_empty_dirs(&context.work_tree, path).await;
        Ok(())
    }

    /// Re-check every executed path against the target slice.
    ///
    /// Restored paths are compared to the slice tree through a scratch index
    /// (`read-tree <sliceTree>` + chunked `diff --name-only`); deleted paths are
    /// checked for absence, because untracked files never show up in a git diff.
    async fn find_suspects(
        &self,
        context: &RestoreContext,
        target: &SliceTarget,
        results: &[RestoreItemResult],
    ) -> Result<Vec<String>> {
        let mut restored_paths = Vec::new();
        let mut deleted_paths = Vec::new();
        for result in results {
            if !matches!(
                result.outcome,
                RestoreItemOutcome::Restored | RestoreItemOutcome::Deleted
            ) {
                continue;
            }
            match result.action {
                RestoreAction::Restore => restored_paths.push(result.path.clone()),
                RestoreAction::Delete => deleted_paths.push(result.path.clone()),
            }
        }
        let mut suspects = Vec::new();
        if !restored_paths.is_empty() {
            let scratch = ScratchIndex::create(&context.shadow);
            let env = self.isolated_env(&context.shadow, &context.work_tree, Some(&scratch.path));
            self.run_git_checked(&["read-tree", &target.tree], &env, None, self.call_timeout)
                .await
                .map_err(restore_git_failure)?;
            for chunk in restored_paths.chunks(PATHSPEC_CHUNK) {
                let specs: Vec<String> = chunk.iter().map(|path| literal_pathspec(path)).collect();
                let mut args: Vec<&str> = vec!["diff", "--no-renames", "--name-only", "-z", "--"];
                args.extend(specs.iter().map(String::as_str));
                let stdout = self
                    .run_git_checked(&args, &env, Some(&context.work_tree), self.call_timeout)
                    .await
                    .map_err(restore_git_failure)?;
                for raw in stdout.split(|byte| *byte == 0) {
                    if !raw.is_empty() {
                        suspects.push(String::from_utf8_lossy(raw).into_owned());
                    }
                }
            }
        }
        for path in deleted_paths {
            if tokio::fs::symlink_metadata(worktree_path(&context.work_tree, &path))
                .await
                .is_ok()
            {
                suspects.push(path);
            }
        }
        suspects.sort();
        suspects.dedup();
        Ok(suspects)
    }
}

/// `(restore, delete, type_conflict)` over the full plan; `restore`/`delete`
/// count by action (type conflicts included), `type_conflict` by state.
fn preview_counts(entries: &[RestorePreviewEntry]) -> RestorePreviewCounts {
    let mut counts = RestorePreviewCounts::default();
    for entry in entries {
        match entry.action {
            RestoreAction::Restore => counts.restore += 1,
            RestoreAction::Delete => counts.delete += 1,
        }
        if entry.state == RestoreEntryState::TypeConflict {
            counts.type_conflict += 1;
        }
    }
    counts
}

fn result_counts(results: &[RestoreItemResult]) -> RestoreResultCounts {
    let mut counts = RestoreResultCounts::default();
    for result in results {
        match result.outcome {
            RestoreItemOutcome::Restored => counts.restored += 1,
            RestoreItemOutcome::Deleted => counts.deleted += 1,
            RestoreItemOutcome::Failed | RestoreItemOutcome::Suspect => {}
        }
        if result.outcome == RestoreItemOutcome::Failed {
            counts.failed += 1;
        }
    }
    counts
}

/// Every `TypeConflict` entry must be acknowledged by exact path; the ack list may
/// arrive with Windows separators or a `./` prefix.
fn ensure_type_changes_acknowledged(
    planned: &[PlannedEntry],
    acknowledge_type_changes: &[String],
) -> Result<()> {
    let acknowledged: HashSet<String> = acknowledge_type_changes
        .iter()
        .map(|path| normalize_ack_path(path))
        .collect();
    let mut unacknowledged = Vec::new();
    for entry in planned {
        if entry.state == RestoreEntryState::TypeConflict && !acknowledged.contains(&entry.path) {
            unacknowledged.push(entry.path.clone());
        }
    }
    if unacknowledged.is_empty() {
        Ok(())
    } else {
        Err(RestoreError::TypeChangesUnacknowledged {
            paths: unacknowledged,
        })
    }
}

fn normalize_ack_path(path: &str) -> String {
    let trimmed = path.trim().replace('\\', "/");
    trimmed.strip_prefix("./").unwrap_or(&trimmed).to_string()
}

/// `true` when any ancestor of `path` exists and is not a directory (a file
/// blocking a slice directory is a file ↔ directory type change).
async fn ancestor_is_not_a_directory(work_tree: &Path, path: &str) -> bool {
    let mut current = work_tree.to_path_buf();
    let mut segments = path.split('/').peekable();
    while let Some(segment) = segments.next() {
        if segments.peek().is_none() {
            break;
        }
        current.push(segment);
        match tokio::fs::symlink_metadata(&current).await {
            Ok(metadata) => {
                if !metadata.is_dir() {
                    return true;
                }
            }
            Err(_) => return false,
        }
    }
    false
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

/// Reject absolute paths, drive prefixes, backslashes, empty segments and `.`/`..`
/// before any fs or pathspec use (defence in depth: paths come from the shadow diff,
/// which never emits them).
fn validate_relative_path(path: &str) -> std::result::Result<(), String> {
    if path.is_empty() {
        return Err("empty restore path rejected".to_string());
    }
    if path.contains('\\') {
        return Err(format!("backslash in restore path rejected: {path:?}"));
    }
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        return Err(format!("absolute restore path rejected: {path}"));
    }
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(format!(
                "non-normal path segment {segment:?} rejected in restore path {path:?}"
            ));
        }
    }
    for component in candidate.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(format!(
                "non-normal path component {component:?} rejected in restore path {path:?}"
            ));
        }
    }
    Ok(())
}

/// Workspace-relative join without validation (diff-sourced paths only).
fn worktree_path(work_tree: &Path, relative: &str) -> PathBuf {
    work_tree.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR))
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

/// Parse the single `git ls-tree -l -z <commit> -- :(literal)<path>` record.
///
/// A missing record is [`RestoreError::PathNotFound`]; a record whose listed path
/// is not the requested one (a directory pathspec expands to its children) or
/// whose entry is not a regular file (tree, symlink, gitlink) is
/// [`RestoreError::InvalidRequest`].
fn parse_tree_entry(listing: &[u8], path: &str) -> Result<TreeEntry> {
    let field = listing
        .split(|byte| *byte == 0)
        .find(|field| !field.is_empty());
    let Some(field) = field else {
        return Err(RestoreError::PathNotFound {
            path: path.to_string(),
        });
    };
    // Entry format: `<mode> <type> <oid> <size>\t<path>` (size is `-` for trees).
    let Some(tab) = field.iter().position(|byte| *byte == b'\t') else {
        return Err(RestoreError::InvalidRequest {
            detail: format!("unparsable tree entry for {path}"),
        });
    };
    let (header, listed_path) = (&field[..tab], &field[tab + 1..]);
    if listed_path != path.as_bytes() {
        return Err(RestoreError::InvalidRequest {
            detail: format!("{path} is not a file in the slice tree"),
        });
    }
    let header = String::from_utf8_lossy(header);
    let mut parts = header.split_whitespace();
    let mode = parts.next().unwrap_or_default();
    let kind = parts.next().unwrap_or_default();
    let oid = parts.next().unwrap_or_default().to_string();
    if kind != "blob" || !(mode == "100644" || mode == "100755") {
        return Err(RestoreError::InvalidRequest {
            detail: format!("unsupported tree entry ({mode} {kind}) at {path}"),
        });
    }
    let size = parts
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| RestoreError::InvalidRequest {
            detail: format!("missing blob size for {path}"),
        })?;
    Ok(TreeEntry { oid, size })
}

fn git_unavailable_reason(version: &Option<String>) -> &'static str {
    if version.is_some() {
        RESTORE_REASON_GIT_TOO_OLD
    } else {
        RESTORE_REASON_GIT_UNAVAILABLE
    }
}

fn restore_git_failure(error: CheckpointError) -> RestoreError {
    match error {
        CheckpointError::GitUnavailable(detail) => RestoreError::Unavailable {
            reason: RESTORE_REASON_GIT_UNAVAILABLE,
            detail,
        },
        CheckpointError::WorkspaceMissing(detail) => RestoreError::Unavailable {
            reason: RESTORE_REASON_WORKSPACE_UNKNOWN,
            detail,
        },
        other => RestoreError::Failed(other.to_string()),
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
                "restore tests require a real host git >= 2.20: {capability:?}"
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

        fn mtime_ms(&self, relative: &str) -> u64 {
            let metadata = std::fs::metadata(self.ws().join(relative)).expect("fixture metadata");
            metadata
                .modified()
                .expect("fixture mtime")
                .duration_since(std::time::UNIX_EPOCH)
                .expect("mtime after epoch")
                .as_millis() as u64
        }

        async fn capture(&self, run_id: &str) -> String {
            self.engine
                .capture(WS, run_id, "fixture", "call-fixture", false)
                .await
                .expect("fixture capture")
                .slice_ref
                .expect("fixture capture always writes a slice")
        }

        async fn execute(&self, slice_ref: &str) -> RestoreResult {
            self.engine
                .restore_execute(WS, slice_ref, &[])
                .await
                .expect("fixture restore")
        }
    }

    #[test]
    fn checkpoint_restore_path_validation_and_literal_pathspec() {
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
    fn checkpoint_restore_type_change_ack_gate_requires_exact_paths() {
        let entry = |path: &str, state: RestoreEntryState| PlannedEntry {
            path: path.to_string(),
            action: RestoreAction::Restore,
            state,
            reason: (state == RestoreEntryState::TypeConflict)
                .then(|| TYPE_CHANGE_REASON.to_string()),
        };
        let planned = vec![
            entry("a/b.txt", RestoreEntryState::TypeConflict),
            entry("ok.txt", RestoreEntryState::Execute),
        ];
        match ensure_type_changes_acknowledged(&planned, &[]) {
            Err(RestoreError::TypeChangesUnacknowledged { paths }) => {
                assert_eq!(paths, vec!["a/b.txt".to_string()]);
            }
            other => panic!("expected TypeChangesUnacknowledged, got {other:?}"),
        }
        // Windows separators and `./` prefixes are normalized before matching.
        assert!(ensure_type_changes_acknowledged(&planned, &["./a\\b.txt".to_string()]).is_ok());
        // Acknowledging unrelated paths does not satisfy the gate.
        assert!(matches!(
            ensure_type_changes_acknowledged(&planned, &["other.txt".to_string()]),
            Err(RestoreError::TypeChangesUnacknowledged { .. })
        ));
        // Execute entries never need an acknowledgement.
        assert!(
            ensure_type_changes_acknowledged(&planned[1..], &[]).is_ok(),
            "only type conflicts are gated"
        );
    }

    #[test]
    fn checkpoint_restore_counts_keep_suspects_out_of_restored_and_deleted() {
        let results = vec![
            RestoreItemResult {
                path: "a.txt".to_string(),
                action: RestoreAction::Restore,
                outcome: RestoreItemOutcome::Restored,
                reason: None,
            },
            RestoreItemResult {
                path: "b.txt".to_string(),
                action: RestoreAction::Delete,
                outcome: RestoreItemOutcome::Suspect,
                reason: None,
            },
            RestoreItemResult {
                path: "c.txt".to_string(),
                action: RestoreAction::Delete,
                outcome: RestoreItemOutcome::Failed,
                reason: Some("io".to_string()),
            },
        ];
        let counts = result_counts(&results);
        assert_eq!(counts.restored, 1);
        assert_eq!(counts.deleted, 0);
        assert_eq!(counts.failed, 1);

        let entries = [
            RestorePreviewEntry {
                path: "a.txt".to_string(),
                action: RestoreAction::Restore,
                state: RestoreEntryState::Execute,
                reason: None,
            },
            RestorePreviewEntry {
                path: "b.txt".to_string(),
                action: RestoreAction::Delete,
                state: RestoreEntryState::Execute,
                reason: None,
            },
            RestorePreviewEntry {
                path: "p".to_string(),
                action: RestoreAction::Restore,
                state: RestoreEntryState::TypeConflict,
                reason: Some(TYPE_CHANGE_REASON.to_string()),
            },
        ];
        let preview = preview_counts(&entries);
        assert_eq!(preview.restore, 2, "action counts include type conflicts");
        assert_eq!(preview.delete, 1);
        assert_eq!(preview.type_conflict, 1);
    }

    #[tokio::test]
    async fn checkpoint_restore_preview_and_execute_are_git_native() {
        let fixture = Fixture::new().await;
        fixture.write("a.txt", "a-base");
        fixture.write("b.txt", "b-base");
        fixture.write("dir/c.txt", "c-base");
        let slice = fixture.capture("run-1").await;

        // The run (or later writes) changed M, D and A paths.
        fixture.write("a.txt", "a-changed");
        fixture.remove("b.txt");
        fixture.write("dir/c.txt", "c-changed");
        fixture.write("new/deep.txt", "new");

        let preview = fixture
            .engine
            .restore_preview(WS, &slice)
            .await
            .expect("preview");
        assert_eq!(preview.commit.len(), 40);
        assert_eq!(preview.counts.restore, 3, "M/M/D are restores");
        assert_eq!(preview.counts.delete, 1, "A is a delete");
        assert_eq!(preview.counts.type_conflict, 0);
        let mut entries: Vec<(String, String, String)> = preview
            .entries
            .iter()
            .map(|entry| {
                (
                    entry.path.clone(),
                    entry.action.as_str().to_string(),
                    entry.state.as_str().to_string(),
                )
            })
            .collect();
        entries.sort();
        assert_eq!(
            entries,
            vec![
                (
                    "a.txt".to_string(),
                    "restore".to_string(),
                    "execute".to_string()
                ),
                (
                    "b.txt".to_string(),
                    "restore".to_string(),
                    "execute".to_string()
                ),
                (
                    "dir/c.txt".to_string(),
                    "restore".to_string(),
                    "execute".to_string()
                ),
                (
                    "new/deep.txt".to_string(),
                    "delete".to_string(),
                    "execute".to_string()
                ),
            ]
        );

        let result = fixture.execute(&slice).await;
        assert_eq!(result.counts.restored, 3);
        assert_eq!(result.counts.deleted, 1);
        assert_eq!(result.counts.failed, 0);
        assert!(result.suspects.is_empty());
        assert_eq!(fixture.read("a.txt"), "a-base");
        assert_eq!(fixture.read("b.txt"), "b-base");
        assert_eq!(fixture.read("dir/c.txt"), "c-base");
        assert!(!fixture.exists("new/deep.txt"));
        assert!(
            !fixture.ws().join("new").exists(),
            "empty directories left by the restore are pruned"
        );

        // A replay finds an empty plan: the workspace already matches the slice.
        let replay_preview = fixture
            .engine
            .restore_preview(WS, &slice)
            .await
            .expect("replay preview");
        assert!(replay_preview.entries.is_empty());
        assert_eq!(replay_preview.counts.restore, 0);
        assert_eq!(replay_preview.counts.delete, 0);
        let replay = fixture.execute(&slice).await;
        assert!(replay.entries.is_empty());
        assert_eq!(replay.counts.restored, 0);
        assert_eq!(replay.counts.deleted, 0);
        assert_eq!(replay.counts.failed, 0);
    }

    #[tokio::test]
    async fn checkpoint_restore_never_touches_excluded_paths() {
        let fixture = Fixture::new().await;
        fixture.write(".env", "SECRET=base");
        fixture.write("node_modules/dep.txt", "dependency-base");
        fixture.write("tracked.txt", "tracked-base");
        let slice = fixture.capture("run-1").await;

        fixture.write("tracked.txt", "tracked-changed");
        fixture.write(".env", "SECRET=changed");
        fixture.write("node_modules/dep.txt", "dependency-changed");
        let env_mtime = fixture.mtime_ms(".env");
        let dep_mtime = fixture.mtime_ms("node_modules/dep.txt");

        let preview = fixture
            .engine
            .restore_preview(WS, &slice)
            .await
            .expect("preview");
        assert_eq!(preview.counts.restore, 1);
        assert_eq!(preview.counts.delete, 0);
        assert!(
            preview
                .entries
                .iter()
                .all(|entry| !entry.path.starts_with(".env")
                    && !entry.path.starts_with("node_modules")),
            "excluded paths never enter the plan: {:?}",
            preview.entries
        );

        let result = fixture.execute(&slice).await;
        assert_eq!(result.counts.restored, 1);
        assert_eq!(fixture.read("tracked.txt"), "tracked-base");
        assert_eq!(
            fixture.read(".env"),
            "SECRET=changed",
            "excluded paths are not restored"
        );
        assert_eq!(fixture.read("node_modules/dep.txt"), "dependency-changed");
        assert_eq!(fixture.mtime_ms(".env"), env_mtime);
        assert_eq!(fixture.mtime_ms("node_modules/dep.txt"), dep_mtime);
    }

    #[tokio::test]
    async fn checkpoint_restore_lock_rejects_a_second_restore_and_recovers() {
        let fixture = Fixture::new().await;
        fixture.write("m.txt", "m-base");
        let slice = fixture.capture("run-1").await;
        fixture.write("m.txt", "m-changed");

        let guard = fixture
            .engine
            .try_lock_restore(WS)
            .expect("fixture restore lock");
        match fixture.engine.restore_execute(WS, &slice, &[]).await {
            Err(RestoreError::RestoreLocked) => {}
            other => panic!("expected RestoreLocked, got {other:?}"),
        }
        assert_eq!(
            fixture.read("m.txt"),
            "m-changed",
            "a locked restore must not mutate the workspace"
        );
        drop(guard);

        let result = fixture.execute(&slice).await;
        assert_eq!(result.counts.restored, 1);
        assert_eq!(fixture.read("m.txt"), "m-base");
    }

    #[tokio::test]
    async fn checkpoint_restore_flags_suspects_for_paths_written_after_the_operation() {
        let fixture = Fixture::new().await;
        fixture.write("m.txt", "m-base");
        let slice = fixture.capture("run-1").await;
        fixture.write("m.txt", "m-changed");
        fixture.write("extra.txt", "extra");

        let context = fixture
            .engine
            .resolve_restore_context(WS, &slice)
            .await
            .expect("context");
        let target = fixture
            .engine
            .resolve_slice_target(&context, &slice)
            .await
            .expect("target");

        // Restore the modified path, then let a concurrent write win the race.
        fixture
            .engine
            .restore_execute(WS, &slice, &[])
            .await
            .expect("restore");
        assert_eq!(fixture.read("m.txt"), "m-base");
        fixture.write("m.txt", "concurrent-write");

        let results = vec![
            RestoreItemResult {
                path: "m.txt".to_string(),
                action: RestoreAction::Restore,
                outcome: RestoreItemOutcome::Restored,
                reason: None,
            },
            RestoreItemResult {
                path: "extra.txt".to_string(),
                action: RestoreAction::Delete,
                outcome: RestoreItemOutcome::Deleted,
                reason: None,
            },
        ];
        let suspects = fixture
            .engine
            .find_suspects(&context, &target, &results)
            .await
            .expect("suspects");
        assert_eq!(
            suspects,
            vec!["m.txt".to_string()],
            "a restored path written afterwards is a suspect"
        );

        // A deleted path that reappeared is a suspect too.
        fixture
            .engine
            .restore_execute(WS, &slice, &[])
            .await
            .expect("replay");
        assert!(!fixture.exists("extra.txt"));
        fixture.write("extra.txt", "written again");
        let results = vec![RestoreItemResult {
            path: "extra.txt".to_string(),
            action: RestoreAction::Delete,
            outcome: RestoreItemOutcome::Deleted,
            reason: None,
        }];
        let suspects = fixture
            .engine
            .find_suspects(&context, &target, &results)
            .await
            .expect("suspects");
        assert_eq!(suspects, vec!["extra.txt".to_string()]);
    }

    #[tokio::test]
    async fn checkpoint_restore_type_conflict_requires_ack_and_executes_after_deletes() {
        let fixture = Fixture::new().await;
        fixture.write("p", "p-base");
        let slice = fixture.capture("run-1").await;

        // The path became a directory containing a file (file → directory).
        fixture.remove("p");
        fixture.write("p/child.txt", "child");

        let preview = fixture
            .engine
            .restore_preview(WS, &slice)
            .await
            .expect("preview");
        assert_eq!(preview.counts.restore, 1);
        assert_eq!(preview.counts.delete, 1);
        assert_eq!(preview.counts.type_conflict, 1);
        let conflict = preview
            .entries
            .iter()
            .find(|entry| entry.state == RestoreEntryState::TypeConflict)
            .expect("type conflict entry");
        assert_eq!(conflict.path, "p");
        assert_eq!(conflict.reason.as_deref(), Some(TYPE_CHANGE_REASON));

        match fixture.engine.restore_execute(WS, &slice, &[]).await {
            Err(RestoreError::TypeChangesUnacknowledged { paths }) => {
                assert_eq!(paths, vec!["p".to_string()]);
            }
            other => panic!("expected TypeChangesUnacknowledged, got {other:?}"),
        }
        assert_eq!(
            fixture.read("p/child.txt"),
            "child",
            "the gate must precede mutation"
        );

        let result = fixture
            .engine
            .restore_execute(WS, &slice, &["p".to_string()])
            .await
            .expect("acknowledged restore");
        assert_eq!(result.counts.restored, 1);
        assert_eq!(result.counts.deleted, 1);
        assert_eq!(result.counts.failed, 0);
        assert!(!fixture.exists("p/child.txt"));
        assert_eq!(fixture.read("p"), "p-base", "the directory became a file");
    }

    #[tokio::test]
    async fn checkpoint_restore_slice_blob_reads_text_and_rejects_caps_and_non_files() {
        let fixture = Fixture::new().await;
        fixture.write("notes.md", "before\n");
        let first = fixture.capture("run-1").await;
        fixture.write("notes.md", "after\n");
        fixture.write("src/new.txt", "created\n");
        let oversized = "a".repeat(usize::try_from(MAX_BLOB_BYTES).expect("cap fits usize") + 1);
        fixture.write("big.txt", &oversized);
        let second = fixture.capture("run-2").await;

        let before = fixture
            .engine
            .slice_blob(WS, &first, "notes.md", MAX_BLOB_BYTES)
            .await
            .expect("first slice blob");
        assert_eq!(String::from_utf8(before.content).expect("utf8"), "before\n");
        let after = fixture
            .engine
            .slice_blob(WS, &second, "notes.md", MAX_BLOB_BYTES)
            .await
            .expect("second slice blob");
        assert_eq!(String::from_utf8(after.content).expect("utf8"), "after\n");

        match fixture
            .engine
            .slice_blob(WS, &first, "src/new.txt", MAX_BLOB_BYTES)
            .await
        {
            Err(RestoreError::PathNotFound { path }) => assert_eq!(path, "src/new.txt"),
            other => panic!("expected PathNotFound, got {other:?}"),
        }
        match fixture.engine.slice_blob(WS, &second, "notes.md", 3).await {
            Err(RestoreError::BlobTooLarge { size, max, path }) => {
                assert_eq!(size, 6);
                assert_eq!(max, 3);
                assert_eq!(path, "notes.md");
            }
            other => panic!("expected BlobTooLarge, got {other:?}"),
        }
        for path in ["../escape.txt", "dir\\file.txt", "/abs.txt"] {
            match fixture
                .engine
                .slice_blob(WS, &second, path, MAX_BLOB_BYTES)
                .await
            {
                Err(RestoreError::InvalidRequest { .. }) => {}
                other => panic!("expected InvalidRequest for {path:?}, got {other:?}"),
            }
        }
        match fixture
            .engine
            .slice_blob(WS, &second, "src", MAX_BLOB_BYTES)
            .await
        {
            Err(RestoreError::InvalidRequest { detail }) => {
                assert!(
                    detail.contains("tree"),
                    "directory entry rejected: {detail}"
                );
            }
            other => panic!("expected InvalidRequest for a directory, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn checkpoint_restore_unknown_and_malformed_slice_refs_are_not_found() {
        let fixture = Fixture::new().await;
        fixture.write("a.txt", "a");
        let slice = fixture.capture("run-1").await;
        let unknown = "refs/xihe/slices/1700000000000-0123456789abcdef0123456789abcdef01234567";

        for reference in [unknown, "refs/xihe/run-1/end", "not-a-ref"] {
            match fixture.engine.restore_preview(WS, reference).await {
                Err(RestoreError::SliceNotFound(_)) => {}
                other => panic!("expected SliceNotFound for {reference:?}, got {other:?}"),
            }
        }
        match fixture.engine.restore_execute(WS, unknown, &[]).await {
            Err(RestoreError::SliceNotFound(_)) => {}
            other => panic!("expected SliceNotFound, got {other:?}"),
        }
        match fixture
            .engine
            .slice_blob(WS, unknown, "a.txt", MAX_BLOB_BYTES)
            .await
        {
            Err(RestoreError::SliceNotFound(_)) => {}
            other => panic!("expected SliceNotFound, got {other:?}"),
        }

        // A missing workspace is an explicit unavailable, not an empty plan.
        let missing = TempDir::new().expect("tempdir");
        let missing_engine = ShadowGit::new(missing.path());
        match missing_engine.restore_preview(WS, &slice).await {
            Err(RestoreError::Unavailable { reason, .. }) => {
                assert_eq!(reason, RESTORE_REASON_WORKSPACE_UNKNOWN);
            }
            other => panic!("expected Unavailable, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn checkpoint_restore_probe_failure_maps_git_unavailable() {
        let temp = TempDir::new().expect("tempdir");
        std::fs::create_dir_all(temp.path().join(WS)).expect("workspace");
        let engine = ShadowGit::new(temp.path()).with_git_binary("xihe-runtime-missing-git-binary");
        match engine
            .restore_preview(
                WS,
                "refs/xihe/slices/1700000000000-0123456789abcdef0123456789abcdef01234567",
            )
            .await
        {
            Err(RestoreError::Unavailable { reason, .. }) => {
                assert_eq!(reason, RESTORE_REASON_GIT_UNAVAILABLE);
            }
            other => panic!("expected Unavailable, got {other:?}"),
        }
    }
}
