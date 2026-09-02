use std::path::PathBuf;
use tempfile::TempDir;
use xihe_runtime::sandbox::SecurityProfile;
use xihe_runtime::workspace::WorkspaceManager;

#[tokio::test]
async fn test_m1b_sentinel_mount_verified() {
    let dir = TempDir::new().unwrap();
    let ws_path = dir.path().join("ws_m1b_test").to_string_lossy().to_string();
    let ws_id = format!("m1b-{}", uuid::Uuid::new_v4());
    let mut mgr = WorkspaceManager::new();
    let state = mgr
        .create_workspace(&ws_id, &ws_path, SecurityProfile::Coding, "xihe/workspace")
        .await
        .expect("Docker-backed Coding workspace should materialize");
    println!("created: {} {:?}", state.ws_id, state.container_name);
    // Check sentinel exists on host
    let sentinel = PathBuf::from(&ws_path).join(".xihe-sentinel");
    assert!(sentinel.exists(), "sentinel should exist on host");
    let content = std::fs::read_to_string(&sentinel).unwrap();
    assert_eq!(content, format!("sentinel-{}", ws_id));
    println!("host sentinel ok: {}", content);

    // Check sentinel inside container via docker exec
    let docker = bollard::Docker::connect_with_local_defaults().unwrap();
    let exec = docker
        .create_exec(
            &state.container_name,
            bollard::exec::CreateExecOptions {
                cmd: Some(vec!["cat".to_string(), "/workspace/.xihe-sentinel".to_string()]),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                ..Default::default()
            },
        )
        .await
        .expect("create exec");
    let _start_res = docker
        .start_exec(
            &exec.id,
            Some(bollard::exec::StartExecOptions {
                detach: false,
                tty: false,
                output_capacity: Some(128),
            }),
        )
        .await
        .expect("start exec");
    // Small delay for inspect to populate exit_code on Windows.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let info = docker.inspect_exec(&exec.id).await.expect("inspect");
    println!("exec inspect: {:?}", info.exit_code);
    assert_eq!(
        info.exit_code,
        Some(0),
        "container should be able to cat sentinel"
    );

    // Also verify that host writability probe left no .xihe-probe file
    assert!(
        !PathBuf::from(&ws_path)
            .join(".xihe-probe-writable")
            .exists(),
        "probe file should be cleaned"
    );

    // Cleanup must be observable; deleting the Sandbox must preserve storage.
    mgr.delete_workspace(&ws_id)
        .await
        .expect("Sandbox cleanup should succeed");
    assert!(PathBuf::from(&ws_path).exists(), "WorkspaceStorage must survive Sandbox delete");
    assert!(sentinel.exists(), "WorkspaceStorage sentinel must survive Sandbox delete");
    println!(
        "cleanup done, host exists? {}",
        PathBuf::from(&ws_path).exists()
    );
}

#[tokio::test]
async fn test_m1b_host_writability_probe() {
    // This test verifies that the host writability probe would fail if dir is read-only?
    // On Windows, making a dir read-only is tricky (needs ACL). We'll just verify that normal writable dir passes.
    let dir = TempDir::new().unwrap();
    let ws_path = dir.path().join("ws_probe_ok").to_string_lossy().to_string();
    let ws_id = format!("m1b-probe-{}", uuid::Uuid::new_v4());
    let mut mgr = WorkspaceManager::new();
    let state = mgr
        .create_workspace(&ws_id, &ws_path, SecurityProfile::Coding, "xihe/workspace")
        .await
        .expect("Docker-backed writable workspace should materialize");
    println!("writability probe passed for {}", ws_id);
    mgr.delete_workspace(&ws_id)
        .await
        .expect("Sandbox cleanup should succeed");
    assert!(!state.container_name.is_empty());
    assert!(PathBuf::from(&ws_path).exists(), "WorkspaceStorage must survive Sandbox delete");
}
