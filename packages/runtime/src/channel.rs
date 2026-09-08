//! XH Channel WebSocket client (PLAN-245).
//!
//! Outbound connection from Runtime to CP: hello → welcome, then app-level
//! heartbeat events at 30s. Transport ping/pong stays framework-managed.
//! Disconnects never lose commands: the channel layer caches nothing; after a
//! reconnect the Runtime re-sends hello with a fresh workspace summary and CP
//! drives reconciliation via resync_required (PLAN-222 semantics).
//!
//! Sink selection: when the channel is connected, HTTP heartbeat POST is
//! suspended (single-sink rule, no double reporting). On disconnect the
//! Runtime falls back to HTTP automatically and logs channel_fallback.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};
use url::Url;

use crate::channel_proto::{
    Envelope, WorkspaceSummary, TYPE_ACK, TYPE_EVENT, TYPE_HELLO, TYPE_WELCOME,
};
use crate::gateway::WorkspaceRegistry;

/// Formats the channel WS URL: ws(s)://host[:port]/internal/v1/channel.
pub fn channel_url(cp_url: &str) -> Result<String, String> {
    let mut parsed =
        Url::parse(cp_url.trim_end_matches('/')).map_err(|e| format!("bad cp url: {e}"))?;
    match parsed.scheme() {
        "https" => parsed.set_scheme("wss").map_err(|_| "scheme downgrade")?,
        "http" => parsed.set_scheme("ws").map_err(|_| "scheme upgrade")?,
        "ws" | "wss" => {}
        other => return Err(format!("unsupported scheme: {other}")),
    }
    parsed.set_path("/internal/v1/channel");
    Ok(parsed.as_str().to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelState {
    Disabled,
    Connecting,
    Connected,
    FallbackHttp,
}

/// Shared channel handle owned by the Runtime process.
pub struct ChannelClient {
    pub url: String,
    pub api_token: String,
    pub device_id: String,
    state: Arc<AtomicBool>,
    connected: Arc<AtomicBool>,
    outbound_sequence: Arc<Mutex<i64>>,
}

impl ChannelClient {
    pub fn from_env(device_id: String) -> Option<Self> {
        let url = std::env::var("XIHE_CHANNEL_URL").ok()?;
        if url.trim().is_empty() {
            return None;
        }
        Some(Self {
            url: channel_url(&url).ok()?,
            api_token: std::env::var("XIHE_CP_API_TOKEN")
                .unwrap_or_else(|_| "dev-token-not-secure".into()),
            device_id,
            state: Arc::new(AtomicBool::new(false)),
            connected: Arc::new(AtomicBool::new(false)),
            outbound_sequence: Arc::new(Mutex::new(0)),
        })
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    /// Marks HTTP fallback active (called by the sink selector on disconnect).
    pub fn mark_fallback(&self) {
        self.connected.store(false, Ordering::Relaxed);
        self.state.store(true, Ordering::Relaxed);
    }

    fn next_sequence(&self) -> i64 {
        // Best-effort monotonic per process; the guard cannot be poisoned.
        let mut seq = self.outbound_sequence.try_lock().map(|mut g| {
            *g += 1;
            *g
        });
        while seq.is_err() {
            std::thread::sleep(Duration::from_millis(1));
            seq = self.outbound_sequence.try_lock().map(|mut g| {
                *g += 1;
                *g
            });
        }
        seq.unwrap_or(0)
    }

    /// Blocking task loop: connect → hello → read events; reconnects with
    /// capped exponential backoff. Runs until `cancellation` fires.
    /// Workspace summaries are built from the registry on each connect,
    /// ensuring the hello always carries the current state.
    pub async fn run(
        self: Arc<Self>,
        registry: Arc<WorkspaceRegistry>,
        ct: tokio_util::sync::CancellationToken,
    ) {
        self.state.store(true, Ordering::Relaxed);
        let mut backoff = Duration::from_millis(250);
        loop {
            if ct.is_cancelled() {
                info!("channel loop cancelled");
                return;
            }
            match self.connect_once(&registry, &ct).await {
                Ok(()) => {
                    backoff = Duration::from_millis(250);
                }
                Err(error) => {
                    self.mark_fallback();
                    warn!("channel_fallback reason={} backoffMs={}", error, backoff.as_millis());
                }
            }
            tokio::select! {
                _ = ct.cancelled() => return,
                _ = tokio::time::sleep(backoff) => {}
            }
            backoff = (backoff * 2).min(Duration::from_secs(30));
        }
    }

    async fn connect_once(
        &self,
        registry: &Arc<WorkspaceRegistry>,
        ct: &tokio_util::sync::CancellationToken,
    ) -> Result<(), String> {
        let mut request = self
            .url
            .as_str()
            .into_client_request()
            .map_err(|e| format!("upgrade request build failed: {e}"))?;
        request.headers_mut().insert(
            "Authorization",
            format!("Bearer {}", self.api_token)
                .parse()
                .map_err(|_| "auth header build failed".to_string())?,
        );
        let (mut ws, _response) =
            tokio_tungstenite::connect_async(request)
                .await
                .map_err(|e| format!("connect failed: {e}"))?;
        info!("channel_connected url={}", self.url);

        // hello with the current workspace summary built from registry.
        let instances = registry.all_instances().await;
        let summaries: Vec<WorkspaceSummary> = instances
            .iter()
            .map(|inst| WorkspaceSummary {
                workspace_id: inst.ws_id.clone(),
                generation: inst.generation,
                sandbox_spec_hash: inst.spec_hash.clone(),
                state: format!("{:?}", inst.state),
            })
            .collect();
        let mut hello = Envelope::new(TYPE_HELLO, "runtime", "control-plane", self.next_sequence());
        hello.device_id = Some(self.device_id.clone());
        hello.payload = serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"),
            "workspaces": summaries,
        });
        ws.send(Message::Text(hello.encode()?))
            .await
            .map_err(|e| format!("hello send failed: {e}"))?;

        // Welcome must arrive before the connection is considered usable.
        let welcome = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .map_err(|_| "welcome timeout".to_string())?
            .ok_or_else(|| "channel closed before welcome".to_string())?
            .map_err(|e| format!("welcome read failed: {e}"))?;
        let welcome_env = match welcome {
            Message::Text(text) => Envelope::parse(&text)?,
            other => return Err(format!("unexpected frame before welcome: {other:?}")),
        };
        if welcome_env.kind != TYPE_WELCOME {
            return Err(format!("expected welcome, got {}", welcome_env.kind));
        }
        self.connected.store(true, Ordering::Relaxed);

        // Read loop: handle resync_required / requests; errors bubble to reconnect.
        loop {
            tokio::select! {
                _ = ct.cancelled() => {
                    let _ = ws.close(None).await;
                    return Ok(());
                }
                frame = ws.next() => {
                    let frame = match frame {
                        Some(Ok(frame)) => frame,
                        Some(Err(e)) => return Err(format!("read failed: {e}")),
                        None => return Err("channel closed by peer".into()),
                    };
                    match frame {
                        Message::Text(text) => {
                            let env = Envelope::parse(&text)?;
                            match env.kind.as_str() {
                                TYPE_EVENT => {
                                    let name = env.payload.get("name").and_then(|v| v.as_str()).unwrap_or("");
                                    if name == "heartbeat" {
                                        // CP-initiated heartbeat echo; ack so the server knows the link is alive.
                                        let mut ack = Envelope::new(
                                            TYPE_ACK,
                                            "runtime",
                                            "control-plane",
                                            self.next_sequence(),
                                        );
                                        ack.correlation_id = Some(env.message_id.clone());
                                        ws.send(Message::Text(ack.encode()?))
                                            .await
                                            .map_err(|e| format!("ack send failed: {e}"))?;
                                    }
                                }
                                "resync_required" => {
                                    let ids: Vec<String> = env
                                        .payload
                                        .get("workspaceIds")
                                        .and_then(|v| v.as_array())
                                        .map(|a| {
                                            a.iter()
                                                .filter_map(|x| x.as_str().map(String::from))
                                                .collect()
                                        })
                                        .unwrap_or_default();
                                    info!("channel_resync_required workspaceIds={:?}", ids);
                                    let mut ack = Envelope::new(
                                        TYPE_ACK,
                                        "runtime",
                                        "control-plane",
                                        self.next_sequence(),
                                    );
                                    ack.correlation_id = Some(env.message_id.clone());
                                    ws.send(Message::Text(ack.encode()?))
                                        .await
                                        .map_err(|e| format!("ack send failed: {e}"))?;
                                    // Reconciliation runs through the existing
                                    // ensure path; poll loop picks this up on
                                    // its next cycle via the shared registry.
                                }
                                _ => {}
                            }
                        }
                        Message::Ping(payload) => {
                            ws.send(Message::Pong(payload))
                                .await
                                .map_err(|e| format!("pong failed: {e}"))?;
                        }
                        Message::Close(_) => return Err("close frame".into()),
                        _ => {}
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_url_upgrades_scheme_and_path() {
        assert_eq!(
            channel_url("http://127.0.0.1:12631").unwrap(),
            "ws://127.0.0.1:12631/internal/v1/channel"
        );
        assert_eq!(
            channel_url("https://cp.example.com/").unwrap(),
            "wss://cp.example.com/internal/v1/channel"
        );
    }

    #[test]
    fn channel_url_rejects_bad_input() {
        assert!(channel_url("not-a-url").is_err());
    }
}
