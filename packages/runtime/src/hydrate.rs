use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use percent_encoding::{AsciiSet, CONTROLS, utf8_percent_encode};
use reqwest::Client;
use serde::Deserialize;
use tokio::sync::Mutex;
use tracing::{error, info};

use crate::error::{Result, RuntimeError};
use crate::gateway::{WorkspaceRegistry, XiheRuntimeInstance};
use crate::sandbox::SecurityProfile;
use crate::storage;
use crate::workspace::{WorkspaceManager, WorkspaceState};

const EXECUTION_SPEC_PATH: &str =
    "/internal/v1/runtime/workspaces/{workspaceId}/execution-spec";
const DEFAULT_IMAGE: &str = "xihe/workspace:latest";

// Encode every byte except the characters accepted by the CP workspace route.
const PATH_SEGMENT_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'/')
    .add(b'?')
    .add(b'\\');

#[derive(Debug, Clone, Deserialize)]
pub struct WorkspaceExecutionSpec {
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    pub generation: u64,
    #[serde(rename = "sandboxSpecHash")]
    pub sandbox_spec_hash: String,
    #[serde(rename = "sandboxSpec")]
    pub sandbox_spec: serde_json::Value,
    #[serde(rename = "storageBackend")]
    pub storage_backend: String,
    #[serde(rename = "storageRef")]
    pub storage_ref: String,
}

impl WorkspaceExecutionSpec {
    pub fn validate_for_workspace(&self, workspace_id: &str) -> Result<()> {
        if self.workspace_id != workspace_id {
            return Err(RuntimeError::InvalidExecutionSpec {
                workspace_id: workspace_id.to_string(),
                detail: format!(
                    "response workspaceId {:?} does not match requested workspaceId {:?}",
                    self.workspace_id, workspace_id
                ),
            });
        }
        if self.generation == 0 {
            return Err(RuntimeError::InvalidExecutionSpec {
                workspace_id: workspace_id.to_string(),
                detail: "generation must be greater than zero".to_string(),
            });
        }
        if !is_sha256_hex(&self.sandbox_spec_hash) {
            return Err(RuntimeError::InvalidExecutionSpec {
                workspace_id: workspace_id.to_string(),
                detail: "sandboxSpecHash must be a 64-character hexadecimal hash".to_string(),
            });
        }
        if self.storage_backend != "host_directory" {
            return Err(RuntimeError::InvalidExecutionSpec {
                workspace_id: workspace_id.to_string(),
                detail: format!(
                    "unsupported storageBackend {:?}; only host_directory is allowed",
                    self.storage_backend
                ),
            });
        }
        if self.storage_ref.is_empty() {
            return Err(RuntimeError::InvalidExecutionSpec {
                workspace_id: workspace_id.to_string(),
                detail: "storageRef must not be empty".to_string(),
            });
        }
        if !self.sandbox_spec.is_object() {
            return Err(RuntimeError::InvalidExecutionSpec {
                workspace_id: workspace_id.to_string(),
                detail: "sandboxSpec must be a JSON object".to_string(),
            });
        }
        self.security_profile(workspace_id)?;
        if let Some(image) = self.sandbox_spec.get("image")
            && (!image.is_string() || image.as_str().is_some_and(str::is_empty))
        {
            return Err(RuntimeError::InvalidExecutionSpec {
                workspace_id: workspace_id.to_string(),
                detail: "sandboxSpec.image must be a non-empty string when present".to_string(),
            });
        }
        Ok(())
    }

    pub fn security_profile(&self, workspace_id: &str) -> Result<SecurityProfile> {
        match self
            .sandbox_spec
            .get("profile")
            .and_then(serde_json::Value::as_str)
        {
            None | Some("strict") => Ok(SecurityProfile::Strict),
            Some("coding") => Ok(SecurityProfile::Coding),
            Some("isolated") => Ok(SecurityProfile::Isolated),
            Some(profile) => Err(RuntimeError::InvalidExecutionSpec {
                workspace_id: workspace_id.to_string(),
                detail: format!("unsupported sandbox profile {profile:?}"),
            }),
        }
    }

    pub fn image<'a>(&'a self, default_image: &'a str) -> &'a str {
        self.sandbox_spec
            .get("image")
            .and_then(serde_json::Value::as_str)
            .filter(|image| !image.is_empty())
            .unwrap_or(default_image)
    }
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_safe_workspace_id(workspace_id: &str) -> bool {
    !workspace_id.is_empty()
        && workspace_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

#[derive(Clone)]
pub struct ExecutionSpecClient {
    client: Client,
    cp_url: String,
    api_token: String,
}

impl ExecutionSpecClient {
    pub fn new(cp_url: &str, api_token: &str) -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(3))
                .build()
                .expect("failed to build execution spec HTTP client"),
            cp_url: cp_url.trim_end_matches('/').to_string(),
            api_token: api_token.to_string(),
        }
    }

    pub fn from_env() -> Self {
        let cp_url = std::env::var("XIHE_CP_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:12631".to_string());
        let api_token = std::env::var("XIHE_CP_API_TOKEN")
            .unwrap_or_else(|_| "dev-token-not-secure".to_string());
        Self::new(&cp_url, &api_token)
    }

    pub async fn fetch_for_workspace(&self, workspace_id: &str) -> Result<WorkspaceExecutionSpec> {
        if !is_safe_workspace_id(workspace_id) {
            return Err(RuntimeError::InvalidExecutionSpec {
                workspace_id: workspace_id.to_string(),
                detail: "workspaceId contains characters not accepted by the runtime route"
                    .to_string(),
            });
        }
        let encoded_workspace_id = utf8_percent_encode(workspace_id, PATH_SEGMENT_ENCODE_SET);
        let url = format!(
            "{}{}",
            self.cp_url,
            EXECUTION_SPEC_PATH.replace("{workspaceId}", &encoded_workspace_id.to_string())
        );
        let response = self
            .client
            .get(&url)
            .bearer_auth(&self.api_token)
            .send()
            .await
            .map_err(|error| RuntimeError::ExecutionSpecUnavailable {
                workspace_id: workspace_id.to_string(),
                detail: format!("request failed: {error}"),
            })?;

        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(RuntimeError::ExecutionSpecNotFound(
                workspace_id.to_string(),
            ));
        }
        if !response.status().is_success() {
            return Err(RuntimeError::ExecutionSpecUnavailable {
                workspace_id: workspace_id.to_string(),
                detail: format!("CP returned {}", response.status()),
            });
        }

        let spec = response
            .json::<WorkspaceExecutionSpec>()
            .await
            .map_err(|error| RuntimeError::InvalidExecutionSpec {
                workspace_id: workspace_id.to_string(),
                detail: format!("response JSON is invalid: {error}"),
            })?;
        spec.validate_for_workspace(workspace_id)?;
        Ok(spec)
    }
}

pub struct WorkspaceEnsurer {
    registry: Arc<WorkspaceRegistry>,
    manager: Arc<Mutex<WorkspaceManager>>,
    client: ExecutionSpecClient,
    host_root: Option<PathBuf>,
    default_image: String,
    locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}

impl WorkspaceEnsurer {
    pub fn new(
        registry: Arc<WorkspaceRegistry>,
        manager: Arc<Mutex<WorkspaceManager>>,
        client: ExecutionSpecClient,
        host_root: Option<PathBuf>,
    ) -> Self {
        Self {
            registry,
            manager,
            client,
            host_root,
            default_image: std::env::var("XIHE_WORKSPACE_IMAGE")
                .unwrap_or_else(|_| DEFAULT_IMAGE.to_string()),
            locks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn from_env(
        registry: Arc<WorkspaceRegistry>,
        manager: Arc<Mutex<WorkspaceManager>>,
    ) -> Self {
        let host_root = std::env::var("XIHE_WORKSPACE_HOST_ROOT")
            .ok()
            .map(PathBuf::from);
        Self::new(registry, manager, ExecutionSpecClient::from_env(), host_root)
    }

    /// Test/embedding entry point: explicit spec client (no env reads).
    pub fn from_env_with_client(
        registry: Arc<WorkspaceRegistry>,
        manager: Arc<Mutex<WorkspaceManager>>,
        client: ExecutionSpecClient,
    ) -> Self {
        let host_root = std::env::var("XIHE_WORKSPACE_HOST_ROOT")
            .ok()
            .map(PathBuf::from);
        Self::new(registry, manager, client, host_root)
    }

    async fn lock_for(&self, workspace_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.locks.lock().await;
        locks
            .entry(workspace_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn failure<T>(&self, workspace_id: &str, error: RuntimeError) -> Result<T> {
        let detail = error.to_string();
        self.registry.mark_failed(workspace_id, &detail).await;
        error!(workspace_id, error = %detail, "workspace materialization failed");
        Err(error)
    }

    /// PLAN-242 M2: identity-only check for remote MCP calls. Fetches the
    /// targeted ExecutionSpec (fail-closed on unknown id) without creating
    /// any container or host directory.
    pub async fn ensure_workspace_identity(&self, workspace_id: &str) -> Result<()> {
        if !is_safe_workspace_id(workspace_id) {
            return self
                .failure(
                    workspace_id,
                    RuntimeError::InvalidExecutionSpec {
                        workspace_id: workspace_id.to_string(),
                        detail: "workspaceId contains invalid route characters".to_string(),
                    },
                )
                .await;
        }
        let workspace_lock = self.lock_for(workspace_id).await;
        let _guard = workspace_lock.lock().await;
        self.client.fetch_for_workspace(workspace_id).await.map(|_| ())
    }

    pub async fn ensure_workspace_materialized(
        &self,
        workspace_id: &str,
    ) -> Result<XiheRuntimeInstance> {
        if !is_safe_workspace_id(workspace_id) {
            return self
                .failure(
                    workspace_id,
                    RuntimeError::InvalidExecutionSpec {
                        workspace_id: workspace_id.to_string(),
                        detail: "workspaceId contains invalid route characters".to_string(),
                    },
                )
                .await;
        }

        let workspace_lock = self.lock_for(workspace_id).await;
        let _guard = workspace_lock.lock().await;

        // A cache hit must still be checked against CP. Comparing the Registry with
        // itself cannot detect a changed ExecutionSpec.
        let cached_instance = self.registry.get(workspace_id).await;
        let spec = match self.client.fetch_for_workspace(workspace_id).await {
            Ok(spec) => spec,
            Err(error) => return self.failure(workspace_id, error).await,
        };
        let profile = match spec.security_profile(workspace_id) {
            Ok(profile) => profile,
            Err(error) => return self.failure(workspace_id, error).await,
        };
        let host_root = match self.host_root.as_deref() {
            Some(host_root) => host_root,
            None => {
                return self
                    .failure(
                        workspace_id,
                        RuntimeError::WorkspaceMaterializationFailed {
                            workspace_id: workspace_id.to_string(),
                            detail: "XIHE_WORKSPACE_HOST_ROOT is not configured".to_string(),
                        },
                    )
                    .await;
            }
        };
        let workspace_path = match storage::resolve_host_path(
            &host_root.to_string_lossy(),
            &spec.storage_ref,
            workspace_id,
        )
        .await
        {
            Ok(path) => path,
            Err(error) => return self.failure(workspace_id, error).await,
        };
        let workspace_path_string = workspace_path.to_string_lossy().to_string();
        let image = spec.image(&self.default_image).to_string();

        if let Some(instance) = cached_instance.as_ref()
            && instance.generation == spec.generation
            && instance.spec_hash == spec.sandbox_spec_hash
            && instance.profile == profile
            && instance.workspace_path == workspace_path_string
        {
            self.registry.update_last_active(workspace_id).await;
            self.registry
                .mark_ready(workspace_id, spec.generation, &spec.sandbox_spec_hash)
                .await;
            info!(
                workspace_id,
                generation = spec.generation,
                spec_hash = %spec.sandbox_spec_hash,
                "workspace materialization cache hit validated against targeted ExecutionSpec"
            );
            return Ok(instance.clone());
        }

        if let Some(instance) = cached_instance.as_ref() {
            info!(
                workspace_id,
                cached_generation = instance.generation,
                live_generation = spec.generation,
                cached_spec_hash = %instance.spec_hash,
                live_spec_hash = %spec.sandbox_spec_hash,
                "workspace ExecutionSpec drift detected; reconciling"
            );
        }

        self.registry.mark_materializing(workspace_id).await;
        let force_recreate = cached_instance.is_some();

        let container_state = match profile {
            SecurityProfile::Strict => {
                if let Err(error) = tokio::fs::create_dir_all(&workspace_path).await {
                    return self.failure(workspace_id, RuntimeError::Io(error)).await;
                }
                let sentinel = workspace_path.join(".xihe-sentinel");
                if let Err(error) = tokio::fs::write(
                    &sentinel,
                    format!("sentinel-{workspace_id}"),
                )
                .await
                {
                    return self.failure(workspace_id, RuntimeError::Io(error)).await;
                }
                None
            }
            SecurityProfile::Coding | SecurityProfile::Isolated => {
                let mut manager = self.manager.lock().await;
                let result = if force_recreate {
                    manager
                        .recreate_workspace(
                            workspace_id,
                            &workspace_path_string,
                            profile,
                            &image,
                        )
                        .await
                } else if let Some(existing) = manager.get_state(workspace_id).cloned() {
                    if existing.workspace_path == workspace_path_string
                        && existing.profile == profile
                    {
                        Ok(existing)
                    } else {
                        manager
                            .recreate_workspace(
                                workspace_id,
                                &workspace_path_string,
                                profile,
                                &image,
                            )
                            .await
                    }
                } else {
                    manager
                        .create_workspace(workspace_id, &workspace_path_string, profile, &image)
                        .await
                };
                match result {
                    Ok(state) => Some(state),
                    Err(error) => return self.failure(workspace_id, error).await,
                }
            }
        };

        self.registry
            .register_with_spec(
                workspace_id,
                &workspace_path_string,
                profile,
                spec.generation,
                &spec.sandbox_spec_hash,
            )
            .await;
        let instance = self
            .registry
            .get(workspace_id)
            .await
            .expect("workspace registry entry must exist after materialization");
        info!(
            workspace_id,
            generation = spec.generation,
            spec_hash = %spec.sandbox_spec_hash,
            container = container_state
                .as_ref()
                .map(|state: &WorkspaceState| state.container_name.as_str())
                .unwrap_or("host-direct"),
            "workspace materialization cache miss completed"
        );
        Ok(instance)
    }
}

#[cfg(test)]
mod tests {
    use mockito::Server;
    use crate::gateway::MaterializationState;

    use super::*;

    fn valid_spec() -> WorkspaceExecutionSpec {
        WorkspaceExecutionSpec {
            workspace_id: "ws-1".to_string(),
            generation: 1,
            sandbox_spec_hash: "a".repeat(64),
            sandbox_spec: serde_json::json!({"profile": "strict"}),
            storage_backend: "host_directory".to_string(),
            storage_ref: "ws-1".to_string(),
        }
    }

    fn spec_body(workspace_id: &str, generation: u64, hash: &str) -> String {
        serde_json::json!({
            "workspaceId": workspace_id,
            "generation": generation,
            "sandboxSpecHash": hash,
            "sandboxSpec": {"profile": "strict"},
            "storageBackend": "host_directory",
            "storageRef": workspace_id,
        })
        .to_string()
    }

    #[test]
    fn execution_spec_validation_accepts_v1_host_directory() {
        let spec = valid_spec();
        assert!(spec.validate_for_workspace("ws-1").is_ok());
        assert_eq!(spec.security_profile("ws-1").unwrap(), SecurityProfile::Strict);
    }

    #[test]
    fn execution_spec_validation_rejects_drift_and_unknown_profile() {
        let mut spec = valid_spec();
        spec.sandbox_spec_hash = "bad".to_string();
        assert!(matches!(
            spec.validate_for_workspace("ws-1"),
            Err(RuntimeError::InvalidExecutionSpec { .. })
        ));

        let mut spec = valid_spec();
        spec.sandbox_spec_hash = "a".repeat(64);
        spec.sandbox_spec = serde_json::json!({"profile": "unknown"});
        assert!(matches!(
            spec.validate_for_workspace("ws-1"),
            Err(RuntimeError::InvalidExecutionSpec { .. })
        ));
    }

    #[tokio::test]
    async fn cache_hit_revalidates_against_targeted_execution_spec() {
        let mut server = Server::new_async().await;
        let hash = "a".repeat(64);
        let mock = server
            .mock(
                "GET",
                "/internal/v1/runtime/workspaces/ws-1/execution-spec",
            )
            .match_header("Authorization", "Bearer test-token")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(spec_body("ws-1", 1, &hash))
            .create_async()
            .await;

        let host_root = tempfile::tempdir().unwrap();
        let workspace_path = storage::resolve_host_path(
            host_root.path().to_str().unwrap(),
            "ws-1",
            "ws-1",
        )
        .await
        .unwrap();
        let registry = Arc::new(WorkspaceRegistry::new());
        registry
            .register_with_spec(
                "ws-1",
                workspace_path.to_str().unwrap(),
                SecurityProfile::Strict,
                1,
                &hash,
            )
            .await;
        let manager = Arc::new(Mutex::new(WorkspaceManager::new()));
        let ensurer = WorkspaceEnsurer::new(
            registry.clone(),
            manager,
            ExecutionSpecClient::new(&server.url(), "test-token"),
            Some(host_root.path().to_path_buf()),
        );

        let instance = ensurer.ensure_workspace_materialized("ws-1").await.unwrap();
        assert_eq!(instance.generation, 1);
        assert_eq!(instance.spec_hash, hash);
        assert_eq!(registry.status("ws-1").await.unwrap().state, MaterializationState::Ready);
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn targeted_execution_spec_drift_reconciles_cached_workspace() {
        let mut server = Server::new_async().await;
        let old_hash = "a".repeat(64);
        let new_hash = "b".repeat(64);
        let mock = server
            .mock(
                "GET",
                "/internal/v1/runtime/workspaces/ws-1/execution-spec",
            )
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(spec_body("ws-1", 2, &new_hash))
            .create_async()
            .await;

        let host_root = tempfile::tempdir().unwrap();
        let workspace_path = storage::resolve_host_path(
            host_root.path().to_str().unwrap(),
            "ws-1",
            "ws-1",
        )
        .await
        .unwrap();
        let registry = Arc::new(WorkspaceRegistry::new());
        registry
            .register_with_spec(
                "ws-1",
                workspace_path.to_str().unwrap(),
                SecurityProfile::Strict,
                1,
                &old_hash,
            )
            .await;
        let ensurer = WorkspaceEnsurer::new(
            registry.clone(),
            Arc::new(Mutex::new(WorkspaceManager::new())),
            ExecutionSpecClient::new(&server.url(), "test-token"),
            Some(host_root.path().to_path_buf()),
        );

        let instance = ensurer.ensure_workspace_materialized("ws-1").await.unwrap();
        assert_eq!(instance.generation, 2);
        assert_eq!(instance.spec_hash, new_hash);
        assert!(workspace_path.join(".xihe-sentinel").is_file());
        assert_eq!(registry.status("ws-1").await.unwrap().state, MaterializationState::Ready);
        mock.assert_async().await;
    }

    /// PLAN-242 M2: identity check passes on a valid spec without creating
    /// any container, registry entry, or sentinel file.
    #[tokio::test]
    async fn identity_check_passes_without_materializing_container() {
        let mut server = Server::new_async().await;
        let hash = "a".repeat(64);
        let mock = server
            .mock(
                "GET",
                "/internal/v1/runtime/workspaces/ws-1/execution-spec",
            )
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(spec_body("ws-1", 1, &hash))
            .create_async()
            .await;

        let host_root = tempfile::tempdir().unwrap();
        let registry = Arc::new(WorkspaceRegistry::new());
        let ensurer = WorkspaceEnsurer::new(
            registry.clone(),
            Arc::new(Mutex::new(WorkspaceManager::new())),
            ExecutionSpecClient::new(&server.url(), "test-token"),
            Some(host_root.path().to_path_buf()),
        );

        ensurer.ensure_workspace_identity("ws-1").await.unwrap();
        assert!(registry.status("ws-1").await.is_none());
        mock.assert_async().await;
    }

    /// PLAN-242 M2: unknown workspace ids fail closed (no silent fallback).
    #[tokio::test]
    async fn identity_check_fails_closed_on_unknown_workspace() {
        let mut server = Server::new_async().await;
        let mock = server
            .mock(
                "GET",
                "/internal/v1/runtime/workspaces/ws-missing/execution-spec",
            )
            .with_status(404)
            .create_async()
            .await;

        let ensurer = WorkspaceEnsurer::new(
            Arc::new(WorkspaceRegistry::new()),
            Arc::new(Mutex::new(WorkspaceManager::new())),
            ExecutionSpecClient::new(&server.url(), "test-token"),
            None,
        );

        let error = ensurer
            .ensure_workspace_identity("ws-missing")
            .await
            .unwrap_err();
        assert!(
            matches!(error, RuntimeError::ExecutionSpecNotFound(_)),
            "unexpected error: {error}"
        );
        mock.assert_async().await;
    }

    /// PLAN-242 M2: unsafe workspace ids are rejected before any CP lookup.
    #[tokio::test]
    async fn identity_check_rejects_unsafe_workspace_id() {
        let ensurer = WorkspaceEnsurer::new(
            Arc::new(WorkspaceRegistry::new()),
            Arc::new(Mutex::new(WorkspaceManager::new())),
            ExecutionSpecClient::new("http://127.0.0.1:9", "test-token"),
            None,
        );

        let error = ensurer
            .ensure_workspace_identity("../evil")
            .await
            .unwrap_err();
        assert!(
            matches!(error, RuntimeError::InvalidExecutionSpec { .. }),
            "unexpected error: {error}"
        );
    }
}
