import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import EmbeddingSettingsPanel from "../EmbeddingSettingsPanel.vue";
import type { ProviderConnection } from "../../../types/providerConnection";
import { listProviderConnections } from "../../../services/providerConnectionService";
import {
    fetchEmbeddingEffective,
    saveEmbeddingProfile,
    testEmbedding,
} from "../../../services/embeddingProfile";
import { setOnlySelectValue } from "../../../test-utils/select";
import { i18n } from "../../../i18n";
import type * as providerConnectionServiceModule from "../../../services/providerConnectionService";
import type * as embeddingProfileModule from "../../../services/embeddingProfile";
import type * as apiModule from "../../../composables/api";

/**
 * task-26：embedding 面板（profile 单元）的脏状态上报。
 *
 * <p>为什么单开一个文件而不加进 `EmbeddingSettingsPanel.spec.ts`：那个文件的
 * `vi.mock("vue-i18n")` 只给 `useI18n`，而组件导入图里有 `stores/session.ts` →
 * `i18n/index.ts` 的 `createI18n`，收集期就抛 `No "createI18n" export is defined on the "vue-i18n" mock`
 * （**HEAD 上既有的红**，与本卡无关；见 task-26 证据）。本文件装真 i18n 插件，绕开那条既有红，只测脏信号。</p>
 */
vi.mock("../../../services/providerConnectionService", () => ({
    listProviderConnections:
        vi.fn<typeof providerConnectionServiceModule.listProviderConnections>(),
}));
vi.mock("../../../services/embeddingProfile", async (importOriginal) => ({
    ...(await importOriginal<typeof embeddingProfileModule>()),
    fetchEmbeddingEffective: vi.fn<typeof fetchEmbeddingEffective>(),
    saveEmbeddingProfile: vi.fn<typeof saveEmbeddingProfile>(),
    testEmbedding: vi.fn<typeof testEmbedding>(),
}));
vi.mock("../../../composables/api", () => ({
    request: vi.fn<typeof apiModule.request>(),
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

function connection(overrides: Partial<ProviderConnection>): ProviderConnection {
    return {
        id: "embed-1",
        providerId: "dashscope-qwen",
        connectionKey: "embedding",
        apiTypeId: "dashscope-multimodal-embedding",
        apiTypeVersion: 1,
        operation: "embedding",
        label: "Embedding",
        scope: "USER",
        modelDiscovery: "manual",
        manualModels: ["tongyi-embedding-vision-flash-2026-03-06"],
        hasKey: true,
        enabled: true,
        status: "READY",
        revision: 2,
        ...overrides,
    };
}

const mockedConnections = vi.mocked(listProviderConnections);
const mockedEffective = vi.mocked(fetchEmbeddingEffective);
const mockedSave = vi.mocked(saveEmbeddingProfile);

async function mountPanel() {
    const wrapper = mount(EmbeddingSettingsPanel, {
        props: { layer: "user" },
        global: { plugins: [i18n] },
    });
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mockedConnections.mockResolvedValue({
        connections: [
            connection({ id: "embed-1" }),
            connection({ id: "embed-2", providerId: "openai", connectionKey: "embedding-b" }),
        ],
    } as never);
    mockedEffective.mockResolvedValue({ profile: null, profileScope: null, resolved: null });
    mockedSave.mockResolvedValue(undefined);
});

describe("EmbeddingSettingsPanel dirty 上报（task-26）", () => {
    it("无已存 profile 时载入不脏；选连接才脏；卸载归零", async () => {
        const wrapper = await mountPanel();
        expect(wrapper.emitted("dirty")?.at(-1)).toEqual([false]);

        await setOnlySelectValue(wrapper, "embed-2");
        expect(wrapper.emitted("dirty")?.at(-1)).toEqual([true]);

        wrapper.unmount();
        expect(wrapper.emitted("dirty")?.at(-1)).toEqual([false]);
    });

    it("已存 profile 指向某连接时载入即不脏；换一个才脏；换回来回落", async () => {
        mockedEffective.mockResolvedValue({
            profile: {
                providerId: "dashscope-qwen",
                connectionKey: "embedding",
                model: "tongyi-embedding-vision-flash-2026-03-06",
            },
            profileScope: "user",
            resolved: null,
        } as never);
        const wrapper = await mountPanel();
        expect(wrapper.emitted("dirty")?.at(-1)).toEqual([false]);

        await setOnlySelectValue(wrapper, "embed-2");
        expect(wrapper.emitted("dirty")?.at(-1)).toEqual([true]);

        await setOnlySelectValue(wrapper, "embed-1");
        expect(wrapper.emitted("dirty")?.at(-1)).toEqual([false]);
    });

    it("保存成功后重取 effective（已存值变成新选择）⇒ 自然回落 false", async () => {
        const wrapper = await mountPanel();
        await setOnlySelectValue(wrapper, "embed-2");
        expect(wrapper.emitted("dirty")?.at(-1)).toEqual([true]);

        mockedEffective.mockResolvedValue({
            profile: {
                providerId: "openai",
                connectionKey: "embedding-b",
                model: "tongyi-embedding-vision-flash-2026-03-06",
            },
            profileScope: "user",
            resolved: null,
        } as never);
        await wrapper.get("button[data-testid='embedding-save']").trigger("click");
        await flushPromises();
        expect(mockedSave).toHaveBeenCalledTimes(1);
        expect(wrapper.emitted("dirty")?.at(-1)).toEqual([false]);
    });
});
