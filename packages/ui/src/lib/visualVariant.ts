/**
 * PLAN-0631 M2：视觉语言候选开关（A / B / C）。
 *
 * 为什么需要它：M2 要拿三个"气质/密度"候选给用户圈选，但**默认主题不能变**。
 * 所以三个候选是三个独立变量集（`src/styles/themes/variant-*.css`），由 `<html>`
 * 上的 `data-xh-variant` 属性激活；属性不存在时三份文件都不匹配，界面与现状逐像素一致。
 *
 * 优先级（与 URL 参数同名的历史键不同，这里只此一处）：
 *   1. `?variant=a|b|c`（一次性预览；会写入 localStorage，便于刷新后仍能对比）
 *   2. localStorage `xihe-visual-variant`
 *   3. 都没有 → 不设属性 = 现状
 * `?variant=default`（或 `off`/`none`）显式清除属性与持久化键。
 *
 * 边界：
 * - 候选只覆盖浅色（三个变量集都用 `:not(.dark)` 限定），深色下开关无视觉效果；
 *   深色候选不在 M2 范围内。
 * - 这里**只写 `<html>` 属性**，不碰颜色/字号本身，也不碰 `useTheme` 的 `xihe-theme`
 *   （dark/light/system 仍是唯一明暗入口）。
 */

export const VISUAL_VARIANT_STORAGE_KEY = "xihe-visual-variant";
export const VISUAL_VARIANT_ATTRIBUTE = "data-xh-variant";

export const VISUAL_VARIANTS = ["a", "b", "c"] as const;
export type VisualVariant = (typeof VISUAL_VARIANTS)[number];

const CLEAR_VALUES = new Set(["default", "off", "none"]);

function isVisualVariant(value: string | null | undefined): value is VisualVariant {
    return value === "a" || value === "b" || value === "c";
}

/**
 * 解析最终生效的候选。`search` 传 `location.search`，`stored` 传已读出的键值。
 * 纯函数：不读全局、不写存储，便于单测与"非法值降级为现状"的显式行为。
 */
export function resolveVisualVariant(search: string, stored: string | null): VisualVariant | null {
    const fromQuery = new URLSearchParams(search).get("variant")?.trim().toLowerCase() ?? "";
    if (CLEAR_VALUES.has(fromQuery)) return null;
    if (isVisualVariant(fromQuery)) return fromQuery;
    const fromStorage = stored?.trim().toLowerCase() ?? "";
    return isVisualVariant(fromStorage) ? fromStorage : null;
}

/** 把候选投影到 `<html data-xh-variant>`；传 `null` 即回到现状。 */
export function applyVisualVariant(variant: VisualVariant | null): void {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (variant) root.setAttribute(VISUAL_VARIANT_ATTRIBUTE, variant);
    else root.removeAttribute(VISUAL_VARIANT_ATTRIBUTE);
}

function readStored(): string | null {
    try {
        return typeof localStorage === "undefined"
            ? null
            : localStorage.getItem(VISUAL_VARIANT_STORAGE_KEY);
    } catch {
        // Storage 访问可能抛（隐私模式/配额/策略）；开关属增强项，读不到就当现状。
        return null;
    }
}

function persist(variant: VisualVariant | null): void {
    try {
        if (typeof localStorage === "undefined") return;
        if (variant) localStorage.setItem(VISUAL_VARIANT_STORAGE_KEY, variant);
        else localStorage.removeItem(VISUAL_VARIANT_STORAGE_KEY);
    } catch {
        // 同上：持久化失败只影响刷新后是否记得，不影响本次渲染。
    }
}

/**
 * 启动钩子：`main.ts` 在挂载前调用，保证首屏就是用户选中的候选（无闪烁）。
 * 返回实际生效的候选，便于诊断日志/测试断言。
 */
export function initVisualVariant(): VisualVariant | null {
    const search = typeof location === "undefined" ? "" : location.search;
    const variant = resolveVisualVariant(search, readStored());
    applyVisualVariant(variant);
    const fromQuery = new URLSearchParams(search).get("variant");
    if (fromQuery !== null) persist(variant);
    return variant;
}
