import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import EmbeddingSettingsPanel from "../EmbeddingSettingsPanel.vue";
import type { ProviderConnection } from "../../../types/providerConnection";
import { listProviderConnections } from "../../../services/providerConnectionService";
import {
    fetchEmbeddingEffective,
    saveEmbeddingProfile,
    testEmbedding,
} from "../../../services/embeddingProfile";

vi.mock("../../../services/providerConnectionService", () => ({
    listProviderConnections:
        vi.fn<typeof import("../../../services/providerConnectionService").listProviderConnections>(),
}));
vi.mock("../../../services/embeddingProfile", async (importOriginal) => ({
    ...(await importOriginal<
        typeof import("../../../services/embeddingProfile")
    >()),
    fetchEmbeddingEffective: vi.fn<typeof fetchEmbeddingEffective>(),
    saveEmbeddingProfile: vi.fn<typeof saveEmbeddingProfile>(),
    testEmbedding: vi.fn<typeof testEmbedding>(),
}));
vi.mock("../../../composables/api", () => ({ request: vi.fn() }));
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
                connection({ id: "chat-1", operation: "chat", apiTypeId: "openai-chat-completions" }),
                connection({ id: "off-1", operation: "embedding", status: "UNVERIFIED" }),
            ],
        } as never);
        const wrapper = mount(EmbeddingSettingsPanel, { props: { layer: "user" } });
        await flushPromises();
        const options = wrapper.findAll("select[data-testid='embedding-connection-select'] option");
        expect(options).toHaveLength(2);
        expect(options[1]?.text()).toContain("Embedding");
    });

    it("saves the whole-unit profile for the selected connection", async () => {
        mockedConnections.mockResolvedValue({
            connections: [connection({ id: "embed-1" })],
        } as never);
        mockedEffective.mockResolvedValue({ profile: null, profileScope: null, resolved: null });
        const wrapper = mount(EmbeddingSettingsPanel, { props: { layer: "workspace", workspaceId: "ws-1" } });
        await flushPromises();
        await wrapper.find("select[data-testid='embedding-connection-select']").setValue("embed-1");
        await wrapper.find("button[data-testid='embedding-save']").trigger("click");
        await flushPromises();
        expect(mockedSave).toHaveBeenCalledWith(
            "workspace",
            {
                providerId: "dashscope-qwen",
                connectionKey: "embedding",
                model: "tongyi-embedding-vision-flash-2026-03-06",
            },
            "ws-1",
        );
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
        expect(
            (wrapper.find("select[data-testid='embedding-connection-select']").element as HTMLSelectElement)
                .value,
        ).toBe("embed-1");
        expect(wrapper.find("[data-testid='embedding-contract']").text()).toContain("768");
    });

    it("shows sanitized test result and error path only via code", async () => {
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
        expect(result).toContain("error");
        expect(result).toContain("EMBEDDING_PROVIDER_UNREACHABLE");
        expect(toast.error).toHaveBeenCalled();
    });

    it("disables save without a connection and clear without profile", async () => {
        const wrapper = mount(EmbeddingSettingsPanel, { props: { layer: "user" } });
        await flushPromises();
        expect(
            (wrapper.find("button[data-testid='embedding-save']").element as HTMLButtonElement).disabled,
        ).toBe(true);
        expect(
            (wrapper.find("button[data-testid='embedding-clear']").element as HTMLButtonElement).disabled,
        ).toBe(true);
        expect(
            (wrapper.find("button[data-testid='embedding-test']").element as HTMLButtonElement).disabled,
        ).toBe(true);
    });
});
