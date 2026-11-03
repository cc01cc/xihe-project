/**
 * PLAN-0631 M2（D31-M2-视觉语言 = B 密集）：默认视觉语言已经是 B —— B 的 token 在
 * `src/styles/main.css` 的 `:root`，不在组件里，也不在这里。
 *
 * 这个开关只为**对比与回归**保留 A/C 覆盖：
 *   1. `?variant=a` → `<html data-xh-variant="a">`（A 克制）
 *   2. `?variant=c` → `<html data-xh-variant="c">`（C 现状+）
 *   3. 无参数 / `?variant=b` / `default` / `off` / `none` → 不设属性 = 默认 B
 * A/C **仅用于对比与回归，非发布默认**；只经 URL 一次性生效，不再持久化。
 *
 * 迁移（旧持久化键）：旧版把预览选择写进 localStorage `xihe-visual-variant`。
 * 默认语义从「现状」变成「B」后，残留的旧值会让界面继续落在已废弃的外观上，
 * 因此启动时**一律清除该键**（`clearLegacyStoredVariant`）——不清就无法保证
 * "无参数 = B"。清除而不是映射：A/C 仍可从 URL 显式进入，映射会伪造一次用户选择。
 *
 * 边界：A/C 只覆盖浅色（都用 `:not(.dark)` 限定），深色下开关无视觉效果；
 * 默认 B 的几何（密度/圆角/字号）对明暗同时生效，深色只换调色板（`.dark` 段）。
 * 这里**只写 `<html>` 属性**，不碰颜色/字号本身，也不碰 `useTheme` 的 `xihe-theme`
 * （dark/light/system 仍是唯一明暗入口）。
 */

export const VISUAL_VARIANT_STORAGE_KEY = "xihe-visual-variant";
export const VISUAL_VARIANT_ATTRIBUTE = "data-xh-variant";

/** opt-in 覆盖集合（A/C）。B 是默认，不需要属性，因此不在这个集合里。 */
export const VISUAL_VARIANTS = ["a", "c"] as const;
export type VisualVariant = (typeof VISUAL_VARIANTS)[number];

function isVisualVariant(value: string | null | undefined): value is VisualVariant {
    return value === "a" || value === "c";
}

/**
 * 解析最终生效的 opt-in 覆盖。`search` 传 `location.search`。
 * 纯函数：不读全局、不写存储；`b`/`default`/`off`/`none`/未知值一律返回 `null`
 * （= 默认 B），这样旧链接不会因参数拼写落到某个已废弃的方案上。
 */
export function resolveVisualVariant(search: string): VisualVariant | null {
    const fromQuery = new URLSearchParams(search).get("variant")?.trim().toLowerCase() ?? "";
    return isVisualVariant(fromQuery) ? fromQuery : null;
}

/** 把覆盖投影到 `<html data-xh-variant>`；传 `null` 即回到默认 B。 */
export function applyVisualVariant(variant: VisualVariant | null): void {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (variant) root.setAttribute(VISUAL_VARIANT_ATTRIBUTE, variant);
    else root.removeAttribute(VISUAL_VARIANT_ATTRIBUTE);
}

/**
 * 旧持久化键的一次性迁移：只删不读。
 * 旧值（`a`/`b`/`c`/…）在默认语义变化后都可能让界面停留在废弃外观上，
 * 因此不区分取值一律清除；A/C 仍可用 `?variant=` 显式进入。
 */
function clearLegacyStoredVariant(): void {
    try {
        if (typeof localStorage === "undefined") return;
        localStorage.removeItem(VISUAL_VARIANT_STORAGE_KEY);
    } catch {
        // Storage 访问可能抛（隐私模式/配额/策略）；迁移失败不影响本次渲染。
    }
}

/**
 * 启动钩子：`main.ts` 在挂载前调用，保证首屏就是最终语言（无闪烁）。
 * 返回实际生效的覆盖（`null` = 默认 B），便于诊断日志/测试断言。
 */
export function initVisualVariant(): VisualVariant | null {
    const search = typeof location === "undefined" ? "" : location.search;
    const variant = resolveVisualVariant(search);
    applyVisualVariant(variant);
    clearLegacyStoredVariant();
    return variant;
}
