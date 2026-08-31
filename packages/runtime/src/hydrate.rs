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

/// Background hydrate loop — for v1, polls CP and logs generation/hash diff per Q19 A (full rebuild on diff).
/// Future: will actually call WorkspaceManager to recreate Container when diff detected.
/// Uses a local `last_seen` map to track last generation/hash per wsId.
use std::collections::HashMap;
use tokio::sync::Mutex as TokioMutex;

pub async fn hydrate_loop(registry: Arc<WorkspaceRegistry>, ready: Arc<AtomicBool>, ct: tokio_util::sync::CancellationToken) {
    let mut ticker = interval(Duration::from_secs(30));
    let last_seen: Arc<TokioMutex<HashMap<String, (u64, String)>>> =
        Arc::new(TokioMutex::new(HashMap::new()));
    loop {
        tokio::select! {
            _ = ct.cancelled() => {
                info!("hydrate loop cancelled");
                break;
            }
            _ = ticker.tick() => {
                let count = registry.all_instances().await.len();
                let is_ready = ready.load(Ordering::Relaxed);
                info!("hydrate tick: hydrated={} workspaces={} ready={}", registry.is_hydrated(), count, is_ready);
                if !is_ready {
                    warn!("hydrate: still not ready, waiting for first assignment");
                }
                // Try to fetch assignments and compare generation/hash per Q19 A
                let cp_url = std::env::var("XIHE_CP_URL").unwrap_or_else(|_| "http://localhost:12631".to_string());
                let url = format!("{}/internal/v1/runtime/assignments", cp_url);
                if let Ok(Ok(resp)) = tokio::time::timeout(Duration::from_secs(2), reqwest::get(&url)).await {
                    if resp.status().is_success() {
                        if let Ok(v) = resp.json::<serde_json::Value>().await {
                            if let Some(arr) = v.as_array() {
                                let mut last = last_seen.lock().await;
                                for item in arr {
                                    let ws_id = item.get("workspaceId").and_then(|x| x.as_str()).unwrap_or("?").to_string();
                                    let generation = item.get("generation").and_then(|x| x.as_u64()).unwrap_or(0);
                                    let hash = item.get("sandboxSpecHash").and_then(|x| x.as_str()).unwrap_or("").to_string();
                                    let prev = last.get(&ws_id).cloned().unwrap_or((0, String::new()));
                                    if prev.0 != generation || prev.1 != hash {
                                        if generation < prev.0 {
                                            info!("hydrate: ignoring old generation for {}: {} < {} per Q21 A", ws_id, generation, prev.0);
                                        } else {
                                            if prev.0 != 0 || !prev.1.is_empty() {
                                                info!("hydrate: generation/hash changed for {}: {}->{} ({}->{}), would rebuild per Q19 A", ws_id, prev.0, generation, prev.1, hash);
                                            }
                                            last.insert(ws_id, (generation, hash));
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
