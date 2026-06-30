pub mod config_client;
pub mod dotenv_loader;
pub mod error;
pub mod fetch;
pub mod fs;
pub mod gateway;
pub mod mcp_process;
pub mod sandbox;
pub mod workspace;

#[cfg(test)]
mod tests {
    #[test]
    fn smoke_test_error_module() {
        let _ = crate::error::RuntimeError::Timeout;
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
