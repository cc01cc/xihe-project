//! XH Channel Protocol v1 envelope (PLAN-245).
//!
//! Transport-independent: one JSON object per WebSocket text frame today; the
//! same envelope may later ride QUIC/stdio without field changes. See
//! plans/research/PLAN-245-xh-channel-protocol.md for the full contract.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: i64 = 1;

pub const TYPE_HELLO: &str = "hello";
pub const TYPE_WELCOME: &str = "welcome";
pub const TYPE_REQUEST: &str = "request";
pub const TYPE_RESPONSE: &str = "response";
pub const TYPE_EVENT: &str = "event";
pub const TYPE_ACK: &str = "ack";
pub const TYPE_RESYNC_REQUIRED: &str = "resync_required";
pub const TYPE_ERROR: &str = "error";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: i64,
    pub message_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub source: String,
    pub target: String,
    pub sent_at: String,
    pub sequence: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default)]
    pub payload: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ChannelError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelError {
    pub code: String,
    #[serde(default)]
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

/// Per-workspace summary carried in hello (read from WorkspaceRegistry).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub workspace_id: String,
    pub generation: u64,
    pub sandbox_spec_hash: String,
    pub state: String,
}

impl Envelope {
    pub fn new(kind: &str, source: &str, target: &str, sequence: i64) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            message_id: uuid::Uuid::new_v4().to_string(),
            kind: kind.to_string(),
            source: source.to_string(),
            target: target.to_string(),
            sent_at: chrono::Utc::now().to_rfc3339(),
            sequence,
            request_id: None,
            correlation_id: None,
            device_id: None,
            workspace_id: None,
            run_id: None,
            payload: serde_json::Value::Object(serde_json::Map::new()),
            error: None,
        }
    }

    pub fn parse(text: &str) -> Result<Self, String> {
        let envelope: Envelope =
            serde_json::from_str(text).map_err(|e| format!("invalid envelope: {e}"))?;
        if envelope.protocol_version != PROTOCOL_VERSION {
            return Err(format!(
                "protocol version mismatch: {} != {PROTOCOL_VERSION}",
                envelope.protocol_version
            ));
        }
        Ok(envelope)
    }

    pub fn encode(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|e| format!("encode failed: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_preserves_fields() {
        let mut env = Envelope::new(TYPE_HELLO, "runtime", "control-plane", 7);
        env.device_id = Some(uuid::Uuid::new_v4().to_string());
        env.payload = serde_json::json!({
            "workspaces": [WorkspaceSummary {
                workspace_id: "ws-1".into(),
                generation: 3,
                sandbox_spec_hash: "abc".into(),
                state: "Ready".into(),
            }]
        });
        let text = env.encode().unwrap();
        let parsed = Envelope::parse(&text).unwrap();
        assert_eq!(parsed.kind, TYPE_HELLO);
        assert_eq!(parsed.sequence, 7);
        assert_eq!(parsed.payload["workspaces"][0]["generation"], 3);
    }

    #[test]
    fn rejects_protocol_version_mismatch() {
        let text = r#"{"protocolVersion":99,"messageId":"m","type":"hello","source":"runtime","target":"control-plane","sentAt":"2026-09-05T00:00:00Z","sequence":1,"payload":{}}"#;
        let err = Envelope::parse(text).unwrap_err();
        assert!(err.contains("protocol version mismatch"));
    }

    #[test]
    fn rejects_unparseable() {
        assert!(Envelope::parse("not json").is_err());
    }
}
