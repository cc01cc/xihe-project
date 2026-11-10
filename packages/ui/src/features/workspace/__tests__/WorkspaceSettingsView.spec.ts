import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { RouteLocationNormalizedLoaded } from "vue-router";
import { i18n } from "../../../i18n";
import { LAYER_DOMAINS } from "../../../stores/config";

const routeState = vi.hoisted(() => ({
    workspaceId: "66666666-6666-4666-8666-666666666666",
    domain: "" as string,
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
            params: { workspaceId: routeState.workspaceId, domain: routeState.domain },
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
    routeState.domain = "";
    routeState.query = {};
    localStorage.setItem("xihe-token", "test-token");
    // PLAN-0610 W3-2b: the wire no longer carries `role`; this spec covers the workspace settings
    // tabs, which are gated by the workspace role/ownership, not by instance capabilities.
    localStorage.setItem("xihe-user", JSON.stringify({ id: "u1", email: "owner@xihe.local" }));
    localStorage.setItem("xihe-workspace", JSON.stringify({ id: WORKSPACE_ID, name: "Workspace" }));
    mockConfigFetch();
});

describe("WorkspaceSettingsView (PLAN-0560)", () => {
    it("renders the workspace header and the tabs (incl. the resource tabs)", async () => {
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="workspace-settings-page"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="workspace-settings-kicker"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="ws-settings-tab-general"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="ws-settings-tab-config"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="ws-settings-tab-mcp"]').exists()).toBe(true);
        // PLAN-0752 T4.2/T4.3：工作区层资源入口 = 真功能，后端都已实现，所以不给缺口标记。
        expect(wrapper.find('[data-testid="ws-settings-tab-credentials"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="ws-settings-tab-knowledge"]').exists()).toBe(true);
        wrapper.unmount();
    });

    it("lands the workspace credentials tab on the real credential panel scoped to WORKSPACE", async () => {
        routeState.query = { tab: "credentials" };
        const wrapper = await mountView();

        const tab = wrapper.find('[data-testid="ws-settings-credentials"]');
        expect(tab.exists()).toBe(true);
        // 真功能：面板在（列表已发请求，自身渲染 heading），不是「缺口说明」占位
        expect(tab.find('[data-testid="credentials-heading"]').exists()).toBe(true);
        expect(tab.find('[data-testid="credentials-scope-note"]').exists()).toBe(true);
        // 「不是缺口占位」按**权限门的形态**判，而不是按文案里有没有「后端缺口」四个字判：
        // PLAN-0752 M4 的 403 卡有意写「提示：本页不会被标记为『后端缺口』——后端已实现」，
        // 旧写法（`tab.text()).not.toContain("后端缺口")`）正是被这句说明命中而误红。
        // ① 不能是 `no-atom`（那才是「概念不存在」的留位信息条）
        expect(tab.find('[data-testid="settings-no-atom-notice"]').exists()).toBe(false);
        // ② 缺口徽标/缺口说明一个都不许出现在这个 tab 里
        expect(tab.find('[data-testid^="settings-gap-"]').exists()).toBe(false);
        // ③ 必须是 `atom-denied` 的 403 卡，且它明写「不是后端缺口」——真功能只是缺授权
        expect(tab.find('[data-testid="settings-atom-denied-not-gap"]').exists()).toBe(true);
        wrapper.unmount();
    });

    it("lands the workspace knowledge tab on the real knowledge base panel", async () => {
        routeState.query = { tab: "knowledge" };
        const wrapper = await mountView();

        const tab = wrapper.find('[data-testid="ws-settings-knowledge"]');
        expect(tab.exists()).toBe(true);
        expect(tab.find('[data-testid="settings-knowledge-heading"]').exists()).toBe(true);
        expect(tab.text()).not.toContain("后端缺口");
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

    it("keeps agent-runtime ceiling keys visible but read-only on the workspace layer", async () => {
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
        // PLAN-0752 T3.2：工作区层不再隐藏实例专属键，改为只读行 + 「仅实例层」徽标。
        const ceiling = wrapper.find(
            '[data-testid="config-field-agent-runtime-runMaxElapsedSecondsCeiling"]',
        );
        expect(ceiling.exists()).toBe(true);
        expect(ceiling.find("input").attributes("disabled")).toBeDefined();
        expect(
            ceiling
                .find(
                    '[data-testid="config-key-layer-badge-agent-runtime-runMaxElapsedSecondsCeiling"]',
                )
                .exists(),
        ).toBe(true);
        wrapper.unmount();
    });

    // ---- PLAN-0752 M2 B4：域段模式按单域渲染（不再 tab 内平铺整层 9 域） ----
    it("renders only the requested domain when the URL carries a domain segment", async () => {
        routeState.domain = "job-policy";
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="ws-settings-domain-page"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="ws-settings-domain-title"]').text()).toBe(
            "Job 运行时限",
        );
        expect(wrapper.find('[data-testid="ws-settings-tab-config"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="config-domain-job-policy"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="config-domain-agent-runtime"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="config-domain-rag"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it("renders the 404 view for a domain the workspace layer does not have (logging) without loading config", async () => {
        routeState.domain = "logging";
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="settings-not-found"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="ws-settings-domain-page"]').exists()).toBe(false);
        const configCalls = vi.mocked(fetch).mock.calls.filter(([input]) => {
            const url = typeof input === "string" ? input : input.url;
            return url.includes("/api/v1/config/");
        });
        expect(configCalls).toHaveLength(0);
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

describe("WorkspaceSettingsView 工具分类入口 (G9 / task-153)", () => {
    const faces = [
        {
            id: null,
            scope: "builtin",
            ownerId: null,
            tool: "read_file",
            actionClass: "read",
            shape: "structured",
        },
        {
            id: "88888888-8888-4888-8888-888888888888",
            scope: "workspace",
            ownerId: WORKSPACE_ID,
            tool: "mcp__third_party__do",
            actionClass: "unclassified",
            shape: "opaque",
        },
    ];
    const requested: string[] = [];

    /** 身份从 sessionStorage 播种：OWNER 才有分类能力，VIEWER 只读（G9 两态）。 */
    function seedWorkspaceRole(role: "OWNER" | "VIEWER", capabilities?: Record<string, unknown>) {
        localStorage.removeItem("xihe-workspace");
        sessionStorage.setItem(
            "xihe-workspace",
            JSON.stringify({
                id: WORKSPACE_ID,
                name: "Workspace",
                workspaceRole: role,
                ownerId: role === "OWNER" ? "u1" : "someone-else",
            }),
        );
        if (capabilities) {
            localStorage.setItem(
                "xihe-user",
                JSON.stringify({ id: "u1", email: "owner@xihe.local", capabilities }),
            );
        }
    }

    function mockFetchWithToolFaces() {
        vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
            const url = typeof input === "string" ? input : input.url;
            if (url.includes("/api/v1/policy/tool-faces")) {
                requested.push(url);
                return Promise.resolve(new Response(JSON.stringify(faces), { status: 200 }));
            }
            return mockConfigFetchResponse(input);
        });
    }

    beforeEach(() => {
        requested.length = 0;
        routeState.domain = "approval-policy";
        routeState.query = {};
        mockFetchWithToolFaces();
    });

    it("G9-①: 工作区 OWNER 能打开「工具分类」页签并读到 workspace 口径的分类表", async () => {
        seedWorkspaceRole("OWNER");
        routeState.query = { tab: "tool-faces" };
        const wrapper = await mountView();

        // 域页出现域内页签，且默认落在 tool-faces（?tab= 只表达域内视图）
        expect(wrapper.find('[data-testid="ws-settings-domain-tabs"]').exists()).toBe(true);
        expect(
            wrapper
                .get('[data-testid="settings-domain-tab-tool-faces"]')
                .attributes("aria-selected"),
        ).toBe("true");
        expect(wrapper.find('[data-testid="ws-settings-tool-faces"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="tool-faces-view"]').exists()).toBe(true);
        // 真读取：请求带 scope=workspace，且列表渲染出内置面与工作区面
        expect(requested.some((url) => url.includes("scope=workspace"))).toBe(true);
        expect(wrapper.find('[data-testid="settings-tool-face-read_file"]').exists()).toBe(true);
        // OWNER 具备分类能力 ⇒ 未分类项出现分类按钮，且不显示只读提示
        expect(
            wrapper
                .find('[data-testid="settings-tool-face-classify-mcp__third_party__do"]')
                .exists(),
        ).toBe(true);
        expect(wrapper.find('[data-testid="settings-tool-faces-forbidden"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it("G9-②: 非 OWNER 可见但只读（能读表、无分类按钮、有只读提示）", async () => {
        seedWorkspaceRole("VIEWER");
        routeState.query = { tab: "tool-faces" };
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="ws-settings-domain-tabs"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="ws-settings-tool-faces"]').exists()).toBe(true);
        // 读面保留：后端 workspace scope 读取只要求带工作区上下文（ToolFaceService.ownerFor(requireOwner=false)）
        expect(requested.some((url) => url.includes("scope=workspace"))).toBe(true);
        expect(wrapper.find('[data-testid="settings-tool-face-read_file"]').exists()).toBe(true);
        // 写面收起：与「工作区设置页对非写角色只读」同语义
        expect(
            wrapper
                .find('[data-testid="settings-tool-face-classify-mcp__third_party__do"]')
                .exists(),
        ).toBe(false);
        expect(wrapper.find('[data-testid="settings-tool-faces-forbidden"]').exists()).toBe(true);
        wrapper.unmount();
    });

    it("G9-③: 实例 ADMIN 在工作区页也不出现「切到实例视图」的范围选择（scopeLock=workspace）", async () => {
        seedWorkspaceRole("VIEWER", {
            isInstanceAdmin: true,
            isInstanceSuper: false,
            workspaceAdminOf: [],
        });
        routeState.query = { tab: "tool-faces" };
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="ws-settings-domain-tabs"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="settings-tool-faces-scope-workspace"]').exists()).toBe(
            true,
        );
        expect(wrapper.find('[data-testid="settings-tool-faces-scope-instance"]').exists()).toBe(
            false,
        );
        expect(requested.every((url) => !url.includes("scope=instance"))).toBe(true);
        wrapper.unmount();
    });

    it("G9-④: 只有 approval-policy 域页出现这两个页签", async () => {
        seedWorkspaceRole("OWNER");
        routeState.domain = "rag";
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="ws-settings-domain-tabs"]').exists()).toBe(false);
        wrapper.unmount();
    });
});

describe("WorkspaceSettingsView 错误回退 (PLAN-0560 T4.1)", () => {
    it("redirects to workspace-home on WORKSPACE_FORBIDDEN", async () => {
        // fixture 缓存短路会让 selectWorkspace 直接命中；清空后强制走真实请求。
        localStorage.removeItem("xihe-workspace");
        sessionStorage.clear();
        vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
            const url = typeof input === "string" ? input : input.url;
            if (url.includes(`/api/v1/workspaces/${WORKSPACE_ID}`)) {
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            code: "WORKSPACE_FORBIDDEN",
                            status: 403,
                            detail: "not a member",
                        }),
                        { status: 403 },
                    ),
                );
            }
            return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
        });
        await mountView();

        expect(routerSpies.replace).toHaveBeenCalledWith({ name: "workspace-home" });
    });
});
