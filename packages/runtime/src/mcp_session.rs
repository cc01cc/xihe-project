//! PLAN-0347 T1.3：stdio MCP 会话承载（`exec attach` 直连，替代容器内 HTTP bridge）。
//!
//! 规范：`plans/PLAN-0347-XH-backend-seam-bridge/spec/session-lifecycle.md`。
//! 要点：`(workspace, serverId)` 一条会话；非 TTY；换行分隔 JSON-RPC；v1 FIFO 单飞；
//! 预算 3 次 + 退避 1/5/15s + 冷却 5 分钟（半开）；终止用容器内 `ps` 固定串匹配 + kill
//! （`inspect_exec` 的 pid 属宿主命名空间，不可用；EOF 不保证退出，见决策 #18）。

use std::collections::{HashMap, VecDeque};
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bollard::Docker;
use bollard::container::LogOutput;
use bollard::errors::Error as BollardError;
use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::{RwLock, mpsc, oneshot};
use tokio_stream::StreamExt;
use tracing::{info, warn};

use crate::backend::Capability;
use crate::error::{Result, RuntimeError};

/// 双向帧上限（spec §5）。
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
/// 配置轮询周期（沿用 30s，CHN-2 语义）。
pub const CONFIG_POLL_INTERVAL: Duration = Duration::from_secs(30);
/// 会话层读超时兜底；调用方（CP/Agent）工具等待值优先。
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(600);
/// 同一故障周期最多重启次数（决策 #8）。
pub const RESTART_BUDGET: u32 = 3;
/// 退避阶梯（决策 #8）。
pub const BACKOFF_SECS: [u64; 3] = [1, 5, 15];
/// 预算耗尽后的冷却窗口（决策 #8）。
pub const FAILURE_COOLDOWN: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStateKind {
    Starting,
    Ready,
    Restarting,
    Failed,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub server_id: String,
    pub state: SessionStateKind,
    pub attempt: u32,
    pub last_error: Option<String>,
    /// 进入当前状态的时间（Unix 毫秒）。
    pub since_ms: u64,
    pub epoch: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StdioServerSpec {
    pub server_id: String,
    pub command: String,
    pub args: Vec<String>,
    /// CP 配置 hash（变化视为新故障周期并重建会话）。
    pub spec_hash: String,
}

/// CP stdio 配置拉取：`Err` 与「空配置」必须可区分（CHN-2），调用方在错误时保留现有会话。
pub async fn fetch_stdio_specs(
    cp_url: &str,
    api_token: &str,
    workspace_id: &str,
) -> std::result::Result<(String, Vec<StdioServerSpec>), String> {
    let url = format!("{cp_url}/internal/v1/workspaces/{workspace_id}/stdio-servers");
    let resp = reqwest::Client::new()
        .get(&url)
        .bearer_auth(api_token)
        .send()
        .await
        .map_err(|error| format!("stdio-servers request failed: {error}"))?;
    if !resp.status().is_success() {
        return Err(format!("stdio-servers returned {}", resp.status()));
    }
    let config = resp
        .json::<Value>()
        .await
        .map_err(|error| format!("failed to parse stdio-servers: {error}"))?;
    let hash = config
        .get("hash")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let mut specs = Vec::new();
    if let Some(servers) = config.get("servers").and_then(Value::as_array) {
        for server in servers {
            let server_id = server.get("name").and_then(Value::as_str).unwrap_or("");
            if server_id.is_empty() {
                continue;
            }
            let config_obj = server.get("config");
            let command = config_obj
                .and_then(|c| c.get("command"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if command.is_empty() {
                continue;
            }
            let args: Vec<String> = config_obj
                .and_then(|c| c.get("args"))
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|value| value.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            specs.push(StdioServerSpec {
                server_id: server_id.to_string(),
                command: command.to_string(),
                args,
                spec_hash: hash.clone(),
            });
        }
    }
    Ok((hash, specs))
}

/// 纯重启策略：预算 / 退避 / 冷却（决策 #8），可单测。
#[derive(Debug, Default, Clone)]
pub struct RestartPolicy {
    attempt: u32,
    failed_since: Option<Instant>,
}

#[derive(Debug, PartialEq)]
pub enum PolicyOutcome {
    RetryIn(Duration),
    /// 预算耗尽：进入 Failed，冷却 5 分钟（半开）。
    Exhausted,
}

impl RestartPolicy {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn attempt(&self) -> u32 {
        self.attempt
    }

    pub fn on_success(&mut self) {
        self.attempt = 0;
        self.failed_since = None;
    }

    pub fn on_failure(&mut self) -> PolicyOutcome {
        self.attempt = self.attempt.saturating_add(1);
        if self.attempt > RESTART_BUDGET {
            self.failed_since = Some(Instant::now());
            PolicyOutcome::Exhausted
        } else {
            let index = (self.attempt as usize - 1).min(BACKOFF_SECS.len() - 1);
            PolicyOutcome::RetryIn(Duration::from_secs(BACKOFF_SECS[index]))
        }
    }

    /// 冷却结束后的下一次触发开启新一轮预算（半开）。
    pub fn cooldown_elapsed(&self) -> bool {
        self.failed_since
            .map(|since| since.elapsed() >= FAILURE_COOLDOWN)
            .unwrap_or(true)
    }

    pub fn reset_for_half_open(&mut self) {
        self.attempt = 0;
        self.failed_since = None;
    }
}

/// 从缓冲中切出完整行（含边界处理）；调用方负责上限判定。
pub fn split_complete_lines(buf: &mut Vec<u8>) -> Vec<Vec<u8>> {
    let mut lines = Vec::new();
    while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
        let mut line: Vec<u8> = buf.drain(..=pos).collect();
        line.pop(); // 去掉 '\n'
        lines.push(line);
    }
    lines
}

/// 容器内终止命令（固定串匹配，marker 经位置参数传入，避免注入与正则误伤）。
pub fn kill_command(marker: &str, force: bool) -> Vec<String> {
    let signal = if force { "-9" } else { "" };
    vec![
        "sh".to_string(),
        "-c".to_string(),
        format!(
            "ps -eo pid,args | grep -F -- \"$1\" | grep -v grep | awk '{{print $1}}' | xargs -r kill {signal}"
        ),
        "sh".to_string(),
        marker.to_string(),
    ]
}

pub fn process_marker(spec: &StdioServerSpec) -> String {
    let mut marker = spec.command.clone();
    for arg in &spec.args {
        marker.push(' ');
        marker.push_str(arg);
    }
    marker
}

enum Command {
    Request {
        frame: Vec<u8>,
        deadline: Instant,
        respond: oneshot::Sender<Result<Value>>,
    },
    Shutdown {
        respond: oneshot::Sender<()>,
    },
}

#[derive(Clone)]
struct SessionHandle {
    tx: mpsc::UnboundedSender<Command>,
    snapshot: Arc<RwLock<SessionSnapshot>>,
    spec_hash: String,
}

/// 宿主侧会话管理器：`(workspace, serverId)` 一条会话，多调用者共享（决策 #20）。
pub struct McpSessionManager {
    docker: Docker,
    sessions: RwLock<HashMap<(String, String), SessionHandle>>,
    /// CP 期望配置（reconcile 写入；调用路径在缓存未命中时惰性补齐）。
    specs: RwLock<HashMap<(String, String), StdioServerSpec>>,
    capability: Arc<RwLock<Capability>>,
}

impl McpSessionManager {
    pub fn new() -> Result<Self> {
        let docker = Docker::connect_with_local_defaults().map_err(|error| {
            RuntimeError::Docker(format!("session manager docker connect: {error}"))
        })?;
        Ok(Self {
            docker,
            sessions: RwLock::new(HashMap::new()),
            specs: RwLock::new(HashMap::new()),
            capability: Arc::new(RwLock::new(Capability::declared())),
        })
    }

    /// 当前缓存的会话规格（调用路径惰性补齐用）。
    pub async fn spec(&self, workspace_id: &str, server_id: &str) -> Option<StdioServerSpec> {
        self.specs
            .read()
            .await
            .get(&(workspace_id.to_string(), server_id.to_string()))
            .cloned()
    }

    /// 用 CP 期望配置对账本地 spec 表；返回需停止的 server（被删除或 spec hash 变化的）。
    pub async fn reconcile_specs(
        &self,
        workspace_id: &str,
        specs: Vec<StdioServerSpec>,
    ) -> Vec<String> {
        let mut store = self.specs.write().await;
        let mut to_stop = Vec::new();
        let desired: std::collections::HashSet<&str> =
            specs.iter().map(|spec| spec.server_id.as_str()).collect();
        let stale: Vec<(String, String)> = store
            .iter()
            .filter(|((ws, _), _)| ws == workspace_id)
            .filter(|((_, sid), existing)| {
                !desired.contains(sid.as_str())
                    || specs
                        .iter()
                        .any(|spec| spec.server_id == *sid && spec.spec_hash != existing.spec_hash)
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in stale {
            store.remove(&key);
            to_stop.push(key.1);
        }
        for spec in specs {
            store.insert((workspace_id.to_string(), spec.server_id.clone()), spec);
        }
        to_stop
    }

    /// `session` 能力观测：首次成功 attach → probed ok；create/start 失败 → probed false + reason。
    pub async fn capability(&self) -> Capability {
        self.capability.read().await.clone()
    }

    /// 发送一帧并等待其响应（同 key FIFO 单飞；排队等待受 deadline 约束）。
    pub async fn request(
        &self,
        workspace_id: &str,
        spec: &StdioServerSpec,
        frame: Vec<u8>,
        timeout: Duration,
    ) -> Result<Value> {
        if frame.len() + 1 > MAX_FRAME_BYTES {
            return Err(RuntimeError::McpSessionBusy {
                workspace_id: workspace_id.to_string(),
                server_id: spec.server_id.clone(),
                detail: format!("request frame exceeds {MAX_FRAME_BYTES} bytes"),
            });
        }
        let handle = self.ensure_session(workspace_id, spec).await;
        let deadline = Instant::now() + timeout;
        let (respond, wait) = oneshot::channel();
        handle
            .tx
            .send(Command::Request {
                frame,
                deadline,
                respond,
            })
            .map_err(|_| RuntimeError::McpSessionUnavailable {
                workspace_id: workspace_id.to_string(),
                server_id: spec.server_id.clone(),
                detail: "session driver stopped".to_string(),
            })?;
        match tokio::time::timeout(timeout, wait).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(RuntimeError::McpSessionUnavailable {
                workspace_id: workspace_id.to_string(),
                server_id: spec.server_id.clone(),
                detail: "session driver dropped request".to_string(),
            }),
            Err(_) => Err(RuntimeError::McpSessionBusy {
                workspace_id: workspace_id.to_string(),
                server_id: spec.server_id.clone(),
                detail: "request timed out while queued/running".to_string(),
            }),
        }
    }

    /// 状态快照（spec §6 查询路由的数据源；只读宿主注册表）。
    pub async fn servers(&self, workspace_id: &str) -> Vec<SessionSnapshot> {
        let sessions = self.sessions.read().await;
        let mut snapshots = Vec::new();
        for ((ws, _), handle) in sessions.iter() {
            if ws == workspace_id {
                snapshots.push(handle.snapshot.read().await.clone());
            }
        }
        snapshots.sort_by(|a, b| a.server_id.cmp(&b.server_id));
        snapshots
    }

    /// 停止单个会话（配置删除路径）。
    pub async fn stop_server(&self, workspace_id: &str, server_id: &str) {
        let handle = self
            .sessions
            .write()
            .await
            .remove(&(workspace_id.to_string(), server_id.to_string()));
        if let Some(handle) = handle {
            let (respond, wait) = oneshot::channel();
            if handle.tx.send(Command::Shutdown { respond }).is_ok() {
                let _ = tokio::time::timeout(Duration::from_secs(5), wait).await;
            }
            info!(
                workspace_id,
                server_id, "mcp session stopped (config removed)"
            );
        }
    }

    /// 容器重建/evict/destroy 路径：清空该 workspace 的全部会话（缺口 A/C 修复）。
    pub async fn cleanup_workspace(&self, workspace_id: &str) {
        let handles: Vec<(String, SessionHandle)> = {
            let mut sessions = self.sessions.write().await;
            let keys: Vec<_> = sessions
                .keys()
                .filter(|(ws, _)| ws == workspace_id)
                .cloned()
                .collect();
            keys.into_iter()
                .filter_map(|key| sessions.remove(&key).map(|handle| (key.1, handle)))
                .collect()
        };
        for (server_id, handle) in handles {
            let (respond, wait) = oneshot::channel();
            if handle.tx.send(Command::Shutdown { respond }).is_ok() {
                let _ = tokio::time::timeout(Duration::from_secs(5), wait).await;
            }
            info!(
                workspace_id,
                server_id, "mcp session cleaned up with workspace"
            );
        }
    }

    /// 进程退出前的统一清理（优雅关闭路径）。
    pub async fn shutdown_all(&self) {
        let handles: Vec<SessionHandle> = {
            let mut sessions = self.sessions.write().await;
            sessions.drain().map(|(_, handle)| handle).collect()
        };
        for handle in handles {
            let (respond, wait) = oneshot::channel();
            if handle.tx.send(Command::Shutdown { respond }).is_ok() {
                let _ = tokio::time::timeout(Duration::from_secs(5), wait).await;
            }
        }
    }

    async fn ensure_session(&self, workspace_id: &str, spec: &StdioServerSpec) -> SessionHandle {
        // Keep the expected-spec table current even on the direct request path
        // (config reconcile prunes/rebuilds from this table).
        self.specs.write().await.insert(
            (workspace_id.to_string(), spec.server_id.clone()),
            spec.clone(),
        );
        let key = (workspace_id.to_string(), spec.server_id.clone());
        // 命中且 spec 未变 → 复用（hash 变化视为新周期，重建）。
        {
            let sessions = self.sessions.read().await;
            if let Some(handle) = sessions.get(&key)
                && handle.spec_hash == spec.spec_hash
                && handle.snapshot.read().await.state != SessionStateKind::Stopped
            {
                return handle.clone();
            }
        }
        let mut sessions = self.sessions.write().await;
        if let Some(handle) = sessions.get(&key)
            && handle.spec_hash == spec.spec_hash
        {
            return handle.clone();
        }
        if let Some(handle) = sessions.remove(&key) {
            let (respond, _wait) = oneshot::channel();
            let _ = handle.tx.send(Command::Shutdown { respond });
        }
        let epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let snapshot = Arc::new(RwLock::new(SessionSnapshot {
            server_id: spec.server_id.clone(),
            state: SessionStateKind::Starting,
            attempt: 0,
            last_error: None,
            since_ms: epoch,
            epoch,
        }));
        let (tx, rx) = mpsc::unbounded_channel();
        let driver = SessionDriver {
            docker: self.docker.clone(),
            workspace_id: workspace_id.to_string(),
            spec: spec.clone(),
            cmd_rx: rx,
            snapshot: snapshot.clone(),
            capability: self.capability.clone(),
            epoch,
            policy: RestartPolicy::new(),
            running: None,
            cancelled: false,
        };
        tokio::spawn(driver.run());
        let handle = SessionHandle {
            tx,
            snapshot,
            spec_hash: spec.spec_hash.clone(),
        };
        sessions.insert(key, handle.clone());
        info!(
            workspace_id,
            server_id = %spec.server_id,
            epoch,
            "mcp session created"
        );
        handle
    }
}

#[derive(Debug)]
enum LineEvent {
    Line(Vec<u8>),
    Closed(Option<String>),
}

struct Running {
    exec_id: String,
    input: Pin<Box<dyn AsyncWrite + Send>>,
    line_rx: mpsc::UnboundedReceiver<LineEvent>,
    pending_lines: VecDeque<Vec<u8>>,
}

struct SessionDriver {
    docker: Docker,
    workspace_id: String,
    spec: StdioServerSpec,
    cmd_rx: mpsc::UnboundedReceiver<Command>,
    snapshot: Arc<RwLock<SessionSnapshot>>,
    capability: Arc<RwLock<Capability>>,
    epoch: u64,
    policy: RestartPolicy,
    running: Option<Running>,
    cancelled: bool,
}

impl SessionDriver {
    async fn run(mut self) {
        loop {
            if self.cancelled {
                break;
            }
            match self.cmd_rx.recv().await {
                None => break,
                Some(Command::Shutdown { respond }) => {
                    self.terminate().await;
                    self.set_state(SessionStateKind::Stopped, None).await;
                    let _ = respond.send(());
                    break;
                }
                Some(Command::Request {
                    frame,
                    deadline,
                    respond,
                }) => {
                    if Instant::now() >= deadline {
                        let _ = respond.send(Err(RuntimeError::McpSessionBusy {
                            workspace_id: self.workspace_id.clone(),
                            server_id: self.spec.server_id.clone(),
                            detail: "request expired while queued".to_string(),
                        }));
                        continue;
                    }
                    if let Err(error) = self.ensure_ready().await {
                        let _ = respond.send(Err(error));
                        continue;
                    }
                    let result = self.roundtrip(&frame, deadline).await;
                    match result {
                        Ok(value) => {
                            self.policy.on_success();
                            let _ = respond.send(Ok(value));
                        }
                        Err(error) => {
                            self.record_failure(&error.to_string()).await;
                            let _ = respond.send(Err(error));
                        }
                    }
                }
            }
        }
    }

    /// 就绪保障：无进程则按预算重启；Failed 且冷却结束则半开重试一轮。
    async fn ensure_ready(&mut self) -> Result<()> {
        if let Some(running) = self.running.as_mut() {
            if !running.line_rx.is_closed() || !running.pending_lines.is_empty() {
                return Ok(());
            }
            // 读通道已关闭：进程已退出。
            self.record_failure("mcp server process exited").await;
        }
        let failed_without_cooldown = self.snapshot.read().await.state == SessionStateKind::Failed
            && !self.policy.cooldown_elapsed();
        if failed_without_cooldown {
            let reason = self.last_error().await;
            return Err(RuntimeError::McpSessionFailed {
                workspace_id: self.workspace_id.clone(),
                server_id: self.spec.server_id.clone(),
                reason,
            });
        }
        if self.policy.cooldown_elapsed() && self.policy.attempt() > RESTART_BUDGET {
            self.policy.reset_for_half_open();
        }
        // 预算内立即重试（退避 1/5/15s）。
        loop {
            match self.start_process().await {
                Ok(()) => {
                    self.policy.on_success();
                    self.set_state(SessionStateKind::Ready, None).await;
                    return Ok(());
                }
                Err(reason) => match self.policy.on_failure() {
                    PolicyOutcome::RetryIn(delay) => {
                        self.set_state(SessionStateKind::Restarting, Some(reason.clone()))
                            .await;
                        tokio::time::sleep(delay).await;
                    }
                    PolicyOutcome::Exhausted => {
                        self.terminate().await;
                        self.set_state(SessionStateKind::Failed, Some(reason.clone()))
                            .await;
                        return Err(RuntimeError::McpSessionFailed {
                            workspace_id: self.workspace_id.clone(),
                            server_id: self.spec.server_id.clone(),
                            reason,
                        });
                    }
                },
            }
        }
    }

    async fn last_error(&mut self) -> String {
        self.snapshot
            .read()
            .await
            .last_error
            .clone()
            .unwrap_or_else(|| "mcp session failed".to_string())
    }

    async fn record_failure(&mut self, reason: &str) {
        self.terminate().await;
        match self.policy.on_failure() {
            PolicyOutcome::RetryIn(_) => {
                self.set_state(SessionStateKind::Restarting, Some(reason.to_string()))
                    .await;
            }
            PolicyOutcome::Exhausted => {
                self.set_state(SessionStateKind::Failed, Some(reason.to_string()))
                    .await;
            }
        }
    }

    async fn start_process(&mut self) -> std::result::Result<(), String> {
        let container = crate::workspace::container_name(&self.workspace_id);
        let mut cmd = Vec::with_capacity(self.spec.args.len() + 1);
        cmd.push(self.spec.command.clone());
        cmd.extend(self.spec.args.iter().cloned());
        let marker = format!(
            "XIHE_MCP_SESSION={}:{}:{}",
            self.workspace_id, self.spec.server_id, self.epoch
        );
        let exec = self
            .docker
            .create_exec(
                &container,
                CreateExecOptions {
                    attach_stdin: Some(true),
                    attach_stdout: Some(true),
                    attach_stderr: Some(true),
                    tty: Some(false),
                    cmd: Some(cmd),
                    env: Some(vec![marker]),
                    ..Default::default()
                },
            )
            .await
            .map_err(|error| {
                self.capability_failed(format!("create_exec failed: {error}"));
                format!("create_exec failed: {error}")
            })?;
        let started = self
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
            .map_err(|error| {
                self.capability_failed(format!("start_exec failed: {error}"));
                format!("start_exec failed: {error}")
            })?;
        let (output, input) = match started {
            StartExecResults::Attached { output, input } => (output, input),
            StartExecResults::Detached => return Err("exec unexpectedly detached".to_string()),
        };
        self.capability_ok().await;
        let (line_tx, line_rx) = mpsc::unbounded_channel();
        tokio::spawn(reader_task(output, line_tx));
        self.running = Some(Running {
            exec_id: exec.id,
            input,
            line_rx,
            pending_lines: VecDeque::new(),
        });
        info!(
            workspace_id = %self.workspace_id,
            server_id = %self.spec.server_id,
            "mcp session process started"
        );
        Ok(())
    }

    async fn roundtrip(&mut self, frame: &[u8], deadline: Instant) -> Result<Value> {
        let request_id = serde_json::from_slice::<Value>(frame)
            .ok()
            .and_then(|value| value.get("id").cloned());
        let Some(running) = self.running.as_mut() else {
            return Err(RuntimeError::McpSessionUnavailable {
                workspace_id: self.workspace_id.clone(),
                server_id: self.spec.server_id.clone(),
                detail: "session process not running".to_string(),
            });
        };
        let mut bytes = frame.to_vec();
        if bytes.last() != Some(&b'\n') {
            bytes.push(b'\n');
        }
        running
            .input
            .write_all(&bytes)
            .await
            .map_err(|error| RuntimeError::McpSessionFailed {
                workspace_id: self.workspace_id.clone(),
                server_id: self.spec.server_id.clone(),
                reason: format!("write failed: {error}"),
            })?;
        running
            .input
            .flush()
            .await
            .map_err(|error| RuntimeError::McpSessionFailed {
                workspace_id: self.workspace_id.clone(),
                server_id: self.spec.server_id.clone(),
                reason: format!("flush failed: {error}"),
            })?;

        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(RuntimeError::McpSessionBusy {
                    workspace_id: self.workspace_id.clone(),
                    server_id: self.spec.server_id.clone(),
                    detail: "response wait exceeded deadline".to_string(),
                });
            }
            while let Some(line) = running.pending_lines.pop_front() {
                if let Some(value) = match_response(&line, request_id.as_ref()) {
                    return Ok(value);
                }
            }
            match tokio::time::timeout(remaining, running.line_rx.recv()).await {
                Err(_) => {
                    return Err(RuntimeError::McpSessionBusy {
                        workspace_id: self.workspace_id.clone(),
                        server_id: self.spec.server_id.clone(),
                        detail: "response timeout".to_string(),
                    });
                }
                Ok(None) => {
                    return Err(RuntimeError::McpSessionFailed {
                        workspace_id: self.workspace_id.clone(),
                        server_id: self.spec.server_id.clone(),
                        reason: "session stream closed".to_string(),
                    });
                }
                Ok(Some(LineEvent::Closed(reason))) => {
                    return Err(RuntimeError::McpSessionFailed {
                        workspace_id: self.workspace_id.clone(),
                        server_id: self.spec.server_id.clone(),
                        reason: reason.unwrap_or_else(|| "session stream closed".to_string()),
                    });
                }
                Ok(Some(LineEvent::Line(line))) => {
                    if let Some(value) = match_response(&line, request_id.as_ref()) {
                        return Ok(value);
                    }
                    // 无 id 通知 / 非匹配响应：旁路记录，不计入响应（spec §5）。
                    warn!(
                        workspace_id = %self.workspace_id,
                        server_id = %self.spec.server_id,
                        frame = %String::from_utf8_lossy(&line),
                        "mcp session unsolicited frame ignored"
                    );
                }
            }
        }
    }

    /// 终止进程：优先 EOF，随后容器内 ps 固定串 kill（决策 #18）。
    async fn terminate(&mut self) {
        let Some(mut running) = self.running.take() else {
            return;
        };
        let _ = running.input.shutdown().await;
        let marker = process_marker(&self.spec);
        let container = crate::workspace::container_name(&self.workspace_id);
        for force in [false, true] {
            if !exec_running(&self.docker, &running.exec_id).await {
                break;
            }
            if let Err(error) = run_kill(&self.docker, &container, &marker, force).await {
                warn!(
                    workspace_id = %self.workspace_id,
                    server_id = %self.spec.server_id,
                    error = %error,
                    "mcp session kill command failed"
                );
                break;
            }
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                if !exec_running(&self.docker, &running.exec_id).await {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    }

    async fn capability_ok(&mut self) {
        *self.capability.write().await = Capability::probed_ok();
    }

    fn capability_failed(&self, reason: String) {
        if let Ok(mut capability) = self.capability.try_write() {
            *capability = Capability {
                declared: true,
                probed: Some(false),
                reason: Some(reason),
            };
        }
    }

    async fn set_state(&mut self, state: SessionStateKind, error: Option<String>) {
        let mut snapshot = self.snapshot.write().await;
        if snapshot.state != state || error.is_some() {
            info!(
                workspace_id = %self.workspace_id,
                server_id = %snapshot.server_id,
                from = ?snapshot.state,
                to = ?state,
                reason = error.as_deref().unwrap_or(""),
                "mcp_session_transition"
            );
        }
        snapshot.state = state;
        if let Some(error) = error {
            snapshot.last_error = Some(error);
        } else if state == SessionStateKind::Ready {
            snapshot.last_error = None;
        }
        snapshot.attempt = self.policy.attempt();
        snapshot.since_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(snapshot.since_ms);
    }
}

async fn exec_running(docker: &Docker, exec_id: &str) -> bool {
    docker
        .inspect_exec(exec_id)
        .await
        .map(|info| info.running.unwrap_or(false))
        .unwrap_or(false)
}

async fn run_kill(docker: &Docker, container: &str, marker: &str, force: bool) -> Result<()> {
    let exec = docker
        .create_exec(
            container,
            CreateExecOptions {
                cmd: Some(kill_command(marker, force)),
                ..Default::default()
            },
        )
        .await
        .map_err(|error| RuntimeError::Docker(format!("create kill exec: {error}")))?;
    let _ = docker
        .start_exec(
            &exec.id,
            Some(StartExecOptions {
                detach: true,
                ..Default::default()
            }),
        )
        .await;
    Ok(())
}

async fn reader_task(
    mut output: Pin<
        Box<dyn tokio_stream::Stream<Item = std::result::Result<LogOutput, BollardError>> + Send>,
    >,
    tx: mpsc::UnboundedSender<LineEvent>,
) {
    let mut stdout_buf: Vec<u8> = Vec::new();
    while let Some(item) = output.next().await {
        match item {
            Ok(LogOutput::StdOut { message }) | Ok(LogOutput::Console { message }) => {
                stdout_buf.extend_from_slice(&message);
                if stdout_buf.len() > MAX_FRAME_BYTES {
                    let _ = tx.send(LineEvent::Closed(Some(format!(
                        "frame exceeds {MAX_FRAME_BYTES} bytes"
                    ))));
                    return;
                }
                for line in split_complete_lines(&mut stdout_buf) {
                    if tx.send(LineEvent::Line(line)).is_err() {
                        return;
                    }
                }
            }
            Ok(LogOutput::StdErr { message }) => {
                warn!(
                    frame = %crate::log_redact::redact_text(&String::from_utf8_lossy(&message)),
                    "mcp session stderr"
                );
            }
            Ok(_) => {}
            Err(error) => {
                let _ = tx.send(LineEvent::Closed(Some(format!("stream error: {error}"))));
                return;
            }
        }
    }
    let _ = tx.send(LineEvent::Closed(None));
}

/// 响应配对：仅当帧含 `id` 且与请求 id 一致时视为响应；无 id（通知）不计数。
pub fn match_response(line: &[u8], request_id: Option<&Value>) -> Option<Value> {
    let value = serde_json::from_slice::<Value>(line).ok()?;
    let response_id = value.get("id")?;
    if request_id.is_some_and(|id| id != response_id) {
        return None;
    }
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_policy_backoff_then_cooldown_half_open() {
        let mut policy = RestartPolicy::new();
        assert_eq!(policy.attempt(), 0);
        assert_eq!(
            policy.on_failure(),
            PolicyOutcome::RetryIn(Duration::from_secs(1))
        );
        assert_eq!(
            policy.on_failure(),
            PolicyOutcome::RetryIn(Duration::from_secs(5))
        );
        assert_eq!(
            policy.on_failure(),
            PolicyOutcome::RetryIn(Duration::from_secs(15))
        );
        assert_eq!(policy.on_failure(), PolicyOutcome::Exhausted);
        assert_eq!(policy.attempt(), 4, "budget exhausted after 4 failures");
        assert!(!policy.cooldown_elapsed());
        policy.reset_for_half_open();
        assert_eq!(policy.attempt(), 0);
        assert!(policy.cooldown_elapsed());
        policy.on_success();
        assert_eq!(policy.attempt(), 0);
    }

    #[test]
    fn split_lines_handles_partial_and_batched_frames() {
        let mut buf = b"{\"id\":1}\n{\"id\":2}".to_vec();
        let lines = split_complete_lines(&mut buf);
        assert_eq!(lines, vec![b"{\"id\":1}".to_vec()]);
        assert_eq!(buf, b"{\"id\":2}".to_vec());
        buf.extend_from_slice(b"}\n");
        let lines = split_complete_lines(&mut buf);
        assert_eq!(lines, vec![b"{\"id\":2}}".to_vec()]);
        assert!(buf.is_empty());
    }

    #[test]
    fn kill_command_passes_marker_as_positional_argument() {
        let command = kill_command("npx -y server", false);
        assert_eq!(command[0], "sh");
        assert_eq!(command[1], "-c");
        assert!(command[2].contains("grep -F -- \"$1\""));
        assert_eq!(command[3], "sh");
        assert_eq!(command[4], "npx -y server");
        let forced = kill_command("npx -y server", true);
        assert!(forced[2].contains("kill -9"));
    }

    #[test]
    fn process_marker_joins_command_and_args() {
        let spec = StdioServerSpec {
            server_id: "fs".to_string(),
            command: "npx".to_string(),
            args: vec!["-y".to_string(), "server-filesystem".to_string()],
            spec_hash: "h".to_string(),
        };
        assert_eq!(process_marker(&spec), "npx -y server-filesystem");
    }

    #[test]
    fn match_response_requires_matching_id() {
        let request_id = serde_json::json!(7);
        let response = serde_json::json!({"jsonrpc":"2.0","id":7,"result":{"ok":true}});
        let line = serde_json::to_vec(&response).unwrap();
        assert!(match_response(&line, Some(&request_id)).is_some());
        // 通知（无 id）不计入响应。
        let notification =
            serde_json::json!({"jsonrpc":"2.0","method":"notifications/tools/list_changed"});
        let line = serde_json::to_vec(&notification).unwrap();
        assert!(match_response(&line, Some(&request_id)).is_none());
        // 不匹配的 id 不计入响应。
        let other = serde_json::json!({"jsonrpc":"2.0","id":8,"result":{}});
        let line = serde_json::to_vec(&other).unwrap();
        assert!(match_response(&line, Some(&request_id)).is_none());
    }
}
