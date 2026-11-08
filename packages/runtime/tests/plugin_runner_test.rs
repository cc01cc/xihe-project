//! T2.4a 的 L0 真进程验证。
//!
//! `cargo test --lib plugin` 只覆盖纯逻辑（规格校验、环境白名单、状态标签、协议帧配对）；
//! **进程托管必须在真进程上验**，所以这里另起 `xihe-plugin-fixture` 二进制当对端，
//! 断言独立 PID、握手、请求/超时、崩溃退出码、stderr 尾巴、环境白名单、限并发与回收。
//!
//! 样本是 `xihe-plugin-fixture`（**工艺样本，不是产品样本**）：B-6 的 `official.doc-index`
//! 真实插件包属 T2.4b，本卡没有它，所以本文件的绿不覆盖"真实插件能被加载并工作"。

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};
use xihe_runtime::plugin::spec::INHERITED_ENV_KEYS;
use xihe_runtime::plugin::{
    HostError, PluginRunner, PluginRunnerHost, PluginRunnerSpec, RunnerError, RunnerState,
};

/// 同一桩 fixture 里要注入的测试用环境变量名（不在继承白名单里，靠 `spec.env` 显式注入）。
const TEST_TOKEN_KEY: &str = "XIHE_PLUGIN_TEST_TOKEN";

fn fixture_program() -> String {
    env!("CARGO_BIN_EXE_xihe-plugin-fixture").to_string()
}

fn spec(version: &str) -> PluginRunnerSpec {
    PluginRunnerSpec::new("official.fixture", fixture_program())
        .with_version(version)
        .with_digest("sha256:fixture-process-sample")
        .with_startup_timeout(Duration::from_secs(10))
        .with_request_timeout(Duration::from_secs(5))
        .with_stop_grace(Duration::from_millis(500))
}

fn pid_path(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "xihe-plugin-fixture-{}-{tag}.pid",
        std::process::id()
    ))
}

/// 有界轮询等 pid 文件出现（不用固定 sleep 证明状态已发生）。
async fn wait_for_pid(path: &Path) -> u32 {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(text) = std::fs::read_to_string(path)
            && let Ok(pid) = text.trim().parse::<u32>()
        {
            return pid;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "pid file {} never received a pid",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn wait_for_stderr(runner: &PluginRunner, needle: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if runner
            .stderr_tail()
            .iter()
            .any(|line| line.contains(needle))
        {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "stderr tail never contained {needle:?}: {:?}",
            runner.stderr_tail()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn runner_handshakes_in_its_own_process() {
    let path = pid_path("handshake");
    let mut runner = PluginRunner::start(spec("0.1.0").with_args([
        "--pid-file".to_string(),
        path.to_string_lossy().into_owned(),
    ]))
    .await
    .expect("fixture runner should start");

    assert_eq!(runner.state(), &RunnerState::Ready);
    let child_pid = runner.pid().expect("child pid must be visible");
    assert_ne!(
        child_pid,
        std::process::id(),
        "插件必须在独立进程里跑（独立 PID），不能是 Runtime 自身"
    );
    assert_eq!(runner.spec().runner_key(), "official.fixture@0.1.0");

    // 子进程自己写下的 pid 必须等于 runner 报告的 pid：证明"独立 PID"不是我们自己编的。
    let recorded = wait_for_pid(&path).await;
    assert_eq!(recorded, child_pid);

    runner.stop().await.expect("graceful stop");
    assert_eq!(runner.state(), &RunnerState::Stopped);
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn runner_answers_requests_and_survives_a_method_error() {
    let mut runner = PluginRunner::start(spec("0.1.0"))
        .await
        .expect("fixture runner should start");

    let result = runner
        .request("tools/list", json!({}))
        .await
        .expect("tools/list should answer");
    let tools = result
        .get("tools")
        .and_then(Value::as_array)
        .expect("tools array");
    assert_eq!(tools.len(), 1);
    assert_eq!(
        tools[0].get("name").and_then(Value::as_str),
        Some("echo"),
        "fixture 只暴露一个 echo 工具"
    );

    // 未知方法要变成可处理的 `Protocol` 错误，而不是 panic 或静默挂死。
    let error = runner
        .request("nope/unknown", json!({}))
        .await
        .expect_err("unknown method must be an error");
    assert!(
        matches!(error, RunnerError::Protocol { .. }),
        "unexpected error: {error:?}"
    );
    // 协议级错误不该把 runner 判死：同一进程还能继续服务。
    assert_eq!(runner.state(), &RunnerState::Ready);
    let again = runner
        .request("tools/list", json!({}))
        .await
        .expect("runner should still answer after a method error");
    assert!(again.get("tools").is_some());

    runner.stop().await.expect("graceful stop");
}

#[tokio::test]
async fn parent_environment_is_not_inherited_but_spec_env_is() {
    let mut runner = PluginRunner::start(spec("0.1.0").with_env(TEST_TOKEN_KEY, "injected-token"))
        .await
        .expect("fixture runner should start");

    let result = runner
        .request("_fixture/env", json!({}))
        .await
        .expect("_fixture/env should answer");
    assert_eq!(
        result.get("token").and_then(Value::as_str),
        Some("injected-token"),
        "spec.env 必须注入到子进程"
    );

    let names: Vec<String> = result
        .get("envNames")
        .and_then(Value::as_array)
        .expect("envNames array")
        .iter()
        .filter_map(|value| value.as_str().map(str::to_string))
        .collect();
    assert!(
        names.iter().any(|name| name.eq_ignore_ascii_case("PATH")),
        "PATH 属于继承白名单，必须透传：{names:?}"
    );
    let mut allowed: Vec<String> = INHERITED_ENV_KEYS
        .iter()
        .map(|key| (*key).to_string())
        .collect();
    allowed.push(TEST_TOKEN_KEY.to_string());
    for name in &names {
        assert!(
            allowed.iter().any(|candidate| candidate == name),
            "{name} 不在白名单里，却出现在了插件进程中"
        );
    }

    runner.stop().await.expect("graceful stop");
}

#[tokio::test]
async fn request_timeout_is_fail_closed() {
    let mut runner =
        PluginRunner::start(spec("0.1.0").with_request_timeout(Duration::from_millis(300)))
            .await
            .expect("fixture runner should start");

    let error = runner
        .request("_fixture/hang", json!({}))
        .await
        .expect_err("hang must time out");
    assert!(
        matches!(error, RunnerError::Timeout { .. }),
        "unexpected error: {error:?}"
    );
    // 超时后必须判死：迟到的应答不能再被下一次请求认领。
    assert!(
        matches!(runner.state(), RunnerState::Crashed { .. }),
        "state after timeout: {:?}",
        runner.state()
    );
    let refused = runner
        .request("tools/list", json!({}))
        .await
        .expect_err("crashed runner must refuse new requests");
    assert!(
        matches!(refused, RunnerError::NotRunning { .. }),
        "unexpected error: {refused:?}"
    );
    assert_eq!(runner.health("official.fixture@0.1.0").state, "crashed");
}

#[tokio::test]
async fn crash_reports_the_exit_code() {
    let mut runner = PluginRunner::start(spec("0.1.0"))
        .await
        .expect("fixture runner should start");

    let error = runner
        .request("_fixture/crash", json!({}))
        .await
        .expect_err("crash must be reported");
    match error {
        RunnerError::Closed { exit_code } => assert_eq!(exit_code, Some(3)),
        other => panic!("unexpected error: {other:?}"),
    }
    assert_eq!(runner.state(), &RunnerState::Crashed { exit_code: Some(3) });

    let health = runner.health("official.fixture@0.1.0");
    assert_eq!(health.key, "official.fixture@0.1.0");
    assert_eq!(health.plugin_id, "official.fixture");
    assert_eq!(health.version, "0.1.0");
    assert_eq!(health.digest, "sha256:fixture-process-sample");
    assert_eq!(health.state, "crashed");
    assert_eq!(health.exit_code, Some(3));
}

#[tokio::test]
async fn stop_is_idempotent() {
    let mut runner = PluginRunner::start(spec("0.1.0"))
        .await
        .expect("fixture runner should start");
    assert!(runner.pid().is_some());

    runner.stop().await.expect("first stop");
    runner.stop().await.expect("second stop is a no-op");
    assert_eq!(runner.state(), &RunnerState::Stopped);
    assert_eq!(runner.health("k").state, "stopped");
}

#[tokio::test]
async fn stderr_is_kept_in_a_bounded_tail() {
    let mut runner = PluginRunner::start(spec("0.1.0"))
        .await
        .expect("fixture runner should start");

    runner
        .request("_fixture/stderr", json!({}))
        .await
        .expect("_fixture/stderr should answer");
    wait_for_stderr(&runner, "stderr marker").await;
    assert!(runner.stderr_lines() >= 1);
    assert!(
        runner
            .stderr_tail()
            .iter()
            .any(|line| line.contains("marker"))
    );

    runner.stop().await.expect("graceful stop");
}

#[tokio::test]
async fn oversized_request_frame_is_rejected_before_it_is_written() {
    let mut runner = PluginRunner::start(spec("0.1.0").with_max_frame_bytes(1024))
        .await
        .expect("fixture runner should start");

    let error = runner
        .request("_fixture/env", json!({"padding": "x".repeat(4096)}))
        .await
        .expect_err("oversized frame must be rejected");
    assert!(
        matches!(error, RunnerError::FrameTooLarge { limit: 1024 }),
        "unexpected error: {error:?}"
    );
    // 超大帧是调用方的问题，不是插件的错：runner 还能继续接活。
    assert_eq!(runner.state(), &RunnerState::Ready);
    runner
        .request("tools/list", json!({}))
        .await
        .expect("runner should still answer after rejecting an oversized frame");

    runner.stop().await.expect("graceful stop");
}

#[tokio::test]
async fn host_caps_runners_and_routes_by_key() {
    let mut host = PluginRunnerHost::new(1);
    let key = host
        .start(spec("0.1.0"))
        .await
        .expect("first runner should start");
    assert_eq!(key, "official.fixture@0.1.0");
    assert!(host.contains(&key));
    assert!(!host.is_empty());

    let tools = host
        .request(&key, "tools/list", json!({}))
        .await
        .expect("host should route the request");
    assert!(tools.get("tools").is_some());

    let error = host
        .start(spec("0.2.0"))
        .await
        .expect_err("cap must reject a second runner");
    assert!(
        matches!(error, HostError::TooManyRunners { max: 1 }),
        "unexpected error: {error:?}"
    );
    let unknown = host
        .request("official.missing@1.0.0", "tools/list", json!({}))
        .await
        .expect_err("unknown key must fail closed");
    assert!(
        matches!(unknown, HostError::UnknownRunner { .. }),
        "unexpected error: {unknown:?}"
    );
    assert_eq!(host.health().len(), 1);
    assert_eq!(host.health()[0].key, key);

    host.stop_all().await;
    assert!(host.is_empty());
}

#[tokio::test]
async fn host_prunes_a_crashed_runner_and_frees_the_slot() {
    let mut host = PluginRunnerHost::new(1);
    let key = host
        .start(spec("0.1.0"))
        .await
        .expect("runner should start");

    let error = host
        .request(&key, "_fixture/crash", json!({}))
        .await
        .expect_err("crash must be reported");
    assert!(
        matches!(error, HostError::Runner(RunnerError::Closed { .. })),
        "unexpected error: {error:?}"
    );

    let pruned = host.prune().await;
    assert_eq!(pruned, vec![key.clone()]);
    assert!(host.is_empty());

    // 回收后槽位必须释放：否则一次插件崩溃就会永久占掉并发额度。
    let again = host
        .start(spec("0.1.0"))
        .await
        .expect("slot should be free after prune");
    assert_eq!(again, key);
    assert_eq!(host.prune().await, Vec::<String>::new());
    host.stop_all().await;
}

#[tokio::test]
async fn duplicate_runner_is_rejected_without_a_second_process() {
    let mut host = PluginRunnerHost::new(4);
    let key = host
        .start(spec("0.1.0"))
        .await
        .expect("first runner should start");

    let error = host
        .start(spec("0.1.0"))
        .await
        .expect_err("duplicate must be rejected");
    assert!(
        matches!(error, HostError::DuplicateRunner { .. }),
        "unexpected error: {error:?}"
    );
    assert_eq!(host.len(), 1);
    assert!(host.contains(&key));

    host.stop_all().await;
}
