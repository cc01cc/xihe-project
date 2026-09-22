//! PLAN-0400 real MXC file-worker boundary matrix.
//!
//! Run explicitly on a Windows host with the verified MXC binary:
//!
//! ```text
//! $env:XIHE_JOB_MXC='1'
//! $env:XIHE_MXC_EXEC='C:\\Users\\zeoneo\\AppData\\Local\\Temp\\kilo\\mxc\\x64\\wxc-exec.exe'
//! $env:XIHE_MXC_EXECUTABLE=$env:XIHE_MXC_EXEC
//! cargo test --test file_worker_mxc -- --ignored --nocapture
//! ```

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use xihe_runtime::file_worker::encode_binary_request;
use xihe_runtime::job_engine::{JobEngine, JobStatus};
use xihe_runtime::job_mxc_adapter::{MxcJobRequest, build_mxc_job};

fn wait_terminal(engine: &JobEngine, job_id: &str) -> xihe_runtime::job_engine::JobSnapshot {
    let started = Instant::now();
    loop {
        let snapshot = engine.snapshot(job_id).expect("snapshot");
        if snapshot.status.is_terminal() {
            return snapshot;
        }
        assert!(
            started.elapsed() < Duration::from_secs(45),
            "file worker did not terminate: {job_id}"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn text_frame(operation: &str, payload: Value) -> Vec<u8> {
    let mut frame = serde_json::to_vec(&serde_json::json!({
        "operation": operation,
        "payload": payload,
    }))
    .expect("text frame");
    frame.push(b'\n');
    frame
}

fn sha256_hex(value: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value);
    format!("{:x}", hasher.finalize())
}

fn run_worker(root: &Path, frame: Vec<u8>) -> (JobStatus, Value, PathBuf) {
    let state = TempDir::new().expect("job state");
    let engine = JobEngine::new("plan0400-file-worker", state.path().to_path_buf());
    let job_id = format!("file-worker-{}", uuid::Uuid::new_v4());
    let executable = std::env::var("CARGO_BIN_EXE_xihe-runtime")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::current_exe()
                .expect("test executable")
                .parent()
                .expect("test directory")
                .join("xihe-runtime.exe")
        });
    let plan = build_mxc_job(
        MxcJobRequest {
            workspace_path: root.to_string_lossy().into_owned(),
            command: executable.to_string_lossy().into_owned(),
            args: vec![
                "--file-worker".to_string(),
                "--workspace".to_string(),
                root.to_string_lossy().into_owned(),
            ],
            cwd: Some(root.to_string_lossy().into_owned()),
            env: BTreeMap::new(),
            timeout_secs: 30,
        },
        &engine.output_dir(&job_id),
    )
    .expect("build MXC worker policy");
    engine
        .start_in_workspace_with_stdin(Some("plan0400"), &job_id, plan, Some(frame))
        .expect("start MXC file worker");
    let snapshot = wait_terminal(&engine, &job_id);
    let stdout = engine
        .read_output(&job_id, "stdout", Some(0), Some(1024 * 1024))
        .expect("worker stdout")
        .data;
    let response: Value = serde_json::from_str(
        stdout
            .lines()
            .rfind(|line| !line.trim().is_empty())
            .expect("worker response"),
    )
    .expect("worker response JSON");
    engine.cleanup(&job_id).expect("worker cleanup");
    (snapshot.status, response, state.path().to_path_buf())
}

#[test]
#[ignore = "requires verified wxc-exec and explicit XIHE_MXC_EXECUTABLE"]
fn mxc_file_worker_real_boundary_matrix() {
    let executable = std::env::var("XIHE_MXC_EXECUTABLE").expect("XIHE_MXC_EXECUTABLE");
    assert!(
        Path::new(&executable).is_file(),
        "wxc-exec not found: {executable}"
    );
    assert_eq!(
        std::env::var("XIHE_JOB_MXC").as_deref(),
        Ok("1"),
        "set XIHE_JOB_MXC=1"
    );

    let isolated_root = Path::new(r"H:\zeogit\one\.local");
    let workspace = tempfile::tempdir_in(isolated_root).expect("workspace");
    let outside = tempfile::tempdir_in(isolated_root).expect("outside");
    fs::write(workspace.path().join("source.txt"), "source").expect("source");
    let outside_marker = outside.path().join("marker.txt");

    let (status, inside, _) = run_worker(
        workspace.path(),
        text_frame(
            "write_file",
            serde_json::json!({"path": "inside.txt", "content": "inside"}),
        ),
    );
    assert_eq!(status, JobStatus::Succeeded);
    assert_eq!(inside["ok"], true, "inside write response: {inside}");
    assert_eq!(
        fs::read_to_string(workspace.path().join("inside.txt")).unwrap(),
        "inside"
    );

    let (status, traversal, _) = run_worker(
        workspace.path(),
        text_frame(
            "write_file",
            serde_json::json!({"path": "../outside/marker.txt", "content": "escape"}),
        ),
    );
    assert_eq!(status, JobStatus::Succeeded);
    assert_eq!(traversal["ok"], false);
    assert_eq!(traversal["errorCode"], "BOUNDARY_DENIED");
    assert!(!outside_marker.exists(), "outside marker was created");

    let (status, absolute, _) = run_worker(
        workspace.path(),
        text_frame(
            "copy_file",
            serde_json::json!({
                "from": "source.txt",
                "to": outside_marker.to_string_lossy(),
            }),
        ),
    );
    assert_eq!(status, JobStatus::Succeeded);
    assert_eq!(absolute["ok"], false);
    assert_eq!(absolute["errorCode"], "BOUNDARY_DENIED");
    assert!(!outside_marker.exists(), "absolute outside copy escaped");

    let (status, binary, _) = run_worker(
        workspace.path(),
        encode_binary_request("binary/data.bin", &[0, 1, 127, 128, 254, 255]).unwrap(),
    );
    assert_eq!(status, JobStatus::Succeeded);
    assert_eq!(binary["ok"], true);
    assert_eq!(
        fs::read(workspace.path().join("binary/data.bin")).unwrap(),
        [0, 1, 127, 128, 254, 255]
    );

    for (operation, payload, expected_key) in [
        (
            "read_file",
            serde_json::json!({"path": "source.txt"}),
            "content",
        ),
        (
            "read_file_range",
            serde_json::json!({"path": "source.txt", "offset": 0, "limit": 3}),
            "content",
        ),
        (
            "list_directory",
            serde_json::json!({"path": "."}),
            "entries",
        ),
        (
            "get_file_info",
            serde_json::json!({"path": "source.txt"}),
            "name",
        ),
        (
            "glob",
            serde_json::json!({"path": ".", "pattern": "*.txt"}),
            "",
        ),
        (
            "grep",
            serde_json::json!({"path": ".", "pattern": "source"}),
            "",
        ),
    ] {
        let (status, response, _) = run_worker(workspace.path(), text_frame(operation, payload));
        assert_eq!(status, JobStatus::Succeeded, "{operation}: {response}");
        assert_eq!(response["ok"], true, "{operation}: {response}");
        if expected_key.is_empty() {
            assert!(!response["result"].is_null(), "{operation}: {response}");
        } else {
            assert!(
                !response["result"][expected_key].is_null(),
                "{operation}: {response}"
            );
        }
    }

    for operation in ["watch_directory", "extract_pdf_text"] {
        let (status, response, _) = run_worker(
            workspace.path(),
            text_frame(operation, serde_json::json!({"path": "source.txt"})),
        );
        assert_eq!(status, JobStatus::Succeeded);
        assert_eq!(response["ok"], false, "{operation}: {response}");
        assert_eq!(
            response["errorCode"], "UNSUPPORTED",
            "{operation}: {response}"
        );
    }

    let (status, mkdir, _) = run_worker(
        workspace.path(),
        text_frame("mkdir", serde_json::json!({"path": "nested"})),
    );
    assert_eq!(status, JobStatus::Succeeded);
    assert_eq!(mkdir["ok"], true, "mkdir: {mkdir}");
    let (status, nested_write, _) = run_worker(
        workspace.path(),
        text_frame(
            "write_file",
            serde_json::json!({"path": "nested/file.txt", "content": "nested"}),
        ),
    );
    assert_eq!(status, JobStatus::Succeeded);
    assert_eq!(nested_write["ok"], true, "nested write: {nested_write}");
    let (status, edit, _) = run_worker(
        workspace.path(),
        text_frame(
            "edit_file",
            serde_json::json!({
                "filePath": "nested/file.txt",
                "oldString": "nested",
                "newString": "edited",
                "replaceAll": false
            }),
        ),
    );
    assert_eq!(status, JobStatus::Succeeded);
    assert_eq!(edit["ok"], true, "edit: {edit}");
    assert_eq!(
        fs::read_to_string(workspace.path().join("nested/file.txt")).unwrap(),
        "edited"
    );
    let (status, copy, _) = run_worker(
        workspace.path(),
        text_frame(
            "copy_file",
            serde_json::json!({"from": "nested/file.txt", "to": "copied.txt"}),
        ),
    );
    assert_eq!(status, JobStatus::Succeeded);
    assert_eq!(copy["ok"], true, "copy: {copy}");
    let (status, move_result, _) = run_worker(
        workspace.path(),
        text_frame(
            "move_file",
            serde_json::json!({"from": "copied.txt", "to": "moved.txt"}),
        ),
    );
    assert_eq!(status, JobStatus::Succeeded);
    assert_eq!(move_result["ok"], true, "move: {move_result}");
    let (status, delete, _) = run_worker(
        workspace.path(),
        text_frame("delete_file", serde_json::json!({"path": "moved.txt"})),
    );
    assert_eq!(status, JobStatus::Succeeded);
    assert_eq!(delete["ok"], true, "delete: {delete}");

    let (status, patch, _) = run_worker(
        workspace.path(),
        text_frame(
            "apply_patch",
            serde_json::json!({
                "patches": [{
                    "path": "source.txt",
                    "expectedHash": sha256_hex(b"source"),
                    "hunks": [{"before": "source", "after": "patched"}]
                }]
            }),
        ),
    );
    assert_eq!(status, JobStatus::Succeeded);
    assert_eq!(patch["ok"], true, "apply_patch: {patch}");
    assert_eq!(
        fs::read_to_string(workspace.path().join("source.txt")).unwrap(),
        "patched"
    );

    let junction = workspace.path().join("outside-junction");
    let junction_status = std::process::Command::new("cmd")
        .args([
            "/C",
            "mklink",
            "/J",
            &junction.to_string_lossy(),
            &outside.path().to_string_lossy(),
        ])
        .status()
        .expect("create junction");
    assert!(
        junction_status.success(),
        "mklink /J failed: {junction_status}"
    );
    let (status, junction_write, _) = run_worker(
        workspace.path(),
        text_frame(
            "write_file",
            serde_json::json!({"path": "outside-junction/junction.txt", "content": "escape"}),
        ),
    );
    assert_eq!(status, JobStatus::Succeeded);
    assert_eq!(junction_write["ok"], false);
    assert_eq!(junction_write["errorCode"], "BOUNDARY_DENIED");
    assert!(!outside.path().join("junction.txt").exists());
    fs::remove_dir(&junction).expect("remove junction");

    let (status, delete, _) = run_worker(
        workspace.path(),
        text_frame(
            "delete_directory",
            serde_json::json!({"path": outside.path().to_string_lossy(), "recursive": true}),
        ),
    );
    assert_eq!(status, JobStatus::Succeeded);
    assert_eq!(delete["ok"], false);
    assert_eq!(delete["errorCode"], "BOUNDARY_DENIED");
    assert!(outside.path().exists(), "outside directory was deleted");

    let race_dir = workspace.path().join("race");
    fs::create_dir(&race_dir).expect("race directory");
    let stop_race = Arc::new(AtomicBool::new(false));
    let stop_race_thread = Arc::clone(&stop_race);
    let race_dir_thread = race_dir.clone();
    let outside_thread = outside.path().to_path_buf();
    let toggler = thread::spawn(move || {
        let mut junction = false;
        while !stop_race_thread.load(Ordering::Relaxed) {
            let _ = fs::remove_dir(&race_dir_thread);
            if junction {
                let _ = fs::create_dir(&race_dir_thread);
            } else {
                let _ = std::process::Command::new("cmd")
                    .args([
                        "/C",
                        "mklink",
                        "/J",
                        &race_dir_thread.to_string_lossy(),
                        &outside_thread.to_string_lossy(),
                    ])
                    .status();
            }
            junction = !junction;
        }
        let _ = fs::remove_dir(&race_dir_thread);
    });
    for index in 0..6 {
        let (status, response, _) = run_worker(
            workspace.path(),
            text_frame(
                "write_file",
                serde_json::json!({
                    "path": format!("race/file-{index}.txt"),
                    "content": "race"
                }),
            ),
        );
        assert_eq!(status, JobStatus::Succeeded);
        assert!(response["ok"] == true || response["errorCode"] == "BOUNDARY_DENIED");
    }
    stop_race.store(true, Ordering::Relaxed);
    toggler.join().expect("race toggler");
    assert!(!outside.path().join("file-0.txt").exists());
    assert!(!outside.path().join("file-1.txt").exists());
    assert!(!outside.path().join("file-2.txt").exists());
    assert!(!outside.path().join("file-3.txt").exists());
    assert!(!outside.path().join("file-4.txt").exists());
    assert!(!outside.path().join("file-5.txt").exists());
}
