use std::time::Duration;

use rmcp::model::{ProtocolVersion, RequestStateCodec, SealOptions};

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
