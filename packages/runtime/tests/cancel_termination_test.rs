//! PLAN-0317 T2.2b / T3.3 真实容器证据：
//!   1. oneshot 中止帧 → 进程组被杀 + `CANCELLED` 回帧；
//!   2. 后台任务到点（运行时限）→ 进程组被杀 + `timeout` 终态。
//!
//! 与 m1b/m1c 同层：需要 Docker（`mise run test:runtime` 环境）。

use std::time::Duration;

use bollard::Docker;
use bollard::container::LogOutput;
use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
use tempfile::TempDir;
use tokio::io::AsyncWriteExt;
use tokio_stream::StreamExt;
use xihe_runtime::sandbox::SecurityProfile;
use xihe_runtime::workspace::WorkspaceManager;

async fn materialize_coding_workspace() -> (WorkspaceManager, TempDir, String, String) {
    let dir = TempDir::new().expect("temp dir");
    let ws_id = format!("t22b-{}", uuid::Uuid::new_v4());
    let ws_path = dir.path().join(&ws_id).to_string_lossy().to_string();
    let mut mgr = WorkspaceManager::new();
    let state = mgr
        .create_workspace(&ws_id, &ws_path, SecurityProfile::Coding, "xihe/workspace")
        .await
        .expect("Coding workspace should materialize for termination tests");
    (mgr, dir, ws_id, state.container_name)
}

async fn exec_capture(docker: &Docker, container: &str, script: &str) -> String {
    let exec = docker
        .create_exec(
            container,
            CreateExecOptions {
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                cmd: Some(vec!["sh".to_string(), "-c".to_string(), script.to_string()]),
                ..Default::default()
            },
        )
        .await
        .expect("create helper exec");
    let mut text = String::new();
    if let Ok(StartExecResults::Attached { mut output, .. }) =
        docker.start_exec(&exec.id, None).await
    {
        while let Some(Ok(chunk)) = output.next().await {
            match chunk {
                LogOutput::StdOut { message }
                | LogOutput::StdErr { message }
                | LogOutput::Console { message } => {
                    text.push_str(&String::from_utf8_lossy(&message));
                }
                _ => {}
            }
        }
    }
    text
}

async fn process_present(docker: &Docker, container: &str, pattern: &str) -> bool {
    // 末位字符加字符类，避免 pgrep 匹配到探测命令自身（`sh -c pgrep -f ...`）。
    let masked = if let Some((head, tail)) = pattern.split_at_checked(pattern.len() - 1) {
        format!("{head}[{tail}]")
    } else {
        pattern.to_string()
    };
    exec_capture(
        docker,
        container,
        // 模式必须整体作为一个参数传给 pgrep（未加引号会被当成多个 pattern 报错）。
        &format!("pgrep -f -- '{masked}' >/dev/null && echo yes || echo no"),
    )
    .await
    .contains("yes")
}

/// 发一帧 op 并**读到应答行即返回**：Docker exec 的输出流在派生的后台任务
/// 存活期间可能保持打开，等待 EOF 会让调用挂死；应答是单行 JSON。
async fn run_oneshot(docker: &Docker, container: &str, op: serde_json::Value) -> String {
    let exec = docker
        .create_exec(
            container,
            CreateExecOptions {
                attach_stdin: Some(true),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                tty: Some(false),
                cmd: Some(vec![
                    "xihe-container-runtime".to_string(),
                    "--oneshot".to_string(),
                ]),
                ..Default::default()
            },
        )
        .await
        .expect("create oneshot exec");
    let start = docker
        .start_exec(
            &exec.id,
            Some(StartExecOptions {
                detach: false,
                tty: false,
                output_capacity: Some(8 * 1024),
            }),
        )
        .await
        .expect("start oneshot exec");
    let StartExecResults::Attached {
        mut output,
        mut input,
    } = start
    else {
        panic!("oneshot exec must attach");
    };
    input
        .write_all(op.to_string().as_bytes())
        .await
        .expect("write op frame");
    input.write_all(b"\n").await.expect("terminate op frame");
    input.flush().await.expect("flush op frame");
    let mut buf: Vec<u8> = Vec::new();
    while let Some(Ok(chunk)) = output.next().await {
        match chunk {
            LogOutput::StdOut { message } | LogOutput::Console { message } => {
                buf.extend_from_slice(&message);
            }
            _ => {}
        }
        let text = String::from_utf8_lossy(&buf);
        if text.contains("\"ok\":") {
            return text.to_string();
        }
    }
    String::from_utf8_lossy(&buf).to_string()
}

/// T2.2b：宿主中止帧 → 容器两阶段终止进程组并回 `CANCELLED`。
#[tokio::test]
async fn oneshot_abort_frame_kills_process_group_and_reports_cancelled() {
    let (mut mgr, _dir, ws_id, container) = materialize_coding_workspace().await;
    let docker = Docker::connect_with_local_defaults().expect("docker client");

    let exec = docker
        .create_exec(
            &container,
            CreateExecOptions {
                attach_stdin: Some(true),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                tty: Some(false),
                cmd: Some(vec![
                    "xihe-container-runtime".to_string(),
                    "--oneshot".to_string(),
                ]),
                ..Default::default()
            },
        )
        .await
        .expect("create oneshot exec");
    let start = docker
        .start_exec(
            &exec.id,
            Some(StartExecOptions {
                detach: false,
                tty: false,
                output_capacity: Some(8 * 1024),
            }),
        )
        .await
        .expect("start oneshot exec");
    let StartExecResults::Attached {
        mut output,
        mut input,
    } = start
    else {
        panic!("oneshot exec must attach");
    };

    let marker = format!("xihe-cancel-probe-{}", uuid::Uuid::new_v4());
    let op = serde_json::json!({
        "operation": "execute_command",
        "payload": {
            // exec_shell_command 直接用 `sh -c <command>`，marker 写在注释里仅用于可读性；
            // 唯一性由 sleep 的秒数承担（pgrep 按整串匹配）。
            "command": format!("sleep 987654 # {marker}"),
            "args": [],
            "timeout": 300,
            "truncate_limit": 4096
        }
    });
    let probe = "sleep 987654";
    input
        .write_all(op.to_string().as_bytes())
        .await
        .expect("write op frame");
    input.write_all(b"\n").await.expect("terminate op frame");
    input.flush().await.expect("flush op frame");

    let collector_buf = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let sink = collector_buf.clone();
    tokio::spawn(async move {
        while let Some(item) = output.next().await {
            if let Ok(LogOutput::StdOut { message }) = item {
                sink.lock()
                    .unwrap()
                    .push_str(&String::from_utf8_lossy(&message));
            }
        }
    });

    let mut running = false;
    for _ in 0..50 {
        if process_present(&docker, &container, probe).await {
            running = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(running, "probe process must be running before abort");

    input
        .write_all(b"{\"abort\":true}\n")
        .await
        .expect("write abort frame");
    input.flush().await.expect("flush abort frame");

    // 不等待流关闭（后台任务存活时 attach 流可能保持打开），有界等待回帧文本。
    let mut stdout = String::new();
    for _ in 0..80 {
        stdout = collector_buf.lock().unwrap().clone();
        if stdout.contains("CANCELLED") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert!(
        stdout.contains("CANCELLED"),
        "expected a CANCELLED reply frame, got: {stdout}"
    );

    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(
        !process_present(&docker, &container, probe).await,
        "the process group must be gone after the abort"
    );

    mgr.delete_workspace(&ws_id).await.expect("cleanup sandbox");
}

/// T3.3：后台任务到点 → 由清理通道落实运行时限：进程组被杀 + `timeout` 终态。
#[tokio::test]
async fn background_job_timeout_kills_group_and_records_terminal_state() {
    let (mut mgr, _dir, ws_id, container) = materialize_coding_workspace().await;
    let docker = Docker::connect_with_local_defaults().expect("docker client");

    let op = serde_json::json!({
        "operation": "start_background_process",
        "payload": {
            "workspaceId": ws_id,
            "command": "sleep 987654",
            "args": [],
            "timeoutSecs": 2
        }
    });
    let reply = tokio::time::timeout(
        Duration::from_secs(15),
        run_oneshot(&docker, &container, op),
    )
    .await
    .expect("start_background_process must answer promptly");
    let job_id = reply
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .find_map(|value| {
            value
                .get("result")
                .and_then(|result| result.get("jobId"))
                .and_then(|id| id.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| panic!("jobId missing in reply: {reply}"));

    let mut running = false;
    for _ in 0..50 {
        if process_present(&docker, &container, "sleep 987654").await {
            running = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(running, "the job must be running before its deadline");
    // 越过 2s 运行时限后再由清理通道驱动（宿主每 5 分钟走同一 op）。
    tokio::time::sleep(Duration::from_secs(3)).await;

    let maintenance = tokio::time::timeout(
        Duration::from_secs(15),
        run_oneshot(
            &docker,
            &container,
            serde_json::json!({"operation": "cleanup_jobs", "payload": {}}),
        ),
    )
    .await
    .expect("cleanup_jobs must answer promptly");
    if !maintenance.contains(&job_id) {
        let state = exec_capture(
            &docker,
            &container,
            &format!(
                "echo started=$(cat /tmp/xihe-jobs/{job_id}/started_at) now=$(date -u +%FT%TZ); \
                 echo meta=$(cat /tmp/xihe-jobs/{job_id}/meta); \
                 echo pidalive=$(/bin/kill -0 -- -$(cat /tmp/xihe-jobs/{job_id}/pid) 2>/dev/null && echo yes || echo no)"
            ),
        )
        .await;
        panic!("cleanup_jobs must report the timed-out job: {maintenance}; state: {state}");
    }

    let meta = exec_capture(
        &docker,
        &container,
        &format!("cat /tmp/xihe-jobs/{job_id}/meta 2>/dev/null || true"),
    )
    .await
    .trim()
    .to_string();
    assert_eq!(meta, "timeout", "job must reach the timeout terminal state");

    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(
        !process_present(&docker, &container, "sleep 987654").await,
        "the job process group must be gone after the run limit"
    );

    mgr.delete_workspace(&ws_id).await.expect("cleanup sandbox");
}
