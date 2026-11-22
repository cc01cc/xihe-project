//! MCP protocol generation contract exposed by the Runtime MCP server.
//!
//! The logical MCP surface is `2026-07-28` (stateless, per-request `_meta`).
//! That generation has no `initialize` handshake (SEP-2567), so a client that
//! posts `initialize` can only ever negotiate the newest generation that still
//! has one. Keep this list in one place: the server handler, the CP gateway and
//! the agent client must agree on the same contract.

use std::borrow::Cow;

use rmcp::model::ProtocolVersion;

/// The generation the logical MCP surface serves (and what CP/agent declare).
pub const STATELESS_PROTOCOL_VERSION: &str = "2026-07-28";

/// The newest generation that still negotiates through `initialize`.
pub const LEGACY_INITIALIZE_VERSION: &str = "2025-11-25";

/// Advertised generations, newest first. `initialize` is answered with the
/// newest entry that still has a handshake.
pub const SUPPORTED: [ProtocolVersion; 4] = [
    ProtocolVersion::V_2026_07_28,
    ProtocolVersion::V_2025_11_25,
    ProtocolVersion::V_2025_06_18,
    ProtocolVersion::V_2025_03_26,
];

pub fn server_supported_versions() -> Cow<'static, [ProtocolVersion]> {
    Cow::Borrowed(&SUPPORTED[..])
}
