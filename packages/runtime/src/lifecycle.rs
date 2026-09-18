//! PLAN-0345: single authoritative workspace lifecycle (decision #9, #14).
//!
//! Six canonical states (`creating/ready/paused/stopped/failed/destroying`);
//! legacy `Suspended`/`Released`/`Materializing` never enter the public enum.
//! Every transition goes through [`Lifecycle`]; `WorkspaceRegistry` write
//! methods are demoted to `pub(crate)` and only this module (plus the ensurer's
//! materialize path, physically in the same crate) may call them.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Mutex, MutexGuard, RwLock};
use tracing::{info, warn};

use crate::error::RuntimeError;
use crate::gateway::{InstanceState, MaterializationState, WorkspaceRegistry};
use crate::sandbox::SecurityProfile;

/// Canonical lifecycle states (DEV-032; PLAN-0345 decision #9).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleState {
    Creating,
    Ready,
    Paused,
    Stopped,
    Failed,
    Destroying,
}

impl LifecycleState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Creating => "creating",
            Self::Ready => "ready",
            Self::Paused => "paused",
            Self::Stopped => "stopped",
            Self::Failed => "failed",
            Self::Destroying => "destroying",
        }
    }

    /// Legal transitions table (spec §2). Anything else is rejected loudly.
    fn allows(&self, to: Self) -> bool {
        use LifecycleState::*;
        matches!(
            (self, to),
            (Creating, Ready)
                | (Creating, Failed)
                | (Creating, Destroying)
                | (Ready, Paused)
                | (Ready, Stopped)
                | (Ready, Failed)
                | (Ready, Destroying)
                | (Paused, Ready)
                | (Paused, Stopped)
                | (Paused, Failed)
                | (Paused, Destroying)
                | (Stopped, Ready)
                | (Stopped, Failed)
                | (Stopped, Destroying)
                | (Failed, Ready)
                | (Failed, Stopped)
                | (Failed, Destroying)
                | (Destroying, Destroying) // destroy is idempotent while in flight
        )
    }
}

/// PLAN-0345 T2.2 (decision #10): single in-process execution lease per
/// workspace, bound to an in-flight operation (ensure/destroy/pause/unpause).
/// No heartbeat, no fixed TTL, no persistence: rebuilt implicitly from Docker
/// state after a restart because the registry itself starts empty.
#[derive(Debug, Default)]
pub struct ExecutionLease {
    holders: RwLock<HashMap<String, String>>,
}

impl ExecutionLease {
    pub fn new() -> Self {
        Self::default()
    }

    /// Acquire the lease for `op` on `ws_id`; rejects when another op holds it.
    pub async fn acquire(&self, ws_id: &str, op: &str) -> Result<LeaseGuard<'_>, RuntimeError> {
        let mut holders = self.holders.write().await;
        if let Some(holder) = holders.get(ws_id)
            && holder != op
        {
            return Err(RuntimeError::WorkspaceBusy {
                workspace_id: ws_id.to_string(),
                holder: holder.to_string(),
            });
        }
        holders.insert(ws_id.to_string(), op.to_string());
        Ok(LeaseGuard {
            leases: self,
            ws_id: ws_id.to_string(),
        })
    }

    /// Whether `op` currently holds the lease on `ws_id`.
    pub async fn is_holder(&self, ws_id: &str, op: &str) -> bool {
        self.holders
            .read()
            .await
            .get(ws_id)
            .is_some_and(|h| h == op)
    }

    /// Late-arrival rejection (V3): a task holding a stale lease (e.g. an old
    /// handle whose generation was replaced) must be refused.
    pub async fn reject_stale(&self, ws_id: &str, op: &str) -> Result<(), RuntimeError> {
        if self.is_holder(ws_id, op).await {
            return Ok(());
        }
        Err(RuntimeError::WorkspaceBusy {
            workspace_id: ws_id.to_string(),
            holder: "stale-handle".to_string(),
        })
    }
}

/// RAII guard: released on drop or explicit [`LeaseGuard::release`].
pub struct LeaseGuard<'a> {
    leases: &'a ExecutionLease,
    ws_id: String,
}

impl LeaseGuard<'_> {
    pub async fn release(self) {
        self.leases.holders.write().await.remove(&self.ws_id);
    }
}

impl Drop for LeaseGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut holders) = self.leases.holders.try_write() {
            holders.remove(&self.ws_id);
        }
        // Contended case: the write lock is held by another acquire; the entry
        // is ours so it will be visible to the next acquire. To avoid leaking,
        // spawn-free best effort: try again shortly is overkill for an
        // in-process lease whose holder map is only ever touched by short
        // critical sections, so we accept try_write semantics.
    }
}

/// Single authoritative write path. Owns all registry state mutations.
pub struct Lifecycle {
    registry: Arc<WorkspaceRegistry>,
    leases: Arc<ExecutionLease>,
    /// Per-ws in-flight transition serialisation (distinct from the ensurer's
    /// materialize lock: this one guards the state record, not Docker work).
    transitions: Mutex<()>,
}

impl Lifecycle {
    pub fn new(registry: Arc<WorkspaceRegistry>, leases: Arc<ExecutionLease>) -> Self {
        Self {
            registry,
            leases,
            transitions: Mutex::new(()),
        }
    }

    pub fn leases(&self) -> &Arc<ExecutionLease> {
        &self.leases
    }

    pub fn registry(&self) -> &Arc<WorkspaceRegistry> {
        &self.registry
    }

    /// Serialised transition gate. Callers hold the guard across the Docker
    /// verb + registry write so concurrent transitions cannot interleave.
    pub async fn transition_guard(&self) -> MutexGuard<'_, ()> {
        self.transitions.lock().await
    }

    /// Apply `to` with legality checking, logging and dual-map write-through.
    /// `reason` carries the failure detail for `Failed` transitions.
    pub async fn transition(
        &self,
        ws_id: &str,
        to: LifecycleState,
        reason: Option<&str>,
    ) -> Result<(), RuntimeError> {
        let _guard = self.transitions.lock().await;
        self.transition_locked(ws_id, to, reason).await
    }

    /// Apply without re-acquiring the transition mutex (caller already holds
    /// [`Lifecycle::transition_guard`], e.g. across a Docker verb).
    pub async fn transition_locked(
        &self,
        ws_id: &str,
        to: LifecycleState,
        reason: Option<&str>,
    ) -> Result<(), RuntimeError> {
        let from = self.ensure_legal(ws_id, to).await?;
        self.write_through(ws_id, to, reason).await;
        info!(
            workspace_id = %ws_id,
            from = from.map(|s| s.as_str()).unwrap_or("none"),
            to = to.as_str(),
            reason = reason.unwrap_or(""),
            "workspace lifecycle transition"
        );
        Ok(())
    }

    /// Legality gate (spec §2 table): same-state writes are idempotent no-ops;
    /// anything not in `allows()` fails loudly. Returns the derived from-state.
    async fn ensure_legal(
        &self,
        ws_id: &str,
        to: LifecycleState,
    ) -> Result<Option<LifecycleState>, RuntimeError> {
        let from = self.current(ws_id).await;
        if let Some(from) = from
            && from != to
            && !from.allows(to)
        {
            return Err(RuntimeError::InvalidTransition {
                workspace_id: ws_id.to_string(),
                from: from.as_str(),
                to: to.as_str(),
            });
        }
        Ok(from)
    }

    /// Current canonical state, deriving from the registry dual maps.
    /// `destroying` has its own map entry; otherwise instance state wins and
    /// the status map refines it.
    pub async fn current(&self, ws_id: &str) -> Option<LifecycleState> {
        let instance = self.registry.get(ws_id).await;
        let status = self.registry.status(ws_id).await;
        derive_state(instance.as_ref().map(|i| i.state), status.map(|s| s.state))
    }

    /// Terminate the workspace record: destroy finished successfully (F2:
    /// no resident `destroyed` state — the instance disappears; the status map
    /// keeps a `released` marker for the UI's "已释放" presentation).
    pub async fn complete_destroy(&self, ws_id: &str) {
        let _guard = self.transitions.lock().await;
        self.registry.unregister(ws_id).await;
        self.registry.mark_released(ws_id).await;
        info!(workspace_id = %ws_id, "workspace lifecycle: destroy complete (unregistered)");
    }

    /// Startup/periodic rebuild (I1: registry is a cache). Derives lifecycle
    /// state from live Docker facts; entries absent from Docker cannot be
    /// reconstructed and are simply absent (404 on later access).
    pub async fn rebuild_from_instances(&self, live: Vec<(String, InstanceState)>) {
        let _guard = self.transitions.lock().await;
        for (ws_id, state) in live {
            if self.registry.get(&ws_id).await.is_some() {
                continue;
            }
            let target = match state {
                InstanceState::Active => LifecycleState::Ready,
                InstanceState::Paused => LifecycleState::Paused,
                InstanceState::Stopped => LifecycleState::Stopped,
                // Legacy tiers never re-enter the public enum.
                InstanceState::Suspended | InstanceState::Released => LifecycleState::Stopped,
            };
            self.registry.register(&ws_id, "").await;
            self.write_through(&ws_id, target, None).await;
            info!(workspace_id = %ws_id, to = target.as_str(), "workspace lifecycle rebuilt");
        }
    }

    /// Progress marker: materialization started. This is NOT a canonical state
    /// transition (`Creating` is derived from `instance + status=Materializing`),
    /// so it is allowed to re-enter from Ready/Paused; it exists so UI and the
    /// consistency checker can see an operation in flight.
    pub async fn begin_materialize(&self, ws_id: &str) {
        let _guard = self.transitions.lock().await;
        self.registry.mark_materializing(ws_id).await;
        info!(workspace_id = %ws_id, "workspace lifecycle: materializing");
    }

    /// Register (or replace) the instance and mark Ready with spec
    /// generation/hash. Used by the materialize success path.
    pub async fn register_ready(
        &self,
        ws_id: &str,
        workspace_path: &str,
        profile: SecurityProfile,
        generation: u64,
        spec_hash: &str,
    ) -> Result<(), RuntimeError> {
        let _guard = self.transitions.lock().await;
        self.ensure_legal(ws_id, LifecycleState::Ready).await?;
        self.registry
            .register_with_spec(ws_id, workspace_path, profile, generation, spec_hash)
            .await;
        info!(
            workspace_id = %ws_id,
            generation, "workspace lifecycle: registered ready"
        );
        Ok(())
    }

    /// Mark Ready without re-registering: instance flips Active + status ready
    /// carries generation/hash. Used by cache-hit revalidation and unpause.
    pub async fn mark_ready(
        &self,
        ws_id: &str,
        generation: u64,
        spec_hash: &str,
    ) -> Result<(), RuntimeError> {
        let _guard = self.transitions.lock().await;
        self.ensure_legal(ws_id, LifecycleState::Ready).await?;
        if self.registry.get(ws_id).await.is_some() {
            self.registry.set_state(ws_id, InstanceState::Active).await;
        }
        self.registry.mark_ready(ws_id, generation, spec_hash).await;
        info!(
            workspace_id = %ws_id,
            generation, "workspace lifecycle: ready"
        );
        Ok(())
    }

    /// Materialize failed midway: `Failed(reason)` + instance entry removed
    /// (I1 cache semantics). Failure recording must never be interrupted by a
    /// legality check, so this writes unconditionally.
    pub async fn fail_materialization(&self, ws_id: &str, detail: &str) {
        let _guard = self.transitions.lock().await;
        self.registry.mark_failed(ws_id, detail).await;
        self.registry.unregister(ws_id).await;
        warn!(
            workspace_id = %ws_id,
            error = %detail,
            "workspace lifecycle: materialization failed"
        );
    }

    /// Reaper evict: drop the instance record and keep a `released` marker
    /// (fixes the 0345 gap where evict only unregistered, leaving stale status).
    pub async fn evict(&self, ws_id: &str) {
        let _guard = self.transitions.lock().await;
        self.registry.unregister(ws_id).await;
        self.registry.mark_released(ws_id).await;
        info!(workspace_id = %ws_id, "workspace lifecycle: evicted (record released)");
    }

    async fn write_through(&self, ws_id: &str, to: LifecycleState, reason: Option<&str>) {
        let instance_state = match to {
            LifecycleState::Creating | LifecycleState::Ready => InstanceState::Active,
            LifecycleState::Paused => InstanceState::Paused,
            LifecycleState::Stopped | LifecycleState::Failed => InstanceState::Stopped,
            LifecycleState::Destroying => InstanceState::Stopped,
        };
        // Keep the instance entry's state in sync when one exists; entries are
        // created by materialize (register_with_spec), not by transitions.
        if self.registry.get(ws_id).await.is_some() {
            self.registry.set_state(ws_id, instance_state).await;
        }
        let status_state = match to {
            LifecycleState::Creating => MaterializationState::Materializing,
            LifecycleState::Ready => MaterializationState::Ready,
            LifecycleState::Paused
            | LifecycleState::Stopped
            | LifecycleState::Failed
            | LifecycleState::Destroying => MaterializationState::Ready,
        };
        match to {
            LifecycleState::Creating => self.registry.mark_materializing(ws_id).await,
            LifecycleState::Ready => {
                let (generation, hash) = self
                    .registry
                    .status(ws_id)
                    .await
                    .map_or((0, String::new()), |s| {
                        (s.generation.unwrap_or(0), s.spec_hash.unwrap_or_default())
                    });
                self.registry.mark_ready(ws_id, generation, &hash).await;
            }
            LifecycleState::Failed => {
                self.registry
                    .mark_failed(ws_id, reason.unwrap_or("workspace failed"))
                    .await;
            }
            LifecycleState::Destroying => {
                self.registry.mark_destroying(ws_id).await;
            }
            // Paused/Stopped live on the instance map; statuses stay Ready so
            // the consistency checker does not flag Ready-instance pairs.
            LifecycleState::Paused | LifecycleState::Stopped => {
                if self.registry.get(ws_id).await.is_none() {
                    // Instance entries for paused/stopped without a registry
                    // entry come from rebuild; nothing to mirror.
                }
            }
        }
        let _ = status_state;
    }
}

/// Derive the canonical state from the legacy dual maps.
pub fn derive_state(
    instance: Option<InstanceState>,
    status: Option<MaterializationState>,
) -> Option<LifecycleState> {
    match (instance, status) {
        (Some(_), Some(MaterializationState::Materializing)) => Some(LifecycleState::Creating),
        (Some(InstanceState::Active), _) => Some(LifecycleState::Ready),
        (Some(InstanceState::Paused), _) => Some(LifecycleState::Paused),
        (Some(InstanceState::Stopped), _) => Some(LifecycleState::Stopped),
        (Some(InstanceState::Suspended) | Some(InstanceState::Released), _) => {
            Some(LifecycleState::Stopped)
        }
        (None, Some(MaterializationState::Released)) => Some(LifecycleState::Stopped),
        // Failed on the status map only surfaces when the instance entry is
        // gone (the ensurer unregisters on failure).
        (None, Some(MaterializationState::Failed)) => Some(LifecycleState::Failed),
        (None, Some(MaterializationState::Destroying)) => Some(LifecycleState::Destroying),
        _ => None,
    }
}

/// Idle reaper thresholds, extracted for unit testing (previously inline).
pub mod reaper {
    use super::*;

    pub const TIER1_PAUSE: Duration = Duration::from_secs(900);
    pub const TIER2_STOP: Duration = Duration::from_secs(7200);
    pub const TIER3_EVICT: Duration = Duration::from_secs(86400);

    /// PLAN-0345 T1.4 (decision #17/F4): the legacy 4-tier ladder collapses to
    /// 3 tiers. Tier 4 (7d `Released`) is deleted: Tier 3 already unregisters
    /// the instance, so there is nothing left to mark.
    pub fn target_tier(idle: Duration) -> Option<ReapTier> {
        if idle >= TIER3_EVICT {
            Some(ReapTier::Evict)
        } else if idle >= TIER2_STOP {
            Some(ReapTier::Stop)
        } else if idle >= TIER1_PAUSE {
            Some(ReapTier::Pause)
        } else {
            None
        }
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum ReapTier {
        Pause,
        Stop,
        Evict,
    }

    impl ReapTier {
        pub fn target(self) -> LifecycleState {
            match self {
                Self::Pause => LifecycleState::Paused,
                Self::Stop => LifecycleState::Stopped,
                Self::Evict => LifecycleState::Stopped,
            }
        }
    }

    /// Structured transition log fields (T2.5; event names frozen for 0346).
    pub fn log_transition(event: &str, ws_id: &str, from: &str, to: &str, error: &str) {
        if error.is_empty() {
            info!(
                event = event,
                workspace_id = ws_id,
                from = from,
                to = to,
                "workspace lifecycle event"
            );
        } else {
            warn!(
                event = event,
                workspace_id = ws_id,
                from = from,
                to = to,
                error = error,
                "workspace lifecycle event"
            );
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn tier_ladder_matches_legacy_thresholds() {
            assert_eq!(target_tier(Duration::from_secs(0)), None);
            assert_eq!(target_tier(Duration::from_secs(899)), None);
            assert_eq!(target_tier(Duration::from_secs(900)), Some(ReapTier::Pause));
            assert_eq!(
                target_tier(Duration::from_secs(7199)),
                Some(ReapTier::Pause)
            );
            assert_eq!(target_tier(Duration::from_secs(7200)), Some(ReapTier::Stop));
            assert_eq!(
                target_tier(Duration::from_secs(86399)),
                Some(ReapTier::Stop)
            );
            assert_eq!(
                target_tier(Duration::from_secs(86400)),
                Some(ReapTier::Evict)
            );
        }

        #[test]
        fn tier4_is_deleted() {
            // 7d idle maps to Evict, not to a dedicated Released tier.
            assert_eq!(
                target_tier(Duration::from_secs(604800)),
                Some(ReapTier::Evict)
            );
        }

        #[test]
        fn structured_log_fields_do_not_panic() {
            log_transition("ensure_ready", "ws-1", "creating", "ready", "");
            log_transition("ensure_failed", "ws-1", "creating", "failed", "docker down");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> Arc<WorkspaceRegistry> {
        Arc::new(WorkspaceRegistry::new())
    }

    async fn seeded() -> (Arc<WorkspaceRegistry>, Lifecycle) {
        let registry = registry();
        registry.register("ws-1", "/tmp/ws-1").await;
        let lifecycle = Lifecycle::new(registry.clone(), Arc::new(ExecutionLease::new()));
        (registry, lifecycle)
    }

    #[tokio::test]
    async fn transition_creates_then_fails_closed_on_illegal() {
        let (registry, lifecycle) = seeded().await;
        // Seeded as Active/Ready via register(); walk the legal M-2 loop.
        assert_eq!(lifecycle.current("ws-1").await, Some(LifecycleState::Ready));
        lifecycle
            .transition("ws-1", LifecycleState::Paused, None)
            .await
            .unwrap();
        assert_eq!(
            lifecycle.current("ws-1").await,
            Some(LifecycleState::Paused)
        );
        lifecycle
            .transition("ws-1", LifecycleState::Ready, None)
            .await
            .unwrap();
        assert_eq!(lifecycle.current("ws-1").await, Some(LifecycleState::Ready));
        // Illegal jump: ready -> paused is legal but paused -> destroy… no:
        // destroying IS legal from paused. Illegal here: ready -> creating.
        registry.set_state("ws-1", InstanceState::Active).await;
        let err = lifecycle
            .transition("ws-1", LifecycleState::Creating, None)
            .await;
        assert!(
            matches!(err, Err(RuntimeError::InvalidTransition { .. })),
            "ready -> creating must be rejected, got {err:?}"
        );
    }

    #[tokio::test]
    async fn illegal_transition_is_rejected() {
        let (registry, lifecycle) = seeded().await;
        registry.set_state("ws-1", InstanceState::Active).await;
        // destroying IS legal from ready; instead test ready -> creating.
        let err = lifecycle
            .transition("ws-1", LifecycleState::Creating, None)
            .await;
        assert!(
            matches!(err, Err(RuntimeError::InvalidTransition { .. })),
            "ready -> creating must be rejected, got {err:?}"
        );
    }

    #[tokio::test]
    async fn complete_destroy_unregisters_and_marks_released() {
        let (registry, lifecycle) = seeded().await;
        lifecycle
            .transition("ws-1", LifecycleState::Destroying, None)
            .await
            .unwrap();
        lifecycle.complete_destroy("ws-1").await;
        assert!(
            registry.get("ws-1").await.is_none(),
            "F2: no destroyed residency"
        );
        let status = registry.status("ws-1").await.expect("status marker kept");
        assert_eq!(status.state, MaterializationState::Released);
    }

    #[tokio::test]
    async fn lease_rejects_second_holder_and_releases_on_drop() {
        let leases = ExecutionLease::new();
        {
            let _guard = leases.acquire("ws-1", "ensure").await.unwrap();
            let second = leases.acquire("ws-1", "destroy").await;
            assert!(second.is_err(), "double-holder must be rejected");
            let same = leases.acquire("ws-1", "ensure").await;
            assert!(same.is_ok(), "same op re-entrant until released");
        }
        // Dropped: released.
        let next = leases.acquire("ws-1", "destroy").await;
        assert!(next.is_ok(), "guard drop must release the lease");
    }

    #[tokio::test]
    async fn lease_rejects_stale_handles() {
        let leases = ExecutionLease::new();
        leases.acquire("ws-1", "destroy").await.unwrap();
        let stale = leases.reject_stale("ws-1", "old-task");
        // reject_stale is async; drive it.
        assert!(stale.await.is_err());
    }

    #[test]
    fn derive_maps_legacy_pairs() {
        assert_eq!(
            derive_state(
                Some(InstanceState::Active),
                Some(MaterializationState::Ready)
            ),
            Some(LifecycleState::Ready)
        );
        assert_eq!(
            derive_state(
                Some(InstanceState::Active),
                Some(MaterializationState::Materializing)
            ),
            Some(LifecycleState::Creating)
        );
        assert_eq!(
            derive_state(
                Some(InstanceState::Paused),
                Some(MaterializationState::Ready)
            ),
            Some(LifecycleState::Paused)
        );
        assert_eq!(
            derive_state(Some(InstanceState::Suspended), None),
            Some(LifecycleState::Stopped)
        );
        assert_eq!(
            derive_state(None, Some(MaterializationState::Released)),
            Some(LifecycleState::Stopped)
        );
        assert_eq!(
            derive_state(None, Some(MaterializationState::Failed)),
            Some(LifecycleState::Failed)
        );
        assert_eq!(derive_state(None, None), None);
    }

    #[tokio::test]
    async fn rebuild_skips_known_and_maps_live_states() {
        let registry = registry();
        let lifecycle = Lifecycle::new(registry.clone(), Arc::new(ExecutionLease::new()));
        lifecycle
            .rebuild_from_instances(vec![
                ("ws-a".to_string(), InstanceState::Active),
                ("ws-b".to_string(), InstanceState::Paused),
                ("ws-c".to_string(), InstanceState::Suspended),
            ])
            .await;
        assert_eq!(lifecycle.current("ws-a").await, Some(LifecycleState::Ready));
        assert_eq!(
            lifecycle.current("ws-b").await,
            Some(LifecycleState::Paused)
        );
        assert_eq!(
            lifecycle.current("ws-c").await,
            Some(LifecycleState::Stopped)
        );
        // Idempotent: second rebuild skips existing entries.
        lifecycle
            .rebuild_from_instances(vec![("ws-a".to_string(), InstanceState::Active)])
            .await;
        assert_eq!(lifecycle.current("ws-a").await, Some(LifecycleState::Ready));
    }

    #[tokio::test]
    async fn begin_materialize_marks_progress_and_derives_creating() {
        let (registry, lifecycle) = seeded().await;
        lifecycle.begin_materialize("ws-1").await;
        assert_eq!(
            lifecycle.current("ws-1").await,
            Some(LifecycleState::Creating)
        );
        assert_eq!(
            registry.status("ws-1").await.unwrap().state,
            MaterializationState::Materializing
        );
    }

    #[tokio::test]
    async fn register_ready_replaces_instance_with_spec() {
        let (registry, lifecycle) = seeded().await;
        lifecycle
            .transition("ws-1", LifecycleState::Failed, Some("boom"))
            .await
            .unwrap();
        lifecycle
            .register_ready("ws-1", "/tmp/ws-1", SecurityProfile::Coding, 7, "hash-7")
            .await
            .unwrap();
        assert_eq!(lifecycle.current("ws-1").await, Some(LifecycleState::Ready));
        let instance = registry.get("ws-1").await.unwrap();
        assert_eq!(instance.generation, 7);
        assert_eq!(instance.spec_hash, "hash-7");
        assert_eq!(instance.state, InstanceState::Active);
    }

    #[tokio::test]
    async fn mark_ready_flips_paused_instance_active() {
        let (registry, lifecycle) = seeded().await;
        lifecycle
            .transition("ws-1", LifecycleState::Paused, None)
            .await
            .unwrap();
        lifecycle.begin_materialize("ws-1").await;
        lifecycle.mark_ready("ws-1", 3, "hash-3").await.unwrap();
        assert_eq!(lifecycle.current("ws-1").await, Some(LifecycleState::Ready));
        let instance = registry.get("ws-1").await.unwrap();
        assert_eq!(instance.state, InstanceState::Active);
        assert_eq!(registry.status("ws-1").await.unwrap().generation, Some(3));
    }

    #[tokio::test]
    async fn fail_materialization_unregisters_and_keeps_failed_status() {
        let (registry, lifecycle) = seeded().await;
        lifecycle.begin_materialize("ws-1").await;
        lifecycle.fail_materialization("ws-1", "docker down").await;
        assert!(registry.get("ws-1").await.is_none());
        let status = registry.status("ws-1").await.unwrap();
        assert_eq!(status.state, MaterializationState::Failed);
        assert_eq!(status.last_error.as_deref(), Some("docker down"));
        assert_eq!(
            lifecycle.current("ws-1").await,
            Some(LifecycleState::Failed)
        );
    }

    #[tokio::test]
    async fn evict_unregisters_and_marks_released() {
        let (registry, lifecycle) = seeded().await;
        lifecycle.evict("ws-1").await;
        assert!(registry.get("ws-1").await.is_none());
        assert_eq!(
            registry.status("ws-1").await.unwrap().state,
            MaterializationState::Released
        );
    }

    #[tokio::test]
    async fn destroying_marker_is_visible_on_status_map() {
        let (registry, lifecycle) = seeded().await;
        lifecycle
            .transition("ws-1", LifecycleState::Destroying, None)
            .await
            .unwrap();
        assert_eq!(
            registry.status("ws-1").await.unwrap().state,
            MaterializationState::Destroying
        );
    }
}
