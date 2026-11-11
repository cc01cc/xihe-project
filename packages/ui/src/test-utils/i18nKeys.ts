import { expect } from "vitest";

import flatI18nKeys from "virtual:xihe-i18n-keys";
import { i18nFixtureBacklog } from "./i18nFixtureBacklog";

/**
 * task-93/task-105 · 兜底断言：**渲染结果里不许出现裸 i18n 键**。
 *
 * <p>为什么需要它：`i18n-scan` 是**静态**门，只看源码字面量；而 task-87 的事故是**测试夹具**只写了
 * 一半 `messages`，组件 `t(labelKey)` 取不到值 ⇒ vue-i18n 原样返回键名，页面上出现
 * `settings.ia.resourceSkills`，**测试照样绿**。静态门结构上看不见夹具（`*.spec.ts` 在扫描范围外），
 * 但测试跑起来时裸键就在 DOM 里 —— 这条断言就是那一刻的探针。</p>
 *
 * <p>判据刻意做成「**命中的必须是本仓真实存在的键**」：只有和 locale 里 2540 个键**逐字相同**的
 * 子串才算裸键，所以 `skills/commit-msg-review/SKILL.md`、`mcpServers`、`workspace.id` 这类正常内容
 * 不会误报。实现上是**扫 html 里的点号 token 再查集合**（不是拿 2540 个键逐个 regex 扫），
 * 所以开销随 html 长度线性增长，可以挂在每次 mount 上。</p>
 *
 * <p>接线点见 `src/test-utils/mount.ts`（`.spec.ts` 的 `@vue/test-utils` 被 vite 插件改指向它）。</p>
 */

let cachedKeys: Set<string> | null = null;

/** 本仓全部 locale 键（zh-CN ∪ en-US，构建期由 `virtual:xihe-i18n-keys` 注入）。 */
export function knownI18nKeys(): Set<string> {
    cachedKeys ??= new Set(flatI18nKeys);
    return cachedKeys;
}

/** 点号 token：`a.b.c`，前后不能紧邻标识符字符或点（`x.y` 里的 `y` 不算独立 token）。 */
const DOT_TOKEN = /(?<![\w.-])([a-z][\w]*(?:\.[\w-]+)+)(?![\w.-])/g;

/** 找出 html 里**逐字等于某个真实 locale 键**的 token（去重；空数组 = 干净）。 */
export function findRawI18nKeys(html: string): string[] {
    const keys = knownI18nKeys();
    const hits = new Set<string>();
    for (const match of html.matchAll(DOT_TOKEN)) {
        const token = match[1];
        if (keys.has(token)) hits.add(token);
    }
    return [...hits];
}

/**
 * 待办台账：这些 spec 渲染出了裸键（局部 messages 夹具缺键），暂按**警告**处理，其余 spec 一律严格。
 *
 * <p>为什么要有台账而不是"先全红再修"：2026-11-12 实测接线后**38 个 spec / 168 条用例**同时红
 * （真实现存问题，不是误报），一次性补完不现实；但若为此把断言关掉，新 spec 就又失去保护。
 * 台账 = **棘轮**：绿在当下、不许新增、只许缩小（补完夹具即删条目）。</p>
 */
const BACKLOG: Record<string, { keys: string[]; note: string }> = i18nFixtureBacklog;

/** 当前 spec 相对 `src/` 的路径（用于查台账）；取不到就返回 null（按严格处理）。 */
function currentSpecRelPath(): string | null {
    const state = expect.getState() as { testPath?: string };
    // 模块级 mount（夹具在 import 期构建）时 testPath 为空 ⇒ 从调用栈里捞 spec 路径。
    const fromStack = /[^\s():]+\.spec\.ts/.exec(new Error().stack ?? "")?.[0];
    const file = state.testPath ?? fromStack;
    if (!file) return null;
    const normalized = file
        .replace(/^file:\/\/\//, "")
        .split("\\")
        .join("/");
    const at = normalized.lastIndexOf("/src/");
    return at === -1 ? null : normalized.slice(at + 5);
}

/** 断言渲染结果里没有裸键；失败信息直接给出**该补哪个键**。 */
export function expectNoRawI18nKey(html: string): void {
    const raw = findRawI18nKeys(html);
    if (raw.length === 0) return;
    const message = `渲染结果里出现裸 i18n 键：${raw.join(", ")} —— 测试夹具的 messages 缺这些键（或组件用了不存在的键）`;
    const rel = currentSpecRelPath();
    if (rel && rel in BACKLOG) {
        // 台账内：只警告不失败（保持树绿），但每次都打印，避免"沉默的债"。
        console.warn(
            `[i18n] ${rel} 渲染出 ${raw.length} 个裸键（见 i18nFixtureBacklog.ts）：${raw.join(", ")}`,
        );
        return;
    }
    expect(raw, message).toEqual([]);
}
