import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import type { RouteLocationNormalizedLoaded } from "vue-router";
import { i18n } from "../../../i18n";
import {
    CONFIG_DOMAINS,
    INSTANCE_DOMAINS,
    LAYER_DOMAINS,
    useConfigStore,
} from "../../../stores/config";
import type { ModelCache } from "../../../types/provider";

vi.mock("vue-router", () => ({
    useRoute: () =>
        ({
            name: "settings-config",
            path: "/settings/config",
            params: {},
            query: {},
            hash: "",
            fullPath: "/settings/config",
            matched: [],
            redirectedFrom: undefined,
            meta: {},
        }) as RouteLocationNormalizedLoaded,
    useRouter: () => ({
        push: vi.fn<(location: unknown) => Promise<void>>(),
        replace: vi.fn<(location: unknown) => Promise<void>>(),
    }),
    RouterLink: { template: "<a><slot /></a>" },
}));

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message?: unknown) => string | number>(),
        error: vi.fn<(message?: unknown) => string | number>(),
        warning: vi.fn<(message?: unknown) => string | number>(),
        info: vi.fn<(message?: unknown) => string | number>(),
    },
}));

const WORKSPACE_ID = "66666666-6666-4666-8666-666666666666";

/**
 * PLAN-0373 T2.2：job-policy 域表单渲染、env 锁定态来源徽标、三层域列表可见性。
 * fetch 返回 layer envelope；job-policy 模拟 env 注入（defaultTimeoutSecs 锁定为 7200）。
 */
function mockConfigFetch() {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => mockConfigFetchResponse(input));
}

function mockConfigFetchResponse(input: RequestInfo | URL): Promise<Response> {
    const url = typeof input === "string" ? input : input.url,
        parsed = new URL(url, "http://localhost"),
        domain = parsed.pathname.split("/").pop() ?? "",
        layer = parsed.searchParams.get("layer");
    if (!layer) {
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }
    const entries =
            domain === "job-policy" ? { defaultTimeoutSecs: "3600", maxTimeoutSecs: "0" } : {},
        envOverridden = domain === "job-policy" ? { defaultTimeoutSecs: "7200" } : {};
    return Promise.resolve(
        new Response(JSON.stringify({ domain, entries, envOverridden }), { status: 200 }),
    );
}

async function mountView() {
    const { default: ConfigSettings } = await import("../ConfigSettings.vue"),
        wrapper = mount(ConfigSettings, {
            global: {
                plugins: [i18n],
                stubs: { ProviderHub: true, McpStdioServerList: true },
            },
        });
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.clearAllMocks();
    localStorage.setItem("xihe-token", "test-token");
    localStorage.setItem(
        "xihe-user",
        JSON.stringify({ id: "u1", email: "admin@xihe.local", role: "ADMIN" }),
    );
    localStorage.setItem("xihe-workspace", JSON.stringify({ id: WORKSPACE_ID, name: "Workspace" }));
    mockConfigFetch();
});

describe("ConfigSettings job-policy (PLAN-0373)", () => {
    it("store domain lists register job-policy on instance+workspace only", () => {
        expect(INSTANCE_DOMAINS).toContain("job-policy");
        expect(LAYER_DOMAINS.instance).toContain("job-policy");
        expect(LAYER_DOMAINS.workspace).toContain("job-policy");
        expect(LAYER_DOMAINS.user).not.toContain("job-policy");
    });

    it("renders the job-policy panel with both fields on the instance tab", async () => {
        const wrapper = await mountView();

        const panel = wrapper.find('[data-testid="config-domain-job-policy"]');
        expect(panel.exists()).toBe(true);
        await panel.find("button").trigger("click");

        const defaultField = wrapper.find(
                '[data-testid="config-field-job-policy-defaultTimeoutSecs"]',
            ),
            maxField = wrapper.find('[data-testid="config-field-job-policy-maxTimeoutSecs"]');
        expect(defaultField.exists()).toBe(true);
        expect(maxField.exists()).toBe(true);
        // defaultTimeoutSecs 被 env 注入锁定（mock 返回 7200），行内不渲染 input；
        // maxTimeoutSecs 保持可编辑。
        expect(defaultField.find("input").exists()).toBe(false);
        expect(maxField.find("input").exists()).toBe(true);
    });

    it("locks defaultTimeoutSecs behind the env badge and keeps maxTimeoutSecs editable", async () => {
        const wrapper = await mountView();

        const panel = wrapper.find('[data-testid="config-domain-job-policy"]');
        await panel.find("button").trigger("click");

        const lockedRow = wrapper.find(
                '[data-testid="config-field-job-policy-defaultTimeoutSecs"]',
            ),
            lock = wrapper.find('[data-testid="config-env-lock-job-policy-defaultTimeoutSecs"]');
        expect(lock.exists()).toBe(true);
        expect(lock.text()).toBe("7200");
        expect(lockedRow.find("input").exists()).toBe(false);
        // 来源徽标（env）与锁定值同行呈现，复用 approval-policy/embedding 的 env 呈现。
        const badge = lockedRow.findAll("span").find((span) => span.text().toLowerCase() === "env");
        expect(badge).toBeTruthy();

        const maxRow = wrapper.find('[data-testid="config-field-job-policy-maxTimeoutSecs"]');
        expect(maxRow.find("input").exists()).toBe(true);
    });

    it("shows job-policy on the workspace tab and hides it from the user tab", async () => {
        const wrapper = await mountView();

        await wrapper.find('[data-testid="config-tab-workspace"]').trigger("click");
        await flushPromises();
        expect(wrapper.find('[data-testid="config-domain-job-policy"]').exists()).toBe(true);

        await wrapper.find('[data-testid="config-tab-user"]').trigger("click");
        await flushPromises();
        expect(wrapper.find('[data-testid="config-domain-job-policy"]').exists()).toBe(false);
    });
});

describe("ConfigSettings Agent template and approval policy (PLAN-0374)", () => {
    it("registers agent-templates on all writable layers", () => {
        expect(INSTANCE_DOMAINS).toContain("agent-templates");
        expect(LAYER_DOMAINS.instance).toContain("agent-templates");
        expect(LAYER_DOMAINS.user).toContain("agent-templates");
        expect(LAYER_DOMAINS.workspace).toContain("agent-templates");
    });

    it("renders the structured template editor while keeping approval action classes in approval-policy", async () => {
        const wrapper = await mountView();

        const templatesPanel = wrapper.find('[data-testid="agent-templates-panel"]');
        expect(templatesPanel.exists()).toBe(true);
        expect(wrapper.find('[data-testid="agent-template-prompt"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="agent-template-role"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="agent-template-provider"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="agent-template-model"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="agent-template-secret"]').exists()).toBe(false);

        const approvalPanel = wrapper.find('[data-testid="config-domain-approval-policy"]');
        expect(approvalPanel.exists()).toBe(true);
        await approvalPanel.find("button").trigger("click");
        expect(
            wrapper
                .find('[data-testid="config-field-approval-policy-askActionClasses"] textarea')
                .exists(),
        ).toBe(true);
    });

    it("keeps approval-policy workspace-only while showing agent-templates in user settings", async () => {
        const wrapper = await mountView();

        await wrapper.find('[data-testid="config-tab-user"]').trigger("click");
        await flushPromises();
        expect(wrapper.find('[data-testid="agent-templates-panel"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="config-domain-approval-policy"]').exists()).toBe(false);
    });

    it("saves askActionClasses as a JSON array value through the selected config layer", async () => {
        const wrapper = await mountView(),
            panel = wrapper.find('[data-testid="config-domain-approval-policy"]');
        await panel.find("button").trigger("click");

        const field = wrapper.find(
            '[data-testid="config-field-approval-policy-askActionClasses"] textarea',
        );
        await field.setValue('["CREATE_TEMPLATE"]');
        const saveLabel = i18n.global.t("common.save"),
            saveButton = panel.findAll("button").find((button) => button.text() === saveLabel);
        expect(saveButton).toBeTruthy();
        await saveButton!.trigger("click");
        await flushPromises();

        const request = vi.mocked(fetch).mock.calls.find(([input, init]) => {
            const url = typeof input === "string" ? input : input.url;
            return (
                url.includes("/api/v1/config/instance/approval-policy") && init?.method === "PUT"
            );
        });
        expect(request).toBeTruthy();
        expect(JSON.parse(String(request?.[1]?.body))).toEqual({
            askActionClasses: '["CREATE_TEMPLATE"]',
        });
    });
});

describe("ConfigSettings API request templates (PLAN-0439 rename of PLAN-0414)", () => {
    it("registers api-request-templates on all writable layers and never in merged config", () => {
        expect(INSTANCE_DOMAINS).toContain("api-request-templates");
        expect(LAYER_DOMAINS.instance).toContain("api-request-templates");
        expect(LAYER_DOMAINS.user).toContain("api-request-templates");
        expect(LAYER_DOMAINS.workspace).toContain("api-request-templates");
        expect(CONFIG_DOMAINS).not.toContain("api-request-templates");
    });

    it("renders the api request editor panel with an empty layer", async () => {
        const wrapper = await mountView();

        const panel = wrapper.find('[data-testid="api-request-templates-panel"]');
        expect(panel.exists()).toBe(true);
        expect(wrapper.text()).toContain(i18n.global.t("settings.apiRequest.empty"));
        wrapper.unmount();
    });

    it("flags metadata load failure through the panel error surface", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
            const url = typeof input === "string" ? input : input.url;
            if (url.includes("/api-input-types") || url.includes("api-request-templates")) {
                return Promise.resolve(new Response("{}", { status: 500 }));
            }
            return mockConfigFetchResponse(input);
        });
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="api-request-templates-panel"]').exists()).toBe(true);
        expect(wrapper.text()).toContain(i18n.global.t("settings.apiRequest.loadFailed"));
        wrapper.unmount();
    });
});

describe("ConfigSettings llm-provider profile (PLAN-0504)", () => {
    const PROFILE_XIAOMI = JSON.stringify({
        providerId: "xiaomi",
        connectionKey: "default",
        model: "mimo-v2.5",
    });

    function chatConnection(overrides: Record<string, unknown> = {}) {
        return {
            id: "conn-x",
            providerId: "xiaomi",
            connectionKey: "default",
            apiTypeId: "mimo-responses",
            apiTypeVersion: 1,
            operation: "chat",
            label: "Xiaomi",
            scope: "USER",
            modelDiscovery: "remote-models",
            manualModels: [],
            hasKey: true,
            enabled: true,
            status: "READY",
            revision: 1,
            ...overrides,
        };
    }

    function mockFetchWithProfile(options: {
        catalog?: unknown;
        catalogStatus?: number;
        models?: unknown;
        llmEntries?: Record<string, string>;
        connections?: unknown[];
    }) {
        vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
            const url = typeof input === "string" ? input : input.url;
            const parsed = new URL(url, "http://localhost");
            if (parsed.pathname.endsWith("/provider-catalog")) {
                if (options.catalogStatus && options.catalogStatus !== 200) {
                    return Promise.resolve(new Response("{}", { status: options.catalogStatus }));
                }
                return Promise.resolve(
                    new Response(
                        JSON.stringify(
                            options.catalog ?? { catalogRevision: "test", providers: [] },
                        ),
                        { status: 200 },
                    ),
                );
            }
            if (parsed.pathname.endsWith("/provider-connections")) {
                return Promise.resolve(
                    new Response(JSON.stringify({ connections: options.connections ?? [] }), {
                        status: 200,
                    }),
                );
            }
            if (parsed.pathname.endsWith("/models")) {
                return Promise.resolve(
                    new Response(JSON.stringify(options.models ?? {}), { status: 200 }),
                );
            }
            const layer = parsed.searchParams.get("layer");
            if (!layer) return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
            const domain = parsed.pathname.split("/").pop() ?? "",
                entries = domain === "llm-provider" ? (options.llmEntries ?? {}) : {};
            return Promise.resolve(
                new Response(JSON.stringify({ domain, entries, envOverridden: {} }), {
                    status: 200,
                }),
            );
        });
    }

    const readyXiaomiModels: ModelCache = {
        models: {},
        providers: {
            "conn-x": {
                connectionId: "conn-x",
                providerId: "xiaomi",
                status: "ready",
                models: [
                    { name: "mimo-v2.5", capabilities: { chat: true } },
                    { name: "mimo-v2.5-asr", capabilities: { chat: false } },
                    { name: "mimo-v2.6-pro", capabilities: { chat: true } },
                ],
                verifiedAt: "2026-10-13T10:00:00Z",
            },
        },
        configRevision: "rev-models",
    };

    async function openLlmPanel(wrapper: VueWrapper) {
        const panel = wrapper.find('[data-testid="config-domain-llm-provider"]');
        expect(panel.exists()).toBe(true);
        await panel.find("button").trigger("click");
        return panel;
    }

    function optionValues(wrapper: VueWrapper, testId: string) {
        return wrapper
            .find(`[data-testid="${testId}"]`)
            .findAll("option")
            .map((option) => (option.element as HTMLOptionElement).value);
    }

    async function saveProfile(wrapper: VueWrapper) {
        await wrapper.find('[data-testid="llm-profile-save"]').trigger("click");
        await flushPromises();
    }

    function putBodies() {
        return vi
            .mocked(fetch)
            .mock.calls.filter(([, init]) => init?.method === "PUT")
            .map(([input, init]) => ({
                url: typeof input === "string" ? input : input.url,
                body: JSON.parse(String(init?.body ?? "{}")) as Record<string, string>,
            }));
    }

    it("V4: connection options come from visible chat connections; model options from the scoped directory", async () => {
        mockFetchWithProfile({ models: readyXiaomiModels, connections: [chatConnection()] });
        const wrapper = await mountView();
        await flushPromises();

        expect(optionValues(wrapper, "llm-profile-connection-select")).toEqual(["", "conn-x"]);
        await wrapper.find('[data-testid="llm-profile-connection-select"]').setValue("conn-x");

        // '' placeholder + ready chat models only (asr filtered) + custom escape.
        expect(optionValues(wrapper, "llm-profile-model-select")).toEqual([
            "",
            "mimo-v2.5",
            "mimo-v2.6-pro",
            "__custom__",
        ]);
        // The freshness note still renders on the sibling domain panel.
        await openLlmPanel(wrapper);
        await flushPromises();
        const note = wrapper.find('[data-testid="config-domain-note-llm-provider"]');
        expect(note.exists()).toBe(true);
        expect(note.text()).toContain("rev-models");
        wrapper.unmount();
    });

    it("V4: saving writes the whole profile unit for the selected connection and model", async () => {
        mockFetchWithProfile({
            models: readyXiaomiModels,
            connections: [chatConnection()],
            llmEntries: { profile: PROFILE_XIAOMI },
        });
        const wrapper = await mountView();
        await flushPromises();

        await wrapper.find('[data-testid="llm-profile-model-select"]').setValue("mimo-v2.6-pro");
        await saveProfile(wrapper);

        const llmPuts = putBodies().filter((call) =>
            call.url.includes("/config/instance/llm-provider"),
        );
        expect(llmPuts).toHaveLength(1);
        expect(llmPuts[0].body).toEqual({
            profile: JSON.stringify({
                providerId: "xiaomi",
                connectionKey: "default",
                model: "mimo-v2.6-pro",
            }),
        });
        wrapper.unmount();
    });

    it("V7: no profile shows the empty hint and save stays disabled until a connection is picked", async () => {
        mockFetchWithProfile({ models: readyXiaomiModels, connections: [chatConnection()] });
        const wrapper = await mountView();
        await flushPromises();

        expect(wrapper.find('[data-testid="llm-profile-empty-hint"]').exists()).toBe(true);
        const save = wrapper.find('[data-testid="llm-profile-save"]');
        expect(save.attributes("disabled")).toBeDefined();
        expect(
            wrapper.find('[data-testid="llm-profile-clear"]').attributes("disabled"),
        ).toBeDefined();

        await wrapper.find('[data-testid="llm-profile-connection-select"]').setValue("conn-x");
        expect(
            wrapper.find('[data-testid="llm-profile-save"]').attributes("disabled"),
        ).toBeDefined();
        await wrapper.find('[data-testid="llm-profile-model-select"]').setValue("mimo-v2.5");
        expect(
            wrapper.find('[data-testid="llm-profile-save"]').attributes("disabled"),
        ).toBeUndefined();

        await saveProfile(wrapper);
        const llmPuts = putBodies().filter((call) =>
            call.url.includes("/config/instance/llm-provider"),
        );
        expect(llmPuts).toHaveLength(1);
        expect(llmPuts[0].body).toEqual({ profile: PROFILE_XIAOMI });
        wrapper.unmount();
    });

    it("V4 decision #12: a stored profile whose connection is not visible is annotated and never rewritten", async () => {
        mockFetchWithProfile({
            connections: [],
            llmEntries: { profile: PROFILE_XIAOMI },
        });
        const wrapper = await mountView();
        await flushPromises();

        expect(wrapper.find('[data-testid="llm-profile-connection-drift"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="llm-profile-connection-drift-option"]').exists()).toBe(
            true,
        );
        // No background write before an explicit user action.
        expect(putBodies()).toHaveLength(0);

        await saveProfile(wrapper);
        const llmPuts = putBodies().filter((call) =>
            call.url.includes("/config/instance/llm-provider"),
        );
        expect(llmPuts).toHaveLength(1);
        expect(llmPuts[0].body).toEqual({ profile: PROFILE_XIAOMI });

        await wrapper.find('[data-testid="llm-profile-clear"]').trigger("click");
        await flushPromises();
        const clears = putBodies().filter((call) =>
            call.url.includes("/config/instance/llm-provider"),
        );
        expect(clears).toHaveLength(2);
        expect(clears[1].body).toEqual({ profile: "" });
        wrapper.unmount();
    });

    it("V5: model drift keeps the stored model annotated; custom entry saves a hand-written model", async () => {
        mockFetchWithProfile({
            models: readyXiaomiModels,
            connections: [chatConnection()],
            llmEntries: {
                profile: JSON.stringify({
                    providerId: "xiaomi",
                    connectionKey: "default",
                    model: "gone-model",
                }),
            },
        });
        const wrapper = await mountView();
        await flushPromises();

        const select = wrapper.find<HTMLSelectElement>('[data-testid="llm-profile-model-select"]');
        expect(select.element.value).toBe("gone-model");
        expect(optionValues(wrapper, "llm-profile-model-select")[1]).toBe("gone-model");
        expect(putBodies()).toHaveLength(0);

        // The custom escape is reversible and keeps the typed value.
        await select.setValue("__custom__");
        const input = wrapper.find('[data-testid="llm-profile-model-custom"]');
        expect(input.exists()).toBe(true);
        await input.setValue("hand-written-model");
        await wrapper.find('[data-testid="llm-profile-model-custom-exit"]').trigger("click");
        expect(wrapper.find('[data-testid="llm-profile-model-custom"]').exists()).toBe(false);
        await wrapper.find('[data-testid="llm-profile-model-select"]').setValue("__custom__");
        expect(
            wrapper.find<HTMLInputElement>('[data-testid="llm-profile-model-custom"]').element
                .value,
        ).toBe("hand-written-model");

        await saveProfile(wrapper);
        const llmPuts = putBodies().filter((call) =>
            call.url.includes("/config/instance/llm-provider"),
        );
        expect(llmPuts).toHaveLength(1);
        expect(llmPuts[0].body).toEqual({
            profile: JSON.stringify({
                providerId: "xiaomi",
                connectionKey: "default",
                model: "hand-written-model",
            }),
        });
        wrapper.unmount();
    });

    it("T2.7: directory add/remove drill keeps configuration write-free", async () => {
        mockFetchWithProfile({
            models: readyXiaomiModels,
            connections: [chatConnection()],
            llmEntries: { profile: PROFILE_XIAOMI },
        });
        const wrapper = await mountView();
        await flushPromises();
        const store = useConfigStore(),
            base = readyXiaomiModels.providers?.["conn-x"];

        // 1) Added model appears in candidates with no configuration write.
        store.modelCache = {
            ...store.modelCache,
            providers: {
                ...(store.modelCache.providers ?? {}),
                "conn-x": {
                    ...base!,
                    models: [...base!.models, { name: "mimo-v3", capabilities: { chat: true } }],
                },
            },
        };
        await nextTick();
        expect(optionValues(wrapper, "llm-profile-model-select")).toContain("mimo-v3");
        expect(putBodies()).toHaveLength(0);

        // 2) Removed model: stored value kept, marked unavailable, still no write.
        store.modelCache = {
            ...store.modelCache,
            providers: {
                "conn-x": {
                    ...base!,
                    models: base!.models.filter((model) => model.name !== "mimo-v2.5"),
                },
            },
        };
        await nextTick();
        expect(optionValues(wrapper, "llm-profile-model-select")).toContain("mimo-v2.5");
        expect(
            wrapper.find<HTMLSelectElement>('[data-testid="llm-profile-model-select"]').element
                .value,
        ).toBe("mimo-v2.5");
        expect(putBodies()).toHaveLength(0);

        // 3) Configuration read-back is unchanged.
        expect(store.layerConfig.instance["llm-provider"]?.profile).toBe(PROFILE_XIAOMI);
        wrapper.unmount();
    });

    it("0503 catalog sourcing: imageProvider options come from the catalog, not an inline list", async () => {
        mockFetchWithProfile({
            catalog: {
                catalogRevision: "catalog-rev",
                providers: [
                    { id: "openrouter", displayName: "OpenRouter" },
                    { id: "deepseek", displayName: "DeepSeek" },
                ],
            },
        });
        const wrapper = await mountView();
        await openLlmPanel(wrapper);
        await flushPromises();

        expect(optionValues(wrapper, "config-select-llm-provider-imageProvider")).toEqual([
            "openrouter",
            "deepseek",
            "",
        ]);
        wrapper.unmount();
    });

    it("0503 catalog sourcing: falls back to the builtin list when the catalog request fails", async () => {
        mockFetchWithProfile({ catalogStatus: 500 });
        const wrapper = await mountView();
        await openLlmPanel(wrapper);
        await flushPromises();

        expect(optionValues(wrapper, "config-select-llm-provider-imageProvider")).toEqual([
            "openai",
            "deepseek",
            "xiaomi",
            "anthropic",
            "",
        ]);
        wrapper.unmount();
    });
});

describe("ConfigSettings agent-runtime run budget (PLAN-0492)", () => {
    it("registers agent-runtime on the writable layers, ceilings stay instance-only", () => {
        expect(LAYER_DOMAINS.instance).toContain("agent-runtime");
        expect(LAYER_DOMAINS.workspace).toContain("agent-runtime");
        expect(LAYER_DOMAINS.user).toContain("agent-runtime");
    });

    it("renders the six budget fields on the instance tab", async () => {
        const wrapper = await mountView();

        const panel = wrapper.find('[data-testid="config-domain-agent-runtime"]');
        expect(panel.exists()).toBe(true);
        await panel.find("button").trigger("click");

        for (const key of [
            "runMaxTurns",
            "runMaxElapsedSeconds",
            "runMaxTokens",
            "runMaxTurnsCeiling",
            "runMaxElapsedSecondsCeiling",
            "runMaxTokensCeiling",
        ]) {
            const field = wrapper.find(`[data-testid="config-field-agent-runtime-${key}"]`);
            expect(field.exists(), `${key} must render on the instance tab`).toBe(true);
            expect(field.find("input").exists(), `${key} must be editable`).toBe(true);
        }
    });

    it("renders the loop guard fields on the instance tab and hides ceilings elsewhere", async () => {
        const wrapper = await mountView();

        const panel = wrapper.find('[data-testid="config-domain-agent-runtime"]');
        expect(panel.exists()).toBe(true);
        await panel.find("button").trigger("click");

        for (const key of [
            "loopRepeatWarn",
            "loopRepeatRefuse",
            "loopRepeatEscalate",
            "loopErrorRunWarn",
            "loopErrorRunEscalate",
            "loopStaleResultWarn",
            "loopStaleResultEscalate",
            "loopWindowSize",
            "loopRepeatEscalateCeiling",
            "loopErrorRunEscalateCeiling",
            "loopStaleResultEscalateCeiling",
            "loopWindowSizeCeiling",
        ]) {
            const field = wrapper.find(`[data-testid="config-field-agent-runtime-${key}"]`);
            expect(field.exists(), `${key} must render on the instance tab`).toBe(true);
            expect(field.find("input").exists(), `${key} must be editable`).toBe(true);
        }

        await wrapper.find('[data-testid="config-tab-user"]').trigger("click");
        await flushPromises();
        const userPanel = wrapper.find('[data-testid="config-domain-agent-runtime"]');
        await userPanel.find("button").trigger("click");
        expect(
            wrapper.find('[data-testid="config-field-agent-runtime-loopRepeatWarn"]').exists(),
        ).toBe(true);
        expect(
            wrapper
                .find('[data-testid="config-field-agent-runtime-loopRepeatEscalateCeiling"]')
                .exists(),
        ).toBe(false);
    });

    it("hides the ceiling keys from the user and workspace tabs", async () => {
        const wrapper = await mountView();

        await wrapper.find('[data-testid="config-tab-user"]').trigger("click");
        await flushPromises();
        const userPanel = wrapper.find('[data-testid="config-domain-agent-runtime"]');
        await userPanel.find("button").trigger("click");
        expect(
            wrapper.find('[data-testid="config-field-agent-runtime-runMaxTurns"]').exists(),
        ).toBe(true);
        expect(
            wrapper.find('[data-testid="config-field-agent-runtime-runMaxTurnsCeiling"]').exists(),
        ).toBe(false);

        await wrapper.find('[data-testid="config-tab-workspace"]').trigger("click");
        await flushPromises();
        const wsPanel = wrapper.find('[data-testid="config-domain-agent-runtime"]');
        await wsPanel.find("button").trigger("click");
        expect(
            wrapper
                .find('[data-testid="config-field-agent-runtime-runMaxElapsedSeconds"]')
                .exists(),
        ).toBe(true);
        expect(
            wrapper
                .find('[data-testid="config-field-agent-runtime-runMaxElapsedSecondsCeiling"]')
                .exists(),
        ).toBe(false);
    });
});
