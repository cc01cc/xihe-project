import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SkillsResourceView from "../SkillsResourceView.vue";
import { i18n } from "../../../i18n";

/**
 * 技能资源页壳的单测。
 *
 * <p><b>D-1432 / task-41</b>：WORKSPACE 层不再渲染 `WorkspaceSkillsPanel`，改为指路卡；
 * INSTANCE（全平台）与 USER（个人）两层不变。WORKSPACE 断言因此从「面板 + workspaceId」
 * 变成「指路卡 + 深链 href = ?tab=skills」，并加负断言「面板不在」。</p>
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
        template: "<div data-testid='stub-skills-workspace' />",
    },
}));

const RouterLinkStub = {
    props: ["to"],
    template: '<a :href="String(to)"><slot /></a>',
};

function mountView(props: Record<string, unknown> = {}) {
    return mount(SkillsResourceView, {
        props,
        global: { plugins: [i18n], stubs: { RouterLink: RouterLinkStub } },
    });
}
beforeEach(() => {
    mocks.query = {};
    mocks.tabWs = null;
});
describe("SkillsResourceView — 层→面板映射（D-1432 后：WORKSPACE = 指路）", () => {
    it("INSTANCE → SkillsPanel（全平台）", () => {
        mocks.query = { layer: "INSTANCE" };
        const w = mountView();
        expect(w.find('[data-testid="stub-skills-instance"]').exists()).toBe(true);
        expect(w.find('[data-testid="stub-skills-personal"]').exists()).toBe(false);
    });
    it("USER → PersonalSkillsPanel（个人层不受搬迁影响）", () => {
        mocks.query = { layer: "USER" };
        expect(mountView().find('[data-testid="stub-skills-personal"]').exists()).toBe(true);
    });
    it("小写 ?layer=instance 也认（resolveResourceLayer 大小写不敏感）", () => {
        mocks.query = { layer: "instance" };
        expect(mountView().find('[data-testid="stub-skills-instance"]').exists()).toBe(true);
    });
    it("WORKSPACE + 有上下文 → 指路卡 + ?tab=skills 深链，且**不**渲染面板", () => {
        mocks.query = { layer: "WORKSPACE" };
        mocks.tabWs = "ws-1";
        const w = mountView();
        expect(w.find('[data-testid="workspace-layer-moved"]').exists()).toBe(true);
        expect(w.find('[data-testid="workspace-layer-moved-action"]').attributes("href")).toBe(
            "/workspace/ws-1/settings?tab=skills",
        );
        expect(w.find('[data-testid="stub-skills-workspace"]').exists()).toBe(false);
    });
    it("缺省层 ⇒ WORKSPACE（skills 默认 WORKSPACE）⇒ 有上下文时指路卡", () => {
        mocks.tabWs = "ws-1";
        expect(mountView().find('[data-testid="workspace-layer-moved"]').exists()).toBe(true);
    });
    it("WORKSPACE + 无上下文 → 指路卡只给提示，不给按钮", () => {
        mocks.query = { layer: "WORKSPACE" };
        mocks.tabWs = null;
        const w = mountView();
        expect(w.find('[data-testid="workspace-layer-moved"]').exists()).toBe(true);
        expect(w.find('[data-testid="workspace-layer-moved-action"]').exists()).toBe(false);
    });
    it("task-210：prop 钉层盖过 ?layer=（深链用 prop 的工作区）", () => {
        mocks.query = { layer: "USER" };
        const w = mountView({ layer: "WORKSPACE", workspaceId: "ws-prop" });
        expect(w.find('[data-testid="stub-skills-personal"]').exists()).toBe(false);
        expect(w.find('[data-testid="workspace-layer-moved-action"]').attributes("href")).toBe(
            "/workspace/ws-prop/settings?tab=skills",
        );
    });
});
