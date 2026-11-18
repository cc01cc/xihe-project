/**
 * 文案泄露判据的**唯一来源**（DEV-011 §14 / D-1879 裁定二 / D-1880 五必填）。
 *
 * <p>为什么要有这个文件：9 形态原先在三个地方各写一份（单测 `KnowledgeResourceView.spec.ts`、
 * 门脚本 `scripts/check-copy-leak.mjs`、以及本卡要加的 mock 车道用例）。三份副本会各自漂移 ——
 * 仓库里已经为此写过话：「旧 URL 的去向统一由一个文件钉住，避免同一条契约在两个文件里各写一份
 * （两份会各自漂移，正是今晚反复踩的坑）」（`e2e/mock/resource-detail.spec.ts:244`）。
 * 所以判据本体收在这里，消费方只 import。</p>
 *
 * <p>Node 侧（门脚本）不能 import TS，仍保留一份**字面量**；两侧一致性由
 * `src/lib/__tests__/copyLeakPatterns.spec.ts` 逐条比对正则源码 —— **有守卫的重复**，
 * 不是无声的重复。</p>
 *
 * <p>为什么是形态而不是枚举字符串：枚举追不上新形态（DEV-011 §14「为什么用形态」）。</p>
 */

export type LeakPattern = { readonly name: string; readonly re: RegExp };

/** 命中结果：形态名 + 次数 + 去重样本（样本用于让红点点名，不靠人再查一遍）。 */
export type LeakHit = { readonly name: string; readonly count: number; readonly samples: string[] };

export const LEAK_PATTERNS: readonly LeakPattern[] = [
    { name: "类名", re: /[A-Z][A-Za-z]*(Controller|Service|Repository|Middleware)\b/ },
    { name: "命令", re: /\bgrep\b/ },
    { name: "契约文件名", re: /\b(openapi|swagger)\.ya?ml\b/ },
    { name: "源码 文件:行号", re: /\b[\w./-]+\.(ts|vue|java|yaml|yml|mjs|js|json):\d+/ },
    { name: "接口路径", re: /\/api\/v1\// },
    { name: "权限原子/枚举常量", re: /\b[A-Z][A-Z0-9]+(_[A-Z0-9]+)+\b/ },
    { name: "内部票号", re: /\b[A-Z]-\d+\b/ },
    { name: "内部术语 读面", re: /读面|\bread-face\b|\bread face\b/i },
    { name: "内部术语 契约", re: /契约|\bcontracts?\b/i },
] as const;

/**
 * 在**已渲染文本**上跑 9 形态。调用方负责只喂 `innerText`（不是 `textContent`）——
 * `textContent` 会把 `sr-only` 与 `display:none` 子树一起吞进来造成假阳（DEV-011 §14.1「在哪量」）。
 */
export function findLeaks(text: string, limit = 5): LeakHit[] {
    const hits: LeakHit[] = [];
    for (const { name, re } of LEAK_PATTERNS) {
        // 旗标要跟着走：只加 "g" 会把 i 丢掉，英文形态（read face / contract）就漏了 ——
        // 这正是 task-57 抓到的「en 全 0 是判据不全造成的假绿」的一半成因。
        const matched = text.match(
            new RegExp(re.source, "g" + (re.flags.includes("i") ? "i" : "")),
        );
        if (matched) {
            hits.push({
                name,
                count: matched.length,
                samples: [...new Set(matched)].slice(0, limit),
            });
        }
    }
    return hits;
}

/** 供断言用的一行摘要：`[形态] x次数 -> 样本`，多条以 ` ; ` 连接；无命中返回空串。 */
export function summarizeLeaks(hits: readonly LeakHit[]): string {
    return hits
        .map((h) => "[" + h.name + "] x" + h.count + " -> " + h.samples.join(" | "))
        .join(" ; ");
}
