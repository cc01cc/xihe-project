use std::sync::Arc;
use std::time::Duration;

// PLAN-0308 M1: 工具超时的取值与传递统一在 `tool_timeout`（spec S1 三条判断）：
// 生效值由 CP 下发 + 本模块 ENV 覆盖，经 task_local 传入本模块；此处只消费，不做计算。
use crate::tool_timeout;

use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
use bollard::Docker;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tokio_stream::StreamExt;

use crate::error::{Result, RuntimeError};
use crate::gateway::WorkspaceRegistry;
use crate::hydrate::WorkspaceEnsurer;
use crate::workspace::WorkspaceManager;

#[derive(Debug, Serialize, Deserialize)]
struct OperationRequest {
    operation: String,
    payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct OperationResponse {
    ok: bool,
    #[serde(default)]
    result: Value,
    #[serde(default)]
    error: Option<OperationError>,
    #[serde(default)]
    error_code: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct OperationError {
    code: String,
    message: String,
}

#[allow(dead_code)]
#[derive(Clone)]
pub struct WorkspaceExecutionRouter {
    ensurer: Arc<WorkspaceEnsurer>,
    manager: Arc<Mutex<WorkspaceManager>>,
    registry: Arc<WorkspaceRegistry>,
    docker: Docker,
}

impl std::fmt::Debug for WorkspaceExecutionRouter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkspaceExecutionRouter").finish()
    }
}

impl WorkspaceExecutionRouter {
    pub fn new(
        ensurer: Arc<WorkspaceEnsurer>,
        manager: Arc<Mutex<WorkspaceManager>>,
        registry: Arc<WorkspaceRegistry>,
    ) -> Self {
        let docker = Docker::connect_with_local_defaults()
            .unwrap_or_else(|e| panic!("failed to connect Docker for executor router: {e}"));
        Self {
            ensurer,
            manager,
            registry,
            docker,
        }
    }

    async fn ensure(&self, workspace_id: &str) -> Result<crate::gateway::XiheRuntimeInstance> {
        self.ensurer
            .ensure_workspace_materialized(workspace_id)
            .await
    }

    fn container_name(workspace_id: &str) -> String {
        format!("xihe-workspace-ws_{workspace_id}")
    }

    async fn exec_oneshot(
        &self,
        workspace_id: &str,
        operation: &str,
        payload: Value,
    ) -> Result<Value> {
        let _instance = self.ensure(workspace_id).await?;
        let container_name = Self::container_name(workspace_id);
        let request_id = uuid::Uuid::new_v4().to_string();
        let op = OperationRequest {
            operation: operation.to_string(),
            payload,
            request_id: Some(request_id.clone()),
        };
        let op_json = serde_json::to_string(&op)
            .map_err(|e| RuntimeError::InvalidPath(format!("serialize op: {e}")))?;
        let exec = self
            .docker
            .create_exec(
                &container_name,
                CreateExecOptions {
                    attach_stdin: Some(true),
                    attach_stdout: Some(true),
                    attach_stderr: Some(true),
                    tty: Some(false),
                    cmd: Some(vec![
                        "xihe-container-runtime".to_string(),
                        "--oneshot".to_string(),
                    ]),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| RuntimeError::Docker(format!("create_exec {container_name}: {e}")))?;
        let start = self
            .docker
            .start_exec(
                &exec.id,
                Some(StartExecOptions {
                    detach: false,
                    tty: false,
                    output_capacity: Some(8 * 1024),
                }),
            )
            .await
            .map_err(|e| RuntimeError::Docker(format!("start_exec {container_name}: {e}")))?;
        let (mut output, mut input) = match start {
            StartExecResults::Attached { output, input } => (output, input),
            StartExecResults::Detached => {
                return Err(RuntimeError::Docker(
                    "exec unexpectedly detached".to_string(),
                ))
            }
        };
        let mut op_bytes = op_json.into_bytes();
        op_bytes.push(b'\n');
        input
            .write_all(&op_bytes)
            .await
            .map_err(|e| RuntimeError::Docker(format!("write stdin: {e}")))?;
        let _ = input.shutdown().await;
        let mut stdout_buf: Vec<u8> = Vec::new();
        let mut stderr_buf: Vec<u8> = Vec::new();
        let mut stream_err: Option<String> = None;
        let collect = async {
            while let Some(item) = output.next().await {
                match item {
                    Ok(bollard::container::LogOutput::StdOut { message }) => {
                        stdout_buf.extend_from_slice(&message)
                    }
                    Ok(bollard::container::LogOutput::StdErr { message }) => {
                        stderr_buf.extend_from_slice(&message)
                    }
                    Ok(bollard::container::LogOutput::Console { message }) => {
                        stdout_buf.extend_from_slice(&message)
                    }
                    Ok(bollard::container::LogOutput::StdIn { .. }) => {}
                    Err(e) => {
                        stream_err = Some(format!("stream error: {e}"));
                        break;
                    }
                }
            }
        };
        let effective = tool_timeout::current_or_resolve();
        let correlation = tool_timeout::current_correlation();
        tracing::info!(
            target: "timeout",
            operation = %operation,
            workspace_id = %workspace_id,
            "tool exec wait: {}{}",
            effective.signature(),
            correlation.render()
        );
        match tokio::time::timeout(Duration::from_secs(effective.seconds), collect).await {
            Ok(_) => {}
            Err(_) => {
                tracing::warn!(
                    target: "timeout",
                    operation = %operation,
                    workspace_id = %workspace_id,
                    "tool exec timeout: {}{}",
                    effective.timeout_signature(),
                    correlation.render()
                );
                return Err(RuntimeError::Timeout {
                    detail: format!("{}{}", effective.timeout_signature(), correlation.render()),
                });
            }
        }
        if let Some(e) = stream_err {
            return Err(RuntimeError::Docker(e));
        }
        let stdout_str = String::from_utf8_lossy(&stdout_buf).trim().to_string();
        if stdout_str.is_empty() {
            return Err(RuntimeError::Docker(format!(
                "empty response for {operation}, stderr: {}",
                String::from_utf8_lossy(&stderr_buf)
            )));
        }
        let json_line = stdout_str
            .lines()
            .rfind(|l| !l.trim().is_empty())
            .unwrap_or(&stdout_str);
        let resp: OperationResponse = serde_json::from_str(json_line).map_err(|e| {
            RuntimeError::Docker(format!("parse exec response: {e}, raw: {json_line}"))
        })?;
        if resp.ok {
            Ok(resp.result)
        } else {
            let code = resp
                .error_code
                .clone()
                .unwrap_or_else(|| "EXEC_FAILED".to_string());
            let msg = resp
                .error
                .map(|e| e.message)
                .unwrap_or_else(|| "unknown".to_string());
            Err(Self::map_sandbox_error(&code, msg))
        }
    }

    /// 沙盒错误码 → 错误类型（PLAN-0308 T3.4：`TIMEOUT` 必须保持超时语义，
    /// 并由 host 补全来源 / valueOrigin / toolCallId；此前落到 Docker 错误会丢掉归因）。
    fn map_sandbox_error(code: &str, msg: String) -> RuntimeError {
        match code {
            "PATH_TRAVERSAL" => RuntimeError::PathTraversal { path: msg },
            "SYMLINK_ESCAPE" => RuntimeError::SymlinkEscape {
                path: msg.clone(),
                resolved: msg,
            },
            "INVALID_PATH" => RuntimeError::InvalidPath(msg),
            "FILE_NOT_FOUND" => RuntimeError::FileNotFound(msg),
            "WORKSPACE_NOT_FOUND" => RuntimeError::WorkspaceNotFound(msg),
            "TIMEOUT" => RuntimeError::Timeout {
                detail: format!(
                    "{}{} mechanism=guard",
                    tool_timeout::current_or_resolve().timeout_signature(),
                    tool_timeout::current_correlation().render()
                ),
            },
            _ => RuntimeError::Docker(format!("{code}: {msg}")),
        }
    }

    pub async fn read_file(&self, workspace_id: &str, path: &str) -> Result<String> {
        let payload = serde_json::json!({"path": path});
        let val = self
            .exec_oneshot(workspace_id, "read_file", payload)
            .await?;
        Ok(val
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string())
    }

    // PLAN-292 T6: binary-safe read — the sandbox op detects binary content
    // and returns {content, total_lines, is_binary} (base64 when binary).
    pub async fn read_file_range(
        &self,
        workspace_id: &str,
        path: &str,
        offset: Option<usize>,
        limit: Option<usize>,
    ) -> Result<serde_json::Value> {
        let payload = serde_json::json!({"path": path, "offset": offset, "limit": limit});
        self.exec_oneshot(workspace_id, "read_file_range", payload)
            .await
    }

    pub async fn write_file(
        &self,
        workspace_id: &str,
        path: &str,
        content: &str,
    ) -> Result<String> {
        let payload = serde_json::json!({"path": path, "content": content});
        let val = self
            .exec_oneshot(workspace_id, "write_file", payload)
            .await?;
        Ok(val
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("ok")
            .to_string())
    }

    pub async fn list_directory(&self, workspace_id: &str, path: &str) -> Result<Value> {
        let payload = serde_json::json!({"path": path});
        self.exec_oneshot(workspace_id, "list_directory", payload)
            .await
    }

    pub async fn glob(&self, workspace_id: &str, pattern: &str, path: &str) -> Result<Value> {
        let payload = serde_json::json!({"pattern": pattern, "path": path});
        self.exec_oneshot(workspace_id, "glob", payload).await
    }

    pub async fn grep(&self, workspace_id: &str, pattern: &str, path: &str) -> Result<Value> {
        let payload = serde_json::json!({"pattern": pattern, "path": path});
        self.exec_oneshot(workspace_id, "grep", payload).await
    }

    pub async fn get_file_info(&self, workspace_id: &str, path: &str) -> Result<Value> {
        let payload = serde_json::json!({"path": path});
        self.exec_oneshot(workspace_id, "get_file_info", payload)
            .await
    }

    pub async fn watch_directory(&self, workspace_id: &str, path: &str) -> Result<Value> {
        let payload = serde_json::json!({"path": path});
        self.exec_oneshot(workspace_id, "watch_directory", payload)
            .await
    }

    pub async fn edit_file(
        &self,
        workspace_id: &str,
        file_path: &str,
        old_string: &str,
        new_string: &str,
        replace_all: bool,
    ) -> Result<Value> {
        let payload = serde_json::json!({"file_path": file_path, "old_string": old_string, "new_string": new_string, "replace_all": replace_all});
        self.exec_oneshot(workspace_id, "edit_file", payload).await
    }

    pub async fn delete_file(&self, workspace_id: &str, path: &str) -> Result<String> {
        let payload = serde_json::json!({"path": path});
        let val = self
            .exec_oneshot(workspace_id, "delete_file", payload)
            .await?;
        Ok(val
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("deleted")
            .to_string())
    }

    pub async fn delete_directory(
        &self,
        workspace_id: &str,
        path: &str,
        recursive: bool,
    ) -> Result<String> {
        let payload = serde_json::json!({"path": path, "recursive": recursive});
        let val = self
            .exec_oneshot(workspace_id, "delete_directory", payload)
            .await?;
        Ok(val
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("deleted")
            .to_string())
    }

    pub async fn move_file(&self, workspace_id: &str, from: &str, to: &str) -> Result<String> {
        let payload = serde_json::json!({"from": from, "to": to});
        let val = self
            .exec_oneshot(workspace_id, "move_file", payload)
            .await?;
        Ok(val
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("moved")
            .to_string())
    }

    pub async fn copy_file(&self, workspace_id: &str, from: &str, to: &str) -> Result<String> {
        let payload = serde_json::json!({"from": from, "to": to});
        let val = self
            .exec_oneshot(workspace_id, "copy_file", payload)
            .await?;
        Ok(val
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("copied")
            .to_string())
    }

    pub async fn mkdir(&self, workspace_id: &str, path: &str) -> Result<String> {
        let payload = serde_json::json!({"path": path});
        let val = self.exec_oneshot(workspace_id, "mkdir", payload).await?;
        Ok(val
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("created")
            .to_string())
    }

    pub async fn extract_pdf_text(&self, workspace_id: &str, path: &str) -> Result<String> {
        let payload = serde_json::json!({"path": path});
        let val = self
            .exec_oneshot(workspace_id, "extract_pdf_text", payload)
            .await?;
        Ok(val
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string())
    }

    pub async fn execute_command(
        &self,
        workspace_id: &str,
        command: &str,
        args: Vec<String>,
        timeout: Option<u64>,
        truncate_limit: Option<u64>,
    ) -> Result<Value> {
        // PLAN-0308 T3.4（决策 #31）：容器守卫由**授权值**派生，不再由调用方或容器默认值决定——
        // 时间守卫 = 本跳生效等待值（含 per-call / ENV / 预热增量）；输出守卫 = CP 下发的上限。
        // 调用方显式给更小的值仅作收窄（超出授权无效）。
        let guard_seconds =
            tool_timeout::time_guard(tool_timeout::current_or_resolve().seconds, timeout);
        let guard_limit =
            tool_timeout::output_limit_guard(tool_timeout::current_output_limit(), truncate_limit);
        let payload = serde_json::json!({"command": command, "args": args, "timeout": guard_seconds, "truncate_limit": guard_limit});
        self.exec_oneshot(workspace_id, "execute_command", payload)
            .await
    }

    pub async fn start_background_process(
        &self,
        workspace_id: &str,
        command: &str,
        args: Vec<String>,
    ) -> Result<String> {
        let payload =
            serde_json::json!({"workspaceId": workspace_id, "command": command, "args": args});
        let val = self
            .exec_oneshot(workspace_id, "start_background_process", payload)
            .await?;
        Ok(val
            .get("jobId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string())
    }

    pub async fn list_background_processes(&self, workspace_id: &str) -> Result<Value> {
        let payload = serde_json::json!({"workspaceId": workspace_id});
        self.exec_oneshot(workspace_id, "list_background_processes", payload)
            .await
    }

    pub async fn get_background_process(&self, workspace_id: &str, job_id: &str) -> Result<Value> {
        let payload = serde_json::json!({"workspaceId": workspace_id, "jobId": job_id});
        self.exec_oneshot(workspace_id, "get_background_process", payload)
            .await
    }

    pub async fn cancel_background_process(
        &self,
        workspace_id: &str,
        job_id: &str,
    ) -> Result<Value> {
        let payload = serde_json::json!({"workspaceId": workspace_id, "jobId": job_id});
        self.exec_oneshot(workspace_id, "cancel_background_process", payload)
            .await
    }

    pub async fn read_command_output(
        &self,
        workspace_id: &str,
        artifact_id: &str,
        offset: Option<usize>,
        limit: Option<usize>,
    ) -> Result<Value> {
        let payload =
            serde_json::json!({"artifact_id": artifact_id, "offset": offset, "limit": limit});
        self.exec_oneshot(workspace_id, "read_command_output", payload)
            .await
    }
}

#[cfg(test)]
mod sandbox_error_mapping_tests {
    use super::*;
    use crate::tool_timeout::{self, ValueOrigin, WaitSource};

    /// PLAN-0308 T3.4：沙盒 `TIMEOUT`（容器守卫到界）必须保持超时语义，
    /// 且 host 侧补全 layer/生效值/来源/valueOrigin/toolCallId + mechanism=guard。
    #[tokio::test]
    async fn sandbox_timeout_maps_to_signed_runtime_timeout() {
        let effective = tool_timeout::resolve(Some((90, Some(ValueOrigin::Config))), None);
        assert_eq!(effective.source, WaitSource::Cp);
        let correlation = tool_timeout::Correlation {
            tool_call_id: Some("call-1".to_string()),
            ..tool_timeout::Correlation::default()
        };
        let err = tool_timeout::scope_tool_call(effective, correlation, None, async {
            WorkspaceExecutionRouter::map_sandbox_error(
                "TIMEOUT",
                "Operation timed out".to_string(),
            )
        })
        .await;

        let RuntimeError::Timeout { detail } = err else {
            panic!("expected Timeout, got {err:?}");
        };
        assert!(detail.contains("layer=runtime_exec"), "{detail}");
        assert!(detail.contains("effectiveSeconds=90"), "{detail}");
        assert!(detail.contains("source=cp"), "{detail}");
        assert!(detail.contains("valueOrigin=config"), "{detail}");
        assert!(detail.contains("mechanism=guard"), "{detail}");
        assert!(detail.contains("toolCallId=call-1"), "{detail}");
    }

    #[test]
    fn other_sandbox_codes_keep_their_types() {
        assert!(matches!(
            WorkspaceExecutionRouter::map_sandbox_error("FILE_NOT_FOUND", "x".to_string()),
            RuntimeError::FileNotFound(_)
        ));
        assert!(matches!(
            WorkspaceExecutionRouter::map_sandbox_error("EXEC_FAILED", "boom".to_string()),
            RuntimeError::Docker(_)
        ));
    }
}
