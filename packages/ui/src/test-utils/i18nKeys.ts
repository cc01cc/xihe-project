import { expect } from "vitest";

import { i18n } from "../i18n";

/**
 * task-93 · 兜底断言：**渲染结果里不许出现裸 i18n 键**。
 *
 * <p>为什么需要它：`i18n-scan` 是**静态**门，它检查源码里的字面量；而 `task-87` 那次事故是
 * **测试夹具**只写了一半的 `messages`，组件 `t(labelKey)` 取不到值 ⇒ vue-i18n 原样返回键名，
 * 页面上出现 `settings.ia.resourceSkills`。静态门看不见夹具（`*.spec.ts` 在扫描范围外），
 * 但**测试跑起来时裸键就在 DOM 里** —— 这条断言就是那一刻的探针。</p>
 *
 * <p>判据刻意做成「**命中的必须是本仓真实存在的键**」：只有和 locale 里的 2540 个键**逐字相同**的
 * 子串才算裸键，所以 `skills/commit-msg-review/SKILL.md`、`mcpServers` 这类正常内容不会误报。</p>
 *
 * <p>用法（组件测试末尾一行）：</p>
 * <pre>
 * const wrapper = mount(Panel, { global: { plugins: [partialI18n] } });
 * expectNoRawI18nKey(wrapper.html());
 * </pre>
 * <p>**它测什么/不测什么**：能测「夹具缺键 ⇒ 界面出裸键」；测不出「键写对了但译文错」，
 * 也测不出根本没被渲染到的分支。</p>
 */

function flatten(node: unknown, prefix = "", out: string[] = []): string[] {
    if (typeof node === "string") {
        out.push(prefix);
        return out;
    }
    if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
            flatten(value, prefix ? `${prefix}.${key}` : key, out);
        }
    }
    return out;
}

let cachedKeys: string[] | null = null;

/** 本仓全部 locale 键（zh-CN ∪ en-US），按长度降序 —— 便于先匹配长键，避免被短键截断。 */
export function knownI18nKeys(): string[] {
    if (cachedKeys) return cachedKeys;
    const zh = flatten(i18n.global.getLocaleMessage("zh-CN"));
    const en = flatten(i18n.global.getLocaleMessage("en-US"));
    cachedKeys = [...new Set([...zh, ...en])].sort((a, b) => b.length - a.length);
    return cachedKeys;
}

/**
 * 找出 html 里**逐字出现**的 i18n 键。返回去重后的键名（空数组 = 干净）。
 *
 * 用「键 + 前后不是标识符字符」判边界：`settings.skills.title` 命中，但
 * `settings.skills.titleExtra` 不会（那是另一个键，出现它本身就说明有问题，会被另一个键命中）。
 */
export function findRawI18nKeys(html: string): string[] {
    const hits = new Set<string>();
    for (const key of knownI18nKeys()) {
        const pattern = new RegExp(
            `(^|[^\\w.-])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])`,
        );
        if (pattern.test(html)) hits.add(key);
    }
    return [...hits];
}

/**
 * 断言渲染结果里没有裸键。失败信息直接给出**该补哪个键**，不必再回源码找。
 */
export function expectNoRawI18nKey(html: string): void {
    const raw = findRawI18nKeys(html);
    expect(
        raw,
        raw.length
            ? `渲染结果里出现裸 i18n 键：${raw.join(", ")} —— 测试夹具的 messages 缺这些键（或组件用了不存在的键）`
            : "",
    ).toEqual([]);
}
