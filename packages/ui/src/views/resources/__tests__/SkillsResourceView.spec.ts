import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SkillsResourceView from "../SkillsResourceView.vue";
import { i18n } from "../../../i18n";

/**
 * 技能资源页壳的单测。
 *
 * <p><b>D-1432 / task-41 + task-145 / DSD-1511</b>：WORKSPACE 层搬回工作区设置（D-1432），
 * 其后指路卡（`WorkspaceLayerMovedNotice`）也按「MVP 前不留请到别处」整件删除（task-145）。
 * 本页现在只剩 INSTANCE（全平台）与 USER（个人）两层；`?layer=WORKSPACE` 静默回落到
 * 默认可见层 = USER。</p>
 *
 * <p>承重判据：① WORKSPACE 深链与缺省层都落 USER，且退役指路节点反查为 0；
 * ② 小写 layer 仍认（解析器大小写不敏感）；③ prop 钉层盖过 query。</p>
 */
const mocks = vi.hoisted(() => ({ query: {} as Record<string, unknown> }));
vi.mock("vue-router", () => ({ useRoute: () => ({ query: mocks.query }) }));
vi.mock("../../../components/settings/SkillsPanel.vue", () => ({
    default: { name: "SkillsPanel", template: "<div data-testid='stub-skills-instance' />" },
}));
vi.mock("../../../components/resources/PersonalSkillsPanel.vue", () => ({
    default: {
        name: "PersonalSkillsPanel",
        template: "<div data-testid='stub-skills-personal' />",
    },
}));

function mountView(props: Record<string, unknown> = {}) {
    return mount(SkillsResourceView, { props, global: { plugins: [i18n] } });
}

beforeEach(() => {
    mocks.query = {};
});

describe("SkillsResourceView — 层→面板映射（task-145 后：已迁层静默回落）", () => {
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

    it("已迁层深链 ?layer=WORKSPACE ⇒ 静默回落 USER，退役指路节点反查为 0", () => {
        mocks.query = { layer: "WORKSPACE" };
        const w = mountView();
        expect(w.find('[data-testid="stub-skills-personal"]').exists()).toBe(true);
        expect(w.find('[data-testid="workspace-layer-moved"]').exists()).toBe(false);
        expect(w.find('[data-testid="workspace-layer-moved-action"]').exists()).toBe(false);
    });

    it("缺省层 ⇒ 默认可见层 = USER（skills 的声明默认层 WORKSPACE 已迁出）", () => {
        expect(mountView().find('[data-testid="stub-skills-personal"]').exists()).toBe(true);
    });

    it("task-210：prop 钉层盖过 ?layer=", () => {
        mocks.query = { layer: "USER" };
        const w = mountView({ layer: "INSTANCE" });
        expect(w.find('[data-testid="stub-skills-instance"]').exists()).toBe(true);
        expect(w.find('[data-testid="stub-skills-personal"]').exists()).toBe(false);
    });
});
