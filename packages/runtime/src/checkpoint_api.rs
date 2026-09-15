//! PLAN-0328 M2 W2: Run-checkpoint host API surface.
//!
//! Wires the W1 shadow-git engine ([`crate::checkpoint`]) into the frozen Runtime
//! HTTP contract:
//!
//! - a workspace mutation lease (decision #8) acquired atomically with
//!   `create_base`, released on seal for the owning run only, TTL 30 min so a
//!   stale lease after a Runtime restart is reclaimable;
//! - seal bookkeeping — change set plus `sealedWithLiveJobs` /
//!   `sealedAfterAbnormal` markers — returned verbatim on an idempotent reseal;
//! - retention GC (decision #10: newest 50 + TTL 30 days per workspace, unsealed
//!   runs are never deleted) and the diagnostics projection.
//!
//! The axum handlers in `main.rs` only map these outcomes to the frozen
//! Problem+JSON shapes; no control-plane or UI concept lives here.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex as StdMutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tracing::{info, warn};

use crate::checkpoint::{
    ChangedFile, CheckpointError, DEFAULT_RETENTION_MAX_RUNS, DEFAULT_RETENTION_TTL_DAYS,
    SHADOW_DIR_NAME, ShadowGit, validate_run_id, validate_workspace_id,
};

/// Frozen mutation-lease TTL (decision #8). The lease map is in-memory; a Runtime
/// restart drops it, so the TTL bounds how long a stale lease can block writers
/// while the persisted base refs keep the checkpoint itself recoverable.
pub const DEFAULT_LEASE_TTL: Duration = Duration::from_secs(30 * 60);

/// `CHECKPOINT_UNAVAILABLE` reasons (frozen CP-facing codes).
pub const REASON_GIT_UNAVAILABLE: &str = "GIT_UNAVAILABLE";
pub const REASON_GIT_TOO_OLD: &str = "GIT_TOO_OLD";
pub const REASON_GIT_FAILED: &str = "GIT_FAILED";
pub const REASON_WORKSPACE_UNKNOWN: &str = "WORKSPACE_UNKNOWN";

/// One entry of a checkpoint wire change set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointChangedFile {
    /// Raw git status (`M`, `A`, `D`, `R100`, ...); first character is the class.
    pub status: String,
    /// Workspace-relative path with forward slashes (destination for renames).
    pub path: String,
}

impl From<&ChangedFile> for CheckpointChangedFile {
    fn from(file: &ChangedFile) -> Self {
        Self {
            status: file.status.clone(),
            path: file.path.clone(),
        }
    }
}

/// `POST .../checkpoints` 200 body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBaseOutcome {
    pub checkpoint_id: String,
    pub run_id: String,
    pub state: String,
    pub base_ref: String,
    pub created_at: String,
}

/// `POST .../checkpoints/{runId}/seal` 200 body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SealOutcome {
    pub run_id: String,
    pub state: String,
    pub base_ref: String,
    pub end_ref: String,
    pub changed_files: Vec<CheckpointChangedFile>,
    pub sealed_with_live_jobs: bool,
    pub sealed_after_abnormal: bool,
}

/// `GET .../checkpoints/{runId}` 200 body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointStatus {
    pub run_id: String,
    /// `base` (end ref missing) or `sealed`.
    pub state: String,
    pub base_ref: Option<String>,
    pub end_ref: Option<String>,
    pub base_commit: Option<String>,
    pub end_commit: Option<String>,
    pub changed_files: Vec<CheckpointChangedFile>,
    pub sealed_with_live_jobs: bool,
    pub sealed_after_abnormal: bool,
}

/// `POST .../checkpoints/gc` 200 body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GcOutcome {
    /// Sealed runs removed by this sweep, oldest first.
    pub deleted_runs: Vec<String>,
    /// Sealed + unsealed runs kept by the sweep.
    pub kept_runs: usize,
    /// CP-projected numeric counts (openapi `counts`).
    pub counts: GcCounts,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GcCounts {
    pub deleted_runs: usize,
    pub kept_sealed: usize,
    pub kept_unsealed: usize,
    pub gc_ran: bool,
}

/// Diagnostics projection (no secrets; `gitVersion` may be absent).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointDiagnostics {
    pub git_version: Option<String>,
    pub capable: bool,
    pub shadow_root: String,
    pub active_lease_workspaces: Vec<String>,
}

/// `create_base` failure mapped to the frozen HTTP statuses (400/409/503).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreateBaseFailure {
    /// 400: workspace or run identifier fails the frozen validation contract.
    Validation { detail: String },
    /// 409: another run holds the workspace mutation lease.
    LeaseHeld { run_id: String, expires_at_ms: u64 },
    /// 503: git probe or workspace failure; `reason` is the frozen code.
    Unavailable {
        reason: &'static str,
        detail: String,
    },
}

/// `seal` failure (404/503).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SealFailure {
    NotFound {
        run_id: String,
    },
    Unavailable {
        reason: &'static str,
        detail: String,
    },
}

/// `status` failure (404/503).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StatusFailure {
    NotFound {
        run_id: String,
    },
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

/// Snapshot of one active workspace lease.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseView {
    pub run_id: String,
    /// Wall-clock deadline in Unix milliseconds (display only; expiry uses a
    /// monotonic deadline internally).
    pub expires_at_ms: u64,
}

/// Result of one atomic acquire attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeaseAcquire {
    /// Lease held by `workspace_id`; `fresh` is false when the same run re-acquired.
    Acquired { fresh: bool },
    /// Another run's lease is still within its TTL; the caller maps this to 409.
    HeldByOther(LeaseView),
}

struct LeaseEntry {
    run_id: String,
    deadline: Instant,
    expires_at_ms: u64,
}

impl std::fmt::Debug for LeaseEntry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LeaseEntry")
            .field("run_id", &self.run_id)
            .field("expires_at_ms", &self.expires_at_ms)
            .finish_non_exhaustive()
    }
}

impl LeaseEntry {
    fn is_expired(&self, now: Instant) -> bool {
        now >= self.deadline
    }

    fn view(&self) -> LeaseView {
        LeaseView {
            run_id: self.run_id.clone(),
            expires_at_ms: self.expires_at_ms,
        }
    }
}

/// Workspace mutation lease registry (decision #8: workspace-level single writer).
///
/// One entry per workspace: `workspaceId → {runId, expiresAt}`. Check-and-set is
/// atomic under one mutex, so concurrent creates for different runs cannot both
/// win. An expired entry is reclaimable by the next acquire, which is the
/// restart-recovery path (the map itself is in-memory).
#[derive(Debug)]
pub struct MutationLeaseRegistry {
    ttl: Duration,
    leases: StdMutex<HashMap<String, LeaseEntry>>,
}

impl Default for MutationLeaseRegistry {
    fn default() -> Self {
        Self::with_ttl(DEFAULT_LEASE_TTL)
    }
}

impl MutationLeaseRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Test/embedding hook: override the lease TTL.
    pub fn with_ttl(ttl: Duration) -> Self {
        Self {
            ttl,
            leases: StdMutex::new(HashMap::new()),
        }
    }

    /// Atomic acquire: a live lease of another run wins (409); the same run gets
    /// an extend (`fresh: false`); an expired lease is reclaimed (`fresh: true`).
    pub fn try_acquire(&self, workspace_id: &str, run_id: &str) -> LeaseAcquire {
        let now = Instant::now();
        let mut leases = self.leases.lock().unwrap_or_else(PoisonError::into_inner);
        match leases.get_mut(workspace_id) {
            Some(entry) if !entry.is_expired(now) && entry.run_id != run_id => {
                LeaseAcquire::HeldByOther(entry.view())
            }
            Some(entry) if !entry.is_expired(now) => {
                // Same run re-acquiring: extend so a long run keeps its lease.
                entry.deadline = now + self.ttl;
                entry.expires_at_ms = wall_clock_ms().saturating_add(ttl_ms(self.ttl));
                LeaseAcquire::Acquired { fresh: false }
            }
            _ => {
                leases.insert(
                    workspace_id.to_string(),
                    LeaseEntry {
                        run_id: run_id.to_string(),
                        deadline: now + self.ttl,
                        expires_at_ms: wall_clock_ms().saturating_add(ttl_ms(self.ttl)),
                    },
                );
                LeaseAcquire::Acquired { fresh: true }
            }
        }
    }

    /// Release only when the lease belongs to `run_id` (never another run's).
    pub fn release(&self, workspace_id: &str, run_id: &str) -> bool {
        let mut leases = self.leases.lock().unwrap_or_else(PoisonError::into_inner);
        if leases
            .get(workspace_id)
            .is_some_and(|entry| entry.run_id == run_id)
        {
            leases.remove(workspace_id);
            true
        } else {
            false
        }
    }

    /// True when an unexpired lease for `run_id` exists (seal abnormality probe).
    pub fn held_by(&self, workspace_id: &str, run_id: &str) -> bool {
        let now = Instant::now();
        let leases = self.leases.lock().unwrap_or_else(PoisonError::into_inner);
        leases
            .get(workspace_id)
            .is_some_and(|entry| entry.run_id == run_id && !entry.is_expired(now))
    }

    /// Live lease of one workspace, purging an expired entry.
    pub fn view(&self, workspace_id: &str) -> Option<LeaseView> {
        let now = Instant::now();
        let mut leases = self.leases.lock().unwrap_or_else(PoisonError::into_inner);
        match leases.get(workspace_id) {
            Some(entry) if !entry.is_expired(now) => Some(entry.view()),
            Some(_) => {
                leases.remove(workspace_id);
                None
            }
            None => None,
        }
    }

    /// Unexpired lease workspaces, sorted for deterministic diagnostics.
    pub fn active_workspaces(&self) -> Vec<String> {
        let now = Instant::now();
        let mut leases = self.leases.lock().unwrap_or_else(PoisonError::into_inner);
        leases.retain(|_, entry| !entry.is_expired(now));
        let mut active: Vec<String> = leases.keys().cloned().collect();
        active.sort();
        active
    }

    /// Drop expired entries; returns how many were reaped.
    pub fn reap_expired(&self) -> usize {
        let now = Instant::now();
        let mut leases = self.leases.lock().unwrap_or_else(PoisonError::into_inner);
        let before = leases.len();
        leases.retain(|_, entry| !entry.is_expired(now));
        before - leases.len()
    }
}

struct CreateRecord {
    checkpoint_id: String,
    created_at: String,
}

/// Host-side Run-checkpoint service: single owner of the W1 engine, the mutation
/// lease registry and the seal bookkeeping used by the HTTP surface.
///
/// `seals`/`creates` are in-memory idempotency records: within one Runtime
/// process an idempotent replay returns the identical body. After a restart the
/// engine still returns the same refs (`create_base`/`seal` are idempotent), while
/// `checkpointId`/`createdAt` are regenerated and the seal markers are recomputed
/// — the CP row remains the durable projection.
pub struct CheckpointService {
    engine: ShadowGit,
    leases: MutationLeaseRegistry,
    creates: StdMutex<HashMap<String, CreateRecord>>,
    seals: StdMutex<HashMap<String, SealOutcome>>,
    max_runs: usize,
    ttl_days: u64,
    auto_gc: bool,
}

impl CheckpointService {
    pub fn new(host_root: impl Into<PathBuf>) -> Self {
        Self {
            engine: ShadowGit::new(host_root),
            leases: MutationLeaseRegistry::new(),
            creates: StdMutex::new(HashMap::new()),
            seals: StdMutex::new(HashMap::new()),
            max_runs: DEFAULT_RETENTION_MAX_RUNS,
            ttl_days: DEFAULT_RETENTION_TTL_DAYS,
            auto_gc: true,
        }
    }

    /// Test/embedding hook: override the host git binary (probe failures).
    pub fn with_git_binary(mut self, git_binary: impl Into<String>) -> Self {
        self.engine = self.engine.with_git_binary(git_binary);
        self
    }

    /// Test/embedding hook: override the mutation-lease TTL.
    pub fn with_lease_ttl(mut self, ttl: Duration) -> Self {
        self.leases = MutationLeaseRegistry::with_ttl(ttl);
        self
    }

    /// Test/embedding hook: override the retention policy (decision #10 defaults).
    pub fn with_retention(mut self, max_runs: usize, ttl_days: u64) -> Self {
        self.max_runs = max_runs;
        self.ttl_days = ttl_days;
        self
    }

    /// Test/embedding hook: disable the best-effort post-seal sweep.
    pub fn with_auto_gc(mut self, enabled: bool) -> Self {
        self.auto_gc = enabled;
        self
    }

    pub fn engine(&self) -> &ShadowGit {
        &self.engine
    }

    pub fn leases(&self) -> &MutationLeaseRegistry {
        &self.leases
    }

    /// Establish the Run base checkpoint. Acquires the workspace mutation lease
    /// atomically with the W1 engine call; releases it again when this call
    /// inserted the lease and the engine then failed.
    pub async fn create_base(
        &self,
        workspace_id: &str,
        run_id: &str,
        actor: Option<&str>,
        call_id: Option<&str>,
    ) -> Result<CreateBaseOutcome, CreateBaseFailure> {
        validate_workspace_id(workspace_id).map_err(|error| CreateBaseFailure::Validation {
            detail: error.to_string(),
        })?;
        validate_run_id(run_id).map_err(|error| CreateBaseFailure::Validation {
            detail: error.to_string(),
        })?;
        let capability = self.engine.probe().await;
        if !capability.available {
            return Err(CreateBaseFailure::Unavailable {
                reason: unavailable_reason(&capability.version),
                detail: capability.detail,
            });
        }
        let fresh = match self.leases.try_acquire(workspace_id, run_id) {
            LeaseAcquire::HeldByOther(view) => {
                return Err(CreateBaseFailure::LeaseHeld {
                    run_id: view.run_id,
                    expires_at_ms: view.expires_at_ms,
                });
            }
            LeaseAcquire::Acquired { fresh } => fresh,
        };
        let outcome = self
            .engine
            .create_base(
                workspace_id,
                run_id,
                actor.unwrap_or(""),
                call_id.unwrap_or(""),
            )
            .await;
        match outcome {
            Ok(base) => {
                info!(
                    workspace_id,
                    run_id,
                    base_commit = %base.base_commit,
                    created = base.created,
                    "run checkpoint base established"
                );
                let key = run_key(workspace_id, run_id);
                let record = {
                    let mut creates = self.creates.lock().unwrap_or_else(PoisonError::into_inner);
                    let entry = creates.entry(key).or_insert_with(new_create_record);
                    CreateRecord {
                        checkpoint_id: entry.checkpoint_id.clone(),
                        created_at: entry.created_at.clone(),
                    }
                };
                Ok(CreateBaseOutcome {
                    checkpoint_id: record.checkpoint_id.clone(),
                    run_id: run_id.to_string(),
                    state: "base".to_string(),
                    base_ref: base_ref(run_id),
                    created_at: record.created_at.clone(),
                })
            }
            Err(error) => {
                if fresh {
                    self.leases.release(workspace_id, run_id);
                }
                Err(create_failure(error))
            }
        }
    }

    /// Seal the Run. Idempotent: an existing seal record is returned verbatim
    /// (same change set and markers). Success releases the lease of this run only
    /// and runs the best-effort post-seal retention sweep.
    pub async fn seal(
        &self,
        workspace_id: &str,
        run_id: &str,
        with_live_jobs: bool,
    ) -> Result<SealOutcome, SealFailure> {
        let key = run_key(workspace_id, run_id);
        let existing = self
            .seals
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&key)
            .cloned();
        if let Some(record) = existing {
            self.leases.release(workspace_id, run_id);
            return Ok(record);
        }
        if validate_workspace_id(workspace_id).is_err() || validate_run_id(run_id).is_err() {
            return Err(SealFailure::NotFound {
                run_id: run_id.to_string(),
            });
        }
        // `sealedAfterAbnormal` is decided before the release: a seal that did not
        // come through this run's own live lease (expired lease after a restart,
        // reclaimed workspace, sweep) is marked for audit.
        let lease_was_held = self.leases.held_by(workspace_id, run_id);
        let sealed = match self.engine.seal(workspace_id, run_id).await {
            Ok(outcome) => outcome,
            Err(CheckpointError::RunNotFound(_) | CheckpointError::InvalidIdentifier { .. }) => {
                return Err(SealFailure::NotFound {
                    run_id: run_id.to_string(),
                });
            }
            Err(error) => {
                return Err(SealFailure::Unavailable {
                    reason: engine_reason(&error),
                    detail: error.to_string(),
                });
            }
        };
        let record = SealOutcome {
            run_id: run_id.to_string(),
            state: "sealed".to_string(),
            base_ref: base_ref(run_id),
            end_ref: end_ref(run_id),
            changed_files: sealed
                .changed_files
                .iter()
                .map(CheckpointChangedFile::from)
                .collect(),
            sealed_with_live_jobs: with_live_jobs,
            sealed_after_abnormal: !lease_was_held,
        };
        self.leases.release(workspace_id, run_id);
        self.seals
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(key, record.clone());
        info!(
            workspace_id,
            run_id,
            changed = record.changed_files.len(),
            sealed_with_live_jobs = with_live_jobs,
            sealed_after_abnormal = record.sealed_after_abnormal,
            "run checkpoint sealed"
        );
        if self.auto_gc {
            self.best_effort_gc(workspace_id).await;
        }
        Ok(record)
    }

    /// Runtime-side status of one run: `base` while the end ref is missing,
    /// `sealed` afterwards, 404 when neither ref exists.
    pub async fn status(
        &self,
        workspace_id: &str,
        run_id: &str,
    ) -> Result<CheckpointStatus, StatusFailure> {
        if validate_workspace_id(workspace_id).is_err() || validate_run_id(run_id).is_err() {
            return Err(StatusFailure::NotFound {
                run_id: run_id.to_string(),
            });
        }
        let (base, end) = match self.engine.run_refs(workspace_id, run_id).await {
            Ok(refs) => refs,
            Err(CheckpointError::InvalidIdentifier { .. }) => {
                return Err(StatusFailure::NotFound {
                    run_id: run_id.to_string(),
                });
            }
            Err(error) => {
                return Err(StatusFailure::Unavailable {
                    reason: engine_reason(&error),
                    detail: error.to_string(),
                });
            }
        };
        if base.is_none() && end.is_none() {
            return Err(StatusFailure::NotFound {
                run_id: run_id.to_string(),
            });
        }
        let record = self
            .seals
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&run_key(workspace_id, run_id))
            .cloned();
        let mut changed_files = Vec::new();
        if end.is_some() {
            match &record {
                Some(record) => changed_files.clone_from(&record.changed_files),
                None => match self.engine.changed_files(workspace_id, run_id).await {
                    Ok(files) => {
                        changed_files = files.iter().map(CheckpointChangedFile::from).collect()
                    }
                    Err(error) => {
                        return Err(StatusFailure::Unavailable {
                            reason: engine_reason(&error),
                            detail: error.to_string(),
                        });
                    }
                },
            }
        }
        Ok(CheckpointStatus {
            run_id: run_id.to_string(),
            state: if end.is_some() { "sealed" } else { "base" }.to_string(),
            base_ref: base.as_ref().map(|_| base_ref(run_id)),
            end_ref: end.as_ref().map(|_| end_ref(run_id)),
            base_commit: base,
            end_commit: end,
            changed_files,
            sealed_with_live_jobs: record.as_ref().is_some_and(|row| row.sealed_with_live_jobs),
            sealed_after_abnormal: record.as_ref().is_some_and(|row| row.sealed_after_abnormal),
        })
    }

    /// Retention sweep (decision #10). Unsealed runs are never deleted by the W1
    /// engine; the in-memory records of deleted runs are pruned in the same pass.
    pub async fn gc(&self, workspace_id: &str) -> Result<GcOutcome, GcFailure> {
        validate_workspace_id(workspace_id).map_err(|error| GcFailure::Validation {
            detail: error.to_string(),
        })?;
        let report = self
            .engine
            .retention_gc(workspace_id, self.max_runs, self.ttl_days)
            .await
            .map_err(|error| GcFailure::Unavailable {
                reason: engine_reason(&error),
                detail: error.to_string(),
            })?;
        self.prune_records(workspace_id, &report.deleted_runs);
        Ok(GcOutcome {
            kept_runs: report.kept_sealed + report.kept_unsealed,
            counts: GcCounts {
                deleted_runs: report.deleted_runs.len(),
                kept_sealed: report.kept_sealed,
                kept_unsealed: report.kept_unsealed,
                gc_ran: report.gc_ran,
            },
            deleted_runs: report.deleted_runs,
        })
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
            active_lease_workspaces: self.leases.active_workspaces(),
        }
    }

    async fn best_effort_gc(&self, workspace_id: &str) {
        match self
            .engine
            .retention_gc(workspace_id, self.max_runs, self.ttl_days)
            .await
        {
            Ok(report) => {
                if !report.deleted_runs.is_empty() {
                    info!(
                        workspace_id,
                        deleted = report.deleted_runs.len(),
                        "post-seal checkpoint retention removed runs"
                    );
                    self.prune_records(workspace_id, &report.deleted_runs);
                }
            }
            Err(error) => {
                warn!(
                    workspace_id,
                    error = %error,
                    "post-seal checkpoint retention failed (ignored; the seal result is authoritative)"
                );
            }
        }
    }

    /// Drop the in-memory idempotency records of runs deleted by a sweep. Keys are
    /// matched exactly (`workspaceId/runId`) so a sweep in one workspace can never
    /// drop another workspace's record nor a run id that is a mere suffix of the
    /// deleted one.
    fn prune_records(&self, workspace_id: &str, deleted_runs: &[String]) {
        if deleted_runs.is_empty() {
            return;
        }
        let deleted_keys: Vec<String> = deleted_runs
            .iter()
            .map(|run_id| run_key(workspace_id, run_id))
            .collect();
        let is_deleted = |key: &String| deleted_keys.iter().any(|deleted| key == deleted);
        let mut seals = self.seals.lock().unwrap_or_else(PoisonError::into_inner);
        seals.retain(|key, _| !is_deleted(key));
        let mut creates = self.creates.lock().unwrap_or_else(PoisonError::into_inner);
        creates.retain(|key, _| !is_deleted(key));
    }
}

fn run_key(workspace_id: &str, run_id: &str) -> String {
    // Workspace ids cannot contain `/` (storage-ref contract), so this is unambiguous.
    format!("{workspace_id}/{run_id}")
}

fn base_ref(run_id: &str) -> String {
    format!("refs/xihe/{run_id}/base")
}

fn end_ref(run_id: &str) -> String {
    format!("refs/xihe/{run_id}/end")
}

fn new_create_record() -> CreateRecord {
    CreateRecord {
        checkpoint_id: uuid::Uuid::new_v4().to_string(),
        created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    }
}

/// `GIT_TOO_OLD` when a version string was reported but rejected (below 2.20 or
/// unparseable), `GIT_UNAVAILABLE` when the binary itself could not be probed.
fn unavailable_reason(version: &Option<String>) -> &'static str {
    if version.is_some() {
        REASON_GIT_TOO_OLD
    } else {
        REASON_GIT_UNAVAILABLE
    }
}

fn engine_reason(error: &CheckpointError) -> &'static str {
    match error {
        CheckpointError::WorkspaceMissing(_) => REASON_WORKSPACE_UNKNOWN,
        CheckpointError::GitUnavailable(_) => REASON_GIT_UNAVAILABLE,
        _ => REASON_GIT_FAILED,
    }
}

fn create_failure(error: CheckpointError) -> CreateBaseFailure {
    let detail = error.to_string();
    match error {
        CheckpointError::InvalidIdentifier { .. } => CreateBaseFailure::Validation { detail },
        CheckpointError::WorkspaceMissing(_) => CreateBaseFailure::Unavailable {
            reason: REASON_WORKSPACE_UNKNOWN,
            detail,
        },
        CheckpointError::GitUnavailable(_) => CreateBaseFailure::Unavailable {
            reason: REASON_GIT_UNAVAILABLE,
            detail,
        },
        _ => CreateBaseFailure::Unavailable {
            reason: REASON_GIT_FAILED,
            detail,
        },
    }
}

fn wall_clock_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn ttl_ms(ttl: Duration) -> u64 {
    u64::try_from(ttl.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lease_acquire_conflicts_reclaims_and_releases() {
        let leases = MutationLeaseRegistry::with_ttl(Duration::from_millis(80));
        assert_eq!(
            leases.try_acquire("ws1", "run-a"),
            LeaseAcquire::Acquired { fresh: true }
        );
        assert!(leases.held_by("ws1", "run-a"));
        assert!(!leases.held_by("ws1", "run-b"));

        match leases.try_acquire("ws1", "run-b") {
            LeaseAcquire::HeldByOther(view) => {
                assert_eq!(view.run_id, "run-a");
                assert!(view.expires_at_ms > wall_clock_ms());
            }
            other => panic!("expected HeldByOther, got {other:?}"),
        }
        // The same run only extends its own lease.
        assert_eq!(
            leases.try_acquire("ws1", "run-a"),
            LeaseAcquire::Acquired { fresh: false }
        );

        // Release is owner-scoped.
        assert!(!leases.release("ws1", "run-b"));
        assert!(leases.release("ws1", "run-a"));
        assert_eq!(
            leases.try_acquire("ws1", "run-b"),
            LeaseAcquire::Acquired { fresh: true }
        );
    }

    #[test]
    fn expired_lease_is_reclaimable_and_purged_from_diagnostics() {
        let leases = MutationLeaseRegistry::with_ttl(Duration::from_millis(30));
        assert_eq!(
            leases.try_acquire("ws1", "run-a"),
            LeaseAcquire::Acquired { fresh: true }
        );
        std::thread::sleep(Duration::from_millis(60));
        assert!(!leases.held_by("ws1", "run-a"));
        assert_eq!(
            leases.try_acquire("ws1", "run-b"),
            LeaseAcquire::Acquired { fresh: true }
        );
        assert_eq!(
            leases.view("ws1").map(|view| view.run_id),
            Some("run-b".to_string())
        );
        assert_eq!(leases.active_workspaces(), vec!["ws1".to_string()]);
        assert_eq!(leases.reap_expired(), 0);
        assert_eq!(
            MutationLeaseRegistry::with_ttl(Duration::from_millis(1)).active_workspaces(),
            Vec::<String>::new()
        );
    }

    #[test]
    fn unavailable_reason_distinguishes_missing_from_old_git() {
        assert_eq!(unavailable_reason(&None), REASON_GIT_UNAVAILABLE);
        assert_eq!(
            unavailable_reason(&Some("git version 2.19.0".to_string())),
            REASON_GIT_TOO_OLD
        );
    }

    #[test]
    fn prune_records_is_workspace_scoped_and_suffix_safe() {
        let service = CheckpointService::new(std::env::temp_dir());
        let insert = |key: &str| {
            service
                .creates
                .lock()
                .unwrap()
                .insert(key.to_string(), new_create_record());
            service.seals.lock().unwrap().insert(
                key.to_string(),
                SealOutcome {
                    run_id: key.rsplit('/').next().unwrap().to_string(),
                    state: "sealed".to_string(),
                    base_ref: String::new(),
                    end_ref: String::new(),
                    changed_files: Vec::new(),
                    sealed_with_live_jobs: false,
                    sealed_after_abnormal: false,
                },
            );
        };
        insert("ws-a/run-1");
        insert("ws-a/run-11");
        insert("ws-b/run-1");

        service.prune_records("ws-a", &["run-1".to_string()]);

        let mut creates: Vec<String> = service.creates.lock().unwrap().keys().cloned().collect();
        creates.sort();
        assert_eq!(
            creates,
            vec!["ws-a/run-11".to_string(), "ws-b/run-1".to_string()],
            "only the exact (workspace, run) record may be pruned"
        );
        let mut seals: Vec<String> = service.seals.lock().unwrap().keys().cloned().collect();
        seals.sort();
        assert_eq!(
            seals,
            vec!["ws-a/run-11".to_string(), "ws-b/run-1".to_string()],
            "seal records follow the same scoping"
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
            engine_reason(&CheckpointError::RunNotFound("run-1".to_string())),
            REASON_GIT_FAILED
        );
        match create_failure(CheckpointError::InvalidIdentifier {
            kind: "run id",
            value: "..".to_string(),
            detail: "unsafe".to_string(),
        }) {
            CreateBaseFailure::Validation { detail } => assert!(detail.contains("run id")),
            other => panic!("expected Validation, got {other:?}"),
        }
    }
}
