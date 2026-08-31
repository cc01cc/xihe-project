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
    // Try to fetch assignments from CP (if CP is up); otherwise keep ready as is.
    let cp_url = std::env::var("XIHE_CP_URL").unwrap_or_else(|_| "http://localhost:12631".to_string());
    let url = format!("{}/internal/v1/runtime/assignments", cp_url);
    match tokio::time::timeout(Duration::from_secs(2), reqwest::get(&url)).await {
        Ok(Ok(resp)) if resp.status().is_success() => {
            match resp.json::<serde_json::Value>().await {
                Ok(v) => {
                    let count = v.as_array().map(|a| a.len()).unwrap_or(0);
                    info!("hydrate: fetched {} assignments from {}", count, url);
                    if count > 0 {
                        // For v1, just log; future will compare generation/hash and reconcile
                        for item in v.as_array().unwrap() {
                            let ws_id = item.get("workspaceId").and_then(|x| x.as_str()).unwrap_or("?");
                            let generation = item.get("generation").and_then(|x| x.as_u64()).unwrap_or(0);
                            let hash = item.get("sandboxSpecHash").and_then(|x| x.as_str()).unwrap_or("");
                            info!("hydrate: assignment ws={} gen={} hash={}", ws_id, generation, hash);
                        }
                    }
                }
                Err(e) => warn!("hydrate: parse assignments failed: {}", e),
            }
        }
        Ok(Ok(resp)) => warn!("hydrate: CP returned {} for {}", resp.status(), url),
        Ok(Err(e)) => warn!("hydrate: request failed: {} for {}", e, url),
        Err(_) => warn!("hydrate: timeout for {}", url),
    }
    if !registry.is_hydrated() {
        info!("hydrate: registry not yet hydrated (PLAN-200 pending), keeping ready as is");
    } else {
        info!("hydrate: registry already hydrated ({} workspaces)", registry.all_instances().await.len());
    }
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
