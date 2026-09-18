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
        let (hash, specs) = xihe_runtime::mcp_session::fetch_stdio_specs(&url, TEST_TOKEN, "ws-1")
            .await
            .expect("successful poll must be Ok");

        assert_eq!(hash, "sha256:abc");
        assert_eq!(specs.len(), 2);

        assert_eq!(specs[0].server_id, "filesystem");
        assert_eq!(specs[0].command, "npx");
        assert!(specs[0].args.contains(&"-y".to_string()));
        assert_eq!(specs[0].spec_hash, "sha256:abc");

        assert_eq!(specs[1].server_id, "github");
        assert_eq!(specs[1].command, "node");
    });
}

/// CHN-2: a non-2xx poll must surface as an error, never as an empty server set.
/// The reconcile loop relies on this to keep running sessions instead of stopping
/// them when CP is briefly unavailable.
#[test]
fn test_mcp_poll_config_http_error_is_not_empty_config() {
    let mut server = Server::new();
    let _mock = server
        .mock("GET", "/internal/v1/workspaces/ws-1/stdio-servers")
        .with_status(500)
        .create();

    let url = server.url();
    let rt = tokio::runtime::Runtime::new().expect("create tokio runtime");
    rt.block_on(async {
        let result = xihe_runtime::mcp_session::fetch_stdio_specs(&url, TEST_TOKEN, "ws-1").await;
        assert!(
            result.is_err(),
            "HTTP 500 must be an error, not an empty config: {result:?}"
        );
    });
}

/// CHN-2: an unparseable body must surface as an error too.
#[test]
fn test_mcp_poll_config_invalid_json_is_error() {
    let mut server = Server::new();
    let _mock = server
        .mock("GET", "/internal/v1/workspaces/ws-1/stdio-servers")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body("not-json")
        .create();

    let url = server.url();
    let rt = tokio::runtime::Runtime::new().expect("create tokio runtime");
    rt.block_on(async {
        let result = xihe_runtime::mcp_session::fetch_stdio_specs(&url, TEST_TOKEN, "ws-1").await;
        assert!(
            result.is_err(),
            "invalid JSON must be an error, not an empty config: {result:?}"
        );
    });
}

/// CHN-2: a transport failure (connection refused) must surface as an error.
#[test]
fn test_mcp_poll_config_unreachable_is_error() {
    let rt = tokio::runtime::Runtime::new().expect("create tokio runtime");
    rt.block_on(async {
        let result =
            xihe_runtime::mcp_session::fetch_stdio_specs("http://127.0.0.1:1", TEST_TOKEN, "ws-1")
                .await;
        assert!(
            result.is_err(),
            "unreachable CP must be an error, not an empty config: {result:?}"
        );
    });
}
