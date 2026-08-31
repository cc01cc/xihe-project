use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::time::interval;
use tracing::{info, warn};

/// Minimal heartbeat for v1 — grill Q8 A 30s/90s is decided, but CP heartbeat API (PLAN-200) not yet implemented.
/// For now, this only logs and flips a local `alive` flag; future will POST /internal/v1/runtime/heartbeat.
pub async fn heartbeat_loop(ready: Arc<AtomicBool>, ct: tokio_util::sync::CancellationToken) {
    let mut ticker = interval(Duration::from_secs(30));
    let mut missed = 0u8;
    loop {
        tokio::select! {
            _ = ct.cancelled() => {
                info!("heartbeat loop cancelled");
                break;
            }
            _ = ticker.tick() => {
                if ready.load(Ordering::Relaxed) {
                    // In real hydrate, this would POST to CP; for v1, just log
                    info!("heartbeat: ready=true, tick");
                    missed = 0;
                } else {
                    missed += 1;
                    warn!("heartbeat: not ready, missed={}", missed);
                    if missed == 3 {
                        warn!("heartbeat: stale threshold reached (90s) per Q22 A");
                    }
                    if missed >= 6 {
                        warn!("heartbeat: blocked threshold reached (180s) per Q22 A");
                    }
                }
            }
        }
    }
}
