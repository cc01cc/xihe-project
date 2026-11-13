import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import LlmDefaultProfilePanel from "../LlmDefaultProfilePanel.vue";
import type { ProviderConnection } from "../../../types/providerConnection";
import {
    listApiInputTypes,
    listProviderCatalog,
    listProviderConnections,
} from "../../../services/providerConnectionService";
import { useConfigStore } from "../../../stores/config";
import { setOnlySelectValue } from "../../../test-utils/select";

vi.mock("../../../services/providerConnectionService", () => ({
    listProviderCatalog:
        vi.fn<typeof import("../../../services/providerConnectionService").listProviderCatalog>(),
    listApiInputTypes:
        vi.fn<typeof import("../../../services/providerConnectionService").listApiInputTypes>(),
    listProviderConnections:
        vi.fn<
            typeof import("../../../services/providerConnectionService").listProviderConnections
        >(),
}));
vi.mock("../../../lib/logger", () => ({
    logger: { warn: vi.fn<(...args: unknown[]) => void>() },
}));
vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message: string) => void>(),
        error: vi.fn<(message: string) => void>(),
    },
}));
vi.mock("vue-i18n", () => ({
    // task-288：带插值参数时把参数拼进返回值，否则「另有 {count} 个」这类文案的 N
    // 在断言里根本看不见（只返回 key 就等于把该参数从测试面上删掉了）。
    useI18n: () => ({
        t: (key: string, params?: Record<string, unknown>) =>
            params ? `${key}:${JSON.stringify(params)}` : key,
    }),
}));

import { toast } from "vue-sonner";

const mockedCatalog = vi.mocked(listProviderCatalog);
const mockedInputTypes = vi.mocked(listApiInputTypes);
const mockedConnections = vi.mocked(listProviderConnections);

function connection(overrides: Partial<ProviderConnection>): ProviderConnection {
    return {
        id: "conn-claude",
        providerId: "anthropic",
        connectionKey: "default",
        apiTypeId: "anthropic-messages",
        apiTypeVersion: 1,
        operation: "chat",
        label: "Claude",
        scope: "USER",
        modelDiscovery: "manual",
        manualModels: ["claude-sonnet-4-5"],
        hasKey: true,
        enabled: true,
        status: "READY",
        revision: 1,
        ...overrides,
    };
}

const catalogProvider = {
    id: "anthropic",
    displayName: "Anthropic",
    supportedApiTypes: [{ apiTypeId: "anthropic-messages", version: 1 }],
    defaultApiType: { apiTypeId: "anthropic-messages", version: 1 },
} as never;

let pinia: ReturnType<typeof createPinia>;

function mountPanel(layer: "instance" | "user") {
    const wrapper = mount(LlmDefaultProfilePanel, {
        props: { layer },
        global: { plugins: [pinia] },
    });
    return wrapper;
}

beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.clearAllMocks();
    mockedCatalog.mockResolvedValue({ catalogRevision: "r1", providers: [catalogProvider] });
    mockedInputTypes.mockResolvedValue({
        types: [
            {
                apiTypeId: "anthropic-messages",
                version: 1,
                operation: "chat",
                method: "POST",
                path: "/v1/messages",
                requestShape: "messages",
                responseShape: "messages",
                streamShape: "sse",
            },
        ],
    } as never);
    mockedConnections.mockResolvedValue({ connections: [connection({})] } as never);
});

function seedStore(options: { profile?: string; models?: unknown } = {}) {
    const store = useConfigStore();
    vi.spyOn(store, "loadProviderConnections").mockResolvedValue(undefined);
    vi.spyOn(store, "fetchModels").mockResolvedValue(undefined);
    vi.spyOn(store, "loadLayerDomains").mockResolvedValue(undefined);
    store.layerConfig.instance = {
        "llm-provider": options.profile ? { profile: options.profile } : {},
    };
    store.providerConnections = [connection({})];
    store.modelCache = {
        models: {},
        providers: {
            "conn-claude": {
                providerId: "anthropic",
                status: "ready",
                models: [{ name: "claude-sonnet-4-5", capabilities: { chat: true } }],
            },
        },
        lastFetched: 1,
    } as never;
    return store;
}

describe("LlmDefaultProfilePanel（PLAN-0764 T1.6）", () => {
    it("实例层只渲染偏好：提供方/模型/连接槽，没有连接列表", async () => {
        seedStore();
        const wrapper = mountPanel("instance");
        await flushPromises();
        expect(wrapper.find("[data-testid='llm-instance-default']").exists()).toBe(true);
        expect(wrapper.find("[data-testid='llm-instance-provider']").exists()).toBe(true);
        expect(wrapper.find("[data-testid='llm-instance-model']").exists()).toBe(true);
        expect(wrapper.find("[data-testid='llm-instance-connection-key']").exists()).toBe(true);
        // 实例层不搬连接：没有 ProviderHub 的连接列表/新建入口。
        expect(wrapper.text()).not.toContain("provider-connections");
        expect(wrapper.find("[data-testid='llm-instance-note']").text()).toContain(
            "settings.providerInstanceNote",
        );
    });

    it("保存 payload 形状 = CP 收的整组 profile 单元（三层键）", async () => {
        const store = seedStore();
        const put = vi.spyOn(store, "putLayerConfig").mockResolvedValue(undefined);
        const wrapper = mountPanel("instance");
        await flushPromises();
        // provider 目录 + 模型目录都来自 mock；模型输入框手填目录外的值也允许。
        await setOnlySelectValue(wrapper, "anthropic");
        await wrapper.find("[data-testid='llm-instance-model']").setValue("claude-sonnet-4-5");
        await wrapper.find("[data-testid='llm-instance-connection-key']").setValue("default");
        await wrapper.find("[data-testid='llm-instance-save']").trigger("click");
        await flushPromises();
        expect(put).toHaveBeenCalledTimes(1);
        expect(put).toHaveBeenCalledWith("instance", "llm-provider", {
            profile: JSON.stringify({
                providerId: "anthropic",
                connectionKey: "default",
                model: "claude-sonnet-4-5",
            }),
        });
        // 形状快照：CP parseProfileUnit 要求恰好 3 个键（providerId/connectionKey/model）。
        const body = put.mock.calls[0]?.[2] as Record<string, string>;
        expect(Object.keys(body)).toEqual(["profile"]);
        expect(Object.keys(JSON.parse(body.profile))).toEqual([
            "providerId",
            "connectionKey",
            "model",
        ]);
        expect(wrapper.emitted("saved")).toBeTruthy();
        expect(toast.success).toHaveBeenCalled();
    });

    it("清除并恢复继承 = profile 空串（CP 删该层行）", async () => {
        const store = seedStore({
            profile: JSON.stringify({
                providerId: "anthropic",
                connectionKey: "default",
                model: "claude-sonnet-4-5",
            }),
        });
        const put = vi.spyOn(store, "putLayerConfig").mockResolvedValue(undefined);
        const wrapper = mountPanel("instance");
        await flushPromises();
        expect(wrapper.find("[data-testid='llm-instance-current']").text()).toContain(
            "settings.llmInstanceCurrent",
        );
        await wrapper.find("[data-testid='llm-instance-clear']").trigger("click");
        await flushPromises();
        expect(put).toHaveBeenCalledWith("instance", "llm-provider", { profile: "" });
        expect(toast.success).toHaveBeenCalled();
        expect(wrapper.emitted("saved")).toBeTruthy();
    });

    it("预填当前实例默认；无 profile 时清除禁用、保存需完整三件套", async () => {
        seedStore({
            profile: JSON.stringify({
                providerId: "anthropic",
                connectionKey: "default",
                model: "claude-sonnet-4-5",
            }),
        });
        const wrapper = mountPanel("instance");
        await flushPromises();
        expect(
            (wrapper.find("[data-testid='llm-instance-model']").element as HTMLInputElement).value,
        ).toBe("claude-sonnet-4-5");
        expect(
            (
                wrapper.find("[data-testid='llm-instance-connection-key']")
                    .element as HTMLInputElement
            ).value,
        ).toBe("default");

        seedStore();
        const empty = mountPanel("instance");
        await flushPromises();
        expect(
            (empty.find("[data-testid='llm-instance-clear']").element as HTMLButtonElement)
                .disabled,
        ).toBe(true);
        expect(
            (empty.find("[data-testid='llm-instance-save']").element as HTMLButtonElement).disabled,
        ).toBe(true);
    });

    it("task-288: 模型/连接槽建议渲染成可见可点填的按钮，不再是不可见的 datalist", async () => {
        const store = seedStore();
        const wrapper = mountPanel("instance");
        await flushPromises();
        await setOnlySelectValue(wrapper, "anthropic");

        // 建议是**渲染出来的**元素（旧方案 <datalist> 只在输入时由浏览器弹出，DOM 里查不到可点项）
        expect(wrapper.find("datalist").exists()).toBe(false);
        const suggestion = wrapper.find(
            "[data-testid='llm-instance-model-suggestion-claude-sonnet-4-5']",
        );
        expect(suggestion.exists()).toBe(true);
        await suggestion.trigger("click");
        expect(
            (wrapper.find("[data-testid='llm-instance-model']").element as HTMLInputElement).value,
        ).toBe("claude-sonnet-4-5");

        // 连接槽同理
        expect(
            wrapper.find("[data-testid='llm-instance-connection-key-suggestion-default']").exists(),
        ).toBe(true);

        // 自由输入不受建议限制：保留手填能力（实例默认不要求本层有连接）
        await wrapper.find("[data-testid='llm-instance-model']").setValue("not-in-catalog-model");
        expect(
            (wrapper.find("[data-testid='llm-instance-model']").element as HTMLInputElement).value,
        ).toBe("not-in-catalog-model");
        expect(store).toBeTruthy();
    });

    it("task-288: 建议超过 6 个时折叠为「另有 N 个」，展示上限不裁剪数据", async () => {
        const store = seedStore();
        const names = Array.from({ length: 9 }, (_, index) => `model-${index}`);
        store.modelCache = {
            models: {},
            providers: {
                "conn-claude": {
                    providerId: "anthropic",
                    status: "ready",
                    models: names.map((name) => ({ name, capabilities: { chat: true } })),
                },
            },
            lastFetched: 1,
        } as never;
        const wrapper = mountPanel("instance");
        await flushPromises();
        await setOnlySelectValue(wrapper, "anthropic");

        const chips = wrapper.findAll("[data-testid^='llm-instance-model-suggestion-model-']");
        expect(chips).toHaveLength(6);
        expect(wrapper.find("[data-testid='llm-instance-model-suggestion-more']").text()).toContain(
            "3",
        );
    });

    it("task-288 判据③: 提供方目录为空时三槽不崩，且统一提示覆盖模型/连接槽", async () => {
        mockedCatalog.mockResolvedValue({ catalogRevision: "r1", providers: [] } as never);
        seedStore();
        const wrapper = mountPanel("instance");
        await flushPromises();

        const notice = wrapper.find("[data-testid='llm-instance-catalog-unavailable']");
        expect(notice.exists()).toBe(true);
        // 提示必须**同时**说清三槽都能手填（只写在提供方字段下等于没覆盖模型/连接槽）
        expect(notice.text()).toContain("settings.llmInstanceCatalogUnavailable");

        // 三个槽位都还在、都还能填
        expect(wrapper.find("[data-testid='llm-instance-provider']").exists()).toBe(true);
        const model = wrapper.find("[data-testid='llm-instance-model']");
        await model.setValue("typed-model");
        expect((model.element as HTMLInputElement).value).toBe("typed-model");
        await wrapper.find("[data-testid='llm-instance-connection-key']").setValue("default");
        // 目录为空时模型字段要给出「可手填」说明，而不是空白
        expect(wrapper.find("[data-testid='llm-instance-model-no-catalog']").exists()).toBe(true);
    });

    it("task-288 判据①: provider trigger 回落 vendor 默认样式（不再手搓覆盖）", async () => {
        seedStore();
        const wrapper = mountPanel("instance");
        await flushPromises();
        const trigger = wrapper.find("[data-testid='llm-instance-provider']");
        const classes = trigger.classes();
        // vendor 默认档位（注意高度是 data 变体，不是字面 h-8）
        expect(classes).toContain("data-[size=default]:h-8");
        expect(classes).toContain("rounded-lg");
        expect(classes).toContain("bg-transparent");
        expect(classes).toContain("border-input");
        expect(classes).toContain("pl-2.5");
        expect(classes).toContain("pr-2");
        expect(classes).toContain("py-2");
        // 手搓版的四个类必须消失，否则就是又回到这一处例外
        expect(classes).not.toContain("bg-background");
        expect(classes).not.toContain("px-2");
        expect(classes).not.toContain("rounded");
        // 唯一保留的覆盖是布局需要的 w-full（vendor 默认 w-fit）
        expect(classes).toContain("w-full");
        expect(trigger.attributes("data-slot")).toBe("select-trigger");
    });

    it("连接槽非法时保存禁用并给出内联错误", async () => {
        seedStore();
        const wrapper = mountPanel("instance");
        await flushPromises();
        await setOnlySelectValue(wrapper, "anthropic");
        await wrapper.find("[data-testid='llm-instance-model']").setValue("claude-sonnet-4-5");
        await wrapper.find("[data-testid='llm-instance-connection-key']").setValue("Bad_Key!");
        expect(wrapper.find("[data-testid='llm-instance-connection-key-invalid']").exists()).toBe(
            true,
        );
        expect(
            (wrapper.find("[data-testid='llm-instance-save']").element as HTMLButtonElement)
                .disabled,
        ).toBe(true);
    });

    it("保存失败按 problem.code 本地化，不直出原始报文或状态码 (F-07/R2)", async () => {
        const store = seedStore();
        const { ApiError } = await import("../../../composables/api");
        vi.spyOn(store, "putLayerConfig").mockRejectedValue(
            new ApiError({
                status: 409,
                code: "LLM_PROFILE_CONFLICT",
                detail: "409 LLM_PROFILE_CONFLICT: provider+model has no usable connection",
                requestId: "req-r2",
            }),
        );
        const wrapper = mountPanel("instance");
        await flushPromises();
        await setOnlySelectValue(wrapper, "anthropic");
        await wrapper.find("[data-testid='llm-instance-model']").setValue("claude-sonnet-4-5");
        await wrapper.find("[data-testid='llm-instance-connection-key']").setValue("default");
        await wrapper.find("[data-testid='llm-instance-save']").trigger("click");
        await flushPromises();

        const calls = vi.mocked(toast.error).mock.calls.map(([message]) => String(message));
        expect(calls.join("\n")).toContain("没有可用连接");
        expect(calls.join("\n")).not.toMatch(/LLM_PROFILE_CONFLICT|provider\+model|\b409\b/);
    });
});
