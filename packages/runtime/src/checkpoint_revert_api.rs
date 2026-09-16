//! PLAN-0338 slice model: restore + slice-blob + workspace-diff host API surface.
//!
//! Wires the restore engine ([`crate::checkpoint_revert`]) into the frozen Runtime
//! HTTP contract:
//!
//! - `revert/preview` is read-only: the git-native plan (restore/delete actions,
//!   type conflicts flagged, full counts) plus a bounded entry list with
//!   `truncated`; no lock is taken;
//! - `revert` executes per path, requires an explicit acknowledgement for every
//!   `type_conflict` path, fails fast with `CHECKPOINT_RESTORE_LOCKED` while
//!   another restore runs, and reports per-path outcomes plus the `suspects`
//!   written concurrently during the execution;
//! - `blob` serves one regular file of the slice tree as plain text (≤1 MiB);
//! - `git-status` projects the user repository's own porcelain status read-only
//!   (isolated env, no hooks) for the dual-diff separation (spec §6.4 / S4).
//!
//! The axum handlers in `main.rs` only map these outcomes to the frozen
//! Problem+JSON shapes; no control-plane or UI concept lives here.

use serde::Serialize;
use tracing::info;

use crate::checkpoint::{CheckpointError, WorkspaceGitStatus, validate_workspace_id};
use crate::checkpoint_api::{
    CheckpointService, REASON_GIT_FAILED, REASON_WORKSPACE_UNKNOWN, unavailable_reason,
};
use crate::checkpoint_revert::{
    MAX_BLOB_BYTES, RestoreError, RestoreItemOutcome, RestorePreview, RestoreResult,
};

/// Preview entry cap: the counts always cover the full plan, `truncated` marks a
/// shortened `entries` list (response-size guard for very large plans).
pub const MAX_PREVIEW_ENTRIES: usize = 1000;

/// One entry of the restore preview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreviewEntry {
    /// Workspace-relative path with forward slashes.
    pub path: String,
    /// `restore` (M/D) or `delete` (A).
    pub action: String,
    /// `execute` / `noop` / `type_conflict`.
    pub state: String,
    /// Frozen type-change reason (`TYPE_CHANGE`) when this entry is a conflict.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Preview counts over the full plan: `restore`/`delete` count by action
/// (type-conflict entries included), `typeConflict` counts by state.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreviewCounts {
    pub restore: usize,
    pub delete: usize,
    pub type_conflict: usize,
}

/// `POST .../checkpoints/revert/preview` 200 body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreviewOutcome {
    pub slice_ref: String,
    pub counts: RestorePreviewCounts,
    pub entries: Vec<RestorePreviewEntry>,
    /// `true` when `entries` was cut at [`MAX_PREVIEW_ENTRIES`].
    pub truncated: bool,
}

/// One entry of the restore execution result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreExecuteEntry {
    pub path: String,
    /// `restored` / `deleted` / `failed` / `suspect`.
    pub outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Execution counts (suspects are listed separately on the response).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreExecuteCounts {
    pub restored: usize,
    pub deleted: usize,
    pub failed: usize,
}

/// `POST .../checkpoints/revert` 200 body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreExecuteOutcome {
    pub slice_ref: String,
    pub counts: RestoreExecuteCounts,
    pub entries: Vec<RestoreExecuteEntry>,
    pub duration_ms: u64,
    /// Executed paths that no longer match the target slice (concurrent write).
    pub suspects: Vec<String>,
}

/// One blob read result; `content` is raw (text policy lives in the handler).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobOutcome {
    pub path: String,
    pub content: Vec<u8>,
}

/// `revert/preview` / `revert` failures mapped to 404 / 409 / 503.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestoreFailure {
    NotFound {
        detail: String,
    },
    TypeChangesUnacknowledged {
        paths: Vec<String>,
    },
    RestoreLocked,
    Unavailable {
        reason: &'static str,
        detail: String,
    },
}

/// Blob endpoint failures mapped to 400 / 404 / 413 / 503.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlobFailure {
    NotFound {
        detail: String,
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

impl CheckpointService {
    /// Read-only restore dry-run for one slice (no lock taken).
    pub async fn restore_preview(
        &self,
        workspace_id: &str,
        slice_ref: &str,
    ) -> Result<RestorePreviewOutcome, RestoreFailure> {
        let preview = self
            .engine()
            .restore_preview(workspace_id, slice_ref)
            .await
            .map_err(restore_failure)?;
        Ok(project_preview(preview))
    }

    /// Execute the restore of one slice.
    ///
    /// The engine holds the fail-fast restore lock for the execution only; every
    /// `type_conflict` entry must be acknowledged explicitly.
    pub async fn restore_execute(
        &self,
        workspace_id: &str,
        slice_ref: &str,
        acknowledge_type_changes: &[String],
    ) -> Result<RestoreExecuteOutcome, RestoreFailure> {
        let result = self
            .engine()
            .restore_execute(workspace_id, slice_ref, acknowledge_type_changes)
            .await
            .map_err(restore_failure)?;
        info!(
            workspace_id,
            slice_ref,
            restored = result.counts.restored,
            deleted = result.counts.deleted,
            failed = result.counts.failed,
            suspects = result.suspects.len(),
            "checkpoint restore executed via host API"
        );
        Ok(project_execute(result))
    }

    /// Read one regular file out of the slice tree.
    pub async fn slice_blob(
        &self,
        workspace_id: &str,
        slice_ref: &str,
        path: &str,
    ) -> Result<BlobOutcome, BlobFailure> {
        let blob = self
            .engine()
            .slice_blob(workspace_id, slice_ref, path, MAX_BLOB_BYTES)
            .await
            .map_err(blob_failure)?;
        Ok(BlobOutcome {
            path: blob.path,
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
fn project_preview(preview: RestorePreview) -> RestorePreviewOutcome {
    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in &preview.entries {
        if entries.len() >= MAX_PREVIEW_ENTRIES {
            truncated = true;
            break;
        }
        entries.push(RestorePreviewEntry {
            path: entry.path.clone(),
            action: entry.action.as_str().to_string(),
            state: entry.state.as_str().to_string(),
            reason: entry.reason.clone(),
        });
    }
    RestorePreviewOutcome {
        slice_ref: preview.slice_ref,
        counts: RestorePreviewCounts {
            restore: preview.counts.restore,
            delete: preview.counts.delete,
            type_conflict: preview.counts.type_conflict,
        },
        entries,
        truncated,
    }
}

/// Project the engine execution result into the frozen execute wire shape.
fn project_execute(result: RestoreResult) -> RestoreExecuteOutcome {
    RestoreExecuteOutcome {
        slice_ref: result.slice_ref,
        counts: RestoreExecuteCounts {
            restored: result.counts.restored,
            deleted: result.counts.deleted,
            failed: result.counts.failed,
        },
        entries: result
            .entries
            .into_iter()
            .map(|item| RestoreExecuteEntry {
                path: item.path,
                outcome: outcome_wire(item.outcome),
                reason: item.reason,
            })
            .collect(),
        duration_ms: result.duration_ms,
        suspects: result.suspects,
    }
}

fn outcome_wire(outcome: RestoreItemOutcome) -> String {
    match outcome {
        RestoreItemOutcome::Restored => "restored",
        RestoreItemOutcome::Deleted => "deleted",
        RestoreItemOutcome::Failed => "failed",
        RestoreItemOutcome::Suspect => "suspect",
    }
    .to_string()
}

fn restore_failure(error: RestoreError) -> RestoreFailure {
    match error {
        RestoreError::SliceNotFound(detail) => RestoreFailure::NotFound {
            detail: format!("no checkpoint slice for {detail}"),
        },
        RestoreError::TypeChangesUnacknowledged { paths } => {
            RestoreFailure::TypeChangesUnacknowledged { paths }
        }
        RestoreError::RestoreLocked => RestoreFailure::RestoreLocked,
        RestoreError::Unavailable { reason, detail } => {
            RestoreFailure::Unavailable { reason, detail }
        }
        other => RestoreFailure::Unavailable {
            reason: REASON_GIT_FAILED,
            detail: other.to_string(),
        },
    }
}

fn blob_failure(error: RestoreError) -> BlobFailure {
    match error {
        RestoreError::SliceNotFound(detail) => BlobFailure::NotFound {
            detail: format!("no checkpoint slice for {detail}"),
        },
        RestoreError::PathNotFound { path } => BlobFailure::NotFound {
            detail: format!("path {path} is not present in the slice tree"),
        },
        RestoreError::InvalidRequest { detail } => BlobFailure::Invalid { detail },
        RestoreError::BlobTooLarge { path, size, max } => BlobFailure::TooLarge { path, size, max },
        RestoreError::Unavailable { reason, detail } => BlobFailure::Unavailable { reason, detail },
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
        RestoreAction, RestoreEntryState, RestoreItemResult,
        RestorePreviewCounts as EnginePreviewCounts, RestoreResultCounts,
    };

    fn preview_with(entries: Vec<crate::checkpoint_revert::RestorePreviewEntry>) -> RestorePreview {
        let counts = EnginePreviewCounts {
            restore: entries
                .iter()
                .filter(|entry| entry.action == RestoreAction::Restore)
                .count(),
            delete: entries
                .iter()
                .filter(|entry| entry.action == RestoreAction::Delete)
                .count(),
            type_conflict: entries
                .iter()
                .filter(|entry| entry.state == RestoreEntryState::TypeConflict)
                .count(),
        };
        RestorePreview {
            slice_ref: "refs/xihe/slices/1-abc".to_string(),
            commit: "abc".to_string(),
            entries,
            counts,
        }
    }

    fn entry(
        path: &str,
        action: RestoreAction,
        state: RestoreEntryState,
    ) -> crate::checkpoint_revert::RestorePreviewEntry {
        crate::checkpoint_revert::RestorePreviewEntry {
            path: path.to_string(),
            action,
            state,
            reason: (state == RestoreEntryState::TypeConflict).then(|| "TYPE_CHANGE".to_string()),
        }
    }

    #[test]
    fn restore_preview_projection_maps_actions_states_and_truncation() {
        let outcome = project_preview(preview_with(vec![
            entry("a.txt", RestoreAction::Restore, RestoreEntryState::Execute),
            entry("b.txt", RestoreAction::Delete, RestoreEntryState::Execute),
            entry("p", RestoreAction::Restore, RestoreEntryState::TypeConflict),
        ]));
        assert_eq!(outcome.slice_ref, "refs/xihe/slices/1-abc");
        assert_eq!(
            outcome.counts,
            RestorePreviewCounts {
                restore: 2,
                delete: 1,
                type_conflict: 1,
            }
        );
        assert_eq!(outcome.entries[0].action, "restore");
        assert_eq!(outcome.entries[0].state, "execute");
        assert_eq!(outcome.entries[0].reason, None);
        assert_eq!(outcome.entries[1].action, "delete");
        assert_eq!(outcome.entries[2].state, "type_conflict");
        assert_eq!(outcome.entries[2].reason.as_deref(), Some("TYPE_CHANGE"));
        assert!(!outcome.truncated);

        let items: Vec<_> = (0..=MAX_PREVIEW_ENTRIES)
            .map(|index| {
                entry(
                    &format!("file-{index:05}.txt"),
                    RestoreAction::Restore,
                    RestoreEntryState::Execute,
                )
            })
            .collect();
        let total = items.len();
        let truncated = project_preview(preview_with(items));
        assert!(
            truncated.truncated,
            "overflowing entry lists must be flagged"
        );
        assert_eq!(truncated.entries.len(), MAX_PREVIEW_ENTRIES);
        assert_eq!(
            truncated.counts.restore, total,
            "counts cover the full plan"
        );
    }

    #[test]
    fn restore_execute_projection_maps_counts_outcomes_and_suspects() {
        let result = RestoreResult {
            slice_ref: "refs/xihe/slices/1-abc".to_string(),
            commit: "abc".to_string(),
            entries: vec![
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
                    action: RestoreAction::Restore,
                    outcome: RestoreItemOutcome::Failed,
                    reason: Some("io detail".to_string()),
                },
            ],
            counts: RestoreResultCounts {
                restored: 1,
                deleted: 0,
                failed: 1,
            },
            duration_ms: 12,
            suspects: vec!["b.txt".to_string()],
        };
        let outcome = project_execute(result);
        assert_eq!(outcome.slice_ref, "refs/xihe/slices/1-abc");
        assert_eq!(
            outcome.counts,
            RestoreExecuteCounts {
                restored: 1,
                deleted: 0,
                failed: 1,
            }
        );
        assert_eq!(outcome.entries[0].outcome, "restored");
        assert_eq!(outcome.entries[0].reason, None);
        assert_eq!(outcome.entries[1].outcome, "suspect");
        assert_eq!(outcome.entries[2].outcome, "failed");
        assert_eq!(outcome.entries[2].reason.as_deref(), Some("io detail"));
        assert_eq!(outcome.duration_ms, 12);
        assert_eq!(outcome.suspects, vec!["b.txt".to_string()]);
    }

    #[test]
    fn failure_mapping_projects_engine_errors_to_frozen_codes() {
        assert_eq!(
            restore_failure(RestoreError::SliceNotFound(
                "refs/xihe/slices/1-a".to_string()
            )),
            RestoreFailure::NotFound {
                detail: "no checkpoint slice for refs/xihe/slices/1-a".to_string()
            }
        );
        assert!(matches!(
            restore_failure(RestoreError::TypeChangesUnacknowledged {
                paths: vec!["p".to_string()]
            }),
            RestoreFailure::TypeChangesUnacknowledged { paths } if paths == vec!["p".to_string()]
        ));
        assert_eq!(
            restore_failure(RestoreError::RestoreLocked),
            RestoreFailure::RestoreLocked
        );
        assert!(matches!(
            restore_failure(RestoreError::Failed("boom".to_string())),
            RestoreFailure::Unavailable {
                reason: REASON_GIT_FAILED,
                ..
            }
        ));
        assert_eq!(
            blob_failure(RestoreError::PathNotFound {
                path: "a.txt".to_string()
            }),
            BlobFailure::NotFound {
                detail: "path a.txt is not present in the slice tree".to_string()
            }
        );
        assert_eq!(
            blob_failure(RestoreError::BlobTooLarge {
                path: "big.bin".to_string(),
                size: 10,
                max: 5,
            }),
            BlobFailure::TooLarge {
                path: "big.bin".to_string(),
                size: 10,
                max: 5,
            }
        );
    }
}
