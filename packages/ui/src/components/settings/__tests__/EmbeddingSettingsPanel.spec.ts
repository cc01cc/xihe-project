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
import {
    openSelectAt,
    selectItemTexts,
    selectItemValues,
    selectValueAt,
    setOnlySelectValue,
} from "../../../test-utils/select";

vi.mock("../../../services/providerConnectionService", () => ({
    listProviderConnections:
        vi.fn<
            typeof import("../../../services/providerConnectionService").listProviderConnections
        >(),
}));
vi.mock("../../../services/embeddingProfile", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../services/embeddingProfile")>()),
    fetchEmbeddingEffective: vi.fn<typeof fetchEmbeddingEffective>(),
    saveEmbeddingProfile: vi.fn<typeof saveEmbeddingProfile>(),
    testEmbedding: vi.fn<typeof testEmbedding>(),
}));
vi.mock("../../../composables/api", () => ({
    request: vi.fn<typeof import("../../../composables/api").request>(),
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
    useI18n: () => ({ t: (key: string) => key }),
}));

import { toast } from "vue-sonner";

function connection(overrides: Partial<ProviderConnection>): ProviderConnection {
    return {
        id: "conn-1",
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
const mockedTest = vi.mocked(testEmbedding);

beforeEach(() => {
    // PLAN-0523 T3.5: the panel reads connections through the config store.
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mockedConnections.mockResolvedValue({ connections: [] } as never);
    mockedEffective.mockResolvedValue({ profile: null, profileScope: null, resolved: null });
    mockedSave.mockResolvedValue(undefined);
    mockedTest.mockResolvedValue({ status: "ok", model: "m", dimension: 768, requestId: "r1" });
});

describe("EmbeddingSettingsPanel", () => {
    it("shows only READY embedding connections", async () => {
        mockedConnections.mockResolvedValue({
            connections: [
                connection({ id: "embed-1", operation: "embedding" }),
                connection({
                    id: "chat-1",
                    operation: "chat",
                    apiTypeId: "openai-chat-completions",
                }),
                connection({ id: "off-1", operation: "embedding", status: "UNVERIFIED" }),
            ],
        } as never);
        const wrapper = mount(EmbeddingSettingsPanel, { props: { layer: "user" } });
        await flushPromises();
        await openSelectAt(wrapper, 0);
        expect(selectItemValues(wrapper)).toHaveLength(2);
        expect(selectItemTexts(wrapper)[1]).toContain("Embedding");
    });

    it("saves the whole-unit profile for the selected connection", async () => {
        mockedConnections.mockResolvedValue({
            connections: [connection({ id: "embed-1" })],
        } as never);
        mockedEffective.mockResolvedValue({ profile: null, profileScope: null, resolved: null });
        const wrapper = mount(EmbeddingSettingsPanel, {
            props: { layer: "user" },
        });
        await flushPromises();
        await setOnlySelectValue(wrapper, "embed-1");
        await wrapper.find("button[data-testid='embedding-save']").trigger("click");
        await flushPromises();
        // task-253：工作区层移除后只剩两个参数（层 + profile），不再带 workspaceId。
        expect(mockedSave).toHaveBeenCalledWith("user", {
            providerId: "dashscope-qwen",
            connectionKey: "embedding",
            model: "tongyi-embedding-vision-flash-2026-03-06",
        });
        expect(wrapper.emitted("saved")).toBeTruthy();
    });

    it("prefills the effective profile connection and shows fixed dimension", async () => {
        mockedConnections.mockResolvedValue({
            connections: [connection({ id: "embed-1" })],
        } as never);
        mockedEffective.mockResolvedValue({
            profile: {
                providerId: "dashscope-qwen",
                connectionKey: "embedding",
                model: "tongyi-embedding-vision-flash-2026-03-06",
            },
            profileScope: "user",
            resolved: null,
        });
        const wrapper = mount(EmbeddingSettingsPanel, { props: { layer: "user" } });
        await flushPromises();
        expect(selectValueAt(wrapper, 0)).toBe("embed-1");
        expect(wrapper.find("[data-testid='embedding-contract']").text()).toContain("768");
    });

    it("本地化测试状态与错误文案，不直出 status/errorCode (F-07/R3)", async () => {
        mockedConnections.mockResolvedValue({
            connections: [connection({ id: "embed-1" })],
        } as never);
        mockedEffective.mockResolvedValue({
            profile: {
                providerId: "dashscope-qwen",
                connectionKey: "embedding",
                model: "tongyi-embedding-vision-flash-2026-03-06",
            },
            profileScope: "user",
            resolved: null,
        });
        mockedTest.mockResolvedValue({
            status: "error",
            errorCode: "EMBEDDING_PROVIDER_UNREACHABLE",
        });
        const wrapper = mount(EmbeddingSettingsPanel, { props: { layer: "user" } });
        await flushPromises();
        await wrapper.find("button[data-testid='embedding-test']").trigger("click");
        await flushPromises();
        const result = wrapper.find("[data-testid='embedding-test-result']").text();
        // task-14 / F-07：状态值走 i18n（本 spec 把 t 换成 key），错误码走统一中文文案。
        expect(result).toContain("settings.embeddingTestFailed");
        expect(result).toContain("操作失败，请稍后重试");
        expect(result).not.toContain("status: error");
        const toastCalls = vi
            .mocked(toast.error)
            .mock.calls.map(([message]) => String(message))
            .join("\n");
        expect(toastCalls).toContain("操作失败，请稍后重试");
        expect(toastCalls).not.toBe("EMBEDDING_PROVIDER_UNREACHABLE");
    });

    it("writes the instance-layer profile through layer=instance", async () => {
        mockedConnections.mockResolvedValue({
            connections: [connection({ id: "embed-1" })],
        } as never);
        const wrapper = mount(EmbeddingSettingsPanel, { props: { layer: "instance" } });
        await flushPromises();
        await setOnlySelectValue(wrapper, "embed-1");
        await wrapper.find("button[data-testid='embedding-save']").trigger("click");
        await flushPromises();
        // PLAN-0764 T1.5：实例层同样发 profile 单元（CP validateEmbeddingLayer 只认 {profile}）。
        expect(mockedSave).toHaveBeenCalledWith("instance", {
            providerId: "dashscope-qwen",
            connectionKey: "embedding",
            model: "tongyi-embedding-vision-flash-2026-03-06",
        });
        expect(wrapper.emitted("saved")).toBeTruthy();
    });

    it("shows the instance note only on the instance layer", async () => {
        mockedConnections.mockResolvedValue({
            connections: [connection({ id: "embed-1" })],
        } as never);
        const instance = mount(EmbeddingSettingsPanel, { props: { layer: "instance" } });
        await flushPromises();
        expect(instance.find("[data-testid='embedding-instance-note']").exists()).toBe(true);
        expect(instance.find("[data-testid='embedding-instance-note']").text()).toContain(
            "settings.embeddingInstanceNote",
        );

        const user = mount(EmbeddingSettingsPanel, { props: { layer: "user" } });
        await flushPromises();
        expect(user.find("[data-testid='embedding-instance-note']").exists()).toBe(false);
    });

    it("disables save without a connection and clear without profile", async () => {
        const wrapper = mount(EmbeddingSettingsPanel, { props: { layer: "user" } });
        await flushPromises();
        expect(
            (wrapper.find("button[data-testid='embedding-save']").element as HTMLButtonElement)
                .disabled,
        ).toBe(true);
        expect(
            (wrapper.find("button[data-testid='embedding-clear']").element as HTMLButtonElement)
                .disabled,
        ).toBe(true);
        expect(
            (wrapper.find("button[data-testid='embedding-test']").element as HTMLButtonElement)
                .disabled,
        ).toBe(true);
    });
});
