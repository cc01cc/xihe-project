import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

import { i18n } from "../../../i18n";
import AgentModelBindingFields from "../AgentModelBindingFields.vue";

/**
 * task-138：白名单行复用本组件时隐藏 restrict 开关（`hideRestrict`）。
 *
 * <p>白名单本身就是「只允许这些模型」的限制；再叠一个「只允许这个模型」的复选会让用户
 * 以为有两层限制。默认 false ⇒ InstanceAgentsPanel 的创建/编辑两处行为一字不变。</p>
 */

const configState = vi.hoisted(() => ({
    providerConnections: [] as Array<Record<string, unknown>>,
    providerConnectionsError: false,
    modelError: null as string | null,
    modelCache: { providers: {} as Record<string, unknown> },
    loadProviderConnections: vi.fn<() => Promise<void>>(async () => {}),
    fetchModels: vi.fn<() => Promise<void>>(async () => {}),
}));

vi.mock("../../../stores/config", () => ({
    useConfigStore: () => configState,
}));

vi.mock("../../../services/providerConnectionService", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        listProviderCatalog: vi.fn<() => Promise<{ providers: unknown[] }>>(async () => ({
            providers: [],
        })),
    };
});

function mountFields(props: Record<string, unknown> = {}) {
    return mount(AgentModelBindingFields, {
        props: {
            modelValue: {
                provider: "anthropic",
                connectionId: "conn-anthropic",
                model: "claude-x",
                restrict: true,
            },
            fieldPrefix: "wlf",
            ...props,
        } as never,
        global: { plugins: [i18n] },
        attachTo: document.body,
    });
}

beforeEach(() => {
    document.body.innerHTML = "";
    configState.providerConnections = [
        {
            id: "conn-anthropic",
            providerId: "anthropic",
            connectionKey: "anthropic-main",
            operation: "chat",
            label: "Claude 主连接",
            enabled: true,
        },
    ];
    configState.modelCache = {
        providers: {
            "conn-anthropic": {
                providerId: "anthropic",
                connectionId: "conn-anthropic",
                status: "ready",
                models: [{ name: "claude-x", capabilities: { chat: true } }],
            },
        },
    };
});

describe("AgentModelBindingFields · hideRestrict", () => {
    it("默认（false）照旧渲染 restrict 复选框", async () => {
        mountFields();
        await flushPromises();

        expect(document.body.querySelector('[data-testid="wlf-restrict"]')).not.toBeNull();
        expect(document.body.querySelector('[data-testid="wlf-restrict-label"]')).not.toBeNull();
    });

    it("hideRestrict=true 时不渲染 restrict 复选框与它的标签", async () => {
        mountFields({ hideRestrict: true });
        await flushPromises();

        expect(document.body.querySelector('[data-testid="wlf-restrict"]')).toBeNull();
        expect(document.body.querySelector('[data-testid="wlf-restrict-label"]')).toBeNull();
        // 三段选择器照旧在（只隐开关，不隐组件主体）。
        expect(document.body.querySelector('[data-testid="wlf-provider"]')).not.toBeNull();
        expect(document.body.querySelector('[data-testid="wlf-model-name"]')).not.toBeNull();
    });
});

/**
 * task-138 J3：存量「裸 provider+model」（没有任何 chat 连接可映射）只警示、不清空、不自动改写。
 * 半填仍是错误 —— 区分点是「是否与 intent 完全一致」。
 */
describe("AgentModelBindingFields · 存量裸意图", () => {
    const legacy = {
        provider: "google",
        connectionId: "",
        model: "gemini-2.0-flash",
        restrict: false,
    };
    const legacyIntent = { provider: "google", model: "gemini-2.0-flash" };

    it("与 intent 一致的裸对不报半填，且三段都把原值显示出来", async () => {
        mountFields({ modelValue: legacy, intent: legacyIntent });
        await flushPromises();

        expect(document.body.querySelector('[data-testid$="-incomplete"]')).toBeNull();
        const text = document.body.textContent ?? "";
        expect(text).toContain("google");
        expect(text).toContain("gemini-2.0-flash");
    });

    it("没有 intent 可对照时，同样的裸对仍按半填报错", async () => {
        mountFields({ modelValue: legacy });
        await flushPromises();
        expect(document.body.querySelector('[data-testid$="-incomplete"]')).not.toBeNull();
    });

    it("intent 对不上（用户刚换了 provider）时仍按半填报错", async () => {
        mountFields({
            modelValue: { ...legacy, provider: "anthropic" },
            intent: legacyIntent,
        });
        await flushPromises();

        expect(document.body.querySelector('[data-testid$="-incomplete"]')).not.toBeNull();
    });
});
