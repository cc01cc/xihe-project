/**
 * PLAN-0631 色彩方案开关（C1 中性优先 / C2 蓝仅小面积 / C3 降饱和）。
 *
 * 为什么需要它：用户 2026-11-03 的反馈是"色彩不够克制 —— 大块按钮真的有必须是有色即蓝色吗"，
 * 但**默认主题不能因为做候选就变**。所以三套色彩是三个独立变量集
 * （`src/styles/themes/color-c{1,2,3}-*.css`），由 `<html>` 上的 `data-xh-color`
 * 属性激活；属性不存在时三份文件都不匹配，界面与现状逐像素一致。
 *
 * 与 `visualVariant.ts`（A/C 视觉语言覆盖）是**两条正交的轴**：
 * - 视觉语言管密度/圆角/字号（B 是默认，A/C 是 opt-in 覆盖）；
 * - 色彩方案只管颜色 token（密度/圆角/字号一律沿用当前视觉语言）。
 * 两者可以同时生效（`?variant=a&color=c2`），互不读取对方的状态。
 *
 * 优先级：
 *   1. `?color=c1|c2|c3`（一次性预览；写入 localStorage，便于刷新后继续对比）
 *   2. localStorage `xihe-color-scheme`
 *   3. 都没有 → 不设属性 = 默认主题
 * `?color=default`（或 `off`/`none`）显式清除属性与持久化键。
 *
 * 边界：
 * - 候选只覆盖浅色（三份变量集都用 `:not(.dark)` 限定）；深色主题不受影响，
 *   深色候选不在本次范围内。
 * - 这里**只写 `<html>` 属性**，不碰颜色/字号本身，也不碰 `useTheme` 的 `xihe-theme`
 *   （dark/light/system 仍是唯一明暗入口）。
 */

export const COLOR_SCHEME_STORAGE_KEY = "xihe-color-scheme";
export const COLOR_SCHEME_ATTRIBUTE = "data-xh-color";

export const COLOR_SCHEMES = ["c1", "c2", "c3"] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];

const CLEAR_VALUES = new Set(["default", "off", "none"]);

function isColorScheme(value: string | null | undefined): value is ColorScheme {
    return value === "c1" || value === "c2" || value === "c3";
}

/**
 * 解析最终生效的色彩方案。`search` 传 `location.search`，`stored` 传已读出的键值。
 * 纯函数：不读全局、不写存储，便于单测与"非法值降级为默认主题"的显式行为。
 */
export function resolveColorScheme(search: string, stored: string | null): ColorScheme | null {
    const fromQuery = new URLSearchParams(search).get("color")?.trim().toLowerCase() ?? "";
    if (CLEAR_VALUES.has(fromQuery)) return null;
    if (isColorScheme(fromQuery)) return fromQuery;
    const fromStorage = stored?.trim().toLowerCase() ?? "";
    return isColorScheme(fromStorage) ? fromStorage : null;
}

/** 把色彩方案投影到 `<html data-xh-color>`；传 `null` 即回到默认主题。 */
export function applyColorScheme(scheme: ColorScheme | null): void {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (scheme) root.setAttribute(COLOR_SCHEME_ATTRIBUTE, scheme);
    else root.removeAttribute(COLOR_SCHEME_ATTRIBUTE);
}

function readStored(): string | null {
    try {
        return typeof localStorage === "undefined"
            ? null
            : localStorage.getItem(COLOR_SCHEME_STORAGE_KEY);
    } catch {
        // Storage 访问可能抛（隐私模式/配额/策略）；开关属增强项，读不到就当默认主题。
        return null;
    }
}

function persist(scheme: ColorScheme | null): void {
    try {
        if (typeof localStorage === "undefined") return;
        if (scheme) localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, scheme);
        else localStorage.removeItem(COLOR_SCHEME_STORAGE_KEY);
    } catch {
        // 同上：持久化失败只影响刷新后是否记得，不影响本次渲染。
    }
}

/**
 * 启动钩子：`main.ts` 在挂载前调用，保证首屏就是选中的色彩方案（无闪烁）。
 * 返回实际生效的方案，便于诊断日志/测试断言。
 */
export function initColorScheme(): ColorScheme | null {
    const search = typeof location === "undefined" ? "" : location.search;
    const scheme = resolveColorScheme(search, readStored());
    applyColorScheme(scheme);
    const fromQuery = new URLSearchParams(search).get("color");
    if (fromQuery !== null) persist(scheme);
    return scheme;
}
