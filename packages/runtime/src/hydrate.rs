use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::time::{Duration, interval};
use tracing::{info, warn};

use crate::gateway::WorkspaceRegistry;

/// Minimal hydrate stub for v1 — grill Q12 A (generation+hash) is decided, but CP assignment API (PLAN-200) not yet implemented.
/// For now, this only flips `ready` after a short delay and logs; future hydrate will:
/// - GET /internal/v1/runtime/assignments?runtimeId=...&deviceId=...
/// - Compare `generation` (monotonic) and `sandboxSpecHash` (canonical SHA256)
/// - Reconcile: if generation > last or hash drift → recreate Container
pub async fn hydrate_once(registry: Arc<WorkspaceRegistry>, ready: Arc<AtomicBool>) {
    // Simulate a tiny hydrate delay; in real hydrate, this would be a CP fetch.
    tokio::time::sleep(Duration::from_millis(200)).await;
    if !registry.is_hydrated() {
        // No assignments yet — for v1, we still mark ready after deviceId (as done in main.rs).
        // Future: only mark ready after successful assignment fetch.
        info!("hydrate: no assignments yet (PLAN-200 pending), keeping ready as is");
    } else {
        info!("hydrate: registry already hydrated ({} workspaces)", registry.all_instances().await.len());
    }
    // Ensure ready is true for v1 (main.rs already set it, but we keep idempotent)
    ready.store(true, Ordering::Relaxed);
}

/// Background hydrate loop — for v1, just logs every 30s (grill Q8 A 30s heartbeat).
/// Future: will poll CP for assignments and trigger reconcile on generation bump.
pub async fn hydrate_loop(registry: Arc<WorkspaceRegistry>, ready: Arc<AtomicBool>, ct: tokio_util::sync::CancellationToken) {
    let mut ticker = interval(Duration::from_secs(30));
    loop {
        tokio::select! {
            _ = ct.cancelled() => {
                info!("hydrate loop cancelled");
                break;
            }
            _ = ticker.tick() => {
                // For v1, just log; future will fetch assignments
                let count = registry.all_instances().await.len();
                let is_ready = ready.load(Ordering::Relaxed);
                info!("hydrate tick: hydrated={} workspaces={} ready={}", registry.is_hydrated(), count, is_ready);
                if !is_ready {
                    warn!("hydrate: still not ready, waiting for first assignment");
                }
            }
        }
    }
}
