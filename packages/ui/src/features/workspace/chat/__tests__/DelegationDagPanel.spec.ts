import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../../../../i18n";
import { api, type DelegationUsageView } from "../../../../composables/api";
import { useSessionStore } from "../../../../stores/session";
import type { Session, SessionDerivedStateResponse } from "../../../../types";
import DelegationDagPanel from "../components/DelegationDagPanel.vue";

/**
 * PLAN-0659 T1.4：委派 DAG 面板（右栏）。纯函数的父子/状态/深度已在
 * `delegationGraph.spec.ts` 钉死；本 spec 只钉**消费端**：节点/边/状态/预算渲染，
 * 空态、错误态（结构仍显示）、刷新按钮重拉。
 */
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
const CHILD_A = session({
    id: "child-a",
    title: "子会话 A",
    kind: "SPAWN",
    spawnedFromSessionId: "root",
    spawnedAt: "2026-11-04T10:01:00.000Z",
});
const CHILD_B = session({
    id: "child-b",
    title: "子会话 B",
    kind: "SPAWN",
    spawnedFromSessionId: "root",
    spawnedAt: "2026-11-04T10:02:00.000Z",
});

const USAGE: DelegationUsageView = {
    rootSessionId: "root",
    usedSessions: 2,
    maxCount: 5,
    currentDepth: 1,
    maxDepth: 3,
    principalId: "agent-alpha",
    principalName: "Agent Alpha",
    policySource: "subject",
    disabled: false,
};

function derived(
    active: SessionDerivedStateResponse["activeChildren"] = [],
    terminal: SessionDerivedStateResponse["terminalNotices"] = [],
): SessionDerivedStateResponse {
    return { sessionId: "root", activeChildren: active, terminalNotices: terminal };
}

describe("DelegationDagPanel (PLAN-0659 T1.4)", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(api, "delegationUsage").mockResolvedValue(USAGE);
        vi.spyOn(api, "getSessionDerivedState").mockResolvedValue(derived());
    });

    function seed(sessions: Session[]): void {
        const store = useSessionStore();
        store.sessions = sessions;
    }

    it("renders parent→child nodes, edges, child status and the root budget", async () => {
        vi.mocked(api.getSessionDerivedState).mockResolvedValue(
            derived(
                [{ childSessionId: "child-a", runId: "run-a", name: null, status: "running" }],
                [
                    {
                        childSessionId: "child-b",
                        runId: "run-b",
                        name: null,
                        state: "success",
                        terminalAt: "2026-11-04T10:03:00.000Z",
                    },
                ],
            ),
        );
        const pinia = createPinia();
        setActivePinia(pinia);
        seed([ROOT, CHILD_A, CHILD_B]);
        const wrapper = mount(DelegationDagPanel, {
            props: { sessionId: "root" },
            global: { plugins: [i18n, pinia] },
        });
        await flushPromises();

        const nodes = wrapper.findAll('[data-testid="delegation-node"]');
        expect(nodes).toHaveLength(3);
        expect(nodes.map((node) => node.attributes("data-session-id"))).toEqual([
            "root",
            "child-a",
            "child-b",
        ]);
        expect(nodes.map((node) => node.attributes("data-depth"))).toEqual(["0", "1", "1"]);
        expect(wrapper.findAll('[data-testid="delegation-edge"]')).toHaveLength(2);

        const statuses = wrapper.findAll('[data-testid="delegation-node-status"]');
        expect(statuses.map((node) => node.text())).toEqual([
            i18n.global.t("chat.derivedStateStatus.running"),
            i18n.global.t("chat.derivedStateOutcome.success"),
        ]);
        // 在途节点有 active 标记，终态节点带 terminal（DOM 断言面）。
        expect(nodes[1]?.attributes("data-node-active")).toBe("true");
        expect(nodes[2]?.attributes("data-node-terminal")).toBe("success");

        expect(wrapper.get('[data-testid="delegation-dag-budget"]').text()).toBe(
            i18n.global.t("chat.delegation.dagBudget", {
                used: 2,
                max: 5,
                depth: 1,
                maxDepth: 3,
            }),
        );
        wrapper.unmount();
    });

    it("shows the empty state when the session has no delegated children", async () => {
        const pinia = createPinia();
        setActivePinia(pinia);
        seed([ROOT]);
        const wrapper = mount(DelegationDagPanel, {
            props: { sessionId: "root" },
            global: { plugins: [i18n, pinia] },
        });
        await flushPromises();

        expect(wrapper.get('[data-testid="delegation-dag-empty"]').text()).toBe(
            i18n.global.t("chat.delegation.dagEmpty"),
        );
        expect(wrapper.findAll('[data-testid="delegation-node"]')).toHaveLength(0);
        expect(wrapper.findAll('[data-testid="delegation-edge"]')).toHaveLength(0);
        wrapper.unmount();
    });

    it("keeps the structure visible when child-state loading fails, and can refresh", async () => {
        vi.mocked(api.getSessionDerivedState).mockRejectedValue(new Error("boom"));
        const pinia = createPinia();
        setActivePinia(pinia);
        seed([ROOT, CHILD_A, CHILD_B]);
        const wrapper = mount(DelegationDagPanel, {
            props: { sessionId: "root" },
            global: { plugins: [i18n, pinia] },
        });
        await flushPromises();

        expect(wrapper.find('[data-testid="delegation-dag-error"]').exists()).toBe(true);
        expect(wrapper.findAll('[data-testid="delegation-node"]')).toHaveLength(3);

        const callsBefore = vi.mocked(api.getSessionDerivedState).mock.calls.length;
        await wrapper.get('[data-testid="delegation-dag-refresh"]').trigger("click");
        await flushPromises();
        expect(vi.mocked(api.getSessionDerivedState).mock.calls.length).toBeGreaterThan(
            callsBefore,
        );
        wrapper.unmount();
    });
});
