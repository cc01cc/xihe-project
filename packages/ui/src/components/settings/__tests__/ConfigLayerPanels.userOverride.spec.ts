import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ConfigLayerPanels from "../ConfigLayerPanels.vue";
import { i18n } from "../../../i18n";
import { useConfigStore } from "../../../stores/config";

/**
 * task-31 接线面：实例层的「个人覆盖」徽标**数据从哪来**。
 *
 * 面板自己的派生规则见 ConfigDomainPanel.userOverride.spec.ts；这里只锁一件事 ——
 * 父组件确实把「当前查看者 user 层的同域条目」传下去了，且三种失配都不传（undefined）。
 * 缺这条，面板会永远拿到 undefined、徽标永远是死的（本 spec 就是抓这个）。
 */
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
        userEntries: { type: Object, required: false, default: undefined },
    },
    emits: ["save", "reset"],
    template: `<div data-testid="domain-panel-stub" />`,
});

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message?: unknown) => string | number>(),
        error: vi.fn<(message?: unknown) => string | number>(),
        warning: vi.fn<(message?: unknown) => string | number>(),
        info: vi.fn<(message?: unknown) => string | number>(),
    },
}));

async function mountPanels(
    layer: "instance" | "user",
    options: { userEntries?: Record<string, string>; reject?: boolean } = {},
) {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ providers: [] }), { status: 200 })),
    );
    const pinia = createPinia();
    setActivePinia(pinia);
    const config = useConfigStore();
    vi.spyOn(config, "fetchModels").mockResolvedValue(undefined);
    const loadLayerDomains = vi
        .spyOn(config, "loadLayerDomains")
        .mockImplementation(async (target: string) => {
            if (target === "user") {
                if (options.reject) throw new Error("user layer 503");
                if (options.userEntries) config.layerConfig.user["rag"] = options.userEntries;
            }
        });
    const wrapper = mount(ConfigLayerPanels, {
        props: { layer, domain: "rag" },
        global: {
            plugins: [pinia, i18n],
            stubs: { ConfigDomainPanel: DomainPanelStub, ConfigSourceSummary: true },
        },
    });
    await flushPromises();
    return { wrapper, loadLayerDomains };
}

function panelProps(wrapper: Awaited<ReturnType<typeof mountPanels>>["wrapper"]) {
    return wrapper.findComponent(DomainPanelStub).props("userEntries") as
        | Record<string, string>
        | undefined;
}

describe("ConfigLayerPanels 把 user 层条目下发给实例层（task-31 接线）", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("实例层：拉一次 user 层，并传出同域条目", async () => {
        const { wrapper, loadLayerDomains } = await mountPanels("instance", {
            userEntries: { topK: "7" },
        });
        expect(loadLayerDomains).toHaveBeenCalledWith("user");
        expect(panelProps(wrapper)).toEqual({ topK: "7" });
    });

    it("用户层：不拉 user 层（自己看自己无覆盖可言），也不传条目", async () => {
        const { wrapper, loadLayerDomains } = await mountPanels("user", {
            userEntries: { topK: "7" },
        });
        expect(loadLayerDomains).not.toHaveBeenCalled();
        expect(panelProps(wrapper)).toBeUndefined();
    });

    it("user 层拉取失败：不抛、且不传条目（未知 ≠ 没有覆盖）", async () => {
        const { wrapper } = await mountPanels("instance", { reject: true });
        expect(panelProps(wrapper)).toBeUndefined();
    });
});
