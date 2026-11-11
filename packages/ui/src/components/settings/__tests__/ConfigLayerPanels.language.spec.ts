import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { toast } from "vue-sonner";
import ConfigLayerPanels from "../ConfigLayerPanels.vue";
import { i18n } from "../../../i18n";
import { useConfigStore } from "../../../stores/config";
import { useSettingsStore } from "../../../stores/settings";
import { DOMAIN_LABEL_KEY } from "../../../lib/settingsIa";
import { applyLocale } from "../../../i18n/locale";

/**
 * task-125（D-899，方案 B）ConfigLayerPanels 的三处拦截：
 *   1. handleSave 把 user-preference.language 从 CP payload 剥离，走 settings.setLanguage；
 *   2. 剥离后 payload 为空 ⇒ 跳过 putLayerConfig（空 PUT 有清库语义风险）；
 *   3. handleReset("language") = setLanguage(DEFAULT_LOCALE)，不写 CP；
 *   以及 entriesFor 薄皮肤：面板显示的 language = settings.language（不从 CP 读）。
 *
 * ConfigDomainPanel 用桩替代：reka Select 的下拉交互 jsdom 覆盖不了
 * （AGENTS：交互行为用 Playwright 验证），本 spec 只锁父组件的拦截逻辑，
 * 桩的 props/emits 与真组件同契约（save/reset 事件 + entries 入参）。
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

/** provider catalog / models / layer 域装载的最小应答。 */
function mockFetch() {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("provider-catalog")) {
            return Promise.resolve(
                new Response(JSON.stringify({ providers: [] }), { status: 200 }),
            );
        }
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });
}

async function mountPanels() {
    const pinia = createPinia();
    setActivePinia(pinia);
    const config = useConfigStore(),
        settings = useSettingsStore();
    const putSpy = vi.spyOn(config, "putLayerConfig").mockResolvedValue(undefined);
    vi.spyOn(config, "loadLayerDomains").mockResolvedValue(undefined);
    const wrapper = mount(ConfigLayerPanels, {
        props: { layer: "user", domain: "user-preference" },
        global: {
            plugins: [pinia, i18n],
            stubs: {
                ConfigDomainPanel: DomainPanelStub,
                ConfigSourceSummary: true,
            },
        },
    });
    await flushPromises();
    return { wrapper, config, settings, putSpy };
}

describe("ConfigLayerPanels user-preference.language（task-125 方案 B）", () => {
    beforeEach(() => {
        localStorage.clear();
        mockFetch();
    });

    it("save：language 从 CP payload 剥离并走 setLanguage，其余键照常 PUT", async () => {
        const { wrapper, settings, putSpy } = await mountPanels();
        expect(settings.language).toBe("zh-CN");

        wrapper.findComponent(DomainPanelStub).vm.$emit("save", {
            language: "en-US",
            theme: "dark",
        });
        await flushPromises();

        expect(settings.language).toBe("en-US");
        expect(i18n.global.locale.value).toBe("en-US");
        expect(localStorage.getItem("xihe-language")).toBe("en-US");
        expect(putSpy).toHaveBeenCalledTimes(1);
        const [, , body] = putSpy.mock.calls[0]!;
        expect(body).toEqual({ theme: "dark" });
        expect("language" in body).toBe(false);
    });

    it("save：剥离后 payload 为空 ⇒ 跳过 putLayerConfig（空 PUT 有清库语义风险）", async () => {
        const { wrapper, settings, putSpy } = await mountPanels();

        wrapper.findComponent(DomainPanelStub).vm.$emit("save", { language: "en-US" });
        await flushPromises();

        expect(settings.language).toBe("en-US");
        expect(putSpy).not.toHaveBeenCalled();
    });

    it("reset：language 重置 = setLanguage(DEFAULT_LOCALE)，不写 CP", async () => {
        const { wrapper, settings, putSpy } = await mountPanels();
        settings.setLanguage("en-US");

        wrapper.findComponent(DomainPanelStub).vm.$emit("reset", "language");
        await flushPromises();

        expect(settings.language).toBe("zh-CN");
        expect(putSpy).not.toHaveBeenCalled();
    });

    it("entriesFor 薄皮肤：面板显示的 language 取 settings.language，不从 CP entries", async () => {
        const { wrapper, settings } = await mountPanels();
        settings.setLanguage("en-US");
        await flushPromises();
        await wrapper.vm.$nextTick();

        const { entries } = wrapper.findComponent(DomainPanelStub).props();
        expect((entries as Record<string, string>).language).toBe("en-US");
    });
});

// ---------------------------------------------------------------------------
// task-47：域名词条必须在**渲染/调用时**求值（原 setup 期 `const domainLabels = { … t(…) }`
// 一次求值 ⇒ 切语言后 toast 出现「用户偏好 Saved」这种混合文案）。
// 期望值一律由 `DOMAIN_LABEL_KEY`（唯一 key 表）+ locale message 现算，**不写死任何文案**。
// ---------------------------------------------------------------------------

/** 直接从某个 locale 的 message 树取原串（不经全局 locale）。 */
function labelIn(locale: string, key: string): string {
    const messages = i18n.global.getLocaleMessage(locale) as Record<string, unknown>;
    const value = key
        .split(".")
        .reduce<unknown>(
            (acc, part) => (acc as Record<string, unknown> | undefined)?.[part],
            messages,
        );
    return typeof value === "string" ? value : "";
}

function expectedSaveToast(locale: "zh-CN" | "en-US"): string {
    return `${labelIn(locale, DOMAIN_LABEL_KEY["user-preference"])} ${labelIn(locale, "common.saved")}`;
}

/** CJK（含扩展 A 与兼容区）：英文界面里出现任何一条就算混语言。 */
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
/** 拉丁字母：中文界面里出现域名词条算混语言（「已保存」等中文文案本身不含拉丁字母）。 */
const LATIN = /[A-Za-z]/;

describe("ConfigLayerPanels 域名文案随语言重算（task-47）", () => {
    beforeEach(() => {
        localStorage.clear();
        mockFetch();
        // 同一文件的其它用例会把全局 locale 切到 en-US 且不回滚（i18n 是模块级单例）
        // ⇒ 本组每条都从明确的语言起点开始；用产品唯一入口 `applyLocale`，不手写 `i18n.global.locale`。
        applyLocale("zh-CN");
    });

    it("中文界面保存 ⇒ toast 用中文域名，且不含拉丁域名词", async () => {
        const { wrapper } = await mountPanels();

        wrapper.findComponent(DomainPanelStub).vm.$emit("save", { theme: "dark" });
        await flushPromises();

        const message = vi.mocked(toast.success).mock.calls.at(-1)?.[0];
        expect(typeof message).toBe("string");
        expect(message).toBe(expectedSaveToast("zh-CN"));
        expect(String(message)).not.toMatch(LATIN);
    });

    it("切到英文后保存 ⇒ toast 不得含中文字符，且等于英文域名文案（反向断言）", async () => {
        const { wrapper, settings } = await mountPanels();

        settings.setLanguage("en-US");
        await flushPromises();

        wrapper.findComponent(DomainPanelStub).vm.$emit("save", { theme: "dark" });
        await flushPromises();

        const message = String(vi.mocked(toast.success).mock.calls.at(-1)?.[0] ?? "");
        expect(message).toBe(expectedSaveToast("en-US"));
        // 本卡的价值：切语言后**不得**再看到中文域名（原缺陷是「用户偏好 Saved」）
        expect(message).not.toMatch(CJK);
    });

    it("面板 title（域名）随语言重算：切到英文后不再用 setup 期算出的中文名", async () => {
        const { wrapper, settings } = await mountPanels();

        expect(wrapper.findComponent(DomainPanelStub).props().title).toBe(
            labelIn("zh-CN", DOMAIN_LABEL_KEY["user-preference"]),
        );

        settings.setLanguage("en-US");
        await flushPromises();
        await wrapper.vm.$nextTick();

        expect(wrapper.findComponent(DomainPanelStub).props().title).toBe(
            labelIn("en-US", DOMAIN_LABEL_KEY["user-preference"]),
        );
    });

    it("英文界面整块面板可见文本不含中文字符（域名词条是唯一入口）", async () => {
        const { wrapper, settings } = await mountPanels();

        settings.setLanguage("en-US");
        await flushPromises();
        await wrapper.vm.$nextTick();

        const rendered = wrapper.text();
        expect(rendered).not.toMatch(CJK);
    });
});
