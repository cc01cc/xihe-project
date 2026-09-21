//! PLAN-0393 真实进程集成验收（Windows 宿主，无需 Docker）。
//!
//! 覆盖 `spec/test-design.md` §2：
//!   1. 父子/孙进程树：cancel 后按 PID 逐个确认退出（不只查父进程）；
//!   2. 话痨命令输出被截断，不撑爆内存；
//!   3. Runtime 进程被杀（模拟崩溃）：job 句柄随进程关闭，子进程无残留；
//!   4. MXC 收容路径（opt-in：`XIHE_JOB_MXC=1` + `XIHE_MXC_EXEC=<wxc-exec.exe>`）。
//!
//! 运行：`cargo test --test job_engine_process -- --nocapture`

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use xihe_runtime::job_engine::{
    CancelOutcome, JobEngine, JobSnapshot, JobStatus, LaunchPlan, STREAM_CAP_BYTES,
};
use xihe_runtime::process_guard::FilesystemPolicy;

fn temp_root(label: &str) -> PathBuf {
    let root = std::env::temp_dir()
        .join("xihe-job-engine-it")
        .join(format!("{label}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).expect("temp root");
    root
}

fn host_plan(root: &Path, program: &str, args: &[&str], timeout_ms: u64) -> LaunchPlan {
    LaunchPlan {
        backend_kind: "windows-host".to_string(),
        backend_revision: "it".to_string(),
        program: program.to_string(),
        args: args.iter().map(|value| value.to_string()).collect(),
        cwd: Some(root.to_path_buf()),
        env: BTreeMap::new(),
        timeout_ms,
        shell: false,
        grants: FilesystemPolicy {
            read_only_roots: Vec::new(),
            read_write_roots: vec![root.to_path_buf()],
        },
        policy_artifact: None,
    }
}

fn wait_terminal(engine: &JobEngine, job_id: &str) -> JobSnapshot {
    let started = Instant::now();
    loop {
        let snapshot = engine.snapshot(job_id).expect("snapshot");
        if snapshot.status.is_terminal() {
            return snapshot;
        }
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "job {job_id} did not reach a terminal state"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// True when the PID no longer exists (independent of the job object's view).
fn pid_gone(pid: u32) -> bool {
    let script = format!(
        "if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 1 }} else {{ exit 0 }}"
    );
    Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[test]
fn cancel_kills_the_whole_process_tree() {
    let root = temp_root("tree");
    let engine = JobEngine::new("boot-it", root.clone());
    let job_id = uuid::Uuid::new_v4().to_string();
    // The parent spawns a detached grandchild through `start /B`.
    let plan = host_plan(
        &root,
        "cmd",
        &[
            "/C",
            "start /B cmd /C ping -n 60 127.0.0.1 > nul & ping -n 60 127.0.0.1 > nul",
        ],
        0,
    );
    engine.start(&job_id, plan).expect("start");

    let started = Instant::now();
    let pids = loop {
        let pids = engine.job_pids(&job_id).expect("pids");
        if pids.len() >= 2 {
            break pids;
        }
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "expected at least two processes in the job, saw {pids:?}"
        );
        std::thread::sleep(Duration::from_millis(50));
    };

    let cancel = engine.cancel(&job_id).expect("cancel");
    assert_eq!(cancel.outcome, CancelOutcome::Cancelled);
    assert!(cancel.changed);
    for pid in &pids {
        assert!(pid_gone(*pid), "pid {pid} survived cancel");
    }
    let cleanup = engine.cleanup(&job_id).expect("cleanup");
    // The tree was already reclaimed by the confirmed cancel, so cleanup has
    // nothing left to terminate and reports zero.
    assert_eq!(cleanup.processes, 0);
    for pid in &pids {
        assert!(pid_gone(*pid), "pid {pid} survived cleanup");
    }
}

#[test]
fn talkative_command_is_truncated_and_bounded() {
    let root = temp_root("talkative");
    let engine = JobEngine::new("boot-it", root.clone());
    let job_id = uuid::Uuid::new_v4().to_string();
    let plan = host_plan(
        &root,
        "powershell",
        &[
            "-NoProfile",
            "-Command",
            "[Console]::Out.Write('a' * 2097152); exit 0",
        ],
        0,
    );
    engine.start(&job_id, plan).expect("start");
    let snapshot = wait_terminal(&engine, &job_id);
    assert_eq!(snapshot.status, JobStatus::Succeeded);
    assert!(snapshot.truncated, "2 MiB of output must be truncated");
    assert_eq!(snapshot.stdout_bytes, STREAM_CAP_BYTES);

    let first = engine
        .read_output(&job_id, "stdout", Some(0), Some(1_048_576))
        .expect("read");
    assert!(first.truncated);
    assert_eq!(first.next_offset - first.offset, 1_048_576);
    let second = engine
        .read_output(&job_id, "stdout", Some(first.next_offset), Some(65_536))
        .expect("read again");
    assert!(second.next_offset >= first.next_offset);
    engine.cleanup(&job_id).expect("cleanup");
}

#[test]
fn mxc_job_is_owned_and_killed() {
    if std::env::var("XIHE_JOB_MXC").ok().as_deref() != Some("1") {
        eprintln!("SKIP: set XIHE_JOB_MXC=1 (and have wxc-exec.exe) to run the MXC path");
        return;
    }
    let mxc = std::env::var("XIHE_MXC_EXEC")
        .expect("set XIHE_MXC_EXEC to the wxc-exec.exe path together with XIHE_JOB_MXC=1");
    assert!(PathBuf::from(&mxc).exists(), "wxc-exec not found at {mxc}");
    let node = String::from_utf8_lossy(
        &Command::new("where")
            .arg("node")
            .output()
            .expect("where node")
            .stdout,
    )
    .lines()
    .next()
    .unwrap_or_default()
    .trim()
    .to_string();
    assert!(!node.is_empty(), "node.exe not found on PATH");
    let node_dir = PathBuf::from(&node)
        .parent()
        .expect("node dir")
        .to_string_lossy()
        .to_string();

    let root = temp_root("mxc");
    let policy_path = root.join("policy.json");
    let policy = serde_json::json!({
        "version": "0.8.0-alpha",
        "containment": "processcontainer",
        "process": {
            "commandLine": format!("\"{node}\" -e \"setTimeout(()=>{{}},60000)\""),
            "cwd": root.to_string_lossy(),
            "timeout": 90000
        },
        "filesystem": {
            "readonlyPaths": [node_dir],
            "readwritePaths": [root.to_string_lossy()]
        },
        "fallback": { "allowDaclMutation": true },
        "network": {
            "egress": { "default": "allow" },
            "ingress": { "default": "allow", "hostLoopback": "allow" }
        },
        "processContainer": {
            "capabilities": ["internetClient", "privateNetworkClientServer"]
        },
        "ui": { "disable": false }
    });
    fs::write(&policy_path, serde_json::to_vec_pretty(&policy).unwrap()).expect("policy");

    let engine = JobEngine::new("boot-it", root.clone());
    let job_id = uuid::Uuid::new_v4().to_string();
    let policy_arg = policy_path.to_string_lossy().to_string();
    let mut plan = host_plan(&root, &mxc, &[policy_arg.as_str()], 0);
    plan.backend_kind = "windows-mxc".to_string();
    plan.grants.read_only_roots.push(PathBuf::from(&node_dir));
    engine.start(&job_id, plan).expect("start mxc job");

    let started = Instant::now();
    let pids = loop {
        let pids = engine.job_pids(&job_id).expect("pids");
        if !pids.is_empty() {
            break pids;
        }
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "the MXC wrapper never appeared in our job object"
        );
        std::thread::sleep(Duration::from_millis(50));
    };

    let cancel = engine.cancel(&job_id).expect("cancel");
    assert_eq!(cancel.outcome, CancelOutcome::Cancelled);
    for pid in &pids {
        assert!(pid_gone(*pid), "sandboxed pid {pid} survived cancel");
    }
    engine.cleanup(&job_id).expect("cleanup");
}

#[test]
fn mxc_readonly_grant_denies_writes() {
    if std::env::var("XIHE_JOB_MXC").ok().as_deref() != Some("1") {
        eprintln!("SKIP: set XIHE_JOB_MXC=1 (and have wxc-exec.exe) to run the MXC path");
        return;
    }
    let mxc = std::env::var("XIHE_MXC_EXEC")
        .expect("set XIHE_MXC_EXEC to the wxc-exec.exe path together with XIHE_JOB_MXC=1");
    let node = String::from_utf8_lossy(
        &Command::new("where")
            .arg("node")
            .output()
            .expect("where node")
            .stdout,
    )
    .lines()
    .next()
    .unwrap_or_default()
    .trim()
    .to_string();
    assert!(!node.is_empty(), "node.exe not found on PATH");
    let node_dir = PathBuf::from(&node)
        .parent()
        .expect("node dir")
        .to_path_buf();

    let root = temp_root("mxc-readonly");
    let policy_path = root.join("policy.json");
    let marker = node_dir.join("xihe-mxc-readonly-probe.txt");
    let _ = fs::remove_file(&marker);
    let script = format!(
        "const fs=require('fs');try{{fs.writeFileSync(String.raw`{}`,'1');process.exit(0)}}catch(e){{process.exit(7)}}",
        marker.display()
    );
    let policy = serde_json::json!({
        "version": "0.8.0-alpha",
        "containment": "processcontainer",
        "process": {
            "commandLine": format!("\"{node}\" -e \"{}\"", script.replace('"', "\\\"")),
            "cwd": root.to_string_lossy(),
            "timeout": 30000
        },
        "filesystem": {
            "readonlyPaths": [node_dir.to_string_lossy()],
            "readwritePaths": [root.to_string_lossy()]
        },
        "fallback": { "allowDaclMutation": true },
        "network": { "egress": { "default": "allow" }, "ingress": { "default": "allow", "hostLoopback": "allow" } },
        "processContainer": { "capabilities": ["internetClient", "privateNetworkClientServer"] },
        "ui": { "disable": false }
    });
    fs::write(&policy_path, serde_json::to_vec_pretty(&policy).unwrap()).expect("policy");

    let engine = JobEngine::new("boot-it", root.clone());
    let job_id = uuid::Uuid::new_v4().to_string();
    let policy_arg = policy_path.to_string_lossy().to_string();
    let mut plan = host_plan(&root, &mxc, &[policy_arg.as_str()], 0);
    plan.backend_kind = "windows-mxc".to_string();
    plan.grants.read_only_roots.push(node_dir.clone());
    engine.start(&job_id, plan).expect("start mxc job");
    let snapshot = wait_terminal(&engine, &job_id);
    let wrote = marker.exists();
    let _ = fs::remove_file(&marker);
    assert!(
        !wrote,
        "a read-only grant must not be writable inside the sandbox (exit={:?})",
        snapshot.exit_code
    );
    engine.cleanup(&job_id).expect("cleanup");
}

/// Crash-path helper: creates a job, records its PIDs, then exits without any
/// cleanup so only the OS handle closure (kill-on-close) can reap the tree.
#[test]
#[ignore = "helper for runtime_crash_leaves_no_residue; run with --ignored"]
fn job_engine_crash_helper() {
    let Ok(pid_file) = std::env::var("XIHE_JOB_CRASH_PIDFILE") else {
        return;
    };
    let root = std::env::var("XIHE_JOB_CRASH_ROOT").expect("crash root");
    let root = PathBuf::from(root);
    let engine = JobEngine::new("boot-crash", root.clone());
    let job_id = "crash-job".to_string();
    engine
        .start(
            &job_id,
            host_plan(&root, "cmd", &["/C", "ping -n 60 127.0.0.1 > nul"], 0),
        )
        .expect("start");
    let pids = loop {
        let pids = engine.job_pids(&job_id).expect("pids");
        if !pids.is_empty() {
            break pids;
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    fs::write(&pid_file, serde_json::to_vec(&pids).unwrap()).expect("pid file");
    // No Drop, no terminate: process exit must close the job handle.
    std::mem::forget(engine);
    std::process::exit(0);
}

#[test]
fn runtime_crash_leaves_no_residue() {
    let root = temp_root("crash");
    let pid_file = root.join("pids.json");
    let exe = std::env::current_exe().expect("current exe");
    let status = Command::new(exe)
        .args([
            "job_engine_crash_helper",
            "--exact",
            "--ignored",
            "--nocapture",
        ])
        .env("XIHE_JOB_CRASH_PIDFILE", &pid_file)
        .env("XIHE_JOB_CRASH_ROOT", &root)
        .status()
        .expect("spawn crash helper");
    assert!(status.success(), "crash helper failed: {status:?}");

    let pids: Vec<u32> =
        serde_json::from_slice(&fs::read(&pid_file).expect("pid file")).expect("pid json");
    assert!(!pids.is_empty(), "helper recorded no pids");
    let started = Instant::now();
    for pid in &pids {
        loop {
            if pid_gone(*pid) {
                break;
            }
            assert!(
                started.elapsed() < Duration::from_secs(15),
                "pid {pid} survived the crashed job owner"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
