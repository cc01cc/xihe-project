use xihe_runtime::mcp_process::{BridgeStatus, McpProcessManager};

fn setup() -> McpProcessManager {
    McpProcessManager::new()
}

#[tokio::test]
async fn test_multi_workspace_isolated_bridges() {
    let mgr = setup();

    mgr.spawn("ws-alpha", "git", "npx", &[], "172.17.0.2", 39001)
        .await;
    mgr.spawn("ws-alpha", "db", "python", &[], "172.17.0.2", 39002)
        .await;
    mgr.spawn("ws-beta", "slack", "npx", &[], "172.17.0.3", 39003)
        .await;

    // ws-alpha has 2 bridges
    let alpha = mgr.list("ws-alpha").await;
    assert_eq!(alpha.len(), 2);
    let alpha_ids: Vec<&str> = alpha.iter().map(|b| b.server_id.as_str()).collect();
    assert!(alpha_ids.contains(&"git"));
    assert!(alpha_ids.contains(&"db"));

    // ws-beta has 1 bridge
    let beta = mgr.list("ws-beta").await;
    assert_eq!(beta.len(), 1);
    assert_eq!(beta[0].server_id, "slack");
    assert_eq!(beta[0].container_ip, "172.17.0.3");

    // Stop git from ws-alpha — only git removed
    mgr.stop("ws-alpha", "git").await;
    let alpha_after = mgr.list("ws-alpha").await;
    assert_eq!(alpha_after.len(), 1);
    assert_eq!(alpha_after[0].server_id, "db");

    // ws-beta unaffected
    assert_eq!(mgr.list("ws-beta").await.len(), 1);
}

#[tokio::test]
async fn test_dynamic_port_allocation_no_conflict() {
    let mgr = setup();

    let ports = [39010, 39011, 39012, 39013, 39014];
    for (i, port) in ports.iter().enumerate() {
        mgr.spawn(
            "ws-port",
            &format!("srv-{i}"),
            "cmd",
            &[],
            "10.0.0.1",
            *port,
        )
        .await;
    }

    let bridges = mgr.list("ws-port").await;
    assert_eq!(bridges.len(), 5);

    let mut used_ports: Vec<u16> = bridges.iter().map(|b| b.port).collect();
    used_ports.sort();
    let mut expected = ports.to_vec();
    expected.sort();
    assert_eq!(used_ports, expected, "All 5 ports must be unique");
}

#[tokio::test]
async fn test_cleanup_workspace_removes_all_bridges() {
    let mgr = setup();
    mgr.spawn("ws-clean", "a", "cmd", &[], "ip", 39020).await;
    mgr.spawn("ws-clean", "b", "cmd", &[], "ip", 39021).await;
    mgr.spawn("ws-clean", "c", "cmd", &[], "ip", 39022).await;
    assert_eq!(mgr.list("ws-clean").await.len(), 3);

    mgr.cleanup_workspace("ws-clean").await;
    assert!(mgr.list("ws-clean").await.is_empty());
}

#[tokio::test]
async fn test_bridge_status_tracking() {
    let mgr = setup();
    mgr.spawn("ws-status", "healthy", "cmd", &[], "ip", 39030)
        .await;
    mgr.mark_failed("ws-status", "healthy", "OOM killed").await;

    let bridges = mgr.list("ws-status").await;
    assert_eq!(bridges.len(), 1);
    assert_eq!(
        bridges[0].status,
        BridgeStatus::Failed("OOM killed".to_string())
    );
}

#[tokio::test]
async fn test_get_bridge_url_after_spawn() {
    let mgr = setup();
    mgr.spawn("ws-url", "my-server", "node", &[], "192.168.1.100", 39100)
        .await;

    let url = mgr.get_bridge_url("ws-url", "my-server").await;
    assert_eq!(
        url,
        Some("http://192.168.1.100:39100".to_string())
    );

    assert!(mgr.get_bridge_url("ws-url", "nonexistent").await.is_none());
    assert!(mgr.get_bridge_url("ws-other", "my-server").await.is_none());
}
