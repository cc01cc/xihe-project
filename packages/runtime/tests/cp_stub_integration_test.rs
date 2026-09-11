use mockito::Server;

const TEST_TOKEN: &str = "test-token";

#[test]
fn test_mcp_poll_config_parses_stdio_servers() {
    let mut server = Server::new();
    let body = r#"{
        "generation": 42,
        "hash": "sha256:abc",
        "servers": [
            {
                "name": "filesystem",
                "config": {
                    "command": "npx",
                    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
                }
            },
            {
                "name": "github",
                "config": { "command": "node", "args": ["server.js"] }
            }
        ]
    }"#;
    let _mock = server
        .mock("GET", "/internal/v1/workspaces/ws-1/stdio-servers")
        .match_header("Authorization", "Bearer test-token")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(body)
        .create();

    let url = server.url();
    let rt = tokio::runtime::Runtime::new().expect("create tokio runtime");
    rt.block_on(async {
        let mgr = xihe_runtime::mcp_process::McpProcessManager::new();
        let (generation, hash, servers) = mgr
            .poll_config_with_generation("ws-1", &url, TEST_TOKEN)
            .await;

        assert_eq!(generation, 42);
        assert_eq!(hash, "sha256:abc");
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
