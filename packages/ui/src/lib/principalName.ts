/**
 * 2026-11-04 用户裁定：agent 主体名与 username 的字符规范（前端预检，权威判定在 CP）。
 *
 * - 不得含空格；
 * - 允许英文字母、中文汉字、数字；
 * - 不得以数字开头。
 *
 * 单一实现，创建/重命名/注册都从这里取规则，避免三处正则各写一套后漂移。
 *
 * 与 CP `com.cc01cc.p.xihe.cp.auth.NameFormat.PATTERN_SOURCE` 必须逐字同源：改一侧必须同批改另一侧。
 * UI 与 CP 各自编译/打包、无法共享常量，双份实现只能靠这条约定与 code review 守住。
 */
export const PRINCIPAL_NAME_PATTERN = /^[A-Za-z\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff]*$/;

export type PrincipalNameError = "required" | "pattern";

/** `null` = 合法；调用方把错误码映射到自己的 i18n 文案与禁用逻辑。 */
export function principalNameError(value: string): PrincipalNameError | null {
    const trimmed = value.trim();
    if (!trimmed) return "required";
    return PRINCIPAL_NAME_PATTERN.test(trimmed) ? null : "pattern";
}

/** 允许的字符集，供输入框的 `title`/提示文案复用。 */
export const PRINCIPAL_NAME_ALLOWED = "英文字母 / 中文汉字 / 数字，且不能以数字开头";
