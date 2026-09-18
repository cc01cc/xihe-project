use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

// PLAN-0308 M1: 工具超时的取值与传递统一在 `tool_timeout`（spec S1 三条判断）：
// 生效值由 CP 下发 + 本模块 ENV 覆盖，经 task_local 传入本模块；此处只消费，不做计算。
use crate::tool_timeout;

use bollard::Docker;
use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
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

/// How a registered execution ended (PLAN-0317 T2.3): a cancel request uses the
/// reported value to tell "terminated for sure" from "gave up waiting".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionEnd {
    /// The execution finished on its own before (or despite) the cancel.
    Completed,
    /// Abort sequence ran; `confirmed` is true when the container answered.
    Cancelled { confirmed: bool },
}

struct InFlightEntry {
    workspace_id: String,
    container: String,
    exec_id: Option<String>,
    token: CancellationToken,
    outcome: tokio::sync::watch::Sender<Option<ExecutionEnd>>,
    /// PLAN-0317 T2.9: 未确认终止的条目保留在注册表，供追偿重试；上限后放弃。
    retain_unconfirmed: bool,
    retry_attempts: u32,
}

/// PLAN-0317 T2.9（决策 #14）：追偿成功（或确认执行已结束）的迟到终止，
/// 由宿主回调 CP 追加 `item.terminated.late`。
#[derive(Debug, Clone)]
pub struct LateTermination {
    pub item_id: String,
    pub workspace_id: String,
    pub confirmed: bool,
}

/// 追偿重试上限：超过后放弃并告警（交由容器生命周期兜底）。
const LATE_RETRY_MAX_ATTEMPTS: u32 = 5;

/// Handles returned when an execution registers itself.
pub struct ExecutionRegistration {
    pub token: CancellationToken,
    pub outcome: tokio::sync::watch::Sender<Option<ExecutionEnd>>,
}

/// Host-side registry of executions that are still running, keyed by
/// `operationItemId` (PLAN-0317 T2.1, decision #12 — the same key CP stores in
/// `operation_items.tool_call_id` and forwards as `X-Operation-Item-Id`).
///
/// A cancel request looks the execution up by that key **within its workspace**
/// (decision #13: no cross-workspace termination) and triggers its
/// [`CancellationToken`]; T2.2's abort sequence then reports back through the
/// watch channel.
#[derive(Default)]
pub struct InFlightExecutions {
    inner: StdMutex<HashMap<String, InFlightEntry>>,
}

impl InFlightExecutions {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a running execution. The returned token is cancelled when a
    /// cancel request arrives for the same `item_id`; the exec task reports its
    /// outcome through the returned watch sender.
    pub fn register(&self, workspace_id: &str, item_id: &str) -> ExecutionRegistration {
        let token = CancellationToken::new();
        let (outcome, _rx) = tokio::sync::watch::channel(None);
        let mut map = self.inner.lock().expect("in-flight registry poisoned");
        // A second registration for the same item replaces the previous token;
        // the old execution then becomes unaddressable, which is logged by the
        // caller rather than silently ignored.
        if let Some(previous) = map.insert(
            item_id.to_string(),
            InFlightEntry {
                workspace_id: workspace_id.to_string(),
                container: String::new(),
                exec_id: None,
                token: token.clone(),
                outcome: outcome.clone(),
                retain_unconfirmed: false,
                retry_attempts: 0,
            },
        ) {
            previous.token.cancel();
        }
        ExecutionRegistration { token, outcome }
    }

    /// PLAN-0317 T2.9：登记 exec 句柄（create/start exec 成功后），供追偿检查。
    pub fn attach_exec(&self, item_id: &str, container: &str, exec_id: &str) {
        let mut map = self.inner.lock().expect("in-flight registry poisoned");
        if let Some(entry) = map.get_mut(item_id) {
            entry.container = container.to_string();
            entry.exec_id = Some(exec_id.to_string());
        }
    }

    /// PLAN-0317 T2.9：终止未确认时保留条目（不注销），等待追偿重试。
    pub fn retain_for_retry(&self, item_id: &str) {
        let mut map = self.inner.lock().expect("in-flight registry poisoned");
        if let Some(entry) = map.get_mut(item_id) {
            entry.retain_unconfirmed = true;
        }
    }

    /// Removes an execution once it has finished (any exit path). Unconfirmed
    /// terminations are retained for the late-retry loop instead.
    pub fn unregister(&self, item_id: &str) {
        let mut map = self.inner.lock().expect("in-flight registry poisoned");
        if map
            .get(item_id)
            .is_some_and(|entry| entry.retain_unconfirmed)
        {
            return;
        }
        map.remove(item_id);
    }

    /// Requests termination inside `workspace_id`; `None` when nothing is in
    /// flight for that item in that workspace (callers map this to 404).
    /// Idempotent: repeated requests keep the token cancelled.
    pub fn request_termination(
        &self,
        workspace_id: &str,
        item_id: &str,
    ) -> Option<tokio::sync::watch::Receiver<Option<ExecutionEnd>>> {
        let map = self.inner.lock().expect("in-flight registry poisoned");
        match map.get(item_id) {
            Some(entry) if entry.workspace_id == workspace_id => {
                entry.token.cancel();
                Some(entry.outcome.subscribe())
            }
            _ => None,
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

    /// Executions currently registered for one workspace (cancel-retained entries
    /// included). A pure registry read: no container probe, so counting can never
    /// resurrect a stopped sandbox.
    pub fn count_for_workspace(&self, workspace_id: &str) -> usize {
        self.inner
            .lock()
            .expect("in-flight registry poisoned")
            .values()
            .filter(|entry| entry.workspace_id == workspace_id)
            .count()
    }

    /// PLAN-0317 T2.9（决策 #14）：对未确认终止的保留条目做追偿——通过
    /// `inspect_exec` 判定原执行是否仍在运行：
    ///   * 已结束（或 exec 已消失）→ 视为迟到终止成功，回调 CP；
    ///   * 仍运行 → 计数重试；超过上限则放弃并告警（交由容器生命周期兜底）。
    pub async fn retry_unconfirmed(&self, docker: &Docker) -> Vec<LateTermination> {
        let candidates: Vec<(String, String, String, u32)> = {
            let map = self.inner.lock().expect("in-flight registry poisoned");
            map.iter()
                .filter(|(_, entry)| entry.retain_unconfirmed)
                .filter_map(|(item_id, entry)| {
                    entry.exec_id.as_ref().map(|exec_id| {
                        (
                            item_id.clone(),
                            entry.workspace_id.clone(),
                            exec_id.clone(),
                            entry.retry_attempts,
                        )
                    })
                })
                .collect()
        };
        let mut late = Vec::new();
        for (item_id, workspace_id, exec_id, attempts) in candidates {
            let still_running = match docker.inspect_exec(&exec_id).await {
                Ok(info) => info.running.unwrap_or(false),
                Err(error) => {
                    tracing::debug!(
                        item_id = %item_id,
                        error = %error,
                        "late-termination: exec no longer inspectable, treating as finished"
                    );
                    false
                }
            };
            if still_running {
                let exhausted = {
                    let mut map = self.inner.lock().expect("in-flight registry poisoned");
                    match map.get_mut(&item_id) {
                        Some(entry) => {
                            entry.retry_attempts = attempts + 1;
                            entry.retry_attempts >= LATE_RETRY_MAX_ATTEMPTS
                        }
                        None => false,
                    }
                };
                if exhausted {
                    tracing::warn!(
                        item_id = %item_id,
                        attempts = attempts + 1,
                        "late-termination retries exhausted; leaving termination to container lifecycle"
                    );
                    self.inner
                        .lock()
                        .expect("in-flight registry poisoned")
                        .remove(&item_id);
                }
                continue;
            }
            if let Some(entry) = self
                .inner
                .lock()
                .expect("in-flight registry poisoned")
                .remove(&item_id)
            {
                let _ = entry
                    .outcome
                    .send(Some(ExecutionEnd::Cancelled { confirmed: true }));
            }
            tracing::info!(item_id = %item_id, "late-termination confirmed after unconfirmed cancel");
            late.push(LateTermination {
                item_id,
                workspace_id,
                confirmed: true,
            });
        }
        late
    }
}

/// Removes the in-flight entry on every exit path of an execution.
struct InFlightGuard {
    registry: Arc<InFlightExecutions>,
    item_id: String,
}

/// Per-execution handles kept by the running call (PLAN-0317 T2.1/T2.3).
struct InFlightState {
    item_id: String,
    token: CancellationToken,
    outcome: tokio::sync::watch::Sender<Option<ExecutionEnd>>,
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

    /// PLAN-0317 T2.9：追偿未确认终止；返回需要回调 CP 的迟到终止列表。
    pub async fn retry_unconfirmed_terminations(&self) -> Vec<LateTermination> {
        self.in_flight.retry_unconfirmed(&self.docker).await
    }

    async fn ensure(&self, workspace_id: &str) -> Result<crate::gateway::XiheRuntimeInstance> {
        // PLAN-0344 T1.3（决策 #3）：若本次 ensure 会激活一个暂停容器
        // （M-2 unpause 路径），恢复后把暂停时长计入 job 计时，避免
        // 「解冻即 timeout」的误杀。paused 判定为内存态，不产生额外 exec。
        let was_paused = self.ensurer.workspace_is_paused(workspace_id).await;
        let instance = self
            .ensurer
            .ensure_workspace_materialized(workspace_id)
            .await?;
        if was_paused {
            match self
                .exec_oneshot_existing(workspace_id, "resume_jobs_paused", Value::Null)
                .await
            {
                Ok(value) => {
                    let resumed = value.get("resumed").and_then(|v| v.as_u64()).unwrap_or(0);
                    if resumed > 0 {
                        tracing::info!(
                            workspace_id,
                            resumed,
                            "job pause clock folded back into runtime budget"
                        );
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        workspace_id,
                        error = %error,
                        "job pause clock resume failed; timeout budget keeps wall clock"
                    );
                }
            }
        }
        Ok(instance)
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
        self.exec_oneshot_inner(workspace_id, operation, payload)
            .await
    }

    /// PLAN-0347 T1.1：`SandboxBackend::execute` 的通用入口（operation + payload）。
    /// 沿用既有 per-request exec 语义（ensure → 容器内单帧操作）。
    pub async fn execute_op(
        &self,
        workspace_id: &str,
        operation: &str,
        payload: Value,
    ) -> Result<Value> {
        self.exec_oneshot(workspace_id, operation, payload).await
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
        self.exec_oneshot_inner(workspace_id, operation, payload)
            .await
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
        let in_flight_state = correlation.tool_call_id.as_deref().map(|item_id| {
            let registration = self.in_flight.register(workspace_id, item_id);
            InFlightState {
                item_id: item_id.to_string(),
                token: registration.token.clone(),
                outcome: registration.outcome.clone(),
            }
        });
        let _in_flight_guard = in_flight_state.as_ref().map(|state| InFlightGuard {
            registry: self.in_flight.clone(),
            item_id: state.item_id.clone(),
        });
        let cancel_token = in_flight_state.as_ref().map(|state| state.token.clone());
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
                ));
            }
        };
        // PLAN-0317 T2.9：登记 exec 句柄，供追偿循环检查原执行是否仍在运行。
        if let Some(state) = &in_flight_state {
            self.in_flight
                .attach_exec(&state.item_id, &container_name, &exec.id);
        }
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
                        stdout_buf.extend_from_slice(&message);
                        // xihe-container-runtime --oneshot keeps stdin open so the host can
                        // send an abort frame while the operation is running. A successful
                        // response is nevertheless a single JSON line; waiting for Docker
                        // exec EOF here deadlocks normal operations until the 30s guard fires.
                        // Stop at the first protocol frame and close stdin below.
                        if message.contains(&b'\n') {
                            break;
                        }
                    }
                    Ok(bollard::container::LogOutput::StdErr { message }) => {
                        stderr_buf.extend_from_slice(&message)
                    }
                    Ok(bollard::container::LogOutput::Console { message }) => {
                        stdout_buf.extend_from_slice(&message);
                        if message.contains(&b'\n') {
                            break;
                        }
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
                Ok(collected) => {
                    // The response frame is complete, but the container-side abort monitor
                    // intentionally still owns stdin. Closing the write side lets the
                    // oneshot process exit instead of leaking an attached exec session.
                    let _ = input.shutdown().await;
                    collected
                }
                Err(join_err) => {
                    return Err(RuntimeError::Docker(format!(
                        "collect task failed: {join_err}"
                    )));
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
                let sent =
                    input.write_all(abort_frame).await.is_ok() && input.flush().await.is_ok();
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
                if let Some(state) = &in_flight_state {
                    let _ = state
                        .outcome
                        .send(Some(ExecutionEnd::Cancelled { confirmed }));
                    if !confirmed {
                        // PLAN-0317 T2.9（决策 #14）：未确认终止保留条目供追偿。
                        self.in_flight.retain_for_retry(&state.item_id);
                    }
                }
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
                    detail: format!("confirmed={confirmed}{}", correlation.render()),
                    confirmed,
                });
            }
        };
        if let Some(state) = &in_flight_state {
            let _ = state.outcome.send(Some(ExecutionEnd::Completed));
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

    pub async fn apply_patch(&self, workspace_id: &str, patches: Value) -> Result<Value> {
        let payload = serde_json::json!({"patches": patches});
        self.exec_oneshot(workspace_id, "apply_patch", payload)
            .await
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
        timeout_secs: Option<u64>,
    ) -> Result<String> {
        let mut payload =
            serde_json::json!({"workspaceId": workspace_id, "command": command, "args": args});
        // PLAN-0317 T3.3：把工具面的 timeout 落实为任务运行时限（容器侧 None→默认 60 分钟）。
        if let Some(timeout_secs) = timeout_secs {
            payload["timeoutSecs"] = serde_json::json!(timeout_secs);
        }
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

    /// PLAN-0344 T1.3：容器暂停前给运行中 job 打暂停标记（容器仍可 exec）。
    pub async fn mark_jobs_paused(&self, workspace_id: &str) -> Result<Value> {
        self.exec_oneshot_existing(workspace_id, "mark_jobs_paused", Value::Null)
            .await
    }

    /// PLAN-0344 T1.3：destroy 前枚举仍存活（status=running）的 jobId。
    /// 走 existing 通道：不触发 materialize / 活动时间刷新，也不受 destroying
    /// 闸门影响（容器尚在，最后一次读账）。
    pub async fn list_running_job_ids(&self, workspace_id: &str) -> Result<Vec<String>> {
        let value = self
            .exec_oneshot_existing(workspace_id, "list_background_processes", Value::Null)
            .await?;
        let ids = value
            .get("jobs")
            .and_then(|jobs| jobs.as_array())
            .map(|jobs| {
                jobs.iter()
                    .filter(|job| {
                        job.get("status").and_then(|status| status.as_str()) == Some("running")
                    })
                    .filter_map(|job| {
                        job.get("jobId")
                            .and_then(|job_id| job_id.as_str())
                            .map(str::to_string)
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(ids)
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

    /// PLAN-0344 T1.2：CP 续看端点的结构化 job 输出分页（字节游标 / UTF-8 安全）。
    pub async fn read_job_output(
        &self,
        workspace_id: &str,
        job_id: &str,
        stream: &str,
        offset: Option<usize>,
        limit: Option<usize>,
    ) -> Result<Value> {
        let payload = serde_json::json!({
            "workspaceId": workspace_id,
            "jobId": job_id,
            "stream": stream,
            "offset": offset,
            "limit": limit,
        });
        self.exec_oneshot(workspace_id, "read_job_output", payload)
            .await
    }
}

#[cfg(test)]
mod in_flight_tests {
    use super::*;

    /// PLAN-0317 T2.1/T2.3：注册后可按 (workspace, operationItemId) 触发终止，
    /// 且幂等；执行侧通过 outcome 通道回报终局。
    #[test]
    fn request_termination_cancels_registered_execution_idempotently() {
        let registry = InFlightExecutions::new();
        let registration = registry.register("ws-1", "item-1");
        assert_eq!(registry.len(), 1);

        let mut outcome = registry
            .request_termination("ws-1", "item-1")
            .expect("registered execution must be found");
        assert!(registration.token.is_cancelled());
        // Repeated requests stay successful and keep the token cancelled.
        assert!(registry.request_termination("ws-1", "item-1").is_some());
        assert!(registration.token.is_cancelled());

        registration
            .outcome
            .send(Some(ExecutionEnd::Cancelled { confirmed: true }))
            .expect("outcome receiver alive");
        assert_eq!(
            *outcome.borrow_and_update(),
            Some(ExecutionEnd::Cancelled { confirmed: true })
        );

        registry.unregister("item-1");
        assert!(registry.is_empty());
        assert!(registry.request_termination("ws-1", "item-1").is_none());
    }

    /// PLAN-0317 T2.3（spec S1.6）：不得跨 workspace 终止执行。
    #[test]
    fn request_termination_rejects_cross_workspace_item() {
        let registry = InFlightExecutions::new();
        let registration = registry.register("ws-1", "item-1");

        assert!(
            registry.request_termination("ws-2", "item-1").is_none(),
            "another workspace must not be able to cancel this execution"
        );
        assert!(!registration.token.is_cancelled());
    }

    /// PLAN-0317 T2.1：同一 key 重复注册只保留最新执行，旧执行被取消。
    #[test]
    fn duplicate_registration_replaces_and_cancels_previous() {
        let registry = InFlightExecutions::new();
        let first = registry.register("ws-1", "item-1");
        let second = registry.register("ws-1", "item-1");

        assert_eq!(registry.len(), 1);
        assert!(
            first.token.is_cancelled(),
            "stale execution must be cancelled"
        );
        assert!(!second.token.is_cancelled());

        assert!(registry.request_termination("ws-1", "item-1").is_some());
        assert!(second.token.is_cancelled());
    }

    /// PLAN-0317 T2.1：未知 key 不误触发、不报错。
    #[test]
    fn request_termination_is_none_for_unknown_item() {
        let registry = InFlightExecutions::new();
        assert!(registry.request_termination("ws-1", "missing").is_none());
    }

    /// PLAN-0317 T2.9（决策 #14）：未确认终止的条目保留在注册表供追偿重试。
    #[test]
    fn unconfirmed_termination_is_retained_for_retry() {
        let registry = InFlightExecutions::new();
        let _registration = registry.register("ws-1", "item-1");
        registry.attach_exec("item-1", "container-1", "exec-1");

        registry.retain_for_retry("item-1");
        registry.unregister("item-1");

        assert_eq!(
            registry.len(),
            1,
            "unconfirmed termination must be retained"
        );
    }

    /// PLAN-0317 T2.9：正常结束（未标记保留）照常注销。
    #[test]
    fn completed_execution_is_unregistered() {
        let registry = InFlightExecutions::new();
        let _registration = registry.register("ws-1", "item-1");

        registry.unregister("item-1");

        assert!(registry.is_empty());
    }

    /// 在途执行探针只统计本 workspace，不跨 workspace、不触发容器探测。
    #[test]
    fn count_for_workspace_is_scoped_and_tracks_unregister() {
        let registry = InFlightExecutions::new();
        let first = registry.register("ws-1", "item-1");
        let second = registry.register("ws-1", "item-2");
        let _other = registry.register("ws-2", "item-3");

        assert_eq!(registry.count_for_workspace("ws-1"), 2);
        assert_eq!(registry.count_for_workspace("ws-2"), 1);
        assert_eq!(registry.count_for_workspace("ws-3"), 0);

        registry.unregister("item-1");
        assert_eq!(registry.count_for_workspace("ws-1"), 1);
        // Cancel-retained entries still count as live jobs.
        registry.retain_for_retry("item-2");
        registry.unregister("item-2");
        assert_eq!(registry.count_for_workspace("ws-1"), 1);
        drop((first, second));
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
