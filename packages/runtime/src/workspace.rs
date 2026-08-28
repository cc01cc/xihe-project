use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use bollard::Docker;
use bollard::exec::CreateExecOptions;
use bollard::models::{ContainerCreateBody, HostConfig};
use bollard::query_parameters::{
    CreateContainerOptions, RemoveContainerOptions, StartContainerOptions, StopContainerOptions,
};
use tokio::fs;
use tracing::{info, warn};

use crate::error::{Result, RuntimeError};
use crate::sandbox::SecurityProfile;

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
        let docker = self.get_docker().await?;
        let name = container_name(ws_id);

        fs::create_dir_all(workspace_path)
            .await
            .map_err(RuntimeError::Io)?;

        let host_config = HostConfig {
            memory: Some(512 * 1024 * 1024),
            memory_swap: Some(512 * 1024 * 1024),
            nano_cpus: Some(2_000_000_000),
            pids_limit: Some(100),
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

        // Start xihe-container-runtime inside the container
        self.start_container_runtime(&state).await?;

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
            .remove(ws_id)
            .ok_or_else(|| RuntimeError::SandboxNotFound(ws_id.to_string()))?;

        if let Some(ref docker) = self.docker {
            let _ = docker
                .stop_container(
                    &state.container_name,
                    Some(StopContainerOptions {
                        t: Some(10),
                        ..Default::default()
                    }),
                )
                .await;

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
                .map_err(|e| RuntimeError::Docker(format!("remove container: {e}")))?;
        }

        if PathBuf::from(&state.workspace_path).exists() {
            fs::remove_dir_all(&state.workspace_path)
                .await
                .map_err(RuntimeError::Io)?;
        }

        info!("Workspace deleted: ws_id={}", ws_id);
        Ok(())
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
                            "wget -qO- http://127.0.0.1:39001/health 2>/dev/null || curl -sf http://127.0.0.1:39001/health 2>/dev/null".into(),
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
                // If start_exec didn't error, the command ran — check exit via inspect
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
        // Continue anyway — container-runtime may start serving after health check window
        Ok(())
    }

    pub async fn start_mcp_bridge(
        &self,
        ws_id: &str,
        server_id: &str,
        _command: &str,
        _args: &[String],
    ) -> Result<(String, u16)> {
        let state = self
            .workspaces
            .get(ws_id)
            .ok_or_else(|| RuntimeError::SandboxNotFound(ws_id.to_string()))?;
        let docker = self
            .docker
            .as_ref()
            .ok_or_else(|| RuntimeError::Docker("Docker not connected".to_string()))?;

        let port = 39000u16;

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

        let container_ip = resolve_container_ip(docker, &state.container_name).await?;

        info!("MCP bridge started: ws={ws_id} server={server_id} at {container_ip}:{port}");

        Ok((container_ip, port))
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

        let _ = docker
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
            .await;

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
        let docker = match &self.docker {
            Some(d) => d,
            None => return Ok(0),
        };

        let mut removed = 0u32;
        let containers = docker
            .list_containers(None::<bollard::query_parameters::ListContainersOptions>)
            .await
            .map_err(|e| RuntimeError::Docker(e.to_string()))?;

        for container in containers {
            if let Some(names) = &container.names {
                for name in names {
                    if name.starts_with("/xihe-workspace-ws_")
                        && let Some(id) = &container.id
                    {
                        let _ = docker
                            .remove_container(
                                id,
                                Some(RemoveContainerOptions {
                                    force: true,
                                    v: true,
                                    link: false,
                                }),
                            )
                            .await;
                        removed += 1;
                    }
                }
            }
        }

        info!("Cleaned up {} orphan workspace container(s)", removed);
        Ok(removed)
    }
}

async fn resolve_container_ip(docker: &Docker, container_name: &str) -> Result<String> {
    match docker.inspect_container(container_name, None).await {
        Ok(inspect) => {
            if let Some(settings) = &inspect.network_settings
                && let Some(networks) = &settings.networks
            {
                for ep in networks.values() {
                    if let Some(ip) = &ep.ip_address
                        && !ip.is_empty()
                    {
                        return Ok(ip.clone());
                    }
                }
            }
            Err(RuntimeError::Docker(
                "could not resolve container IP from inspect".to_string(),
            ))
        }
        Err(e) => Err(RuntimeError::Docker(format!(
            "inspect container {container_name}: {e}"
        ))),
    }
}
