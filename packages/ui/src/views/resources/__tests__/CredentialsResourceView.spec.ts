import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CredentialsResourceView from "../CredentialsResourceView.vue";
import { i18n } from "../../../i18n";

/**
 * task-41（D-1239 裁 A）：凭据资源页壳的 focused 单测（此前无）。
 * 壳只做宿主：三层各沿用原面板，钉 owner-type 分支（USER vs WORKSPACE）+ 无上下文诚实态。
 * 无权真形态（403 说明卡在 DOM、新建不渲染）在 CredentialsPanel/r17，壳层钉 owner-type 传递。
 */
const mocks = vi.hoisted(() => ({
    query: {} as Record<string, unknown>,
    tabWs: null as string | null,
}));
vi.mock("vue-router", () => ({ useRoute: () => ({ query: mocks.query }) }));
vi.mock("../../../lib/workspaceContext", () => ({ readTabWorkspaceId: () => mocks.tabWs }));
vi.mock("../../../components/settings/InstanceCredentialsPanel.vue", () => ({
    default: {
        name: "InstanceCredentialsPanel",
        template: "<div data-testid='stub-cred-instance' />",
    },
}));
vi.mock("../../../components/settings/credentials/CredentialsPanel.vue", () => ({
    default: {
        name: "CredentialsPanel",
        props: ["ownerType"],
        template: "<div data-testid='stub-cred-panel' :data-owner='ownerType' />",
    },
}));
vi.mock("../../../components/resources/ResourceWorkspaceRequired.vue", () => ({
    default: {
        name: "ResourceWorkspaceRequired",
        template: "<div data-testid='stub-workspace-required' />",
    },
}));
function mountView(props: Record<string, unknown> = {}) {
    return mount(CredentialsResourceView, { props, global: { plugins: [i18n] } });
}
beforeEach(() => {
    mocks.query = {};
    mocks.tabWs = null;
});
describe("CredentialsResourceView — 层→面板 + owner-type", () => {
    it("INSTANCE → InstanceCredentialsPanel", () => {
        mocks.query = { layer: "INSTANCE" };
        expect(mountView().find('[data-testid="stub-cred-instance"]').exists()).toBe(true);
    });
    it("USER → CredentialsPanel owner-type=USER", () => {
        mocks.query = { layer: "USER" };
        expect(mountView().find('[data-testid="stub-cred-panel"]').attributes("data-owner")).toBe(
            "USER",
        );
    });
    it("缺省层 → USER（credentials 默认 USER，settingsIa:321）", () => {
        expect(mountView().find('[data-testid="stub-cred-panel"]').attributes("data-owner")).toBe(
            "USER",
        );
    });
    it("WORKSPACE + 有上下文 → CredentialsPanel owner-type=WORKSPACE", () => {
        mocks.query = { layer: "WORKSPACE" };
        mocks.tabWs = "ws-1";
        expect(mountView().find('[data-testid="stub-cred-panel"]').attributes("data-owner")).toBe(
            "WORKSPACE",
        );
    });
    it("WORKSPACE + 无上下文 → 诚实态门（不拿实例层冒充，承重：删门必红）", () => {
        mocks.query = { layer: "WORKSPACE" };
        mocks.tabWs = null;
        const w = mountView();
        expect(w.find('[data-testid="stub-workspace-required"]').exists()).toBe(true);
        expect(w.find('[data-testid="stub-cred-panel"]').exists()).toBe(false);
    });
    it("task-210：prop 钉层盖过 ?layer=", () => {
        mocks.query = { layer: "USER" };
        mocks.tabWs = null;
        const w = mountView({ layer: "WORKSPACE", workspaceId: "ws-prop" });
        expect(w.find('[data-testid="stub-cred-panel"]').attributes("data-owner")).toBe(
            "WORKSPACE",
        );
    });
});
