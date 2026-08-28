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

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct RequestStateBinding {
    pub user_id: String,
    pub workspace_id: String,
    pub server_id: String,
    pub scope: String,
}

#[derive(Clone)]
struct RequestStateEntry {
    expires_at: Instant,
    binding: RequestStateBinding,
    state: Value,
}

/// Business-level request state is deliberately one-shot, in addition to the
/// authenticated/TTL-protected rmcp codec used for wire state.
#[derive(Clone, Default)]
pub struct RequestStateStore {
    states: Arc<Mutex<HashMap<String, RequestStateEntry>>>,
}

impl RequestStateStore {
    pub fn issue_for(&self, binding: RequestStateBinding, state: Value, ttl: Duration) {
        let key = state_key(&binding, &state);
        let mut states = self.states.lock().expect("request state mutex poisoned");
        states.retain(|_, entry| entry.expires_at > Instant::now());
        states.insert(
            key,
            RequestStateEntry {
                expires_at: Instant::now() + ttl,
                binding,
                state,
            },
        );
    }

    pub fn consume_for(
        &self,
        binding: &RequestStateBinding,
        state: &Value,
    ) -> Result<(), RemoteMcpError> {
        let key = state_key(binding, state);
        let mut states = self.states.lock().expect("request state mutex poisoned");
        match states.remove(&key) {
            Some(entry)
                if entry.binding == *binding
                    && entry.state == *state
                    && entry.expires_at > Instant::now() =>
            {
                Ok(())
            }
            _ => Err(RemoteMcpError::RequestStateInvalid),
        }
    }

    pub fn validate_for(
        &self,
        binding: &RequestStateBinding,
        state: &Value,
    ) -> Result<(), RemoteMcpError> {
        let states = self.states.lock().expect("request state mutex poisoned");
        match states.get(&state_key(binding, state)) {
            Some(entry)
                if entry.binding == *binding
                    && entry.state == *state
                    && entry.expires_at > Instant::now() =>
            {
                Ok(())
            }
            _ => Err(RemoteMcpError::RequestStateInvalid),
        }
    }

    #[cfg(test)]
    pub fn issue(&self, state: impl Into<String>, ttl: Duration) {
        self.issue_for(
            RequestStateBinding {
                user_id: "test-user".into(),
                workspace_id: "test-workspace".into(),
                server_id: "test-server".into(),
                scope: "test-scope".into(),
            },
            Value::String(state.into()),
            ttl,
        );
    }

    #[cfg(test)]
    pub fn consume(&self, state: &str) -> Result<(), RemoteMcpError> {
        self.consume_for(
            &RequestStateBinding {
                user_id: "test-user".into(),
                workspace_id: "test-workspace".into(),
                server_id: "test-server".into(),
                scope: "test-scope".into(),
            },
            &Value::String(state.into()),
        )
    }
}

fn state_key(binding: &RequestStateBinding, state: &Value) -> String {
    format!(
        "{}\0{}\0{}\0{}\0{}",
        binding.user_id, binding.workspace_id, binding.server_id, binding.scope, state
    )
}

pub struct RemoteMcpConnector {
    client: Client,
    endpoint: Url,
    bearer_token: String,
    next_id: AtomicU64,
    session_id: Mutex<Option<String>>,
    last_event_id: Mutex<Option<String>>,
    pub request_states: RequestStateStore,
    request_state_binding: RequestStateBinding,
}

impl RemoteMcpConnector {
    pub fn new(
        endpoint: &str,
        bearer_token: impl Into<String>,
        timeout: Duration,
    ) -> Result<Self, RemoteMcpError> {
        Self::new_with_context(
            endpoint,
            bearer_token,
            timeout,
            RequestStateBinding {
                user_id: "unknown".into(),
                workspace_id: "unknown".into(),
                server_id: "unknown".into(),
                scope: "unknown".into(),
            },
            RequestStateStore::default(),
        )
    }

    pub fn new_with_context(
        endpoint: &str,
        bearer_token: impl Into<String>,
        timeout: Duration,
        request_state_binding: RequestStateBinding,
        request_states: RequestStateStore,
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
            request_states,
            request_state_binding,
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
        self.tools_call_with_state(name, arguments, None, cancellation)
            .await
    }

    pub async fn tools_call_with_state(
        &self,
        name: &str,
        arguments: Value,
        request_state: Option<Value>,
        cancellation: &CancellationToken,
    ) -> Result<Value, RemoteMcpError> {
        if let Some(state) = request_state.as_ref() {
            self.request_states
                .validate_for(&self.request_state_binding, state)?;
        }
        let mut params = json!({"name": name, "arguments": arguments});
        if let Some(state) = request_state.as_ref() {
            params["requestState"] = state.clone();
        }
        let result = self.call("tools/call", params, cancellation).await?;
        if let Some(state) = request_state.as_ref() {
            self.request_states
                .consume_for(&self.request_state_binding, state)?;
        }
        Ok(result)
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
            && let Some(event_id) = last_sse_event_id(&body)
        {
            *self.last_event_id.lock().expect("event mutex poisoned") = Some(event_id);
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
        let result = parse_response_body(response).await?;
        if let Some(state) = result.get("requestState") {
            if !state.is_object() {
                return Err(RemoteMcpError::RequestStateInvalid);
            }
            self.request_states.issue_for(
                self.request_state_binding.clone(),
                state.clone(),
                Duration::from_secs(300),
            );
        }
        Ok(result)
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
    validate_endpoint_with_allowlist(endpoint, &[])
}

pub fn validate_endpoint_with_allowlist(
    endpoint: &str,
    allowed_hosts: &[String],
) -> Result<Url, RemoteMcpError> {
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
    if !allowed_hosts.is_empty()
        && !allowed_hosts
            .iter()
            .any(|allowed| host_matches_allowlist(&host_lower, allowed))
    {
        return Err(RemoteMcpError::EndpointNotAllowed(
            "host is not in the configured allowlist".into(),
        ));
    }
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

fn host_matches_allowlist(host: &str, allowed: &str) -> bool {
    let allowed = allowed.trim().trim_end_matches('.').to_ascii_lowercase();
    if allowed.is_empty() {
        return false;
    }
    host == allowed || (allowed.starts_with("*.") && host.ends_with(&allowed[1..]))
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
    use axum::body::to_bytes;
    use axum::extract::State;
    use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode as AxumStatusCode};
    use axum::routing::any;
    use axum::{Router, body::Body, http::Request, response::Response};
    use std::sync::atomic::AtomicBool;
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;

    #[derive(Clone, Default)]
    struct WireFixture {
        requests: Arc<Mutex<Vec<(Method, HeaderMap, Value)>>>,
        delay: Arc<AtomicBool>,
    }

    async fn wire_handler(
        State(fixture): State<WireFixture>,
        request: Request<Body>,
    ) -> Response<Body> {
        let (parts, body) = request.into_parts();
        let bytes = to_bytes(body, usize::MAX).await.expect("read fixture body");
        let payload = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).expect("fixture received JSON")
        };
        fixture
            .requests
            .lock()
            .expect("fixture mutex poisoned")
            .push((parts.method.clone(), parts.headers.clone(), payload.clone()));

        if fixture.delay.load(Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
        match (parts.method, payload.get("method").and_then(Value::as_str)) {
            (Method::POST, Some("initialize")) => json_response(
                serde_json::json!({
                    "jsonrpc": "2.0", "id": payload["id"],
                    "result": {"protocolVersion": MCP_PROTOCOL_VERSION, "capabilities": {}, "requestState": {"nonce": "live-1"}}
                }),
                Some(("mcp-session-id", "session-live")),
            ),
            (Method::POST, Some("notifications/initialized")) => json_response(
                serde_json::json!({}),
                Some(("mcp-session-id", "session-live")),
            ),
            (Method::POST, Some("tools/list")) => json_response(
                serde_json::json!({
                    "jsonrpc": "2.0", "id": payload["id"],
                    "result": {"tools": [{"name": "echo", "description": "Echo", "inputSchema": {"type": "object"}}]}
                }),
                Some(("mcp-session-id", "session-live")),
            ),
            (Method::POST, Some("tools/call")) => json_response(
                serde_json::json!({
                    "jsonrpc": "2.0", "id": payload["id"],
                    "result": {"content": [{"type": "text", "text": "wire-ok"}]}
                }),
                Some(("mcp-session-id", "session-live")),
            ),
            (Method::GET, None) => {
                let mut response = Response::new(Body::from(
                    "id: evt-2\ndata: {\"jsonrpc\":\"2.0\",\"result\":{\"ok\":true}}\n\n",
                ));
                response.headers_mut().insert(
                    "content-type",
                    "text/event-stream".parse().expect("content type"),
                );
                response
                    .headers_mut()
                    .insert("last-event-id", "evt-2".parse().expect("event id"));
                response
            }
            (Method::DELETE, None) => Response::builder()
                .status(AxumStatusCode::NO_CONTENT)
                .body(Body::empty())
                .expect("build delete response"),
            _ => Response::builder()
                .status(AxumStatusCode::BAD_REQUEST)
                .body(Body::empty())
                .expect("build bad request response"),
        }
    }

    fn json_response(body: Value, session: Option<(&str, &str)>) -> Response<Body> {
        let mut response = Response::new(Body::from(body.to_string()));
        response.headers_mut().insert(
            "content-type",
            "application/json".parse().expect("content type"),
        );
        if let Some((_name, value)) = session {
            response.headers_mut().insert(
                HeaderName::from_static("mcp-session-id"),
                HeaderValue::from_str(value).expect("session id"),
            );
        }
        response
    }

    async fn fixture() -> (WireFixture, String, oneshot::Sender<()>) {
        let fixture = WireFixture::default();
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fixture");
        let endpoint = format!(
            "http://{}/mcp",
            listener.local_addr().expect("fixture address")
        );
        let (shutdown, signal) = oneshot::channel();
        let router = Router::new()
            .fallback(any(wire_handler))
            .with_state(fixture.clone());
        tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    signal.await.ok();
                })
                .await
                .expect("serve fixture");
        });
        (fixture, endpoint, shutdown)
    }

    fn local_connector(endpoint: &str, states: RequestStateStore) -> RemoteMcpConnector {
        RemoteMcpConnector {
            client: Client::builder()
                .timeout(Duration::from_secs(1))
                .redirect(Policy::none())
                .build()
                .expect("build test client"),
            endpoint: Url::parse(endpoint).expect("parse fixture endpoint"),
            bearer_token: "access-live".into(),
            next_id: AtomicU64::new(1),
            session_id: Mutex::new(None),
            last_event_id: Mutex::new(None),
            request_states: states,
            request_state_binding: RequestStateBinding {
                user_id: "user-1".into(),
                workspace_id: "ws-1".into(),
                server_id: "server-1".into(),
                scope: "mcp:tools".into(),
            },
        }
    }

    #[tokio::test]
    async fn wire_protocol_preserves_auth_session_state_sse_and_disconnect() {
        let (fixture, endpoint, shutdown) = fixture().await;
        let connector = local_connector(&endpoint, RequestStateStore::default());
        let cancellation = CancellationToken::new();

        let initialized = connector
            .initialize(&cancellation)
            .await
            .expect("initialize");
        assert_eq!(initialized["requestState"]["nonce"], "live-1");
        connector
            .tools_list(&cancellation)
            .await
            .expect("tools/list");
        let result = connector
            .tools_call_with_state(
                "echo",
                json!({"value": "hello"}),
                Some(json!({"nonce": "live-1"})),
                &cancellation,
            )
            .await
            .expect("tools/call");
        assert_eq!(result["content"][0]["text"], "wire-ok");

        connector
            .get_events(&cancellation)
            .await
            .expect("SSE reconnect");
        connector
            .get_events(&cancellation)
            .await
            .expect("SSE resume");
        connector
            .disconnect(&cancellation)
            .await
            .expect("disconnect");

        let requests = fixture.requests.lock().expect("fixture mutex poisoned");
        assert_eq!(requests.len(), 7);
        assert_eq!(requests[0].0, Method::POST);
        assert_eq!(requests[0].1["authorization"], "Bearer access-live");
        assert_eq!(requests[0].1["mcp-protocol-version"], MCP_PROTOCOL_VERSION);
        assert_eq!(
            requests[0].2["params"]["protocolVersion"],
            MCP_PROTOCOL_VERSION
        );
        assert!(requests[1].2.get("id").is_none());
        assert_eq!(requests[2].2["method"], "tools/list");
        assert_eq!(requests[3].2["params"]["requestState"]["nonce"], "live-1");
        assert!(requests[4].1.get("last-event-id").is_none());
        assert_eq!(requests[5].1["last-event-id"], "evt-2");
        assert_eq!(requests[6].0, Method::DELETE);
        assert_eq!(requests[6].1["mcp-session-id"], "session-live");
        drop(requests);
        shutdown.send(()).expect("stop fixture");
    }

    #[tokio::test]
    async fn wire_cancellation_is_observable_and_401_is_not_silently_retried() {
        let (fixture, endpoint, shutdown) = fixture().await;
        fixture.delay.store(true, Ordering::Relaxed);
        let connector = local_connector(&endpoint, RequestStateStore::default());
        let cancellation = CancellationToken::new();
        let task = tokio::spawn({
            let cancellation = cancellation.clone();
            async move { connector.tools_list(&cancellation).await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        cancellation.cancel();
        assert!(matches!(
            task.await.expect("join request"),
            Err(RemoteMcpError::Cancelled)
        ));
        shutdown.send(()).expect("stop fixture");
    }

    #[test]
    fn request_state_rejects_expired_and_wrong_bindings_without_consuming_valid_state() {
        let store = RequestStateStore::default();
        let binding = RequestStateBinding {
            user_id: "u".into(),
            workspace_id: "w".into(),
            server_id: "s".into(),
            scope: "read".into(),
        };
        let state = json!({"nonce": "one"});
        store.issue_for(binding.clone(), state.clone(), Duration::from_millis(1));
        std::thread::sleep(Duration::from_millis(5));
        assert!(matches!(
            store.validate_for(&binding, &state),
            Err(RemoteMcpError::RequestStateInvalid)
        ));
        store.issue_for(binding.clone(), state.clone(), Duration::from_secs(1));
        let mut wrong = binding.clone();
        wrong.scope = "write".into();
        assert!(matches!(
            store.consume_for(&wrong, &state),
            Err(RemoteMcpError::RequestStateInvalid)
        ));
        assert!(store.consume_for(&binding, &state).is_ok());
    }

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
    fn request_state_is_bound_to_all_context_fields() {
        let store = RequestStateStore::default();
        let binding = RequestStateBinding {
            user_id: "user-1".into(),
            workspace_id: "workspace-1".into(),
            server_id: "server-1".into(),
            scope: "read".into(),
        };
        let state = json!({"required": ["value"]});
        store.issue_for(binding.clone(), state.clone(), Duration::from_secs(60));

        let mut wrong = binding.clone();
        wrong.workspace_id = "workspace-2".into();
        assert!(matches!(
            store.consume_for(&wrong, &state),
            Err(RemoteMcpError::RequestStateInvalid)
        ));
        assert!(store.consume_for(&binding, &state).is_ok());
        assert!(matches!(
            store.consume_for(&binding, &state),
            Err(RemoteMcpError::RequestStateInvalid)
        ));
    }

    #[test]
    fn endpoint_allowlist_supports_exact_and_subdomain_entries() {
        let allowed = vec!["example.com".to_string(), "*.trusted.example".to_string()];
        assert!(validate_endpoint_with_allowlist("https://example.com/mcp", &allowed).is_ok());
        assert!(
            validate_endpoint_with_allowlist("https://mcp.trusted.example/mcp", &allowed).is_ok()
        );
        assert!(validate_endpoint_with_allowlist("https://evil.example", &allowed).is_err());
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
