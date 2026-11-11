import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../../../../i18n";
import { api } from "../../../../composables/api";
import { useSessionStore } from "../../../../stores/session";
import type { Session, SessionDerivedStateResponse } from "../../../../types";
import DelegationDagPanel from "../components/DelegationDagPanel.vue";
import DelegationDialog from "../components/DelegationDialog.vue";

/**
 * task-101（PLAN-0659 缺陷 A 类第 1 条）：`delegation-budget` 同屏双挂。
 *
 * 事实：DAG 面板（dock 常驻面）与委派弹窗（composer 里 `open` 后出现）渲染**同一会话的
 * 同一组数**（used/max/depth），只是 i18n 模板不同 ⇒ 两者同时打开时页面上有两个
 * `[data-testid="delegation-budget"]`，Playwright strict mode 会直接定位失败
 * （`e2e/mock/plan0659-delegation-dag.spec.ts` 曾裸用它，只是侥幸没同框）。
 *
 * 改法与命名依据（与 task-90「载具让名、本体留语义」方向相反的召回）：
 * - 面板侧让名 → `delegation-dag-budget`：面板的 testid 家族本来就是
 *   `delegation-dag` / `delegation-dag-refresh` / `delegation-dag-error` /
 *   `delegation-dag-truncated` / `delegation-dag-empty`，`delegation-budget` 是家里唯一的
 *   异类 ⇒ 它才是"DAG 面板自己的预算"这个语义的持有者，命名应带容器前缀。
 * - 弹窗保留 `delegation-budget`：它是"委派**动作**的预算"（点「委派」时才需要看的那份），
 *   通用名归它。
 *
 * 本 spec 的判据（**真挂两个组件，不 stub 任何一方** —— task-90 的教训：stub 掉重复的那一方
 * 等于断言不看）：同框时 `delegation-budget` 计数 = 1、`delegation-dag-budget` 计数 = 1，
 * 且各自落在自己的容器里、渲染各自的模板。
 */

const BUDGET = {
    usedSessions: 2,
    maxCount: 5,
    currentDepth: 1,
    maxDepth: 3,
    disabled: false,
};

function session(overrides: Partial<Session> & { id: string }): Session {
    return {
        title: `会话 ${overrides.id}`,
        createdAt: "2026-11-04T10:00:00.000Z",
        updatedAt: "2026-11-04T10:00:00.000Z",
        kind: null,
        spawnedFromSessionId: null,
        spawnedAt: null,
        ...overrides,
    } as Session;
}

const ROOT = session({ id: "root", title: "父会话" });
const CHILD = session({
    id: "child-a",
    title: "子会话 A",
    kind: "SPAWN",
    spawnedFromSessionId: "root",
    spawnedAt: "2026-11-04T10:01:00.000Z",
});

function derived(): SessionDerivedStateResponse {
    return {
        sessionId: "root",
        activeChildren: [
            { childSessionId: "child-a", runId: "run-a", name: null, status: "running" },
        ],
        terminalNotices: [],
    };
}

const mounted: VueWrapper[] = [];
/** 同一条用例内组件与 store 必须共用同一个 pinia 实例，否则塞进 store 的数据组件看不见。 */
let pinia: ReturnType<typeof createPinia>;

/** 真挂两个组件：DAG 面板 + 已打开的委派弹窗（弹窗内容 teleport 到 body）。 */
function mountBothSameScreen(): VueWrapper {
    const Harness = defineComponent({
        render() {
            return h("div", [
                h(DelegationDagPanel, { sessionId: "root" }),
                h(DelegationDialog, {
                    open: true,
                    sessionId: "root",
                    principals: [{ principalId: "agent-alpha", name: "Agent Alpha" }],
                    budget: BUDGET,
                    submitting: false,
                    approvalPending: false,
                }),
            ]);
        },
    });
    const wrapper = mount(Harness, {
        attachTo: document.body,
        global: { plugins: [i18n, pinia] },
    });
    mounted.push(wrapper);
    return wrapper;
}

function countTestId(testId: string): number {
    return document.querySelectorAll(`[data-testid="${testId}"]`).length;
}

describe("delegation budget testid 同屏唯一性 (task-101)", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        pinia = createPinia();
        setActivePinia(pinia);
        vi.spyOn(api, "delegationUsage").mockResolvedValue({
            rootSessionId: "root",
            usedSessions: 2,
            maxCount: 5,
            currentDepth: 0,
            maxDepth: 3,
            principalId: "agent-alpha",
            principalName: "Agent Alpha",
            policySource: "subject",
            disabled: false,
        });
        vi.spyOn(api, "getSessionDerivedState").mockResolvedValue(derived());
        useSessionStore(pinia).sessions = [ROOT, CHILD];
    });

    afterEach(() => {
        while (mounted.length > 0) mounted.pop()?.unmount();
        // 弹窗 portal 的残留节点挂在 body 上，清掉避免污染下一条用例的计数
        document.body.innerHTML = "";
    });

    it("同框时两个 testid 各出现 1 次，且真挂了两处组件", async () => {
        mountBothSameScreen();
        await flushPromises();

        // ① 两个容器都在（证明是"真挂两个"，不是只挂一个然后数 1）
        expect(countTestId("delegation-dag"), "DAG 面板容器").toBe(1);
        expect(countTestId("delegation-dialog"), "委派弹窗容器").toBe(1);

        // ② 两个预算 testid 各 1 次（改名前的双挂状态在这里 count 会是 2/0）
        expect(countTestId("delegation-dag-budget"), "面板预算").toBe(1);
        expect(countTestId("delegation-budget"), "弹窗预算").toBe(1);

        // ③ 归属正确：面板的预算只出现在 DAG 面板内，弹窗的只出现在弹窗内
        const dagRoot = document.querySelector('[data-testid="delegation-dag"]');
        const dialogRoot = document.querySelector('[data-testid="delegation-dialog"]');
        expect(dagRoot?.querySelectorAll('[data-testid="delegation-dag-budget"]')).toHaveLength(1);
        expect(dagRoot?.querySelectorAll('[data-testid="delegation-budget"]')).toHaveLength(0);
        expect(dialogRoot?.querySelectorAll('[data-testid="delegation-budget"]')).toHaveLength(1);
        expect(dialogRoot?.querySelectorAll('[data-testid="delegation-dag-budget"]')).toHaveLength(
            0,
        );

        // ④ 两份是**真实的两处渲染**：模板不同（面板 `·`，弹窗 `｜`），数值各自来自
        //    root budget（面板 0/3 深度）与 dialog budget prop（1/3 深度）
        const dagBudget = document.querySelector('[data-testid="delegation-dag-budget"]');
        const dialogBudget = document.querySelector('[data-testid="delegation-budget"]');
        expect(dagBudget?.textContent).toBe(
            i18n.global.t("chat.delegation.dagBudget", {
                used: 2,
                max: 5,
                depth: 0,
                maxDepth: 3,
            }),
        );
        expect(dialogBudget?.textContent).toContain(i18n.global.t("chat.delegation.budgetUsage"));
        expect(dialogBudget?.textContent).toContain("2/5");
        expect(dialogBudget?.textContent).toContain("1/3");
    });

    it("只开 DAG 面板时 `delegation-budget` 不存在（弹窗未开）", async () => {
        const wrapper = mount(DelegationDagPanel, {
            props: { sessionId: "root" },
            attachTo: document.body,
            global: { plugins: [i18n, pinia] },
        });
        mounted.push(wrapper);
        await flushPromises();

        expect(countTestId("delegation-dag-budget")).toBe(1);
        expect(countTestId("delegation-budget")).toBe(0);
    });
});
