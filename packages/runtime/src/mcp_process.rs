use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tokio::sync::RwLock;
use tracing::{error, info, warn};

pub const CONFIG_POLL_INTERVAL: Duration = Duration::from_secs(30);
const HEALTH_CHECK_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize)]
pub struct BridgeInfo {
    pub server_id: String,
    pub container_ip: String,
    pub port: u16,
    pub command: String,
    pub args: Vec<String>,
    pub status: BridgeStatus,
    pub spawned_at: SystemTime,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum BridgeStatus {
    Running,
    Restarting(u8),
    Failed(String),
}

pub struct McpProcessManager {
    bridges: Arc<RwLock<HashMap<String, HashMap<String, BridgeInfo>>>>,
}

impl Default for McpProcessManager {
    fn default() -> Self {
        Self::new()
    }
}

impl McpProcessManager {
    pub fn new() -> Self {
        Self {
            bridges: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn spawn(
        &self,
        ws_id: &str,
        server_id: &str,
        command: &str,
        args: &[String],
        container_ip: &str,
        port: u16,
    ) {
        let mut workspaces = self.bridges.write().await;
        let servers = workspaces.entry(ws_id.to_string()).or_default();
        servers.insert(
            server_id.to_string(),
            BridgeInfo {
                server_id: server_id.to_string(),
                container_ip: container_ip.to_string(),
                port,
                command: command.to_string(),
                args: args.to_vec(),
                status: BridgeStatus::Running,
                spawned_at: SystemTime::now(),
            },
        );
        info!("bridge spawned: ws={ws_id} server={server_id} at {container_ip}:{port}");
    }

    pub async fn stop(&self, ws_id: &str, server_id: &str) -> bool {
        let mut workspaces = self.bridges.write().await;
        if let Some(servers) = workspaces.get_mut(ws_id) {
            let removed = servers.remove(server_id).is_some();
            if removed {
                info!("bridge stopped: ws={ws_id} server={server_id}");
            }
            if servers.is_empty() {
                workspaces.remove(ws_id);
            }
            return removed;
        }
        false
    }

    pub async fn list(&self, ws_id: &str) -> Vec<BridgeInfo> {
        let workspaces = self.bridges.read().await;
        workspaces
            .get(ws_id)
            .map(|servers| servers.values().cloned().collect())
            .unwrap_or_default()
    }

    pub async fn get_bridge_url(&self, ws_id: &str, server_id: &str) -> Option<String> {
        let workspaces = self.bridges.read().await;
        workspaces
            .get(ws_id)
            .and_then(|servers| servers.get(server_id))
            .map(|info| format!("http://{}:{}/{}", info.container_ip, info.port, server_id))
    }

    pub async fn cleanup_workspace(&self, ws_id: &str) {
        let mut workspaces = self.bridges.write().await;
        workspaces.remove(ws_id);
        info!("cleaned up all bridges for workspace {ws_id}");
    }

    pub async fn mark_failed(&self, ws_id: &str, server_id: &str, reason: &str) {
        let mut workspaces = self.bridges.write().await;
        if let Some(info) = workspaces
            .get_mut(ws_id)
            .and_then(|s| s.get_mut(server_id))
        {
            info.status = BridgeStatus::Failed(reason.to_string());
            error!("bridge {ws_id}/{server_id} failed: {reason}");
        }
    }

    pub async fn health_check_loop(&self) {
        let mut interval = tokio::time::interval(HEALTH_CHECK_INTERVAL);
        loop {
            interval.tick().await;
            let all: Vec<(String, String)> = {
                let bridges = self.bridges.read().await;
                bridges
                    .iter()
                    .flat_map(|(ws, servers)| {
                        servers.keys().map(move |sid| (ws.clone(), sid.clone()))
                    })
                    .collect()
            };
            for (ws_id, server_id) in &all {
                if let Some(url) = self.get_bridge_url(ws_id, server_id).await {
                    match reqwest::get(&format!("{url}/_health")).await {
                        Ok(resp) if resp.status().is_success() => {}
                        _ => {
                            warn!(
                                "bridge health check failed: ws={ws_id} server={server_id}"
                            );
                        }
                    }
                }
            }
        }
    }

    pub async fn poll_config(
        &self,
        ws_id: &str,
        cp_url: &str,
        api_token: &str,
    ) -> Vec<(String, String, Vec<String>)> {
        let url = format!("{cp_url}/api/v1/workspaces/{ws_id}/mcp-config");
        match reqwest::Client::new()
            .get(&url)
            .bearer_auth(api_token)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<serde_json::Value>().await {
                    Ok(config) => {
                        let mut servers = Vec::new();
                        if let Some(servers_obj) = config.get("mcpServers").and_then(|v| v.as_object()) {
                            for (sid, srv) in servers_obj {
                                let cmd = srv.get("command").and_then(|v| v.as_str()).unwrap_or("");
                                let args: Vec<String> = srv
                                    .get("args")
                                    .and_then(|v| v.as_array())
                                    .map(|a| {
                                        a.iter()
                                            .filter_map(|v| v.as_str().map(String::from))
                                            .collect()
                                    })
                                    .unwrap_or_default();
                                servers.push((sid.clone(), cmd.to_string(), args));
                            }
                        }
                        servers
                    }
                    Err(e) => {
                        error!("failed to parse mcp-config: {e}");
                        Vec::new()
                    }
                }
            }
            Ok(resp) => {
                warn!("mcp-config poll returned {}", resp.status());
                Vec::new()
            }
            Err(e) => {
                error!("mcp-config poll request failed: {e}");
                Vec::new()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_spawn_and_list() {
        let mgr = McpProcessManager::new();
        mgr.spawn("ws-1", "github", "npx", &[], "172.17.0.2", 39001).await;
        let bridges = mgr.list("ws-1").await;
        assert_eq!(bridges.len(), 1);
        assert_eq!(bridges[0].server_id, "github");
        assert_eq!(bridges[0].container_ip, "172.17.0.2");
        assert_eq!(bridges[0].port, 39001);
    }

    #[tokio::test]
    async fn test_stop_removes_bridge() {
        let mgr = McpProcessManager::new();
        mgr.spawn("ws-1", "filesystem", "npx", &[], "172.17.0.2", 39002).await;
        assert_eq!(mgr.list("ws-1").await.len(), 1);
        let removed = mgr.stop("ws-1", "filesystem").await;
        assert!(removed);
        assert!(mgr.list("ws-1").await.is_empty());
    }

    #[tokio::test]
    async fn test_stop_nonexistent_returns_false() {
        let mgr = McpProcessManager::new();
        assert!(!mgr.stop("ws-1", "nope").await);
    }

    #[tokio::test]
    async fn test_get_bridge_url() {
        let mgr = McpProcessManager::new();
        mgr.spawn("ws-1", "github", "npx", &[], "10.0.0.1", 39000).await;
        let url = mgr.get_bridge_url("ws-1", "github").await;
        assert_eq!(url, Some("http://10.0.0.1:39000/github".to_string()));
    }

    #[tokio::test]
    async fn test_get_bridge_url_nonexistent() {
        let mgr = McpProcessManager::new();
        assert!(mgr.get_bridge_url("ws-1", "nonexistent").await.is_none());
    }

    #[tokio::test]
    async fn test_cleanup_workspace() {
        let mgr = McpProcessManager::new();
        mgr.spawn("ws-1", "a", "cmd", &[], "ip", 1).await;
        mgr.spawn("ws-1", "b", "cmd", &[], "ip", 2).await;
        mgr.spawn("ws-2", "c", "cmd", &[], "ip", 3).await;
        mgr.cleanup_workspace("ws-1").await;
        assert!(mgr.list("ws-1").await.is_empty());
        assert_eq!(mgr.list("ws-2").await.len(), 1);
    }

    #[tokio::test]
    async fn test_mark_failed() {
        let mgr = McpProcessManager::new();
        mgr.spawn("ws-1", "fail-server", "cmd", &[], "ip", 1).await;
        mgr.mark_failed("ws-1", "fail-server", "OOM").await;
        let bridges = mgr.list("ws-1").await;
        assert_eq!(bridges[0].status, BridgeStatus::Failed("OOM".to_string()));
    }
}
