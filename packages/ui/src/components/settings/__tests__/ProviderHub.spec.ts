import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { config, flushPromises, mount } from "@vue/test-utils";
import ProviderHub from "../ProviderHub.vue";
import type { ProviderConnection, ProviderDefinition } from "../../../types/providerConnection";
import {
    deleteProviderConnection,
    getDeleteImpact,
    listProviderCatalog,
    listProviderConnections,
    updateProviderConnection,
    verifyProviderConnection,
} from "../../../services/providerConnectionService";
import { ApiError, request } from "../../../composables/api";
import { toast } from "vue-sonner";
import { listVisibleTemplates, readTemplateConfig } from "../../../services/apiRequestTemplates";
import { i18n } from "../../../i18n";

// PLAN-0523 T3.4: install the real i18n plugin so template strings resolve.
(config.global.plugins ??= []).push(i18n);

vi.mock("../../../services/apiRequestTemplates", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../services/apiRequestTemplates")>()),
    listVisibleTemplates: vi.fn<typeof listVisibleTemplates>(),
    readTemplateConfig: vi.fn<typeof readTemplateConfig>(),
}));

vi.mock("../../../services/providerConnectionService", () => ({
    listProviderCatalog:
        vi.fn<typeof import("../../../services/providerConnectionService").listProviderCatalog>(),
    listProviderConnections:
        vi.fn<
            typeof import("../../../services/providerConnectionService").listProviderConnections
        >(),
    createProviderConnection:
        vi.fn<
            typeof import("../../../services/providerConnectionService").createProviderConnection
        >(),
    updateProviderConnection:
        vi.fn<
            typeof import("../../../services/providerConnectionService").updateProviderConnection
        >(),
    verifyProviderConnection:
        vi.fn<
            typeof import("../../../services/providerConnectionService").verifyProviderConnection
        >(),
    deleteProviderConnection:
        vi.fn<
            typeof import("../../../services/providerConnectionService").deleteProviderConnection
        >(),
    getDeleteImpact:
        vi.fn<typeof import("../../../services/providerConnectionService").getDeleteImpact>(),
}));
vi.mock("../../../composables/api", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../composables/api")>()),
    request: vi.fn<typeof request>(),
}));
vi.mock("../../../lib/logger", () => ({ logger: { warn: vi.fn<(...args: unknown[]) => void>() } }));
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
    // PLAN-0523 T3.5: ProviderHub reads connections from the config store — give
    // each test an isolated pinia so the store cache never leaks between cases.
    setActivePinia(createPinia());
    vi.restoreAllMocks();
    vi.resetAllMocks();
    vi.mocked(listVisibleTemplates).mockResolvedValue([]);
    vi.mocked(readTemplateConfig).mockResolvedValue({});
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
    it("writes a Workspace default to the same explicit Workspace used for its read", async () => {
        const target = { ...workspace, apiTypeId: user.apiTypeId, workspaceId: "workspace-b" };
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [target] });
        vi.mocked(listVisibleTemplates).mockResolvedValue([
            {
                layer: "instance",
                templateId: "builtin",
                version: 1,
                name: "Built in",
                apiTypeId: user.apiTypeId,
                apiTypeVersion: 1,
            },
        ]);
        const wrapper = mount(ProviderHub, {
            props: { scope: "WORKSPACE", workspaceId: "workspace-a" },
        });
        await flushPromises();
        await wrapper
            .get(
                'select[aria-label="' +
                    i18n.global.t("settings.providerHub.connDefaultTemplate") +
                    '"]',
            )
            .setValue("instance:builtin:1");
        await flushPromises();
        expect(readTemplateConfig).toHaveBeenCalledWith("workspace", "workspace-b");
        expect(request).toHaveBeenCalledWith(
            "/config/workspace/api-request-templates?workspaceId=workspace-b",
            expect.objectContaining({ method: "PUT" }),
        );
        wrapper.unmount();
    });
    it("loads Workspace templates using the current context for a User connection", async () => {
        const wrapper = mount(ProviderHub, {
            props: { scope: "USER", workspaceId: "current-workspace" },
        });
        await flushPromises();
        expect(listVisibleTemplates).toHaveBeenCalledWith("current-workspace");
        expect(readTemplateConfig).toHaveBeenCalledWith("user", "current-workspace");
        wrapper.unmount();
    });
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
        expect(detail.find("select").exists()).toBe(true);
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
        expect(wrapper.text()).toContain(i18n.global.t("settings.providerHub.noMatch"));
        wrapper.unmount();
    });

    it("retains discovery/manualModels and never prefills or submits an unchanged secret", async () => {
        const wrapper = await mountHub();
        const row = wrapper.findAll('[data-testid="provider-connection-example"]')[0]!;
        await row
            .findAll("button")
            .find((button) => button.text() === i18n.global.t("settings.providerHub.manage"))!
            .trigger("click");
        const modal = wrapper.get('[data-testid="provider-connection-modal"]');
        expect(modal.get<HTMLInputElement>('input[type="password"]').element.value).toBe("");
        expect(
            modal
                .findAll<HTMLSelectElement>("select")
                .find((item) => item.element.value === "curated")?.element.value,
        ).toBe("curated");
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

    it("derives the form scope from the connection and current page without a scope picker", async () => {
        const wrapper = mount(ProviderHub, {
            props: { scope: "WORKSPACE", workspaceId: "workspace-a" },
        });
        await flushPromises();
        const row = wrapper.findAll('[data-testid="provider-connection-example"]')[0]!;
        await row
            .findAll("button")
            .find((button) => button.text() === i18n.global.t("settings.providerHub.manage"))!
            .trigger("click");
        const modal = wrapper.get('[data-testid="provider-connection-modal"]');
        // A USER connection edited from the workspace tab keeps its own scope.
        expect(modal.text()).toContain(
            i18n.global.t("settings.providerHub.formScopeHint", {
                scope: i18n.global.t("settings.providerHub.scopeUser"),
            }),
        );
        expect(modal.findAll('input[type="radio"][name="provider-scope"]')).toHaveLength(0);
        wrapper.unmount();
    });

    it("keeps row-level deletion contract and falls back after deleting the selected connection", async () => {
        vi.mocked(getDeleteImpact).mockResolvedValue({
            connectionId: user.id,
            providerId: user.providerId,
            connectionKey: user.connectionKey,
            bindingCount: 0,
            bindingUserScopes: 0,
            defaultTemplateRef: false,
            profileCount: 0,
            profileScopes: [],
            sessionCount: 0,
            blocked: false,
        });
        const wrapper = await mountHub();
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [workspace] });
        const row = wrapper.findAll('[data-testid="provider-connection-example"]')[0]!;
        await row
            .findAll("button")
            .find((button) => button.text() === i18n.global.t("settings.providerHub.delete"))!
            .trigger("click");
        await flushPromises();
        expect(getDeleteImpact).toHaveBeenCalledWith(user.id);
        // PLAN-0505: the confirm dialog must show before the DELETE is issued.
        expect(deleteProviderConnection).not.toHaveBeenCalled();
        await wrapper.get('[data-testid="provider-delete-confirm"]').trigger("click");
        await flushPromises();
        expect(deleteProviderConnection).toHaveBeenCalledWith(user.id);
        // Review round-4 regression guard: the dialog must close on success
        // (the deleting-guard on cancel must not block the success path).
        expect(wrapper.find('[data-testid="provider-delete-confirm-modal"]').exists()).toBe(false);
        expect(
            wrapper
                .get('[data-testid="provider-connection-detail"]')
                .attributes("data-connection-id"),
        ).toBe(workspace.id);
        wrapper.unmount();
    });

    it("PLAN-0505: cancel closes the confirm dialog with zero mutations", async () => {
        vi.mocked(getDeleteImpact).mockResolvedValue({
            connectionId: user.id,
            providerId: user.providerId,
            connectionKey: user.connectionKey,
            bindingCount: 2,
            bindingUserScopes: 1,
            defaultTemplateRef: true,
            profileCount: 1,
            profileScopes: ["user"],
            sessionCount: 0,
            blocked: false,
        });
        const wrapper = await mountHub();
        const row = wrapper.findAll('[data-testid="provider-connection-example"]')[0]!;
        await row
            .findAll("button")
            .find((button) => button.text() === i18n.global.t("settings.providerHub.delete"))!
            .trigger("click");
        await flushPromises();
        const summary = wrapper.get('[data-testid="provider-delete-impact-summary"]');
        expect(summary.text()).toContain(
            i18n.global.t("settings.providerHub.impactModelBindings", { count: 2, scopes: 1 }),
        );
        expect(summary.text()).toContain(
            i18n.global.t("settings.providerHub.impactDefaultTemplate"),
        );
        expect(summary.text()).toContain(
            i18n.global.t("settings.providerHub.impactProfiles", { count: 1 }),
        );
        await wrapper.get('[data-testid="provider-delete-cancel"]').trigger("click");
        expect(wrapper.find('[data-testid="provider-delete-confirm-modal"]').exists()).toBe(false);
        expect(deleteProviderConnection).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it("PLAN-0505: blocked connections disable deletion and show the session hint", async () => {
        vi.mocked(getDeleteImpact).mockResolvedValue({
            connectionId: user.id,
            providerId: user.providerId,
            connectionKey: user.connectionKey,
            bindingCount: 0,
            bindingUserScopes: 0,
            defaultTemplateRef: false,
            profileCount: 0,
            profileScopes: [],
            sessionCount: 2,
            blocked: true,
        });
        const wrapper = await mountHub();
        const row = wrapper.findAll('[data-testid="provider-connection-example"]')[0]!;
        await row
            .findAll("button")
            .find((button) => button.text() === i18n.global.t("settings.providerHub.delete"))!
            .trigger("click");
        await flushPromises();
        expect(wrapper.get('[data-testid="provider-delete-blocked"]').text()).toContain(
            i18n.global.t("settings.providerHub.deleteBlocked", { count: 2 }),
        );
        expect(
            wrapper.get('[data-testid="provider-delete-confirm"]').attributes("disabled"),
        ).toBeDefined();
        expect(deleteProviderConnection).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it("PLAN-0505: a failed delete keeps the dialog open and reports the error", async () => {
        vi.mocked(getDeleteImpact).mockResolvedValue({
            connectionId: user.id,
            providerId: user.providerId,
            connectionKey: user.connectionKey,
            bindingCount: 0,
            bindingUserScopes: 0,
            defaultTemplateRef: false,
            profileCount: 0,
            profileScopes: [],
            sessionCount: 0,
            blocked: false,
        });
        vi.mocked(deleteProviderConnection).mockRejectedValue(new Error("CONNECTION_IN_USE"));
        const wrapper = await mountHub();
        const row = wrapper.findAll('[data-testid="provider-connection-example"]')[0]!;
        await row
            .findAll("button")
            .find((button) => button.text() === i18n.global.t("settings.providerHub.delete"))!
            .trigger("click");
        await flushPromises();
        await wrapper.get('[data-testid="provider-delete-confirm"]').trigger("click");
        await flushPromises();
        expect(wrapper.get('[data-testid="provider-delete-error"]').text()).toBe(
            "CONNECTION_IN_USE",
        );
        expect(wrapper.find('[data-testid="provider-delete-confirm-modal"]').exists()).toBe(true);
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
            i18n.global.t("settings.providerHub.noModels"),
        );
        wrapper.unmount();
    });

    it("clears a cancelled replacement key without writing the connection", async () => {
        const wrapper = await mountHub();
        await wrapper.get('[data-testid="provider-connection-detail"] button').trigger("click");
        await wrapper.get('input[type="password"]').setValue("replacement-for-test");
        await wrapper
            .get('button[aria-label="' + i18n.global.t("settings.providerHub.close") + '"]')
            .trigger("click");
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
        expect(models.text()).toContain(i18n.global.t("settings.providerHub.modelsError"));
        expect(models.text()).toContain("preserved-manual-model");
        // PLAN-0523 T3.2 行改版：请求模板下拉移入模型行展开区（点击行展开）。
        await models
            .get('[data-testid="provider-model-preserved-manual-model"] button')
            .trigger("click");
        expect(
            models.get('[data-testid="provider-model-detail-preserved-manual-model"]').exists(),
        ).toBe(true);
        expect(models.find("select").exists()).toBe(true);
        wrapper.unmount();
    });
});

describe("ProviderHub orphan template bindings (PLAN-0503)", () => {
    it("lists bindings whose model left the catalog and clears them only on user action", async () => {
        // Fresh object per call: the component mutates the returned entries and
        // relies on a new reference to trigger reactivity (same as the service).
        vi.mocked(readTemplateConfig).mockImplementation(async () => ({
            providerModelBindings: JSON.stringify({
                [user.id]: {
                    "ghost-model": { layer: "instance", templateId: "builtin", version: 1 },
                },
            }),
        }));
        const wrapper = await mountHub();

        const orphanSection = wrapper.get('[data-testid="provider-orphan-bindings"]');
        expect(orphanSection.text()).toContain("ghost-model");
        expect(orphanSection.text()).toContain(i18n.global.t("settings.providerHub.orphanTitle"));
        // Drift alone never triggers a write (I4: kept, visible, cleared by user).
        expect(
            vi.mocked(request).mock.calls.filter(([, init]) => init?.method === "PUT"),
        ).toHaveLength(0);

        await orphanSection.get("select").setValue("");
        await flushPromises();
        const put = vi.mocked(request).mock.calls.find(([, init]) => init?.method === "PUT");
        expect(put).toBeTruthy();
        expect(String(put![0])).toContain("/config/user/api-request-templates");
        const body = JSON.parse(String(put![1]!.body)) as Record<string, string>;
        expect(JSON.parse(body.providerModelBindings)).toEqual({});
        expect(wrapper.find('[data-testid="provider-orphan-bindings"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it("labels availability as unknown (not clearable) when the directory fetch fails", async () => {
        vi.mocked(request).mockRejectedValue(new Error("directory down"));
        vi.mocked(readTemplateConfig).mockImplementation(async () => ({
            providerModelBindings: JSON.stringify({
                [user.id]: {
                    "ghost-model": { layer: "instance", templateId: "builtin", version: 1 },
                },
            }),
        }));
        const wrapper = await mountHub();

        const orphanSection = wrapper.get('[data-testid="provider-orphan-bindings"]');
        expect(orphanSection.text()).toContain("ghost-model");
        expect(orphanSection.text()).toContain(
            i18n.global.t("settings.providerHub.orphanTitleError"),
        );
        expect(orphanSection.text()).not.toContain("可清除");
        wrapper.unmount();
    });
});

describe("ProviderHub 就地默认与每模型配置 (PLAN-0523 T3.2/T3.3)", () => {
    const second: ProviderConnection = {
        ...user,
        id: "second-connection",
        providerId: "other",
        connectionKey: "secondary",
        baseUrl: "https://other.test/v1",
    };
    const catalog = {
        providers: {
            "user-connection": {
                connectionId: "user-connection",
                providerId: "example",
                status: "ready",
                models: [
                    {
                        name: "mimo-v2.5",
                        capabilities: { chat: true },
                        inputModalities: ["text"],
                        outputModalities: ["text"],
                        contextWindowTokens: 128000,
                        maxOutputTokens: 8192,
                        pricing: { currency: "¥", unit: "1M tokens", input: 1.2, output: 4.8 },
                    },
                    { name: "mimo-asr", capabilities: { chat: false } },
                    { name: "mimo-v2.6-pro", capabilities: { chat: true } },
                ],
                verifiedAt: "2026-10-16T10:00:00Z",
            },
            "second-connection": {
                connectionId: "second-connection",
                providerId: "other",
                status: "ready",
                models: [
                    { name: "other-1", capabilities: { chat: true } },
                    { name: "other-2", capabilities: { chat: false } },
                ],
                verifiedAt: "2026-10-16T10:00:00Z",
            },
        },
    };
    const PROFILE_PRIMARY = JSON.stringify({
        providerId: "example",
        connectionKey: "primary",
        model: "mimo-v2.5",
    });

    /** request mock：/models 返回目录，/config/ 返回层 entries，其余走 api-input-types。 */
    function mockHubFetch(options: { profile?: string; modelParams?: string } = {}) {
        vi.mocked(request).mockImplementation((input) => {
            const url = typeof input === "string" ? input : input.url,
                parsed = new URL(url, "http://localhost");
            if (parsed.pathname.endsWith("/models")) {
                return Promise.resolve(catalog as never);
            }
            if (parsed.pathname.includes("/config/")) {
                const entries: Record<string, string> = {};
                if (options.profile !== undefined) entries.profile = options.profile;
                if (options.modelParams) entries.modelParams = options.modelParams;
                return Promise.resolve({
                    domain: "llm-provider",
                    entries,
                    envOverridden: {},
                } as never);
            }
            return Promise.resolve({ types: [] } as never);
        });
    }

    function requestPuts() {
        return vi
            .mocked(request)
            .mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT")
            .map(([input, init]) => ({
                url: typeof input === "string" ? input : input.url,
                body: JSON.parse(String((init as RequestInit).body ?? "{}")) as Record<
                    string,
                    string
                >,
            }));
    }

    function llmPuts() {
        return requestPuts().filter((call) => call.url.includes("/config/user/llm-provider"));
    }

    it("pins the stored default connection on top with a badge, not repeated in groups", async () => {
        mockHubFetch({ profile: PROFILE_PRIMARY });
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [user, second] });
        const wrapper = await mountHub();

        const pinned = wrapper.get('[data-testid="provider-default-connection"]');
        expect(pinned.attributes("data-connection-key")).toBe("primary");
        expect(pinned.text()).toContain(i18n.global.t("settings.providerHub.badgeDefault"));
        const occurrences = wrapper.findAll(
            '[data-testid="provider-master-detail"] nav [data-connection-key="primary"]',
        );
        expect(occurrences).toHaveLength(1);
        expect(occurrences[0]!.attributes("data-testid")).toBe("provider-default-connection");
        wrapper.unmount();
    });

    it("set-as-default writes the layer profile with the first chat model", async () => {
        mockHubFetch();
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [user, second] });
        const wrapper = await mountHub();

        await wrapper
            .get('[data-testid="provider-connection-default-second-connection"]')
            .trigger("click");
        await flushPromises();

        const puts = llmPuts();
        expect(puts).toHaveLength(1);
        expect(puts[0]!.body.profile).toBe(
            JSON.stringify({ providerId: "other", connectionKey: "secondary", model: "other-1" }),
        );
        wrapper.unmount();
    });

    it("set-as-default keeps the stored model when it exists in the target catalog", async () => {
        // 默认连接为 user-connection；stored model other-1 在目标连接目录中 → 保留。
        mockHubFetch({
            profile: JSON.stringify({
                providerId: "example",
                connectionKey: "primary",
                model: "other-1",
            }),
        });
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [user, second] });
        const wrapper = await mountHub();

        await wrapper
            .get('[data-testid="provider-connection-default-second-connection"]')
            .trigger("click");
        await flushPromises();

        const puts = llmPuts();
        expect(puts).toHaveLength(1);
        expect(puts[0]!.body.profile).toBe(
            JSON.stringify({ providerId: "other", connectionKey: "secondary", model: "other-1" }),
        );
        wrapper.unmount();
    });

    it("keeps a drifted stored default as an amber kept entry at the list top", async () => {
        mockHubFetch({
            profile: JSON.stringify({
                providerId: "example",
                connectionKey: "gone-key",
                model: "mimo-v2.5",
            }),
        });
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [user] });
        const wrapper = await mountHub();

        const drift = wrapper.get('[data-testid="provider-default-drift"]');
        expect(drift.text()).toContain("gone-key");
        expect(drift.text()).toContain(i18n.global.t("settings.providerHub.driftBadge"));
        expect(wrapper.find('[data-testid="provider-default-connection"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it("pins the default model on top of the default connection's model list", async () => {
        mockHubFetch({
            profile: JSON.stringify({
                providerId: "example",
                connectionKey: "primary",
                model: "mimo-v2.6-pro",
            }),
        });
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [user, second] });
        const wrapper = await mountHub();

        const rows = wrapper.findAll(
            '[data-testid="provider-connection-models"] li[data-testid^="provider-model-"]',
        );
        expect(rows[0]!.attributes("data-testid")).toBe("provider-model-mimo-v2.6-pro");
        expect(rows[0]!.text()).toContain(i18n.global.t("settings.providerHub.badgeDefault"));
        wrapper.unmount();
    });

    it("set-model-as-default writes the profile with the picked model", async () => {
        mockHubFetch({
            profile: JSON.stringify({
                providerId: "example",
                connectionKey: "primary",
                model: "mimo-v2.6-pro",
            }),
        });
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [user, second] });
        const wrapper = await mountHub();

        await wrapper.get('[data-testid="provider-model-default-mimo-v2.5"]').trigger("click");
        await flushPromises();

        const puts = llmPuts();
        expect(puts).toHaveLength(1);
        expect(puts[0]!.body.profile).toBe(
            JSON.stringify({ providerId: "example", connectionKey: "primary", model: "mimo-v2.5" }),
        );
        wrapper.unmount();
    });

    it("saves per-model sampling params into the whole-unit modelParams map", async () => {
        mockHubFetch({ profile: PROFILE_PRIMARY });
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [user, second] });
        const wrapper = await mountHub();

        await wrapper.get('[data-testid="provider-model-mimo-v2.5"] button').trigger("click");
        await wrapper
            .get(
                `input[aria-label="${i18n.global.t("settings.providerHub.maxTokensAria", {
                    model: "mimo-v2.5",
                })}"]`,
            )
            .setValue("4096");
        await wrapper
            .get(
                `input[aria-label="${i18n.global.t("settings.providerHub.temperatureAria", {
                    model: "mimo-v2.5",
                })}"]`,
            )
            .setValue("0.7");
        await wrapper
            .get(
                `input[aria-label="${i18n.global.t("settings.providerHub.timeoutAria", {
                    model: "mimo-v2.5",
                })}"]`,
            )
            .setValue("60");
        await wrapper.get('[data-testid="provider-model-params-save-mimo-v2.5"]').trigger("click");
        await flushPromises();

        const puts = llmPuts();
        expect(puts).toHaveLength(1);
        expect(puts[0]!.body.profile).toBe(PROFILE_PRIMARY);
        expect(JSON.parse(puts[0]!.body.modelParams ?? "{}")).toEqual({
            "mimo-v2.5": { maxTokens: 4096, temperature: 0.7, timeout: 60 },
        });
        wrapper.unmount();
    });

    it("shows model details with catalog metadata and 未知 fallbacks (T3.3)", async () => {
        mockHubFetch({ profile: PROFILE_PRIMARY });
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [user] });
        const wrapper = await mountHub();

        const btn = wrapper.get('[data-testid="provider-model-mimo-v2.5"] button');
        await btn.trigger("click");
        const detail = wrapper.get('[data-testid="provider-model-detail-mimo-v2.5"]');
        expect(detail.text()).toContain("text");
        expect(detail.text()).toContain("128,000");
        expect(detail.text()).toContain("8,192");
        expect(detail.text()).toContain("¥1.2/1M tokens");
        wrapper.unmount();
    });

    it("shows 未知 for catalog models without metadata (T3.3)", async () => {
        mockHubFetch({ profile: PROFILE_PRIMARY });
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [user] });
        const wrapper = await mountHub();

        await wrapper.get('[data-testid="provider-model-mimo-asr"] button').trigger("click");
        const detail = wrapper.get('[data-testid="provider-model-detail-mimo-asr"]');
        expect(detail.text()).toContain(i18n.global.t("settings.providerHub.unknown"));
        wrapper.unmount();
    });
});

describe("ProviderHub label rules (PLAN-0555)", () => {
    async function openManageForm(wrapper: Awaited<ReturnType<typeof mountHub>>) {
        const row = wrapper.findAll('[data-testid="provider-connection-example"]')[0]!;
        await row
            .findAll("button")
            .find((button) => button.text() === i18n.global.t("settings.providerHub.manage"))!
            .trigger("click");
        return wrapper.get('[data-testid="provider-connection-modal"]');
    }

    it("blocks an empty label before calling the API", async () => {
        const wrapper = await mountHub(),
            modal = await openManageForm(wrapper);
        await modal.get('[data-testid="provider-connection-form-label"]').setValue("   ");
        await modal.get("form").trigger("submit");
        await flushPromises();

        expect(toast.error).toHaveBeenCalledWith(
            i18n.global.t("settings.providerHub.toastLabelRequired"),
        );
        expect(updateProviderConnection).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it("blocks a label longer than 40 characters before calling the API", async () => {
        const wrapper = await mountHub(),
            modal = await openManageForm(wrapper);
        await modal.get('[data-testid="provider-connection-form-label"]').setValue("x".repeat(41));
        await modal.get("form").trigger("submit");
        await flushPromises();

        expect(toast.error).toHaveBeenCalledWith(
            i18n.global.t("settings.providerHub.toastLabelTooLong"),
        );
        expect(updateProviderConnection).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it("blocks control characters before calling the API", async () => {
        const wrapper = await mountHub(),
            modal = await openManageForm(wrapper);
        await modal.get('[data-testid="provider-connection-form-label"]').setValue("bad\tname");
        await modal.get("form").trigger("submit");
        await flushPromises();

        expect(toast.error).toHaveBeenCalledWith(
            i18n.global.t("settings.providerHub.toastLabelControl"),
        );
        expect(updateProviderConnection).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it("warns on a case-insensitive sibling label but still submits", async () => {
        const sibling: ProviderConnection = {
            ...user,
            id: "user-connection-2",
            connectionKey: "secondary",
            label: "Second connection",
        };
        vi.mocked(listProviderConnections).mockResolvedValue({ connections: [user, sibling] });
        const wrapper = await mountHub(),
            modal = await openManageForm(wrapper);
        await modal
            .get('[data-testid="provider-connection-form-label"]')
            .setValue("second CONNECTION");
        await modal.get("form").trigger("submit");
        await flushPromises();

        expect(toast.warning).toHaveBeenCalledWith(
            i18n.global.t("settings.providerHub.toastLabelDuplicate"),
        );
        expect(updateProviderConnection).toHaveBeenCalledWith(
            user.id,
            expect.objectContaining({ label: "second CONNECTION" }),
        );
        wrapper.unmount();
    });

    it("maps the 409 label conflict to a localized message and keeps the dialog", async () => {
        vi.mocked(updateProviderConnection).mockRejectedValue(
            new ApiError({
                status: 409,
                code: "PROVIDER_CONNECTION_LABEL_CONFLICT",
                requestId: "test-request",
                field: "label",
            }),
        );
        const wrapper = await mountHub(),
            modal = await openManageForm(wrapper);
        await modal
            .get('[data-testid="provider-connection-form-label"]')
            .setValue("Duplicate name");
        await modal.get("form").trigger("submit");
        await flushPromises();

        expect(toast.error).toHaveBeenCalledWith(
            i18n.global.t("settings.providerHub.toastLabelConflict"),
        );
        expect(wrapper.find('[data-testid="provider-connection-modal"]').exists()).toBe(true);
        wrapper.unmount();
    });
});

describe("PLAN-0591 tool capability visibility", () => {
    it("shows the provider partial badge and per-API-Type capability detail", async () => {
        vi.mocked(listProviderCatalog).mockResolvedValue({
            catalogRevision: "v2",
            providers: [
                {
                    ...provider,
                    supports: { ...provider.supports, tools: true, toolsPartial: true },
                    supportedApiTypes: [
                        { apiTypeId: "openai-chat", version: 1, capability: { tools: true } },
                        { apiTypeId: "legacy-responses", version: 1, capability: { tools: false } },
                    ],
                },
            ],
        });
        const wrapper = await mountHub();
        await wrapper.get('[data-testid="provider-hub-connect"]').trigger("click");
        expect(
            wrapper.find('[data-testid="provider-supports-tools-partial-example"]').exists(),
        ).toBe(true);
        await wrapper.get('[data-testid="provider-picker-example"]').trigger("click");
        const modal = wrapper.get('[data-testid="provider-connection-modal"]');
        const detail = modal.get('[data-testid="connection-api-type-capabilities"]').text();
        expect(detail).toContain("openai-chat@1");
        expect(detail).toContain(i18n.global.t("settings.providerHub.apiTypeToolsSupported"));
        expect(detail).toContain("legacy-responses@1");
        expect(detail).toContain(i18n.global.t("settings.providerHub.apiTypeToolsUnsupported"));
        wrapper.unmount();
    });
});
