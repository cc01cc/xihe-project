//! PLAN-0308 M1：MCP 工具超时值的取值与传递。
//!
//! 口径（详见 `plans/PLAN-0308-XH-mcp-timeout-debts/spec/timeout-target.md` S1/S2）：
//! 超时计算只在 CP 发生；Runtime 只做三条判断——
//! per-call（可压过本模块 ENV）→ 本模块 ENV → CP 下发值 → 代码默认。
//! 生效值经 task_local 传给 `executor::exec_oneshot`（同 task 内联 await，无 spawn 打断）。

use axum::http::{HeaderMap, request};
use tokio::task_local;

/// 离线 / 直连 / 单测（无下发值且无 ENV）时的兜底等待。
pub const DEFAULT_WAIT_SECS: u64 = 30;

/// 出站头：CP 下发的最终等待值（只由 CP 设置，见 spec S2.2 规则 5）。
pub const HEADER_TIMEOUT: &str = "x-xihe-tool-timeout-s";
/// 出站头：值的性质（`per-call` | `config`）。
pub const HEADER_ORIGIN: &str = "x-xihe-tool-timeout-origin";
/// 本模块 ENV 覆盖键（部署者本地上限）。
pub const ENV_KEY: &str = "XIHE_EXEC_COLLECT_TIMEOUT_S";

/// 生效值的来源（spec S5 `source` 字段）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitSource {
    Env,
    Cp,
    Default,
}

impl WaitSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Env => "env",
            Self::Cp => "cp",
            Self::Default => "default",
        }
    }
}

/// 下发值的性质（spec S1 `valueOrigin` 字段；per-call 最高）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueOrigin {
    PerCall,
    Config,
}

impl ValueOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PerCall => "per-call",
            Self::Config => "config",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "per-call" | "per_call" | "percall" => Some(Self::PerCall),
            "config" => Some(Self::Config),
            _ => None,
        }
    }
}

/// 一次工具调用的生效等待值 + 署名信息。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EffectiveWait {
    pub seconds: u64,
    pub source: WaitSource,
    pub value_origin: Option<ValueOrigin>,
    /// 被本跳压制的另一个值（署名用：谁被忽略）。
    pub overridden_seconds: Option<u64>,
}

impl EffectiveWait {
    /// 单行署名（字段口径 = spec S5 / S5.1）。
    pub fn signature(&self) -> String {
        let mut out = format!(
            "layer=runtime_exec effectiveSeconds={} source={}",
            self.seconds,
            self.source.as_str()
        );
        if let Some(origin) = self.value_origin {
            out.push_str(&format!(" valueOrigin={}", origin.as_str()));
        }
        if let Some(value) = self.overridden_seconds {
            out.push_str(&format!(" overriddenSeconds={value}"));
        }
        out
    }

    /// 超时发生时的署名：附 `origin=self`（Runtime 是最内层，到界即源头）。
    pub fn timeout_signature(&self) -> String {
        format!("{} origin=self", self.signature())
    }
}

task_local! {
    static EFFECTIVE_WAIT: EffectiveWait;
}

/// 在 task_local 作用域内执行本次工具调用；`exec_oneshot` 由此读取生效值。
pub async fn scope<F: std::future::Future>(effective: EffectiveWait, future: F) -> F::Output {
    EFFECTIVE_WAIT.scope(effective, future).await
}

/// 当前生效值；无 scope（直连 MCP / 单测）时返回 None。
pub fn current() -> Option<EffectiveWait> {
    EFFECTIVE_WAIT.try_with(|value| *value).ok()
}

/// 当前生效值；无 scope 时按"仅 ENV / 默认"即时解析（离线兜底路径）。
pub fn current_or_resolve() -> EffectiveWait {
    current().unwrap_or_else(|| resolve(None, env_override()))
}

/// 当前署名字符串（超时错误 detail 与日志使用）。
pub fn current_signature() -> String {
    current_or_resolve().signature()
}

/// 读取本模块 ENV 覆盖；非法值 WARN 后忽略（fail-closed，不放大）。
pub fn env_override() -> Option<u64> {
    match std::env::var(ENV_KEY) {
        Ok(raw) => match raw.trim().parse::<u64>() {
            Ok(value) if value > 0 => Some(value),
            _ => {
                tracing::warn!(key = ENV_KEY, value = %raw, "invalid tool timeout env; ignoring");
                None
            }
        },
        Err(_) => None,
    }
}

/// 三条判断（spec S1）。`delivered` = CP 下发的 (秒数, 性质)。
pub fn resolve(delivered: Option<(u64, Option<ValueOrigin>)>, env: Option<u64>) -> EffectiveWait {
    match (delivered, env) {
        // per-call 最高：压过本模块 ENV（署名记录被压制的 ENV 值）
        (Some((secs, Some(ValueOrigin::PerCall))), env_secs) => EffectiveWait {
            seconds: secs,
            source: WaitSource::Cp,
            value_origin: Some(ValueOrigin::PerCall),
            overridden_seconds: env_secs,
        },
        // 本模块 ENV 显式 → 用它，压制 config 下发值
        (Some((secs, origin)), Some(env_secs)) => EffectiveWait {
            seconds: env_secs,
            source: WaitSource::Env,
            value_origin: origin,
            overridden_seconds: Some(secs),
        },
        // 用下发值
        (Some((secs, origin)), None) => EffectiveWait {
            seconds: secs,
            source: WaitSource::Cp,
            value_origin: origin,
            overridden_seconds: None,
        },
        (None, Some(env_secs)) => EffectiveWait {
            seconds: env_secs,
            source: WaitSource::Env,
            value_origin: None,
            overridden_seconds: None,
        },
        (None, None) => EffectiveWait {
            seconds: DEFAULT_WAIT_SECS,
            source: WaitSource::Default,
            value_origin: None,
            overridden_seconds: None,
        },
    }
}

/// 从请求头解析下发值；缺头或非法值 → None（退回 ENV / 默认）。
pub fn delivered_from_headers(headers: &HeaderMap) -> Option<(u64, Option<ValueOrigin>)> {
    let secs = headers
        .get(HEADER_TIMEOUT)
        .and_then(|value| value.to_str().ok())
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|secs| *secs > 0)?;
    let origin = headers
        .get(HEADER_ORIGIN)
        .and_then(|value| value.to_str().ok())
        .and_then(ValueOrigin::parse);
    Some((secs, origin))
}

/// 从 rmcp 请求上下文 extensions 取头并解析（HTTP transport 由 `handle_post` 注入 Parts）。
pub fn resolve_from_extensions(extensions: &rmcp::model::Extensions) -> Option<EffectiveWait> {
    let parts = extensions.get::<request::Parts>()?;
    Some(resolve(
        delivered_from_headers(&parts.headers),
        env_override(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn per_call_beats_env_and_is_signed() {
        let effective = resolve(Some((120, Some(ValueOrigin::PerCall))), Some(60));
        assert_eq!(effective.seconds, 120);
        assert_eq!(effective.source, WaitSource::Cp);
        assert_eq!(effective.value_origin, Some(ValueOrigin::PerCall));
        assert_eq!(effective.overridden_seconds, Some(60));
        let signature = effective.signature();
        assert!(signature.contains("source=cp"), "{signature}");
        assert!(signature.contains("valueOrigin=per-call"), "{signature}");
        assert!(signature.contains("overriddenSeconds=60"), "{signature}");
    }

    #[test]
    fn env_beats_config_delivery() {
        let effective = resolve(Some((90, Some(ValueOrigin::Config))), Some(60));
        assert_eq!(effective.seconds, 60);
        assert_eq!(effective.source, WaitSource::Env);
        assert_eq!(effective.overridden_seconds, Some(90));
    }

    #[test]
    fn delivered_value_wins_without_env() {
        let effective = resolve(Some((90, Some(ValueOrigin::Config))), None);
        assert_eq!(effective.seconds, 90);
        assert_eq!(effective.source, WaitSource::Cp);
        assert_eq!(effective.value_origin, Some(ValueOrigin::Config));
        assert_eq!(effective.overridden_seconds, None);
    }

    #[test]
    fn env_only_and_default_fallback() {
        let env_only = resolve(None, Some(45));
        assert_eq!(env_only.seconds, 45);
        assert_eq!(env_only.source, WaitSource::Env);

        let fallback = resolve(None, None);
        assert_eq!(fallback.seconds, DEFAULT_WAIT_SECS);
        assert_eq!(fallback.source, WaitSource::Default);
    }

    #[test]
    fn headers_are_parsed_with_origin() {
        let mut headers = HeaderMap::new();
        headers.insert(HEADER_TIMEOUT, "150".parse().unwrap());
        headers.insert(HEADER_ORIGIN, "per-call".parse().unwrap());
        let delivered = delivered_from_headers(&headers).expect("header parsed");
        assert_eq!(delivered.0, 150);
        assert_eq!(delivered.1, Some(ValueOrigin::PerCall));
    }

    #[test]
    fn invalid_headers_fall_back() {
        let mut headers = HeaderMap::new();
        headers.insert(HEADER_TIMEOUT, "not-a-number".parse().unwrap());
        assert!(delivered_from_headers(&headers).is_none());

        let mut zero = HeaderMap::new();
        zero.insert(HEADER_TIMEOUT, "0".parse().unwrap());
        assert!(delivered_from_headers(&zero).is_none());
    }

    #[tokio::test]
    async fn scope_exposes_effective_wait() {
        let effective = resolve(Some((90, Some(ValueOrigin::Config))), None);
        let seen = scope(effective, async { current() }).await;
        assert_eq!(seen, Some(effective));
        assert!(current().is_none(), "scope must end with the future");
    }
}
