use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use tokio::sync::RwLock;

use crate::mcp_process::BridgeInfo;
use crate::sandbox::SecurityProfile;

/// Lifecycle state of a per-workspace runtime instance.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum InstanceState {
    Active,
    Paused,
    Stopped,
    Suspended,
    Released,
}

impl InstanceState {
    pub fn is_running(&self) -> bool {
        matches!(self, Self::Active)
    }
}

/// Minimal routing and lifecycle handle for a workspace runtime.
///
/// This does NOT duplicate `XiheRuntime` (the MCP tool handler).
/// It holds only the configuration and lifecycle metadata needed
/// by the gateway layer — the actual `XiheRuntime` is constructed
/// on demand from these fields when a request is routed.
#[derive(Debug, Clone)]
pub struct XiheRuntimeInstance {
    pub ws_id: String,
    pub workspace_path: String,
    pub profile: SecurityProfile,
    pub file_service_pid: Option<u32>,
    pub mcp_bridges: HashMap<String, BridgeInfo>,
    pub last_active: SystemTime,
    pub state: InstanceState,
}

impl XiheRuntimeInstance {
    pub fn new(ws_id: &str, workspace_path: &str, profile: SecurityProfile) -> Self {
        Self {
            ws_id: ws_id.to_string(),
            workspace_path: workspace_path.to_string(),
            profile,
            file_service_pid: None,
            mcp_bridges: HashMap::new(),
            last_active: SystemTime::now(),
            state: InstanceState::Active,
        }
    }

    pub fn update_last_active(&mut self) {
        self.last_active = SystemTime::now();
    }

    pub fn is_idle(&self, threshold: Duration) -> bool {
        self.last_active
            .elapsed()
            .map(|elapsed| elapsed >= threshold)
            .unwrap_or(false)
    }
}

/// Concurrent-safe registry of per-workspace runtime instances.
///
/// All access goes through `Arc<RwLock<HashMap>>` so the registry
/// can be shared across tokio tasks (e.g. axum router + idle reaper).
#[derive(Debug, Default)]
pub struct WorkspaceRegistry {
    instances: Arc<RwLock<HashMap<String, XiheRuntimeInstance>>>,
}

impl WorkspaceRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn register(&self, ws_id: &str, workspace_path: &str) {
        let instance = XiheRuntimeInstance::new(ws_id, workspace_path, SecurityProfile::Strict);
        self.instances
            .write()
            .await
            .insert(ws_id.to_string(), instance);
    }

    pub async fn register_with_profile(
        &self,
        ws_id: &str,
        workspace_path: &str,
        profile: SecurityProfile,
    ) {
        let instance = XiheRuntimeInstance::new(ws_id, workspace_path, profile);
        self.instances
            .write()
            .await
            .insert(ws_id.to_string(), instance);
    }

    pub async fn unregister(&self, ws_id: &str) {
        self.instances.write().await.remove(ws_id);
    }

    pub async fn get(&self, ws_id: &str) -> Option<XiheRuntimeInstance> {
        self.instances.read().await.get(ws_id).cloned()
    }

    pub async fn contains(&self, ws_id: &str) -> bool {
        self.instances.read().await.contains_key(ws_id)
    }

    pub async fn update_last_active(&self, ws_id: &str) {
        if let Some(instance) = self.instances.write().await.get_mut(ws_id) {
            instance.last_active = SystemTime::now();
        }
    }

    pub async fn is_idle(&self, ws_id: &str, threshold: Duration) -> bool {
        self.instances
            .read()
            .await
            .get(ws_id)
            .map(|instance| instance.is_idle(threshold))
            .unwrap_or(false)
    }

    pub async fn set_state(&self, ws_id: &str, state: InstanceState) {
        if let Some(instance) = self.instances.write().await.get_mut(ws_id) {
            instance.state = state;
        }
    }

    pub async fn all_instances(&self) -> Vec<XiheRuntimeInstance> {
        self.instances.read().await.values().cloned().collect()
    }
}

/// Route an MCP request to the correct workspace instance.
///
/// Looks up the workspace by the ID extracted from the request
/// header (e.g. `X-Workspace-Id`). Updates the last-active
/// timestamp so idle tracking is accurate.
pub async fn get_instance_for_request(
    registry: &WorkspaceRegistry,
    workspace_id: &str,
) -> Result<XiheRuntimeInstance, String> {
    let instance = registry
        .get(workspace_id)
        .await
        .ok_or_else(|| format!("workspace not registered: {workspace_id}"))?;
    registry.update_last_active(workspace_id).await;
    Ok(instance)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn test_register_and_get() {
        let registry = WorkspaceRegistry::new();
        registry.register("ws-1", "/tmp/ws-1").await;
        let instance = registry.get("ws-1").await.unwrap();
        assert_eq!(instance.ws_id, "ws-1");
        assert_eq!(instance.workspace_path, "/tmp/ws-1");
        assert_eq!(instance.state, InstanceState::Active);
    }

    #[tokio::test]
    async fn test_register_with_profile() {
        let registry = WorkspaceRegistry::new();
        registry
            .register_with_profile("ws-2", "/tmp/ws-2", SecurityProfile::Isolated)
            .await;
        let instance = registry.get("ws-2").await.unwrap();
        assert_eq!(instance.profile, SecurityProfile::Isolated);
    }

    #[tokio::test]
    async fn test_contains() {
        let registry = WorkspaceRegistry::new();
        registry.register("ws-1", "/tmp/ws-1").await;
        assert!(registry.contains("ws-1").await);
        assert!(!registry.contains("ws-nonexistent").await);
    }

    #[tokio::test]
    async fn test_unregister() {
        let registry = WorkspaceRegistry::new();
        registry.register("ws-1", "/tmp/ws-1").await;
        registry.unregister("ws-1").await;
        assert!(!registry.contains("ws-1").await);
    }

    #[tokio::test]
    async fn test_get_returns_none_for_unknown() {
        let registry = WorkspaceRegistry::new();
        assert!(registry.get("ws-unknown").await.is_none());
    }

    #[tokio::test]
    async fn test_update_last_active_refreshes_timestamp() {
        let registry = WorkspaceRegistry::new();
        registry.register("ws-1", "/tmp/ws-1").await;

        let before = registry.get("ws-1").await.unwrap().last_active;

        // Force a small delay so the timestamp differs
        tokio::time::sleep(Duration::from_millis(5)).await;

        registry.update_last_active("ws-1").await;
        let after = registry.get("ws-1").await.unwrap().last_active;
        assert!(after > before);
    }

    #[tokio::test]
    async fn test_is_idle() {
        let registry = WorkspaceRegistry::new();
        registry.register("ws-1", "/tmp/ws-1").await;

        // Immediately after registration, the instance should not be idle
        // for any reasonable threshold since last_active was just set.
        assert!(!registry.is_idle("ws-1", Duration::from_secs(3600)).await);
    }

    #[tokio::test]
    async fn test_is_idle_unknown_ws() {
        let registry = WorkspaceRegistry::new();
        assert!(
            !registry
                .is_idle("ws-nonexistent", Duration::from_secs(10))
                .await
        );
    }

    #[tokio::test]
    async fn test_set_state() {
        let registry = WorkspaceRegistry::new();
        registry.register("ws-1", "/tmp/ws-1").await;
        registry.set_state("ws-1", InstanceState::Paused).await;
        let instance = registry.get("ws-1").await.unwrap();
        assert_eq!(instance.state, InstanceState::Paused);
    }

    #[tokio::test]
    async fn test_get_instance_for_request_ok() {
        let registry = WorkspaceRegistry::new();
        registry.register("ws-1", "/tmp/ws-1").await;

        let instance = get_instance_for_request(&registry, "ws-1").await.unwrap();
        assert_eq!(instance.ws_id, "ws-1");
    }

    #[tokio::test]
    async fn test_get_instance_for_request_not_found() {
        let registry = WorkspaceRegistry::new();
        let err = get_instance_for_request(&registry, "ws-nonexistent")
            .await
            .unwrap_err();
        assert!(err.contains("not registered"));
    }

    #[tokio::test]
    async fn test_get_instance_for_request_updates_last_active() {
        let registry = WorkspaceRegistry::new();
        registry.register("ws-1", "/tmp/ws-1").await;

        let before = registry.get("ws-1").await.unwrap().last_active;
        tokio::time::sleep(Duration::from_millis(5)).await;

        let _ = get_instance_for_request(&registry, "ws-1").await.unwrap();
        let after = registry.get("ws-1").await.unwrap().last_active;
        assert!(after > before);
    }

    #[test]
    fn test_instance_state_is_running() {
        assert!(InstanceState::Active.is_running());
        assert!(!InstanceState::Paused.is_running());
        assert!(!InstanceState::Stopped.is_running());
        assert!(!InstanceState::Suspended.is_running());
        assert!(!InstanceState::Released.is_running());
    }

    #[test]
    fn test_instance_update_last_active() {
        let mut instance = XiheRuntimeInstance::new("ws-1", "/tmp/ws-1", SecurityProfile::Strict);
        let before = instance.last_active;
        instance.update_last_active();
        assert!(instance.last_active >= before);
    }

    #[test]
    fn test_instance_is_idle() {
        let mut instance = XiheRuntimeInstance::new("ws-1", "/tmp/ws-1", SecurityProfile::Strict);
        // Immediately after creation, should not be idle
        assert!(!instance.is_idle(Duration::from_secs(3600)));
        // Fake the last_active to be far in the past
        instance.last_active = SystemTime::now()
            .checked_sub(Duration::from_secs(7200))
            .unwrap();
        assert!(instance.is_idle(Duration::from_secs(3600)));
    }
}
