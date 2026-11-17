import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ConfigLayerPanels from "../ConfigLayerPanels.vue";
import { i18n } from "../../../i18n";
import { useConfigStore } from "../../../stores/config";

/**
 * task-284（D-1140）：llm-provider 域的层分派 —— 实例层与个人层挂**同一个** `ProviderHub`，
 * 只由 `layer`（写哪层配置）与 `scope`（连接归属）两个 prop 区分。
 *
 * 历史：task-150 起实例层挂的是 `LlmDefaultProfilePanel`（3 字段：provider / 连接槽位 / 模型），
 * 用户层挂 ProviderHub —— 那个「两份外观相似的实现」正是 D-1140 判定的缺陷原始形态。本 spec 锁两件事：
 * ① 两层都用 ProviderHub，且 layer/scope 逐层正确；② 旧 3 字段面板**不再**出现在任何一层。
 */
const LlmDefaultPanelStub = defineComponent({
    name: "LlmDefaultProfilePanel",
    props: {
        layer: { type: String, required: true },
        readonly: { type: Boolean, default: false },
    },
    emits: ["saved"],
    template: '<div data-testid="llm-default-panel-stub" />',
});

const ProviderHubStub = defineComponent({
    name: "ProviderHub",
    props: {
        scope: { type: String, required: true },
        layer: { type: String, default: "user" },
        readonly: { type: Boolean, default: false },
    },
    template: '<div data-testid="provider-hub-stub" />',
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

async function mountLlm(layer: "instance" | "user") {
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
        props: { layer, domain: "llm-provider" },
        global: {
            plugins: [pinia, i18n],
            stubs: {
                LlmDefaultProfilePanel: LlmDefaultPanelStub,
                ProviderHub: ProviderHubStub,
                ConfigDomainPanel: DomainPanelStub,
                ConfigSourceSummary: true,
            },
        },
    });
    await flushPromises();
    return wrapper;
}

describe("ConfigLayerPanels llm-provider 域分派（task-284 / D-1140）", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("instance 层渲染 ProviderHub(layer=instance, scope=INSTANCE)", async () => {
        const wrapper = await mountLlm("instance");
        expect(wrapper.findComponent(ProviderHubStub).exists()).toBe(true);
        expect(wrapper.findComponent(ProviderHubStub).props("layer")).toBe("instance");
        expect(wrapper.findComponent(ProviderHubStub).props("scope")).toBe("INSTANCE");
        // 旧 3 字段面板不再挂载（文件保留，删它另立步）。
        expect(wrapper.findComponent(LlmDefaultPanelStub).exists()).toBe(false);
        expect(wrapper.findComponent(DomainPanelStub).exists()).toBe(false);
        // 「前往个人层管理连接」入口随同构撤掉：实例层自己就有连接管理。
        expect(wrapper.find("[data-testid='provider-instance-go-user']").exists()).toBe(false);
        // task-157：连接管理页没有行内字段 ⇒ 次量纲 M=0（两层同一口径）。
        expect(wrapper.emitted("editable-count")?.at(-1)).toEqual([0]);
    });

    it("user 层渲染同一个 ProviderHub(layer=user, scope=USER)，行为不变", async () => {
        const wrapper = await mountLlm("user");
        expect(wrapper.findComponent(ProviderHubStub).exists()).toBe(true);
        expect(wrapper.findComponent(ProviderHubStub).props("layer")).toBe("user");
        expect(wrapper.findComponent(ProviderHubStub).props("scope")).toBe("USER");
        expect(wrapper.findComponent(LlmDefaultPanelStub).exists()).toBe(false);
        // task-157：连接管理页没有行内字段 ⇒ 次量纲 M=0（不显示），不与「字段」口径混。
        expect(wrapper.emitted("editable-count")?.at(-1)).toEqual([0]);
    });

    // task-227 ⑨ 类 H-04：分区卡不再是手搓 `border rounded-lg` + 灰头 div + 自造 h3，
    // 改用 vendor `Card` 族。判据锚 vendor 的 data-slot 契约（换件/退回手搓都会红），
    // 并钉住「换容器不许把标题语义降级」——`CardTitle` 只渲染 div，里层 h3 必须还在。
    it("H-04: provider-partition 是 vendor Card 族，标题语义仍是 h3", async () => {
        const wrapper = await mountLlm("instance");
        const card = wrapper.get('[data-testid="provider-partition"]');
        expect(card.attributes("data-slot")).toBe("card");
        expect(card.find('[data-slot="card-header"]').exists()).toBe(true);
        expect(card.find('[data-slot="card-title"]').exists()).toBe(true);
        expect(card.find('[data-slot="card-content"]').exists()).toBe(true);
        // 手搓痕迹清零：修前这里是 `border rounded-lg` + bg-muted/30 的裸 div
        expect(card.classes()).not.toContain("border");
        const title = card.get('[data-testid="provider-hub-section-title"]');
        expect(title.element.tagName).toBe("H3");
        expect(title.text().length).toBeGreaterThan(0);
        // 换壳不改内容：ProviderHub 仍在卡体里
        expect(card.find('[data-testid="provider-hub-stub"]').exists()).toBe(true);
    });
});
