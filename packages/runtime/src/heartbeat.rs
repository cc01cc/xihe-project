use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use reqwest::Client;
use tokio::time::interval;
use tracing::{info, warn};

pub async fn heartbeat_loop(
    ready: Arc<AtomicBool>,
    cp_url: String,
    api_token: String,
    device_id: String,
    ct: tokio_util::sync::CancellationToken,
) {
    let mut ticker = interval(Duration::from_secs(30));
    let client = Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .expect("failed to build heartbeat HTTP client");
    loop {
        tokio::select! {
            _ = ct.cancelled() => {
                info!("heartbeat loop cancelled");
                break;
            }
            _ = ticker.tick() => {
                let status = if ready.load(Ordering::Relaxed) { "ready" } else { "blocked" };
                let url = format!("{cp_url}/internal/v1/runtime/heartbeat");
                let result = client
                    .post(&url)
                    .bearer_auth(&api_token)
                    .json(&serde_json::json!({
                        "deviceId": device_id,
                        "status": status,
                    }))
                    .send()
                    .await;
                match result {
                    Ok(response) if response.status().is_success() => {
                        info!("heartbeat: sent deviceId={} status={}", device_id, status);
                    }
                    Ok(response) => {
                        warn!("heartbeat: CP returned {} for {}", response.status(), url);
                    }
                    Err(error) => {
                        warn!("heartbeat: request failed for {}: {}", url, error);
                    }
                }
            }
        }
    }
}
