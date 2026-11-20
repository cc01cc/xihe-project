import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import McpResourceView from "../McpResourceView.vue";
import { i18n } from "../../../i18n";

/**
 * MCP 资源页壳的单测。
 *
 * <p><b>task-145 / DSD-1511（2026-11-20 用户裁定：MVP 前不留「请到别处」的空壳）</b>：
 * D-1432 / task-41 引入的 WORKSPACE 指路卡（`WorkspaceLayerMovedNotice`）整件删除。
 * 本页现在**只剩实例层**；`?layer=WORKSPACE` 与 `?layer=USER` 都由
 * `visibleLayersForResource` 过滤后静默回落到 INSTANCE（不再渲染任何指路节点）。</p>
 *
 * <p>三条承重判据：① WORKSPACE 深链 ⇒ 实例面板在、指路节点为 0；② 退役节点反查为 0
 * （`workspace-layer-moved` / `-action` —— 删干净了，不是「藏起来」）；③ prop 钉层仍盖过 query。</p>
 *
 * <p><b>只读门（`:readonly="!auth.canWriteWorkspace"`）不在本文件了</b> —— 它随面板搬到了
 * 工作区设置页（`features/workspace/__tests__/WorkspaceSettingsView.spec.ts` 钉）。这里保留
 * 一句反向说明，防止下一个人在本文件里再找一遍。</p>
 */
const mocks = vi.hoisted(() => ({ query: {} as Record<string, unknown> }));
vi.mock("vue-router", () => ({ useRoute: () => ({ query: mocks.query }) }));
vi.mock("../../../components/settings/InstanceMcpPanel.vue", () => ({
    default: { name: "InstanceMcpPanel", template: "<div data-testid='stub-mcp-instance' />" },
}));

function mountView(props: Record<string, unknown> = {}) {
    return mount(McpResourceView, { props, global: { plugins: [i18n] } });
}

beforeEach(() => {
    mocks.query = {};
});

describe("McpResourceView — 层映射（task-145 后：只剩实例层，已迁层静默回落）", () => {
    it("INSTANCE → InstanceMcpPanel", () => {
        mocks.query = { layer: "INSTANCE" };
        expect(mountView().find('[data-testid="stub-mcp-instance"]').exists()).toBe(true);
    });

    it("已迁层深链 ?layer=WORKSPACE ⇒ 静默回落 INSTANCE，且页面上没有任何指路节点", () => {
        mocks.query = { layer: "WORKSPACE" };
        const w = mountView();
        expect(w.find('[data-testid="stub-mcp-instance"]').exists()).toBe(true);
        // 退役节点反查为 0：删除而不是隐藏（CSS 藏起来会在这里露出真身）。
        expect(w.find('[data-testid="workspace-layer-moved"]').exists()).toBe(false);
        expect(w.find('[data-testid="workspace-layer-moved-action"]').exists()).toBe(false);
    });

    it("无 USER 层：?layer=USER 也回落到 INSTANCE（不渲染空页、不 404）", () => {
        mocks.query = { layer: "USER" };
        expect(mountView().find('[data-testid="stub-mcp-instance"]').exists()).toBe(true);
    });

    it("缺省层（无 ?layer=）⇒ 默认可见层 = INSTANCE", () => {
        expect(mountView().find('[data-testid="stub-mcp-instance"]').exists()).toBe(true);
    });

    it("task-210：prop 钉层盖过 ?layer=（深链交给调用方决定）", () => {
        mocks.query = { layer: "WORKSPACE" };
        const w = mountView({ layer: "INSTANCE" });
        expect(w.find('[data-testid="stub-mcp-instance"]').exists()).toBe(true);
    });
});
