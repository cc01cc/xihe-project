use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use bollard::Docker;
use bollard::exec::CreateExecOptions;
use bollard::models::{ContainerCreateBody, HostConfig, PortBinding};
use bollard::query_parameters::{
    CreateContainerOptions, ListContainersOptions, RemoveContainerOptions, StartContainerOptions,
    StopContainerOptions,
};
use tokio::fs;
use tracing::{info, warn};

use crate::error::{Result, RuntimeError};
use crate::sandbox::SecurityProfile;

pub const CONTAINER_RUNTIME_PORT: u16 = 39001;

fn container_name(ws_id: &str) -> String {
    format!("xihe-workspace-ws_{ws_id}")
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
            let content = format!("probe-{}", ws_id);
            if let Err(e) = fs::write(&probe_file, content.as_bytes()).await {
                return Err(RuntimeError::Io(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    format!(
                        "STORAGE_UNAVAILABLE: host writability probe failed for {}: {}",
                        workspace_path, e
                    ),
                )));
            }
            let _ = fs::remove_file(&probe_file).await;
        }
        // M1b: available space check (>64MB) — fs2
        {
            let available = fs2::available_space(workspace_path).map_err(|e| {
                RuntimeError::Io(std::io::Error::other(format!(
                    "STORAGE_UNAVAILABLE: available_space check failed for {}: {}",
                    workspace_path, e
                )))
            })?;
            if available < 64 * 1024 * 1024 {
                return Err(RuntimeError::Io(std::io::Error::new(
                    std::io::ErrorKind::StorageFull,
                    format!(
                        "STORAGE_UNAVAILABLE: insufficient space for {}: {} bytes available",
                        workspace_path, available
                    ),
                )));
            }
        }

        // Native Windows hosts cannot route to Docker Desktop's Linux bridge IP.
        // Publish the private container-runtime port on a Docker-assigned
        // loopback port so the host gateway can reach it. Strict sandboxes use
        // host-side file operations and do not need a published port.
        let port_bindings = match profile {
            SecurityProfile::Strict => None,
            SecurityProfile::Coding | SecurityProfile::Isolated => Some(HashMap::from([(
                format!("{CONTAINER_RUNTIME_PORT}/tcp"),
                Some(vec![PortBinding {
                    host_ip: Some("127.0.0.1".to_string()),
                    host_port: Some(String::new()),
                }]),
            )])),
        };

        let labels = std::env::var("XIHE_E2E_RUN_ID").ok().map(|run_id| {
            HashMap::from([(String::from("xihe.e2e.run-id"), run_id)])
        });

        let host_config = HostConfig {
            memory: Some(512 * 1024 * 1024),
            memory_swap: Some(512 * 1024 * 1024),
            nano_cpus: Some(2_000_000_000),
            pids_limit: Some(100),
            cap_drop: Some(vec!["ALL".to_string()]),
            security_opt: Some(vec!["no-new-privileges:true".to_string()]),
            binds: Some(vec![format!("{}:/workspace:rw", workspace_path)]),
            port_bindings,
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
        if let Err(error) = self.start_container_runtime(&state).await {
            self.remove_container_best_effort(&state.container_name).await;
            return Err(error);
        }

        // M1b: verify mount via sentinel (host -> container) — grill B3/B4
        if let Err(e) = self.verify_mount(&state).await {
            // Clean up container on mount verification failure to avoid orphan
            self.remove_container_best_effort(&state.container_name).await;
            return Err(e);
        }

        // M1c: Strict isolation probes — grill B5 direct Engine exec, B6 STRICT_PROBE_FAILED
        if profile == SecurityProfile::Strict
            && let Err(e) = self.verify_strict_isolation(&state).await
        {
            self.remove_container_best_effort(&state.container_name).await;
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

    pub async fn start_container(&mut self, ws_id: &str) -> Result<()> {
        let state = self
            .workspaces
            .get(ws_id)
            .ok_or_else(|| RuntimeError::SandboxNotFound(ws_id.to_string()))?;
        let docker = self
            .docker
            .as_ref()
            .ok_or_else(|| RuntimeError::Docker("Docker not connected".to_string()))?;
        docker
            .start_container(&state.container_name, None::<StartContainerOptions>)
            .await
            .map_err(|e| RuntimeError::Docker(format!("start container: {e}")))?;

        self.start_container_runtime(state).await?;
        info!(
            "Container started and container-runtime restarted: ws_id={}",
            ws_id
        );
        Ok(())
    }

    async fn start_container_runtime(&self, state: &WorkspaceState) -> Result<()> {
        let docker = self
            .docker
            .as_ref()
            .ok_or_else(|| RuntimeError::Docker("Docker not connected".to_string()))?;

        let setup_cmd = "nohup /usr/local/bin/xihe-container-runtime \
             > /workspace/.xihe-container-runtime.log 2>&1 & \
             echo $! > /workspace/.xihe-container-runtime.pid"
            .to_string();

        let exec = docker
            .create_exec(
                &state.container_name,
                CreateExecOptions {
                    cmd: Some(vec!["sh".to_string(), "-c".to_string(), setup_cmd]),
                    attach_stdout: Some(false),
                    attach_stderr: Some(false),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| RuntimeError::Docker(format!("create exec: {e}")))?;

        docker
            .start_exec(
                &exec.id,
                Some(bollard::exec::StartExecOptions {
                    detach: true,
                    tty: false,
                    output_capacity: None,
                }),
            )
            .await
            .map_err(|e| RuntimeError::Docker(format!("start exec: {e}")))?;

        // Wait for xihe-container-runtime to become healthy (max 5s, 500ms intervals)
        for i in 0..10 {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let check = docker
                .create_exec(
                    &state.container_name,
                    CreateExecOptions {
                        cmd: Some(vec![
                            "sh".to_string(),
                            "-c".to_string(),
                            format!(
                                "wget -qO- http://127.0.0.1:{CONTAINER_RUNTIME_PORT}/health 2>/dev/null || curl -sf http://127.0.0.1:{CONTAINER_RUNTIME_PORT}/health 2>/dev/null"
                            ),
                        ]),
                        attach_stdout: Some(true),
                        attach_stderr: Some(true),
                        ..Default::default()
                    },
                )
                .await;

            if let Ok(exec) = check {
                // Use a detached exec and just check the exit code via inspect
                let _ = docker
                    .start_exec(
                        &exec.id,
                        Some(bollard::exec::StartExecOptions {
                            detach: false,
                            tty: false,
                            output_capacity: Some(64),
                        }),
                    )
                    .await;
                // Small delay to let inspect populate exit_code (bollard quirk on Windows):
                // inspect_exec immediately after start_exec returns Running (exit_code None).
                tokio::time::sleep(Duration::from_millis(200)).await;
                if let Ok(info) = docker.inspect_exec(&exec.id).await
                    && info.exit_code == Some(0)
                {
                    info!(
                        "xihe-container-runtime ready for workspace {} (attempt {})",
                        state.ws_id,
                        i + 1
                    );
                    return Ok(());
                }
            }
        }

        warn!(
            "xihe-container-runtime health check timeout for workspace {}",
            state.ws_id
        );
        Err(RuntimeError::Docker(format!(
            "xihe-container-runtime health check timeout for workspace {}",
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
        let check_cmd = format!("cat /workspace/.xihe-sentinel | grep -q \"{}\"", expected);
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
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            let info = docker
                .inspect_exec(&exec.id)
                .await
                .map_err(|e| RuntimeError::Docker(format!("strict probe {label} inspect: {e}")))?;
            match info.exit_code {
                Some(0) => {
                    info!("strict probe passed: ws_id={} probe={}", state.ws_id, label);
                }
                Some(code) => {
                    return Err(RuntimeError::Io(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        format!(
                            "STRICT_PROBE_FAILED: {} probe failed for {}: exit code {} (isolation broken)",
                            label, state.ws_id, code
                        ),
                    )));
                }
                None => {
                    return Err(RuntimeError::Docker(format!(
                        "strict probe {label}: no exit code for {}",
                        state.ws_id
                    )));
                }
            }
        }
        info!("strict isolation verified for workspace {}", state.ws_id);
        Ok(())
    }

    async fn resolve_mcp_bridge_endpoint(
        &self,
        ws_id: &str,
        server_id: &str,
        container_name: &str,
        container_port: u16,
    ) -> Result<(String, u16)> {
        let unavailable = |detail: String| RuntimeError::McpBridgeUnavailable {
            workspace_id: ws_id.to_string(),
            server_id: server_id.to_string(),
            detail,
        };
        let docker = self
            .docker
            .as_ref()
            .ok_or_else(|| unavailable("Docker is not connected".to_string()))?;
        let inspect = docker
            .inspect_container(container_name, None)
            .await
            .map_err(|error| unavailable(format!("inspect container failed: {error}")))?;

        if let Some(bindings) = inspect
            .network_settings
            .as_ref()
            .and_then(|settings| settings.ports.as_ref())
            .and_then(|ports| ports.get(&format!("{container_port}/tcp")))
            .and_then(|bindings| bindings.as_ref())
            && let Some(binding) = bindings.iter().find(|binding| {
                binding
                    .host_port
                    .as_ref()
                    .is_some_and(|port| !port.is_empty())
            })
        {
            let host_port = binding
                .host_port
                .as_deref()
                .and_then(|port| port.parse::<u16>().ok())
                .ok_or_else(|| {
                    unavailable(format!(
                        "published bridge host port is invalid for container port {container_port}"
                    ))
                })?;
            let host = binding
                .host_ip
                .as_deref()
                .filter(|ip| !ip.is_empty() && *ip != "0.0.0.0")
                .unwrap_or("127.0.0.1")
                .to_string();
            return Ok((host, host_port));
        }

        if cfg!(windows) {
            return Err(unavailable(format!(
                "bridge container port {container_port} is not published for native Windows Runtime"
            )));
        }

        let container_ip = inspect
            .network_settings
            .and_then(|settings| settings.networks)
            .and_then(|networks| {
                networks
                    .values()
                    .find_map(|endpoint| endpoint.ip_address.clone().filter(|ip| !ip.is_empty()))
            })
            .ok_or_else(|| unavailable("container has no reachable network address".to_string()))?;
        Ok((container_ip, container_port))
    }

    pub async fn start_mcp_bridge(
        &self,
        ws_id: &str,
        server_id: &str,
        command: &str,
        args: &[String],
        port: u16,
    ) -> Result<(String, u16)> {
        let state = self
            .workspaces
            .get(ws_id)
            .cloned()
            .ok_or_else(|| RuntimeError::SandboxNotFound(ws_id.to_string()))?;
        let (bridge_host, bridge_port) = self
            .resolve_mcp_bridge_endpoint(ws_id, server_id, &state.container_name, port)
            .await?;
        let docker = self
            .docker
            .as_ref()
            .ok_or_else(|| RuntimeError::Docker("Docker not connected".to_string()))?;

        let bridge_cmd = format!(
            "/usr/local/bin/xihe-mcp-bridge --port {port} & echo $! > /workspace/.xihe-bridge-{server_id}.pid"
        );

        let exec = docker
            .create_exec(
                &state.container_name,
                CreateExecOptions {
                    cmd: Some(vec!["sh".to_string(), "-c".to_string(), bridge_cmd]),
                    attach_stdout: Some(false),
                    attach_stderr: Some(false),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| RuntimeError::Docker(format!("create bridge exec: {e}")))?;

        docker
            .start_exec(
                &exec.id,
                Some(bollard::exec::StartExecOptions {
                    detach: true,
                    ..Default::default()
                }),
            )
            .await
            .map_err(|e| RuntimeError::Docker(format!("start bridge exec: {e}")))?;

        info!(
            "MCP bridge started: ws={ws_id} server={server_id} cmd={command} args={} at {bridge_host}:{bridge_port} (container_port={port})",
            args.len()
        );

        Ok((bridge_host, bridge_port))
    }

    pub async fn stop_mcp_bridge(&self, ws_id: &str, server_id: &str) -> Result<()> {
        let state = self
            .workspaces
            .get(ws_id)
            .ok_or_else(|| RuntimeError::SandboxNotFound(ws_id.to_string()))?;
        let docker = self
            .docker
            .as_ref()
            .ok_or_else(|| RuntimeError::Docker("Docker not connected".to_string()))?;

        let kill_cmd = format!(
            "kill $(cat /workspace/.xihe-bridge-{server_id}.pid 2>/dev/null) 2>/dev/null; \
             rm -f /workspace/.xihe-bridge-{server_id}.pid"
        );

        let exec = docker
            .create_exec(
                &state.container_name,
                CreateExecOptions {
                    cmd: Some(vec![
                        "sh".to_string(),
                        "-c".to_string(),
                        kill_cmd.to_string(),
                    ]),
                    attach_stdout: Some(false),
                    attach_stderr: Some(false),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| RuntimeError::Docker(format!("create bridge stop exec: {e}")))?;

        docker
            .start_exec(
                &exec.id,
                Some(bollard::exec::StartExecOptions {
                    detach: true,
                    tty: false,
                    output_capacity: None,
                }),
            )
            .await
            .map_err(|e| RuntimeError::Docker(format!("start bridge stop exec: {e}")))?;

        info!("MCP bridge stopped: ws={ws_id} server={server_id}");
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

        for container in containers {
            let is_runtime_owned = container.names.as_ref().is_some_and(|names| {
                names
                    .iter()
                    .any(|name| name.starts_with("/xihe-workspace-ws_"))
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
            if is_runtime_owned && belongs_to_current_run && let Some(id) = &container.id {
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
