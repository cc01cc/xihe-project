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
        stdout_truncated: false,
        stderr_truncated: false,
    };

    let json = serde_json::to_value(&result).expect("command result should serialize");
    assert_eq!(json["stdout"], "hello");
    assert_eq!(json["exit_code"], 0);
    assert_eq!(json["success"], true);
    // PLAN-0381 T2.1：缺省 false 不序列化（旧读者按缺省读）；true 必须出现。
    assert!(
        json.get("stdout_truncated").is_none(),
        "false flags must stay additive-absent: {json}"
    );

    let truncated = CommandResult {
        stdout: "cut".into(),
        stdout_truncated: true,
        stderr_truncated: true,
        ..result
    };
    let json = serde_json::to_value(truncated).expect("flags should serialize");
    assert_eq!(json["stdout_truncated"], true);
    assert_eq!(json["stderr_truncated"], true);
    // 脱落映射回归：容器侧 ExecResult → sandbox::CommandResult 的字段名一致。
    let parsed: CommandResult =
        serde_json::from_str(r#"{"stdout":"a","stderr":"b","exit_code":1,"success":false,"artifact_id":"art-1","stdout_truncated":true,"stderr_truncated":false}"#)
            .expect("wire shape must parse");
    assert!(parsed.stdout_truncated);
    assert!(!parsed.stderr_truncated);
    assert_eq!(parsed.artifact_id.as_deref(), Some("art-1"));
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
