//! PLAN-0308 M1：MCP 工具超时值的取值与传递。
//!
//! 口径（详见 `plans/PLAN-0308-XH-mcp-timeout-debts/spec/timeout-target.md` S1/S2）：
//! 超时计算只在 CP 发生；Runtime 只做三条判断——
//! per-call（可压过本模块 ENV）→ 本模块 ENV → CP 下发值 → 代码默认。
//! 生效值经 task_local 传给 `executor::exec_oneshot`（同 task 内联 await，无 spawn 打断）。

use axum::http::{request, HeaderMap};
use tokio::task_local;

/// 离线 / 直连 / 单测（无下发值且无 ENV）时的兜底等待。
pub const DEFAULT_WAIT_SECS: u64 = 30;

/// 出站头：CP 下发的最终等待值（只由 CP 设置，见 spec S2.2 规则 5）。
pub const HEADER_TIMEOUT: &str = "x-xihe-tool-timeout-s";
/// 出站头：值的性质（`per-call` | `config`）。
pub const HEADER_ORIGIN: &str = "x-xihe-tool-timeout-origin";
/// 本模块 ENV 覆盖键（部署者本地上限）。
pub const ENV_KEY: &str = "XIHE_EXEC_COLLECT_TIMEOUT_S";
/// 关联键（spec S5.1）：CP 透传的 toolCallId / runId / requestId（同一工具调用跨三层可检索）。
pub const HEADER_TOOL_CALL_ID: &str = "x-operation-item-id";
pub const HEADER_RUN_ID: &str = "x-chat-run-id";
pub const HEADER_REQUEST_ID: &str = "x-request-id";
/// 出站头：CP 下发的单次工具返回字节上限（授权值；只由 CP 设置，见决策 #31 ②）。
pub const HEADER_OUTPUT_LIMIT: &str = "x-xihe-tool-output-limit";

/// 授权（授权值）→ 时间守卫（决策 #31 ①）：**调用方只可收窄**，超出授权无效。
pub fn time_guard(authorized_secs: u64, caller_secs: Option<u64>) -> u64 {
    match caller_secs {
        Some(caller) if caller > 0 && caller < authorized_secs => caller,
        _ => authorized_secs,
    }
}

/// 授权（授权值）→ 输出守卫（决策 #31 ②）：调用方只可收窄；授权缺省时沿用调用方
/// （两者都没有 → None，交由沙盒的既有默认值）。
pub fn output_limit_guard(authorized: Option<u64>, caller: Option<u64>) -> Option<u64> {
    match (authorized, caller) {
        (Some(auth), Some(call)) => Some(auth.min(call)),
        (Some(auth), None) => Some(auth),
        (None, call) => call,
    }
}

/// 从请求头解析输出上限（缺头/非法/0 → None）。
pub fn output_limit_from_headers(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(HEADER_OUTPUT_LIMIT)
        .and_then(|value| value.to_str().ok())
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|limit| *limit > 0)
}

/// 从 rmcp 请求上下文 extensions 取输出上限。
pub fn output_limit_from_extensions(extensions: &rmcp::model::Extensions) -> Option<u64> {
    extensions
        .get::<request::Parts>()
        .and_then(|parts| output_limit_from_headers(&parts.headers))
}

/// 一次工具调用的关联键（spec S5.1 规则 1：三层日志共用；缺失时留空不猜测）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Correlation {
    pub tool_call_id: Option<String>,
    pub run_id: Option<String>,
    pub request_id: Option<String>,
}

impl Correlation {
    /// 单行追加载荷（署名后缀；无任何键时为空串）。
    pub fn render(&self) -> String {
        let mut out = String::new();
        if let Some(id) = &self.tool_call_id {
            out.push_str(&format!(" toolCallId={id}"));
        }
        if let Some(id) = &self.run_id {
            out.push_str(&format!(" runId={id}"));
        }
        if let Some(id) = &self.request_id {
            out.push_str(&format!(" requestId={id}"));
        }
        out
    }
}

/// 从请求头解析关联键（HTTP transport 经 Parts 注入；直连/单测缺失时全空）。
pub fn correlation_from_headers(headers: &HeaderMap) -> Correlation {
    let value = |name: &str| {
        headers
            .get(name)
            .and_then(|raw| raw.to_str().ok())
            .map(str::trim)
            .filter(|raw| !raw.is_empty())
            .map(str::to_string)
    };
    Correlation {
        tool_call_id: value(HEADER_TOOL_CALL_ID),
        run_id: value(HEADER_RUN_ID),
        request_id: value(HEADER_REQUEST_ID),
    }
}

/// 从 rmcp 请求上下文 extensions 取关联键。
pub fn correlation_from_extensions(extensions: &rmcp::model::Extensions) -> Correlation {
    extensions
        .get::<request::Parts>()
        .map(|parts| correlation_from_headers(&parts.headers))
        .unwrap_or_default()
}

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
    static CORRELATION: Correlation;
    static OUTPUT_LIMIT: Option<u64>;
}

/// 在 task_local 作用域内执行本次工具调用；`exec_oneshot` 由此读取生效值。
pub async fn scope<F: std::future::Future>(effective: EffectiveWait, future: F) -> F::Output {
    EFFECTIVE_WAIT.scope(effective, future).await
}

/// 同 `scope`，并携带本次调用的关联键（spec S5.1）。
pub async fn scope_with_correlation<F: std::future::Future>(
    effective: EffectiveWait,
    correlation: Correlation,
    future: F,
) -> F::Output {
    EFFECTIVE_WAIT
        .scope(effective, CORRELATION.scope(correlation, future))
        .await
}

/// 完整作用域：生效值 + 关联键 + 输出上限授权（决策 #31 ②）。
pub async fn scope_tool_call<F: std::future::Future>(
    effective: EffectiveWait,
    correlation: Correlation,
    output_limit: Option<u64>,
    future: F,
) -> F::Output {
    EFFECTIVE_WAIT
        .scope(
            effective,
            CORRELATION.scope(correlation, OUTPUT_LIMIT.scope(output_limit, future)),
        )
        .await
}

/// 当前关联键；无 scope（直连 MCP / 单测）时全空。
pub fn current_correlation() -> Correlation {
    CORRELATION
        .try_with(|value| value.clone())
        .unwrap_or_default()
}

/// 当前输出上限授权；无 scope 时为 None（沿用调用方值 / 沙盒默认）。
pub fn current_output_limit() -> Option<u64> {
    OUTPUT_LIMIT.try_with(|value| *value).ok().flatten()
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

    #[test]
    fn correlation_headers_are_parsed_and_rendered() {
        let mut headers = HeaderMap::new();
        headers.insert(HEADER_TOOL_CALL_ID, "call-abc-123".parse().unwrap());
        headers.insert(HEADER_RUN_ID, "run-1".parse().unwrap());
        let correlation = correlation_from_headers(&headers);
        assert_eq!(correlation.tool_call_id.as_deref(), Some("call-abc-123"));
        assert_eq!(correlation.run_id.as_deref(), Some("run-1"));
        assert_eq!(correlation.request_id, None);
        let rendered = correlation.render();
        assert!(rendered.contains("toolCallId=call-abc-123"), "{rendered}");
        assert!(rendered.contains("runId=run-1"), "{rendered}");
        assert!(!rendered.contains("requestId="), "{rendered}");
    }

    #[test]
    fn correlation_render_is_empty_without_keys() {
        assert_eq!(Correlation::default().render(), "");
    }

    #[tokio::test]
    async fn scope_with_correlation_exposes_ids() {
        let effective = resolve(Some((90, Some(ValueOrigin::Config))), None);
        let correlation = Correlation {
            tool_call_id: Some("call-1".to_string()),
            ..Correlation::default()
        };
        let seen = scope_with_correlation(effective, correlation.clone(), async {
            (current(), current_correlation())
        })
        .await;
        assert_eq!(seen.0, Some(effective));
        assert_eq!(seen.1.tool_call_id.as_deref(), Some("call-1"));
        assert_eq!(current_correlation(), Correlation::default());
    }

    // ── T3.4（决策 #31）：授权 → 守卫派生（调用方只可收窄） ──────────────────────

    #[test]
    fn time_guard_derives_from_authorization_and_only_narrows() {
        // 无调用方值 → 守卫 = 授权
        assert_eq!(time_guard(90, None), 90);
        // 调用方给更小 → 收窄
        assert_eq!(time_guard(90, Some(20)), 20);
        // 调用方给更大 → 无效（超出授权）
        assert_eq!(time_guard(90, Some(600)), 90);
        // 非法值（0）忽略
        assert_eq!(time_guard(90, Some(0)), 90);
    }

    #[test]
    fn output_limit_guard_only_narrows_and_falls_back() {
        assert_eq!(output_limit_guard(Some(8192), None), Some(8192));
        assert_eq!(output_limit_guard(Some(8192), Some(1024)), Some(1024));
        assert_eq!(output_limit_guard(Some(8192), Some(65536)), Some(8192));
        // 无授权时沿用调用方；两者皆无 → None（沙盒默认）
        assert_eq!(output_limit_guard(None, Some(1024)), Some(1024));
        assert_eq!(output_limit_guard(None, None), None);
    }

    #[test]
    fn output_limit_header_is_parsed() {
        let mut headers = HeaderMap::new();
        headers.insert(HEADER_OUTPUT_LIMIT, "8192".parse().unwrap());
        assert_eq!(output_limit_from_headers(&headers), Some(8192));

        let mut invalid = HeaderMap::new();
        invalid.insert(HEADER_OUTPUT_LIMIT, "abc".parse().unwrap());
        assert_eq!(output_limit_from_headers(&invalid), None);

        let mut zero = HeaderMap::new();
        zero.insert(HEADER_OUTPUT_LIMIT, "0".parse().unwrap());
        assert_eq!(output_limit_from_headers(&zero), None);
        assert_eq!(output_limit_from_headers(&HeaderMap::new()), None);
    }

    #[tokio::test]
    async fn scope_tool_call_exposes_output_limit() {
        let effective = resolve(Some((90, Some(ValueOrigin::Config))), None);
        let seen = scope_tool_call(effective, Correlation::default(), Some(8192), async {
            (current(), current_correlation(), current_output_limit())
        })
        .await;
        assert_eq!(seen.0, Some(effective));
        assert_eq!(seen.2, Some(8192));
        assert_eq!(
            current_output_limit(),
            None,
            "scope must end with the future"
        );
    }
}
