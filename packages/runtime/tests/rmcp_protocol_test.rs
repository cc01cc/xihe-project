use std::time::Duration;

use rmcp::model::{ProtocolVersion, RequestStateCodec, SealOptions};
use xihe_runtime::mcp_protocol::{
    LEGACY_INITIALIZE_VERSION, STATELESS_PROTOCOL_VERSION, server_supported_versions,
};

#[test]
fn request_state_round_trips_with_associated_data() {
    let codec = RequestStateCodec::try_new(b"xihe-test-request-state-key-32-bytes!!")
        .expect("test key meets the minimum length");
    let sealed = codec.seal_with(
        b"workspace=ws-1;step=2",
        &SealOptions::new().associated_data(b"user=u-1|server=remote"),
    );

    let payload = codec
        .open_with(&sealed, b"user=u-1|server=remote")
        .expect("matching associated data should open");
    assert_eq!(payload, b"workspace=ws-1;step=2");
}

#[test]
fn request_state_rejects_tampering_and_wrong_associated_data() {
    let codec = RequestStateCodec::try_new(b"xihe-test-request-state-key-32-bytes!!")
        .expect("test key meets the minimum length");
    let sealed = codec.seal_with(
        b"state",
        &SealOptions::new()
            .associated_data(b"workspace=ws-1")
            .ttl(Duration::from_secs(60)),
    );

    assert!(
        codec
            .open_with(&format!("{sealed}x"), b"workspace=ws-1")
            .is_err()
    );
    assert!(codec.open_with(&sealed, b"workspace=ws-2").is_err());
}

#[test]
fn runtime_protocol_target_is_mcp_2026_07_28() {
    assert_eq!(ProtocolVersion::V_2026_07_28.as_str(), "2026-07-28");
}

#[test]
fn server_advertises_the_stateless_generation_first() {
    let versions = server_supported_versions();
    assert_eq!(
        versions.first().map(ProtocolVersion::as_str),
        Some(STATELESS_PROTOCOL_VERSION),
        "the newest advertised generation must be the stateless one"
    );
    assert!(
        versions
            .iter()
            .any(|version| version.as_str() == LEGACY_INITIALIZE_VERSION),
        "legacy clients still negotiate 2025-11-25 over initialize"
    );
}

#[test]
fn initialize_negotiation_cannot_name_the_stateless_generation() {
    // rmcp echoes the requested version only when it still has an initialize
    // handshake; 2026-07-28 moved the lifecycle into per-request `_meta`
    // (SEP-2567), so an initialize request always falls back to 2025-11-25.
    assert!(!ProtocolVersion::V_2026_07_28.has_initialize());
    assert_eq!(
        ProtocolVersion::LATEST_WITH_INITIALIZE.as_str(),
        LEGACY_INITIALIZE_VERSION
    );
    assert!(ProtocolVersion::V_2025_11_25.has_initialize());
}
