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

    #[error("Operation timed out")]
    Timeout,

    #[error("Watch error: {0}")]
    Watch(String),

    #[error("Join error: {0}")]
    Join(String),

    #[error("Sandbox not found for workspace {0}")]
    SandboxNotFound(String),

    #[error("Workspace execution spec not found: {0}")]
    ExecutionSpecNotFound(String),

    #[error("Workspace execution spec unavailable for {workspace_id}: {detail}")]
    ExecutionSpecUnavailable { workspace_id: String, detail: String },

    #[error("Invalid workspace execution spec for {workspace_id}: {detail}")]
    InvalidExecutionSpec { workspace_id: String, detail: String },

    #[error("Workspace materialization failed for {workspace_id}: {detail}")]
    WorkspaceMaterializationFailed { workspace_id: String, detail: String },

    #[error("MCP bridge not found for workspace {workspace_id}: {server_id}")]
    McpBridgeNotFound {
        workspace_id: String,
        server_id: String,
    },

    #[error("MCP bridge unavailable for workspace {workspace_id}: {server_id}: {detail}")]
    McpBridgeUnavailable {
        workspace_id: String,
        server_id: String,
        detail: String,
    },
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
            (RuntimeError::Timeout, "Operation timed out"),
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
