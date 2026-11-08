//! 本地 stdio 插件 runner 的启动规格。
//!
//! 规格只描述"起什么进程"，**不承载**授权、配额、binding 状态（那些在 CP）。
//! manifest 的 `runtime.kind = "mcp-stdio"` 只允许 `command` + `args`，所以这里**没有**
//! `command_line` 字符串：没有可注入的 shell，`program`/`args` 原样交给
//! `tokio::process::Command`（不经 shell 解释，也不做路径拼接）。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use thiserror::Error;

/// 握手（`initialize`）预算。
pub const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
/// 单次请求预算。
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// `stop()` 先关 stdin 等它自己退，超过这个时间再杀进程组。
pub const DEFAULT_STOP_GRACE: Duration = Duration::from_secs(2);
/// 单帧上限：与 `mcp_session::MAX_FRAME_BYTES` 取同一常量，避免两处口径漂移。
pub const DEFAULT_MAX_FRAME_BYTES: usize = crate::mcp_session::MAX_FRAME_BYTES;
/// 帧上限下界（再小连 `initialize` 都放不下）。
pub const MIN_MAX_FRAME_BYTES: usize = 1024;
/// 帧上限上界（再大等于没有上限）。
pub const MAX_MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// 父进程环境里允许透传给插件子进程的键。
///
/// 子进程一律 `env_clear()` 之后只加这些 + [`PluginRunnerSpec::env`]：插件需要的 secret 由 CP
/// 注入（manifest 不携带 secret，B-5），而父进程环境里可能有 CP token / 宿主凭据，
/// 顺手继承就是把攻击面白送出去。
pub const INHERITED_ENV_KEYS: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "HOME",
    "TMPDIR",
    "LANG",
];

/// 起一个本地 stdio 插件 runner 所需的全部信息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginRunnerSpec {
    /// 反向域名插件 id（对应 `plugins/official/<id>` 的 manifest `id`）。
    pub plugin_id: String,
    /// manifest `version`；空串表示未登记版本（注册表键退化成只有 id）。
    pub version: String,
    /// manifest `digest`（`sha256:...`）；本层只留证，不校验（校验在 CP 装包路径）。
    pub digest: String,
    /// 可执行文件。**不做 shell 解析**，也不允许包含 NUL。
    pub program: String,
    /// 命令行参数，逐个传给 `Command::args`。
    pub args: Vec<String>,
    /// 额外注入的环境变量（覆盖同名白名单键）。
    pub env: BTreeMap<String, String>,
    /// 工作目录；`None` 用 Runtime 自己的 cwd。
    pub cwd: Option<PathBuf>,
    /// 握手预算。
    pub startup_timeout: Duration,
    /// 单次请求预算。
    pub request_timeout: Duration,
    /// 关 stdin 后等它自己退的宽限。
    pub stop_grace: Duration,
    /// 单帧字节上限。
    pub max_frame_bytes: usize,
}

impl PluginRunnerSpec {
    /// 只要求 `plugin_id` 与 `program`，其余走默认值（builder 补齐）。
    #[must_use]
    pub fn new(plugin_id: impl Into<String>, program: impl Into<String>) -> Self {
        Self {
            plugin_id: plugin_id.into(),
            version: String::new(),
            digest: String::new(),
            program: program.into(),
            args: Vec::new(),
            env: BTreeMap::new(),
            cwd: None,
            startup_timeout: DEFAULT_STARTUP_TIMEOUT,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            stop_grace: DEFAULT_STOP_GRACE,
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES,
        }
    }

    #[must_use]
    pub fn with_version(mut self, version: impl Into<String>) -> Self {
        self.version = version.into();
        self
    }

    #[must_use]
    pub fn with_digest(mut self, digest: impl Into<String>) -> Self {
        self.digest = digest.into();
        self
    }

    #[must_use]
    pub fn with_args(mut self, args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.args = args.into_iter().map(Into::into).collect();
        self
    }

    #[must_use]
    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(key.into(), value.into());
        self
    }

    #[must_use]
    pub fn with_cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    #[must_use]
    pub fn with_startup_timeout(mut self, timeout: Duration) -> Self {
        self.startup_timeout = timeout;
        self
    }

    #[must_use]
    pub fn with_request_timeout(mut self, timeout: Duration) -> Self {
        self.request_timeout = timeout;
        self
    }

    #[must_use]
    pub fn with_stop_grace(mut self, grace: Duration) -> Self {
        self.stop_grace = grace;
        self
    }

    #[must_use]
    pub fn with_max_frame_bytes(mut self, max_frame_bytes: usize) -> Self {
        self.max_frame_bytes = max_frame_bytes;
        self
    }

    /// 注册表键：同一插件版本只允许一条 runner（binding 是 CP 侧概念，不进这个键）。
    #[must_use]
    pub fn runner_key(&self) -> String {
        if self.version.is_empty() {
            self.plugin_id.clone()
        } else {
            format!("{}@{}", self.plugin_id, self.version)
        }
    }

    /// 起进程前的**唯一**校验点。宁可起不来，也不要起一个参数可疑的进程。
    pub fn validate(&self) -> Result<(), SpecError> {
        if self.plugin_id.trim().is_empty() {
            return Err(SpecError::EmptyPluginId);
        }
        if self.program.trim().is_empty() {
            return Err(SpecError::EmptyProgram);
        }
        if self.program.contains('\0') {
            return Err(SpecError::NulByte { field: "program" });
        }
        if self.args.iter().any(|arg| arg.contains('\0')) {
            return Err(SpecError::NulByte { field: "args" });
        }
        for (field, timeout) in [
            ("startup_timeout", self.startup_timeout),
            ("request_timeout", self.request_timeout),
        ] {
            if timeout.is_zero() {
                return Err(SpecError::ZeroTimeout { field });
            }
        }
        if !(MIN_MAX_FRAME_BYTES..=MAX_MAX_FRAME_BYTES).contains(&self.max_frame_bytes) {
            return Err(SpecError::FrameBound {
                value: self.max_frame_bytes,
                min: MIN_MAX_FRAME_BYTES,
                max: MAX_MAX_FRAME_BYTES,
            });
        }
        Ok(())
    }
}

/// 规格校验失败。全部是"起进程之前就该拦住"的静态错误。
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SpecError {
    #[error("plugin id must not be empty")]
    EmptyPluginId,
    #[error("plugin runner program must not be empty")]
    EmptyProgram,
    #[error("{field} contains a NUL byte")]
    NulByte { field: &'static str },
    #[error("{field} must be greater than zero")]
    ZeroTimeout { field: &'static str },
    #[error("max frame bytes {value} outside [{min}, {max}]")]
    FrameBound {
        value: usize,
        min: usize,
        max: usize,
    },
}

/// 子进程环境：`env_clear()` 之后只保留 [`INHERITED_ENV_KEYS`] 里父进程已有的键，
/// 再叠加 `spec.env`（同键以 `spec.env` 为准）。
///
/// 白名单键统一按**大写**写回（Windows 环境变量本就大小写不敏感，大写化可避免
/// `PATH` / `Path` 两条同时进 `Command::envs` 导致取值不确定）；非 UTF-8 的父进程值直接
/// 跳过——健康快照和日志都是字符串，不把二进制噪声带进来。
#[must_use]
pub fn runner_env(spec: &PluginRunnerSpec) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    for (key, value) in std::env::vars_os() {
        let Some(name) = key.to_str() else { continue };
        let upper = name.to_ascii_uppercase();
        if !INHERITED_ENV_KEYS.contains(&upper.as_str()) {
            continue;
        }
        let Some(text) = value.to_str() else { continue };
        env.insert(upper, text.to_string());
    }
    for (key, value) in &spec.env {
        env.insert(key.clone(), value.clone());
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_the_documented_budget() {
        let spec = PluginRunnerSpec::new("official.fixture", "fixture");
        assert_eq!(spec.startup_timeout, DEFAULT_STARTUP_TIMEOUT);
        assert_eq!(spec.request_timeout, DEFAULT_REQUEST_TIMEOUT);
        assert_eq!(spec.stop_grace, DEFAULT_STOP_GRACE);
        assert_eq!(spec.max_frame_bytes, crate::mcp_session::MAX_FRAME_BYTES);
        assert_eq!(spec.max_frame_bytes, DEFAULT_MAX_FRAME_BYTES);
        assert!(spec.validate().is_ok());
    }

    #[test]
    fn runner_key_includes_the_version_only_when_present() {
        let spec = PluginRunnerSpec::new("official.fixture", "fixture");
        assert_eq!(spec.runner_key(), "official.fixture");
        assert_eq!(
            spec.clone().with_version("1.2.3").runner_key(),
            "official.fixture@1.2.3"
        );
    }

    #[test]
    fn validation_rejects_blank_program_and_bad_identifiers() {
        let blank_program = PluginRunnerSpec::new("official.fixture", "   ");
        assert_eq!(blank_program.validate(), Err(SpecError::EmptyProgram));
        let blank_id = PluginRunnerSpec::new("  ", "fixture");
        assert_eq!(blank_id.validate(), Err(SpecError::EmptyPluginId));
    }

    #[test]
    fn validation_rejects_zero_timeouts_and_out_of_range_frame_bound() {
        let no_startup = PluginRunnerSpec::new("official.fixture", "fixture")
            .with_startup_timeout(Duration::ZERO);
        assert_eq!(
            no_startup.validate(),
            Err(SpecError::ZeroTimeout {
                field: "startup_timeout"
            })
        );
        let no_request = PluginRunnerSpec::new("official.fixture", "fixture")
            .with_request_timeout(Duration::ZERO);
        assert_eq!(
            no_request.validate(),
            Err(SpecError::ZeroTimeout {
                field: "request_timeout"
            })
        );
        let too_small =
            PluginRunnerSpec::new("official.fixture", "fixture").with_max_frame_bytes(16);
        assert_eq!(
            too_small.validate(),
            Err(SpecError::FrameBound {
                value: 16,
                min: MIN_MAX_FRAME_BYTES,
                max: MAX_MAX_FRAME_BYTES,
            })
        );
        let too_large = PluginRunnerSpec::new("official.fixture", "fixture")
            .with_max_frame_bytes(MAX_MAX_FRAME_BYTES + 1);
        assert!(matches!(
            too_large.validate(),
            Err(SpecError::FrameBound { .. })
        ));
    }

    #[test]
    fn nul_bytes_cannot_reach_the_command_line() {
        let program = PluginRunnerSpec::new("official.fixture", "fix\0ture");
        assert_eq!(
            program.validate(),
            Err(SpecError::NulByte { field: "program" })
        );
        let args =
            PluginRunnerSpec::new("official.fixture", "fixture").with_args(["--flag", "bad\0arg"]);
        assert_eq!(args.validate(), Err(SpecError::NulByte { field: "args" }));
    }

    #[test]
    fn parent_environment_is_an_allowlist_and_spec_env_is_injected() {
        let spec = PluginRunnerSpec::new("official.fixture", "fixture")
            .with_env("XIHE_PLUGIN_TEST_TOKEN", "injected");
        let env = runner_env(&spec);
        assert_eq!(
            env.get("XIHE_PLUGIN_TEST_TOKEN").map(String::as_str),
            Some("injected")
        );
        // PATH 在父进程里必然存在，且在白名单里 ⇒ 必须透传（否则子进程找不着依赖）。
        assert!(
            env.keys().any(|key| key.eq_ignore_ascii_case("PATH")),
            "PATH should be inherited, got keys: {:?}",
            env.keys().collect::<Vec<_>>()
        );
        // 父进程里存在、但不在白名单的键一个都不许透传。
        let leaked: Vec<String> = std::env::vars()
            .map(|(key, _)| key)
            .filter(|key| {
                let upper = key.to_ascii_uppercase();
                // `spec.env` 显式注入的键不算泄露（父进程碰巧也有同名键时不能误判）。
                upper != "XIHE_PLUGIN_TEST_TOKEN" && !INHERITED_ENV_KEYS.contains(&upper.as_str())
            })
            .collect();
        assert!(
            !leaked.is_empty(),
            "test environment must have at least one non-allowlisted variable"
        );
        for key in leaked {
            assert!(
                !env.keys()
                    .any(|candidate| candidate.eq_ignore_ascii_case(&key)),
                "{key} must not be inherited by the plugin process"
            );
        }
    }
}
