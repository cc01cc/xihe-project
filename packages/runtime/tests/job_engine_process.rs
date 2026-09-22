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

use base64::Engine as _;
use sha2::{Digest, Sha256};
use xihe_runtime::job_engine::{
    CancelOutcome, JobEngine, JobSnapshot, JobStatus, LaunchPlan, STREAM_CAP_BYTES,
};
use xihe_runtime::job_mxc_adapter::{MxcJobRequest, build_mxc_job};
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

fn directory_manifest(root: &Path) -> String {
    let mut entries = Vec::new();
    if let Ok(read_dir) = fs::read_dir(root) {
        for entry in read_dir.flatten() {
            let path = entry.path();
            let relative = path.strip_prefix(root).unwrap_or(&path).to_string_lossy();
            let metadata = fs::symlink_metadata(&path).expect("manifest metadata");
            let bytes = if metadata.is_file() {
                fs::read(&path).expect("manifest file")
            } else {
                Vec::new()
            };
            let mut hasher = Sha256::new();
            hasher.update(bytes);
            entries.push(format!(
                "{}|{}|{}|{}",
                relative.replace('\\', "/"),
                metadata.is_dir(),
                metadata.len(),
                format_args!("{:x}", hasher.finalize())
            ));
        }
    }
    entries.sort();
    entries.join("\n")
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

#[test]
fn mxc_readwrite_grant_allows_writes_inside_the_workspace() {
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

    let root = temp_root("mxc-readwrite");
    let policy_path = root.join("policy.json");
    let marker = root.join("written-inside.txt");
    let script = format!(
        "require('fs').writeFileSync(String.raw`{}`,'ok')",
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
    assert_eq!(
        snapshot.status,
        JobStatus::Succeeded,
        "writing inside readwritePaths must succeed: {snapshot:?}"
    );
    assert!(
        marker.exists(),
        "the sandboxed write must land in the workspace"
    );
    engine.cleanup(&job_id).expect("cleanup");
}

#[test]
fn mxc_command_bypass_matrix_rejects_outside_writes() {
    if std::env::var("XIHE_JOB_MXC").ok().as_deref() != Some("1") {
        eprintln!("SKIP: set XIHE_JOB_MXC=1 and XIHE_MXC_EXEC to run the MXC bypass matrix");
        return;
    }
    let _mxc = std::env::var("XIHE_MXC_EXEC").expect("XIHE_MXC_EXEC");
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

    let root = temp_root("mxc-bypass-matrix");
    let outside = temp_root("mxc-bypass-outside");
    let script = root.join("bypass-fixture.js");
    fs::write(
        &script,
        r#"const fs=require('fs');const path=require('path');const mode=process.argv[2];let target=process.argv[3];if(mode==='encoded'){target=Buffer.from(target,'base64').toString('utf8')}if(mode==='build'){fs.mkdirSync(path.dirname(target),{recursive:true})}fs.writeFileSync(target,`outside-${mode}`);"#,
    )
    .expect("fixture script");

    let cases: Vec<(&str, String, Vec<String>)> = vec![
        (
            "direct",
            node.clone(),
            vec![script.to_string_lossy().to_string(), "direct".to_string()],
        ),
        (
            "absolute",
            node.clone(),
            vec![script.to_string_lossy().to_string(), "absolute".to_string()],
        ),
        (
            "nested-shell",
            "cmd.exe".to_string(),
            vec![
                "/D".to_string(),
                "/S".to_string(),
                "/C".to_string(),
                format!("\"{}\" \"{}\" nested-shell", node, script.to_string_lossy()),
            ],
        ),
        (
            "encoded",
            node.clone(),
            vec![script.to_string_lossy().to_string(), "encoded".to_string()],
        ),
        (
            "build-like",
            node.clone(),
            vec![script.to_string_lossy().to_string(), "build".to_string()],
        ),
    ];

    for (label, program, mut args) in cases {
        let target = outside.join(format!("{label}.txt"));
        if label == "encoded" {
            args.push(
                base64::engine::general_purpose::STANDARD
                    .encode(target.to_string_lossy().as_bytes()),
            );
        } else {
            args.push(target.to_string_lossy().to_string());
        }
        let before = directory_manifest(&outside);
        let output_dir = root.join("job-output").join(label);
        let mut plan = build_mxc_job(
            MxcJobRequest {
                workspace_path: root.to_string_lossy().into_owned(),
                command: program,
                args,
                cwd: Some(root.to_string_lossy().into_owned()),
                env: BTreeMap::new(),
                timeout_secs: 30,
            },
            &output_dir,
        )
        .expect("build MXC fixture job");
        plan.grants.read_only_roots.push(node_dir.clone());

        let engine = JobEngine::new("boot-it", root.clone());
        let job_id = uuid::Uuid::new_v4().to_string();
        engine.start(&job_id, plan).expect("start matrix job");
        let snapshot = wait_terminal(&engine, &job_id);
        let after = directory_manifest(&outside);
        assert_eq!(
            before, after,
            "outside manifest changed for {label}: {snapshot:?}"
        );
        assert!(!target.exists(), "outside marker was created for {label}");
        engine.cleanup(&job_id).expect("cleanup matrix job");
    }
}

#[test]
fn mxc_path_normalization_and_missing_tool_are_classified() {
    if std::env::var("XIHE_JOB_MXC").ok().as_deref() != Some("1") {
        eprintln!("SKIP: set XIHE_JOB_MXC=1 and XIHE_MXC_EXEC to run the MXC path matrix");
        return;
    }
    let _mxc = std::env::var("XIHE_MXC_EXEC").expect("XIHE_MXC_EXEC");
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
    let root = temp_root("mxc-path-matrix");
    let script = root.join("path-fixture.js");
    fs::write(
        &script,
        r#"const fs=require('fs');fs.writeFileSync(process.argv[2],'outside-path-matrix')"#,
    )
    .expect("fixture script");

    let parent_target = root
        .parent()
        .expect("temp parent")
        .join(format!("mxc-parent-{}.txt", uuid::Uuid::new_v4()));
    let case_target = PathBuf::from(root.to_string_lossy().to_uppercase())
        .join("..")
        .join(format!("mxc-case-{}.txt", uuid::Uuid::new_v4()));

    for target in [parent_target, case_target] {
        let output_dir = root
            .join("job-output")
            .join(uuid::Uuid::new_v4().to_string());
        let plan = build_mxc_job(
            MxcJobRequest {
                workspace_path: root.to_string_lossy().into_owned(),
                command: node.clone(),
                args: vec![
                    script.to_string_lossy().into_owned(),
                    target.to_string_lossy().into_owned(),
                ],
                cwd: Some(root.to_string_lossy().into_owned()),
                env: BTreeMap::new(),
                timeout_secs: 30,
            },
            &output_dir,
        )
        .expect("build path matrix job");
        let engine = JobEngine::new("boot-it", root.clone());
        let job_id = uuid::Uuid::new_v4().to_string();
        engine.start(&job_id, plan).expect("start path matrix job");
        let _snapshot = wait_terminal(&engine, &job_id);
        assert!(
            !target.exists(),
            "path normalization escaped workspace: {target:?}"
        );
        engine.cleanup(&job_id).expect("cleanup path matrix job");
    }

    let output_dir = root.join("job-output").join("missing-tool");
    let plan = build_mxc_job(
        MxcJobRequest {
            workspace_path: root.to_string_lossy().into_owned(),
            command: root.join("missing-tool.exe").to_string_lossy().into_owned(),
            args: Vec::new(),
            cwd: Some(root.to_string_lossy().into_owned()),
            env: BTreeMap::new(),
            timeout_secs: 5,
        },
        &output_dir,
    )
    .expect("build missing-tool plan");
    let engine = JobEngine::new("boot-it", root.clone());
    let job_id = uuid::Uuid::new_v4().to_string();
    let result = engine.start(&job_id, plan);
    if result.is_ok() {
        let snapshot = wait_terminal(&engine, &job_id);
        assert_ne!(
            snapshot.status,
            JobStatus::Succeeded,
            "missing tool must not be reported as a successful job"
        );
        engine.cleanup(&job_id).expect("cleanup missing-tool job");
    }

    let package_target = root
        .parent()
        .expect("package parent")
        .join(format!("mxc-package-{}.txt", uuid::Uuid::new_v4()));
    let npm_cli = PathBuf::from(&node)
        .parent()
        .expect("node dir")
        .join("node_modules")
        .join("npm")
        .join("bin")
        .join("npm-cli.js");
    assert!(
        npm_cli.exists(),
        "npm CLI fixture is unavailable: {npm_cli:?}"
    );
    fs::write(
        root.join("package.json"),
        format!(
            r#"{{"scripts":{{"build":"node -e \"require('fs').writeFileSync('package-ran.txt','ran');require('fs').writeFileSync('{}','package-outside')\""}}}}"#,
            package_target
                .display()
                .to_string()
                .replace('\\', "/")
                .replace('"', "\\\"")
        ),
    )
    .expect("package fixture");
    let package_plan = build_mxc_job(
        MxcJobRequest {
            workspace_path: root.to_string_lossy().into_owned(),
            command: node,
            args: vec![
                "--preserve-symlinks".to_string(),
                "--preserve-symlinks-main".to_string(),
                npm_cli.to_string_lossy().into_owned(),
                "run".to_string(),
                "build".to_string(),
            ],
            cwd: Some(root.to_string_lossy().into_owned()),
            env: BTreeMap::from([
                (
                    "npm_config_cache".to_string(),
                    root.join(".npm-cache").to_string_lossy().into_owned(),
                ),
                (
                    "npm_config_userconfig".to_string(),
                    root.join(".npmrc").to_string_lossy().into_owned(),
                ),
                (
                    "npm_config_update_notifier".to_string(),
                    "false".to_string(),
                ),
                ("npm_config_fund".to_string(), "false".to_string()),
                ("npm_config_audit".to_string(), "false".to_string()),
            ]),
            timeout_secs: 30,
        },
        &root.join("job-output").join("package"),
    )
    .expect("build package fixture job");
    let package_engine = JobEngine::new("boot-it", root.clone());
    let package_job = uuid::Uuid::new_v4().to_string();
    package_engine
        .start(&package_job, package_plan)
        .expect("start package fixture");
    let package_snapshot = wait_terminal(&package_engine, &package_job);
    assert_ne!(
        package_snapshot.status,
        JobStatus::Succeeded,
        "package fixture must not write outside the workspace"
    );
    assert!(
        !package_target.exists(),
        "package fixture escaped workspace"
    );
    package_engine
        .cleanup(&package_job)
        .expect("cleanup package fixture");
}

/// Engine restart: handles are not persisted, so a restarted Runtime cannot see
/// the previous process's jobs (CP marks them interrupted by bootId change).
#[test]
fn restarted_engine_cannot_see_previous_handles() {
    let root = temp_root("restart");
    let first = JobEngine::new("boot-one", root.clone());
    let job_id = uuid::Uuid::new_v4().to_string();
    first
        .start(
            &job_id,
            host_plan(&root, "cmd", &["/C", "ping -n 60 127.0.0.1 > nul"], 0),
        )
        .expect("start");
    assert!(!first.job_pids(&job_id).expect("pids").is_empty());
    drop(first); // Runtime shutdown terminates and closes the handles

    let second = JobEngine::new("boot-two", root.clone());
    assert!(matches!(
        second.snapshot(&job_id),
        Err(xihe_runtime::job_engine::JobEngineError::NotFound)
    ));
    assert!(matches!(
        second.cancel(&job_id),
        Err(xihe_runtime::job_engine::JobEngineError::NotFound)
    ));
    assert_eq!(second.active_count(), 0);
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

/// PLAN-0379 T3.5: a mode switch terminates every execution the previous mode
/// left behind, while jobs of other Workspaces keep running.
#[test]
fn mode_switch_terminates_previous_workspace_executions() {
    let root = temp_root("mode-switch");
    let engine = JobEngine::new("boot-switch", root.clone());
    let alpha_job = uuid::Uuid::new_v4().to_string();
    let beta_job = uuid::Uuid::new_v4().to_string();
    let long = ["/C", "ping -n 60 127.0.0.1 > nul"];

    engine
        .start_in_workspace(
            Some("ws-alpha"),
            &alpha_job,
            host_plan(&root, "cmd", &long, 0),
        )
        .expect("alpha start");
    engine
        .start_in_workspace(
            Some("ws-alpha"),
            &beta_job,
            host_plan(&root, "cmd", &long, 0),
        )
        .expect("beta start");
    let alpha_pids = loop {
        let pids = engine.job_pids(&alpha_job).expect("alpha pids");
        if !pids.is_empty() {
            break pids;
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    let beta_pids = loop {
        let pids = engine.job_pids(&beta_job).expect("beta pids");
        if !pids.is_empty() {
            break pids;
        }
        std::thread::sleep(Duration::from_millis(25));
    };

    let addressed = engine.terminate_workspace("ws-alpha");
    assert_eq!(addressed, 2, "both alpha jobs must be addressed");
    for pid in alpha_pids.iter().chain(beta_pids.iter()) {
        let started = Instant::now();
        loop {
            if pid_gone(*pid) {
                break;
            }
            assert!(
                started.elapsed() < Duration::from_secs(15),
                "pid {pid} survived the mode-switch termination"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    assert!(
        engine.handle(&alpha_job).is_err(),
        "alpha handle outlived the mode switch"
    );
    assert!(
        engine.handle(&beta_job).is_err(),
        "beta handle outlived the mode switch"
    );

    let other_job = uuid::Uuid::new_v4().to_string();
    engine
        .start_in_workspace(
            Some("ws-gamma"),
            &other_job,
            host_plan(&root, "cmd", &long, 0),
        )
        .expect("gamma start");
    assert_eq!(
        engine.terminate_workspace("ws-alpha"),
        0,
        "alpha has no jobs after its switch"
    );
    assert!(
        engine.handle(&other_job).is_ok(),
        "another workspace job must keep its handle"
    );
    assert_eq!(engine.active_count(), 1);
    let other_pids = engine.job_pids(&other_job).expect("gamma pids");
    assert!(engine.cancel(&other_job).expect("gamma cancel").changed);
    for pid in other_pids {
        assert!(pid_gone(pid), "pid {pid} survived the explicit cancel");
    }
    engine.cleanup(&other_job).expect("gamma cleanup");
}
