//! PLAN-0347 M0 探针 v2（一次性，M0 后并入 T1.3 测试或删除）。
//! 目的：在 native Windows 宿主上实测长驻 `exec attach` 会话语义。
//! 运行：cargo test --test session_probe_test -- --ignored --nocapture
//! 证据：plans/PLAN-0347-XH-backend-seam-bridge/evidence/session-probe.md

use std::collections::VecDeque;
use std::pin::Pin;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bollard::Docker;
use bollard::container::LogOutput;
use bollard::errors::Error as BollardError;
use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
use bollard::models::{ContainerCreateBody, HostConfig};
use bollard::query_parameters::{
    CreateContainerOptions, RemoveContainerOptions, RestartContainerOptions, StartContainerOptions,
};
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio_stream::StreamExt;

const IMAGE: &str = "xihe/workspace";
const ECHO_CMD: &str = r#"while IFS= read -r line; do printf '%s\n' "$line"; done"#;

enum ReadOutcome {
    Line(Vec<u8>),
    Closed,
    Timeout,
}

struct Session {
    exec_id: String,
    output: Pin<Box<dyn tokio_stream::Stream<Item = Result<LogOutput, BollardError>> + Send>>,
    input: Pin<Box<dyn AsyncWrite + Send>>,
    pending: VecDeque<Vec<u8>>,
    eof: bool,
}

fn exec_options(cmd: Vec<String>) -> CreateExecOptions<String> {
    CreateExecOptions {
        attach_stdin: Some(true),
        attach_stdout: Some(true),
        attach_stderr: Some(true),
        tty: Some(false),
        cmd: Some(cmd),
        ..Default::default()
    }
}

async fn attach(docker: &Docker, container: &str, cmd: Vec<String>) -> Session {
    let exec = docker
        .create_exec(container, exec_options(cmd))
        .await
        .expect("create_exec");
    let started = docker
        .start_exec(
            &exec.id,
            Some(StartExecOptions {
                detach: false,
                tty: false,
                output_capacity: Some(8 * 1024),
            }),
        )
        .await
        .expect("start_exec");
    match started {
        StartExecResults::Attached { output, input } => Session {
            exec_id: exec.id,
            output,
            input,
            pending: VecDeque::new(),
            eof: false,
        },
        StartExecResults::Detached => panic!("unexpected detached"),
    }
}

async fn read_line(session: &mut Session, wait: Duration) -> ReadOutcome {
    if let Some(line) = session.pending.pop_front() {
        return ReadOutcome::Line(line);
    }
    if session.eof {
        return ReadOutcome::Closed;
    }
    let fut = async {
        let mut buf: Vec<u8> = Vec::new();
        while let Some(item) = session.output.next().await {
            match item {
                Ok(LogOutput::StdOut { message }) | Ok(LogOutput::Console { message }) => {
                    buf.extend_from_slice(&message);
                    while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
                        let line: Vec<u8> = buf.drain(..=pos).collect();
                        session.pending.push_back(line[..line.len() - 1].to_vec());
                    }
                    if let Some(first) = session.pending.pop_front() {
                        return Some(first);
                    }
                }
                Ok(_) => {}
                Err(error) => {
                    println!("PROBE: stream error: {error}");
                    return None;
                }
            }
        }
        None
    };
    match tokio::time::timeout(wait, fut).await {
        Ok(Some(line)) => ReadOutcome::Line(line),
        Ok(None) => {
            session.eof = true;
            if let Some(line) = session.pending.pop_front() {
                return ReadOutcome::Line(line);
            }
            ReadOutcome::Closed
        }
        Err(_) => ReadOutcome::Timeout,
    }
}

async fn ping(session: &mut Session, id: usize, wait: Duration) -> Result<Vec<u8>, String> {
    let line = format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":\"tools/list\"}}");
    session
        .input
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("write: {e}"))?;
    session
        .input
        .write_all(b"\n")
        .await
        .map_err(|e| format!("write nl: {e}"))?;
    session
        .input
        .flush()
        .await
        .map_err(|e| format!("flush: {e}"))?;
    match read_line(session, wait).await {
        ReadOutcome::Line(line) => Ok(line),
        ReadOutcome::Closed => Err("stream closed".into()),
        ReadOutcome::Timeout => Err("timeout".into()),
    }
}

async fn exec_detached(docker: &Docker, container: &str, cmd: Vec<String>) {
    let exec = docker
        .create_exec(container, exec_options(cmd))
        .await
        .expect("create detached exec");
    let _ = docker
        .start_exec(
            &exec.id,
            Some(StartExecOptions {
                detach: true,
                ..Default::default()
            }),
        )
        .await;
}

async fn wait_stream_closed(session: &mut Session, wait: Duration) -> bool {
    let deadline = Instant::now() + wait;
    loop {
        let remain = deadline.saturating_duration_since(Instant::now());
        if remain.is_zero() {
            return false;
        }
        match read_line(session, remain.min(Duration::from_secs(5))).await {
            ReadOutcome::Closed => return true,
            ReadOutcome::Timeout => return false,
            ReadOutcome::Line(_) => continue,
        }
    }
}

async fn wait_not_running(docker: &Docker, exec_id: &str, bound: Duration) -> Option<Option<i64>> {
    let deadline = Instant::now() + bound;
    while Instant::now() < deadline {
        if let Ok(info) = docker.inspect_exec(exec_id).await
            && !info.running.unwrap_or(true)
        {
            return Some(info.exit_code);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    None
}

async fn collect_until(
    docker: &Docker,
    container: &str,
    cmd: Vec<String>,
    marker: &str,
) -> Vec<String> {
    let mut session = attach(docker, container, cmd).await;
    let mut lines = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let remain = deadline.saturating_duration_since(Instant::now());
        if remain.is_zero() {
            break;
        }
        match read_line(&mut session, remain.min(Duration::from_secs(5))).await {
            ReadOutcome::Line(line) => {
                let text = String::from_utf8_lossy(&line).to_string();
                if text == marker {
                    break;
                }
                lines.push(text);
            }
            ReadOutcome::Closed => break,
            ReadOutcome::Timeout => break,
        }
    }
    lines
}

#[tokio::test]
#[ignore = "M0 probe; run with: cargo test --test session_probe_test -- --ignored --nocapture"]
async fn session_probe() {
    let mut failures: Vec<String> = Vec::new();
    let docker = Docker::connect_with_local_defaults().expect("docker connect");
    match docker.version().await {
        Ok(version) => println!(
            "PROBE: docker server={:?} platform={:?}",
            version.version, version.platform
        ),
        Err(error) => {
            println!("PROBE: docker version failed: {error}");
            failures.push("docker version".into());
            return;
        }
    }

    let name = format!(
        "xihe-session-probe-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
    );
    let config = ContainerCreateBody {
        image: Some(IMAGE.to_string()),
        cmd: Some(vec!["sleep".into(), "infinity".into()]),
        host_config: Some(HostConfig {
            network_mode: Some("none".to_string()),
            ..Default::default()
        }),
        ..Default::default()
    };
    docker
        .create_container(
            Some(CreateContainerOptions {
                name: Some(name.clone()),
                ..Default::default()
            }),
            config,
        )
        .await
        .expect("create container");
    docker
        .start_container(&name, None::<StartContainerOptions>)
        .await
        .expect("start container");
    println!("PROBE: container {name} started");

    let echo = vec!["sh".to_string(), "-c".to_string(), ECHO_CMD.to_string()];

    // 1-3) 往返 / 大帧 / 流水线（同一会话）
    {
        let mut session = attach(&docker, &name, echo.clone()).await;
        let start = Instant::now();
        let mut ok = 0usize;
        for id in 0..200usize {
            let expected = format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":\"tools/list\"}}");
            match ping(&mut session, id, Duration::from_secs(10)).await {
                Ok(line) if line == expected.as_bytes() => ok += 1,
                Ok(line) => {
                    println!(
                        "PROBE: roundtrip mismatch id={id} got={:?}",
                        String::from_utf8_lossy(&line)
                    );
                    break;
                }
                Err(error) => {
                    println!("PROBE: roundtrip error id={id}: {error}");
                    break;
                }
            }
        }
        let elapsed = start.elapsed();
        println!(
            "PROBE: roundtrip {ok}/200 in {elapsed:?} (avg {:?})",
            elapsed / 200
        );
        if ok != 200 {
            failures.push("roundtrip".into());
        }

        let pad = "x".repeat(1_048_500);
        let big = format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":9001,\"method\":\"tools/call\",\"params\":{{\"pad\":\"{pad}\"}}}}"
        );
        let big_len = big.len();
        let start = Instant::now();
        let write = async {
            session.input.write_all(big.as_bytes()).await?;
            session.input.write_all(b"\n").await?;
            session.input.flush().await
        };
        let write: Result<(), std::io::Error> = write.await;
        let read = read_line(&mut session, Duration::from_secs(30)).await;
        match (write, read) {
            (Ok(()), ReadOutcome::Line(line)) if line.len() == big_len => println!(
                "PROBE: big-frame {big_len}B round-trip ok in {:?}",
                start.elapsed()
            ),
            (Ok(()), ReadOutcome::Line(line)) => {
                println!(
                    "PROBE: big-frame length mismatch sent={big_len} got={}",
                    line.len()
                );
                failures.push("big-frame".into());
            }
            (Err(error), _) => {
                println!("PROBE: big-frame write error: {error}");
                failures.push("big-frame-write".into());
            }
            (_, ReadOutcome::Timeout) => {
                println!("PROBE: big-frame timeout");
                failures.push("big-frame-read".into());
            }
            (_, ReadOutcome::Closed) => {
                println!("PROBE: big-frame stream closed");
                failures.push("big-frame-closed".into());
            }
        }

        let frame_a = "{\"jsonrpc\":\"2.0\",\"id\":7001,\"method\":\"a\"}";
        let frame_b = "{\"jsonrpc\":\"2.0\",\"id\":7002,\"method\":\"b\"}";
        let write = async {
            session.input.write_all(frame_a.as_bytes()).await?;
            session.input.write_all(b"\n").await?;
            session.input.write_all(frame_b.as_bytes()).await?;
            session.input.write_all(b"\n").await?;
            session.input.flush().await
        };
        let write: Result<(), std::io::Error> = write.await;
        let first = read_line(&mut session, Duration::from_secs(10)).await;
        let second = read_line(&mut session, Duration::from_secs(10)).await;
        let pipelined = write.is_ok()
            && matches!(&first, ReadOutcome::Line(l) if l == frame_a.as_bytes())
            && matches!(&second, ReadOutcome::Line(l) if l == frame_b.as_bytes());
        println!("PROBE: pipelining order-preserved={pipelined}");
        if !pipelined {
            failures.push("pipelining".into());
        }

        // 4) inspect_exec：运行状态与 pid；确认 pid 的命名空间
        let info = docker
            .inspect_exec(&session.exec_id)
            .await
            .expect("inspect_exec");
        let inspect_pid = info.pid.unwrap_or_default();
        println!(
            "PROBE: inspect running={:?} pid={} exit={:?}",
            info.running, inspect_pid, info.exit_code
        );
        if !info.running.unwrap_or(false) || inspect_pid <= 0 {
            failures.push("inspect-running".into());
        }
        let ps_lines = collect_until(
            &docker,
            &name,
            vec![
                "sh".to_string(),
                "-c".to_string(),
                format!("ps -eo pid,args; echo __END__"),
            ],
            "__END__",
        )
        .await;
        let echo_pids: Vec<String> = ps_lines
            .iter()
            .filter(|l| l.contains("while IFS="))
            .filter_map(|l| l.split_whitespace().next().map(str::to_string))
            .collect();
        let pid_in_container_ns = echo_pids.iter().any(|p| p == &inspect_pid.to_string());
        println!(
            "PROBE: pid-namespace inspect_pid={inspect_pid} container_ps_pids={echo_pids:?} matches={pid_in_container_ns}"
        );

        // 5) kill 机制（决策 #16 修订）：先验证 inspect pid（宿主命名空间）不可用，再验证容器内 ps 精确匹配 kill
        exec_detached(
            &docker,
            &name,
            vec![
                "sh".to_string(),
                "-c".to_string(),
                format!("kill {inspect_pid}"),
            ],
        )
        .await;
        let by_inspect_pid =
            wait_not_running(&docker, &session.exec_id, Duration::from_secs(3)).await;
        println!(
            "PROBE: kill-by-inspect-pid usable={:?}（预期 None=不可用，宿主命名空间 pid）",
            by_inspect_pid.is_some()
        );
        if by_inspect_pid.is_none() {
            let ps_kill = "ps -eo pid,args | grep -F 'while IFS=' | grep -v grep | awk '{print $1}' | head -1 | xargs -r kill";
            exec_detached(
                &docker,
                &name,
                vec!["sh".to_string(), "-c".to_string(), ps_kill.to_string()],
            )
            .await;
            let fallback =
                wait_not_running(&docker, &session.exec_id, Duration::from_secs(5)).await;
            let closed2 = wait_stream_closed(&mut session, Duration::from_secs(5)).await;
            println!("PROBE: kill-by-ps not-running-exit={fallback:?} stream-closed={closed2}");
            if fallback.is_none() || !closed2 {
                failures.push("kill-ps".into());
            }
        } else {
            failures.push("kill-inspect-pid-unexpectedly-worked".into());
        }
    }

    // 6) idle 稳定性（独立会话，先测再杀）
    {
        let mut session = attach(&docker, &name, echo.clone()).await;
        let mut idle_ok = true;
        for round in 0..4usize {
            let start = Instant::now();
            if ping(&mut session, 8000 + round, Duration::from_secs(10))
                .await
                .is_err()
            {
                idle_ok = false;
                break;
            }
            println!("PROBE: idle ping {round} ok in {:?}", start.elapsed());
            if round < 3 {
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
        println!("PROBE: idle-stability ok={idle_ok}");
        if !idle_ok {
            failures.push("idle".into());
        }
        let _ = session.input.shutdown().await;
        let _ = wait_stream_closed(&mut session, Duration::from_secs(5)).await;
    }

    // 7) 容器重启：旧流断开 + 新会话可用
    {
        let mut session = attach(&docker, &name, echo.clone()).await;
        let _ = ping(&mut session, 9100, Duration::from_secs(10)).await;
        docker
            .restart_container(
                &name,
                Some(RestartContainerOptions {
                    t: Some(1),
                    signal: None,
                }),
            )
            .await
            .expect("restart");
        let closed = wait_stream_closed(&mut session, Duration::from_secs(20)).await;
        let mut fresh = attach(&docker, &name, echo.clone()).await;
        let after_restart_ok = ping(&mut fresh, 9200, Duration::from_secs(10))
            .await
            .is_ok();
        println!("PROBE: restart old-stream-closed={closed} fresh-session-ok={after_restart_ok}");
        if !closed || !after_restart_ok {
            failures.push("restart".into());
        }
        let _ = fresh.input.shutdown().await;
    }

    // 8) stdin EOF：观测项（不依赖 EOF 终止；kill 为主路径）
    {
        let mut session = attach(&docker, &name, echo.clone()).await;
        let _ = ping(&mut session, 9300, Duration::from_secs(10)).await;
        let _ = session.input.shutdown().await;
        let closed_after_shutdown = wait_stream_closed(&mut session, Duration::from_secs(5)).await;
        let input = std::mem::replace(
            &mut session.input,
            Box::pin(tokio::io::sink()) as Pin<Box<dyn AsyncWrite + Send>>,
        );
        drop(input);
        let closed_after_drop = wait_stream_closed(&mut session, Duration::from_secs(5)).await;
        let exit = wait_not_running(&docker, &session.exec_id, Duration::from_secs(5)).await;
        println!(
            "PROBE: stdin-eof observational shutdown-closed={closed_after_shutdown} drop-closed={closed_after_drop} not-running-exit={exit:?}（设计以 kill 为主路径，EOF 不作依赖）"
        );
    }

    let _ = docker
        .remove_container(
            &name,
            Some(RemoveContainerOptions {
                force: true,
                v: true,
                ..Default::default()
            }),
        )
        .await;
    println!("PROBE: container removed");

    if failures.is_empty() {
        println!("PROBE: SUMMARY all checks passed");
    } else {
        println!("PROBE: SUMMARY failures={failures:?}");
        panic!("probe failures: {failures:?}");
    }
}
