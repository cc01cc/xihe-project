import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import ProviderHub from "../ProviderHub.vue";
import type { ProviderConnection, ProviderDefinition } from "../../../types/providerConnection";
import {
    deleteProviderConnection,
    listProviderCatalog,
    listProviderConnections,
    updateProviderConnection,
    verifyProviderConnection,
} from "../../../services/providerConnectionService";
import { request } from "../../../composables/api";

vi.mock("../../../services/providerConnectionService", () => ({
    listProviderCatalog:
        vi.fn<
            (typeof import("../../../services/providerConnectionService"))["listProviderCatalog"]
        >(),
    listProviderConnections:
        vi.fn<
            (typeof import("../../../services/providerConnectionService"))["listProviderConnections"]
        >(),
    createProviderConnection:
        vi.fn<
            (typeof import("../../../services/providerConnectionService"))["createProviderConnection"]
        >(),
    updateProviderConnection:
        vi.fn<
            (typeof import("../../../services/providerConnectionService"))["updateProviderConnection"]
        >(),
    verifyProviderConnection:
        vi.fn<
            (typeof import("../../../services/providerConnectionService"))["verifyProviderConnection"]
        >(),
    deleteProviderConnection:
        vi.fn<
            (typeof import("../../../services/providerConnectionService"))["deleteProviderConnection"]
        >(),
}));
vi.mock("../../../composables/api", () => ({
    request: vi.fn<(typeof import("../../../composables/api"))["request"]>(),
}));
vi.mock("../../../lib/logger", () => ({
    logger: { warn: vi.fn<(message: string, ...rest: unknown[]) => void>() },
}));
vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message: string) => void>(),
        error: vi.fn<(message: string) => void>(),
        warning: vi.fn<(message: string) => void>(),
    },
}));

const provider: ProviderDefinition = {
    id: "example",
    displayName: "Example",
    adapter: "openai-compatible",
    defaultBaseUrl: "https://example.test/v1",
    modelDiscovery: "remote-models",
    credential: { type: "api-key", required: true },
    supports: { customBaseUrl: true, streaming: true },
    supportedApiTypes: [{ apiTypeId: "openai-chat", version: 1 }],
    defaultApiType: { apiTypeId: "openai-chat", version: 1 },
};
const user: ProviderConnection = {
    id: "user-connection",
    providerId: provider.id,
    connectionKey: "primary",
    apiTypeId: "openai-chat",
    apiTypeVersion: 1,
    operation: "chat",
    label: "User connection",
    scope: "USER",
    baseUrl: "https://example.test/v1",
    modelDiscovery: "curated",
    manualModels: ["preserved-manual-model"],
    hasKey: true,
    enabled: true,
    status: "READY",
    revision: 1,
};
const workspace: ProviderConnection = {
    ...user,
    id: "workspace-connection",
    scope: "WORKSPACE",
    label: "Workspace connection",
    apiTypeId: "other-type",
};

async function mountHub(readonly = false) {
    const wrapper = mount(ProviderHub, { props: { scope: "USER", readonly } });
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    vi.mocked(listProviderCatalog).mockResolvedValue({
        catalogRevision: "1",
        providers: [provider],
    });
    vi.mocked(listProviderConnections).mockResolvedValue({ connections: [user, workspace] });
    vi.mocked(request).mockResolvedValue({
        providers: {
            [user.id]: { connectionId: user.id, models: [{ name: "user-model" }] },
            [workspace.id]: { connectionId: workspace.id, models: [{ name: "workspace-model" }] },
        },
    });
    vi.mocked(updateProviderConnection).mockResolvedValue(user);
    vi.mocked(verifyProviderConnection).mockResolvedValue({ connection: user, models: [] });
});

describe("ProviderHub master-detail", () => {
    it("groups connections by Provider and switches the entire detail by connection ID", async () => {
        const wrapper = await mountHub();
        const rows = wrapper.findAll('[data-testid="provider-connection-example"]');
        expect(rows).toHaveLength(2);
        expect(rows[0]!.attributes("data-connection-key")).toBe("primary");
        expect(rows[0]!.text()).toContain("User");
        expect(rows[1]!.text()).toContain("Workspace");
        expect(wrapper.get('[data-testid="provider-connection-models"]').text()).toContain(
            "user-model",
        );
        await rows[1]!.get("button[aria-pressed]").trigger("click");
        const detail = wrapper.get('[data-testid="provider-connection-detail"]');
        expect(detail.attributes("data-connection-id")).toBe(workspace.id);
        expect(detail.text()).toContain("workspace-model");
        expect(detail.text()).not.toContain("user-model");
        expect(detail.get('[data-testid="provider-connection-readonly-type"]').text()).toContain(
            "other-type@1",
        );
        expect(detail.find("select").exists()).toBe(false);
        expect(detail.text()).toContain("Configured · hidden");
        expect(wrapper.text()).not.toContain("个人连接对同一 Provider 优先");
        expect(wrapper.get('[data-testid="provider-master-detail"]').classes()).toContain("grid");
        wrapper.unmount();
    });

    it("filters key/scope navigation and shows an explicit no-match detail", async () => {
        const wrapper = await mountHub();
        await wrapper.get('[data-testid="provider-connection-search"]').setValue("workspace");
        expect(wrapper.findAll('[data-testid="provider-connection-example"]')).toHaveLength(1);
        expect(
            wrapper
                .get('[data-testid="provider-connection-detail"]')
                .attributes("data-connection-id"),
        ).toBe(workspace.id);
        await wrapper.get('[data-testid="provider-connection-search"]').setValue("missing");
        expect(wrapper.find('[data-testid="provider-connection-detail"]').exists()).toBe(false);
        expect(wrapper.text()).toContain("没有匹配的连接");
        wrapper.unmount();
    });

    it("retains discovery/manualModels and never prefills or submits an unchanged secret", async () => {
        const wrapper = await mountHub();
        const row = wrapper.findAll('[data-testid="provider-connection-example"]')[0]!;
        await row
            .findAll("button")
            .find((button) => button.text() === "管理")!
            .trigger("click");
        const modal = wrapper.get('[data-testid="provider-connection-modal"]');
        expect(modal.get<HTMLInputElement>('input[type="password"]').element.value).toBe("");
        expect(modal.get<HTMLSelectElement>("select").element.value).toBe("curated");
        expect(
            modal.get('[data-testid="provider-connection-form-key"]').attributes("readonly"),
        ).toBeDefined();
        await modal.get("form").trigger("submit");
        await flushPromises();
        expect(updateProviderConnection).toHaveBeenCalledWith(
            user.id,
            expect.objectContaining({
                modelDiscovery: "curated",
                manualModels: ["preserved-manual-model"],
            }),
        );
        expect(vi.mocked(updateProviderConnection).mock.calls[0]![1]).not.toHaveProperty("apiKey");
        wrapper.unmount();
    });

    it("keeps row-level deletion contract and falls back after deleting the selected connection", async () => {
        const wrapper = await mountHub();
        vi.spyOn(window, "confirm").mockReturnValue(true);
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [workspace] });
        const row = wrapper.findAll('[data-testid="provider-connection-example"]')[0]!;
        await row
            .findAll("button")
            .find((button) => button.text() === "删除")!
            .trigger("click");
        await flushPromises();
        expect(deleteProviderConnection).toHaveBeenCalledWith(user.id);
        expect(
            wrapper
                .get('[data-testid="provider-connection-detail"]')
                .attributes("data-connection-id"),
        ).toBe(workspace.id);
        wrapper.unmount();
    });

    it("allows readonly navigation but disables mutation controls", async () => {
        const wrapper = await mountHub(true);
        const rows = wrapper.findAll('[data-testid="provider-connection-example"]');
        await rows[1]!.get("button[aria-pressed]").trigger("click");
        expect(
            wrapper
                .get('[data-testid="provider-connection-detail"]')
                .attributes("data-connection-id"),
        ).toBe(workspace.id);
        expect(
            rows[1]!
                .findAll("button")
                .slice(1)
                .every((button) => button.attributes("disabled") !== undefined),
        ).toBe(true);
        expect(wrapper.find('[data-testid="provider-hub-connect"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it("does not mix models when the catalog belongs to another connection", async () => {
        vi.mocked(request).mockResolvedValue({
            providers: {
                [user.id]: { connectionId: workspace.id, models: [{ name: "wrong-model" }] },
            },
        });
        const wrapper = await mountHub();
        expect(wrapper.get('[data-testid="provider-connection-models"]').text()).not.toContain(
            "wrong-model",
        );
        expect(wrapper.get('[data-testid="provider-connection-models"]').text()).toContain(
            "暂无可显示的模型",
        );
        wrapper.unmount();
    });

    it("clears a cancelled replacement key without writing the connection", async () => {
        const wrapper = await mountHub();
        await wrapper.get('[data-testid="provider-connection-detail"] button').trigger("click");
        await wrapper.get('input[type="password"]').setValue("replacement-for-test");
        await wrapper.get('button[aria-label="关闭"]').trigger("click");
        await wrapper.get('[data-testid="provider-connection-detail"] button').trigger("click");
        expect(wrapper.get<HTMLInputElement>('input[type="password"]').element.value).toBe("");
        expect(updateProviderConnection).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it("shows model load failure separately and keeps this connection's manual configuration", async () => {
        vi.mocked(request).mockRejectedValue(new Error("Model catalog unavailable"));
        vi.mocked(listProviderConnections).mockResolvedValue({
            connections: [{ ...user, modelDiscovery: "manual" }],
        });
        const wrapper = await mountHub();
        const models = wrapper.get('[data-testid="provider-connection-models"]');
        expect(models.text()).toContain("模型目录加载失败");
        expect(models.text()).toContain("preserved-manual-model");
        expect(models.text()).toContain("openai-chat@1 · 继承连接");
        wrapper.unmount();
    });
});
