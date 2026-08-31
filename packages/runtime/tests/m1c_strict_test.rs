use xihe_runtime::workspace::WorkspaceManager;
use xihe_runtime::sandbox::SecurityProfile;
use tempfile::TempDir;

#[tokio::test]
async fn test_strict_isolation_probes_pass() {
    let dir = TempDir::new().unwrap();
    let ws_path = dir.path().join("ws_strict_m1c").to_string_lossy().to_string();
    let ws_id = format!("m1c-strict-{}", uuid::Uuid::new_v4());
    let mut mgr = WorkspaceManager::new();
    let result = mgr
        .create_workspace(&ws_id, &ws_path, SecurityProfile::Strict, "xihe/workspace")
        .await;
    match result {
        Ok(state) => {
            println!("strict created with isolation ok: {:?}", state.container_name);
            // Verify container has network none
            let docker = bollard::Docker::connect_with_local_defaults().unwrap();
            let inspect = docker.inspect_container(&state.container_name, None).await.unwrap();
            let net_mode = inspect.host_config.and_then(|hc| hc.network_mode).unwrap_or_default();
            println!("network_mode: {}", net_mode);
            // For Strict, should be "none"
            assert_eq!(net_mode, "none");
            let _ = mgr.delete_workspace(&ws_id).await;
        }
        Err(e) => {
            let msg = e.to_string();
            println!("strict create failed: {}", msg);
            if msg.contains("STRICT_PROBE_FAILED") {
                panic!("strict isolation probe failed, should be isolated: {}", msg);
            }
            if msg.contains("Docker") || msg.contains("connect") {
                println!("docker unavailable, skipping");
                return;
            }
            panic!("unexpected: {}", e);
        }
    }
}

#[tokio::test]
async fn test_coding_does_not_run_strict_probes() {
    let dir = TempDir::new().unwrap();
    let ws_path = dir.path().join("ws_coding_m1c").to_string_lossy().to_string();
    let ws_id = format!("m1c-coding-{}", uuid::Uuid::new_v4());
    let mut mgr = WorkspaceManager::new();
    let result = mgr
        .create_workspace(&ws_id, &ws_path, SecurityProfile::Coding, "xihe/workspace")
        .await;
    match result {
        Ok(state) => {
            println!("coding created (no strict probe): {}", state.container_name);
            let _ = mgr.delete_workspace(&ws_id).await;
        }
        Err(e) => {
            println!("coding create failed: {}", e);
            if e.to_string().contains("Docker") {
                return;
            }
            panic!("unexpected: {}", e);
        }
    }
}
