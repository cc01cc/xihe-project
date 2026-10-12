import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import { createRouter, createWebHistory, type Router } from "vue-router";
import { nextTick } from "vue";
import { useConfigStore } from "../../../../stores/config";
import { useSessionStore } from "../../../../stores/session";
import { useAuthStore } from "../../../../stores/auth";
import * as connectionApi from "../../../../services/providerConnectionService";
import ModelPopover from "../components/ModelPopover.vue";

const i18n = createI18n({
    legacy: false,
    locale: "en",
    messages: {
        en: {
            chat: {
                modelSelectorPlaceholder: "Select Model",
                noProvidersConfigured: "Configure a Provider first",
                providersNoModels: "No models available",
                searchModels: "Search models...",
                noSearchResults: "No matching models",
                favorites: "Favorites",
                modelFetchFailed: "Failed to fetch models",
                stop: "Stop",
            },
            sidebar: {
                newChat: "New Chat",
                search: "Search...",
                today: "Today",
                yesterday: "Yesterday",
                earlier: "Earlier",
                rename: "Rename",
                delete: "Delete",
                empty: "No sessions",
                settings: "Settings",
                logout: "Logout",
                workspace: "Workspace",
            },
        },
    },
});

const router = createRouter({
    history: createWebHistory(),
    routes: [
        {
            path: "/workspace/:workspaceId/chat/:sessionId",
            name: "workspace-chat",
            component: { template: "<div />" },
        },
        { path: "/settings/config", name: "settings-config", component: { template: "<div />" } },
    ],
});

const { pushSpy } = vi.hoisted(() => ({
    pushSpy: vi.fn<Router["push"]>(),
}));

vi.mock("vue-router", async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        useRouter: () => ({ push: pushSpy }),
    };
});

function mountPopover() {
    return mount(ModelPopover, {
        attachTo: document.body,
        global: {
            plugins: [i18n, router],
        },
    });
}

function readyModelCache(models: Record<string, string[]>) {
    return {
        models,
        providers: Object.fromEntries(
            Object.entries(models).map(([provider, modelIds]) => [
                provider,
                {
                    providerId: provider,
                    connectionId: provider,
                    connectionRevision: 1,
                    status: "ready" as const,
                    models: modelIds.map((name) => ({
                        name,
                        capabilities: { chat: true },
                    })),
                },
            ]),
        ),
    };
}

async function openContent(wrapper: ReturnType<typeof mountPopover>) {
    const trigger = wrapper.find("button");
    await trigger.trigger("click");
    await flushPromises();
    await nextTick();
}

function stubSessionResponse(record: { id: string; title?: string }) {
    return {
        id: record.id,
        title: record.title ?? "New Chat",
        workspaceId: "ws-test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

async function createSessionInStore(id: string, title: string) {
    const auth = useAuthStore();
    auth.$patch({ token: "mock", workspace: { id: "ws-test", name: "Default Workspace" } });
    const store = useSessionStore();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: () => Promise.resolve(stubSessionResponse({ id, title })),
    } as Response);
    await store.createSession("principal-test", title);
}

describe("ModelPopover", () => {
    beforeAll(() => {
        Object.defineProperty(globalThis, "navigator", {
            value: { mediaDevices: { getDisplayMedia: async () => ({}) } },
            configurable: true,
        });
        if (!Element.prototype.scrollIntoView) {
            Element.prototype.scrollIntoView = vi.fn<() => void>();
        }
    });

    beforeEach(async () => {
        setActivePinia(createPinia());
        localStorage.clear();
        pushSpy.mockClear();
        vi.restoreAllMocks();
        vi.spyOn(connectionApi, "listProviderConnections").mockImplementation(async () => ({
            connections: Object.entries(useConfigStore().modelCache.providers ?? {}).map(
                ([id, catalog]) => ({
                    id,
                    providerId: catalog.providerId ?? id,
                    connectionKey: id,
                    apiTypeId: "openai-chat-completions",
                    apiTypeVersion: 1,
                    operation: "chat" as const,
                    label: id,
                    scope: "USER" as const,
                    enabled: true,
                    status: "READY" as const,
                    revision: catalog.connectionRevision ?? 1,
                    hasKey: true,
                    modelDiscovery: "manual" as const,
                    manualModels: catalog.models.map((item) => item.name),
                }),
            ),
        }));
        vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
            const url = typeof input === "string" ? input : (input as Request).url,
                method = (init?.method ?? "GET").toUpperCase();
            if (url.includes("/messages") && method === "GET") {
                return new Response(JSON.stringify([]), { status: 200 });
            }
            if (url.includes("/api/v1/sessions/") && method === "PATCH") {
                return new Response(JSON.stringify({ id: "mp-3", title: "Updated" }), {
                    status: 200,
                });
            }
            if (url.endsWith("/api/v1/sessions") && method === "POST") {
                return new Response(JSON.stringify({ id: "mp-3", title: "New Chat" }), {
                    status: 201,
                });
            }
            if (url.includes("/api/v1/models")) {
                return new Response(JSON.stringify({ models: {} }), { status: 200 });
            }
            return new Response("{}", { status: 200 });
        });
        document.body.innerHTML = "";
        await router.push("/workspace/ws-test/chat/mock");
        await router.isReady();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("shows placeholder when no model selected", async () => {
        const wrapper = mountPopover();
        expect(wrapper.text()).toContain("Select Model");
        wrapper.unmount();
    });

    it("shows selected model name in trigger", async () => {
        await createSessionInStore("mp-1", "Model chat");
        const configStore = useConfigStore(),
            sessionStore = useSessionStore();
        configStore.modelCache = readyModelCache({ deepseek: ["deepseek-chat"] });
        configStore.setSessionModel(sessionStore.currentSessionId!, "deepseek", "deepseek-chat");
        vi.spyOn(configStore, "fetchModels").mockResolvedValue(undefined);

        const wrapper = mountPopover();
        expect(wrapper.text()).toContain("deepseek-chat");
        expect(wrapper.text()).toContain("DeepSeek");
        wrapper.unmount();
    });

    it("shows effective model from config defaults when no session binding", async () => {
        await createSessionInStore("mp-2", "Default model");
        const configStore = useConfigStore(),
            sessionStore = useSessionStore();
        sessionStore.updateSession(sessionStore.currentSessionId!, { title: "Default model" });
        configStore.$patch({
            mergedConfig: {
                "llm-provider": { defaultProvider: "openai" },
                "user-preference": { defaultModel: "gpt-4o" },
            },
        });
        configStore.modelCache = readyModelCache({ openai: ["gpt-4o"] });
        vi.spyOn(configStore, "fetchModels").mockResolvedValue(undefined);

        const wrapper = mountPopover();
        expect(wrapper.text()).toContain("gpt-4o");
        expect(wrapper.text()).toContain("OpenAI");
        wrapper.unmount();
    });

    it('shows "Configure a Provider" link when no providers', async () => {
        const configStore = useConfigStore();
        configStore.modelCache = { models: {} };
        vi.spyOn(configStore, "fetchModels").mockResolvedValue(undefined);

        const wrapper = mountPopover();
        await openContent(wrapper);
        expect(document.body.textContent).toContain("Configure a Provider first");
        wrapper.unmount();
    });

    it('shows "No models available" when providers exist but all empty', async () => {
        const configStore = useConfigStore();
        configStore.modelCache = readyModelCache({ deepseek: [], openai: [] });
        vi.spyOn(configStore, "fetchModels").mockResolvedValue(undefined);

        const wrapper = mountPopover();
        await openContent(wrapper);
        expect(document.body.textContent).toContain("No models available");
        wrapper.unmount();
    });
    it("renders provider group headers", async () => {
        const configStore = useConfigStore();
        configStore.modelCache = readyModelCache({
            deepseek: ["deepseek-chat", "deepseek-reasoner"],
            openai: ["gpt-4o"],
        });
        vi.spyOn(configStore, "fetchModels").mockResolvedValue(undefined);

        const wrapper = mountPopover();
        await openContent(wrapper);
        expect(document.body.textContent).toContain("DeepSeek");
        expect(document.body.textContent).toContain("OpenAI");
        wrapper.unmount();
    });

    it("collapses and reopens provider groups from the group header", async () => {
        const configStore = useConfigStore();
        configStore.modelCache = readyModelCache({ deepseek: ["deepseek-chat"] });
        vi.spyOn(configStore, "fetchModels").mockResolvedValue(undefined);

        const wrapper = mountPopover();
        await openContent(wrapper);
        const group = document.body.querySelector(
                '[data-testid="model-group-deepseek"]',
            ) as HTMLElement,
            header = group.querySelector("button") as HTMLButtonElement;

        expect(group.getAttribute("data-state")).toBe("open");
        expect(group.querySelector('[data-state="open"]')).toBeTruthy();

        header.click();
        await nextTick();
        expect(group.getAttribute("data-state")).toBe("closed");
        expect(group.querySelector('[data-state="closed"]')).toBeTruthy();

        header.click();
        await nextTick();
        expect(group.getAttribute("data-state")).toBe("open");
        expect(group.querySelector('[data-state="open"]')).toBeTruthy();
        wrapper.unmount();
    });

    it("renders model IDs with provider names", async () => {
        const configStore = useConfigStore();
        configStore.modelCache = readyModelCache({ deepseek: ["deepseek-chat"] });
        vi.spyOn(configStore, "fetchModels").mockResolvedValue(undefined);

        const wrapper = mountPopover();
        await openContent(wrapper);
        expect(document.body.textContent).toContain("deepseek-chat");
        expect(document.body.textContent).toContain("DeepSeek");
        wrapper.unmount();
    });

    it("selects model and updates session", async () => {
        await createSessionInStore("mp-3", "Select me");
        const configStore = useConfigStore(),
            sessionStore = useSessionStore();
        configStore.modelCache = readyModelCache({
            deepseek: ["deepseek-chat", "deepseek-reasoner"],
        });
        vi.spyOn(configStore, "fetchModels").mockResolvedValue(undefined);
        const updateSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
            ok: true,
            status: 200,
            json: () => Promise.resolve(stubSessionResponse({ id: "mp-3" })),
        } as Response);

        const wrapper = mountPopover();
        await openContent(wrapper);
        const option = Array.from(document.body.querySelectorAll('[role="option"]')).find((el) =>
            el.textContent?.includes("deepseek-chat"),
        );
        expect(option).toBeTruthy();
        (option as HTMLElement).click();
        for (let i = 0; i < 5; i += 1) {
            await flushPromises();
        }

        expect(updateSpy).toHaveBeenCalled();
        const binding = configStore.getActiveModel(sessionStore.currentSessionId!);
        // Legacy provider-keyed catalogs have no concrete ProviderConnection, so the
        // binding stays provider/model only (pre-0438 PATCH shape).
        expect(binding?.provider).toBe("deepseek");
        expect(binding?.model).toBe("deepseek-chat");
        expect(binding?.connectionId).toBe("deepseek");
        expect(binding?.connectionRevision).toBe(1);
        wrapper.unmount();
    });

    it("keeps same-provider model options distinct and patches the selected connection identity", async () => {
        await createSessionInStore("mp-3", "Connection identity");
        const configStore = useConfigStore(),
            sessionStore = useSessionStore(),
            catalog = readyModelCache({ openai: ["vendor/model"] }).providers.openai;
        configStore.modelCache = {
            models: { "connection-a": ["vendor/model"], "connection-b": ["vendor/model"] },
            providers: {
                "connection-a": {
                    ...catalog,
                    connectionId: "connection-a",
                    displayName: "Personal",
                    connectionRevision: 1,
                },
                "connection-b": {
                    ...catalog,
                    connectionId: "connection-b",
                    displayName: "Workspace",
                    connectionRevision: 2,
                },
            },
        };
        configStore.setSessionModel("mp-3", "openai", "vendor/model", "connection-a", 1);
        configStore.toggleFavorite("openai", "vendor/model");
        vi.spyOn(configStore, "fetchModels").mockResolvedValue(undefined);
        const updateSpy = vi.spyOn(sessionStore, "updateSession").mockResolvedValue({
            ...stubSessionResponse({ id: "mp-3" }),
            modelProvider: "openai",
            modelName: "vendor/model",
            providerConnectionId: "connection-b",
            connectionRevision: 2,
        });
        const wrapper = mountPopover();
        expect(wrapper.text()).toContain("vendor/model · OpenAI");
        await openContent(wrapper);
        expect(
            document.body.querySelectorAll('[data-model-key="connection-a/vendor/model"]'),
        ).toHaveLength(2);
        expect(
            document.body.querySelectorAll('[data-model-key="connection-b/vendor/model"]'),
        ).toHaveLength(2);
        // Readable legacy selector stays provider/model scoped for existing E2E specs;
        // connection identity lives in data-model-key.
        expect(
            document.body.querySelectorAll('[data-testid="model-item-openai/vendor/model"]').length,
        ).toBeGreaterThan(0);
        const selected = document.body.querySelector(
            '[data-model-key="connection-a/vendor/model"][data-state="checked"]',
        );
        expect(selected).toBeTruthy();
        const option = document.body.querySelector(
            '[data-connection-id="connection-b"] [role="option"]',
        );
        expect(option).toBeTruthy();
        (option as HTMLElement).click();
        await flushPromises();
        expect(updateSpy).toHaveBeenCalledWith("mp-3", {
            modelProvider: "openai",
            modelName: "vendor/model",
            providerConnectionId: "connection-b",
            connectionRevision: 2,
        });
        expect(configStore.getEffectiveModel("mp-3")).toEqual({
            provider: "openai",
            model: "vendor/model",
            connectionId: "connection-b",
            connectionRevision: 2,
        });
        expect(configStore.modelFavorites).toEqual([{ provider: "openai", model: "vendor/model" }]);
        wrapper.unmount();
    });

    it("toggles favorite when star clicked", async () => {
        const configStore = useConfigStore();
        configStore.modelCache = readyModelCache({ deepseek: ["deepseek-chat"] });
        vi.spyOn(configStore, "fetchModels").mockResolvedValue(undefined);

        const wrapper = mountPopover();
        await openContent(wrapper);
        expect(configStore.isFavorite("deepseek", "deepseek-chat")).toBe(false);

        const starBtn = Array.from(document.body.querySelectorAll("button")).find((el) =>
            el.getAttribute("aria-label")?.includes("Favorite"),
        );
        expect(starBtn).toBeTruthy();
        starBtn!.click();
        await flushPromises();

        expect(configStore.isFavorite("deepseek", "deepseek-chat")).toBe(true);
        wrapper.unmount();
    });

    it("filters models by search", async () => {
        const configStore = useConfigStore();
        configStore.modelCache = readyModelCache({
            deepseek: ["deepseek-chat", "deepseek-reasoner"],
            openai: ["gpt-4o"],
        });
        vi.spyOn(configStore, "fetchModels").mockResolvedValue(undefined);

        const wrapper = mountPopover();
        await openContent(wrapper);
        const input = document.body.querySelector("input");
        expect(input).toBeTruthy();
        (input as HTMLInputElement).value = "reasoner";
        input!.dispatchEvent(new Event("input"));
        await flushPromises();
        await nextTick();

        expect(document.body.textContent).toContain("deepseek-reasoner");
        expect(document.body.textContent).not.toContain("gpt-4o");
        wrapper.unmount();
    });

    it('navigates to settings when "Configure a Provider" clicked', async () => {
        const configStore = useConfigStore();
        configStore.modelCache = { models: {} };
        vi.spyOn(configStore, "fetchModels").mockResolvedValue(undefined);
        const wrapper = mountPopover();
        await openContent(wrapper);
        const settingsLink = Array.from(document.body.querySelectorAll("button")).find((el) =>
            el.textContent?.includes("Configure a Provider first"),
        );
        expect(settingsLink).toBeTruthy();
        settingsLink!.click();
        await flushPromises();
        expect(pushSpy).toHaveBeenCalledWith("/settings/config");
        wrapper.unmount();
    });
});
