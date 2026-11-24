//! Real-process coverage for the one-shot binary file worker protocol.
//!
//! This proves framing and byte preservation only. It does not claim that the
//! worker was launched through a real MXC boundary; that requires wxc-exec and
//! remains an opt-in environment test.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use tempfile::TempDir;
use xihe_runtime::file_worker::encode_binary_request;

fn run_worker(workspace: &Path, roots: &[(&str, &Path)], frame: &[u8]) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_xihe-runtime"));
    command.args([
        "--file-worker",
        "--workspace",
        workspace.to_str().expect("workspace path"),
    ]);
    for (root_id, host_path) in roots {
        let declaration = format!("{root_id}={}", host_path.to_str().expect("root path"));
        command.args(["--root", declaration.as_str()]);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start real file worker");
    child
        .stdin
        .take()
        .expect("worker stdin")
        .write_all(frame)
        .expect("write frame");
    child.wait_with_output().expect("wait for worker")
}

fn assert_worker_succeeded(output: &std::process::Output) {
    assert!(
        output.status.success(),
        "worker failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn real_worker_process_preserves_binary_bytes() {
    let workspace = TempDir::new().expect("workspace");
    let payload = [0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff];
    let frame = encode_binary_request("nested/data.bin", None, &payload).expect("frame");
    let output = run_worker(workspace.path(), &[], &frame);
    assert_worker_succeeded(&output);
    assert_eq!(
        std::fs::read(workspace.path().join("nested/data.bin")).expect("binary output"),
        payload
    );
}

/// task-979 follow-up: an explicit `rootId` must route the write to that
/// declared root, not to the primary `--workspace` root. This is a real
/// subprocess assertion on the encoded header field, so dropping the
/// `rootId` from the frame turns this test red (file lands elsewhere).
#[test]
fn real_worker_process_routes_binary_write_to_declared_root() {
    let workspace = TempDir::new().expect("workspace");
    let second = TempDir::new().expect("second root");
    let payload = [0xde, 0xad, 0xbe, 0xef];
    let frame = encode_binary_request("routed.bin", Some("rootB"), &payload).expect("frame");
    let output = run_worker(workspace.path(), &[("rootB", second.path())], &frame);
    assert_worker_succeeded(&output);
    assert_eq!(
        std::fs::read(second.path().join("routed.bin")).expect("declared root output"),
        payload
    );
    assert!(
        !workspace.path().join("routed.bin").exists(),
        "explicit rootId must not fall back to the primary workspace root"
    );
}

/// task-979 follow-up: an unknown `rootId` must fail closed instead of
/// silently writing into the primary root.
#[test]
fn real_worker_process_rejects_unknown_root_id() {
    let workspace = TempDir::new().expect("workspace");
    let second = TempDir::new().expect("second root");
    let frame = encode_binary_request("nope.bin", Some("missing"), &[0x01]).expect("frame");
    let output = run_worker(workspace.path(), &[("rootB", second.path())], &frame);
    assert_worker_succeeded(&output);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("\"ok\":false"),
        "unknown rootId must be rejected: {stdout}"
    );
    assert!(
        stdout.contains("INVALID_PATH"),
        "unknown rootId must carry INVALID_PATH: {stdout}"
    );
    assert!(!workspace.path().join("nope.bin").exists());
    assert!(!second.path().join("nope.bin").exists());
}
