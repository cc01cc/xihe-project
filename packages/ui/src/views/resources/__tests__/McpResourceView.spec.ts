import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import McpResourceView from "../McpResourceView.vue";
import { i18n } from "../../../i18n";

/**
 * task-41（D-1239 裁 A）：MCP 资源页壳的 focused 单测（此前无）。
 * 核心承重：task-209 搬家接管的只读门 :readonly="!auth.canWriteWorkspace"（VIEWER 可编辑 = P0 回归）。
 * mcp 只有两层（无 USER，?layer=USER 落回 WORKSPACE）。无权真形态逐页取（r17），壳层钉 readonly 传递。
 */
const mocks = vi.hoisted(() => ({
    query: {} as Record<string, unknown>,
    tabWs: null as string | null,
    canWrite: true,
}));
vi.mock("vue-router", () => ({ useRoute: () => ({ query: mocks.query }) }));
vi.mock("../../../lib/workspaceContext", () => ({ readTabWorkspaceId: () => mocks.tabWs }));
vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => ({ canWriteWorkspace: mocks.canWrite }),
}));
vi.mock("../../../components/settings/InstanceMcpPanel.vue", () => ({
    default: { name: "InstanceMcpPanel", template: "<div data-testid='stub-mcp-instance' />" },
}));
vi.mock("../../../features/workspace/components/WorkspaceMcpPanel.vue", () => ({
    default: {
        name: "WorkspaceMcpPanel",
        props: ["workspaceId", "readonly"],
        template:
            "<div data-testid='stub-mcp-workspace' :data-ws='workspaceId' :data-readonly='String(readonly)' />",
    },
}));
vi.mock("../../../components/resources/ResourceWorkspaceRequired.vue", () => ({
    default: {
        name: "ResourceWorkspaceRequired",
        template: "<div data-testid='stub-workspace-required' />",
    },
}));
function mountView(props: Record<string, unknown> = {}) {
    return mount(McpResourceView, { props, global: { plugins: [i18n] } });
}
beforeEach(() => {
    mocks.query = {};
    mocks.tabWs = null;
    mocks.canWrite = true;
});
describe("McpResourceView — 层映射 + 只读门", () => {
    it("INSTANCE → InstanceMcpPanel", () => {
        mocks.query = { layer: "INSTANCE" };
        expect(mountView().find('[data-testid="stub-mcp-instance"]').exists()).toBe(true);
    });
    it("WORKSPACE + 有上下文 → WorkspaceMcpPanel 带 workspaceId", () => {
        mocks.query = { layer: "WORKSPACE" };
        mocks.tabWs = "ws-1";
        expect(mountView().find('[data-testid="stub-mcp-workspace"]').attributes("data-ws")).toBe(
            "ws-1",
        );
    });
    it("只读门：canWriteWorkspace=true → readonly=false（EDITOR 可写）", () => {
        mocks.query = { layer: "WORKSPACE" };
        mocks.tabWs = "ws-1";
        mocks.canWrite = true;
        expect(
            mountView().find('[data-testid="stub-mcp-workspace"]').attributes("data-readonly"),
        ).toBe("false");
    });
    it("只读门承重：canWriteWorkspace=false → readonly=true（VIEWER 只读；去掉 :readonly 必红）", () => {
        mocks.query = { layer: "WORKSPACE" };
        mocks.tabWs = "ws-1";
        mocks.canWrite = false;
        expect(
            mountView().find('[data-testid="stub-mcp-workspace"]').attributes("data-readonly"),
        ).toBe("true");
    });
    it("WORKSPACE + 无上下文 → 诚实态门", () => {
        mocks.query = { layer: "WORKSPACE" };
        mocks.tabWs = null;
        expect(mountView().find('[data-testid="stub-workspace-required"]').exists()).toBe(true);
    });
    it("无 USER 层：?layer=USER 落回 WORKSPACE（不渲染空页）", () => {
        mocks.query = { layer: "USER" };
        mocks.tabWs = "ws-1";
        expect(mountView().find('[data-testid="stub-mcp-workspace"]').exists()).toBe(true);
    });
    it("task-210：prop 钉层 + workspaceId 盖过 ?layer=", () => {
        mocks.query = { layer: "INSTANCE" };
        mocks.tabWs = null;
        const w = mountView({ layer: "WORKSPACE", workspaceId: "ws-prop" });
        expect(w.find('[data-testid="stub-mcp-workspace"]').attributes("data-ws")).toBe("ws-prop");
    });
});
