//! 本地 stdio 插件 runner 的进程托管。
//!
//! 一个 runner = 一个宿主子进程 + 一条 `stdin`/`stdout` 管道 + 一份 stderr 尾巴。
//! 并发模型是**单 owner 的 `&mut self`**（v1 单飞，与 `mcp_session` 的 FIFO 口径一致）：
//! 要并发就开多个 runner，而不是共享一个 runner。
//!
//! 四条硬性质（D-61）：
//!
//! 1. **独立 PID**：插件跑在自己的进程里（Windows 侧额外不共享控制台窗口；Unix 侧自成进程组），
//!    Runtime 进程崩溃不会连带插件里的用户代码；反过来插件被杀也不影响 Runtime。
//! 2. **超时**：握手有 `startup_timeout`，每个请求有 `request_timeout`；超时即判死并杀进程组，
//!    不留半死的会话（fail-closed：宁可让 CP 看到 `crashed`，也不要让一帧迟到的应答后续被错认）。
//! 3. **无共享内存**：只走管道字节流，不 mmap、不传共享 buffer、不写临时文件。
//! 4. **崩溃回收**：进程退出必被 `wait`/`try_wait` 收掉；`stop()` 与 `Drop` 都会尝试回收，
//!    `kill_on_drop(true)` 兜住"runner 被直接丢掉"的路径。

use std::collections::VecDeque;
use std::io;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::time::Instant;

use crate::mcp_session::{match_response, split_complete_lines};
use crate::plugin::spec::{PluginRunnerSpec, SpecError, runner_env};

/// stderr 尾巴保留的行数（崩溃排障用；全量 stderr 不进内存）。
pub const STDERR_TAIL_LINES: usize = 40;
/// 单行 stderr 的截断上限。
pub const MAX_STDERR_LINE_BYTES: usize = 8 * 1024;

/// 进程级状态。**不要**跟 binding 五态机（T2.5）混用：这里只描述"进程活着没"。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunnerState {
    /// 已 spawn，`initialize` 还没回。
    Starting,
    /// 握手成功，可以发请求。
    Ready,
    /// 进程退出 / 超时被判死；`exit_code` 为 `None` 表示没拿到退出码（或已被杀）。
    Crashed { exit_code: Option<i32> },
    /// 被 `stop()` 正常停掉。
    Stopped,
}

impl RunnerState {
    /// 健康快照里的稳定小写标签（CP 侧按字符串判等，别改字面量）。
    #[must_use]
    pub fn label(&self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Crashed { .. } => "crashed",
            Self::Stopped => "stopped",
        }
    }

    /// 还活着（可发请求或正在握手）。
    #[must_use]
    pub fn is_running(&self) -> bool {
        matches!(self, Self::Starting | Self::Ready)
    }

    /// 已经判死（`crashed`）或被停掉（`stopped`），可回收。
    #[must_use]
    pub fn is_terminal(&self) -> bool {
        !self.is_running()
    }
}

/// 健康快照。T2.4b 的 internal API 直接序列化它（camelCase）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerHealth {
    /// 注册表键（`plugin_id@version`）。
    pub key: String,
    pub plugin_id: String,
    pub version: String,
    pub digest: String,
    /// 子进程 PID（宿主命名空间）。**只给 CP internal 面**，不得透传到公共 API。
    pub pid: Option<u32>,
    /// `starting` / `ready` / `crashed` / `stopped`。
    pub state: String,
    pub exit_code: Option<i32>,
    /// 已保留的 stderr 行数（不是全量行数）。
    pub stderr_lines: usize,
}

/// runner 生命周期里的可恢复失败。都表达"这个 binding 这次没成"，不让它冒成 panic。
#[derive(Debug, Error)]
pub enum RunnerError {
    #[error(transparent)]
    Spec(#[from] SpecError),
    #[error("failed to spawn plugin runner: {0}")]
    Spawn(#[source] io::Error),
    #[error("plugin runner did not answer {method} within {timeout:?}")]
    Timeout { method: String, timeout: Duration },
    #[error("plugin runner closed its stdout (exit code {exit_code:?})")]
    Closed { exit_code: Option<i32> },
    #[error("plugin runner frame exceeds {limit} bytes")]
    FrameTooLarge { limit: usize },
    #[error("plugin runner answered {method} with an error: {detail}")]
    Protocol { method: String, detail: String },
    #[error("plugin runner is not running (state {state})")]
    NotRunning { state: &'static str },
    #[error("plugin runner io error: {0}")]
    Io(#[source] io::Error),
}

/// 一条托管的本地 stdio 插件会话。
pub struct PluginRunner {
    spec: PluginRunnerSpec,
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    stderr_task: Option<tokio::task::JoinHandle<()>>,
    state: RunnerState,
    next_id: u64,
    /// 跨 `read_until` 的半帧缓冲。
    buf: Vec<u8>,
    /// 已切出来、还没被消费的完整帧。
    pending: VecDeque<Vec<u8>>,
}

impl PluginRunner {
    /// spawn + 握手。任何一步失败都会先杀掉已起的进程再返回错误（不留孤儿）。
    pub async fn start(spec: PluginRunnerSpec) -> Result<Self, RunnerError> {
        spec.validate()?;
        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .env_clear()
            .envs(runner_env(&spec))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(cwd) = &spec.cwd {
            command.current_dir(cwd);
        }
        #[cfg(windows)]
        {
            // 不建控制台窗口：插件没有可共享的控制台句柄，Ctrl+C 也不会串到它。
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        #[cfg(unix)]
        {
            // 自成进程组：崩溃回收时能整组杀，不会误伤 Runtime 自己的进程组。
            command.process_group(0);
        }
        let mut child = command.spawn().map_err(RunnerError::Spawn)?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| RunnerError::Io(io::Error::other("plugin runner stdin not captured")))?;
        let stdout = child.stdout.take().ok_or_else(|| {
            RunnerError::Io(io::Error::other("plugin runner stdout not captured"))
        })?;
        let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
        let stderr_task = child
            .stderr
            .take()
            .map(|stderr| tokio::spawn(drain_stderr(stderr, Arc::clone(&stderr_tail))));
        let mut runner = Self {
            spec,
            child,
            stdin: Some(stdin),
            stdout: BufReader::new(stdout),
            stderr_tail,
            stderr_task,
            state: RunnerState::Starting,
            next_id: 1,
            buf: Vec::new(),
            pending: VecDeque::new(),
        };
        if let Err(error) = runner.handshake().await {
            runner.kill_and_reap().await;
            return Err(error);
        }
        runner.state = RunnerState::Ready;
        Ok(runner)
    }

    #[must_use]
    pub fn spec(&self) -> &PluginRunnerSpec {
        &self.spec
    }

    #[must_use]
    pub fn state(&self) -> &RunnerState {
        &self.state
    }

    /// 子进程 PID（宿主命名空间）；进程已退出时仍返回它的 pid。
    #[must_use]
    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    /// 留存的 stderr 行（最多 [`STDERR_TAIL_LINES`] 行，单行已截断）。
    #[must_use]
    pub fn stderr_tail(&self) -> Vec<String> {
        self.stderr_tail.lock().map_or_else(
            |_| Vec::new(),
            |tail| tail.iter().cloned().collect::<Vec<String>>(),
        )
    }

    /// 已留存行数（健康快照用，避免把整段 stderr 搬进快照）。
    #[must_use]
    pub fn stderr_lines(&self) -> usize {
        self.stderr_tail.lock().map_or(0, |tail| tail.len())
    }

    /// 发一个 JSON-RPC 请求并等**同 id** 的应答（`request_timeout` 预算）。
    pub async fn request(&mut self, method: &str, params: Value) -> Result<Value, RunnerError> {
        let timeout = self.spec.request_timeout;
        self.call(method, params, timeout).await
    }

    /// 发一个通知（无 `id`，不等应答）。
    pub async fn notify(&mut self, method: &str, params: Value) -> Result<(), RunnerError> {
        let frame = json!({"jsonrpc": "2.0", "method": method, "params": params});
        self.write_frame(&frame).await
    }

    /// 优雅停：先关 stdin（MCP stdio 服务端看到 EOF 就该自己退），宽限期内没退再杀进程组。
    /// 幂等：已 `stopped` 再调直接返回 `Ok`。
    pub async fn stop(&mut self) -> Result<(), RunnerError> {
        if matches!(self.state, RunnerState::Stopped) {
            return Ok(());
        }
        self.stdin = None;
        let grace = self.spec.stop_grace;
        let exit_code = match tokio::time::timeout(grace, self.child.wait()).await {
            Ok(Ok(status)) => status.code(),
            Ok(Err(error)) => return Err(RunnerError::Io(error)),
            Err(_) => self.kill_and_reap().await,
        };
        self.state = RunnerState::Stopped;
        if let Some(task) = self.stderr_task.take() {
            task.abort();
        }
        tracing::debug!(
            plugin_id = %self.spec.plugin_id,
            exit_code = ?exit_code,
            "plugin runner stopped"
        );
        Ok(())
    }

    /// 健康快照（`key` 由注册表给，runner 自己不知道注册表键）。
    #[must_use]
    pub fn health(&self, key: &str) -> RunnerHealth {
        RunnerHealth {
            key: key.to_string(),
            plugin_id: self.spec.plugin_id.clone(),
            version: self.spec.version.clone(),
            digest: self.spec.digest.clone(),
            pid: self.child.id(),
            state: self.state.label().to_string(),
            exit_code: match &self.state {
                RunnerState::Crashed { exit_code } => *exit_code,
                _ => None,
            },
            stderr_lines: self.stderr_lines(),
        }
    }

    /// `initialize` + `notifications/initialized`。协议参数与 `remote_mcp` 的 HTTP 路径同源，
    /// 免得 stdio 与 HTTP 两条 connector 对同一个 MCP 服务说两种话。
    async fn handshake(&mut self) -> Result<(), RunnerError> {
        let timeout = self.spec.startup_timeout;
        let result = self
            .call("initialize", initialize_params(), timeout)
            .await?;
        // 协商下来的版本只留证：stdio 侧没有 HTTP 头要带版本，本 runner 不按版本分支。
        let negotiated = result
            .get("protocolVersion")
            .and_then(Value::as_str)
            .unwrap_or_default();
        tracing::debug!(
            plugin_id = %self.spec.plugin_id,
            negotiated,
            "plugin runner initialized"
        );
        self.notify("notifications/initialized", json!({})).await
    }

    async fn call(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RunnerError> {
        if !self.state.is_running() {
            return Err(RunnerError::NotRunning {
                state: self.state.label(),
            });
        }
        let id = self.next_id;
        self.next_id += 1;
        let frame = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        self.write_frame(&frame).await?;
        let deadline = Instant::now() + timeout;
        let request_id = json!(id);
        loop {
            match tokio::time::timeout_at(deadline, self.read_frame()).await {
                Err(_) => {
                    let exit_code = self.kill_and_reap().await;
                    self.state = RunnerState::Crashed { exit_code };
                    return Err(RunnerError::Timeout {
                        method: method.to_string(),
                        timeout,
                    });
                }
                Ok(Err(error)) => {
                    let exit_code = self.observe_exit();
                    self.state = RunnerState::Crashed { exit_code };
                    return Err(error);
                }
                Ok(Ok(None)) => {
                    // stdout 关了 ⇒ 进程正在退出。给一小段有界时间让状态码落地，
                    // 否则 `try_wait` 可能抢在退出之前，把真实退出码报成 `None`。
                    let exit_code = self.reap_exit_code(Duration::from_millis(500)).await;
                    self.state = RunnerState::Crashed { exit_code };
                    return Err(RunnerError::Closed { exit_code });
                }
                Ok(Ok(Some(line))) => {
                    let Some(response) = match_response(&line, Some(&request_id)) else {
                        continue;
                    };
                    if let Some(error) = response.get("error") {
                        return Err(RunnerError::Protocol {
                            method: method.to_string(),
                            detail: error.to_string(),
                        });
                    }
                    return Ok(response.get("result").cloned().unwrap_or(Value::Null));
                }
            }
        }
    }

    async fn write_frame(&mut self, frame: &Value) -> Result<(), RunnerError> {
        let mut line =
            serde_json::to_vec(frame).map_err(|error| RunnerError::Io(io::Error::other(error)))?;
        line.push(b'\n');
        if line.len() > self.spec.max_frame_bytes {
            return Err(RunnerError::FrameTooLarge {
                limit: self.spec.max_frame_bytes,
            });
        }
        let state = self.state.label();
        let Some(stdin) = self.stdin.as_mut() else {
            return Err(RunnerError::NotRunning { state });
        };
        stdin.write_all(&line).await.map_err(RunnerError::Io)?;
        stdin.flush().await.map_err(RunnerError::Io)
    }

    /// 读下一帧（`Ok(None)` = stdout 关了，进程大概率已退出）。
    async fn read_frame(&mut self) -> Result<Option<Vec<u8>>, RunnerError> {
        loop {
            if let Some(line) = self.pending.pop_front() {
                if line.is_empty() {
                    continue;
                }
                return Ok(Some(line));
            }
            let read = self
                .stdout
                .read_until(b'\n', &mut self.buf)
                .await
                .map_err(RunnerError::Io)?;
            if read == 0 {
                return Ok(None);
            }
            if self.buf.len() > self.spec.max_frame_bytes {
                // 半帧就超限：先判死再返回，避免后续读到被截断的 JSON 拼出假应答。
                return Err(RunnerError::FrameTooLarge {
                    limit: self.spec.max_frame_bytes,
                });
            }
            self.pending.extend(split_complete_lines(&mut self.buf));
        }
    }

    /// 非阻塞看退出码（不 `wait`，避免在请求路径上无限挂住）。
    fn observe_exit(&mut self) -> Option<i32> {
        match self.child.try_wait() {
            Ok(Some(status)) => status.code(),
            _ => None,
        }
    }

    /// 已知进程正在退出时，用有界等待换到真实退出码（`None` = 超时内没退或没有状态码）。
    async fn reap_exit_code(&mut self, grace: Duration) -> Option<i32> {
        if let Some(code) = self.observe_exit() {
            return Some(code);
        }
        match tokio::time::timeout(grace, self.child.wait()).await {
            Ok(Ok(status)) => status.code(),
            _ => None,
        }
    }

    /// 杀进程组（Windows 走 `process_guard` 的 `taskkill /T /F` 口径，Unix 按进程组发 SIGKILL），
    /// 然后 `wait` 回收，返回退出码。
    async fn kill_and_reap(&mut self) -> Option<i32> {
        self.stdin = None;
        self.kill_child_tree().await;
        match self.child.wait().await {
            Ok(status) => status.code(),
            Err(_) => None,
        }
    }

    async fn kill_child_tree(&mut self) {
        let Some(pid) = self.child.id() else {
            return;
        };
        #[cfg(windows)]
        {
            if let Err(error) = crate::process_guard::terminate_process_tree(pid).await {
                tracing::warn!(pid, error = %error, "plugin runner tree kill failed");
            }
        }
        #[cfg(unix)]
        {
            // 子进程已 `process_group(0)` 自成进程组，按组发 SIGKILL。
            // `unsafe_code = "deny"`（crate lints）⇒ 不直接调 libc，走 `kill` 工具。
            let group = format!("-{pid}");
            let _ = Command::new("kill")
                .args(["-9", &group])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
        }
        let _ = self.child.kill().await;
    }
}

impl Drop for PluginRunner {
    fn drop(&mut self) {
        if let Some(task) = self.stderr_task.take() {
            task.abort();
        }
        // 子进程由 `kill_on_drop(true)` 兜住；tokio 会在 Child 被丢弃后回收进程。
    }
}

impl std::fmt::Debug for PluginRunner {
    /// 只打印定位用的字段：`Child`/管道句柄没有有意义的 Debug，且 stderr 尾巴可能含插件输出。
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PluginRunner")
            .field("key", &self.spec.runner_key())
            .field("state", &self.state)
            .field("pid", &self.child.id())
            .finish_non_exhaustive()
    }
}

/// `initialize` 的 params：与 `remote_mcp::RemoteMcpConnector::initialize` 同源。
fn initialize_params() -> Value {
    json!({
        "protocolVersion": crate::remote_mcp::MCP_PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": {"name": "xihe-runtime", "version": env!("CARGO_PKG_VERSION")},
    })
}

async fn drain_stderr(stderr: ChildStderr, tail: Arc<Mutex<VecDeque<String>>>) {
    let mut lines = BufReader::new(stderr).lines();
    // EOF（`Ok(None)`）与读错误都只意味着"这个进程没有更多 stderr 了"，同一出口即可。
    while let Ok(Some(line)) = lines.next_line().await {
        push_tail(&tail, line);
    }
}

fn push_tail(tail: &Arc<Mutex<VecDeque<String>>>, line: String) {
    let mut line = line;
    if line.len() > MAX_STDERR_LINE_BYTES {
        let mut end = MAX_STDERR_LINE_BYTES;
        while end > 0 && !line.is_char_boundary(end) {
            end -= 1;
        }
        line.truncate(end);
        line.push_str("...(truncated)");
    }
    let Ok(mut tail) = tail.lock() else {
        return;
    };
    while tail.len() >= STDERR_TAIL_LINES {
        tail.pop_front();
    }
    tail.push_back(line);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_labels_are_stable_wire_values() {
        assert_eq!(RunnerState::Starting.label(), "starting");
        assert_eq!(RunnerState::Ready.label(), "ready");
        assert_eq!(
            RunnerState::Crashed { exit_code: Some(3) }.label(),
            "crashed"
        );
        assert_eq!(RunnerState::Stopped.label(), "stopped");
        assert!(RunnerState::Starting.is_running());
        assert!(RunnerState::Ready.is_running());
        assert!(RunnerState::Crashed { exit_code: None }.is_terminal());
        assert!(RunnerState::Stopped.is_terminal());
    }

    #[test]
    fn stderr_tail_keeps_only_the_last_lines() {
        let tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
        for index in 0..(STDERR_TAIL_LINES + 5) {
            push_tail(&tail, format!("line-{index}"));
        }
        let snapshot = tail.lock().expect("stderr tail mutex").clone();
        assert_eq!(snapshot.len(), STDERR_TAIL_LINES);
        let newest = format!("line-{}", STDERR_TAIL_LINES + 4);
        assert_eq!(snapshot.back().map(String::as_str), Some(newest.as_str()));
        assert_eq!(snapshot.front().map(String::as_str), Some("line-5"));
    }

    #[test]
    fn overlong_stderr_lines_are_truncated_on_a_char_boundary() {
        let tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
        push_tail(&tail, "汉".repeat(MAX_STDERR_LINE_BYTES));
        let snapshot = tail.lock().expect("stderr tail mutex").clone();
        let line = snapshot.front().expect("one line");
        assert!(line.ends_with("...(truncated)"));
        assert!(line.len() <= MAX_STDERR_LINE_BYTES + "...(truncated)".len());
        // 截断点必须落在字符边界上，否则 String 会 panic/丢字。
        assert!(line.is_char_boundary(MAX_STDERR_LINE_BYTES.min(line.len())));
    }

    #[test]
    fn initialize_params_reuse_the_remote_mcp_contract() {
        let params = initialize_params();
        assert_eq!(
            params.get("protocolVersion").and_then(Value::as_str),
            Some(crate::remote_mcp::MCP_PROTOCOL_VERSION)
        );
        assert_eq!(
            params.pointer("/clientInfo/name").and_then(Value::as_str),
            Some("xihe-runtime")
        );
        assert!(params.get("capabilities").is_some());
    }

    #[test]
    fn frame_matching_reuses_the_mcp_session_contract() {
        let request_id = json!(7);
        assert!(
            match_response(
                br#"{"jsonrpc":"2.0","id":7,"result":{}}"#,
                Some(&request_id)
            )
            .is_some()
        );
        // 通知（无 id）不配对。
        assert!(match_response(br#"{"jsonrpc":"2.0","method":"x"}"#, Some(&request_id)).is_none());
        // 别人的 id 不配对。
        assert!(
            match_response(
                br#"{"jsonrpc":"2.0","id":8,"result":{}}"#,
                Some(&request_id)
            )
            .is_none()
        );
        // 非 JSON 行不配对（插件往 stdout 打日志的常见事故）。
        assert!(match_response(b"noise", Some(&request_id)).is_none());
    }
}
