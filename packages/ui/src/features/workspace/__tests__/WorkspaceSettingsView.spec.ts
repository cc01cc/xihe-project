import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { RouteLocationNormalizedLoaded } from "vue-router";
import { i18n } from "../../../i18n";
import { LAYER_DOMAINS } from "../../../stores/config";

const routeState = vi.hoisted(() => ({
    workspaceId: "66666666-6666-4666-8666-666666666666",
    query: {} as Record<string, string>,
}));

const routerSpies = vi.hoisted(() => ({
    push: vi.fn<(location: unknown) => Promise<void>>(),
    replace: vi.fn<(location: unknown) => Promise<void>>(),
}));

vi.mock("vue-router", () => ({
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
            name: "workspace-settings",
            path: `/workspace/${routeState.workspaceId}/settings`,
            params: { workspaceId: routeState.workspaceId },
            query: routeState.query,
            hash: "",
            fullPath: `/workspace/${routeState.workspaceId}/settings`,
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
 * PLAN-0560 M1：WorkspaceSettingsView 承载 workspace 层配置与 MCP。
 * fetch 对 config 域返回 layer envelope；工作区上下文由 selectWorkspace
 * 的缓存短路提供（fixture 带 name），不额外请求 /workspaces/{id}。
 */
function mockConfigFetch() {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => mockConfigFetchResponse(input));
}

function mockConfigFetchResponse(input: RequestInfo | URL): Promise<Response> {
    const url = typeof input === "string" ? input : input.url,
        parsed = new URL(url, "http://localhost"),
        layer = parsed.searchParams.get("layer");
    if (!layer) {
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }
    const domain = parsed.pathname.split("/").pop() ?? "",
        entries = domain === "job-policy" ? { defaultTimeoutSecs: "3600" } : {};
    return Promise.resolve(
        new Response(JSON.stringify({ domain, entries, envOverridden: {} }), { status: 200 }),
    );
}

async function mountView() {
    const { default: WorkspaceSettingsView } = await import("../pages/WorkspaceSettingsView.vue"),
        wrapper = mount(WorkspaceSettingsView, {
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
    sessionStorage.clear();
    vi.clearAllMocks();
    routeState.workspaceId = WORKSPACE_ID;
    routeState.query = {};
    localStorage.setItem("xihe-token", "test-token");
    localStorage.setItem(
        "xihe-user",
        JSON.stringify({ id: "u1", email: "admin@xihe.local", role: "ADMIN" }),
    );
    localStorage.setItem("xihe-workspace", JSON.stringify({ id: WORKSPACE_ID, name: "Workspace" }));
    mockConfigFetch();
});

describe("WorkspaceSettingsView (PLAN-0560)", () => {
    it("renders the workspace header and the three tabs", async () => {
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="workspace-settings-page"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="workspace-settings-kicker"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="ws-settings-tab-general"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="ws-settings-tab-config"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="ws-settings-tab-mcp"]').exists()).toBe(true);
        wrapper.unmount();
    });

    it("shows the workspace general info on the default tab", async () => {
        const wrapper = await mountView();

        const general = wrapper.find('[data-testid="ws-settings-general"]');
        expect(general.exists()).toBe(true);
        expect(wrapper.find('[data-testid="ws-settings-name"]').text()).toBe("Workspace");
        wrapper.unmount();
    });

    it("renders job-policy on the workspace layer config tab", async () => {
        routeState.query = { tab: "config" };
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="config-domain-job-policy"]').exists()).toBe(true);
        const panel = wrapper.find('[data-testid="config-domain-job-policy"]');
        await panel.find("button").trigger("click");
        expect(
            wrapper.find('[data-testid="config-field-job-policy-defaultTimeoutSecs"]').exists(),
        ).toBe(true);
        wrapper.unmount();
    });

    it("hides agent-runtime ceiling keys on the workspace layer", async () => {
        routeState.query = { tab: "config" };
        const wrapper = await mountView();

        const panel = wrapper.find('[data-testid="config-domain-agent-runtime"]');
        expect(panel.exists()).toBe(true);
        await panel.find("button").trigger("click");
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
        wrapper.unmount();
    });

    it("loads config lazily when switching to the config tab", async () => {
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="config-domain-job-policy"]').exists()).toBe(false);
        await wrapper.find('[data-testid="ws-settings-tab-config"]').trigger("click");
        await flushPromises();
        expect(wrapper.find('[data-testid="config-domain-job-policy"]').exists()).toBe(true);
        const request = vi.mocked(fetch).mock.calls.find(([input]) => {
            const url = typeof input === "string" ? input : input.url;
            return url.includes("layer=workspace") && url.includes(`workspaceId=${WORKSPACE_ID}`);
        });
        expect(request).toBeTruthy();
        wrapper.unmount();
    });

    it("renders the MCP panel on the mcp tab", async () => {
        routeState.query = { tab: "mcp" };
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="ws-settings-mcp"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="mcp-config-textarea"]').exists()).toBe(true);
        wrapper.unmount();
    });

    it("keeps workspace-layer domains out of user-only lists (sanity)", () => {
        expect(LAYER_DOMAINS.workspace).toContain("job-policy");
        expect(LAYER_DOMAINS.workspace).toContain("llm-provider");
    });
});
