// T3 real integration test — requires a running Control Plane at the configured port.
// Use `#[ignore]` to exclude from default `cargo test`; run explicitly with
// `cargo test -- --ignored` when CP is available.

fn cp_port() -> u16 {
    std::env::var("XIHE_CP_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(12631)
}

fn cp_api_token() -> String {
    std::env::var("XIHE_CP_API_TOKEN").unwrap_or_else(|_| "dev-token-change-me".into())
}

fn cp_url() -> String {
    format!("http://127.0.0.1:{}", cp_port())
}

#[tokio::test]
#[ignore = "requires running Control Plane — set XIHE_CP_PORT and start CP first"]
async fn test_cp_health_endpoint() {
    let resp = reqwest::get(format!("{}/actuator/health", cp_url()))
        .await
        .expect("CP health endpoint should be reachable");
    assert_eq!(resp.status(), 200);

    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["status"], "UP");
}

#[tokio::test]
#[ignore = "requires running Control Plane — set XIHE_CP_PORT and start CP first"]
async fn test_config_client_sync_with_real_cp() {
    let mut client = xihe_runtime::config_client::ConfigClient::new(&cp_url(), &cp_api_token());
    let result = client.sync().await;

    assert!(result.is_ok());

    let provider_api_key = client.get("llm-provider", "openaiApiKey");
    let log_level = client.get("logging", "logLevel");

    assert!(provider_api_key.is_some() || log_level.is_some());
}

#[tokio::test]
#[ignore = "requires running Control Plane — set XIHE_CP_PORT and start CP first"]
async fn test_cp_auth_register_login() {
    let email = format!(
        "test-integration-{}@xihe.local",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );

    let client = reqwest::Client::new();

    let register_body = serde_json::json!({
        "email": email,
        "password": "Test1234!",
        "name": "Integration Test User"
    });

    let reg_resp = client
        .post(format!("{}/api/v1/auth/register", cp_url()))
        .json(&register_body)
        .send()
        .await;

    match reg_resp {
        Ok(resp) => {
            let status = resp.status();
            let body: serde_json::Value = resp.json().await.unwrap_or_default();
            assert!(
                status == 200 || status == 201 || status == 409,
                "register should succeed or report conflict: {status} {body:?}"
            );
        }
        Err(e) => {
            panic!("auth/register request failed: {e}");
        }
    }

    let login_body = serde_json::json!({
        "email": email,
        "password": "Test1234!"
    });

    let login_resp = client
        .post(format!("{}/api/v1/auth/login", cp_url()))
        .json(&login_body)
        .send()
        .await
        .expect("login request should succeed");

    assert_eq!(login_resp.status(), 200);

    let login_body: serde_json::Value = login_resp.json().await.unwrap();
    let token = login_body["accessToken"].as_str();
    assert!(
        token.is_some(),
        "login response should contain accessToken: {login_body:?}"
    );
    assert!(
        !token.unwrap().is_empty(),
        "accessToken should not be empty"
    );
}
