//! PLAN-0338: slice-model Run-checkpoint host API surface.
//!
//! Wires the shadow-git engine ([`crate::checkpoint`]) into the frozen Runtime
//! HTTP contract:
//!
//! - `capture` is the single capture point (Run terminal + abnormal re-capture +
//!   C0 at materialization): the engine writes at most one slice per call, and a
//!   tree equal to the chain tail produces `noChange` without writing a ref;
//! - same-run re-captures are idempotent within one Runtime process through an
//!   in-memory `(workspace, run) → sliceRef` map; after a restart the map is empty
//!   and a replay of an unchanged workspace reports `noChange` against the chain
//!   tail instead (documented limitation of the in-memory record);
//! - retention GC (decision #10: newest 50 slices + TTL 30 days per workspace)
//!   and the diagnostics projection (active capture/restore lock counts).
//!
//! The axum handlers in `main.rs` only map these outcomes to the frozen
//! Problem+JSON shapes; no control-plane or UI concept lives here.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex as StdMutex, PoisonError};

use serde::Serialize;
use tracing::{info, warn};

use crate::checkpoint::{
    CaptureOutcome, CheckpointError, CheckpointStorageMode, CleanupOutcome,
    DEFAULT_RETENTION_MAX_SLICES, DEFAULT_RETENTION_TTL_DAYS, NestedRepoPolicy, SHADOW_DIR_NAME,
    ShadowGit, validate_run_id, validate_workspace_id,
};
use crate::checkpoint_store::store::StoreError;

/// Reserved capture id of the workspace materialization baseline (C0).
///
/// The id is a plain 2-character run id, so it passes [`validate_run_id`] without
/// a special case; C0 captures flow through the same engine path as Run
/// terminal captures (best-effort, never blocking materialization).
pub const C0_RUN_ID: &str = "c0";

/// `CHECKPOINT_UNAVAILABLE` reasons (frozen CP-facing codes).
pub const REASON_GIT_UNAVAILABLE: &str = "GIT_UNAVAILABLE";
pub const REASON_GIT_TOO_OLD: &str = "GIT_TOO_OLD";
pub const REASON_GIT_FAILED: &str = "GIT_FAILED";
pub const REASON_WORKSPACE_UNKNOWN: &str = "WORKSPACE_UNKNOWN";
/// Capture rejected because nested repositories are present and the opt-in
/// hard limit (default off) is enabled; the detail lists the offending paths.
pub const REASON_NESTED_REPO_LIMIT: &str = "NESTED_REPO_LIMIT";

/// `POST .../checkpoints/gc` 200 body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GcOutcome {
    pub counts: GcCounts,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GcCounts {
    /// Slices removed by this sweep.
    pub deleted: usize,
    /// Slices kept by this sweep.
    pub kept: usize,
}

/// Diagnostics projection (no secrets; `gitVersion` may be absent).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointDiagnostics {
    pub git_version: Option<String>,
    pub capable: bool,
    pub shadow_root: String,
    /// Number of capture locks currently held (short capture operations only).
    pub active_capture_locks: usize,
    /// Number of restore locks currently held (second concurrent restore is
    /// rejected while this is non-zero).
    pub active_restore_locks: usize,
    /// Nested-repository policy token (`opaque` | `reject`).
    pub nested_repo_policy: &'static str,
    /// `git` (default) or `dual`; `self` is reserved for T2.
    pub checkpoint_storage: &'static str,
    /// Number of dual-write store attempts that failed since process start.
    pub store_failures: u64,
    /// Configured store root; absent for `git` mode.
    pub store_root: Option<String>,
}

/// `capture` failure mapped to the frozen HTTP statuses (400/503).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureFailure {
    /// 400: workspace or run identifier fails the frozen validation contract.
    Validation { detail: String },
    /// 503: git probe or workspace failure; `reason` is the frozen code.
    Unavailable {
        reason: &'static str,
        detail: String,
    },
}

/// `gc` failure (400/503).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GcFailure {
    Validation {
        detail: String,
    },
    Unavailable {
        reason: &'static str,
        detail: String,
    },
}

/// `cleanup` failure (400/409/503).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CleanupFailure {
    /// 400: workspace identifier fails the frozen validation contract.
    Validation { detail: String },
    /// 409: a capture or restore currently owns the workspace (no queueing).
    Busy,
    /// 503: git probe or workspace failure; `reason` is the frozen code.
    Unavailable {
        reason: &'static str,
        detail: String,
    },
}

/// Host-side Run-checkpoint service: single owner of the engine and the
/// in-memory same-run capture idempotency records.
///
/// `captures` is an in-memory map keyed `workspaceId/runId`: within one Runtime
/// process a replayed capture returns the identical body (verified against the
/// still-existing slice ref). After a restart the map is empty; replaying a run
/// whose workspace did not change since its slice reports `noChange` (the chain
/// tail already carries that tree) instead of minting a duplicate slice, while a
/// workspace that changed again produces a new slice. The CP row remains the
/// durable projection.
pub struct CheckpointService {
    engine: ShadowGit,
    captures: StdMutex<HashMap<String, CaptureOutcome>>,
    max_slices: usize,
    ttl_days: u64,
    auto_gc: bool,
}

impl CheckpointService {
    pub fn new(host_root: impl Into<PathBuf>) -> Self {
        Self {
            engine: ShadowGit::new(host_root),
            captures: StdMutex::new(HashMap::new()),
            max_slices: DEFAULT_RETENTION_MAX_SLICES,
            ttl_days: DEFAULT_RETENTION_TTL_DAYS,
            auto_gc: true,
        }
    }

    /// Test/embedding hook: override the host git binary (probe failures).
    pub fn with_git_binary(mut self, git_binary: impl Into<String>) -> Self {
        self.engine = self.engine.with_git_binary(git_binary);
        self
    }

    /// Test/embedding hook: override the retention policy (decision #10 defaults).
    pub fn with_retention(mut self, max_slices: usize, ttl_days: u64) -> Self {
        self.max_slices = max_slices;
        self.ttl_days = ttl_days;
        self
    }

    /// Test/embedding hook: disable the best-effort post-capture sweep.
    pub fn with_auto_gc(mut self, enabled: bool) -> Self {
        self.auto_gc = enabled;
        self
    }

    /// Test/embedding hook: opt into the nested-repository hard limit
    /// (default `Opaque`; `Reject` refuses captures with nested repositories).
    pub fn with_nested_repo_policy(mut self, policy: NestedRepoPolicy) -> Self {
        self.engine = self.engine.with_nested_repo_policy(policy);
        self
    }

    /// Configure P1 dual-write. `Store::init` runs now so a bad path/VERSION
    /// fails startup rather than surfacing only on the first capture.
    pub fn with_checkpoint_storage(
        mut self,
        mode: CheckpointStorageMode,
        store_root: impl AsRef<std::path::Path>,
    ) -> Result<Self, StoreError> {
        self.engine.configure_checkpoint_storage(mode, store_root)?;
        Ok(self)
    }

    pub fn engine(&self) -> &ShadowGit {
        &self.engine
    }

    /// PLAN-0470 (decision #17): refresh the effective work tree from the
    /// validated ExecutionSpec/materialized instance path before an operation.
    pub fn set_work_tree(&self, workspace_id: &str, path: PathBuf) {
        self.engine.set_work_tree_override(workspace_id, path);
    }

    /// PLAN-0639 M7 (VM11/VM13): register the ordered declared roots of one
    /// workspace `(root_id, host_path)`. This is what turns per-root capture from
    /// a naming convention into a routed operation: the engine learns both the
    /// shadow-repo key and the work tree of every root.
    pub fn set_declared_roots(&self, workspace_id: &str, roots: Vec<(String, String)>) {
        self.engine.set_declared_roots(workspace_id, roots);
    }

    /// Drops the declared-root registration of a destroyed/unmaterialized workspace.
    pub fn clear_declared_roots(&self, workspace_id: &str) {
        self.engine.clear_declared_roots(workspace_id);
    }

    /// The declared roots currently registered for one workspace.
    pub fn declared_roots(&self, workspace_id: &str) -> Vec<(String, String)> {
        self.engine.declared_roots(workspace_id)
    }

    /// Drops a stale work-tree override for a destroyed/unmaterialized workspace.
    pub fn clear_work_tree(&self, workspace_id: &str) {
        self.engine.clear_work_tree_override(workspace_id);
    }

    /// Capture the workspace as one checkpoint slice (the single capture point).
    ///
    /// PLAN-0639 M7 (VM11): the primary-root form; delegates to
    /// [`Self::capture_for_root`] with `root_id = workspace_id`, so a single-root
    /// workspace keeps the exact pre-M7 behavior (root[0].id == workspaceId).
    ///
    /// Idempotent per `(workspace, root, run)` within this process: a replay whose
    /// slice ref still resolves returns the recorded outcome unchanged.
    pub async fn capture(
        &self,
        workspace_id: &str,
        run_id: &str,
        actor: &str,
        call_id: &str,
        abnormal: bool,
    ) -> Result<CaptureOutcome, CaptureFailure> {
        self.capture_for_root(workspace_id, workspace_id, run_id, actor, call_id, abnormal)
            .await
    }

    /// PLAN-0639 M7 (VM11): capture **one declared root** into its own slice chain.
    ///
    /// The replay cache is keyed by `(workspace, root, run)` so two roots of the
    /// same workspace can be captured for the same run without one replaying the
    /// other's outcome.
    pub async fn capture_for_root(
        &self,
        workspace_id: &str,
        root_id: &str,
        run_id: &str,
        actor: &str,
        call_id: &str,
        abnormal: bool,
    ) -> Result<CaptureOutcome, CaptureFailure> {
        validate_workspace_id(workspace_id).map_err(|error| CaptureFailure::Validation {
            detail: error.to_string(),
        })?;
        validate_workspace_id(root_id).map_err(|error| CaptureFailure::Validation {
            detail: error.to_string(),
        })?;
        validate_run_id(run_id).map_err(|error| CaptureFailure::Validation {
            detail: error.to_string(),
        })?;
        let capability = self.engine.probe().await;
        if !capability.available {
            return Err(CaptureFailure::Unavailable {
                reason: unavailable_reason(&capability.version),
                detail: capability.detail,
            });
        }
        let key = capture_key(workspace_id, root_id, run_id);
        let existing = self
            .captures
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&key)
            .cloned();
        if let Some(record) = existing
            && let Some(slice_ref) = record.slice_ref.as_deref()
        {
            match self.engine.slice_commit(root_id, slice_ref).await {
                Ok(Some(_)) => return Ok(record),
                Ok(None) => {
                    // The slice was reclaimed (retention) or the shadow repo was
                    // rebuilt; fall through and capture again.
                    self.captures
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .remove(&key);
                }
                Err(error) => return Err(capture_failure(error)),
            }
        }
        let outcome = self
            .engine
            .capture_for_root(workspace_id, root_id, run_id, actor, call_id, abnormal)
            .await
            .map_err(capture_failure)?;
        if outcome.slice_ref.is_some() {
            info!(
                workspace_id,
                root_id,
                run_id,
                slice_ref = outcome.slice_ref.as_deref().unwrap_or(""),
                changed = outcome.changed_files.len(),
                state = %outcome.state,
                "run checkpoint slice captured"
            );
            self.captures
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(key, outcome.clone());
            if self.auto_gc {
                self.best_effort_gc(workspace_id).await;
            }
        } else {
            info!(
                workspace_id,
                root_id,
                run_id,
                predecessor = outcome.predecessor.as_deref().unwrap_or("none"),
                "run checkpoint capture found no change"
            );
        }
        Ok(outcome)
    }

    /// Retention sweep (decision #10, slice model). Counts slices; abnormal
    /// slices participate exactly like normal ones.
    pub async fn gc(&self, workspace_id: &str) -> Result<GcOutcome, GcFailure> {
        validate_workspace_id(workspace_id).map_err(|error| GcFailure::Validation {
            detail: error.to_string(),
        })?;
        let report = self
            .engine
            .retention_gc(workspace_id, self.max_slices, self.ttl_days)
            .await
            .map_err(|error| GcFailure::Unavailable {
                reason: engine_reason(&error),
                detail: error.to_string(),
            })?;
        Ok(GcOutcome {
            counts: GcCounts {
                deleted: report.deleted_slices.len(),
                kept: report.kept,
            },
        })
    }

    /// Explicit cleanup (frozen plan B, Runtime side): remove the whole shadow
    /// repository of one workspace. A capture or restore in progress rejects the
    /// cleanup (409 busy, no queueing). CP-side projection invalidation, the
    /// user confirmation flow and the UI entry are PLAN-0339.
    pub async fn cleanup(&self, workspace_id: &str) -> Result<CleanupOutcome, CleanupFailure> {
        validate_workspace_id(workspace_id).map_err(|error| CleanupFailure::Validation {
            detail: error.to_string(),
        })?;
        let outcome =
            self.engine
                .cleanup_workspace(workspace_id)
                .await
                .map_err(|error| match error {
                    CheckpointError::CleanupBusy(_) => CleanupFailure::Busy,
                    other => CleanupFailure::Unavailable {
                        reason: engine_reason(&other),
                        detail: other.to_string(),
                    },
                })?;
        // The workspace's slices are gone: drop the in-memory idempotency records.
        let prefix = format!("{workspace_id}/");
        self.captures
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|key, _| !key.starts_with(&prefix));
        Ok(outcome)
    }

    /// Diagnostics projection used by `GET /internal/v1/runtime/diagnostics`.
    pub async fn diagnostics(&self) -> CheckpointDiagnostics {
        let capability = self.engine.probe().await;
        CheckpointDiagnostics {
            git_version: capability.version,
            capable: capability.available,
            shadow_root: self
                .engine
                .host_root()
                .join(SHADOW_DIR_NAME)
                .to_string_lossy()
                .replace('\\', "/"),
            active_capture_locks: self.engine.active_capture_locks(),
            active_restore_locks: self.engine.active_restore_locks(),
            nested_repo_policy: self.engine.nested_repo_policy().as_str(),
            checkpoint_storage: self.engine.checkpoint_storage().as_str(),
            store_failures: self.engine.store_failures(),
            store_root: self
                .engine
                .store_root()
                .map(|root| root.to_string_lossy().replace('\\', "/")),
        }
    }

    async fn best_effort_gc(&self, workspace_id: &str) {
        match self
            .engine
            .retention_gc(workspace_id, self.max_slices, self.ttl_days)
            .await
        {
            Ok(report) => {
                if !report.deleted_slices.is_empty() {
                    info!(
                        workspace_id,
                        deleted = report.deleted_slices.len(),
                        "post-capture checkpoint retention removed slices"
                    );
                }
            }
            Err(error) => {
                warn!(
                    workspace_id,
                    error = %error,
                    "post-capture checkpoint retention failed (ignored; the capture result is authoritative)"
                );
            }
        }
    }
}

/// PLAN-0639 M7 (VM11): replay-cache key for one `(workspace, root, run)` capture.
/// Root ids are workspace-id shaped (no `/`), so the composite stays unambiguous.
fn capture_key(workspace_id: &str, root_id: &str, run_id: &str) -> String {
    format!("{workspace_id}/{root_id}/{run_id}")
}

/// `GIT_TOO_OLD` when a version string was reported but rejected (below 2.20 or
/// unparseable), `GIT_UNAVAILABLE` when the binary itself could not be probed.
pub(crate) fn unavailable_reason(version: &Option<String>) -> &'static str {
    if version.is_some() {
        REASON_GIT_TOO_OLD
    } else {
        REASON_GIT_UNAVAILABLE
    }
}

pub(crate) fn engine_reason(error: &CheckpointError) -> &'static str {
    match error {
        CheckpointError::WorkspaceMissing(_) => REASON_WORKSPACE_UNKNOWN,
        CheckpointError::GitUnavailable(_) => REASON_GIT_UNAVAILABLE,
        _ => REASON_GIT_FAILED,
    }
}

fn capture_failure(error: CheckpointError) -> CaptureFailure {
    let detail = error.to_string();
    match error {
        CheckpointError::InvalidIdentifier { .. } => CaptureFailure::Validation { detail },
        CheckpointError::WorkspaceMissing(_) => CaptureFailure::Unavailable {
            reason: REASON_WORKSPACE_UNKNOWN,
            detail,
        },
        CheckpointError::GitUnavailable(_) => CaptureFailure::Unavailable {
            reason: REASON_GIT_UNAVAILABLE,
            detail,
        },
        CheckpointError::NestedRepoLimit { .. } => CaptureFailure::Unavailable {
            reason: REASON_NESTED_REPO_LIMIT,
            detail,
        },
        _ => CaptureFailure::Unavailable {
            reason: REASON_GIT_FAILED,
            detail,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_reason_distinguishes_missing_from_old_git() {
        assert_eq!(unavailable_reason(&None), REASON_GIT_UNAVAILABLE);
        assert_eq!(
            unavailable_reason(&Some("git version 2.19.0".to_string())),
            REASON_GIT_TOO_OLD
        );
    }

    #[test]
    fn engine_reason_maps_workspace_and_git_failures() {
        assert_eq!(
            engine_reason(&CheckpointError::WorkspaceMissing("ws1".to_string())),
            REASON_WORKSPACE_UNKNOWN
        );
        assert_eq!(
            engine_reason(&CheckpointError::GitUnavailable("missing".to_string())),
            REASON_GIT_UNAVAILABLE
        );
        assert_eq!(
            engine_reason(&CheckpointError::GitCommand {
                command: "add".to_string(),
                detail: "boom".to_string(),
            }),
            REASON_GIT_FAILED
        );
    }

    #[test]
    fn capture_failure_maps_validation_workspace_and_git_errors() {
        match capture_failure(CheckpointError::InvalidIdentifier {
            kind: "run id",
            value: "..".to_string(),
            detail: "unsafe".to_string(),
        }) {
            CaptureFailure::Validation { detail } => assert!(detail.contains("run id")),
            other => panic!("expected Validation, got {other:?}"),
        }
        assert_eq!(
            capture_failure(CheckpointError::WorkspaceMissing("ws1".to_string())),
            CaptureFailure::Unavailable {
                reason: REASON_WORKSPACE_UNKNOWN,
                detail: "workspace directory does not exist: ws1".to_string(),
            }
        );
        assert_eq!(
            capture_failure(CheckpointError::GitUnavailable("missing".to_string())),
            CaptureFailure::Unavailable {
                reason: REASON_GIT_UNAVAILABLE,
                detail: "host git is unavailable for checkpointing: missing".to_string(),
            }
        );
        assert_eq!(
            capture_failure(CheckpointError::GitCommand {
                command: "add -A".to_string(),
                detail: "exit code 1".to_string(),
            }),
            CaptureFailure::Unavailable {
                reason: REASON_GIT_FAILED,
                detail: "git command failed [add -A]: exit code 1".to_string(),
            }
        );
    }

    #[test]
    fn capture_failure_maps_the_nested_repo_hard_limit_to_its_reason() {
        let failure = capture_failure(CheckpointError::NestedRepoLimit {
            paths: vec!["sub-repo/".to_string()],
        });
        match failure {
            CaptureFailure::Unavailable { reason, detail } => {
                assert_eq!(reason, REASON_NESTED_REPO_LIMIT);
                assert!(detail.contains("sub-repo/"));
            }
            other => panic!("expected Unavailable, got {other:?}"),
        }
    }

    #[test]
    fn run_key_is_workspace_scoped_and_unambiguous() {
        assert_eq!(capture_key("ws-a", "ws-a", "run-1"), "ws-a/ws-a/run-1");
        assert_ne!(
            capture_key("ws-a", "ws-a", "run-1"),
            capture_key("ws", "a/ws-a", "run-1")
        );
    }

    /// PLAN-0639 M7 (VM11): two roots of one workspace must not share a replay
    /// entry — that was the silent no-op shape of the pre-M7 key `(workspace, run)`.
    #[test]
    fn capture_key_separates_roots_of_one_workspace() {
        let primary = capture_key("ws-a", "ws-a", "run-1");
        let secondary = capture_key("ws-a", "root-b", "run-1");
        assert_ne!(primary, secondary);
    }

    #[tokio::test]
    async fn diagnostics_exposes_storage_and_store_failure_counter() {
        let temp = tempfile::tempdir().expect("tempdir");
        let git = CheckpointService::new(temp.path());
        let git_diagnostics = git.diagnostics().await;
        assert_eq!(git_diagnostics.checkpoint_storage, "git");
        assert_eq!(git_diagnostics.store_failures, 0);
        assert!(git_diagnostics.store_root.is_none());

        let store_root = temp.path().join(".xihe-store");
        let dual = CheckpointService::new(temp.path())
            .with_checkpoint_storage(CheckpointStorageMode::Dual, &store_root)
            .expect("dual store");
        let dual_diagnostics = dual.diagnostics().await;
        assert_eq!(dual_diagnostics.checkpoint_storage, "dual");
        assert_eq!(dual_diagnostics.store_failures, 0);
        assert!(dual_diagnostics.store_root.is_some());
    }
}
