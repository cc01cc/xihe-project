import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { createPinia, setActivePinia } from "pinia";
import ConfigLayerPanels from "../ConfigLayerPanels.vue";
import { i18n } from "../../../i18n";
import { useConfigStore } from "../../../stores/config";

/**
 * task-285 判据 ② 的**后半句**（Lead 2026-11-13 裁定要的可算读数）：
 * 「不改 ⇒ 深度相等 ⇒ 返回 null ⇒ **不发 PUT 也不报「已保存」**」。
 *
 * <p>为什么只测「没发请求」不够：只做到不发请求、成功 toast 照弹，用户会看到「已保存」
 * 而实际一个字节都没变 —— 那是假信号，比报错更糟（报错至少可追）。所以两个读数必须同时为 0。
 *</p>
 *
 * <p>为什么必须有正例（第二个用例）：`expect(toast.success).not.toHaveBeenCalled()` 在
 * 「spy 根本没接上」「面板根本没挂载」时也会通过 —— **零触发通过是空断言**。正例证明这条
 * 通路真的会打请求、真的会弹提示，反例的 0 才有意义。</p>
 */
vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message?: unknown) => string | number>(),
        error: vi.fn<(message?: unknown) => string | number>(),
        warning: vi.fn<(message?: unknown) => string | number>(),
        info: vi.fn<(message?: unknown) => string | number>(),
    },
}));

const { toast } = await import("vue-sonner");

/** 带一个 catalog 没登记的键：这样「保存后它还在」也能在同一条用例里读到（判据 ④）。 */
const DEFAULTS_RAW = JSON.stringify(
    {
        softThresholdPct: 0.6,
        keepRecentMessages: 12,
        summaryProvider: "rule",
        legacyKnob: "keep-me",
    },
    null,
    2,
);
const MODELS_RAW = JSON.stringify({ "gpt-4o": { summaryTimeoutMs: 20000 } }, null, 2);

type FetchCall = { url: string; init: RequestInit | undefined };

function makeRouter() {
    return createRouter({
        history: createMemoryHistory(),
        routes: [{ path: "/settings/:layer/:domain", component: { template: "<div />" } }],
    });
}

async function mountContextPolicy() {
    const calls: FetchCall[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        calls.push({ url: typeof input === "string" ? input : input.url, init });
        return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    });
    const pinia = createPinia();
    setActivePinia(pinia);
    const config = useConfigStore();
    vi.spyOn(config, "loadLayerDomains").mockResolvedValue(undefined);
    // 只塞值、不走网络：本用例要读的是「保存动作产生什么」，不是加载链路。
    config.layerConfig.instance = {
        "context-policy": { defaults: DEFAULTS_RAW, models: MODELS_RAW },
    };
    const router = makeRouter();
    await router.push("/settings/instance/context-policy");
    await router.isReady();
    const wrapper = mount(ConfigLayerPanels, {
        props: { layer: "instance", domain: "context-policy" },
        global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();
    return { wrapper, calls };
}

async function clickSave(wrapper: Awaited<ReturnType<typeof mountContextPolicy>>["wrapper"]) {
    const label = i18n.global.t("common.save");
    const button = wrapper.findAll("button").find((item) => item.text() === label);
    expect(button, "找不到保存按钮（用 common.save 文案匹配）").toBeTruthy();
    await button!.trigger("click");
    await flushPromises();
}

/** 任何 PUT（不只目标 URL）—— URL 猜错时不会假绿。 */
function anyPut(calls: FetchCall[]): FetchCall[] {
    return calls.filter((call) => call.init?.method === "PUT");
}

function contextPolicyPut(calls: FetchCall[]): FetchCall[] {
    return calls.filter(
        (call) =>
            call.url.includes("/config/instance/context-policy") && call.init?.method === "PUT",
    );
}

describe("context-policy「不改就不写」的两个读数（task-285 判据 ②）", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.mocked(toast.success).mockClear();
        vi.mocked(toast.error).mockClear();
    });

    it("① 没改就点保存 ⇒ 0 个 PUT；② 且 0 次成功提示（不发请求也不报已保存）", async () => {
        const { wrapper, calls } = await mountContextPolicy();
        // 前置：13 个默认值字段真的渲染出来了，否则下面两个 0 是「什么都没挂上」的 0。
        expect(wrapper.findAll('[data-testid^="config-field-context-policy-"]').length).toBe(13);

        await clickSave(wrapper);

        expect(contextPolicyPut(calls)).toHaveLength(0);
        expect(anyPut(calls)).toHaveLength(0);
        expect(toast.success).toHaveBeenCalledTimes(0);
        expect(toast.error).toHaveBeenCalledTimes(0);
    });

    it("正例（证明上面两个 0 不是空断言）：改一个字段 ⇒ 1 个 PUT + 1 次成功提示", async () => {
        const { wrapper, calls } = await mountContextPolicy();
        const input = wrapper.find(
            '[data-testid="config-field-context-policy-defaults.keepRecentMessages"',
        );
        expect(input.exists()).toBe(true);
        await input.find("input").setValue("20");

        await clickSave(wrapper);

        expect(contextPolicyPut(calls)).toHaveLength(1);
        expect(toast.success).toHaveBeenCalledTimes(1);
    });

    it("保存形状：defaults 是 JSON 字符串，改的键变了、未登记键还在", async () => {
        const { wrapper, calls } = await mountContextPolicy();
        const input = wrapper.find(
            '[data-testid="config-field-context-policy-defaults.keepRecentMessages"',
        );
        await input.find("input").setValue("20");
        await clickSave(wrapper);

        const body = JSON.parse(String(contextPolicyPut(calls)[0]!.init!.body)) as Record<
            string,
            string
        >;
        expect(Object.keys(body)).toEqual(["defaults"]);
        const stored = JSON.parse(body.defaults as string) as Record<string, unknown>;
        expect(stored.keepRecentMessages).toBe(20);
        expect(stored.legacyKnob).toBe("keep-me");
    });
});
