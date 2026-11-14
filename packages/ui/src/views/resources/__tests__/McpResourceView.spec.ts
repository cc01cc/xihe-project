import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import McpResourceView from "../McpResourceView.vue";
import { i18n } from "../../../i18n";

/**
 * MCP 资源页壳的单测。
 *
 * <p><b>D-1432 / task-41（用户 2026-11-15 裁定）改了承重对象</b>：WORKSPACE 层不再渲染
 * `WorkspaceMcpPanel`，改为指路卡（`WorkspaceLayerMovedNotice`）⇒ 本文件的 WORKSPACE 断言
 * 从「面板 + workspaceId」变成「指路卡 + 深链 href」，并**加了负断言**「面板不在」(否则
 * 改回旧分支也能全绿)。</p>
 *
 * <p><b>只读门（`:readonly="!auth.canWriteWorkspace"`）不在本文件了</b> —— 它随面板搬到了
 * 工作区设置页（`features/workspace/__tests__/WorkspaceSettingsView.spec.ts` 钉）。这里保留
 * 一句反向说明，防止下一个人在本文件里再找一遍。</p>
 */
const mocks = vi.hoisted(() => ({
    query: {} as Record<string, unknown>,
    tabWs: null as string | null,
}));
vi.mock("vue-router", () => ({ useRoute: () => ({ query: mocks.query }) }));
vi.mock("../../../lib/workspaceContext", () => ({ readTabWorkspaceId: () => mocks.tabWs }));
vi.mock("../../../components/settings/InstanceMcpPanel.vue", () => ({
    default: { name: "InstanceMcpPanel", template: "<div data-testid='stub-mcp-instance' />" },
}));
/** 守护用：若 WORKSPACE 分支又被接回面板，这个 stub 会出现在 DOM 里 ⇒ 负断言当场红。 */
vi.mock("../../../features/workspace/components/WorkspaceMcpPanel.vue", () => ({
    default: {
        name: "WorkspaceMcpPanel",
        props: ["workspaceId", "readonly"],
        template: "<div data-testid='stub-mcp-workspace' />",
    },
}));

const RouterLinkStub = {
    props: ["to"],
    template: '<a :href="String(to)"><slot /></a>',
};

function mountView(props: Record<string, unknown> = {}) {
    return mount(McpResourceView, {
        props,
        global: { plugins: [i18n], stubs: { RouterLink: RouterLinkStub } },
    });
}
beforeEach(() => {
    mocks.query = {};
    mocks.tabWs = null;
});
describe("McpResourceView — 层映射（D-1432 后：WORKSPACE 层 = 指路）", () => {
    it("INSTANCE → InstanceMcpPanel（实例层不受搬迁影响）", () => {
        mocks.query = { layer: "INSTANCE" };
        expect(mountView().find('[data-testid="stub-mcp-instance"]').exists()).toBe(true);
    });
    it("WORKSPACE + 有上下文 → 指路卡 + 深链指向设置页 mcp 页签，且**不**渲染面板", () => {
        mocks.query = { layer: "WORKSPACE" };
        mocks.tabWs = "ws-1";
        const w = mountView();
        expect(w.find('[data-testid="workspace-layer-moved"]').exists()).toBe(true);
        expect(w.find('[data-testid="workspace-layer-moved-action"]').attributes("href")).toBe(
            "/workspace/ws-1/settings?tab=mcp",
        );
        // 负断言：旧分支（渲染面板）必须已经不在 —— 否则「改回去」也能绿。
        expect(w.find('[data-testid="stub-mcp-workspace"]').exists()).toBe(false);
    });
    it("WORKSPACE + 无上下文 → 仍是指路卡，但只给「先选工作区」提示、不给按钮（不猜工作区）", () => {
        mocks.query = { layer: "WORKSPACE" };
        mocks.tabWs = null;
        const w = mountView();
        expect(w.find('[data-testid="workspace-layer-moved"]').exists()).toBe(true);
        expect(w.find('[data-testid="workspace-layer-moved-action"]').exists()).toBe(false);
    });
    it("无 USER 层：?layer=USER 落回 WORKSPACE ⇒ 指路卡（不渲染空页、不 404）", () => {
        mocks.query = { layer: "USER" };
        mocks.tabWs = "ws-1";
        expect(mountView().find('[data-testid="workspace-layer-moved"]').exists()).toBe(true);
    });
    it("缺省层（无 ?layer=）⇒ mcp 默认 WORKSPACE ⇒ 指路卡", () => {
        mocks.tabWs = "ws-1";
        expect(mountView().find('[data-testid="workspace-layer-moved"]').exists()).toBe(true);
    });
    it("task-210：prop 钉层 + workspaceId 盖过 ?layer=（深链用 prop 的工作区）", () => {
        mocks.query = { layer: "INSTANCE" };
        const w = mountView({ layer: "WORKSPACE", workspaceId: "ws-prop" });
        expect(w.find('[data-testid="stub-mcp-instance"]').exists()).toBe(false);
        expect(w.find('[data-testid="workspace-layer-moved-action"]').attributes("href")).toBe(
            "/workspace/ws-prop/settings?tab=mcp",
        );
    });
});
