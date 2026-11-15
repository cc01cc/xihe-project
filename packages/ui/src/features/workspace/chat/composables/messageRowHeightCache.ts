/**
 * task-179 —— 行高占位缓存（挂在**行身份**上，不挂在元素上）。
 *
 * 病根（`task-170` E2 已定）：`MessageScrollerItem.vue` 用
 * `[contain-intrinsic-size:auto_10rem]`（占位 160 px）+ `[content-visibility:auto]`，
 * 而真实行高是 78 / 83 / 143 / 148 / **662** px ⇒ 行重测量时浏览器滚动锚定补偿 `scrollTop`，
 * 实测 `502 = 662 − 160`、`474 = 502 − 28`（28 = 折叠 banner 实高）。
 *
 * 为什么必须是「行身份」：`contain-intrinsic-size: auto <length>` 的「记住上次尺寸」是**逐元素**的，
 * 虚拟化卸载行 ⇒ 元素被替换 ⇒ 记忆丢失 ⇒ 每次重挂载都重演一次 160 → 真实 翻转
 * （实测抓到同一 `data-message-id` 单窗内翻转 2 次）。这里把测量结果按行 key（由 messageId 派生）
 * 存在**模块级单例**里，比列表实例活得久：重挂载时直接给出上次实测值，占位 ≈ 真实，
 * 尺寸变化本身消失 —— 而不是靠全局关 `overflow-anchor` 把补偿层整体关掉。
 *
 * 反应式：`MessageList` 模板里读 `rowHeightOf(row.key)` 给 `contain-intrinsic-size` 绑内联样式，
 * 读的值必须被追踪，否则行重挂载时占位不会更新。
 */
import { reactive } from "vue";

/** 占位下限：0/负值会让 `contain-intrinsic-size` 退化成 0（比 160 更糟，布局会塌）。 */
export const MIN_ROW_HEIGHT_PX = 1;
/** 占位上限：防御性钳制，避免异常测量（例如 1e9）把占位撑爆。 */
export const MAX_ROW_HEIGHT_PX = 20000;
/**
 * 条目上限：缓存是模块级单例（跨列表实例存活），长会话滚动会不断加新行，
 * 必须有界；超限按**插入顺序**淘汰最旧的（`Map` 保序，重写已存在的 key 前先 delete 以维持 LRU 语义）。
 */
export const MAX_ROW_HEIGHT_CACHE_ENTRIES = 5000;

const heights = reactive(new Map<string, number>());

/** 记下一次实测行高；非法值（NaN/Infinity/≤0）一律丢弃，保留旧值。 */
export function rememberRowHeight(key: string, height: number): void {
    if (!key || !Number.isFinite(height) || height < MIN_ROW_HEIGHT_PX) return;
    // 重写已存在的 key：先删后插，保持「最久未更新」在 Map 头部。
    heights.delete(key);
    heights.set(key, Math.min(Math.round(height), MAX_ROW_HEIGHT_PX));
    while (heights.size > MAX_ROW_HEIGHT_CACHE_ENTRIES) {
        const oldest = heights.keys().next().value;
        if (oldest === undefined) break;
        heights.delete(oldest);
    }
}

/** 读某行的占位高；没测过返回 undefined（调用方退回 CSS 类里的 160 px）。 */
export function rowHeightOf(key: string): number | undefined {
    return heights.get(key);
}

/** 行彻底消失（会话切换/消息删除）时清掉，避免缓存无界增长。 */
export function forgetRowHeight(key: string): void {
    heights.delete(key);
}

/** 会话级重置（切换会话/登出）。 */
export function clearRowHeights(): void {
    heights.clear();
}

/** 测试/调试用：缓存条目数。 */
export function rowHeightCacheSize(): number {
    return heights.size;
}
