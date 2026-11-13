import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ConfigLayerPanels from "../ConfigLayerPanels.vue";
import { i18n } from "../../../i18n";
import { useConfigStore } from "../../../stores/config";

/**
 * PLAN-0764 T1.5：embedding 域的层分派。
 * 旧实现：实例层走通用 ConfigDomainPanel（model/dimensions 两键）⇒ CP 拒收（必 400）；
 * 新实现：实例层/用户层都走 EmbeddingSettingsPanel（profile 单元）。本 spec 只锁分派，
 * panel 自身行为由 EmbeddingSettingsPanel.spec.ts 与 services/__tests__/embeddingProfile.spec.ts 覆盖。
 */
const EmbeddingPanelStub = defineComponent({
    name: "EmbeddingSettingsPanel",
    props: {
        layer: { type: String, required: true },
        saving: { type: Boolean, default: false },
        readonly: { type: Boolean, default: false },
    },
    emits: ["saved"],
    template: '<div data-testid="embedding-panel-stub" />',
});

const DomainPanelStub = defineComponent({
    name: "ConfigDomainPanel",
    props: {
        domain: { type: String, required: true },
        title: { type: String, required: true },
        entries: { type: Object, required: true },
        summary: { type: String, default: "" },
        schema: { type: Array, required: true },
        envLocked: { type: Object, default: () => ({}) },
        meta: { type: Object, default: () => ({}) },
        layer: { type: String, required: true },
        readonly: { type: Boolean, default: false },
    },
    emits: ["save", "reset"],
    template: '<div data-testid="domain-panel-stub" />',
});

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message?: unknown) => string | number>(),
        error: vi.fn<(message?: unknown) => string | number>(),
        warning: vi.fn<(message?: unknown) => string | number>(),
        info: vi.fn<(message?: unknown) => string | number>(),
    },
}));

async function mountEmbedding(layer: "instance" | "user" | "workspace" | "workspace-default") {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("provider-catalog")) {
            return Promise.resolve(
                new Response(JSON.stringify({ providers: [] }), { status: 200 }),
            );
        }
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });
    const pinia = createPinia();
    setActivePinia(pinia);
    const config = useConfigStore();
    vi.spyOn(config, "fetchModels").mockResolvedValue(undefined);
    vi.spyOn(config, "loadLayerDomains").mockResolvedValue(undefined);
    const wrapper = mount(ConfigLayerPanels, {
        props: { layer, domain: "embedding" },
        global: {
            plugins: [pinia, i18n],
            stubs: {
                EmbeddingSettingsPanel: EmbeddingPanelStub,
                ConfigDomainPanel: DomainPanelStub,
                ConfigSourceSummary: true,
            },
        },
    });
    await flushPromises();
    return wrapper;
}

describe("ConfigLayerPanels embedding 域分派（PLAN-0764 T1.5）", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("instance 层渲染 EmbeddingSettingsPanel(layer=instance)，不再是通用表单", async () => {
        const wrapper = await mountEmbedding("instance");
        const panel = wrapper.findComponent(EmbeddingPanelStub);
        expect(panel.exists()).toBe(true);
        expect(panel.props("layer")).toBe("instance");
        expect(wrapper.findComponent(DomainPanelStub).exists()).toBe(false);
    });

    it("user 层仍渲染 EmbeddingSettingsPanel(layer=user)", async () => {
        const wrapper = await mountEmbedding("user");
        const panel = wrapper.findComponent(EmbeddingPanelStub);
        expect(panel.exists()).toBe(true);
        expect(panel.props("layer")).toBe("user");
        expect(wrapper.findComponent(DomainPanelStub).exists()).toBe(false);
    });

    /**
     * D-1122 49A / PLAN-0766 T2.4（2026-11-13）：embedding 退出工作区层 ⇒ 那两层**一个写入口都不许画**。
     *
     * <p>为什么必须另立一条而不是"信矩阵"：矩阵保证**路由不注册**，但不保证组件在被人直挂时不出入口
     * （D-1122 的验收就是「路由不注册」与「菜单不出现」分开断，这里同理再加第三条「组件不出写入口」）。
     * 关键否定是**不许落回通用 ConfigDomainPanel** —— 那会画出 CP 必 400 的 model/dimensions 两键，
     * 正是 PLAN-0764 修掉的错配；只断"没有专用面板"会让这个回退通道静默通过。</p>
     */
    it.each(["workspace", "workspace-default"] as const)(
        "%s 层不渲染任何 embedding 写入口（专用面板与通用表单都不画）",
        async (layer) => {
            const wrapper = await mountEmbedding(layer);
            expect(wrapper.findComponent(EmbeddingPanelStub).exists()).toBe(false);
            expect(wrapper.findComponent(DomainPanelStub).exists()).toBe(false);
            expect(wrapper.find('[data-testid="embedding-settings"]').exists()).toBe(false);
            // 可编辑字段数同样为 0：徽标不得出现"1 项可编辑"而实际一个控件都没有。
            const counts = wrapper.emitted("editable-count") ?? [];
            expect(counts.at(-1)).toEqual([0]);
        },
    );

    it("instance / user 层的可编辑字段数仍是 1（不是把 embedding 一律记 0）", async () => {
        for (const layer of ["instance", "user"] as const) {
            const wrapper = await mountEmbedding(layer);
            const counts = wrapper.emitted("editable-count") ?? [];
            expect(counts.at(-1)).toEqual([1]);
        }
    });
});
