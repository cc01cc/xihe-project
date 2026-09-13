use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
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
use tokio_util::sync::CancellationToken;

use crate::error::{Result, RuntimeError};
use crate::gateway::WorkspaceRegistry;
use crate::hydrate::WorkspaceEnsurer;
use crate::workspace::WorkspaceManager;

/// Host-side registry of executions that are still running, keyed by
/// `operationItemId` (PLAN-0317 T2.1, decision #12 — the same key CP stores in
/// `operation_items.tool_call_id` and forwards as `X-Operation-Item-Id`).
///
/// A cancel request looks the execution up by that key and triggers its
/// [`CancellationToken`]; T2.2 wires the token to the container abort frame.
#[derive(Default)]
pub struct InFlightExecutions {
    inner: StdMutex<HashMap<String, CancellationToken>>,
}

impl InFlightExecutions {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a running execution. The returned token is cancelled when a
    /// cancel request arrives for the same `item_id`.
    pub fn register(&self, item_id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        let mut map = self.inner.lock().expect("in-flight registry poisoned");
        // A second registration for the same item replaces the previous token;
        // the old execution then becomes unaddressable, which is logged by the
        // caller rather than silently ignored.
        if let Some(previous) = map.insert(item_id.to_string(), token.clone()) {
            previous.cancel();
        }
        token
    }

    /// Removes an execution once it has finished (any exit path).
    pub fn unregister(&self, item_id: &str) {
        let mut map = self.inner.lock().expect("in-flight registry poisoned");
        map.remove(item_id);
    }

    /// Requests termination; `false` when nothing is in flight for `item_id`.
    /// Idempotent: repeated requests keep the token cancelled.
    pub fn request_termination(&self, item_id: &str) -> bool {
        let map = self.inner.lock().expect("in-flight registry poisoned");
        match map.get(item_id) {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    pub fn len(&self) -> usize {
        self.inner
            .lock()
            .expect("in-flight registry poisoned")
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Removes the in-flight entry on every exit path of an execution.
struct InFlightGuard {
    registry: Arc<InFlightExecutions>,
    item_id: String,
    _token: CancellationToken,
}

/// PLAN-0317 T2.2（决策 #13）：中止确认的有界等待（容器回帧）与 EOF 兜底等待。
const ABORT_CONFIRM_WAIT: Duration = Duration::from_secs(5);
const ABORT_EOF_WAIT: Duration = Duration::from_secs(2);

/// 执行输出收集结果：stdout / stderr / 流错误。
type CollectResult = (Vec<u8>, Vec<u8>, Option<String>);
type CollectJoin = std::result::Result<CollectResult, tokio::task::JoinError>;

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.registry.unregister(&self.item_id);
    }
}

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
    in_flight: Arc<InFlightExecutions>,
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
            in_flight: Arc::new(InFlightExecutions::new()),
            docker,
        }
    }

    /// In-flight execution registry (PLAN-0317 T2.1); cancel requests (T2.3)
    /// address executions through it by `operationItemId`.
    pub fn in_flight(&self) -> Arc<InFlightExecutions> {
        self.in_flight.clone()
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
        self.exec_oneshot_inner(workspace_id, operation, payload).await
    }

    /// Executes against the already-materialized container **without**
    /// re-materializing the workspace or refreshing its activity timestamp.
    /// Used by the periodic job cleanup so an idle workspace is neither
    /// started nor kept alive by maintenance traffic.
    async fn exec_oneshot_existing(
        &self,
        workspace_id: &str,
        operation: &str,
        payload: Value,
    ) -> Result<Value> {
        self.exec_oneshot_inner(workspace_id, operation, payload).await
    }

    async fn exec_oneshot_inner(
        &self,
        workspace_id: &str,
        operation: &str,
        payload: Value,
    ) -> Result<Value> {
        let container_name = Self::container_name(workspace_id);
        let request_id = uuid::Uuid::new_v4().to_string();
        // PLAN-0317 T2.1/T2.2: register the execution under the CP-provided
        // operationItemId so a cancel request can address this exact run. The
        // guard removes the entry on every exit path.
        let correlation = tool_timeout::current_correlation();
        let (_in_flight_guard, cancel_token) = match correlation.tool_call_id.as_deref() {
            Some(item_id) => {
                let registry = self.in_flight.clone();
                let token = registry.register(item_id);
                (
                    Some(InFlightGuard {
                        registry,
                        item_id: item_id.to_string(),
                        _token: token.clone(),
                    }),
                    Some(token),
                )
            }
            None => (None, None),
        };
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
        input
            .flush()
            .await
            .map_err(|e| RuntimeError::Docker(format!("flush stdin: {e}")))?;
        // PLAN-0317 T2.2（决策 #13）：stdin 保持打开，超时/取消时写入中止帧；
        // 仅在确认失败时以关闭写端（EOF）兜底。
        let collector = tokio::spawn(async move {
            let mut stdout_buf: Vec<u8> = Vec::new();
            let mut stderr_buf: Vec<u8> = Vec::new();
            let mut stream_err: Option<String> = None;
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
            (stdout_buf, stderr_buf, stream_err)
        });
        let effective = tool_timeout::current_or_resolve();
        tracing::info!(
            target: "timeout",
            operation = %operation,
            workspace_id = %workspace_id,
            "tool exec wait: {}{}",
            effective.signature(),
            correlation.render()
        );
        enum WaitOutcome {
            Finished(CollectJoin),
            Aborted(&'static str),
        }
        let mut collector = collector;
        let cancel_arm = {
            let token = cancel_token.clone();
            async move {
                match token {
                    Some(token) => token.cancelled_owned().await,
                    None => std::future::pending::<()>().await,
                }
            }
        };
        let outcome = tokio::select! {
            biased;
            res = &mut collector => WaitOutcome::Finished(res),
            _ = cancel_arm => WaitOutcome::Aborted("cancel"),
            _ = tokio::time::sleep(Duration::from_secs(effective.seconds)) => WaitOutcome::Aborted("timeout"),
        };
        let (stdout_buf, stderr_buf, stream_err) = match outcome {
            WaitOutcome::Finished(joined) => match joined {
                Ok(collected) => collected,
                Err(join_err) => {
                    return Err(RuntimeError::Docker(format!(
                        "collect task failed: {join_err}"
                    )))
                }
            },
            WaitOutcome::Aborted(reason) => {
                tracing::warn!(
                    target: "timeout",
                    operation = %operation,
                    workspace_id = %workspace_id,
                    reason,
                    "tool exec abort: {}{}",
                    effective.timeout_signature(),
                    correlation.render()
                );
                let abort_frame = b"{\"abort\":true}\n";
                let sent = input.write_all(abort_frame).await.is_ok()
                    && input.flush().await.is_ok();
                let mut reply = if sent {
                    tokio::time::timeout(ABORT_CONFIRM_WAIT, &mut collector)
                        .await
                        .ok()
                } else {
                    None
                };
                if reply.is_none() {
                    // EOF 兜底：关闭写端同样触发容器侧监听。
                    let _ = input.shutdown().await;
                    reply = tokio::time::timeout(ABORT_EOF_WAIT, &mut collector)
                        .await
                        .ok();
                }
                let confirmed = reply.is_some();
                if reason == "timeout" {
                    return Err(RuntimeError::Timeout {
                        detail: format!(
                            "{}{}",
                            effective.timeout_signature(),
                            correlation.render()
                        ),
                    });
                }
                return Err(RuntimeError::Cancelled {
                    detail: format!(
                        "confirmed={confirmed}{}",
                        correlation.render()
                    ),
                    confirmed,
                });
            }
        };
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
            // PLAN-0317 T2.2（决策 #13）：容器确认终止时回 CANCELLED 帧。
            "CANCELLED" => RuntimeError::Cancelled {
                detail: msg,
                confirmed: true,
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

    /// Reclaims expired finished jobs inside an already-materialized
    /// container. Deliberately skips materialization and the activity
    /// timestamp so the periodic maintenance loop cannot keep an idle
    /// workspace active (see PLAN-0317 T1.1).
    pub async fn cleanup_jobs(&self, workspace_id: &str) -> Result<Value> {
        self.exec_oneshot_existing(workspace_id, "cleanup_jobs", Value::Null)
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
mod in_flight_tests {
    use super::*;

    /// PLAN-0317 T2.1：注册后可按 operationItemId 触发终止，且幂等。
    #[test]
    fn request_termination_cancels_registered_execution_idempotently() {
        let registry = InFlightExecutions::new();
        let token = registry.register("item-1");
        assert_eq!(registry.len(), 1);

        assert!(registry.request_termination("item-1"));
        assert!(token.is_cancelled());
        // Repeated requests stay successful and keep the token cancelled.
        assert!(registry.request_termination("item-1"));
        assert!(token.is_cancelled());

        registry.unregister("item-1");
        assert!(registry.is_empty());
        assert!(!registry.request_termination("item-1"));
    }

    /// PLAN-0317 T2.1：未知 key 不误触发、不报错。
    #[test]
    fn request_termination_is_false_for_unknown_item() {
        let registry = InFlightExecutions::new();
        assert!(!registry.request_termination("missing"));
    }

    /// PLAN-0317 T2.1：同一 key 重复注册只保留最新执行，旧执行被取消。
    #[test]
    fn duplicate_registration_replaces_and_cancels_previous() {
        let registry = InFlightExecutions::new();
        let first = registry.register("item-1");
        let second = registry.register("item-1");

        assert_eq!(registry.len(), 1);
        assert!(first.is_cancelled(), "stale execution must be cancelled");
        assert!(!second.is_cancelled());

        assert!(registry.request_termination("item-1"));
        assert!(second.is_cancelled());
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

    /// PLAN-0317 T2.2（决策 #13）：容器回 CANCELLED 帧 → host 映射为已确认取消。
    #[test]
    fn cancelled_sandbox_error_maps_to_confirmed_cancel() {
        match WorkspaceExecutionRouter::map_sandbox_error(
            "CANCELLED",
            "container runtime aborted by host request".to_string(),
        ) {
            RuntimeError::Cancelled { confirmed, detail } => {
                assert!(confirmed);
                assert!(detail.contains("aborted"));
            }
            other => panic!("expected Cancelled, got {other:?}"),
        }
    }
}
