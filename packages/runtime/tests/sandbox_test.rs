use xihe_runtime::error::RuntimeError;
use xihe_runtime::sandbox::{CommandResult, SecurityProfile};
use xihe_runtime::workspace::WorkspaceManager;

#[test]
fn test_security_profiles_are_distinct() {
    assert_ne!(SecurityProfile::Strict, SecurityProfile::Coding);
    assert_ne!(SecurityProfile::Coding, SecurityProfile::Isolated);
    assert_ne!(SecurityProfile::Strict, SecurityProfile::Isolated);
}

#[test]
fn test_command_result_serializes_public_fields() {
    let result = CommandResult {
        stdout: "hello".into(),
        stderr: String::new(),
        exit_code: 0,
        success: true,
        artifact_id: None,
    };

    let json = serde_json::to_value(result).expect("command result should serialize");
    assert_eq!(json["stdout"], "hello");
    assert_eq!(json["exit_code"], 0);
    assert_eq!(json["success"], true);
}

#[test]
fn test_workspace_manager_starts_empty() {
    let manager = WorkspaceManager::new();

    assert_eq!(manager.workspace_count(), 0);
    assert!(manager.list_workspaces().is_empty());
    assert!(manager.get_state("missing").is_none());
}

#[tokio::test]
async fn test_delete_missing_workspace_returns_sandbox_not_found() {
    let mut manager = WorkspaceManager::new();

    let error = manager
        .delete_workspace("missing")
        .await
        .expect_err("missing workspace should not be deleted");

    assert!(matches!(error, RuntimeError::SandboxNotFound(id) if id == "missing"));
}

#[tokio::test]
async fn test_pause_missing_workspace_returns_sandbox_not_found() {
    let manager = WorkspaceManager::new();

    let error = manager
        .pause_container("missing")
        .await
        .expect_err("missing workspace should not be paused");

    assert!(matches!(error, RuntimeError::SandboxNotFound(id) if id == "missing"));
}

#[tokio::test]
async fn test_stop_missing_workspace_returns_sandbox_not_found() {
    let manager = WorkspaceManager::new();

    let error = manager
        .stop_container("missing")
        .await
        .expect_err("missing workspace should not be stopped");

    assert!(matches!(error, RuntimeError::SandboxNotFound(id) if id == "missing"));
}
