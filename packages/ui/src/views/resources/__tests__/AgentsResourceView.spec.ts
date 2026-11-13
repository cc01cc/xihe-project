import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AgentsResourceView from "../AgentsResourceView.vue";
import { i18n } from "../../../i18n";

/**
 * task-41（D-1239 裁 A）：智能体资源页壳的 focused 单测（此前无）。
 * 三层不同轴（USER=个人主体 / WORKSPACE=成员绑定 / INSTANCE=平台智能体），钉映射不互相顶替 + 无上下文诚实态。
 * 无权真形态（绑定由 CP MANAGE_WORKSPACE_AGENTS 守）在面板/r17，壳层钉「有没有工作区上下文」。
 */
const mocks = vi.hoisted(() => ({
    query: {} as Record<string, unknown>,
    tabWs: null as string | null,
}));
vi.mock("vue-router", () => ({ useRoute: () => ({ query: mocks.query }) }));
vi.mock("../../../lib/workspaceContext", () => ({ readTabWorkspaceId: () => mocks.tabWs }));
vi.mock("../../../components/settings/InstanceAgentsPanel.vue", () => ({
    default: {
        name: "InstanceAgentsPanel",
        template: "<div data-testid='stub-agents-instance' />",
    },
}));
vi.mock("../../../components/settings/AgentPrincipalsPanel.vue", () => ({
    default: {
        name: "AgentPrincipalsPanel",
        template: "<div data-testid='stub-agents-principals' />",
    },
}));
vi.mock("../../../features/workspace/components/WorkspaceAgentsPanel.vue", () => ({
    default: {
        name: "WorkspaceAgentsPanel",
        props: ["workspaceId"],
        template: "<div data-testid='stub-agents-workspace' :data-ws='workspaceId' />",
    },
}));
vi.mock("../../../components/resources/ResourceWorkspaceRequired.vue", () => ({
    default: {
        name: "ResourceWorkspaceRequired",
        template: "<div data-testid='stub-workspace-required' />",
    },
}));
function mountView(props: Record<string, unknown> = {}) {
    return mount(AgentsResourceView, { props, global: { plugins: [i18n] } });
}
beforeEach(() => {
    mocks.query = {};
    mocks.tabWs = null;
});
describe("AgentsResourceView — 三层不同轴映射", () => {
    it("INSTANCE → InstanceAgentsPanel（平台智能体）", () => {
        mocks.query = { layer: "INSTANCE" };
        expect(mountView().find('[data-testid="stub-agents-instance"]').exists()).toBe(true);
    });
    it("USER → AgentPrincipalsPanel（个人主体）", () => {
        mocks.query = { layer: "USER" };
        expect(mountView().find('[data-testid="stub-agents-principals"]').exists()).toBe(true);
    });
    it("缺省层 → USER（agents 默认 USER，settingsIa:377）", () => {
        expect(mountView().find('[data-testid="stub-agents-principals"]').exists()).toBe(true);
    });
    it("WORKSPACE + 有上下文 → WorkspaceAgentsPanel（成员绑定）带 workspaceId", () => {
        mocks.query = { layer: "WORKSPACE" };
        mocks.tabWs = "ws-1";
        expect(
            mountView().find('[data-testid="stub-agents-workspace"]').attributes("data-ws"),
        ).toBe("ws-1");
    });
    it("WORKSPACE + 无上下文 → 诚实态门（不许静默空列表，承重：删门必红）", () => {
        mocks.query = { layer: "WORKSPACE" };
        mocks.tabWs = null;
        const w = mountView();
        expect(w.find('[data-testid="stub-workspace-required"]').exists()).toBe(true);
        expect(w.find('[data-testid="stub-agents-workspace"]').exists()).toBe(false);
    });
    it("task-210：prop 钉层盖过 ?layer=", () => {
        mocks.query = { layer: "USER" };
        mocks.tabWs = null;
        const w = mountView({ layer: "WORKSPACE", workspaceId: "ws-prop" });
        expect(w.find('[data-testid="stub-agents-workspace"]').attributes("data-ws")).toBe(
            "ws-prop",
        );
    });
});
