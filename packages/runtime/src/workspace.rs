use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use bollard::Docker;
use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
use bollard::models::{ContainerCreateBody, HostConfig};
use bollard::query_parameters::{
    CreateContainerOptions, ListContainersOptions, RemoveContainerOptions, StartContainerOptions,
    StopContainerOptions,
};
use tokio::fs;
use tokio_stream::StreamExt;
use tracing::{info, warn};

use crate::error::{Result, RuntimeError};
use crate::sandbox::SecurityProfile;

/// Legacy (stack-1) sandbox container prefix; unchanged by PLAN-0533.
pub(crate) const CONTAINER_PREFIX_DEFAULT: &str = "xihe-workspace-ws_";
/// Label carrying the owning stack. Missing label = stack-1 (legacy containers).
pub(crate) const STACK_LABEL: &str = "xihe.stack-id";

/// Sandbox container prefix for the current stack.
///
/// Deployment authority is `XIHE_SANDBOX_CONTAINER_PREFIX`, a derived env the
/// launcher computes from `XIHE_STACK_ID`. The runtime intentionally does not
/// read `XIHE_STACK_ID` itself (invariant I6: only `/version` may).
pub(crate) fn container_prefix_from(lookup: impl Fn(&str) -> Option<String>) -> String {
    lookup("XIHE_SANDBOX_CONTAINER_PREFIX")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| CONTAINER_PREFIX_DEFAULT.to_string())
}

/// Stack id used for the container label; defaults to stack-1 for legacy setups.
pub(crate) fn sandbox_stack_id_from(lookup: impl Fn(&str) -> Option<String>) -> String {
    lookup("XIHE_SANDBOX_STACK_ID")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "stack-1".to_string())
}

fn env_lookup(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

pub(crate) fn container_name(ws_id: &str) -> String {
    format!("{}{ws_id}", container_prefix_from(env_lookup))
}

/// Ownership predicate shared by orphan cleanup: name prefix AND stack label.
/// A container without the label is legacy stack-1 (B3).
pub(crate) fn is_stack_container(
    name: &str,
    labels: Option<&HashMap<String, String>>,
    prefix: &str,
    stack_id: &str,
) -> bool {
    if !name.starts_with(&format!("/{prefix}")) {
        return false;
    }
    let labelled = labels
        .and_then(|map| map.get(STACK_LABEL))
        .map(String::as_str)
        .unwrap_or("stack-1");
    labelled == stack_id
}

/// Sandbox container resource defaults (legacy profile; env-overridable).
pub const DEFAULT_SANDBOX_MEMORY_MB: u64 = 512;
pub const DEFAULT_SANDBOX_CPUS: u64 = 2;
pub const DEFAULT_SANDBOX_PIDS_LIMIT: u64 = 100;

/// Sanity bounds for env overrides: reject implausible values instead of
/// handing them to Docker (1 TiB / 256 CPUs / 1M pids).
const MAX_SANDBOX_MEMORY_MB: u64 = 1024 * 1024;
const MAX_SANDBOX_CPUS: u64 = 256;
const MAX_SANDBOX_PIDS_LIMIT: u64 = 1_000_000;

/// Sandbox container resource limits.
///
/// Deployment authority is the environment (`XIHE_SANDBOX_MEMORY_MB`,
/// `XIHE_SANDBOX_CPUS`, `XIHE_SANDBOX_PIDS_LIMIT`), resolved when a sandbox
/// container is created. Malformed or out-of-range values fall back to the
/// default for that field and log a warning; the effective values are logged
/// on every container create.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SandboxResourceLimits {
    pub memory_bytes: i64,
    pub memory_swap_bytes: i64,
    pub nano_cpus: i64,
    pub pids_limit: i64,
}

impl Default for SandboxResourceLimits {
    fn default() -> Self {
        let memory_bytes = (DEFAULT_SANDBOX_MEMORY_MB * 1024 * 1024) as i64;
        Self {
            memory_bytes,
            // Keep swap == memory: no extra swap beyond the memory limit.
            memory_swap_bytes: memory_bytes,
            nano_cpus: (DEFAULT_SANDBOX_CPUS * 1_000_000_000) as i64,
            pids_limit: DEFAULT_SANDBOX_PIDS_LIMIT as i64,
        }
    }
}

impl SandboxResourceLimits {
    /// Resolve limits from the process environment.
    pub fn from_env() -> Self {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let mut limits = Self::default();

        if let Some(raw) = lookup("XIHE_SANDBOX_MEMORY_MB") {
            match parse_sandbox_env_u64(&raw, 1, MAX_SANDBOX_MEMORY_MB) {
                Some(mb) => {
                    limits.memory_bytes = (mb * 1024 * 1024) as i64;
                    limits.memory_swap_bytes = limits.memory_bytes;
                }
                None => warn!(
                    "invalid XIHE_SANDBOX_MEMORY_MB={raw:?}; using default {} MB",
                    DEFAULT_SANDBOX_MEMORY_MB
                ),
            }
        }
        if let Some(raw) = lookup("XIHE_SANDBOX_CPUS") {
            match parse_sandbox_env_u64(&raw, 1, MAX_SANDBOX_CPUS) {
                Some(cpus) => limits.nano_cpus = (cpus * 1_000_000_000) as i64,
                None => warn!(
                    "invalid XIHE_SANDBOX_CPUS={raw:?}; using default {}",
                    DEFAULT_SANDBOX_CPUS
                ),
            }
        }
        if let Some(raw) = lookup("XIHE_SANDBOX_PIDS_LIMIT") {
            match parse_sandbox_env_u64(&raw, 1, MAX_SANDBOX_PIDS_LIMIT) {
                Some(pids) => limits.pids_limit = pids as i64,
                None => warn!(
                    "invalid XIHE_SANDBOX_PIDS_LIMIT={raw:?}; using default {}",
                    DEFAULT_SANDBOX_PIDS_LIMIT
                ),
            }
        }
        limits
    }
}

fn parse_sandbox_env_u64(raw: &str, min: u64, max: u64) -> Option<u64> {
    raw.trim()
        .parse::<u64>()
        .ok()
        .filter(|value| (min..=max).contains(value))
}

#[derive(Debug, Clone)]
pub struct WorkspaceState {
    pub ws_id: String,
    pub workspace_path: String,
    pub container_name: String,
    pub container_id: String,
    pub profile: SecurityProfile,
}

#[derive(Debug, Default)]
pub struct WorkspaceManager {
    workspaces: HashMap<String, WorkspaceState>,
    docker: Option<Docker>,
}

impl WorkspaceManager {
    pub fn new() -> Self {
        Self {
            workspaces: HashMap::new(),
            docker: None,
        }
    }

    async fn get_docker(&mut self) -> Result<&Docker> {
        if self.docker.is_none() {
            let docker = Docker::connect_with_local_defaults()
                .map_err(|e| RuntimeError::Docker(e.to_string()))?;
            self.docker = Some(docker);
        }
        Ok(self.docker.as_ref().unwrap())
    }

    pub async fn create_workspace(
        &mut self,
        ws_id: &str,
        workspace_path: &str,
        profile: SecurityProfile,
        image: &str,
    ) -> Result<WorkspaceState> {
        let name = container_name(ws_id);

        // Establish the Docker connection first: remove_container_best_effort is a
        // no-op when self.docker is not yet connected.
        self.get_docker().await?;
        // Sandbox containers are ephemeral; WorkspaceStorage persists. A leftover
        // container from a previous Runtime generation (unclean shutdown) must be
        // removed before creating a fresh one — never touch host storage here.
        self.remove_container_best_effort(&name).await;

        let docker = self.get_docker().await?;

        fs::create_dir_all(workspace_path)
            .await
            .map_err(RuntimeError::Io)?;

        // M1b: host writability probe — fail with STORAGE_UNAVAILABLE if not writable
        {
            let probe_file = PathBuf::from(workspace_path).join(".xihe-probe-writable");
            let content = format!("probe-{ws_id}");
            if let Err(e) = fs::write(&probe_file, content.as_bytes()).await {
                return Err(RuntimeError::Io(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    format!(
                        "STORAGE_UNAVAILABLE: host writability probe failed for {workspace_path}: {e}"
                    ),
                )));
            }
            let _ = fs::remove_file(&probe_file).await;
        }
        // M1b: available space check (>64MB) — fs2
        {
            let available = fs2::available_space(workspace_path).map_err(|e| {
                RuntimeError::Io(std::io::Error::other(format!(
                    "STORAGE_UNAVAILABLE: available_space check failed for {workspace_path}: {e}"
                )))
            })?;
            if available < 64 * 1024 * 1024 {
                return Err(RuntimeError::Io(std::io::Error::new(
                    std::io::ErrorKind::StorageFull,
                    format!(
                        "STORAGE_UNAVAILABLE: insufficient space for {workspace_path}: {available} bytes available"
                    ),
                )));
            }
        }

        // PLAN-0347 T1.5: no published container-runtime port any more; workspace
        // operations and MCP sessions flow through Docker exec, so Docker network
        // reachability is not required (and never worked on native Windows hosts).
        let mut labels = HashMap::new();
        if let Ok(run_id) = std::env::var("XIHE_E2E_RUN_ID") {
            labels.insert(String::from("xihe.e2e.run-id"), run_id);
        }
        // PLAN-0533: every container carries its owning stack; legacy containers
        // without the label are treated as stack-1 on cleanup.
        labels.insert(STACK_LABEL.to_string(), sandbox_stack_id_from(env_lookup));
        let labels = Some(labels);

        // Sandbox resource limits are deployment-authority env knobs
        // (XIHE_SANDBOX_MEMORY_MB / XIHE_SANDBOX_CPUS / XIHE_SANDBOX_PIDS_LIMIT);
        // defaults preserve the legacy 512 MB / 2 CPU / 100 pids profile.
        let limits = SandboxResourceLimits::from_env();
        info!(
            "sandbox resource limits: ws_id={} memory={}MB cpus={} pids={}",
            ws_id,
            limits.memory_bytes / (1024 * 1024),
            limits.nano_cpus / 1_000_000_000,
            limits.pids_limit
        );

        let host_config = HostConfig {
            memory: Some(limits.memory_bytes),
            memory_swap: Some(limits.memory_swap_bytes),
            nano_cpus: Some(limits.nano_cpus),
            pids_limit: Some(limits.pids_limit),
            cap_drop: Some(vec!["ALL".to_string()]),
            security_opt: Some(vec!["no-new-privileges:true".to_string()]),
            binds: Some(vec![format!("{}:/workspace:rw", workspace_path)]),
            network_mode: match profile {
                SecurityProfile::Strict => Some("none".to_string()),
                SecurityProfile::Coding => Some("bridge".to_string()),
                SecurityProfile::Isolated => Some("bridge".to_string()),
            },
            readonly_rootfs: Some(matches!(
                profile,
                SecurityProfile::Strict | SecurityProfile::Isolated
            )),
            ..Default::default()
        };

        let config = ContainerCreateBody {
            image: Some(image.to_string()),
            cmd: Some(vec!["sleep".into(), "infinity".into()]),
            labels,
            host_config: Some(host_config),
            env: match profile {
                SecurityProfile::Coding => Some(vec![
                    "HTTP_PROXY=http://audit-proxy:8080".to_string(),
                    "HTTPS_PROXY=http://audit-proxy:8080".to_string(),
                ]),
                _ => None,
            },
            working_dir: Some("/workspace".to_string()),
            ..Default::default()
        };

        let opts = CreateContainerOptions {
            name: Some(name.clone()),
            ..Default::default()
        };

        let container = docker
            .create_container(Some(opts), config)
            .await
            .map_err(|e| RuntimeError::Docker(format!("create container: {e}")))?;

        docker
            .start_container(&name, None::<StartContainerOptions>)
            .await
            .map_err(|e| RuntimeError::Docker(format!("start container: {e}")))?;

        let state = WorkspaceState {
            ws_id: ws_id.to_string(),
            workspace_path: workspace_path.to_string(),
            container_name: name,
            container_id: container.id,
            profile,
        };

        // Start xihe-container-runtime inside the container.
        if let Err(error) = self.probe_container_ready(&state).await {
            self.remove_container_best_effort(&state.container_name)
                .await;
            return Err(error);
        }

        // M1b: verify mount via sentinel (host -> container) — grill B3/B4
        if let Err(e) = self.verify_mount(&state).await {
            // Clean up container on mount verification failure to avoid orphan
            self.remove_container_best_effort(&state.container_name)
                .await;
            return Err(e);
        }

        // M1c: Strict isolation probes — grill B5 direct Engine exec, B6 STRICT_PROBE_FAILED
        if profile == SecurityProfile::Strict
            && let Err(e) = self.verify_strict_isolation(&state).await
        {
            self.remove_container_best_effort(&state.container_name)
                .await;
            return Err(e);
        }

        self.workspaces.insert(ws_id.to_string(), state.clone());
        info!(
            "Workspace created: ws_id={}, path={}",
            ws_id, workspace_path
        );
        Ok(state)
    }

    pub async fn delete_workspace(&mut self, ws_id: &str) -> Result<()> {
        let state = self
            .workspaces
            .get(ws_id)
            .cloned()
            .ok_or_else(|| RuntimeError::SandboxNotFound(ws_id.to_string()))?;

        self.remove_ephemeral_container(&state).await?;
        self.workspaces.remove(ws_id);

        info!(
            "Sandbox deleted: ws_id={} container={} WorkspaceStorage preserved at {}",
            ws_id, state.container_name, state.workspace_path
        );
        Ok(())
    }

    /// Recreate only the ephemeral Sandbox Container while preserving WorkspaceStorage.
    pub async fn recreate_workspace(
        &mut self,
        ws_id: &str,
        workspace_path: &str,
        profile: SecurityProfile,
        image: &str,
    ) -> Result<WorkspaceState> {
        if let Some(previous) = self.workspaces.get(ws_id).cloned() {
            self.remove_ephemeral_container(&previous).await?;
            self.workspaces.remove(ws_id);
            info!(
                "Sandbox container removed for reconcile: ws_id={} storage_preserved={}",
                ws_id, previous.workspace_path
            );
        }

        self.create_workspace(ws_id, workspace_path, profile, image)
            .await
    }

    pub async fn pause_container(&self, ws_id: &str) -> Result<()> {
        let state = self
            .workspaces
            .get(ws_id)
            .ok_or_else(|| RuntimeError::SandboxNotFound(ws_id.to_string()))?;
        let docker = self
            .docker
            .as_ref()
            .ok_or_else(|| RuntimeError::Docker("Docker not connected".to_string()))?;
        docker
            .pause_container(&state.container_name)
            .await
            .map_err(|e| RuntimeError::Docker(format!("pause container: {e}")))?;
        info!("Container paused: ws_id={}", ws_id);
        Ok(())
    }

    pub async fn unpause_container(&self, ws_id: &str) -> Result<()> {
        let state = self
            .workspaces
            .get(ws_id)
            .ok_or_else(|| RuntimeError::SandboxNotFound(ws_id.to_string()))?;
        let docker = self
            .docker
            .as_ref()
            .ok_or_else(|| RuntimeError::Docker("Docker not connected".to_string()))?;
        docker
            .unpause_container(&state.container_name)
            .await
            .map_err(|e| RuntimeError::Docker(format!("unpause container: {e}")))?;
        info!("Container unpaused: ws_id={}", ws_id);
        Ok(())
    }

    pub async fn stop_container(&self, ws_id: &str) -> Result<()> {
        let state = self
            .workspaces
            .get(ws_id)
            .ok_or_else(|| RuntimeError::SandboxNotFound(ws_id.to_string()))?;
        let docker = self
            .docker
            .as_ref()
            .ok_or_else(|| RuntimeError::Docker("Docker not connected".to_string()))?;
        docker
            .stop_container(
                &state.container_name,
                Some(StopContainerOptions {
                    t: Some(10),
                    ..Default::default()
                }),
            )
            .await
            .map_err(|e| RuntimeError::Docker(format!("stop container: {e}")))?;
        info!("Container stopped: ws_id={}", ws_id);
        Ok(())
    }

    /// PLAN-0347 T1.5：容器就绪探针（替代 `xihe-container-runtime` HTTP daemon
    /// 的 `/health` 创建门）。oneshot exec `true`：退出码 0 即就绪；失败 fail-closed。
    async fn probe_container_ready(&self, state: &WorkspaceState) -> Result<()> {
        let docker = self
            .docker
            .as_ref()
            .ok_or_else(|| RuntimeError::Docker("Docker not connected".to_string()))?;
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut last_error = String::from("probe exec never ran");
        while Instant::now() < deadline {
            let exec = match docker
                .create_exec(
                    &state.container_name,
                    CreateExecOptions {
                        cmd: Some(vec!["sh".to_string(), "-c".to_string(), "true".to_string()]),
                        attach_stdout: Some(true),
                        attach_stderr: Some(true),
                        ..Default::default()
                    },
                )
                .await
            {
                Ok(exec) => exec,
                Err(error) => {
                    last_error = format!("create_exec: {error}");
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    continue;
                }
            };
            match docker
                .start_exec(
                    &exec.id,
                    Some(StartExecOptions {
                        detach: false,
                        tty: false,
                        output_capacity: Some(64),
                    }),
                )
                .await
            {
                Ok(StartExecResults::Attached { mut output, .. }) => {
                    while output.next().await.is_some() {}
                }
                Ok(StartExecResults::Detached) => {
                    warn!(
                        workspace_id = %state.ws_id,
                        "probe exec unexpectedly detached"
                    );
                }
                Err(error) => {
                    warn!(
                        workspace_id = %state.ws_id,
                        error = %error,
                        "probe start_exec failed"
                    );
                }
            }
            match docker.inspect_exec(&exec.id).await {
                Ok(info) if info.exit_code == Some(0) => {
                    info!(
                        workspace_id = %state.ws_id,
                        "workspace container ready (exec probe)"
                    );
                    return Ok(());
                }
                Ok(info) => {
                    last_error = format!(
                        "probe exit_code={:?} running={:?}",
                        info.exit_code, info.running
                    );
                }
                Err(error) => {
                    last_error = format!("inspect_exec: {error}");
                }
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        Err(RuntimeError::Docker(format!(
            "workspace container not ready for {}: {last_error}",
            state.ws_id
        )))
    }

    /// M1b: verify host -> container mount via fixed sentinel (grill B3/B4).
    /// Writes `.xihe-sentinel` on host, then `cat | grep -q` inside container.
    async fn verify_mount(&self, state: &WorkspaceState) -> Result<()> {
        let docker = self
            .docker
            .as_ref()
            .ok_or_else(|| RuntimeError::Docker("Docker not connected".to_string()))?;
        let sentinel_path = PathBuf::from(&state.workspace_path).join(".xihe-sentinel");
        let expected = format!("sentinel-{}", state.ws_id);
        // Write sentinel on host (fixed single file per workspace)
        fs::write(&sentinel_path, expected.as_bytes())
            .await
            .map_err(|e| {
                RuntimeError::Io(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    format!(
                        "STORAGE_UNAVAILABLE: sentinel write failed for {}: {}",
                        state.workspace_path, e
                    ),
                ))
            })?;
        // Verify inside container: cat + grep
        let check_cmd = format!("cat /workspace/.xihe-sentinel | grep -q \"{expected}\"");
        let exec = docker
            .create_exec(
                &state.container_name,
                CreateExecOptions {
                    cmd: Some(vec!["sh".to_string(), "-c".to_string(), check_cmd]),
                    attach_stdout: Some(false),
                    attach_stderr: Some(false),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| RuntimeError::Docker(format!("verify mount create exec: {e}")))?;
        docker
            .start_exec(
                &exec.id,
                Some(bollard::exec::StartExecOptions {
                    detach: false,
                    tty: false,
                    output_capacity: Some(128),
                }),
            )
            .await
            .map_err(|e| RuntimeError::Docker(format!("verify mount start exec: {e}")))?;
        // Small delay to let inspect populate exit_code (bollard quirk on Windows)
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        // Check exit code via inspect
        let info = docker
            .inspect_exec(&exec.id)
            .await
            .map_err(|e| RuntimeError::Docker(format!("verify mount inspect: {e}")))?;
        match info.exit_code {
            Some(0) => {
                info!("mount verified via sentinel for workspace {}", state.ws_id);
                Ok(())
            }
            Some(code) => Err(RuntimeError::Io(std::io::Error::other(format!(
                "STORAGE_UNAVAILABLE: sentinel mismatch for {}: expected {:?}, exit code {}",
                state.ws_id, expected, code
            )))),
            None => Err(RuntimeError::Docker(format!(
                "verify mount: no exit code for {}",
                state.ws_id
            ))),
        }
    }

    /// M1c: Strict isolation probes — grill B5 direct Engine exec, B6 STRICT_PROBE_FAILED.
    /// Verifies external egress and lateral access are blocked via `curl`/`wget`.
    async fn verify_strict_isolation(&self, state: &WorkspaceState) -> Result<()> {
        let docker = self
            .docker
            .as_ref()
            .ok_or_else(|| RuntimeError::Docker("Docker not connected".to_string()))?;
        // Probes: (label, shell command that exits 0 when isolated (blocked), 1 when not isolated)
        let probes = [
            (
                "external_egress",
                "curl --connect-timeout 2 -s http://1.1.1.1:80 > /dev/null 2>&1 && exit 1; wget -qO- --timeout=2 http://1.1.1.1:80 > /dev/null 2>&1 && exit 1; exit 0",
            ),
            (
                "lateral_postgres",
                "curl --connect-timeout 2 -s http://postgres:5432 > /dev/null 2>&1 && exit 1; wget -qO- --timeout=2 http://postgres:5432 > /dev/null 2>&1 && exit 1; exit 0",
            ),
        ];
        for (label, cmd) in probes {
            let exec = docker
                .create_exec(
                    &state.container_name,
                    CreateExecOptions {
                        cmd: Some(vec!["sh".to_string(), "-c".to_string(), cmd.to_string()]),
                        attach_stdout: Some(false),
                        attach_stderr: Some(false),
                        ..Default::default()
                    },
                )
                .await
                .map_err(|e| {
                    RuntimeError::Docker(format!("strict probe {label} create exec: {e}"))
                })?;
            docker
                .start_exec(
                    &exec.id,
                    Some(bollard::exec::StartExecOptions {
                        detach: false,
                        tty: false,
                        output_capacity: Some(64),
                    }),
                )
                .await
                .map_err(|e| {
                    RuntimeError::Docker(format!("strict probe {label} start exec: {e}"))
                })?;
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
            let exit_code = loop {
                let info = docker.inspect_exec(&exec.id).await.map_err(|e| {
                    RuntimeError::Docker(format!("strict probe {label} inspect: {e}"))
                })?;
                if let Some(code) = info.exit_code {
                    break code;
                }
                if tokio::time::Instant::now() >= deadline {
                    return Err(RuntimeError::Docker(format!(
                        "strict probe {label}: no exit code for {} within 5s",
                        state.ws_id
                    )));
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            };
            match exit_code {
                0 => {
                    info!("strict probe passed: ws_id={} probe={}", state.ws_id, label);
                }
                code => {
                    return Err(RuntimeError::Io(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        format!(
                            "STRICT_PROBE_FAILED: {} probe failed for {}: exit code {} (isolation broken)",
                            label, state.ws_id, code
                        ),
                    )));
                }
            }
        }
        info!("strict isolation verified for workspace {}", state.ws_id);
        Ok(())
    }

    pub fn get_state(&self, ws_id: &str) -> Option<&WorkspaceState> {
        self.workspaces.get(ws_id)
    }

    pub fn list_workspaces(&self) -> Vec<&WorkspaceState> {
        self.workspaces.values().collect()
    }

    pub fn workspace_count(&self) -> usize {
        self.workspaces.len()
    }

    pub async fn cleanup_orphans(&mut self) -> Result<u32> {
        let docker = self.get_docker().await?.clone();

        let mut removed = 0u32;
        let containers = docker
            .list_containers(Some(ListContainersOptions {
                all: true,
                ..Default::default()
            }))
            .await
            .map_err(|e| RuntimeError::Docker(e.to_string()))?;

        let prefix = container_prefix_from(env_lookup);
        let current_stack = sandbox_stack_id_from(env_lookup);

        for container in containers {
            let is_runtime_owned = container.names.as_ref().is_some_and(|names| {
                names.iter().any(|name| {
                    is_stack_container(name, container.labels.as_ref(), &prefix, &current_stack)
                })
            });
            let belongs_to_current_run = match std::env::var("XIHE_E2E_RUN_ID") {
                Ok(run_id) => container
                    .labels
                    .as_ref()
                    .and_then(|labels| labels.get("xihe.e2e.run-id"))
                    .is_some_and(|label| label == &run_id),
                Err(_) => container
                    .labels
                    .as_ref()
                    .is_none_or(|labels| !labels.contains_key("xihe.e2e.run-id")),
            };
            if is_runtime_owned
                && belongs_to_current_run
                && let Some(id) = &container.id
            {
                match docker
                    .remove_container(
                        id,
                        Some(RemoveContainerOptions {
                            force: true,
                            v: true,
                            link: false,
                        }),
                    )
                    .await
                {
                    Ok(_) => removed += 1,
                    Err(error) => {
                        warn!(
                            "orphan sandbox cleanup failed: container={} status={:?} error={}",
                            id, container.state, error
                        );
                    }
                }
            }
        }

        info!("Cleaned up {} orphan workspace container(s)", removed);
        Ok(removed)
    }

    async fn remove_ephemeral_container(&self, state: &WorkspaceState) -> Result<()> {
        let docker = self
            .docker
            .as_ref()
            .ok_or_else(|| RuntimeError::Docker("Docker not connected".to_string()))?;

        if let Err(error) = docker
            .stop_container(
                &state.container_name,
                Some(StopContainerOptions {
                    t: Some(10),
                    ..Default::default()
                }),
            )
            .await
        {
            warn!(
                "sandbox stop before delete failed: ws_id={} container={} error={}",
                state.ws_id, state.container_name, error
            );
        }

        docker
            .remove_container(
                &state.container_name,
                Some(RemoveContainerOptions {
                    force: true,
                    v: true,
                    link: false,
                }),
            )
            .await
            .map_err(|error| RuntimeError::Docker(format!("remove container: {error}")))?;
        Ok(())
    }

    async fn remove_container_best_effort(&self, container_name: &str) {
        let Some(docker) = self.docker.as_ref() else {
            return;
        };
        if let Err(error) = docker
            .remove_container(
                container_name,
                Some(RemoveContainerOptions {
                    force: true,
                    v: true,
                    link: false,
                }),
            )
            .await
        {
            warn!(
                "sandbox cleanup failed: container={} error={}",
                container_name, error
            );
        }
    }
}

#[cfg(test)]
mod sandbox_resource_limits_tests {
    use super::*;
    use std::collections::HashMap;

    fn lookup<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect();
        move |key: &str| map.get(key).cloned()
    }

    #[test]
    fn defaults_preserve_legacy_profile() {
        let limits = SandboxResourceLimits::default();
        assert_eq!(limits.memory_bytes, 512 * 1024 * 1024);
        assert_eq!(limits.memory_swap_bytes, 512 * 1024 * 1024);
        assert_eq!(limits.nano_cpus, 2_000_000_000);
        assert_eq!(limits.pids_limit, 100);

        let resolved = SandboxResourceLimits::from_lookup(|_| None);
        assert_eq!(resolved, limits);
    }

    #[test]
    fn env_overrides_each_field_and_keeps_swap_equal_to_memory() {
        let limits = SandboxResourceLimits::from_lookup(lookup(&[
            ("XIHE_SANDBOX_MEMORY_MB", "2048"),
            ("XIHE_SANDBOX_CPUS", "6"),
            ("XIHE_SANDBOX_PIDS_LIMIT", "512"),
        ]));
        assert_eq!(limits.memory_bytes, 2048 * 1024 * 1024);
        assert_eq!(limits.memory_swap_bytes, 2048 * 1024 * 1024);
        assert_eq!(limits.nano_cpus, 6_000_000_000);
        assert_eq!(limits.pids_limit, 512);
    }

    #[test]
    fn malformed_or_out_of_range_values_fall_back_per_field() {
        let defaults = SandboxResourceLimits::default();

        let zero_and_garbage = SandboxResourceLimits::from_lookup(lookup(&[
            ("XIHE_SANDBOX_MEMORY_MB", "0"),
            ("XIHE_SANDBOX_CPUS", "not-a-number"),
            ("XIHE_SANDBOX_PIDS_LIMIT", "99999999999"),
        ]));
        assert_eq!(zero_and_garbage, defaults);

        let negative_cpus =
            SandboxResourceLimits::from_lookup(lookup(&[("XIHE_SANDBOX_CPUS", "-4")]));
        assert_eq!(negative_cpus, defaults);

        let oversized_memory =
            SandboxResourceLimits::from_lookup(lookup(&[("XIHE_SANDBOX_MEMORY_MB", "2097152")]));
        assert_eq!(oversized_memory, defaults);
    }

    #[test]
    fn stack_prefix_and_label_default_to_legacy_stack_1() {
        assert_eq!(container_prefix_from(|_| None), CONTAINER_PREFIX_DEFAULT);
        assert_eq!(sandbox_stack_id_from(|_| None), "stack-1");
        assert_eq!(
            container_prefix_from(|_| Some("  ".to_string())),
            CONTAINER_PREFIX_DEFAULT
        );
    }

    #[test]
    fn stack_prefix_and_label_come_from_derived_env_only() {
        let prefix = container_prefix_from(|key| {
            (key == "XIHE_SANDBOX_CONTAINER_PREFIX").then(|| "xihe-ws-s2-ws_".to_string())
        });
        assert_eq!(prefix, "xihe-ws-s2-ws_");

        let stack = sandbox_stack_id_from(|key| {
            (key == "XIHE_SANDBOX_STACK_ID").then(|| "stack-2".to_string())
        });
        assert_eq!(stack, "stack-2");
    }

    #[test]
    fn ownership_requires_prefix_and_matching_label() {
        let mut labels = HashMap::new();
        labels.insert(STACK_LABEL.to_string(), "stack-2".to_string());

        assert!(is_stack_container(
            "/xihe-ws-s2-ws_ws_1",
            Some(&labels),
            "xihe-ws-s2-ws_",
            "stack-2"
        ));
        assert!(!is_stack_container(
            "/xihe-ws-s2-ws_ws_1",
            Some(&labels),
            "xihe-workspace-ws_",
            "stack-2"
        ));
        assert!(!is_stack_container(
            "/xihe-ws-s2-ws_ws_1",
            Some(&labels),
            "xihe-ws-s2-ws_",
            "stack-1"
        ));

        // Legacy container without the label belongs to stack-1 only (B3).
        assert!(is_stack_container(
            "/xihe-workspace-ws_ws_1",
            None,
            CONTAINER_PREFIX_DEFAULT,
            "stack-1"
        ));
        assert!(!is_stack_container(
            "/xihe-workspace-ws_ws_1",
            None,
            CONTAINER_PREFIX_DEFAULT,
            "stack-2"
        ));
    }

    #[test]
    fn container_name_implementation_is_shared_with_executor() {
        // Guards against re-introducing a second format! in executor.rs (T3.1).
        assert_eq!(
            crate::executor::WorkspaceExecutionRouter::container_name("ws_test"),
            container_name("ws_test")
        );
    }
}
