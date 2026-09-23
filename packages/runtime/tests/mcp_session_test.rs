//! PLAN-0347 T1.3 真容器会话测试（需 Docker + `xihe/workspace` 镜像）。
//! 运行：cargo test --test mcp_session_test -- --nocapture

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bollard::Docker;
use bollard::exec::{CreateExecOptions, StartExecOptions};
use bollard::models::{ContainerCreateBody, HostConfig};
use bollard::query_parameters::{
    CreateContainerOptions, RemoveContainerOptions, StartContainerOptions,
};
use serde_json::json;
use xihe_runtime::mcp_session::{
    DEFAULT_REQUEST_TIMEOUT, McpSessionManager, SessionStateKind, StdioServerSpec,
};

const IMAGE: &str = "xihe/workspace";
const ECHO: &str = r#"while IFS= read -r line; do printf '%s\n' "$line"; done"#;

fn spec(server_id: &str, args: Vec<String>, hash: &str) -> StdioServerSpec {
    StdioServerSpec {
        server_id: server_id.to_string(),
        command: "sh".to_string(),
        args,
        spec_hash: hash.to_string(),
    }
}

async fn create_ws_container(docker: &Docker, name: &str) {
    let config = ContainerCreateBody {
        image: Some(IMAGE.to_string()),
        cmd: Some(vec!["sleep".into(), "infinity".into()]),
        host_config: Some(HostConfig {
            network_mode: Some("none".to_string()),
            ..Default::default()
        }),
        ..Default::default()
    };
    docker
        .create_container(
            Some(CreateContainerOptions {
                name: Some(name.to_string()),
                ..Default::default()
            }),
            config,
        )
        .await
        .expect("create container (is the xihe/workspace image built?)");
    docker
        .start_container(name, None::<StartContainerOptions>)
        .await
        .expect("start container");
}

async fn exec_detached(docker: &Docker, container: &str, cmd: Vec<String>) {
    let exec = docker
        .create_exec(
            container,
            CreateExecOptions {
                cmd: Some(cmd),
                ..Default::default()
            },
        )
        .await
        .expect("create detached exec");
    let _ = docker
        .start_exec(
            &exec.id,
            Some(StartExecOptions {
                detach: true,
                ..Default::default()
            }),
        )
        .await;
}

async fn wait_session_state(
    manager: &McpSessionManager,
    ws: &str,
    server: &str,
    expected: SessionStateKind,
    bound: Duration,
) -> bool {
    let deadline = std::time::Instant::now() + bound;
    while std::time::Instant::now() < deadline {
        if let Some(snapshot) = manager
            .servers(ws)
            .await
            .into_iter()
            .find(|snapshot| snapshot.server_id == server)
            && snapshot.state == expected
        {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

#[tokio::test]
async fn session_request_self_heals_and_cleans_up() {
    let docker = Docker::connect_with_local_defaults().expect("docker connect");
    docker.version().await.expect("docker must be available");

    let ws_id = format!(
        "sessiontest{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
    );
    let container = format!("xihe-workspace-ws_{ws_id}");
    create_ws_container(&docker, &container).await;

    let manager = McpSessionManager::new().expect("session manager");
    let echo = spec("echo", vec!["-c".to_string(), ECHO.to_string()], "hash-1");
    let request = serde_json::to_vec(&json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/list"
    }))
    .unwrap();

    // 1) 首次请求：惰性建会话并往返成功
    let response = manager
        .request(&ws_id, &echo, request.clone(), DEFAULT_REQUEST_TIMEOUT)
        .await
        .expect("first request must succeed");
    assert_eq!(response.get("id"), Some(&json!(1)));
    assert!(
        wait_session_state(
            &manager,
            &ws_id,
            "echo",
            SessionStateKind::Ready,
            Duration::from_secs(5)
        )
        .await,
        "session must reach ready"
    );
    let capability = manager.capability().await;
    assert_eq!(
        capability.probed,
        Some(true),
        "attach probe records success"
    );

    // 1.5) 跨 workspace 隔离：cleanup 其他 workspace 不得波及本会话
    // （PLAN-0387 T3.1：MCP session 不串状态）
    manager.cleanup_workspace("ws_isolation_probe").await;
    assert!(
        !manager.servers(&ws_id).await.is_empty(),
        "cleanup of a foreign workspace must not touch this workspace's sessions"
    );
    let isolated = manager
        .request(&ws_id, &echo, request.clone(), DEFAULT_REQUEST_TIMEOUT)
        .await;
    assert!(
        isolated.is_ok(),
        "request after foreign cleanup must still succeed: {isolated:?}"
    );

    // 2) 杀死会话进程 → 下一次请求自愈（重启并成功）
    let kill = "ps -eo pid,args | grep -F -e 'while IFS=' | grep -v grep | awk '{print $1}' | xargs -r kill".to_string();
    exec_detached(
        &docker,
        &container,
        vec!["sh".to_string(), "-c".to_string(), kill],
    )
    .await;
    assert!(
        wait_session_state(
            &manager,
            &ws_id,
            "echo",
            SessionStateKind::Restarting,
            Duration::from_secs(5)
        )
        .await
            || wait_session_state(
                &manager,
                &ws_id,
                "echo",
                SessionStateKind::Ready,
                Duration::from_secs(5)
            )
            .await,
        "killed session must be observed (restarting then ready)"
    );
    let healed = manager
        .request(&ws_id, &echo, request.clone(), DEFAULT_REQUEST_TIMEOUT)
        .await
        .expect("request after kill must self-heal");
    assert_eq!(healed.get("id"), Some(&json!(1)));

    // 3) 立即退出的进程：请求显式失败（不静默）
    let failing = spec(
        "failing",
        vec!["-c".to_string(), "exit 1".to_string()],
        "hash-1",
    );
    let fail = manager
        .request(&ws_id, &failing, request.clone(), Duration::from_secs(15))
        .await;
    assert!(fail.is_err(), "exiting process must surface an error");

    // 4) 配置对账：spec 删除 → 会话停止；cleanup 清空注册表
    let stopped = manager.reconcile_specs(&ws_id, vec![echo.clone()]).await;
    assert!(
        stopped.contains(&"failing".to_string()),
        "removed spec must be reported for stop: {stopped:?}"
    );
    for server_id in stopped {
        manager.stop_server(&ws_id, &server_id).await;
    }
    manager.cleanup_workspace(&ws_id).await;
    assert!(manager.servers(&ws_id).await.is_empty());

    // 5) 清理容器（无残留）
    let _ = docker
        .remove_container(
            &container,
            Some(RemoveContainerOptions {
                force: true,
                v: true,
                ..Default::default()
            }),
        )
        .await;
}
