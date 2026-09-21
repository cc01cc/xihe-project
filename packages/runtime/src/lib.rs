pub mod backend;
pub mod channel;
pub mod channel_proto;
pub mod checkpoint;
pub mod checkpoint_api;
pub mod checkpoint_revert;
pub mod checkpoint_revert_api;
pub mod device;
pub mod dotenv_loader;
pub mod environment;
pub mod error;
pub mod executor;
pub mod fetch;
pub mod fs;
pub mod gateway;
pub mod heartbeat;
pub mod hydrate;
pub mod inventory;
pub mod job_engine;
pub mod job_mxc_adapter;
pub mod lifecycle;
pub mod log_redact;
pub mod mcp_session;
pub mod process_guard;
pub mod remote_mcp;
pub mod sandbox;
pub mod security_defaults;
pub mod storage;
pub mod tool_timeout;
pub mod workspace;

#[cfg(test)]
mod tests {
    #[test]
    fn smoke_test_error_module() {
        let _ = crate::error::RuntimeError::Timeout {
            detail: "smoke".to_string(),
        };
    }

    #[test]
    fn smoke_test_fs_types() {
        let info = crate::fs::FileInfo {
            name: "test.txt".into(),
            path: "test.txt".into(),
            is_dir: false,
            is_symlink: false,
            size: 100,
            modified: "now".into(),
            created: None,
        };
        assert_eq!(info.name, "test.txt");
    }

    #[test]
    fn smoke_test_sandbox_types() {
        let result = crate::sandbox::CommandResult {
            stdout: "out".into(),
            stderr: "err".into(),
            exit_code: 0,
            success: true,
            artifact_id: None,
        };
        assert!(result.success);
    }
}
