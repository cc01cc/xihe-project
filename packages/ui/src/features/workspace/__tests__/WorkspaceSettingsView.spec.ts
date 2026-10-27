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
        parsed = new URL(url, "http://localhost");
    if (parsed.pathname.includes("/api/v1/workspaces/")) {
        if ((input as Request).method === "DELETE") {
            return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.resolve(
            new Response(
                JSON.stringify({ id: WORKSPACE_ID, name: "Workspace", workspaceRole: "OWNER" }),
                { status: 200 },
            ),
        );
    }
    const layer = parsed.searchParams.get("layer");
    if (!layer) {
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }
    const domain = parsed.pathname.split("/").pop() ?? "",
        entries = domain === "job-policy" ? { defaultTimeoutSecs: "3600" } : {};
    return Promise.resolve(
        new Response(JSON.stringify({ domain, entries, envOverridden: {} }), { status: 200 }),
    );
}

async function mountView(options: { attachTo?: boolean } = {}) {
    const { default: WorkspaceSettingsView } = await import("../pages/WorkspaceSettingsView.vue"),
        wrapper = mount(WorkspaceSettingsView, {
            ...(options.attachTo ? { attachTo: document.body } : {}),
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

describe("WorkspaceSettingsView OWNER 编辑与删除 (PLAN-0560 T2.6/T3.3 迁移)", () => {
    async function mountOwner() {
        // migrateLegacyWorkspace 会把 localStorage 旧键归一化为 {id,name}，
        // 角色必须直写 per-tab sessionStorage 才能进入 OWNER 分支。
        localStorage.removeItem("xihe-workspace");
        sessionStorage.setItem(
            "xihe-workspace",
            JSON.stringify({
                id: WORKSPACE_ID,
                name: "Workspace",
                workspaceRole: "OWNER",
                ownerId: "u1",
            }),
        );
        return await mountView({ attachTo: true });
    }

    async function setBodyInput(id: string, value: string) {
        // AlertDialog content is teleported outside the wrapper tree; use native events.
        // Portal mount can be rAF-deferred under jsdom, so poll instead of single nextTick.
        await vi.waitFor(() => {
            expect(document.body.querySelector(`#${id}`)).toBeTruthy();
        });
        const input = document.body.querySelector(`#${id}`) as HTMLInputElement | null;
        input!.value = value;
        input!.dispatchEvent(new Event("input", { bubbles: true }));
    }

    it("saves rename via updateWorkspace", async () => {
        const wrapper = await mountOwner();

        await wrapper.find('[data-testid="ws-settings-name-input"]').setValue("Renamed");
        await wrapper.find('[data-testid="ws-settings-save"]').trigger("click");
        await flushPromises();

        const request = vi.mocked(fetch).mock.calls.find(([input, init]) => {
            const url = typeof input === "string" ? input : input.url;
            return url.includes(`/api/v1/workspaces/${WORKSPACE_ID}`) && init?.method === "PATCH";
        });
        expect(request).toBeTruthy();
        expect(JSON.parse(String(request?.[1]?.body))).toEqual(
            expect.objectContaining({ name: "Renamed" }),
        );
        wrapper.unmount();
    });

    it("requires exact workspace name before deleting", async () => {
        const wrapper = await mountOwner();

        await wrapper.find('[data-testid="ws-settings-delete"]').trigger("click");
        await setBodyInput("ws-delete-confirm-input", "Wrong Name");
        const confirmBtn = () =>
            document.body.querySelector(
                '[data-testid="ws-delete-confirm-btn"]',
            ) as HTMLButtonElement | null;
        await vi.waitFor(() => expect(confirmBtn()).toBeTruthy());
        confirmBtn()!.click();
        await flushPromises();

        const deleteCalls = () =>
            vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "DELETE");
        expect(deleteCalls().length).toBe(0);
        // guard keeps the dialog open (regression: AlertDialogAction auto-close)
        expect(document.body.querySelector("#ws-delete-confirm-input")).toBeTruthy();

        await setBodyInput("ws-delete-confirm-input", "Workspace");
        confirmBtn()!.click();
        await flushPromises();

        expect(deleteCalls().length).toBe(1);
        expect(routerSpies.replace).toHaveBeenCalledWith({ name: "workspace-home" });
        wrapper.unmount();
    });
});

describe("WorkspaceSettingsView 权限一致性 (PLAN-0560 T3.6)", () => {
    it("hides general mutations for VIEWER", async () => {
        localStorage.removeItem("xihe-workspace");
        sessionStorage.setItem(
            "xihe-workspace",
            JSON.stringify({
                id: WORKSPACE_ID,
                name: "Workspace",
                workspaceRole: "VIEWER",
                ownerId: "someone-else",
            }),
        );
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="ws-settings-edit"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="ws-settings-delete"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="ws-settings-save"]').exists()).toBe(false);
        // 头部动作组仍可用（新建对话/环境状态/返回工作区均为只读导航动作）。
        expect(wrapper.find('[data-testid="ws-settings-new-chat"]').exists()).toBe(true);
        wrapper.unmount();
    });
});
