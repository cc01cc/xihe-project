//! Real-process coverage for the one-shot binary file worker protocol.
//!
//! This proves framing and byte preservation only. It does not claim that the
//! worker was launched through a real MXC boundary; that requires wxc-exec and
//! remains an opt-in environment test.

use std::io::Write;
use std::process::{Command, Stdio};

use tempfile::TempDir;
use xihe_runtime::file_worker::encode_binary_request;

#[test]
fn real_worker_process_preserves_binary_bytes() {
    let workspace = TempDir::new().expect("workspace");
    let mut child = Command::new(env!("CARGO_BIN_EXE_xihe-runtime"))
        .args([
            "--file-worker",
            "--workspace",
            workspace.path().to_str().expect("workspace path"),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start real file worker");
    let payload = [0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff];
    let frame = encode_binary_request("nested/data.bin", &payload).expect("frame");
    child
        .stdin
        .take()
        .expect("worker stdin")
        .write_all(&frame)
        .expect("write frame");
    let output = child.wait_with_output().expect("wait for worker");
    assert!(
        output.status.success(),
        "worker failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read(workspace.path().join("nested/data.bin")).expect("binary output"),
        payload
    );
}
