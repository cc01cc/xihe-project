import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { RouteLocationNormalizedLoaded } from "vue-router";
import { i18n } from "../../../i18n";
import { CONFIG_DOMAINS, INSTANCE_DOMAINS, LAYER_DOMAINS } from "../../../stores/config";

const routerSpies = vi.hoisted(() => ({
    push: vi.fn<(location: unknown) => Promise<void>>(),
    replace: vi.fn<(location: unknown) => Promise<void>>(),
}));

vi.mock("vue-router", () => ({
    // PLAN-0546 made stores/auth import the router; the affected spec needs the
    // factory exports even though it only renders the settings view.
    createRouter: () => ({
        push: vi.fn<(location: unknown) => Promise<void>>(),
        replace: vi.fn<(location: unknown) => Promise<void>>(),
        beforeEach: vi.fn<() => void>(),
        afterEach: vi.fn<() => void>(),
        isReady: () => Promise.resolve(),
        currentRoute: { value: {} },
    }),
    createWebHistory: () => ({}),
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
    useRouter: () => routerSpies,
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
                stubs: { ProviderHub: true },
            },
        });
    await flushPromises();
    return wrapper;
}

/**
 * PLAN-0610 W5a: instance administration is the `cap:instance:admin` capability carried by
 * `/auth/me`; the retired `role` string must not grant anything.
 */
function userWithCapabilities(isInstanceAdmin: boolean, email: string) {
    return JSON.stringify({
        id: "u1",
        email,
        capabilities: { isInstanceAdmin, isInstanceSuper: false, workspaceAdminOf: [] },
    });
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
    localStorage.setItem("xihe-token", "test-token");
    localStorage.setItem("xihe-user", userWithCapabilities(true, "admin@xihe.local"));
    localStorage.setItem("xihe-workspace", JSON.stringify({ id: WORKSPACE_ID, name: "Workspace" }));
    mockConfigFetch();
});

describe("ConfigSettings job-policy (PLAN-0373)", () => {
    it("store domain lists register job-policy on the instance layer only (task-253)", () => {
        expect(INSTANCE_DOMAINS).toContain("job-policy");
        expect(LAYER_DOMAINS.instance).toContain("job-policy");
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

    it("hides job-policy from the user tab (workspace layer moved out by PLAN-0560)", async () => {
        const wrapper = await mountView();

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

describe("ConfigSettings 模型提供方分区 (PLAN-0523 T3.1)", () => {
    it("层 tab 顺序为 实例 → 个人（PLAN-0560 移除工作区页签，管理员）", async () => {
        const wrapper = await mountView();
        const tabs = wrapper
            .findAll("[data-testid^='config-tab-']")
            .map((tab) => tab.attributes("data-testid"));
        expect(tabs).toEqual(["config-tab-instance", "config-tab-user"]);
        wrapper.unmount();
    });

    it("层 tab 只剩个人（非管理员不渲染实例层）", async () => {
        localStorage.setItem("xihe-user", userWithCapabilities(false, "user@xihe.local"));
        const wrapper = await mountView();
        const tabs = wrapper
            .findAll("[data-testid^='config-tab-']")
            .map((tab) => tab.attributes("data-testid"));
        expect(tabs).toEqual(["config-tab-user"]);
        wrapper.unmount();
    });

    it("llm-provider 域渲染为单一「模型提供方」分区（kicker + 标题 + 说明）", async () => {
        const wrapper = await mountView();
        const partition = wrapper.find('[data-testid="provider-partition"]');
        expect(partition.exists()).toBe(true);
        const text = partition.text();
        expect(text).toContain("模型提供方");
        expect(text).toContain("LLM 连接与默认身份");
        wrapper.unmount();
    });

    it("实例层渲染默认偏好编辑器，不渲染连接管理", async () => {
        const wrapper = await mountView();
        // 默认激活 instance tab（管理员）。
        // PLAN-0764 T1.6（task-150）：引导块 → 可编辑的「实例默认模型」偏好。
        const partition = wrapper.find('[data-testid="provider-partition"]');
        expect(partition.text()).toContain("实例默认模型");
        // 话术必须写明解析不到连接时 409、不静默回落。
        expect(partition.text()).toContain("LLM_PROFILE_CONFLICT");
        expect(wrapper.find('[data-testid="llm-instance-default"]').exists()).toBe(true);
        expect(wrapper.find("provider-hub-stub").exists()).toBe(false);
        wrapper.unmount();
    });

    it("实例层只提供前往用户层的入口（task-253：工作区层入口已移除）", async () => {
        const wrapper = await mountView();
        const goUser = wrapper.find('[data-testid="provider-instance-go-user"]');
        expect(goUser.exists()).toBe(true);
        // task-253：工作区配置层从 UI 移除 ⇒ 那个「前往工作区层」按钮不再存在。
        expect(wrapper.find('[data-testid="provider-instance-go-workspace"]').exists()).toBe(false);

        await goUser.trigger("click");
        await flushPromises();
        expect(wrapper.find('[data-testid="config-tab-user"]').classes()).toContain(
            // PLAN-0631 色彩方案：选中指示从 --primary 改为 --brand（蓝只在"身份"位置）。
            "border-brand",
        );
        wrapper.unmount();
    });

    it("个人层在分区内渲染连接管理（ProviderHub）", async () => {
        const wrapper = await mountView();
        await wrapper.find('[data-testid="config-tab-user"]').trigger("click");
        await flushPromises();
        const partition = wrapper.find('[data-testid="provider-partition"]');
        expect(partition.exists()).toBe(true);
        expect(partition.find("provider-hub-stub").exists()).toBe(true);
        wrapper.unmount();
    });
});

describe("ConfigSettings agent-runtime run budget (PLAN-0492)", () => {
    it("registers agent-runtime on the writable layers, ceilings stay instance-only", () => {
        expect(LAYER_DOMAINS.instance).toContain("agent-runtime");
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

    it("renders the loop guard fields on the instance tab and keeps ceilings read-only elsewhere", async () => {
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
        // PLAN-0752 T3.2：实例专属键在用户层不再「静默消失」，而是只读行 + 「仅实例层」徽标
        // （design §5.1：隐藏会让用户以为没有这项）。
        const ceiling = wrapper.find(
            '[data-testid="config-field-agent-runtime-loopRepeatEscalateCeiling"]',
        );
        expect(ceiling.exists()).toBe(true);
        expect(ceiling.find("input").attributes("disabled")).toBeDefined();
        expect(
            ceiling
                .find(
                    '[data-testid="config-key-layer-badge-agent-runtime-loopRepeatEscalateCeiling"]',
                )
                .exists(),
        ).toBe(true);
    });

    it("shows the ceiling keys read-only with the instance-only badge on the user tab", async () => {
        const wrapper = await mountView();

        await wrapper.find('[data-testid="config-tab-user"]').trigger("click");
        await flushPromises();
        const userPanel = wrapper.find('[data-testid="config-domain-agent-runtime"]');
        await userPanel.find("button").trigger("click");
        expect(
            wrapper.find('[data-testid="config-field-agent-runtime-runMaxTurns"]').exists(),
        ).toBe(true);
        const ceiling = wrapper.find(
            '[data-testid="config-field-agent-runtime-runMaxTurnsCeiling"]',
        );
        expect(ceiling.exists()).toBe(true);
        expect(ceiling.find("input").attributes("disabled")).toBeDefined();
        expect(
            ceiling
                .find('[data-testid="config-key-layer-badge-agent-runtime-runMaxTurnsCeiling"]')
                .text(),
        ).not.toBe("");
        // PLAN-0560：workspace 层上限的只读呈现由 WorkspaceSettingsView.spec.ts 覆盖。
        wrapper.unmount();
    });

    // PLAN-0679 M2a (B-1): the provider-request-fingerprint switch is a
    // workspace-writable select in the existing agent-runtime panel.
    it("renders the provider-request-fingerprint switch on instance and user tabs", async () => {
        const wrapper = await mountView();

        const panel = wrapper.find('[data-testid="config-domain-agent-runtime"]');
        expect(panel.exists()).toBe(true);
        await panel.find("button").trigger("click");
        for (const tab of ["config-tab-instance", "config-tab-user"]) {
            if (tab !== "config-tab-instance") {
                await wrapper.find(`[data-testid="${tab}"]`).trigger("click");
                await flushPromises();
                const next = wrapper.find('[data-testid="config-domain-agent-runtime"]');
                await next.find("button").trigger("click");
            }
            const field = wrapper.find(
                '[data-testid="config-field-agent-runtime-providerRequestFingerprintEnabled"]',
            );
            expect(field.exists()).toBe(true);
            expect(field.find('[data-slot="select-trigger"]').exists()).toBe(true);
        }
        wrapper.unmount();
    });
});

describe("ConfigSettings 导入导出回归 (PLAN-0560 T1.5)", () => {
    it("instance 层保留导入导出区块，导出发出 instance 层请求", async () => {
        const wrapper = await mountView();

        const section = wrapper.find('[data-testid="config-import-export"]');
        expect(section.exists()).toBe(true);
        await wrapper.find('[data-testid="config-export-button"]').trigger("click");
        await flushPromises();
        const request = vi.mocked(fetch).mock.calls.find(([input, init]) => {
            const url = typeof input === "string" ? input : input.url;
            return (
                url.includes("/api/v1/config/export") &&
                url.includes("layer=instance") &&
                (!init || !init.method || init.method === "GET")
            );
        });
        expect(request).toBeTruthy();
        wrapper.unmount();
    });
});
