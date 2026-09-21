use thiserror::Error;

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("Path traversal detected: {path}")]
    PathTraversal { path: String },

    #[error("Invalid path: {0}")]
    InvalidPath(String),

    #[error("File not found: {0}")]
    FileNotFound(String),

    #[error("Symlink escape: {path} resolved to {resolved} outside workspace")]
    SymlinkEscape { path: String, resolved: String },

    #[error("Workspace root not found: {0}")]
    WorkspaceNotFound(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Pattern error: {0}")]
    Pattern(String),

    #[error("Regex error: {0}")]
    Regex(#[from] regex::Error),

    #[error("Glob pattern error: {0}")]
    GlobPattern(#[from] globset::Error),

    #[error("Command execution error: {0}")]
    Command(String),

    #[error("Docker error: {0}")]
    Docker(String),

    #[error("Operation timed out ({detail})")]
    Timeout { detail: String },

    /// PLAN-0317 T2.2（决策 #13）：执行被取消。`confirmed=true` 表示已收到容器
    /// 的 `CANCELLED` 回帧（终止已确认）；`false` 表示有界等待内未收到回帧
    /// （未确认，由对账/追偿兜底）。
    #[error("Execution cancelled (confirmed={confirmed}, {detail})")]
    Cancelled { detail: String, confirmed: bool },

    #[error("Process timed out: {detail}")]
    ProcessTimeout { detail: String },

    #[error("Process cancelled (confirmed={confirmed}): {detail}")]
    ProcessCancelled { detail: String, confirmed: bool },

    #[error("Process tree cleanup failed: {detail}")]
    ProcessTreeCleanupFailed { detail: String },

    #[error("Process exited with code {code:?}")]
    ProcessExited { code: Option<i32> },

    #[error("Watch error: {0}")]
    Watch(String),

    #[error("Join error: {0}")]
    Join(String),

    #[error("Sandbox not found for workspace {0}")]
    SandboxNotFound(String),

    #[error("Workspace execution spec not found: {0}")]
    ExecutionSpecNotFound(String),

    #[error("Workspace execution spec unavailable for {workspace_id}: {detail}")]
    ExecutionSpecUnavailable {
        workspace_id: String,
        detail: String,
    },

    #[error("Invalid workspace execution spec for {workspace_id}: {detail}")]
    InvalidExecutionSpec {
        workspace_id: String,
        detail: String,
    },

    #[error("Workspace materialization failed for {workspace_id}: {detail}")]
    WorkspaceMaterializationFailed {
        workspace_id: String,
        detail: String,
    },

    /// PLAN-0345 T1.3 (decision #7): the workspace is being destroyed; late
    /// ensure/materialize calls are rejected with 409 WORKSPACE_DESTROYING.
    #[error("Workspace {workspace_id} is being destroyed")]
    WorkspaceDestroying { workspace_id: String },

    /// PLAN-0345 T2.2 (decision #10): another in-flight operation holds the
    /// workspace execution lease.
    #[error("Workspace {workspace_id} is busy (held by {holder})")]
    WorkspaceBusy {
        workspace_id: String,
        holder: String,
    },

    /// PLAN-0345 I3: illegal lifecycle transitions fail loudly.
    #[error("Illegal workspace transition for {workspace_id}: {from} -> {to}")]
    InvalidTransition {
        workspace_id: String,
        from: &'static str,
        to: &'static str,
    },

    /// PLAN-0347 T1.1（0329 §3 / 不变式 I3）：能力未声明或 `declared/probed`
    /// 冲突时显式 fail-closed，禁止静默降级。
    #[error("Capability unsupported: {capability} ({reason})")]
    Unsupported { capability: String, reason: String },

    /// PLAN-0347 T1.3：会话无可用进程且无法启动（spec `MCP_SESSION_UNAVAILABLE`）。
    #[error("MCP session unavailable for {workspace_id}/{server_id}: {detail}")]
    McpSessionUnavailable {
        workspace_id: String,
        server_id: String,
        detail: String,
    },

    /// PLAN-0347 T1.3：会话预算耗尽/冷却中（spec `MCP_SESSION_FAILED`）。
    #[error("MCP session failed for {workspace_id}/{server_id}: {reason}")]
    McpSessionFailed {
        workspace_id: String,
        server_id: String,
        reason: String,
    },

    /// PLAN-0347 T1.3：同 server 排队/等待超上限（spec `MCP_SESSION_BUSY`）。
    #[error("MCP session busy for {workspace_id}/{server_id}: {detail}")]
    McpSessionBusy {
        workspace_id: String,
        server_id: String,
        detail: String,
    },
}

impl RuntimeError {
    /// 构造带署名的超时错误（PLAN-0308 spec S5）：detail 取当前 task_local 生效值。
    pub fn timeout_now() -> Self {
        Self::Timeout {
            detail: crate::tool_timeout::current_signature(),
        }
    }

    /// PLAN-0308 T3.4（决策 #31）：容器内命令守卫到界。
    /// 与 `timeout_now()` 的区别：守卫值由**授权值派生**（不是本进程的默认解析），
    /// 因此只报守卫确知的事实（层名 / 机制 / 秒数）；来源与 valueOrigin 由 host 侧补签。
    pub fn guard_timeout(guard_seconds: u64) -> Self {
        Self::Timeout {
            detail: format!("layer=runtime_exec mechanism=guard effectiveSeconds={guard_seconds}"),
        }
    }
}

impl From<RuntimeError> for rmcp::ErrorData {
    fn from(err: RuntimeError) -> Self {
        rmcp::ErrorData::internal_error(err.to_string(), None)
    }
}

pub type Result<T> = std::result::Result<T, RuntimeError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_error_into_rmcp_error_data() {
        let err = RuntimeError::PathTraversal {
            path: "/etc/passwd".into(),
        };
        let data: rmcp::ErrorData = err.into();
        assert!(data.message.contains("Path traversal"));
    }

    #[test]
    fn runtime_error_to_string() {
        let err = RuntimeError::FileNotFound("test.txt".into());
        assert_eq!(err.to_string(), "File not found: test.txt");
    }

    #[test]
    fn runtime_error_display_formats_all_variants() {
        let cases = vec![
            (RuntimeError::InvalidPath("x".into()), "Invalid path"),
            (RuntimeError::timeout_now(), "Operation timed out"),
            (
                RuntimeError::Command("fail".into()),
                "Command execution error",
            ),
        ];
        for (err, expected_prefix) in cases {
            assert!(
                err.to_string().starts_with(expected_prefix),
                "unexpected: {err}"
            );
        }
    }
}
