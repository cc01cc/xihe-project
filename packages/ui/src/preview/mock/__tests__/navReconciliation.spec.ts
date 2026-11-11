import { describe, expect, it } from "vitest";
import {
    domainsForLayer,
    instanceOpsGroups,
    instanceResourceGroup,
    userResourceGroup,
} from "@/lib/settingsIa";
import {
    NAV_COUNTS,
    NAV_RECONCILIATION,
    domains,
    instanceResourceItems,
    missingNavMeta,
    opsItems,
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
 */
describe("preview mock 设置导航 · 防漂移（硬编码期望）", () => {
    it("实例层 21 = 12 域 + 2 运维 + 3 安全 + 4 资源", () => {
        expect(NAV_COUNTS).toEqual({ instance: 21, user: 12 });
        expect(domains).toHaveLength(12);
        expect(opsItems).toHaveLength(2);
        expect(securityItems).toHaveLength(3);
        expect(instanceResourceItems).toHaveLength(4);
    });

    it("用户层 12 条 = 9 域 + 3 资源（不是稿上原来的 4）", () => {
        expect(userItems).toHaveLength(12);
        expect(userItems.map((item) => item.id)).toEqual([
            "llm-provider",
            "context-policy",
            "embedding",
            "rag",
            "agent-runtime",
            "agent-profile",
            "user-preference",
            "agent-templates",
            "api-request-templates",
            "agent-principals",
            "my-credentials",
            "knowledge-mcp",
        ]);
    });

    it("每个条目都有图标与标签（缺了稿页要显示「N 条无图标」）", () => {
        // 这条**已经红过一次**：实例层资源 4 条的 id（agents/mcp/credentials/knowledge）与用户层那 3 条
        // 不同名，第一次跑就被它顶出来，随后才补的 ICONS/LABELS。
        expect(missingNavMeta).toEqual([]);
    });

    it("对账表逐段可加：实例段之和 21 / 用户段之和 12", () => {
        const sum = (needle: string) =>
            NAV_RECONCILIATION.filter((row) => row.segment.includes(needle)).reduce(
                (total, row) => total + row.count,
                0,
            );
        expect(sum("实例层")).toBe(21);
        expect(sum("用户层")).toBe(12);
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
        expect(instanceResourceItems).toHaveLength(instanceResourceGroup().length);
        expect(userItems.map((item) => item.id)).toEqual([
            ...domainsForLayer("user"),
            ...userResourceGroup().map((resource) => resource.id),
        ]);
    });
});
