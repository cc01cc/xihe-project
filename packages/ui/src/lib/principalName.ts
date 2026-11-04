/**
 * 2026-11-04 用户裁定（v23 + v29）：**agent 主体名 / username / 昵称**（= 现状 displayName）
 * 共用一条字符规范 —— 前端预检，权威判定在 CP。
 *
 * - 不得含空格；
 * - 允许英文字母（含大写）、中文汉字、数字；
 * - 不得以数字开头。
 *
 * 单一实现，创建/重命名/注册/成员邀请都从这里取规则，避免各处再写一套正则。
 *
 * 与 CP `com.cc01cc.p.xihe.cp.auth.NameFormat.PATTERN_SOURCE` 必须逐字同源：改一侧必须同批改另一侧。
 * UI 与 CP 各自编译/打包、无法共享常量，双份实现只能靠这条约定与 code review 守住
 * （`src/lib/__tests__/principalName.spec.ts` 有逐字比对断言）。
 */
export const PRINCIPAL_NAME_PATTERN = /^[A-Za-z\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff]*$/;

/** username 面的长度上限 = CP 列宽 `users.username VARCHAR(32)`（V82）；主体名面是 64。 */
export const USERNAME_MAX_LENGTH = 32;

export type PrincipalNameError = "required" | "whitespace" | "pattern";

/** username 面比主体名多的只有长度这一条。 */
export type UsernameError = PrincipalNameError | "length";

/** `null` = 合法；调用方把错误码映射到自己的 i18n 文案与禁用逻辑。 */
export function principalNameError(value: string): PrincipalNameError | null {
    // CP 是权威判定且**不 trim**（前后有空格即非法）。这里同样不 trim：
    // 静默 trim 会让 " abc " 在 UI 通过、到 CP 才 400。
    if (!value.trim()) return "required";
    if (value !== value.trim()) return "whitespace";
    return PRINCIPAL_NAME_PATTERN.test(value) ? null : "pattern";
}

/**
 * username 面（注册 / 管理员建号 / 工作区成员邀请）：同一规则 + 32 上限。
 * 长度上限只在 UI 这一处知识里，不再让各调用点自己写 `value.length > 32`。
 */
export function usernameError(value: string): UsernameError | null {
    const base = principalNameError(value);
    if (base) return base;
    return value.length > USERNAME_MAX_LENGTH ? "length" : null;
}

/** 允许的字符集，供输入框的 `title`/提示文案复用。 */
export const PRINCIPAL_NAME_ALLOWED = "英文字母 / 中文汉字 / 数字，且不能以数字开头";
