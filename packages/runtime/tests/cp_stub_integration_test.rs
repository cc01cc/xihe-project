use std::collections::HashMap;

use mockito::Server;
use xihe_runtime::config_client::ConfigClient;

const TEST_TOKEN: &str = "test-token";
const TEST_AUTHORIZATION: &str = "Bearer test-token";

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Runtime::new().expect("create tokio runtime")
}

fn admin_url(domain: &str) -> String {
    format!("/internal/v1/config/admin/{domain}")
}

fn system_url(domain: &str) -> String {
    format!("/internal/v1/config/system/{domain}")
}

fn empty_hashmap_body() -> String {
    serde_json::to_string(&HashMap::<String, String>::new()).unwrap()
}

#[test]
fn test_sync_populates_cache() {
    let mut server = Server::new();
    let body = r#"{"openaiApiKey":"sk-test123","model":"gpt-4"}"#;
    let _mock = server
        .mock("GET", admin_url("llm-provider").as_str())
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(body)
        .create();

    let url = server.url();
    let rt = runtime();
    rt.block_on(async {
        let mut client = ConfigClient::new(&url, TEST_TOKEN);
        let result = client.sync().await;

        assert!(result.is_ok());
        assert_eq!(
            client.get("llm-provider", "openaiApiKey"),
            Some("sk-test123")
        );
        assert_eq!(client.get("llm-provider", "model"), Some("gpt-4"));
    });
}

#[test]
fn test_sync_handles_server_error_gracefully() {
    let mut server = Server::new();
    let _mock = server
        .mock("GET", admin_url("llm-provider").as_str())
        .with_status(500)
        .create();

    let url = server.url();
    let rt = runtime();
    rt.block_on(async {
        let mut client = ConfigClient::new(&url, TEST_TOKEN);
        let result = client.sync().await;

        assert!(result.is_ok());
        assert_eq!(client.get("llm-provider", "openaiApiKey"), None);
    });
}

#[test]
fn test_sync_handles_unreachable_server_gracefully() {
    let rt = runtime();
    rt.block_on(async {
        let mut client = ConfigClient::new("http://127.0.0.1:1", TEST_TOKEN);
        let result = client.sync().await;

        assert!(result.is_ok());
        assert_eq!(client.get("llm-provider", "openaiApiKey"), None);
    });
}

#[test]
fn test_sync_sends_auth_header() {
    let mut server = Server::new();
    let mock = server
        .mock("GET", admin_url("llm-provider").as_str())
        .match_header("Authorization", TEST_AUTHORIZATION)
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(empty_hashmap_body())
        .create();

    let url = server.url();
    let rt = runtime();
    rt.block_on(async {
        let mut client = ConfigClient::new(&url, TEST_TOKEN);
        let _ = client.sync().await;
    });

    mock.assert();
}

#[test]
fn test_sync_sends_auth_header_on_all_system_requests() {
    let mut server = Server::new();
    let mock = server
        .mock("GET", system_url("llm-provider").as_str())
        .match_header("Authorization", TEST_AUTHORIZATION)
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(empty_hashmap_body())
        .create();

    let url = server.url();
    let rt = runtime();
    rt.block_on(async {
        let mut client = ConfigClient::new(&url, TEST_TOKEN);
        let _ = client.sync().await;
    });

    mock.assert();
}

#[test]
fn test_mcp_poll_config_parses_mcp_servers() {
    let mut server = Server::new();
    let body = r#"{
        "mcpServers": {
            "filesystem": {
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
            },
            "github": {
                "command": "node",
                "args": ["server.js"]
            }
        }
    }"#;
    let _mock = server
        .mock("GET", "/internal/v1/config/workspaces/ws-1/mcp-config")
        .match_header("Authorization", "Bearer test-token")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(body)
        .create();

    let url = server.url();
    let rt = runtime();
    rt.block_on(async {
        let mgr = xihe_runtime::mcp_process::McpProcessManager::new();
        let servers = mgr.poll_config("ws-1", &url, "test-token").await;

        assert_eq!(servers.len(), 2);

        let (sid0, cmd0, args0) = &servers[0];
        assert_eq!(sid0, "filesystem");
        assert_eq!(cmd0, "npx");
        assert!(args0.contains(&"-y".to_string()));

        let (sid1, cmd1, _) = &servers[1];
        assert_eq!(sid1, "github");
        assert_eq!(cmd1, "node");
    });
}
