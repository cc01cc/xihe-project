use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tokio::sync::RwLock;

use crate::mcp_process::BridgeInfo;
use crate::sandbox::SecurityProfile;

/// Lifecycle state of a per-workspace runtime instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstanceState {
    Active,
    Paused,
    Stopped,
    Suspended,
    Released,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MaterializationState {
    Materializing,
    Ready,
    Failed,
    Released,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkspaceStatus {
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    pub state: MaterializationState,
    pub generation: Option<u64>,
    #[serde(rename = "specHash")]
    pub spec_hash: Option<String>,
    #[serde(rename = "lastError")]
    pub last_error: Option<String>,
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
    pub generation: u64,
    pub spec_hash: String,
    pub file_service_pid: Option<u32>,
    pub mcp_bridges: HashMap<String, BridgeInfo>,
    pub last_active: SystemTime,
    pub state: InstanceState,
}

impl XiheRuntimeInstance {
    pub fn new(ws_id: &str, workspace_path: &str, profile: SecurityProfile) -> Self {
        Self::new_with_spec(ws_id, workspace_path, profile, 0, "")
    }

    pub fn new_with_spec(
        ws_id: &str,
        workspace_path: &str,
        profile: SecurityProfile,
        generation: u64,
        spec_hash: &str,
    ) -> Self {
        Self {
            ws_id: ws_id.to_string(),
            workspace_path: workspace_path.to_string(),
            profile,
            generation,
            spec_hash: spec_hash.to_string(),
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
    statuses: Arc<RwLock<HashMap<String, WorkspaceStatus>>>,
}

impl WorkspaceRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn register(&self, ws_id: &str, workspace_path: &str) {
        self.register_with_spec(ws_id, workspace_path, SecurityProfile::Strict, 0, "")
            .await;
    }

    pub async fn register_with_profile(
        &self,
        ws_id: &str,
        workspace_path: &str,
        profile: SecurityProfile,
    ) {
        self.register_with_spec(ws_id, workspace_path, profile, 0, "")
            .await;
    }

    pub async fn register_with_spec(
        &self,
        ws_id: &str,
        workspace_path: &str,
        profile: SecurityProfile,
        generation: u64,
        spec_hash: &str,
    ) {
        let instance = XiheRuntimeInstance::new_with_spec(
            ws_id,
            workspace_path,
            profile,
            generation,
            spec_hash,
        );
        self.instances
            .write()
            .await
            .insert(ws_id.to_string(), instance);
        self.mark_ready(ws_id, generation, spec_hash).await;
    }

    pub async fn mark_materializing(&self, ws_id: &str) {
        let mut statuses = self.statuses.write().await;
        let previous_generation = statuses.get(ws_id).and_then(|status| status.generation);
        let previous_hash = statuses
            .get(ws_id)
            .and_then(|status| status.spec_hash.clone());
        statuses.insert(
            ws_id.to_string(),
            WorkspaceStatus {
                workspace_id: ws_id.to_string(),
                state: MaterializationState::Materializing,
                generation: previous_generation,
                spec_hash: previous_hash,
                last_error: None,
            },
        );
    }

    pub async fn mark_ready(&self, ws_id: &str, generation: u64, spec_hash: &str) {
        self.statuses.write().await.insert(
            ws_id.to_string(),
            WorkspaceStatus {
                workspace_id: ws_id.to_string(),
                state: MaterializationState::Ready,
                generation: (generation != 0).then_some(generation),
                spec_hash: (!spec_hash.is_empty()).then_some(spec_hash.to_string()),
                last_error: None,
            },
        );
    }

    pub async fn mark_failed(&self, ws_id: &str, error: &str) {
        let mut statuses = self.statuses.write().await;
        let previous_generation = statuses.get(ws_id).and_then(|status| status.generation);
        let previous_hash = statuses
            .get(ws_id)
            .and_then(|status| status.spec_hash.clone());
        statuses.insert(
            ws_id.to_string(),
            WorkspaceStatus {
                workspace_id: ws_id.to_string(),
                state: MaterializationState::Failed,
                generation: previous_generation,
                spec_hash: previous_hash,
                last_error: Some(error.to_string()),
            },
        );
    }

    pub async fn mark_released(&self, ws_id: &str) {
        let mut statuses = self.statuses.write().await;
        let previous_generation = statuses.get(ws_id).and_then(|status| status.generation);
        let previous_hash = statuses
            .get(ws_id)
            .and_then(|status| status.spec_hash.clone());
        statuses.insert(
            ws_id.to_string(),
            WorkspaceStatus {
                workspace_id: ws_id.to_string(),
                state: MaterializationState::Released,
                generation: previous_generation,
                spec_hash: previous_hash,
                last_error: None,
            },
        );
    }

    pub async fn status(&self, ws_id: &str) -> Option<WorkspaceStatus> {
        self.statuses.read().await.get(ws_id).cloned()
    }

    pub async fn unregister(&self, ws_id: &str) {
        self.instances.write().await.remove(ws_id);
    }

    pub async fn get(&self, ws_id: &str) -> Option<XiheRuntimeInstance> {
        self.instances.read().await.get(ws_id).cloned()
    }

    pub fn try_get(&self, ws_id: &str) -> Option<XiheRuntimeInstance> {
        self.instances.try_read().ok()?.get(ws_id).cloned()
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

    /// Cross-map consistency check: detect and log cases where InstanceState
    /// and MaterializationState are contradictory. Called at key transition
    /// points to catch dual-map divergence early.
    pub async fn check_consistency(&self) -> Vec<String> {
        let instances = self.instances.read().await;
        let statuses = self.statuses.read().await;
        let mut issues = Vec::new();

        for (ws_id, instance) in instances.iter() {
            if let Some(status) = statuses.get(ws_id) {
                // Active instance with Failed status is contradictory
                if instance.state == InstanceState::Active
                    && status.state == MaterializationState::Failed
                {
                    issues.push(format!(
                        "{}: InstanceState::Active but MaterializationState::Failed",
                        ws_id
                    ));
                }
                // Suspended/Released instance with Ready status is contradictory
                if matches!(
                    instance.state,
                    InstanceState::Suspended | InstanceState::Released
                ) && status.state == MaterializationState::Ready
                {
                    issues.push(format!(
                        "{}: InstanceState::{:?} but MaterializationState::Ready",
                        ws_id, instance.state
                    ));
                }
            }
        }

        // Check for statuses without corresponding instances (orphaned status entries)
        for ws_id in statuses.keys() {
            if !instances.contains_key(ws_id)
                && statuses.get(ws_id).is_some_and(|s| {
                    !matches!(s.state, MaterializationState::Released)
                })
            {
                issues.push(format!(
                    "{}: MaterializationState::{:?} but no instance entry",
                    ws_id,
                    statuses.get(ws_id).map(|s| s.state)
                ));
            }
        }

        if !issues.is_empty() {
            tracing::warn!(
                "cross-map consistency issues detected: {}",
                issues.join("; ")
            );
        }
        issues
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
    let instance = registry.get(workspace_id).await.ok_or_else(|| {
        format!("workspace not registered: {workspace_id} (WORKSPACE_NOT_REGISTERED)")
    })?;
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
        assert!(err.contains("WORKSPACE_NOT_REGISTERED"));
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

    #[tokio::test]
    async fn test_status_tracks_failure_without_global_hydration_flag() {
        let registry = WorkspaceRegistry::new();
        registry.mark_materializing("ws-1").await;
        assert_eq!(
            registry.status("ws-1").await.unwrap().state,
            MaterializationState::Materializing
        );

        registry.mark_failed("ws-1", "execution spec not found").await;
        let status = registry.status("ws-1").await.unwrap();
        assert_eq!(status.state, MaterializationState::Failed);
        assert_eq!(status.last_error.as_deref(), Some("execution spec not found"));
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
