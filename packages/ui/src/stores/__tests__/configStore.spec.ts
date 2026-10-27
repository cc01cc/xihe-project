import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useConfigStore, CONFIG_DOMAINS, INSTANCE_DOMAINS, LAYER_DOMAINS } from "../config";

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
});

function seedReadyModel(store: ReturnType<typeof useConfigStore>, provider: string, model: string) {
    store.modelCache = {
        models: { [provider]: [model] },
        providers: {
            [provider]: {
                providerId: provider,
                status: "ready",
                models: [{ name: model, capabilities: { chat: true } }],
            },
        },
    };
}

describe("useConfigStore", () => {
    describe("mergedConfig persistence", () => {
        it("loads persisted mergedConfig from localStorage", () => {
            localStorage.setItem(
                "xihe-config-merged",
                JSON.stringify({
                    "llm-provider": { temperature: "0.5" },
                    "user-preference": { theme: "dark" },
                }),
            );

            const store = useConfigStore();
            expect(store.mergedConfig["llm-provider"]?.temperature).toBe("0.5");
            expect(store.mergedConfig["user-preference"]?.theme).toBe("dark");
        });

        it("writes mergedConfig to localStorage via loadAllDomains", async () => {
            vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
                const url = typeof input === "string" ? input : input.url,
                    domain = url.split("/").pop()?.split("?")[0] ?? "";
                const payload: Record<string, Record<string, string>> = {
                    logging: { logLevel: "DEBUG" },
                    "llm-provider": { temperature: "0.5" },
                    "context-policy": {},
                    embedding: {},
                    "agent-runtime": {},
                    "agent-profile": {},
                    "user-preference": {},
                    rag: {},
                };
                return Promise.resolve(
                    new Response(JSON.stringify(payload[domain] ?? {}), { status: 200 }),
                );
            });
            const store = useConfigStore();

            await store.loadAllDomains();

            const raw = localStorage.getItem("xihe-config-merged");
            expect(raw).not.toBeNull();
            const parsed = JSON.parse(raw!);
            expect(parsed["llm-provider"].temperature).toBe("0.5");
        });

        it("loadAllDomains fetches and updates mergedConfig", async () => {
            const requestedDomains: string[] = [];
            vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
                const url = typeof input === "string" ? input : input.url,
                    domain = url.split("/").pop()?.split("?")[0] ?? "";
                requestedDomains.push(domain);
                const payload: Record<string, Record<string, string>> = {
                    logging: { logLevel: "DEBUG" },
                    "llm-provider": { temperature: "0.5" },
                    "context-policy": {},
                    embedding: {},
                    "agent-runtime": {},
                    "agent-profile": {},
                    "user-preference": {},
                    rag: {},
                };
                return Promise.resolve(
                    new Response(JSON.stringify(payload[domain] ?? {}), { status: 200 }),
                );
            });
            const store = useConfigStore();

            await store.loadAllDomains();

            expect(store.mergedConfig["logging"]?.logLevel).toBe("DEBUG");
            expect(store.mergedConfig["llm-provider"]?.temperature).toBe("0.5");
            expect(store.loading).toBe(false);
            expect(store.error).toBeNull();
            expect(CONFIG_DOMAINS).not.toContain("agent-templates");
            expect(INSTANCE_DOMAINS).toContain("agent-templates");
            expect(requestedDomains).not.toContain("agent-templates");
            expect(store.mergedConfig["agent-templates"]).toBeUndefined();
        });

        it("loadAllDomains sets error on failure", async () => {
            vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));
            const store = useConfigStore();

            await store.loadAllDomains();

            expect(store.error).toBe("Network error");
            expect(store.loading).toBe(false);
        });
    });

    describe("getEffectiveModel", () => {
        it("resolves a bound connection without treating its UUID as the provider", () => {
            const store = useConfigStore();
            seedReadyModel(store, "openai", "gpt-4o");
            const catalog = store.modelCache.providers!.openai;
            store.modelCache.providers = {
                "connection-a": { ...catalog, connectionId: "connection-a" },
                "connection-b": { ...catalog, connectionId: "connection-b", status: "unreachable" },
            };
            store.setSessionModel("s1", "openai", "gpt-4o", "connection-a", 3);
            expect(store.getEffectiveModel("s1")).toEqual({
                provider: "openai",
                model: "gpt-4o",
                connectionId: "connection-a",
                connectionRevision: 3,
            });
            store.setSessionModel("s1", "openai", "gpt-4o", "connection-b");
            expect(store.getEffectiveModel("s1")).toBeUndefined();
            store.setSessionModel("s1", "openai", "gpt-4o", "missing-connection");
            expect(store.getEffectiveModel("s1")).toBeUndefined();
            store.setSessionModel("s1", "deepseek", "gpt-4o", "connection-a");
            expect(store.getEffectiveModel("s1")).toBeUndefined();
        });

        it("keeps provider-based callers and unbound defaults on real provider IDs", () => {
            const store = useConfigStore();
            seedReadyModel(store, "openai", "gpt-4o");
            const catalog = store.modelCache.providers!.openai;
            store.modelCache.providers = {
                "connection-a": { ...catalog, connectionId: "connection-a" },
                "connection-b": {
                    ...catalog,
                    connectionId: "connection-b",
                    models: [{ name: "gpt-4.1", capabilities: { chat: true } }],
                },
            };
            expect(store.findProviderForModel("gpt-4o")).toBe("openai");
            expect(store.getChatModels("openai")).toEqual(["gpt-4o", "gpt-4.1"]);
            expect(store.getChatModels("connection-a")).toEqual([]);
            expect(store.isChatModelAvailable("openai", "gpt-4.1", "connection-a")).toBe(false);
            expect(store.isChatModelAvailable("openai", "gpt-4.1", "connection-b")).toBe(true);
            store.mergedConfig = {
                "llm-provider": {
                    profile: JSON.stringify({
                        providerId: "openai",
                        connectionKey: "default",
                        model: "gpt-4o",
                    }),
                },
            };
            expect(store.getEffectiveModel("s1")).toEqual({ provider: "openai", model: "gpt-4o" });
            store.setSessionModel("s1", "openai", "gpt-4.1");
            expect(store.getEffectiveModel("s1")).toEqual({ provider: "openai", model: "gpt-4.1" });
        });

        it("returns session binding when set", () => {
            const store = useConfigStore();
            seedReadyModel(store, "deepseek", "deepseek-chat");
            store.setSessionModel("s1", "deepseek", "deepseek-chat");

            expect(store.getEffectiveModel("s1")).toEqual({
                provider: "deepseek",
                model: "deepseek-chat",
            });
        });

        it("resolves the merged profile unit (PLAN-0504)", () => {
            const store = useConfigStore();
            store.mergedConfig = {
                "llm-provider": {
                    profile: JSON.stringify({
                        providerId: "openai",
                        connectionKey: "default",
                        model: "gpt-4o",
                    }),
                },
            };
            seedReadyModel(store, "openai", "gpt-4o");

            expect(store.getEffectiveModel("s1")).toEqual({ provider: "openai", model: "gpt-4o" });
        });

        it("has no implicit fallback when no profile exists (decision #10)", () => {
            const store = useConfigStore();
            seedReadyModel(store, "deepseek", "deepseek-chat");

            expect(store.getEffectiveModel("s1")).toBeUndefined();

            // Legacy keys have no compat reads.
            store.mergedConfig = {
                "llm-provider": { defaultProvider: "deepseek", defaultModel: "deepseek-chat" },
            };
            expect(store.getEffectiveModel("s1")).toBeUndefined();
        });

        it("does not substitute a provider default when the profile model is unavailable", () => {
            const store = useConfigStore();
            seedReadyModel(store, "anthropic", "claude-sonnet-4-20250514");
            store.mergedConfig = {
                "llm-provider": {
                    profile: JSON.stringify({
                        providerId: "anthropic",
                        connectionKey: "default",
                        model: "gone-model",
                    }),
                },
            };

            expect(store.getEffectiveModel("s1")).toBeUndefined();
        });

        it("returns undefined when no binding or config exists", () => {
            const store = useConfigStore();
            expect(store.getEffectiveModel("s1")).toBeUndefined();
        });

        it("session binding takes precedence over the merged profile", () => {
            const store = useConfigStore();
            seedReadyModel(store, "deepseek", "deepseek-reasoner");
            store.setSessionModel("s1", "deepseek", "deepseek-reasoner");
            store.mergedConfig = {
                "llm-provider": {
                    profile: JSON.stringify({
                        providerId: "openai",
                        connectionKey: "default",
                        model: "gpt-4o",
                    }),
                },
            };

            expect(store.getEffectiveModel("s1")).toEqual({
                provider: "deepseek",
                model: "deepseek-reasoner",
            });
        });

        it("returns the ready chat union when the provider filter is empty (PLAN-0503)", () => {
            const store = useConfigStore();
            store.modelCache = {
                models: {},
                providers: {
                    openai: {
                        providerId: "openai",
                        status: "ready",
                        models: [
                            { name: "gpt-4o", capabilities: { chat: true } },
                            { name: "gpt-4o-mini-tts", capabilities: { chat: false } },
                        ],
                    },
                    deepseek: {
                        providerId: "deepseek",
                        status: "ready",
                        models: [{ name: "deepseek-chat", capabilities: { chat: true } }],
                    },
                },
            };

            expect(store.getChatModels("")).toEqual(["gpt-4o", "deepseek-chat"]);
        });

        it("ignores provider-less legacy bindings so merged defaults win (PLAN-0503 review)", () => {
            const store = useConfigStore();
            seedReadyModel(store, "openai", "gpt-4o");
            store.mergedConfig = {
                "llm-provider": {
                    profile: JSON.stringify({
                        providerId: "openai",
                        connectionKey: "default",
                        model: "gpt-4o",
                    }),
                },
            };
            // Migration writes provider "" when a legacy string binding cannot be
            // attributed; availability is unverifiable, so defaults must win.
            store.setSessionModel("s1", "", "gpt-4o");

            expect(store.getEffectiveModel("s1")).toEqual({ provider: "openai", model: "gpt-4o" });
        });
    });

    describe("findProviderForModel", () => {
        it("finds provider from modelCache", () => {
            const store = useConfigStore();
            seedReadyModel(store, "openai", "gpt-4o");

            expect(store.findProviderForModel("gpt-4o")).toBe("openai");
        });

        it("returns undefined when model is not in cache", () => {
            const store = useConfigStore();
            store.modelCache = { models: {}, providers: {} };

            expect(store.findProviderForModel("unknown")).toBeUndefined();
        });
    });

    describe("fetchModels", () => {
        it("populates modelCache on success", async () => {
            vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(JSON.stringify({ models: { deepseek: ["deepseek-chat"] } }), {
                    status: 200,
                }),
            );
            const store = useConfigStore();

            await store.fetchModels();

            expect(store.modelCache.models).toEqual({ deepseek: ["deepseek-chat"] });
        });

        it("sets modelError on failure", async () => {
            vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));
            const store = useConfigStore();

            await store.fetchModels();

            expect(store.modelError).toBe("Network error");
        });
    });

    describe("user switch isolation", () => {
        it("clears config, model, session and favorite caches", () => {
            const store = useConfigStore();
            store.mergedConfig = { "llm-provider": { temperature: "0.5" } };
            store.modelCache = {
                models: { openai: ["gpt-4o"] },
                providers: {
                    openai: {
                        providerId: "openai",
                        status: "ready",
                        models: [{ name: "gpt-4o", capabilities: { chat: true } }],
                    },
                },
            };
            store.setSessionModel("session-a", "openai", "gpt-4o");
            store.toggleFavorite("openai", "gpt-4o");

            store.clearForUserSwitch();

            expect(store.mergedConfig).toEqual({});
            expect(store.modelCache).toEqual({ models: {}, providers: {} });
            expect(store.getActiveModel("session-a")).toBeUndefined();
            expect(store.modelFavorites).toEqual([]);
        });
    });

    describe("layer config (PLAN-0307 T2.17)", () => {
        function mockLayerFetch() {
            const calls: { url: string; init?: RequestInit }[] = [];
            vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
                const url = typeof input === "string" ? input : input.url;
                calls.push({ url, init: init ?? undefined });
                const parsed = new URL(url, "http://localhost"),
                    domain = parsed.pathname.split("/").pop() ?? "",
                    layer = parsed.searchParams.get("layer") ?? "";
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            domain,
                            entries: { [`${layer}-${domain}-key`]: "value" },
                            envOverridden: domain === "embedding" ? { model: "env-model" } : {},
                        }),
                        { status: 200 },
                    ),
                );
            });
            return calls;
        }

        it("loadLayerDomains fetches only the layer domain set with includeMeta", async () => {
            const calls = mockLayerFetch();
            const store = useConfigStore();

            await store.loadLayerDomains("workspace", "ws-1");

            // Workspace includes approval-policy, agent-templates, context-templates, and job-policy.
            // Each domain now issues a config read plus a PLAN-0554 meta read.
            const domainCalls = calls.filter((call) => !call.url.includes("/meta"));
            const metaCalls = calls.filter((call) => call.url.includes("/meta"));
            expect(domainCalls).toHaveLength(9);
            expect(metaCalls).toHaveLength(9);
            for (const call of domainCalls) {
                expect(call.url).toContain("layer=workspace");
                expect(call.url).toContain("includeMeta=true");
                expect(call.url).toContain("workspaceId=ws-1");
            }
            for (const call of metaCalls) {
                expect(call.url).toContain("layer=workspace");
                expect(call.url).not.toContain("includeMeta=true");
                expect(call.url).toContain("workspaceId=ws-1");
            }
            expect(Object.keys(store.layerConfig.workspace)).toHaveLength(9);
            expect(store.layerConfig.workspace["embedding"]).toEqual({
                "workspace-embedding-key": "value",
            });
            expect(store.envOverridden["embedding"]).toEqual({ model: "env-model" });
            expect(store.envOverridden["rag"]).toEqual({});
        });

        it("job-policy is instance+workspace writable but absent from the user layer (PLAN-0373)", async () => {
            const calls = mockLayerFetch(),
                store = useConfigStore();

            expect(INSTANCE_DOMAINS).toContain("job-policy");
            expect(LAYER_DOMAINS.workspace).toContain("job-policy");
            expect(LAYER_DOMAINS.user).not.toContain("job-policy");

            await store.loadLayerDomains("instance");
            expect(calls.some((c) => c.url.includes("/config/job-policy?layer=instance"))).toBe(
                true,
            );
            expect(Object.keys(store.layerConfig.instance)).toHaveLength(INSTANCE_DOMAINS.length);

            await store.loadLayerDomains("user");
            expect(store.layerConfig.user["job-policy"]).toBeUndefined();
        });

        it("loadLayerDomains loads all nine user domains without workspace query", async () => {
            const calls = mockLayerFetch(),
                store = useConfigStore();

            await store.loadLayerDomains("user");

            const domainCalls = calls.filter((call) => !call.url.includes("/meta"));
            const metaCalls = calls.filter((call) => call.url.includes("/meta"));
            expect(domainCalls).toHaveLength(9);
            expect(metaCalls).toHaveLength(9);
            for (const call of calls) {
                expect(call.url).toContain("layer=user");
                expect(call.url).not.toContain("workspaceId=");
            }
            expect(
                calls.some((call) => call.url.includes("/config/agent-templates?layer=user")),
            ).toBe(true);
            expect(store.layerConfig.user["logging"]).toBeUndefined();
        });

        it("putLayerConfig targets the layer endpoint with workspace query", async () => {
            const calls = mockLayerFetch(),
                store = useConfigStore();

            await store.putLayerConfig("workspace", "rag", { topK: "5" }, "ws-2");
            await store.putLayerConfig("user", "agent-profile", { userName: "zero" });
            await store.putLayerConfig("instance", "logging", { logLevel: "DEBUG" });

            expect(calls[0].url).toContain("/config/workspace/rag?workspaceId=ws-2");
            expect(calls[0].init?.method).toBe("PUT");
            expect(calls[0].init?.body).toBe(JSON.stringify({ topK: "5" }));
            expect(calls[1].url).toContain("/config/user/agent-profile");
            expect(calls[2].url).toContain("/config/instance/logging");
        });

        it("exportConfig/importConfig use the instance management endpoints", async () => {
            const calls = mockLayerFetch(),
                store = useConfigStore(),
                exported = await store.exportConfig(false);
            await store.importConfig('{"logging":{"logLevel":"INFO"}}');

            expect(calls[0].url).toContain("/config/export?layer=instance&includeSecrets=false");
            expect(exported).toContain('"domain"');
            expect(calls[1].url).toContain("/config/import?layer=instance");
            expect(calls[1].init?.method).toBe("POST");
        });

        it("clearForUserSwitch clears layer state and env locks", async () => {
            mockLayerFetch();
            const store = useConfigStore();
            await store.loadLayerDomains("instance");
            expect(Object.keys(store.layerConfig.instance).length).toBeGreaterThan(0);

            store.clearForUserSwitch();

            expect(store.layerConfig).toEqual({ instance: {}, workspace: {}, user: {} });
            expect(store.envOverridden).toEqual({});
        });
    });
});
