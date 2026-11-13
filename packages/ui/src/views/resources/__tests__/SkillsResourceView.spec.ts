import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SkillsResourceView from "../SkillsResourceView.vue";
import { i18n } from "../../../i18n";

/**
 * task-41（D-1239 裁 A）：技能资源页壳的 focused 单测（此前无）。
 * 钉 layer→panel 映射 + 无工作区上下文诚实态 + task-210 prop 钉层。承重：改分支必红。
 * 无权真形态在面板/r17（本层写面未接线），壳层只判「有没有工作区上下文」，不硬套 disabled。
 */
const mocks = vi.hoisted(() => ({
    query: {} as Record<string, unknown>,
    tabWs: null as string | null,
}));
vi.mock("vue-router", () => ({ useRoute: () => ({ query: mocks.query }) }));
vi.mock("../../../lib/workspaceContext", () => ({ readTabWorkspaceId: () => mocks.tabWs }));
vi.mock("../../../components/settings/SkillsPanel.vue", () => ({
    default: { name: "SkillsPanel", template: "<div data-testid='stub-skills-instance' />" },
}));
vi.mock("../../../components/resources/PersonalSkillsPanel.vue", () => ({
    default: {
        name: "PersonalSkillsPanel",
        template: "<div data-testid='stub-skills-personal' />",
    },
}));
vi.mock("../../../components/resources/WorkspaceSkillsPanel.vue", () => ({
    default: {
        name: "WorkspaceSkillsPanel",
        props: ["workspaceId"],
        template: "<div data-testid='stub-skills-workspace' :data-ws='workspaceId' />",
    },
}));
vi.mock("../../../components/resources/ResourceWorkspaceRequired.vue", () => ({
    default: {
        name: "ResourceWorkspaceRequired",
        template: "<div data-testid='stub-workspace-required' />",
    },
}));

function mountView(props: Record<string, unknown> = {}) {
    return mount(SkillsResourceView, { props, global: { plugins: [i18n] } });
}
beforeEach(() => {
    mocks.query = {};
    mocks.tabWs = null;
});
describe("SkillsResourceView — 层→面板映射", () => {
    it("INSTANCE → SkillsPanel（全平台）", () => {
        mocks.query = { layer: "INSTANCE" };
        const w = mountView();
        expect(w.find('[data-testid="stub-skills-instance"]').exists()).toBe(true);
        expect(w.find('[data-testid="stub-skills-personal"]').exists()).toBe(false);
    });
    it("USER → PersonalSkillsPanel（个人）", () => {
        mocks.query = { layer: "USER" };
        expect(mountView().find('[data-testid="stub-skills-personal"]').exists()).toBe(true);
    });
    it("缺省层 → WORKSPACE（skills 默认 WORKSPACE，settingsIa:354）；无上下文 ⇒ 诚实态门", () => {
        const w = mountView();
        expect(w.find('[data-testid="stub-workspace-required"]').exists()).toBe(true);
    });
    it("小写 ?layer=instance 也认（resolveResourceLayer 大小写不敏感）", () => {
        mocks.query = { layer: "instance" };
        expect(mountView().find('[data-testid="stub-skills-instance"]').exists()).toBe(true);
    });
    it("WORKSPACE + 有上下文 → WorkspaceSkillsPanel 且带 workspaceId", () => {
        mocks.query = { layer: "WORKSPACE" };
        mocks.tabWs = "ws-1";
        const w = mountView();
        const panel = w.find('[data-testid="stub-skills-workspace"]');
        expect(panel.exists()).toBe(true);
        expect(panel.attributes("data-ws")).toBe("ws-1");
    });
    it("WORKSPACE + 无上下文 → 诚实态门（不静默空列表，承重：删门必红）", () => {
        mocks.query = { layer: "WORKSPACE" };
        mocks.tabWs = null;
        const w = mountView();
        expect(w.find('[data-testid="stub-workspace-required"]').exists()).toBe(true);
        expect(w.find('[data-testid="stub-skills-workspace"]').exists()).toBe(false);
    });
    it("task-210：prop 钉层盖过 ?layer=（工作区资源页不依赖页签上下文顺序）", () => {
        mocks.query = { layer: "USER" };
        mocks.tabWs = null;
        const w = mountView({ layer: "WORKSPACE", workspaceId: "ws-prop" });
        const panel = w.find('[data-testid="stub-skills-workspace"]');
        expect(panel.exists()).toBe(true);
        expect(panel.attributes("data-ws")).toBe("ws-prop");
    });
});
