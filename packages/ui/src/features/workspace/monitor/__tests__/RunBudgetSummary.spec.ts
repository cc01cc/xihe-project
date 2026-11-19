import { describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { i18n } from "../../../../i18n";
import type { api } from "../../../../composables/api";
import RunBudgetSummary from "../RunBudgetSummary.vue";

/**
 * task-112：回合用量/预算块。
 *
 * <p>这个块的**全部价值**在分辨力，所以断言也按分辨力写，而不是「渲染出了数字」：</p>
 * <ul>
 *   <li>`budgetConsumed = null` 与 `0` 在屏上必须不同（虚线「未记录」徽标 vs 等宽 0 + 「真实 0」徽标）；</li>
 *   <li>`tokenCount` 与 `budgetConsumed` 是两个口径，取相等值的 fixture 会让这条判据失效；</li>
 *   <li>生效上限必须是 `min(runMaxTokens, ceiling>0?ceiling:∞)`，并写出**谁在钳制**。`0` 是真实值（该维度停用），
 *       不是「未知」，所以 `0` 要显示「不限制」而不是被当成缺省。</li>
 * </ul>
 *
 * <p>读数一律走 `fetcher` seam，不打网络；生产恒用 `api.getChatRunStatus`。</p>
 */
type ChatRunStatus = Awaited<ReturnType<typeof api.getChatRunStatus>>;
type Fetcher = typeof api.getChatRunStatus;

const RUN_ID = "33333333-3333-4333-8333-333333333333";
const NEXT_RUN_ID = "66666666-6666-4666-8666-666666666666";

let wrapper: VueWrapper | null = null;

function runStatus(overrides: Partial<ChatRunStatus> = {}): ChatRunStatus {
    return {
        runId: RUN_ID,
        sessionId: "11111111-1111-4111-8111-111111111111",
        origin: "user_submission",
        status: "succeeded",
        terminalOutcome: "succeeded",
        errorCode: null,
        leaseExpired: false,
        pendingApprovals: [],
        // 真机读数形状（stack-5 run cd378844…）：两个数本来就不同口径，取等会让分辨判据失效。
        tokenCount: 13166,
        budgetConsumed: 1262,
        runMaxTokens: 500000,
        runMaxTokensCeiling: 1000000,
        budgetAccounting: "growth",
        ...overrides,
    };
}

function mountSummary(fetcher: Fetcher, runId: string | null = RUN_ID): VueWrapper {
    wrapper = mount(RunBudgetSummary, {
        props: { runId, fetcher },
        global: { plugins: [i18n] },
    });
    return wrapper;
}

function text(w: VueWrapper, testId: string): string {
    return w.get(`[data-testid="${testId}"]`).text();
}

describe("RunBudgetSummary", () => {
    it("同屏给出两个口径的数字，并标出记账口径", async () => {
        const fetcher = vi.fn<Fetcher>().mockResolvedValue(runStatus());
        const w = mountSummary(fetcher);
        await flushPromises();

        expect(fetcher).toHaveBeenCalledWith(RUN_ID);
        expect(text(w, "monitor-budget-token-value")).toBe("13166");
        expect(text(w, "monitor-budget-consumed-value")).toBe("1262");
        expect(text(w, "monitor-run-budget-accounting")).toContain(
            i18n.global.t("monitor.budget.accounting.growth"),
        );
        // 两个口径的标签必须是两条不同的文案，否则「同屏两数」在语义上仍是一个数。
        expect(i18n.global.t("monitor.budget.tokenCount")).not.toBe(
            i18n.global.t("monitor.budget.consumed"),
        );
    });

    it("budgetConsumed 为 null ⇒ 「未记录」，且绝不当成 0", async () => {
        const fetcher = vi
            .fn<Fetcher>()
            .mockResolvedValue(runStatus({ budgetConsumed: null, budgetAccounting: null }));
        const w = mountSummary(fetcher);
        await flushPromises();

        expect(
            w.get('[data-testid="monitor-budget-consumed"]').attributes("data-budget-recorded"),
        ).toBe("false");
        expect(w.find('[data-testid="monitor-budget-consumed-unrecorded"]').exists()).toBe(true);
        expect(text(w, "monitor-budget-consumed-value")).toBe(
            i18n.global.t("monitor.budget.unrecorded"),
        );
        // 没有记账值时口径不可知 ⇒ 不许在这里凭空写一个默认口径。
        expect(text(w, "monitor-run-budget-accounting")).toContain(
            i18n.global.t("monitor.budget.unknown"),
        );
        // 也不许画进度条（缺的分母会让「未记录」看起来像「已花 0%」）。
        expect(w.find('[data-testid="monitor-budget-usage"]').exists()).toBe(false);
    });

    it("budgetConsumed 为 0 ⇒ 真实 0（等宽数字 + 「真实 0」徽标），与「未记录」视觉可区分", async () => {
        const fetcher = vi.fn<Fetcher>().mockResolvedValue(runStatus({ budgetConsumed: 0 }));
        const w = mountSummary(fetcher);
        await flushPromises();

        expect(
            w.get('[data-testid="monitor-budget-consumed"]').attributes("data-budget-recorded"),
        ).toBe("true");
        expect(text(w, "monitor-budget-consumed-value")).toBe("0");
        expect(w.find('[data-testid="monitor-budget-consumed-zero"]').exists()).toBe(true);
        expect(w.find('[data-testid="monitor-budget-consumed-unrecorded"]').exists()).toBe(false);
        // 0 有分母 ⇒ 进度条画得出来（0%），这与「无记账值不画」是两条不同的路。
        expect(w.find('[data-testid="monitor-budget-usage"]').exists()).toBe(true);
    });

    it("runMaxTokens 更小 ⇒ 生效上限取它并标出钳制来源", async () => {
        const fetcher = vi.fn<Fetcher>().mockResolvedValue(runStatus());
        const w = mountSummary(fetcher);
        await flushPromises();

        expect(text(w, "monitor-budget-effective-value")).toBe("500000");
        const badge = w.get('[data-testid="monitor-budget-clamped-by"]');
        expect(badge.attributes("data-clamped-by")).toBe("runMaxTokens");
        expect(badge.text()).toContain(i18n.global.t("monitor.budget.runMaxTokens"));
        expect(w.find('[data-testid="monitor-budget-not-clamped"]').exists()).toBe(false);
    });

    it("ceiling 更小 ⇒ 生效上限取 ceiling 并标出钳制来源", async () => {
        const fetcher = vi
            .fn<Fetcher>()
            .mockResolvedValue(runStatus({ runMaxTokens: 500000, runMaxTokensCeiling: 200000 }));
        const w = mountSummary(fetcher);
        await flushPromises();

        expect(text(w, "monitor-budget-effective-value")).toBe("200000");
        expect(
            w.get('[data-testid="monitor-budget-clamped-by"]').attributes("data-clamped-by"),
        ).toBe("ceiling");
    });

    it("runMaxTokens 为 0 ⇒ 「不限制」（真实值），此时由 ceiling 钳制", async () => {
        const fetcher = vi
            .fn<Fetcher>()
            .mockResolvedValue(runStatus({ runMaxTokens: 0, runMaxTokensCeiling: 200000 }));
        const w = mountSummary(fetcher);
        await flushPromises();

        expect(text(w, "monitor-budget-limits")).toContain(
            i18n.global.t("monitor.budget.unlimited"),
        );
        expect(text(w, "monitor-budget-effective-value")).toBe("200000");
        expect(
            w.get('[data-testid="monitor-budget-clamped-by"]').attributes("data-clamped-by"),
        ).toBe("ceiling");
    });

    it("两个上限都是 0 ⇒ 「当前无限制在钳制」，不画进度条", async () => {
        const fetcher = vi
            .fn<Fetcher>()
            .mockResolvedValue(runStatus({ runMaxTokens: 0, runMaxTokensCeiling: 0 }));
        const w = mountSummary(fetcher);
        await flushPromises();

        expect(text(w, "monitor-budget-effective-value")).toBe(
            i18n.global.t("monitor.budget.unlimited"),
        );
        expect(w.find('[data-testid="monitor-budget-not-clamped"]').exists()).toBe(true);
        expect(w.find('[data-testid="monitor-budget-clamped-by"]').exists()).toBe(false);
        expect(w.find('[data-testid="monitor-budget-usage"]').exists()).toBe(false);
    });

    it("未选中回合 ⇒ 空态，且不发请求", async () => {
        const fetcher = vi.fn<Fetcher>();
        const w = mountSummary(fetcher, null);
        await flushPromises();

        expect(fetcher).not.toHaveBeenCalled();
        expect(w.find('[data-testid="monitor-run-budget-empty"]').exists()).toBe(true);
    });

    it("取数失败 ⇒ 给出重试，重试后显示读数", async () => {
        const fetcher = vi
            .fn<Fetcher>()
            .mockRejectedValueOnce(new Error("boom"))
            .mockResolvedValueOnce(runStatus());
        const w = mountSummary(fetcher);
        await flushPromises();

        expect(w.find('[data-testid="monitor-run-budget-failed"]').exists()).toBe(true);
        await w.get('[data-testid="monitor-run-budget-retry"]').trigger("click");
        await flushPromises();

        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(w.find('[data-testid="monitor-run-budget-failed"]').exists()).toBe(false);
        expect(text(w, "monitor-budget-token-value")).toBe("13166");
    });

    it("切换回合会重新取数（不会把上一个回合的读数留在屏上）", async () => {
        const fetcher = vi
            .fn<Fetcher>()
            .mockResolvedValueOnce(runStatus())
            .mockResolvedValueOnce(
                runStatus({ runId: NEXT_RUN_ID, tokenCount: 5952, budgetConsumed: null }),
            );
        const w = mountSummary(fetcher);
        await flushPromises();

        await w.setProps({ runId: NEXT_RUN_ID });
        await flushPromises();

        expect(fetcher).toHaveBeenLastCalledWith(NEXT_RUN_ID);
        expect(text(w, "monitor-budget-token-value")).toBe("5952");
        expect(w.find('[data-testid="monitor-budget-consumed-unrecorded"]').exists()).toBe(true);
    });

    it("百分比按生效上限算，且封顶 100", async () => {
        const fetcher = vi
            .fn<Fetcher>()
            .mockResolvedValue(
                runStatus({ budgetConsumed: 1500, runMaxTokens: 1000, runMaxTokensCeiling: 1000 }),
            );
        const w = mountSummary(fetcher);
        await flushPromises();

        expect(text(w, "monitor-budget-usage")).toContain("100");
        expect(text(w, "monitor-budget-usage")).toContain(
            i18n.global.t("monitor.budget.usageOf", { percent: 100 }),
        );
    });
});
