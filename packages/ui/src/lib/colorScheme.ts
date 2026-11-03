/**
 * PLAN-0631 色彩方案开关。**默认色彩 = C2′（蓝仅小面积，用户 2026-11-03 圈选）**，
 * token 已落在 `styles/main.css` 的 `:root`，没有 `data-xh-color` 属性时渲染的就是 C2′。
 *
 * 这个开关现在只为**对比**保留 C1/C3 覆盖（`src/styles/themes/color-c{1,3}-*.css`），
 * 由 `<html>` 上的 `data-xh-color` 属性激活；**仅对比用，非发布候选**。
 * C2 已升格为默认（C2′），`?color=c2` 与未知值一律解析为默认（不设属性）。
 *
 * 与 `visualVariant.ts`（A/C 视觉语言覆盖）是**两条正交的轴**：
 * - 视觉语言管密度/圆角/字号（B 是默认，A/C 是 opt-in 覆盖）；
 * - 色彩方案只管颜色 token（密度/圆角/字号一律沿用当前视觉语言）。
 * 两者可以同时生效（`?variant=a&color=c1`），互不读取对方的状态。
 *
 * 生效方式：只有 URL `?color=c1|c3` 一次性投影到 `<html data-xh-color>`；
 * **不再持久化**（见下方迁移说明）。
 *
 * 迁移（旧持久化键）：候选对比阶段曾把 `?color=` 写进 localStorage
 * `xihe-color-scheme`。默认语义从"现状"变成"C2′"后，残留的旧值会让界面停留在
 * 已废弃的外观上，因此启动时**一律清除该键**（`clearLegacyStoredColorScheme`）——
 * 不清就无法保证"无参数 = C2′"。清除而不是映射：C1/C3 仍可从 URL 显式进入，
 * 映射会伪造一次用户选择。（做法与 `visualVariant.ts` 的 `xihe-visual-variant` 相同。）
 *
 * 边界：
 * - C1/C3 只覆盖浅色（两份变量集都用 `:not(.dark)` 限定）；深色主题 = C2′ 的深色
 *   回落（main.css `.dark` 段），不受 `?color=` 影响。
 * - 这里**只写 `<html>` 属性**，不碰颜色/字号本身，也不碰 `useTheme` 的 `xihe-theme`
 *   （dark/light/system 仍是唯一明暗入口）。
 */

export const COLOR_SCHEME_STORAGE_KEY = "xihe-color-scheme";
export const COLOR_SCHEME_ATTRIBUTE = "data-xh-color";

/** opt-in 覆盖集合（C1/C3）。C2′ 是默认，不需要属性，因此不在这个集合里。 */
export const COLOR_SCHEMES = ["c1", "c3"] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];

const CLEAR_VALUES = new Set(["default", "off", "none"]);

function isColorScheme(value: string | null | undefined): value is ColorScheme {
    return value === "c1" || value === "c3";
}

/**
 * 解析最终生效的 opt-in 覆盖。`search` 传 `location.search`。
 * 纯函数：不读全局、不写存储；`c2`（已是默认）/`default`/`off`/`none`/未知值一律
 * 返回 `null`（= 默认 C2′），这样旧链接不会因参数拼写落到某个已废弃的方案上。
 */
export function resolveColorScheme(search: string): ColorScheme | null {
    const fromQuery = new URLSearchParams(search).get("color")?.trim().toLowerCase() ?? "";
    if (CLEAR_VALUES.has(fromQuery)) return null;
    return isColorScheme(fromQuery) ? fromQuery : null;
}

/** 把色彩方案投影到 `<html data-xh-color>`；传 `null` 即回到默认 C2′。 */
export function applyColorScheme(scheme: ColorScheme | null): void {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (scheme) root.setAttribute(COLOR_SCHEME_ATTRIBUTE, scheme);
    else root.removeAttribute(COLOR_SCHEME_ATTRIBUTE);
}

/**
 * 旧持久化键的一次性迁移：只删不读、也不再写。
 * 旧值（`c1`/`c2`/`c3`/…）在默认语义变化后都可能让界面停留在废弃外观上，
 * 因此不区分取值一律清除；C1/C3 仍可用 `?color=` 显式进入。
 */
function clearLegacyStoredColorScheme(): void {
    try {
        if (typeof localStorage === "undefined") return;
        localStorage.removeItem(COLOR_SCHEME_STORAGE_KEY);
    } catch {
        // Storage 访问可能抛（隐私模式/配额/策略）；迁移失败不影响本次渲染。
    }
}

/**
 * 启动钩子：`main.ts` 在挂载前调用，保证首屏就是最终色彩（无闪烁）。
 * 返回实际生效的覆盖（`null` = 默认 C2′），便于诊断日志/测试断言。
 */
export function initColorScheme(): ColorScheme | null {
    const search = typeof location === "undefined" ? "" : location.search;
    const scheme = resolveColorScheme(search);
    applyColorScheme(scheme);
    clearLegacyStoredColorScheme();
    return scheme;
}
