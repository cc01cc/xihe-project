import { describe, expect, it } from "vitest";
import { domainsForLayer, instanceOpsGroups, resourceGroups } from "@/lib/settingsIa";
import {
    NAV_COUNTS,
    NAV_RECONCILIATION,
    domains,
    missingNavMeta,
    opsItems,
    resourceItems,
    securityItems,
    userItems,
} from "../data";

/**
 * task-121 ①：稿子的域清单**从产品 SSOT 生成**（2026-11-11 用户亲审稿：「用户层的域怎么就这么几个？」
 * ——稿上手写 4 条，真值 9 域 + 3 资源 = 12）。
 *
 * <p>本文件把两类断言**分开写**，因为它们的性质不同（D-884：守卫本身也要能被自己的第一版打红）：</p>
 * <ul>
 *   <li>**防漂移**（真判据）：硬编码期望值 / 硬编码 id 清单。矩阵或资源组一变就红，
 *       红的人必须来说明「是产品变了还是稿变了」。</li>
 *   <li>**生成完整性**（弱判据）：`X == 由 X 生成的那些函数的输出`。这条**恒真于生成式**，
 *       只守「map/filter 没吞掉条目」，不守「稿与产品一致」——后者由「生成」这件事本身保证。</li>
 * </ul>
 *
 * <p><b>PLAN-0772 M2（2026-11-12）三个数变了</b>：资源面搬出 `/settings` 成了第三个顶层入口 ⇒
 * 实例层 22 → **17**（12 域 + 2 运维 + 3 安全）、用户层 12 → **9**（只剩 9 域），另立
 * 资源模块 **5**（5 资源 × 层 tab）。<b>两条断言形态都保留</b>：`toEqual` 仍写死数字、
 * `toHaveLength(5)` 仍写死字面量 5 —— 不许换成「由生成函数自己算」的恒真式（那样就没人会发现
 * 有条目被搬走）。</p>
 */
describe("preview mock 设置导航 · 防漂移（硬编码期望）", () => {
    // task-485（2026-11-14）：`agent-profile` 迁出设置区 ⇒ 实例层 12 → **11 域**（17 → 16）、
    // 用户层 9 → **8 域**。资源段仍是 5（搬家只动资源面，与域矩阵无关）。
    it("设置区两个层：实例层 16 = 11 域 + 2 运维 + 3 安全；用户层 8 = 8 域；资源 5", () => {
        expect(NAV_COUNTS).toEqual({ instance: 16, user: 8, resources: 5 });
        expect(domains).toHaveLength(11);
        expect(opsItems).toHaveLength(2);
        expect(securityItems).toHaveLength(3);
        // 硬编码 5：资源搬走后设置区一条都不该剩；资源模块恰好 5 条。
        expect(resourceItems).toHaveLength(5);
    });

    it("用户层只剩 8 个配置域（资源 3 条已搬走；task-485 再撤 agent-profile）", () => {
        expect(userItems).toHaveLength(8);
        expect(userItems.map((item) => item.id)).toEqual([
            "llm-provider",
            "context-policy",
            "embedding",
            "rag",
            "agent-runtime",
            "user-preference",
            "agent-templates",
            "api-request-templates",
        ]);
    });

    it("每个条目都有图标与标签（缺了稿页要显示「N 条无图标」）", () => {
        // 这条**已经红过两次**：实例层资源 id（agents/mcp/credentials/skills/knowledge）与用户层那 3 条
        // 不同名，第一次跑就被它顶出来，随后才补的 ICONS/LABELS。
        expect(missingNavMeta).toEqual([]);
    });

    it("对账表逐段可加：实例段之和 16 / 用户段之和 8 / 资源段 5", () => {
        const sum = (needle: string) =>
            NAV_RECONCILIATION.filter((row) => row.segment.includes(needle)).reduce(
                (total, row) => total + row.count,
                0,
            );
        expect(sum("实例层")).toBe(16);
        expect(sum("用户层")).toBe(8);
        expect(sum("资源模块")).toBe(5);
    });
});

describe("preview mock 设置导航 · 生成完整性（只防 map 丢条目）", () => {
    /**
     * 恒真于生成式：`domains` 就是 `domainsForLayer("instance").map(...)`。
     * 它守的是「map/filter 没吞掉条目 / 没有去重丢项」，**不**证明稿与产品一致。
     * 留着的理由：将来若有人在 map 里加 `.filter(...)`（例如按权限过滤），这条会红 —— 那正是该被告知的时刻。
     */
    it("生成过程不丢条目（恒真式，见上方说明）", () => {
        expect(domains.map((item) => item.id)).toEqual([...domainsForLayer("instance")]);
        expect(opsItems.map((item) => item.id)).toEqual(
            instanceOpsGroups()
                .find((group) => group.id === "ops")
                ?.items.map((item) => item.id),
        );
        expect(securityItems.map((item) => item.id)).toEqual(
            instanceOpsGroups()
                .find((group) => group.id === "security")
                ?.items.map((item) => item.id),
        );
        expect(resourceItems.map((item) => item.id)).toEqual(
            resourceGroups().map((resource) => resource.id),
        );
        expect(userItems.map((item) => item.id)).toEqual([...domainsForLayer("user")]);
    });
});
