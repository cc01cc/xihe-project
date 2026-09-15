//! PLAN-0328 M3 W1b: revert + workspace-diff host API surface.
//!
//! Wires the M3 revert engine ([`crate::checkpoint_revert`]) and the M2 mutation
//! lease registry ([`crate::checkpoint_api`]) into the frozen Runtime HTTP contract:
//!
//! - `revert/preview` is read-only: engine dry-run plus the recorded/current HEAD
//!   fingerprint triple, a bounded entry list with `truncated`, no lease taken;
//! - `revert` consults the workspace mutation lease first (synthetic owner
//!   `revert-<uuid>`, owner-scoped release on every path) in addition to the engine
//!   lock, so a live run blocks execution with `CHECKPOINT_LEASE_HELD`;
//! - `blob` serves one regular file of the run's base/end tree as bytes for a
//!   plain-text response (≤1 MiB, workspace-relative normal paths only);
//! - `git-status` projects the user repository's own porcelain status read-only
//!   (isolated env, no hooks) for the dual-diff separation (spec §6.4 / S4).
//!
//! The axum handlers in `main.rs` only map these outcomes to the frozen
//! Problem+JSON shapes; no control-plane or UI concept lives here.

use serde::{Deserialize, Serialize};
use tracing::info;

use crate::checkpoint::{
    CheckpointError, HeadFingerprint, HeadFingerprintStatus, WorkspaceGitStatus, validate_run_id,
    validate_workspace_id,
};
use crate::checkpoint_api::{
    CheckpointService, LeaseAcquire, MutationLeaseRegistry, REASON_GIT_FAILED,
    REASON_WORKSPACE_UNKNOWN, unavailable_reason,
};
use crate::checkpoint_revert::{
    MAX_BLOB_BYTES, RevertAcks, RevertBlobRef, RevertError, RevertItemOutcome, RevertPlanState,
    RevertPreview, RevertResult,
};

/// Preview entry cap: the counts always cover the full plan, `truncated` marks a
/// shortened `entries` list (response-size guard for very large runs).
pub const MAX_PREVIEW_ENTRIES: usize = 1000;

/// The `?ref=base|end` selector of the blob endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlobRef {
    Base,
    End,
}

impl BlobRef {
    fn engine_ref(self) -> RevertBlobRef {
        match self {
            Self::Base => RevertBlobRef::Base,
            Self::End => RevertBlobRef::End,
        }
    }
}

/// One entry of the revert preview: a pending `restore`/`delete`, or a conflict
/// carrying the frozen reason code. Noop items are counted but not listed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertPreviewEntry {
    /// Workspace-relative path with forward slashes.
    pub path: String,
    /// Rename source; the engine splits renames into independent delete/add items,
    /// so this field is currently never emitted (kept for wire stability).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub action: String,
    /// Frozen conflict reason (`CONTENT_CHANGED`) when this entry is skipped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict_reason: Option<String>,
}

/// Preview counts (wire names are frozen: `skipConflicts`, not the engine's internal
/// `conflicts`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertPreviewCounts {
    pub restore: usize,
    pub delete: usize,
    pub skip_conflicts: usize,
    pub noop: usize,
}

/// Recorded vs current HEAD fingerprint of the workspace user repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertHeadFingerprint {
    pub recorded: Option<HeadFingerprint>,
    pub current: Option<HeadFingerprint>,
    /// `ok` / `changed` / `unknown` / `not_repo` (decision #41 / S2).
    pub status: HeadFingerprintStatus,
}

/// `POST .../revert/preview` 200 body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertPreviewOutcome {
    pub run_id: String,
    /// Always `sealed`: preview requires the end ref.
    pub state: String,
    pub counts: RevertPreviewCounts,
    pub entries: Vec<RevertPreviewEntry>,
    pub head_fingerprint: RevertHeadFingerprint,
    /// Seal marker from the in-memory seal record; `false` when unknown (after a
    /// Runtime restart the CP row remains the durable projection).
    pub sealed_with_live_jobs: bool,
    /// `true` when `entries` was cut at [`MAX_PREVIEW_ENTRIES`].
    pub truncated: bool,
}

/// One entry of the revert execution result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertExecuteEntry {
    pub path: String,
    /// `restored` / `deleted` / `skippedConflict` / `failed` / `noop`.
    pub result: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Execution counts (wire names are frozen; the engine `total` is not exposed).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertExecuteCounts {
    pub restored: usize,
    pub deleted: usize,
    pub skipped_conflict: usize,
    pub failed: usize,
    pub noop: usize,
}

/// `POST .../revert` 200 body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertExecuteOutcome {
    pub run_id: String,
    /// `refs/xihe/<runId>/rollback/<epochMs>` audit ref; `null` when it could not
    /// be written (the per-item results remain authoritative).
    pub revert_ref: Option<String>,
    pub counts: RevertExecuteCounts,
    pub entries: Vec<RevertExecuteEntry>,
    pub duration_ms: u64,
}

/// One blob read result; `content` is raw (text policy lives in the handler).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobOutcome {
    pub path: String,
    pub reference: &'static str,
    pub content: Vec<u8>,
}

/// `revert/preview` / `revert` failures mapped to 404 / 409 / 503.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RevertFailure {
    NotFound {
        run_id: String,
    },
    NotSealed {
        run_id: String,
    },
    LeaseHeld {
        /// Workspace lease holder as recorded (`run-*` or the synthetic
        /// `revert-*` owner); `None` when only the engine lock was held.
        holder: Option<String>,
        expires_at_ms: Option<u64>,
    },
    HeadChanged {
        recorded: Option<HeadFingerprint>,
        observed: Option<HeadFingerprint>,
    },
    ConflictsUnacknowledged {
        paths: Vec<String>,
    },
    Unavailable {
        reason: &'static str,
        detail: String,
    },
}

/// Blob endpoint failures mapped to 400 / 404 / 409 / 413 / 503.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlobFailure {
    NotFound {
        detail: String,
    },
    NotSealed {
        run_id: String,
    },
    Invalid {
        detail: String,
    },
    TooLarge {
        path: String,
        size: u64,
        max: u64,
    },
    Unavailable {
        reason: &'static str,
        detail: String,
    },
}

/// `git-status` failures mapped to 400 / 503.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitStatusFailure {
    Validation {
        detail: String,
    },
    Unavailable {
        reason: &'static str,
        detail: String,
    },
}

/// Owner-scoped release of the synthetic revert lease: dropping the guard always
/// releases exactly the `owner` entry, on success, error and panic paths alike.
struct SyntheticLease<'a> {
    leases: &'a MutationLeaseRegistry,
    workspace_id: String,
    owner: String,
}

impl<'a> SyntheticLease<'a> {
    fn new(leases: &'a MutationLeaseRegistry, workspace_id: &str, owner: &str) -> Self {
        Self {
            leases,
            workspace_id: workspace_id.to_string(),
            owner: owner.to_string(),
        }
    }
}

impl Drop for SyntheticLease<'_> {
    fn drop(&mut self) {
        self.leases.release(&self.workspace_id, &self.owner);
    }
}

impl CheckpointService {
    /// Read-only revert dry-run for one sealed run (no lease).
    pub async fn revert_preview(
        &self,
        workspace_id: &str,
        run_id: &str,
    ) -> Result<RevertPreviewOutcome, RevertFailure> {
        validate_revert_pair(workspace_id, run_id)?;
        let preview = self
            .engine()
            .revert_preview(workspace_id, run_id)
            .await
            .map_err(revert_failure)?;
        let head = self
            .engine()
            .head_fingerprint_details(workspace_id, run_id)
            .await
            .map_err(revert_failure)?;
        Ok(project_preview(
            preview,
            head,
            self.sealed_with_live_jobs(workspace_id, run_id),
        ))
    }

    /// Execute the revert of one sealed run.
    ///
    /// Consulted leases: the workspace mutation registry first (synthetic owner
    /// `revert-<uuid>`, so a live run answers 409 `CHECKPOINT_LEASE_HELD`), then the
    /// engine's per-workspace lock inside `revert_execute`.
    pub async fn revert_execute(
        &self,
        workspace_id: &str,
        run_id: &str,
        acks: &RevertAcks,
    ) -> Result<RevertExecuteOutcome, RevertFailure> {
        validate_revert_pair(workspace_id, run_id)?;
        let owner = format!("revert-{}", uuid::Uuid::new_v4());
        match self.leases().try_acquire(workspace_id, &owner) {
            LeaseAcquire::HeldByOther(view) => {
                return Err(RevertFailure::LeaseHeld {
                    holder: Some(view.run_id),
                    expires_at_ms: Some(view.expires_at_ms),
                });
            }
            LeaseAcquire::Acquired { .. } => {}
        }
        let _lease = SyntheticLease::new(self.leases(), workspace_id, &owner);
        let result = self
            .engine()
            .revert_execute(workspace_id, run_id, acks)
            .await
            .map_err(revert_failure)?;
        info!(
            workspace_id,
            run_id,
            restored = result.counts.restored,
            deleted = result.counts.deleted,
            skipped_conflict = result.counts.skipped_conflict,
            failed = result.counts.failed,
            noop = result.counts.noop,
            "run revert executed via host API"
        );
        Ok(project_execute(result))
    }

    /// Read one regular file out of the run's base/end tree.
    pub async fn revert_blob(
        &self,
        workspace_id: &str,
        run_id: &str,
        reference: BlobRef,
        path: &str,
    ) -> Result<BlobOutcome, BlobFailure> {
        validate_workspace_id(workspace_id)
            .and_then(|()| validate_run_id(run_id))
            .map_err(|error| BlobFailure::Invalid {
                detail: error.to_string(),
            })?;
        let blob = self
            .engine()
            .revert_blob(
                workspace_id,
                run_id,
                reference.engine_ref(),
                path,
                MAX_BLOB_BYTES,
            )
            .await
            .map_err(|error| blob_failure(error, run_id))?;
        Ok(BlobOutcome {
            path: blob.path,
            reference: blob.reference,
            content: blob.content,
        })
    }

    /// Read-only user-repository `git status` (dual-diff "待提交" side).
    pub async fn git_status(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceGitStatus, GitStatusFailure> {
        validate_workspace_id(workspace_id).map_err(|error| GitStatusFailure::Validation {
            detail: error.to_string(),
        })?;
        match self.engine().workspace_git_status(workspace_id).await {
            Ok(status) => Ok(status),
            Err(CheckpointError::GitUnavailable(detail)) => {
                let capability = self.engine().probe().await;
                Err(GitStatusFailure::Unavailable {
                    reason: unavailable_reason(&capability.version),
                    detail,
                })
            }
            Err(CheckpointError::InvalidIdentifier { detail, .. }) => {
                Err(GitStatusFailure::Validation { detail })
            }
            Err(CheckpointError::WorkspaceMissing(detail)) => Err(GitStatusFailure::Unavailable {
                reason: REASON_WORKSPACE_UNKNOWN,
                detail,
            }),
            Err(other) => Err(GitStatusFailure::Unavailable {
                reason: REASON_GIT_FAILED,
                detail: other.to_string(),
            }),
        }
    }
}

/// Project the engine dry-run into the frozen preview wire shape.
fn project_preview(
    preview: RevertPreview,
    head: (
        HeadFingerprintStatus,
        Option<HeadFingerprint>,
        Option<HeadFingerprint>,
    ),
    sealed_with_live_jobs: bool,
) -> RevertPreviewOutcome {
    let mut entries = Vec::new();
    let mut truncated = false;
    for item in &preview.items {
        if item.state == RevertPlanState::Noop {
            continue;
        }
        if entries.len() >= MAX_PREVIEW_ENTRIES {
            truncated = true;
            break;
        }
        entries.push(RevertPreviewEntry {
            path: item.path.clone(),
            old_path: None,
            action: item.action.as_str().to_string(),
            conflict_reason: if item.state == RevertPlanState::Conflict {
                item.reason.clone()
            } else {
                None
            },
        });
    }
    RevertPreviewOutcome {
        run_id: preview.run_id,
        state: "sealed".to_string(),
        counts: RevertPreviewCounts {
            restore: preview.counts.restore,
            delete: preview.counts.delete,
            skip_conflicts: preview.counts.conflicts,
            noop: preview.counts.noop,
        },
        entries,
        head_fingerprint: RevertHeadFingerprint {
            recorded: head.1,
            current: head.2,
            status: head.0,
        },
        sealed_with_live_jobs,
        truncated,
    }
}

/// Project the engine execution result into the frozen execute wire shape.
fn project_execute(result: RevertResult) -> RevertExecuteOutcome {
    RevertExecuteOutcome {
        run_id: result.run_id,
        revert_ref: result.rollback_ref,
        counts: RevertExecuteCounts {
            restored: result.counts.restored,
            deleted: result.counts.deleted,
            skipped_conflict: result.counts.skipped_conflict,
            failed: result.counts.failed,
            noop: result.counts.noop,
        },
        entries: result
            .items
            .into_iter()
            .map(|item| RevertExecuteEntry {
                path: item.path,
                result: outcome_wire(item.outcome),
                reason: item.reason,
            })
            .collect(),
        duration_ms: result.duration_ms,
    }
}

fn outcome_wire(outcome: RevertItemOutcome) -> String {
    match outcome {
        RevertItemOutcome::Restored => "restored",
        RevertItemOutcome::Deleted => "deleted",
        RevertItemOutcome::SkippedConflict => "skippedConflict",
        RevertItemOutcome::Failed => "failed",
        RevertItemOutcome::Noop => "noop",
    }
    .to_string()
}

/// Malformed identifiers are reported as 404 `CHECKPOINT_NOT_FOUND` (the frozen
/// revert-endpoint vocabulary); the run id is echoed so the detail stays useful.
fn validate_revert_pair(workspace_id: &str, run_id: &str) -> Result<(), RevertFailure> {
    validate_workspace_id(workspace_id)
        .and_then(|()| validate_run_id(run_id))
        .map_err(|_| RevertFailure::NotFound {
            run_id: run_id.to_string(),
        })
}

fn revert_failure(error: RevertError) -> RevertFailure {
    match error {
        RevertError::NotFound(run_id) => RevertFailure::NotFound { run_id },
        RevertError::NotSealed(run_id) => RevertFailure::NotSealed { run_id },
        RevertError::HeadChanged { recorded, observed } => {
            RevertFailure::HeadChanged { recorded, observed }
        }
        RevertError::ConflictsUnacknowledged { paths } => {
            RevertFailure::ConflictsUnacknowledged { paths }
        }
        RevertError::Unavailable { reason, detail } => {
            RevertFailure::Unavailable { reason, detail }
        }
        RevertError::LeaseHeld => RevertFailure::LeaseHeld {
            holder: None,
            expires_at_ms: None,
        },
        other => RevertFailure::Unavailable {
            reason: REASON_GIT_FAILED,
            detail: other.to_string(),
        },
    }
}

fn blob_failure(error: RevertError, run_id: &str) -> BlobFailure {
    match error {
        RevertError::NotFound(_) => BlobFailure::NotFound {
            detail: format!("no checkpoint refs for run {run_id}"),
        },
        RevertError::NotSealed(run_id) => BlobFailure::NotSealed { run_id },
        RevertError::InvalidRequest { detail } => BlobFailure::Invalid { detail },
        RevertError::PathNotFound { reference, path } => BlobFailure::NotFound {
            detail: format!("path {path} is not present in the run's {reference} tree"),
        },
        RevertError::BlobTooLarge {
            path, size, max, ..
        } => BlobFailure::TooLarge { path, size, max },
        RevertError::Unavailable { reason, detail } => BlobFailure::Unavailable { reason, detail },
        other => BlobFailure::Unavailable {
            reason: REASON_GIT_FAILED,
            detail: other.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checkpoint_revert::{
        RevertAction, RevertItemResult, RevertPlanItem, RevertPreviewCounts as EnginePreviewCounts,
        RevertResultCounts, RevertTarget,
    };

    fn plan_item(path: &str, state: RevertPlanState, action: RevertAction) -> RevertPlanItem {
        RevertPlanItem {
            path: path.to_string(),
            action,
            target: match action {
                RevertAction::Restore => RevertTarget::Base,
                RevertAction::Delete => RevertTarget::Absent,
            },
            state,
            reason: (state == RevertPlanState::Conflict).then(|| "CONTENT_CHANGED".to_string()),
            observed_at: None,
        }
    }

    fn preview_with(items: Vec<RevertPlanItem>) -> RevertPreview {
        let counts = {
            let mut counts = EnginePreviewCounts::default();
            for item in &items {
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
        };
        RevertPreview {
            workspace_id: "ws".to_string(),
            run_id: "run-1".to_string(),
            base_commit: "base".to_string(),
            end_commit: "end".to_string(),
            head: HeadFingerprintStatus::Ok,
            items,
            counts,
        }
    }

    fn no_head() -> (
        HeadFingerprintStatus,
        Option<HeadFingerprint>,
        Option<HeadFingerprint>,
    ) {
        (
            HeadFingerprintStatus::NotRepo,
            Some(HeadFingerprint::default()),
            Some(HeadFingerprint::default()),
        )
    }

    #[test]
    fn revert_preview_projection_excludes_noop_and_maps_conflicts() {
        let outcome = project_preview(
            preview_with(vec![
                plan_item("a.txt", RevertPlanState::Execute, RevertAction::Restore),
                plan_item("gone.txt", RevertPlanState::Execute, RevertAction::Delete),
                plan_item(
                    "clash.txt",
                    RevertPlanState::Conflict,
                    RevertAction::Restore,
                ),
                plan_item("done.txt", RevertPlanState::Noop, RevertAction::Restore),
            ]),
            no_head(),
            true,
        );
        assert_eq!(outcome.run_id, "run-1");
        assert_eq!(outcome.state, "sealed");
        assert_eq!(
            outcome.counts,
            RevertPreviewCounts {
                restore: 1,
                delete: 1,
                skip_conflicts: 1,
                noop: 1,
            }
        );
        assert!(
            outcome.entries.iter().all(|entry| entry.path != "done.txt"),
            "noop items are counted but never listed: {:?}",
            outcome.entries
        );
        assert_eq!(outcome.entries.len(), 3);
        assert_eq!(outcome.entries[1].action, "delete");
        assert_eq!(
            outcome.entries[2].conflict_reason.as_deref(),
            Some("CONTENT_CHANGED")
        );
        assert_eq!(outcome.entries[0].conflict_reason, None);
        assert!(outcome.entries.iter().all(|entry| entry.old_path.is_none()));
        assert!(outcome.sealed_with_live_jobs);
        assert!(!outcome.truncated);
        assert_eq!(
            outcome.head_fingerprint.status,
            HeadFingerprintStatus::NotRepo
        );
    }

    #[test]
    fn revert_preview_projection_truncates_entries_at_the_cap() {
        let items: Vec<RevertPlanItem> = (0..=MAX_PREVIEW_ENTRIES)
            .map(|index| {
                plan_item(
                    &format!("file-{index:05}.txt"),
                    RevertPlanState::Execute,
                    RevertAction::Restore,
                )
            })
            .collect();
        let total = items.len();
        let outcome = project_preview(preview_with(items), no_head(), false);
        assert!(outcome.truncated, "overflowing entry lists must be flagged");
        assert_eq!(outcome.entries.len(), MAX_PREVIEW_ENTRIES);
        assert_eq!(outcome.counts.restore, total, "counts cover the full plan");
    }

    #[test]
    fn revert_execute_projection_maps_counts_and_results() {
        let result = RevertResult {
            workspace_id: "ws".to_string(),
            run_id: "run-1".to_string(),
            base_commit: "base".to_string(),
            end_commit: "end".to_string(),
            head: HeadFingerprintStatus::Ok,
            items: vec![
                RevertItemResult {
                    path: "a.txt".to_string(),
                    action: RevertAction::Restore,
                    outcome: RevertItemOutcome::Restored,
                    reason: None,
                    observed_at: None,
                },
                RevertItemResult {
                    path: "b.txt".to_string(),
                    action: RevertAction::Delete,
                    outcome: RevertItemOutcome::SkippedConflict,
                    reason: Some("CONTENT_CHANGED".to_string()),
                    observed_at: Some(7),
                },
            ],
            counts: RevertResultCounts {
                restored: 1,
                deleted: 0,
                skipped_conflict: 1,
                failed: 0,
                noop: 0,
                total: 2,
            },
            duration_ms: 12,
            rollback_ref: Some("refs/xihe/run-1/rollback/1".to_string()),
        };
        let outcome = project_execute(result);
        assert_eq!(
            outcome.revert_ref.as_deref(),
            Some("refs/xihe/run-1/rollback/1")
        );
        assert_eq!(outcome.counts.restored, 1);
        assert_eq!(outcome.counts.skipped_conflict, 1);
        assert_eq!(outcome.entries[0].result, "restored");
        assert_eq!(outcome.entries[0].reason, None);
        assert_eq!(outcome.entries[1].result, "skippedConflict");
        assert_eq!(
            outcome.entries[1].reason.as_deref(),
            Some("CONTENT_CHANGED")
        );
        assert_eq!(outcome.duration_ms, 12);
    }

    #[test]
    fn synthetic_lease_blocks_other_owners_and_releases_on_drop() {
        let registry = MutationLeaseRegistry::new();
        {
            let owner = "revert-synthetic";
            match registry.try_acquire("ws", owner) {
                LeaseAcquire::Acquired { fresh } => assert!(fresh),
                other => panic!("expected Acquired, got {other:?}"),
            }
            let _lease = SyntheticLease::new(&registry, "ws", owner);
            match registry.try_acquire("ws", "run-live") {
                LeaseAcquire::HeldByOther(view) => assert_eq!(view.run_id, owner),
                other => panic!("expected HeldByOther, got {other:?}"),
            }
        }
        assert!(
            matches!(
                registry.try_acquire("ws", "run-live"),
                LeaseAcquire::Acquired { fresh: true }
            ),
            "dropping the guard must release the synthetic lease"
        );
    }

    #[test]
    fn failure_mapping_projects_engine_errors_to_frozen_codes() {
        assert_eq!(
            revert_failure(RevertError::NotFound("run-1".to_string())),
            RevertFailure::NotFound {
                run_id: "run-1".to_string()
            }
        );
        assert_eq!(
            revert_failure(RevertError::NotSealed("run-1".to_string())),
            RevertFailure::NotSealed {
                run_id: "run-1".to_string()
            }
        );
        assert!(matches!(
            revert_failure(RevertError::ConflictsUnacknowledged {
                paths: vec!["a.txt".to_string()]
            }),
            RevertFailure::ConflictsUnacknowledged { paths } if paths == vec!["a.txt".to_string()]
        ));
        assert!(matches!(
            revert_failure(RevertError::LeaseHeld),
            RevertFailure::LeaseHeld {
                holder: None,
                expires_at_ms: None
            }
        ));
        assert!(matches!(
            revert_failure(RevertError::Failed("boom".to_string())),
            RevertFailure::Unavailable {
                reason: REASON_GIT_FAILED,
                ..
            }
        ));
        assert_eq!(
            blob_failure(
                RevertError::PathNotFound {
                    reference: "base",
                    path: "a.txt".to_string()
                },
                "run-1"
            ),
            BlobFailure::NotFound {
                detail: "path a.txt is not present in the run's base tree".to_string()
            }
        );
        assert_eq!(
            blob_failure(
                RevertError::BlobTooLarge {
                    reference: "end",
                    path: "big.bin".to_string(),
                    size: 10,
                    max: 5,
                },
                "run-1"
            ),
            BlobFailure::TooLarge {
                path: "big.bin".to_string(),
                size: 10,
                max: 5,
            }
        );
    }
}
