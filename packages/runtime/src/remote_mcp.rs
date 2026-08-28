use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use reqwest::{Client, StatusCode, Url, redirect::Policy};
use serde_json::{Value, json};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

pub const MCP_PROTOCOL_VERSION: &str = "2026-07-28";

#[derive(Debug, Error)]
pub enum RemoteMcpError {
    #[error("remote MCP endpoint is not allowed: {0}")]
    EndpointNotAllowed(String),
    #[error("invalid remote MCP endpoint: {0}")]
    InvalidEndpoint(String),
    #[error("remote MCP authorization required")]
    AuthorizationRequired,
    #[error("remote MCP request timed out")]
    Timeout,
    #[error("remote MCP request cancelled")]
    Cancelled,
    #[error("remote MCP returned HTTP {0}")]
    HttpStatus(StatusCode),
    #[error("remote MCP returned invalid JSON")]
    InvalidJson(#[source] reqwest::Error),
    #[error("remote MCP request failed")]
    Request(#[source] reqwest::Error),
    #[error("remote MCP returned a JSON-RPC error: {0}")]
    JsonRpc(String),
    #[error("remote MCP request state is invalid or expired")]
    RequestStateInvalid,
}

/// Business-level request state is deliberately one-shot, in addition to the
/// authenticated/TTL-protected rmcp codec used for wire state.
#[derive(Clone, Default)]
pub struct RequestStateStore {
    states: Arc<Mutex<HashMap<String, Instant>>>,
}

impl RequestStateStore {
    pub fn issue(&self, state: impl Into<String>, ttl: Duration) {
        let mut states = self.states.lock().expect("request state mutex poisoned");
        states.retain(|_, expires_at| *expires_at > Instant::now());
        states.insert(state.into(), Instant::now() + ttl);
    }

    pub fn consume(&self, state: &str) -> Result<(), RemoteMcpError> {
        let mut states = self.states.lock().expect("request state mutex poisoned");
        match states.remove(state) {
            Some(expires_at) if expires_at > Instant::now() => Ok(()),
            _ => Err(RemoteMcpError::RequestStateInvalid),
        }
    }
}

pub struct RemoteMcpConnector {
    client: Client,
    endpoint: Url,
    bearer_token: String,
    next_id: AtomicU64,
    session_id: Mutex<Option<String>>,
    last_event_id: Mutex<Option<String>>,
    pub request_states: RequestStateStore,
}

impl RemoteMcpConnector {
    pub fn new(
        endpoint: &str,
        bearer_token: impl Into<String>,
        timeout: Duration,
    ) -> Result<Self, RemoteMcpError> {
        let endpoint = validate_endpoint(endpoint)?;
        let bearer_token = bearer_token.into();
        if bearer_token.is_empty() {
            return Err(RemoteMcpError::InvalidEndpoint(
                "bearer token must not be empty".into(),
            ));
        }

        let client = Client::builder()
            .timeout(timeout)
            .redirect(Policy::none())
            .build()
            .map_err(RemoteMcpError::Request)?;

        Ok(Self {
            client,
            endpoint,
            bearer_token,
            next_id: AtomicU64::new(1),
            session_id: Mutex::new(None),
            last_event_id: Mutex::new(None),
            request_states: RequestStateStore::default(),
        })
    }

    pub async fn initialize(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<Value, RemoteMcpError> {
        let result = self
            .call(
                "initialize",
                json!({
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": "xihe-runtime", "version": env!("CARGO_PKG_VERSION")}
                }),
                cancellation,
            )
            .await?;
        self.notify("notifications/initialized", json!({}), cancellation)
            .await?;
        Ok(result)
    }

    pub async fn tools_list(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<Value, RemoteMcpError> {
        self.call("tools/list", json!({}), cancellation).await
    }

    pub async fn tools_call(
        &self,
        name: &str,
        arguments: Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RemoteMcpError> {
        self.call(
            "tools/call",
            json!({"name": name, "arguments": arguments}),
            cancellation,
        )
        .await
    }

    /// Reconnects to the server's resumable SSE channel.
    pub async fn get_events(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<Vec<Value>, RemoteMcpError> {
        let mut request = self.request(self.client.get(self.endpoint.clone()));
        request = request.header("Accept", "text/event-stream");
        if let Some(last_event_id) = self
            .last_event_id
            .lock()
            .expect("event mutex poisoned")
            .clone()
        {
            request = request.header("Last-Event-ID", last_event_id);
        }
        let response = self.send(request, cancellation).await?;
        let event_id = response
            .headers()
            .get("Last-Event-ID")
            .and_then(|value| value.to_str().ok())
            .map(ToOwned::to_owned);
        if event_id.is_some() {
            *self.last_event_id.lock().expect("event mutex poisoned") = event_id;
        }
        let body = response.text().await.map_err(RemoteMcpError::Request)?;
        if self
            .last_event_id
            .lock()
            .expect("event mutex poisoned")
            .is_none()
        {
            if let Some(event_id) = last_sse_event_id(&body) {
                *self.last_event_id.lock().expect("event mutex poisoned") = Some(event_id);
            }
        }
        parse_sse_events(&body)
    }

    /// Terminates the remote MCP session. Safe to call repeatedly.
    pub async fn disconnect(&self, cancellation: &CancellationToken) -> Result<(), RemoteMcpError> {
        let Some(session_id) = self
            .session_id
            .lock()
            .expect("session mutex poisoned")
            .clone()
        else {
            return Ok(());
        };
        let request = self
            .request(self.client.delete(self.endpoint.clone()))
            .header("mcp-session-id", session_id);
        self.send(request, cancellation).await.map(|_| ())
    }

    async fn call(
        &self,
        method: &str,
        params: Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RemoteMcpError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let response = self
            .send(
                self.request(self.client.post(self.endpoint.clone()))
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json, text/event-stream")
                    .json(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})),
                cancellation,
            )
            .await?;
        parse_response_body(response).await
    }

    async fn notify(
        &self,
        method: &str,
        params: Value,
        cancellation: &CancellationToken,
    ) -> Result<(), RemoteMcpError> {
        self.send(
            self.request(self.client.post(self.endpoint.clone()))
                .header("Content-Type", "application/json")
                .header("Accept", "application/json, text/event-stream")
                .json(&json!({"jsonrpc": "2.0", "method": method, "params": params})),
            cancellation,
        )
        .await
        .map(|_| ())
    }

    fn request(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let request = request
            .bearer_auth(&self.bearer_token)
            .header("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);
        if let Some(session_id) = self
            .session_id
            .lock()
            .expect("session mutex poisoned")
            .clone()
        {
            request.header("mcp-session-id", session_id)
        } else {
            request
        }
    }

    async fn send(
        &self,
        request: reqwest::RequestBuilder,
        cancellation: &CancellationToken,
    ) -> Result<reqwest::Response, RemoteMcpError> {
        tokio::select! {
            result = request.send() => {
                let response = result.map_err(|error| {
                    if error.is_timeout() {
                        RemoteMcpError::Timeout
                    } else {
                        RemoteMcpError::Request(error)
                    }
                })?;
                if response.status() == StatusCode::UNAUTHORIZED {
                    return Err(RemoteMcpError::AuthorizationRequired);
                }
                if !response.status().is_success() {
                    return Err(RemoteMcpError::HttpStatus(response.status()));
                }
                if let Some(session_id) = response
                    .headers()
                    .get("mcp-session-id")
                    .and_then(|value| value.to_str().ok())
                {
                    *self.session_id.lock().expect("session mutex poisoned") = Some(session_id.to_owned());
                }
                Ok(response)
            }
            _ = cancellation.cancelled() => Err(RemoteMcpError::Cancelled),
        }
    }
}

async fn parse_response_body(response: reqwest::Response) -> Result<Value, RemoteMcpError> {
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let body = response.text().await.map_err(RemoteMcpError::Request)?;
    if content_type.starts_with("text/event-stream") {
        let events = parse_sse_events(&body)?;
        return events
            .into_iter()
            .next()
            .ok_or_else(|| RemoteMcpError::JsonRpc("empty SSE response".into()))
            .and_then(parse_response);
    }
    let body = serde_json::from_str(&body)
        .map_err(|error| RemoteMcpError::JsonRpc(format!("invalid JSON: {error}")))?;
    parse_response(body)
}

fn parse_sse_events(body: &str) -> Result<Vec<Value>, RemoteMcpError> {
    body.split("\n\n")
        .filter_map(|event| {
            let data = event
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(str::trim)
                .collect::<Vec<_>>();
            (!data.is_empty()).then(|| data.join("\n"))
        })
        .map(|data| {
            serde_json::from_str(&data)
                .map_err(|error| RemoteMcpError::JsonRpc(format!("invalid SSE JSON: {error}")))
        })
        .collect()
}

fn last_sse_event_id(body: &str) -> Option<String> {
    body.lines()
        .filter_map(|line| line.strip_prefix("id:"))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .next_back()
}

pub fn validate_endpoint(endpoint: &str) -> Result<Url, RemoteMcpError> {
    let url =
        Url::parse(endpoint).map_err(|error| RemoteMcpError::InvalidEndpoint(error.to_string()))?;
    let allow_local_http =
        std::env::var("XIHE_REMOTE_MCP_ALLOW_INSECURE_LOCAL").is_ok_and(|value| value == "true");
    let local_http = url.scheme() == "http"
        && allow_local_http
        && url
            .host_str()
            .is_some_and(|host| host.eq_ignore_ascii_case("host.docker.internal"));
    if url
        .host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case("host.docker.internal"))
        && !local_http
    {
        return Err(RemoteMcpError::EndpointNotAllowed(
            "host.docker.internal is allowed only for explicit local HTTP development".into(),
        ));
    }
    if url.scheme() != "https" && !local_http {
        return Err(RemoteMcpError::EndpointNotAllowed(
            "HTTPS is required".into(),
        ));
    }
    if url.username() != "" || url.password().is_some() {
        return Err(RemoteMcpError::EndpointNotAllowed(
            "userinfo is not allowed".into(),
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| RemoteMcpError::InvalidEndpoint("endpoint must include a host".into()))?;
    let host_lower = host.to_ascii_lowercase();
    if host_lower == "localhost"
        || host_lower.ends_with(".localhost")
        || host_lower == "localhost.localdomain"
    {
        return Err(RemoteMcpError::EndpointNotAllowed(
            "localhost is not allowed".into(),
        ));
    }
    if let Ok(ip) = host.trim_matches(['[', ']']).parse::<IpAddr>()
        && is_private_or_local(ip)
    {
        return Err(RemoteMcpError::EndpointNotAllowed(
            "private or local IP is not allowed".into(),
        ));
    }
    if !local_http && url.port().is_some_and(|port| port != 443) {
        return Err(RemoteMcpError::EndpointNotAllowed(
            "only ports 443 and 80 are allowed".into(),
        ));
    }
    Ok(url)
}

pub async fn validate_endpoint_dns(endpoint: &Url) -> Result<(), RemoteMcpError> {
    if endpoint
        .host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case("host.docker.internal"))
    {
        return Ok(());
    }
    let host = endpoint
        .host_str()
        .ok_or_else(|| RemoteMcpError::InvalidEndpoint("endpoint must include a host".into()))?;
    let port = endpoint
        .port_or_known_default()
        .ok_or_else(|| RemoteMcpError::InvalidEndpoint("endpoint must include a port".into()))?;
    let addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| {
            RemoteMcpError::EndpointNotAllowed(format!("DNS lookup failed: {error}"))
        })?;
    for address in addresses {
        if is_private_or_local(address.ip()) {
            return Err(RemoteMcpError::EndpointNotAllowed(
                "DNS resolved to a private or local IP".into(),
            ));
        }
    }
    Ok(())
}

fn is_private_or_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_broadcast()
        }
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip.is_multicast()
                || is_ipv4_mapped_local(ip)
        }
    }
}

fn is_ipv4_mapped_local(ip: Ipv6Addr) -> bool {
    ip.to_ipv4_mapped().is_some_and(is_private_or_local_v4)
}

fn is_private_or_local_v4(ip: Ipv4Addr) -> bool {
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_broadcast()
}

fn parse_response(body: Value) -> Result<Value, RemoteMcpError> {
    if let Some(error) = body.get("error") {
        return Err(RemoteMcpError::JsonRpc(error.to_string()));
    }
    body.get("result")
        .cloned()
        .ok_or_else(|| RemoteMcpError::JsonRpc("response has neither result nor error".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_policy_rejects_insecure_private_and_unapproved_urls() {
        for endpoint in [
            "http://example.com/mcp",
            "https://localhost/mcp",
            "https://127.0.0.1/mcp",
            "https://10.0.0.1/mcp",
            "https://[::1]/mcp",
            "https://example.com:8443/mcp",
        ] {
            assert!(
                validate_endpoint(endpoint).is_err(),
                "{endpoint} should be rejected"
            );
        }
        assert!(validate_endpoint("https://example.com/mcp").is_ok());
        assert!(validate_endpoint("https://example.com:443/mcp").is_ok());
    }

    #[test]
    fn response_parser_returns_result_or_sanitized_rpc_error() {
        assert_eq!(
            parse_response(json!({"result": {"ok": true}})).unwrap(),
            json!({"ok": true})
        );
        let error =
            parse_response(json!({"error": {"code": -1, "message": "failed"}})).unwrap_err();
        assert!(matches!(error, RemoteMcpError::JsonRpc(_)));
    }

    #[test]
    fn request_state_is_expired_and_one_shot() {
        let store = RequestStateStore::default();
        store.issue("state-1", Duration::from_secs(60));
        assert!(store.consume("state-1").is_ok());
        assert!(matches!(
            store.consume("state-1"),
            Err(RemoteMcpError::RequestStateInvalid)
        ));
    }

    #[test]
    fn sse_parser_decodes_multiple_json_events() {
        let events = parse_sse_events(
            "id: 1\ndata: {\"result\":{\"ok\":true}}\n\ndata: {\"result\":{\"n\":2}}\n\n",
        )
        .unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1]["result"]["n"], 2);
    }
}
