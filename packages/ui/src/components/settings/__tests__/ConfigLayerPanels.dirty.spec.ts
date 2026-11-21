import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ConfigLayerPanels from "../ConfigLayerPanels.vue";
import { i18n } from "../../../i18n";
import { useConfigStore } from "../../../stores/config";

/**
 * task-26：五个**专用面板**（ProviderHub / AgentTemplatesPanel / ContextTemplatesPanel /
 * EmbeddingSettingsPanel / ContextModelOverrides）的脏状态必须汇进 task-190 J1 的**同一张**
 * 聚合表（\`ConfigLayerPanels.draftDomains\`），再经 \`dirty-change\` 喂给路由离开守卫。
 *
 * 为什么本 spec 用 stub 而不是真面板：这里要锁的是**接线**（面板 emit 的 dirty 有没有进表、
 * 只读层有没有被挡），面板各自的脏判据由各自的 \`*.dirty\` 例覆盖；真挂五个面板会把
 * 五个域的网络/状态一起拖进来，接线错了也未必报红。
 */
const DIRTY_PANELS = [
    { domain: "llm-provider", name: "ProviderHub" },
    { domain: "agent-templates", name: "AgentTemplatesPanel" },
    { domain: "api-request-templates", name: "ContextTemplatesPanel" },
    { domain: "embedding", name: "EmbeddingSettingsPanel" },
    { domain: "context-policy", name: "ContextModelOverrides" },
] as const;

function panelStub(name: string) {
    return defineComponent({
        name,
        props: {
            layer: { type: String, default: "" },
            readonly: { type: Boolean, default: false },
            saving: { type: Boolean, default: false },
        },
        emits: ["dirty", "save"],
        template: `<div data-testid="stub-${name}" />`,
    });
}

const DomainPanelStub = defineComponent({
    name: "ConfigDomainPanel",
    props: {
        domain: { type: String, required: true },
        title: { type: String, default: "" },
        entries: { type: Object, default: () => ({}) },
        summary: { type: String, default: "" },
        schema: { type: Array, default: () => [] },
        layer: { type: String, required: true },
        readonly: { type: Boolean, default: false },
    },
    emits: ["save", "reset", "dirty"],
    template: '<div data-testid="domain-panel-stub" />',
});

const stubs = {
    ProviderHub: panelStub("ProviderHub"),
    AgentTemplatesPanel: panelStub("AgentTemplatesPanel"),
    ContextTemplatesPanel: panelStub("ContextTemplatesPanel"),
    EmbeddingSettingsPanel: panelStub("EmbeddingSettingsPanel"),
    ContextModelOverrides: panelStub("ContextModelOverrides"),
    ConfigDomainPanel: DomainPanelStub,
    ConfigSourceSummary: true,
};

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message?: unknown) => string | number>(),
        error: vi.fn<(message?: unknown) => string | number>(),
        warning: vi.fn<(message?: unknown) => string | number>(),
        info: vi.fn<(message?: unknown) => string | number>(),
    },
}));

async function mountPanel(options: {
    domain: string;
    layer?: "instance" | "user";
    readonly?: boolean;
}) {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("provider-catalog")) {
            return Promise.resolve(
                new Response(JSON.stringify({ catalogRevision: "v3", providers: [] }), {
                    status: 200,
                }),
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
        props: {
            layer: options.layer ?? "instance",
            domain: options.domain,
            readonly: options.readonly ?? false,
        },
        global: { plugins: [pinia, i18n], stubs },
    });
    await flushPromises();
    return wrapper;
}

function lastDirtyChange(wrapper: ReturnType<typeof mount>) {
    const events = wrapper.emitted("dirty-change") ?? [];
    return events.at(-1)?.[0] as { count: number; labels: string[] } | undefined;
}

describe("ConfigLayerPanels 专用面板 dirty 接线（task-26）", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    for (const { domain, name } of DIRTY_PANELS) {
        it(`${domain} 面板报脏 ⇒ dirty-change 点名该域（${name}）`, async () => {
            const wrapper = await mountPanel({ domain });
            expect(lastDirtyChange(wrapper)).toEqual({ count: 0, labels: [] });
            wrapper.findComponent(stubs[name as keyof typeof stubs]).vm.$emit("dirty", true);
            await flushPromises();
            const payload = lastDirtyChange(wrapper);
            expect(payload?.count).toBe(1);
            expect(payload?.labels).toHaveLength(1);
        });
    }

    it("面板撤销改动（dirty=false）⇒ 聚合表回落，不会留一个幽灵域", async () => {
        const wrapper = await mountPanel({ domain: "llm-provider" });
        wrapper.findComponent(stubs.ProviderHub).vm.$emit("dirty", true);
        await flushPromises();
        expect(lastDirtyChange(wrapper)?.count).toBe(1);
        wrapper.findComponent(stubs.ProviderHub).vm.$emit("dirty", false);
        await flushPromises();
        expect(lastDirtyChange(wrapper)).toEqual({ count: 0, labels: [] });
    });

    it("只读层：面板即使报脏也不进聚合表（用户改不动就没人拦他离开）", async () => {
        const wrapper = await mountPanel({ domain: "llm-provider", readonly: true });
        wrapper.findComponent(stubs.ProviderHub).vm.$emit("dirty", true);
        await flushPromises();
        expect(lastDirtyChange(wrapper)).toEqual({ count: 0, labels: [] });
    });
});
