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

use std::borrow::Cow;
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
use crate::checkpoint_store::fsck::fsck_store;
use crate::checkpoint_store::preflight::{PreflightOptions, run_preflight};
use crate::checkpoint_store::reads::list_slices;
use crate::checkpoint_store::restore_full::restore_status;
use crate::checkpoint_store::store::{Store, StoreError};

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
/// P2.4 store/self reasons. Unknown adapter reasons are carried through as
/// `Cow::Owned`; these are only the known tokens used by this crate.
pub const REASON_STORE_BUSY: &str = "STORE_BUSY";
pub const REASON_STORE_CORRUPT: &str = "STORE_CORRUPT";
pub const REASON_SELF_STORE_CORRUPT: &str = "SELF_STORE_CORRUPT";
pub const REASON_STORE_SLICE_UNMAPPED: &str = "STORE_SLICE_UNMAPPED";
pub const REASON_STORE_GC_DISABLED: &str = "STORE_GC_DISABLED";
pub const REASON_SELF_ACK_REQUIRED: &str = "SELF_ACK_REQUIRED";
pub const REASON_SELF_MODE_FORBIDDEN: &str = "SELF_MODE_FORBIDDEN";
pub const REASON_SELF_PREFLIGHT_BLOCKED: &str = "SELF_PREFLIGHT_BLOCKED";

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
    /// `git` (default), `dual`, or explicit-only `self`.
    pub checkpoint_storage: &'static str,
    /// Number of dual-write store attempts that failed since process start.
    pub store_failures: u64,
    /// P3 T2.5: best-effort shadow backup failures after a successful self
    /// capture (store stayed authoritative; never silent).
    pub shadow_backup_failures: u64,
    /// Configured store root; absent for `git` mode.
    pub store_root: Option<String>,
    /// P2.4: last store fsck summary (non-mutating check).
    pub fsck: FsckDiagnostics,
    /// P2.4: incomplete restore marker/trash summary.
    pub incomplete_restore: IncompleteRestoreDiagnostics,
    /// P2.4: slices without an `index/refs` mapping.
    pub unmapped_slices: usize,
    /// P2.4: last GC attempt (retention or store GC).
    pub last_gc: Option<LastGcDiagnostics>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsckDiagnostics {
    pub ok: bool,
    pub findings: usize,
    pub repaired: usize,
    pub last_run_at_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncompleteRestoreDiagnostics {
    pub incomplete: bool,
    pub restore_id: Option<String>,
    pub trash_entries: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastGcDiagnostics {
    pub at_ms: u64,
    pub dry_run: bool,
    pub candidates: usize,
    pub candidate_bytes: u64,
    pub deleted: usize,
    pub bytes_freed: u64,
    pub journal: Option<String>,
}

/// `capture` failure mapped to the frozen HTTP statuses (400/503).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureFailure {
    /// 400: workspace or run identifier fails the frozen validation contract.
    Validation { detail: String },
    /// 503: git probe or workspace failure; `reason` is the frozen code.
    Unavailable {
        reason: Cow<'static, str>,
        detail: String,
    },
}

/// `gc` failure (400/409/503).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GcFailure {
    Validation {
        detail: String,
    },
    /// 409: GC is disabled at runtime (`XIHE_CHECKPOINT_GC=off`).
    Disabled {
        detail: String,
    },
    Unavailable {
        reason: Cow<'static, str>,
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
        reason: Cow<'static, str>,
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
    gc_enabled: bool,
    last_gc: StdMutex<Option<LastGcDiagnostics>>,
}

impl CheckpointService {
    pub fn new(host_root: impl Into<PathBuf>) -> Self {
        Self {
            engine: ShadowGit::new(host_root),
            captures: StdMutex::new(HashMap::new()),
            max_slices: DEFAULT_RETENTION_MAX_SLICES,
            ttl_days: DEFAULT_RETENTION_TTL_DAYS,
            auto_gc: true,
            gc_enabled: true,
            last_gc: StdMutex::new(None),
        }
    }

    /// Runtime switch (`XIHE_CHECKPOINT_GC=off`): off must be explicit and
    /// disables both the best-effort sweep and the explicit GC endpoint.
    pub fn with_gc_enabled(mut self, enabled: bool) -> Self {
        self.gc_enabled = enabled;
        self.auto_gc = enabled && self.auto_gc;
        self
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

    /// P2.4 fail-closed startup validation for `self`: open the store, discover
    /// roots, verify every root's shadow exists, run preflight (including refs
    /// backfill + fsck + read-path readiness), and reject if anything is incomplete.
    /// This is deliberately synchronous and runs before the HTTP server starts.
    pub fn validate_self_startup(&self) -> Result<(), String> {
        let Some(store_root) = self.engine.store_root() else {
            return Err("STORE_NOT_INITIALIZED: self mode has no store root".into());
        };
        let store = Store::open(store_root)
            .map_err(|error| format!("STORE_IO: store open failed: {error}"))?;
        let slices = store_root.join("slices");
        let mut roots = Vec::new();
        if slices.is_dir() {
            for entry in std::fs::read_dir(&slices)
                .map_err(|error| format!("STORE_IO: slices scan failed: {error}"))?
            {
                let entry = entry.map_err(|error| format!("STORE_IO: slices entry: {error}"))?;
                if entry
                    .file_type()
                    .map_err(|error| format!("STORE_IO: slices type: {error}"))?
                    .is_dir()
                {
                    roots.push(entry.file_name().to_string_lossy().to_string());
                }
            }
        }
        // P3 T2.5 (D53-37): git is the best-effort backup, not a gate. When the
        // binary is absent the shadow cross-check degrades with a visible WARN
        // instead of blocking self startup; store validation still runs.
        let git_available = self.engine.git_binary_available();
        if !git_available && !roots.is_empty() {
            tracing::warn!(
                roots = roots.len(),
                "self startup: git unavailable; shadow validation degraded (store is primary, backup will be skipped)"
            );
        }
        let mut shadows = std::collections::HashMap::new();
        for root in &roots {
            let work_tree = self
                .engine
                .work_tree_for_root(root)
                .map_err(|error| format!("SELF_PREFLIGHT_BLOCKED: root {root}: {error}"))?;
            if store.root().starts_with(&work_tree) {
                return Err(format!(
                    "SELF_PREFLIGHT_BLOCKED: store root {} is inside capture root {}",
                    store.root().display(),
                    work_tree.display()
                ));
            }
            if !git_available {
                continue;
            }
            let shadow = self
                .engine
                .shadow_git_dir(root)
                .map_err(|error| format!("SELF_SHADOW_MISSING: {root}: {error}"))?;
            if !shadow.is_dir() {
                return Err(format!(
                    "SELF_SHADOW_MISSING: shadow for root {root} is missing at {}",
                    shadow.display()
                ));
            }
            shadows.insert(root.clone(), shadow);
        }
        let report = run_preflight(
            &store,
            &PreflightOptions {
                roots: roots.clone(),
                shadow_git_dirs: shadows,
                enforce_read_paths: true,
                ..PreflightOptions::default()
            },
        )
        .map_err(|error| format!("SELF_PREFLIGHT_BLOCKED: preflight io: {error}"))?;
        if !report.ok || !report.store_ok || !report.fsck_clean || !report.blockers.is_empty() {
            return Err(format!(
                "SELF_PREFLIGHT_BLOCKED: ok={} store_ok={} fsck_clean={} blockers={:?}",
                report.ok, report.store_ok, report.fsck_clean, report.blockers
            ));
        }
        if report
            .roots
            .iter()
            .any(|root| !root.unmapped_slices.is_empty() || !root.symlink_blockers.is_empty())
        {
            return Err(format!(
                "SELF_PREFLIGHT_BLOCKED: root report incomplete: {report:?}"
            ));
        }
        Ok(())
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
        // P3 T2.5: the self primary path (Flatten default) must not gate on git
        // capability; git/dual and the legacy self policies keep the probe.
        let needs_git_gate = self.engine.checkpoint_storage() != CheckpointStorageMode::Self_
            || self.engine.nested_repo_policy() != NestedRepoPolicy::Flatten;
        if needs_git_gate {
            let capability = self.engine.probe().await;
            if !capability.available {
                return Err(CaptureFailure::Unavailable {
                    reason: unavailable_reason(&capability.version).into(),
                    detail: capability.detail,
                });
            }
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
            // Self/store mode never reclaims slices behind the cache (cleanup
            // clears this map), so the cached record is authoritative without
            // asking git.
            if self.engine.checkpoint_storage() == CheckpointStorageMode::Self_
                && self.engine.nested_repo_policy() == NestedRepoPolicy::Flatten
            {
                return Ok(record);
            }
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
        if !self.gc_enabled {
            return Err(GcFailure::Disabled {
                detail: "checkpoint GC is disabled by XIHE_CHECKPOINT_GC=off".into(),
            });
        }
        // P3 T2.5: self mode sweeps the store (blob + stale stat-cache) and never
        // spawns git. Store slices are never deleted by GC (P2.3 policy), so the
        // counts keep their slice meaning; blob sweep numbers live in `lastGc`.
        if self.engine.checkpoint_storage() == CheckpointStorageMode::Self_ {
            return self.store_gc_sweep(workspace_id);
        }
        let report = self
            .engine
            .retention_gc(workspace_id, self.max_slices, self.ttl_days)
            .await
            .map_err(|error| GcFailure::Unavailable {
                reason: engine_reason(&error),
                detail: error.to_string(),
            })?;
        let diagnostics = LastGcDiagnostics {
            at_ms: now_ms(),
            dry_run: false,
            candidates: report.kept,
            candidate_bytes: 0,
            deleted: report.deleted_slices.len(),
            bytes_freed: 0,
            journal: None,
        };
        *self.last_gc.lock().unwrap_or_else(PoisonError::into_inner) = Some(diagnostics);
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
        let mut fsck = FsckDiagnostics::default();
        let mut unmapped_slices = 0usize;
        let mut incomplete_restore = IncompleteRestoreDiagnostics::default();
        if let Some(store_root) = self.engine.store_root()
            && let Ok(store) = Store::open(store_root)
        {
            if let Ok(report) = fsck_store(&store, false) {
                fsck = FsckDiagnostics {
                    ok: report.is_clean(),
                    findings: report.findings.len(),
                    repaired: report
                        .findings
                        .iter()
                        .filter(|finding| finding.repaired)
                        .count(),
                    last_run_at_ms: now_ms(),
                };
            }
            let slices = store.root().join("slices");
            if let Ok(entries) = std::fs::read_dir(&slices) {
                for entry in entries.flatten() {
                    if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                        continue;
                    }
                    let root = entry.file_name().to_string_lossy().to_string();
                    if let Ok(list) = list_slices(&store, &root) {
                        unmapped_slices += list.unmapped_slices.len();
                    }
                }
            }
        }
        if let Ok(entries) = std::fs::read_dir(self.engine.host_root()) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.')
                    || !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
                {
                    continue;
                }
                if let Ok(status) = restore_status(&entry.path())
                    && status.incomplete
                {
                    incomplete_restore.incomplete = true;
                    incomplete_restore.restore_id = status
                        .marker
                        .as_ref()
                        .map(|marker| marker.restore_id.clone());
                    incomplete_restore.trash_entries = status.trash_entries.len();
                }
            }
        }
        let last_gc = self
            .last_gc
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
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
            shadow_backup_failures: self.engine.shadow_backup_failures(),
            store_root: self
                .engine
                .store_root()
                .map(|root| root.to_string_lossy().replace('\\', "/")),
            fsck,
            incomplete_restore,
            unmapped_slices,
            last_gc,
        }
    }

    /// P3 T2.5: explicit self-mode GC = store blob/cache sweep, no git spawn.
    fn store_gc_sweep(&self, workspace_id: &str) -> Result<GcOutcome, GcFailure> {
        use crate::checkpoint_store::gc::{GcError, GcOptions, gc as store_gc};

        let Some(store_root) = self.engine.store_root() else {
            return Err(GcFailure::Unavailable {
                reason: Cow::Borrowed("STORE_NOT_INITIALIZED"),
                detail: "self GC has no configured store root".into(),
            });
        };
        let store = Store::open(store_root).map_err(|error| GcFailure::Unavailable {
            reason: Cow::Borrowed("STORE_IO"),
            detail: error.to_string(),
        })?;
        let sweep = store_gc(
            &store,
            &GcOptions {
                repair: true,
                ..GcOptions::default()
            },
        )
        .map_err(|error| {
            let (reason, detail) = match &error {
                GcError::Busy => (Cow::Borrowed(REASON_STORE_BUSY), error.to_string()),
                GcError::ReferenceCorrupt(_) => {
                    (Cow::Borrowed("GC_REFERENCE_CORRUPT"), error.to_string())
                }
                GcError::Io(_) => (Cow::Borrowed("GC_IO"), error.to_string()),
                GcError::Store(_) => (Cow::Borrowed("GC_STORE"), error.to_string()),
                GcError::InjectedCrash => (Cow::Borrowed("GC_CRASH_INJECTED"), error.to_string()),
            };
            GcFailure::Unavailable {
                reason,
                detail: detail.to_string(),
            }
        })?;
        let kept = list_slices(&store, workspace_id)
            .map(|list| list.slices.len())
            .unwrap_or(0);
        let diagnostics = LastGcDiagnostics {
            at_ms: now_ms(),
            dry_run: sweep.dry_run,
            candidates: sweep.candidates,
            candidate_bytes: sweep.candidate_bytes,
            deleted: sweep.deleted,
            bytes_freed: sweep.bytes_freed,
            journal: sweep.journal_path,
        };
        *self.last_gc.lock().unwrap_or_else(PoisonError::into_inner) = Some(diagnostics);
        info!(
            store_root = %store.root().display(),
            candidates = sweep.candidates,
            blobs_deleted = sweep.deleted,
            kept_slices = kept,
            "checkpoint self GC store sweep completed (no git spawn)"
        );
        Ok(GcOutcome {
            counts: GcCounts { deleted: 0, kept },
        })
    }

    async fn best_effort_gc(&self, workspace_id: &str) {
        // Self mode: the store is authoritative; skip git retention entirely
        // (explicit GC runs the store sweep above).
        if self.engine.checkpoint_storage() == CheckpointStorageMode::Self_ {
            return;
        }
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

pub(crate) fn engine_reason(error: &CheckpointError) -> Cow<'static, str> {
    match error {
        CheckpointError::WorkspaceMissing(_) => Cow::Borrowed(REASON_WORKSPACE_UNKNOWN),
        CheckpointError::GitUnavailable(_) => Cow::Borrowed(REASON_GIT_UNAVAILABLE),
        CheckpointError::StoreFailure { reason, .. } => Cow::Owned(reason.clone()),
        CheckpointError::StoreCaptureFailed { .. } => Cow::Borrowed(REASON_SELF_STORE_CORRUPT),
        _ => Cow::Borrowed(REASON_GIT_FAILED),
    }
}

fn capture_failure(error: CheckpointError) -> CaptureFailure {
    let detail = error.to_string();
    match error {
        CheckpointError::InvalidIdentifier { .. } => CaptureFailure::Validation { detail },
        CheckpointError::WorkspaceMissing(_) => CaptureFailure::Unavailable {
            reason: Cow::Borrowed(REASON_WORKSPACE_UNKNOWN),
            detail,
        },
        CheckpointError::GitUnavailable(_) => CaptureFailure::Unavailable {
            reason: Cow::Borrowed(REASON_GIT_UNAVAILABLE),
            detail,
        },
        CheckpointError::NestedRepoLimit { .. } => CaptureFailure::Unavailable {
            reason: Cow::Borrowed(REASON_NESTED_REPO_LIMIT),
            detail,
        },
        CheckpointError::StoreFailure { reason, .. } => CaptureFailure::Unavailable {
            reason: Cow::Owned(reason),
            detail,
        },
        _ => CaptureFailure::Unavailable {
            reason: Cow::Borrowed(REASON_GIT_FAILED),
            detail,
        },
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
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
    fn off_table_store_reason_is_not_normalized_to_git_failed() {
        let failure = capture_failure(CheckpointError::StoreFailure {
            reason: "VENDOR_STORE_NEW_REASON".into(),
            detail: "adapter detail".into(),
        });
        match failure {
            CaptureFailure::Unavailable { reason, detail } => {
                assert_eq!(reason, "VENDOR_STORE_NEW_REASON");
                assert_ne!(reason, REASON_GIT_FAILED);
                assert_eq!(
                    detail,
                    "checkpoint store failure [VENDOR_STORE_NEW_REASON]: adapter detail"
                );
            }
            other => panic!("expected unavailable, got {other:?}"),
        }
    }

    #[test]
    fn self_startup_rejects_unmapped_store() {
        use crate::checkpoint_store::capture::capture_root;

        let temp = tempfile::tempdir().expect("tempdir");
        let host = temp.path().join("host");
        let work = host.join("ws-1");
        std::fs::create_dir_all(&work).expect("work");
        std::fs::write(work.join("a.txt"), "a").expect("file");
        let store_root = temp.path().join("store");
        let store = Store::init(&store_root).expect("store");
        capture_root(&store, &work, "ws-1", None, None).expect("slice");
        let shadow = host.join(SHADOW_DIR_NAME).join("ws-1.git");
        std::fs::create_dir_all(&shadow).expect("shadow dir");
        let service = CheckpointService::new(&host)
            .with_checkpoint_storage(CheckpointStorageMode::Self_, &store_root)
            .expect("self service");
        let error = service.validate_self_startup().expect_err("must block");
        assert!(
            error.contains("SELF_PREFLIGHT_BLOCKED") || error.contains("STORE_SLICE_UNMAPPED"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn gc_disabled_never_deletes_and_reports_store_gc_disabled() {
        let temp = tempfile::tempdir().expect("tempdir");
        let host = temp.path().join("host");
        std::fs::create_dir_all(&host).expect("host");
        let store_root = temp.path().join("store");
        let service = CheckpointService::new(&host)
            .with_checkpoint_storage(CheckpointStorageMode::Dual, &store_root)
            .expect("dual")
            .with_gc_enabled(false);
        let error = service.gc("ws-1").await.expect_err("gc must be disabled");
        assert!(matches!(error, GcFailure::Disabled { .. }), "{error:?}");
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
                reason: REASON_WORKSPACE_UNKNOWN.into(),
                detail: "workspace directory does not exist: ws1".to_string(),
            }
        );
        assert_eq!(
            capture_failure(CheckpointError::GitUnavailable("missing".to_string())),
            CaptureFailure::Unavailable {
                reason: REASON_GIT_UNAVAILABLE.into(),
                detail: "host git is unavailable for checkpointing: missing".to_string(),
            }
        );
        assert_eq!(
            capture_failure(CheckpointError::GitCommand {
                command: "add -A".to_string(),
                detail: "exit code 1".to_string(),
            }),
            CaptureFailure::Unavailable {
                reason: REASON_GIT_FAILED.into(),
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

    /// P3 T2.5 (D53-37): the self primary path must capture, start up and GC
    /// with git entirely absent; the skipped backup stays visible.
    #[tokio::test]
    async fn self_capture_startup_and_gc_work_without_git() {
        use crate::checkpoint_store::refs;

        let temp = tempfile::tempdir().expect("tempdir");
        let host = temp.path().join("host");
        let work = host.join("ws-1");
        std::fs::create_dir_all(&work).expect("work");
        std::fs::write(work.join("a.txt"), "one").expect("file");
        let store_root = temp.path().join(".xihe-store");
        let service = CheckpointService::new(&host)
            .with_git_binary("xihe-git-missing-binary")
            .with_checkpoint_storage(CheckpointStorageMode::Self_, &store_root)
            .expect("self store");

        let capture = service
            .capture("ws-1", "run-nogit-1", "tester", "call-1", false)
            .await
            .expect("capture must not need git");
        let slice_ref = capture.slice_ref.expect("slice ref");
        assert!(crate::checkpoint::parse_slice_ref(&slice_ref).is_some());

        let store = Store::open(&store_root).expect("store");
        let record = refs::read_ref(&store, "ws-1", &slice_ref)
            .expect("ref read")
            .expect("store mapping");
        assert_eq!(record.git_tree, "", "backup skipped: no shadow object");
        assert_eq!(service.engine().shadow_backup_failures(), 1);
        assert_eq!(service.engine().store_failures(), 0);

        // Startup degrades the shadow check instead of blocking self mode.
        service
            .validate_self_startup()
            .expect("self startup must degrade, not fail");

        // Explicit GC sweeps the store without spawning git.
        let gc_out = service.gc("ws-1").await.expect("store gc");
        assert_eq!(gc_out.counts.deleted, 0, "store GC never deletes slices");
        assert!(gc_out.counts.kept >= 1);

        let diagnostics = service.diagnostics().await;
        assert_eq!(diagnostics.checkpoint_storage, "self");
        assert!(!diagnostics.capable, "git probe must report unavailable");
        assert_eq!(diagnostics.shadow_backup_failures, 1);
        assert!(diagnostics.last_gc.is_some());
    }

    /// P3 T2.5: with git present the backup publishes the SAME slice ref the
    /// store records, so a later git-mode rollback sees a consistent list.
    #[tokio::test]
    async fn self_backup_shares_store_slice_ref_and_preflight_validates_it() {
        use crate::checkpoint_store::preflight::{PreflightOptions, run_preflight};
        use crate::checkpoint_store::refs;

        let temp = tempfile::tempdir().expect("tempdir");
        let host = temp.path().join("host");
        let work = host.join("ws-1");
        std::fs::create_dir_all(&work).expect("work");
        std::fs::write(work.join("a.txt"), "one").expect("file");
        let store_root = temp.path().join(".xihe-store");
        let service = CheckpointService::new(&host)
            .with_checkpoint_storage(CheckpointStorageMode::Self_, &store_root)
            .expect("self store");
        if !service.engine().git_binary_available() {
            return;
        }

        let capture = service
            .capture("ws-1", "run-backup-1", "tester", "call-1", false)
            .await
            .expect("capture");
        let slice_ref = capture.slice_ref.expect("slice ref");
        assert!(crate::checkpoint::parse_slice_ref(&slice_ref).is_some());

        let store = Store::open(&store_root).expect("store");
        let record = refs::read_ref(&store, "ws-1", &slice_ref)
            .expect("ref read")
            .expect("store mapping");
        assert!(!record.git_tree.is_empty(), "backup recorded its tree");

        // The shadow publishes the identical ref name.
        let commit = service
            .engine()
            .slice_commit("ws-1", &slice_ref)
            .await
            .expect("slice commit")
            .expect("shadow must contain the same slice ref");

        // Preflight cross-checks sidecar git_tree against the shadow object.
        let shadow = service
            .engine()
            .shadow_git_dir("ws-1")
            .expect("shadow path");
        let report = run_preflight(
            &store,
            &PreflightOptions {
                roots: vec!["ws-1".into()],
                shadow_git_dirs: [("ws-1".to_string(), shadow)].into_iter().collect(),
                enforce_read_paths: true,
                ..PreflightOptions::default()
            },
        )
        .expect("preflight");
        assert!(report.ok && report.blockers.is_empty(), "{report:?}");
        assert!(!commit.is_empty());
        assert_eq!(service.engine().shadow_backup_failures(), 0);
        assert_eq!(service.engine().store_failures(), 0);
    }
}
