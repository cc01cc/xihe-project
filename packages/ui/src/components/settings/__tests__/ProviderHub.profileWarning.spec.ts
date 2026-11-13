import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { config, flushPromises, mount } from "@vue/test-utils";
import ProviderHub from "../ProviderHub.vue";
import type { ProviderConnection, ProviderDefinition } from "../../../types/providerConnection";
import {
    listProviderCatalog,
    listProviderConnections,
} from "../../../services/providerConnectionService";
import { request } from "../../../composables/api";
import { listVisibleTemplates, readTemplateConfig } from "../../../services/apiRequestTemplates";
import { useConfigStore } from "../../../stores/config";
import { i18n } from "../../../i18n";

/**
 * task-385（D-1233）：实例层保存 profile 时连接未就绪 / ghost ⇒ **inline 警示，不阻断保存**。
 * 三条判据逐条钉：① UNVERIFIED 保存 ⇒ 警示出现且 PUT 真的发了；② READY 保存 ⇒ 无警示；
 * ③ 警示可关闭且不禁用后续操作。纯前端判据（D-1203：不加 HTTP warning 字段）。
 * 承重负例：把 refreshProfileWarning() 从两个写入口任一去掉，①/ghost 用例必红；
 * 把警示改成阻断（return 在 PUT 之前），①的 putLayerConfig 断言必红。
 */
(config.global.plugins ??= []).push(i18n);

vi.mock("../../../services/apiRequestTemplates", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../services/apiRequestTemplates")>()),
    listVisibleTemplates: vi.fn<typeof listVisibleTemplates>(),
    readTemplateConfig: vi.fn<typeof readTemplateConfig>(),
}));
vi.mock("../../../services/providerConnectionService", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../services/providerConnectionService")>()),
    listProviderCatalog: vi.fn<typeof listProviderCatalog>(),
    listProviderConnections: vi.fn<typeof listProviderConnections>(),
}));
vi.mock("../../../composables/api", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../composables/api")>()),
    request: vi.fn<typeof request>(),
}));
vi.mock("../../../lib/logger", () => ({ logger: { warn: vi.fn<(...args: unknown[]) => void>() } }));
vi.mock("vue-sonner", () => ({
    toast: { success: vi.fn<(m: string) => void>(), error: vi.fn<(m: string) => void>() },
}));

const provider: ProviderDefinition = {
    id: "example",
    displayName: "Example",
    adapter: "openai-compatible",
    defaultBaseUrl: "https://example.test/v1",
    modelDiscovery: "remote-models",
    credential: { type: "api-key", required: true },
    supports: { customBaseUrl: true, streaming: true },
    supportedApiTypes: [{ apiTypeId: "openai-chat-completions", version: 1 }],
    defaultApiType: { apiTypeId: "openai-chat-completions", version: 1 },
};

function connection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
    return {
        id: "instance-connection",
        providerId: provider.id,
        connectionKey: "primary",
        apiTypeId: "openai-chat-completions",
        apiTypeVersion: 1,
        operation: "chat",
        label: "Instance connection",
        scope: "INSTANCE",
        baseUrl: "https://example.test/v1",
        modelDiscovery: "manual",
        manualModels: ["model-a"],
        hasKey: true,
        enabled: true,
        status: "READY",
        revision: 1,
        ...overrides,
    };
}

const WARNING = '[data-testid="provider-profile-warning"]';
const DISMISS = '[data-testid="provider-profile-warning-dismiss"]';

/** 扮演页面：取数由页面负责（task-121），这里显式给实例层一个空域 + 桩掉两个写动作。 */
async function mountInstanceHub(conn: ProviderConnection, storedProfile?: string) {
    vi.mocked(listProviderConnections).mockResolvedValue({ connections: [conn] });
    const store = useConfigStore();
    store.layerConfig.instance = {
        ...store.layerConfig.instance,
        "llm-provider": storedProfile ? { profile: storedProfile } : {},
    };
    const put = vi.spyOn(store, "putLayerConfig").mockImplementation(async () => {});
    // 服务端回显：保存后重新取数会带回刚写的 profile（判据要读的是**保存后**的状态）。
    vi.spyOn(store, "loadLayerDomains").mockImplementation(async (layer) => {
        const written = put.mock.calls.at(-1)?.[2];
        store.layerConfig[layer] = {
            ...store.layerConfig[layer],
            "llm-provider": { ...(written ?? {}) },
        };
    });
    const wrapper = mount(ProviderHub, { props: { layer: "instance", scope: "INSTANCE" } });
    await flushPromises();
    return { wrapper, store, put };
}

beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
    vi.resetAllMocks();
    vi.mocked(listVisibleTemplates).mockResolvedValue([]);
    vi.mocked(readTemplateConfig).mockResolvedValue({});
    vi.mocked(listProviderCatalog).mockResolvedValue({
        catalogRevision: "1",
        providers: [provider],
    });
    vi.mocked(request).mockResolvedValue({});
});

describe("ProviderHub 实例层 profile 警示（task-385 / D-1233）", () => {
    it("判据①：UNVERIFIED 连接设为默认 ⇒ 警示出现，且保存真的发生（不阻断）", async () => {
        const conn = connection({ status: "UNVERIFIED" });
        const { wrapper, put } = await mountInstanceHub(conn);
        expect(wrapper.find(WARNING).exists()).toBe(false);

        await wrapper
            .get(`[data-testid="provider-connection-default-${conn.id}"]`)
            .trigger("click");
        await flushPromises();

        expect(put).toHaveBeenCalledTimes(1);
        expect(put.mock.calls[0]?.[0]).toBe("instance");
        expect(put.mock.calls[0]?.[1]).toBe("llm-provider");
        expect(JSON.parse(String(put.mock.calls[0]?.[2]?.profile))).toMatchObject({
            providerId: provider.id,
            connectionKey: "primary",
            model: "model-a",
        });
        const warning = wrapper.get(WARNING);
        expect(warning.text()).toContain("409");
        expect(warning.text()).toContain("连接未就绪");
    });

    it("判据②：READY 连接设为默认 ⇒ 保存成功且无警示", async () => {
        const conn = connection({ status: "READY" });
        const { wrapper, put } = await mountInstanceHub(conn);
        await wrapper
            .get(`[data-testid="provider-connection-default-${conn.id}"]`)
            .trigger("click");
        await flushPromises();
        expect(put).toHaveBeenCalledTimes(1);
        expect(wrapper.find(WARNING).exists()).toBe(false);
    });

    it("判据③：警示可关闭，且关闭后仍能继续保存（不挡后续操作）", async () => {
        const conn = connection({ status: "UNVERIFIED", manualModels: ["model-a", "model-b"] });
        const { wrapper, put } = await mountInstanceHub(conn);
        await wrapper
            .get(`[data-testid="provider-connection-default-${conn.id}"]`)
            .trigger("click");
        await flushPromises();
        expect(wrapper.find(WARNING).exists()).toBe(true);

        await wrapper.get(DISMISS).trigger("click");
        expect(wrapper.find(WARNING).exists()).toBe(false);

        // 关闭警示不禁用任何后续操作：换一个**新查询到的**写入口再保存一次仍然发 PUT。
        // （连接成为默认后列表里那颗按钮不再渲染 ⇒ 用模型级入口，且它必须可点。）
        const next = wrapper.get('[data-testid="provider-model-default-model-b"]');
        expect((next.element as HTMLButtonElement).disabled).toBe(false);
        await next.trigger("click");
        await flushPromises();
        expect(put).toHaveBeenCalledTimes(2);
        expect(wrapper.find(WARNING).exists()).toBe(true);
    });

    it("ghost：profile 引用的连接已不可见，保存模型参数 ⇒ ghost 警示（第二个写入口同样覆盖）", async () => {
        const conn = connection();
        const ghostProfile = JSON.stringify({
            providerId: provider.id,
            connectionKey: "gone",
            model: "model-a",
        });
        const { wrapper, put } = await mountInstanceHub(conn, ghostProfile);
        const toggle = wrapper
            .findAll("button[aria-expanded]")
            .find((item) => item.text().includes("model-a"));
        expect(toggle).toBeDefined();
        await toggle?.trigger("click");
        await wrapper.get('[data-testid="provider-model-params-save-model-a"]').trigger("click");
        await flushPromises();
        expect(put).toHaveBeenCalledTimes(1);
        expect(wrapper.get(WARNING).text()).toContain("已不可见");
    });

    it("先 UNVERIFIED 警示、后改选 READY 连接保存 ⇒ 警示自动消失（判据②的时序形态）", async () => {
        const unverified = connection({
            status: "UNVERIFIED",
            manualModels: ["model-a", "model-b"],
        });
        const { wrapper, store } = await mountInstanceHub(unverified);
        await wrapper
            .get(`[data-testid="provider-connection-default-${unverified.id}"]`)
            .trigger("click");
        await flushPromises();
        expect(wrapper.find(WARNING).exists()).toBe(true);

        // 连接验证通过（列表刷新为 READY）后再保存一次 ⇒ 重算为 ready ⇒ 警示消失。
        // 第二次保存走**模型级**入口：连接成为默认后，列表里的「设为默认」按钮不再渲染，
        // 而默认模型自身的模型级按钮也隐藏（!isDefaultModel）⇒ 用另一个模型 model-b。
        store.providerConnections = [
            connection({ status: "READY", manualModels: ["model-a", "model-b"] }),
        ];
        await flushPromises();
        await wrapper.get('[data-testid="provider-model-default-model-b"]').trigger("click");
        await flushPromises();
        expect(wrapper.find(WARNING).exists()).toBe(false);
    });
});
