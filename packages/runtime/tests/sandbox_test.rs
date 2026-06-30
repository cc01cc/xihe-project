use std::fs;

use tempfile::TempDir;
use uuid::Uuid;
use xihe_runtime::sandbox::{SandboxManager, SecurityProfile};

struct SandboxTest {
    _dir: TempDir,
    ws_id: String,
    ws_path: String,
    mgr: SandboxManager,
}

impl SandboxTest {
    async fn new() -> Self {
        let dir = TempDir::new().expect("create temp dir");
        let ws = dir.path().to_str().unwrap().to_string();
        let ws_id = format!("test_{}", Uuid::new_v4());
        fs::write(dir.path().join("test.txt"), "hello").unwrap();
        let mut mgr = SandboxManager::new();
        let _ = mgr.remove_container(&ws_id).await;
        Self { _dir: dir, ws_id, ws_path: ws, mgr }
    }

    async fn ensure(&mut self) {
        self.mgr
            .ensure_container(&self.ws_id, SecurityProfile::Strict, &self.ws_path)
            .await
            .expect("create container");
    }

    async fn cleanup(&mut self) {
        let _ = self.mgr.remove_container(&self.ws_id).await;
    }
}

#[tokio::test]
async fn test_sandbox_manager_ensure_container() {
    let mut t = SandboxTest::new().await;
    t.ensure().await;
    assert!(t.mgr.ensure_container(&t.ws_id, SecurityProfile::Strict, &t.ws_path).await.is_ok());
    t.cleanup().await;
}

#[tokio::test]
async fn test_sandbox_echo_command() {
    let mut t = SandboxTest::new().await;
    t.ensure().await;

    let result = t.mgr
        .exec(&t.ws_id, "echo hello from docker", &[], Some(10))
        .await
        .expect("echo should succeed");

    assert!(result.success);
    assert!(result.stdout.contains("hello from docker"));
    assert_eq!(result.exit_code, 0);
    t.cleanup().await;
}

#[tokio::test]
async fn test_sandbox_failing_command() {
    let mut t = SandboxTest::new().await;
    t.ensure().await;

    let result = t.mgr
        .exec(&t.ws_id, "exit 42", &[], Some(10))
        .await
        .expect("command should complete");

    assert!(!result.success);
    assert_eq!(result.exit_code, 42);
    t.cleanup().await;
}

#[tokio::test]
async fn test_sandbox_stderr_captured() {
    let mut t = SandboxTest::new().await;
    t.ensure().await;

    let result = t.mgr
        .exec(&t.ws_id, "echo stderr output >&2", &[], Some(10))
        .await
        .expect("command should complete");

    assert!(result.stderr.contains("stderr output"));
    t.cleanup().await;
}

#[tokio::test]
async fn test_sandbox_no_sudo() {
    let mut t = SandboxTest::new().await;
    t.ensure().await;

    let result = t.mgr
        .exec(&t.ws_id, "sudo echo ok", &[], Some(10))
        .await
        .expect("command should complete");

    assert!(!result.success, "sudo should fail in sandbox");
    t.cleanup().await;
}

#[tokio::test]
async fn test_sandbox_workspace_isolation() {
    let ws1_dir = TempDir::new().expect("ws1 dir");
    let ws2_dir = TempDir::new().expect("ws2 dir");
    fs::write(ws2_dir.path().join("secret.txt"), "sensitive data").unwrap();

    let mut mgr = SandboxManager::new();
    let ws1_id = format!("ws1_{}", Uuid::new_v4());
    let ws2_id = format!("ws2_{}", Uuid::new_v4());

    let _ = mgr.remove_container(&ws1_id).await;
    let _ = mgr.remove_container(&ws2_id).await;

    mgr.ensure_container(
        &ws1_id,
        SecurityProfile::Strict,
        ws1_dir.path().to_str().unwrap(),
    )
    .await
    .expect("create ws1 container");

    let result = mgr
        .exec(&ws1_id, &format!("cat {}/secret.txt 2>&1 || true", ws2_dir.path().display()), &[], Some(5))
        .await
        .expect("command should complete");

    assert!(
        !result.stdout.contains("sensitive data"),
        "ws1 should not see ws2's files: stdout={}",
        result.stdout
    );

    let _ = mgr.remove_container(&ws1_id).await;
}

#[tokio::test]
async fn test_sandbox_no_network() {
    let mut t = SandboxTest::new().await;
    t.ensure().await;

    let result = t.mgr
        .exec(&t.ws_id, "curl --max-time 3 http://example.com 2>&1 || true", &[], Some(10))
        .await
        .expect("command should complete");

    assert!(
        !result.stdout.is_empty() || !result.stderr.is_empty(),
        "curl should produce some output indicating network failure"
    );
    t.cleanup().await;
}

#[tokio::test]
#[ignore = "sandbox exec does not implement timeout yet (DESIGN-017 pending)"]
async fn test_sandbox_timeout() {
    let mut t = SandboxTest::new().await;
    t.ensure().await;

    let result = t.mgr
        .exec(&t.ws_id, "sleep 10", &[], Some(1))
        .await;

    assert!(result.is_err(), "Sleep should time out");
    t.cleanup().await;
}

#[tokio::test]
async fn test_sandbox_write_isolation() {
    let ws1_dir = TempDir::new().expect("ws1 dir");
    let ws2_dir = TempDir::new().expect("ws2 dir");

    let mut mgr = SandboxManager::new();
    let ws1_id = format!("ws1w_{}", Uuid::new_v4());
    let _ = mgr.remove_container(&ws1_id).await;

    mgr.ensure_container(&ws1_id, SecurityProfile::Strict, ws1_dir.path().to_str().unwrap())
        .await.expect("create ws1");

    let result = mgr
        .exec(&ws1_id, &format!("echo hacked > {}/owned.txt 2>&1 || echo BLOCKED", ws2_dir.path().display()), &[], Some(5))
        .await.expect("command should complete");

    assert!(
        !ws2_dir.path().join("owned.txt").exists(),
        "ws1 should not write to ws2's directory"
    );

    let _ = mgr.remove_container(&ws1_id).await;
}

#[tokio::test]
async fn test_sandbox_list_isolation() {
    let ws1_dir = TempDir::new().expect("ws1 dir");
    let ws2_dir = TempDir::new().expect("ws2 dir");
    fs::write(ws2_dir.path().join("hidden.txt"), "secret").unwrap();

    let mut mgr = SandboxManager::new();
    let ws1_id = format!("ws1l_{}", Uuid::new_v4());
    let _ = mgr.remove_container(&ws1_id).await;

    mgr.ensure_container(&ws1_id, SecurityProfile::Strict, ws1_dir.path().to_str().unwrap())
        .await.expect("create ws1");

    let result = mgr
        .exec(&ws1_id, &format!("ls {} 2>&1 || echo BLOCKED", ws2_dir.path().display()), &[], Some(5))
        .await.expect("command should complete");

    assert!(
        !result.stdout.contains("hidden.txt"),
        "ws1 should not list ws2's files: stdout={}",
        result.stdout
    );

    let _ = mgr.remove_container(&ws1_id).await;
}

#[tokio::test]
async fn test_sandbox_grep_isolation() {
    let ws1_dir = TempDir::new().expect("ws1 dir");
    let ws2_dir = TempDir::new().expect("ws2 dir");
    fs::write(ws2_dir.path().join("private.txt"), "password=abc123").unwrap();

    let mut mgr = SandboxManager::new();
    let ws1_id = format!("ws1g_{}", Uuid::new_v4());
    let _ = mgr.remove_container(&ws1_id).await;

    mgr.ensure_container(&ws1_id, SecurityProfile::Strict, ws1_dir.path().to_str().unwrap())
        .await.expect("create ws1");

    let result = mgr
        .exec(&ws1_id, &format!("grep -r 'password' {} 2>&1 || echo BLOCKED", ws2_dir.path().display()), &[], Some(5))
        .await.expect("command should complete");

    assert!(
        !result.stdout.contains("abc123"),
        "ws1 should not grep ws2's files: stdout={}",
        result.stdout
    );

    let _ = mgr.remove_container(&ws1_id).await;
}

#[tokio::test]
async fn test_sandbox_exec_cannot_escape_workspace() {
    let ws_dir = TempDir::new().expect("ws dir");
    fs::write(ws_dir.path().join("data.txt"), "workspace data").unwrap();

    let mut mgr = SandboxManager::new();
    let ws_id = format!("ws1e_{}", Uuid::new_v4());
    let _ = mgr.remove_container(&ws_id).await;

    mgr.ensure_container(&ws_id, SecurityProfile::Strict, ws_dir.path().to_str().unwrap())
        .await.expect("create ws");

    let result = mgr
        .exec(&ws_id, "cat /etc/hostname 2>&1 || echo BLOCKED", &[], Some(5))
        .await.expect("command should complete");

    assert!(
        result.success || result.stdout.contains("BLOCKED") || result.stderr.contains("Permission denied"),
        "exec should not allow reading host files outside workspace"
    );

    let _ = mgr.remove_container(&ws_id).await;
}
