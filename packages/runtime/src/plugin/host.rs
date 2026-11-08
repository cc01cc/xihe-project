//! 多 runner 注册表：限并发、健康快照、崩溃回收。
//!
//! 只做进程级编排；binding / 授权 / 配额判定全在 CP（T2.4b 经 internal API 调这里）。
//! 单 owner 的 `&mut self`：想并行就 spawn 多个 runner，不要把这里做成全局单例
//! （全局单例会把"谁在什么时候停了谁"变成隐式状态）。

use std::collections::BTreeMap;

use serde_json::Value;
use thiserror::Error;

use crate::plugin::runner::{PluginRunner, RunnerError, RunnerHealth};
use crate::plugin::spec::PluginRunnerSpec;

/// 注册表操作失败。`Runner(_)` 是单个 runner 的生命周期失败，其余是编排层失败。
#[derive(Debug, Error)]
pub enum HostError {
    #[error("plugin runner limit reached ({max})")]
    TooManyRunners { max: usize },
    #[error("plugin runner {key} is already registered")]
    DuplicateRunner { key: String },
    #[error("plugin runner {key} is not registered")]
    UnknownRunner { key: String },
    #[error(transparent)]
    Runner(#[from] RunnerError),
}

/// 一组本地 stdio 插件 runner 的宿主注册表。
pub struct PluginRunnerHost {
    max_runners: usize,
    runners: BTreeMap<String, PluginRunner>,
}

impl PluginRunnerHost {
    /// `max_runners = 0` 会被夹到 1：注册表空转没有意义，静默关死比"以为配 0 就没人能起"
    /// 更难排查（起不来时至少能看到 `TooManyRunners { max: 1 }`）。
    #[must_use]
    pub fn new(max_runners: usize) -> Self {
        Self {
            max_runners: max_runners.max(1),
            runners: BTreeMap::new(),
        }
    }

    #[must_use]
    pub fn max_runners(&self) -> usize {
        self.max_runners
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.runners.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.runners.is_empty()
    }

    #[must_use]
    pub fn contains(&self, key: &str) -> bool {
        self.runners.contains_key(key)
    }

    /// spawn 并握手；成功返回注册表键（`plugin_id@version`）。
    ///
    /// 上界判定在 spawn **之前**：超限时不先起进程再返回错误（避免起完就杀的抖动）。
    pub async fn start(&mut self, spec: PluginRunnerSpec) -> Result<String, HostError> {
        let key = spec.runner_key();
        if self.runners.contains_key(&key) {
            return Err(HostError::DuplicateRunner { key });
        }
        if self.runners.len() >= self.max_runners {
            return Err(HostError::TooManyRunners {
                max: self.max_runners,
            });
        }
        let runner = PluginRunner::start(spec).await?;
        self.runners.insert(key.clone(), runner);
        Ok(key)
    }

    /// 按注册表键发请求。未知键直接 `UnknownRunner`，不会顺手新建（fail-closed）。
    pub async fn request(
        &mut self,
        key: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, HostError> {
        let runner = self
            .runners
            .get_mut(key)
            .ok_or_else(|| HostError::UnknownRunner {
                key: key.to_string(),
            })?;
        Ok(runner.request(method, params).await?)
    }

    /// 停掉并摘除一个 runner（幂等：不认识这个键就报 `UnknownRunner`，不静默通过）。
    pub async fn stop(&mut self, key: &str) -> Result<(), HostError> {
        let mut runner = self
            .runners
            .remove(key)
            .ok_or_else(|| HostError::UnknownRunner {
                key: key.to_string(),
            })?;
        runner.stop().await?;
        Ok(())
    }

    /// 健康快照（按键排序）。
    #[must_use]
    pub fn health(&self) -> Vec<RunnerHealth> {
        self.runners
            .iter()
            .map(|(key, runner)| runner.health(key))
            .collect()
    }

    /// 崩溃回收：摘掉已判死的 runner（`crashed` / `stopped`），返回被摘掉的键。
    /// 摘之前再 `stop()` 一次，确保进程被 reap（不留僵尸）。
    pub async fn prune(&mut self) -> Vec<String> {
        let dead: Vec<String> = self
            .runners
            .iter()
            .filter(|(_, runner)| runner.state().is_terminal())
            .map(|(key, _)| key.clone())
            .collect();
        for key in &dead {
            if let Some(mut runner) = self.runners.remove(key)
                && let Err(error) = runner.stop().await
            {
                tracing::warn!(key = %key, error = %error, "plugin runner prune stop failed");
            }
        }
        dead
    }

    /// 停掉全部 runner（进程关闭 / 测试收尾用）。单个失败只 WARN，不阻断其余回收。
    pub async fn stop_all(&mut self) {
        for (key, mut runner) in std::mem::take(&mut self.runners) {
            if let Err(error) = runner.stop().await {
                tracing::warn!(key = %key, error = %error, "plugin runner stop failed");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::runner::RunnerState;
    use crate::plugin::spec::SpecError;

    #[test]
    fn zero_limit_is_clamped_to_one() {
        let host = PluginRunnerHost::new(0);
        assert_eq!(host.max_runners(), 1);
        assert!(host.is_empty());
        assert_eq!(host.len(), 0);
        assert!(!host.contains("official.fixture"));
        assert!(host.health().is_empty());
    }

    #[test]
    fn limit_and_duplicate_errors_carry_their_context() {
        let too_many = HostError::TooManyRunners { max: 2 };
        assert_eq!(too_many.to_string(), "plugin runner limit reached (2)");
        let duplicate = HostError::DuplicateRunner {
            key: "official.fixture@0.1.0".to_string(),
        };
        assert!(duplicate.to_string().contains("official.fixture@0.1.0"));
        let unknown = HostError::UnknownRunner {
            key: "official.missing".to_string(),
        };
        assert_eq!(
            unknown.to_string(),
            "plugin runner official.missing is not registered"
        );
    }

    #[test]
    fn runner_errors_convert_into_host_errors() {
        let host_error: HostError = RunnerError::Spec(SpecError::EmptyProgram).into();
        assert!(matches!(host_error, HostError::Runner(_)));
        assert_eq!(
            host_error.to_string(),
            "plugin runner program must not be empty"
        );
    }

    #[test]
    fn terminal_states_are_prunable_and_live_ones_are_not() {
        assert!(RunnerState::Crashed { exit_code: Some(1) }.is_terminal());
        assert!(RunnerState::Stopped.is_terminal());
        assert!(!RunnerState::Starting.is_terminal());
        assert!(!RunnerState::Ready.is_terminal());
    }
}
