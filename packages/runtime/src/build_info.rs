//! 构建身份读面（BL-324 runtime 半边 / task-238，2026-11-13）。
//!
//! 值的来源按优先级三层，**顺序不能反**：
//! 1. **构建期埋入** `XH_RUNTIME_BUILD_COMMIT`（`build.rs` 写 `cargo:rustc-env`）——
//!    干净树 `<sha12>`、脏树 `<sha12>-dirty`。这是默认值，与谁启动无关。
//! 2. **部署期显式覆盖** `XIHE_BUILD_COMMIT`（PLAN-0534 的 env-first 通道，保留为兼容位）——
//!    只在 1 缺失时生效，所以「埋了 sha」不会被一个忘设置的 env 悄悄抹掉。
//! 3. 两层都没有 ⇒ `unknown`。
//!
//! **为什么是 `unknown` 而不是空串**：空串会被下游读成「字段存在但为空」，与「读不到」在
//! 判据上无法区分（`D-1074` 同源：能区分「跳过」与「通过」才配当判据）；`unknown` 是显式值，
//! 既不会被误当 sha，也能让「埋点没生效」在读数里立刻可见。
//!
//! 读面：`GET /ready` 的 `commit` 字段（CP `HealthMonitor` 已在读它，经 `/api/v1/version` 的
//! `modules.runtime.commit` 透出 —— 字段与形状不变，只是值从 `null` 变成真 sha）；
//! 以及 `xihe-runtime --print-build-commit`（不连栈、不读 env，直接读产物里埋的值）。
use std::env;

/// 构建期埋入的值。缺失（如被 `cargo` 之外的构建链编译）时为 `None`。
pub const COMPILED_COMMIT: Option<&str> = option_env!("XH_RUNTIME_BUILD_COMMIT");

/// 读不到任何来源时的显式值（**不是空串**）。
pub const UNKNOWN: &str = "unknown";

/// 部署期覆盖位（PLAN-0534），仅当构建期值缺失时生效。
pub const OVERRIDE_ENV: &str = "XIHE_BUILD_COMMIT";

/// 规范形：`unknown`，或 `<7..=40 位十六进制>[-dirty]`。其余一律 `None`（不猜、不截断、不补零）。
fn normalize(raw: &str) -> Option<String> {
    let value = raw.trim();
    if value.eq_ignore_ascii_case(UNKNOWN) {
        return Some(UNKNOWN.to_string());
    }
    let (sha, dirty) = match value.strip_suffix("-dirty") {
        Some(sha) => (sha, true),
        None => (value, false),
    };
    if !(7..=40).contains(&sha.len()) || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    if dirty {
        Some(format!("{}-dirty", sha.to_ascii_lowercase()))
    } else {
        Some(sha.to_ascii_lowercase())
    }
}

/// 当前进程所属产物的构建身份。**永远返回可读值**：要么是规范 sha（可带 `-dirty`），要么是 `unknown`。
pub fn build_commit() -> String {
    if let Some(compiled) = COMPILED_COMMIT.and_then(normalize) {
        return compiled;
    }
    if let Ok(overridden) = env::var(OVERRIDE_ENV)
        && let Some(value) = normalize(&overridden)
    {
        return value;
    }
    UNKNOWN.to_string()
}

/// `commit=<值> version=<CARGO_PKG_VERSION>` —— 给日志/诊断用的一行文本。
pub fn describe() -> String {
    format!(
        "commit={} version={}",
        build_commit(),
        env!("CARGO_PKG_VERSION")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_clean_short_sha() {
        assert_eq!(Some("b0c68ddf".to_string()), normalize("b0c68ddf"));
    }

    #[test]
    fn accepts_dirty_suffix_and_keeps_it() {
        assert_eq!(
            Some("b0c68ddf-dirty".to_string()),
            normalize("b0c68ddf-dirty")
        );
    }

    #[test]
    fn accepts_unknown_verbatim() {
        assert_eq!(Some("unknown".to_string()), normalize("unknown"));
        assert_eq!(Some("unknown".to_string()), normalize("  UNKNOWN  "));
    }

    #[test]
    fn rejects_empty_and_non_sha() {
        // 空串必须被拒 ⇒ 走 unknown，不允许「空值冒充值」。
        assert_eq!(None, normalize(""));
        assert_eq!(None, normalize("   "));
        assert_eq!(None, normalize("not-a-sha"));
        assert_eq!(None, normalize("b0c68d")); // 6 位：短于下限（git 最短 7）
        assert_eq!(None, normalize("b0c68ddf-notdirty")); // 只有 -dirty 这一个合法后缀
    }

    #[test]
    fn rejects_dirty_with_short_sha() {
        assert_eq!(None, normalize("abc-dirty"));
    }

    #[test]
    fn build_commit_is_never_empty() {
        let value = build_commit();
        assert!(
            !value.is_empty(),
            "构建身份读不到时必须回落成 unknown，不许空串"
        );
        assert_eq!(
            Some(&value),
            normalize(&value).as_ref(),
            "返回值必须已经是规范形"
        );
    }

    #[test]
    fn compiled_value_is_baked_by_build_script() {
        // 本仓是 git 检出 ⇒ build.rs 必然写入；这条断言是「埋点真的埋了」的第一道门。
        // 若在 tarball/docker 里构建（无 git），它会是 unknown —— 那也算通过（未知是合法值），
        // 但值不许是空串（由上一条覆盖）。
        assert!(
            COMPILED_COMMIT.is_some(),
            "build.rs 没有把 XH_RUNTIME_BUILD_COMMIT 写进产物（读不到 ≠ 允许缺省）"
        );
    }

    #[test]
    fn describe_carries_both_fields() {
        let line = describe();
        assert!(line.starts_with("commit="), "日志行格式固定：{line}");
        assert!(line.contains(" version="), "日志行格式固定：{line}");
    }
}
