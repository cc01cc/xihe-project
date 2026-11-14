import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { RouteLocationNormalizedLoaded } from "vue-router";
import { i18n } from "../../../i18n";
import { makeWorkspace } from "../../../tests/workspaceFixture";

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
}));

/**
 * task-209：提示条里的「去资源区」链接要能被断言到**目标地址**，所以本地注册的 RouterLink
 * stub 把 `to` 暴露成 `data-to`（默认 `<a><slot /></a>` 会吞掉目标，只能断言文案 ——
 * 那种断言看着绿但什么都没验）。
 */
const RouterLinkStub = {
    props: ["to"],
    template: '<a :data-to="String(to)"><slot /></a>',
};

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
 * PLAN-0560 M1：WorkspaceSettingsView 承载 workspace 层常规信息与成员。
 * task-209（D-1019）：`mcp` / `credentials` / `knowledge` 三个 tab 已撤到资源区
 * （`/resources/<id>?layer=WORKSPACE`），旧 `?tab=` 回落到「常规」并显示迁移提示条 ——
 * 本 spec 现在**同时**守住「tab 不再存在」与「旧链接有落点」两件事。
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
                JSON.stringify(
                    makeWorkspace({ id: WORKSPACE_ID, name: "Workspace", workspaceRole: "OWNER" }),
                ),
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
                components: { RouterLink: RouterLinkStub },
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
    it("renders the workspace header and only the surviving tabs (task-209 撤资源双入口)", async () => {
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="workspace-settings-page"]').exists()).toBe(true);
        // task-253：工作区设置不再是设置区的「一层」⇒ 自带页面标题头，不再借用
        // SettingsLayerHeader 的「设置 › 工作区层」面包屑。
        expect(wrapper.find('[data-testid="workspace-settings-header"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="workspace-settings-title"]').text()).toBe("工作区设置");
        expect(wrapper.find('[data-testid="settings-layer-header"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="ws-settings-tab-general"]').exists()).toBe(true);
        // PLAN-0773 M4-1（task-190）：配置 tab 回来了 —— 但这次是**按工作区**的层
        // （`ConfigLayer` 新增 `workspace`，`SettingsLayer` 同批收窄成 Exclude）。
        // 这条从 task-253 的「正面守卫（不存在）」翻成「正面守卫（存在）」：留下的理由不变 ——
        // 纯删除只能证明"这一刻没写"，有人再撤掉它时不会有任何东西变红。
        expect(wrapper.find('[data-testid="ws-settings-tab-config"]').exists()).toBe(true);
        // task-209 / D-1019：mcp / credentials / knowledge 三个 tab 与资源区双入口 ⇒ 撤。
        // 断言写成**正面守卫**（计数为 0）而不是删掉这几行：删掉只能证明"这一刻没写"，加回来时没人会红。
        // task-236（M4-3）：成员 tab 提升为一级页（/workspace/:id/members）⇒ 设置页只剩
        // 常规 + 配置两个 tab；正面守卫计数防「tab 被悄悄加回来」。
        expect(wrapper.findAll('[data-testid^="ws-settings-tab-"]')).toHaveLength(2);
        for (const removed of ["mcp", "credentials", "knowledge", "members"]) {
            expect(wrapper.find(`[data-testid="ws-settings-tab-${removed}"]`).exists()).toBe(false);
            expect(wrapper.find(`[data-testid="ws-settings-${removed}"]`).exists()).toBe(false);
        }
        wrapper.unmount();
    });

    it.each([
        ["mcp", "mcp", "MCP"],
        ["credentials", "credentials", "凭据"],
        ["knowledge", "knowledge", "知识库"],
    ])(
        "旧 ?tab=%s 回落到「常规」并指路到 /resources/%s?layer=WORKSPACE",
        async (legacyTab, resourceId, resourceName) => {
            routeState.query = { tab: legacyTab };
            const wrapper = await mountView();

            // ① 回落：落点是「常规」，三个旧 tab 容器一个都不渲染（不是静默 404，也不是原页面）。
            expect(wrapper.find('[data-testid="ws-settings-general"]').exists()).toBe(true);
            expect(wrapper.find(`[data-testid="ws-settings-${legacyTab}"]`).exists()).toBe(false);

            // ② 不静默：提示条点名是哪个资源搬走了，并给出可直接点过去的**目标地址**。
            const notice = wrapper.find('[data-testid="ws-settings-resource-moved"]');
            expect(notice.exists()).toBe(true);
            expect(notice.text()).toContain("已迁到资源区");
            expect(notice.text()).toContain(resourceName);
            expect(
                notice
                    .find('[data-testid="ws-settings-resource-moved-action"]')
                    .attributes("data-to"),
            ).toBe(`/resources/${resourceId}?layer=WORKSPACE`);
            wrapper.unmount();
        },
    );

    it("旧 ?tab= 之外的未知 tab 既不回落提示、也不渲染任何资源面", async () => {
        routeState.query = { tab: "nope" };
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="ws-settings-general"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="ws-settings-resource-moved"]').exists()).toBe(false);
        expect(wrapper.findAll('[data-testid^="ws-settings-tab-"]')).toHaveLength(2);
        wrapper.unmount();
    });

    it("旧 ?tab=members 重定向到一级成员页（task-236 M4-3：单入口，不回落不 404）", async () => {
        routeState.query = { tab: "members" };
        const wrapper = await mountView();
        await flushPromises();

        expect(routerSpies.replace).toHaveBeenCalledWith({
            name: "workspace-members",
            params: { workspaceId: WORKSPACE_ID },
        });
        // 设置页自己不再渲染任何成员面。
        expect(wrapper.find('[data-testid="ws-settings-members"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it("shows the workspace general info on the default tab", async () => {
        const wrapper = await mountView();

        const general = wrapper.find('[data-testid="ws-settings-general"]');
        expect(general.exists()).toBe(true);
        expect(wrapper.find('[data-testid="ws-settings-name"]').text()).toBe("Workspace");
        wrapper.unmount();
    });
});

describe("WorkspaceSettingsView OWNER 编辑与删除 (PLAN-0560 T2.6/T3.3 迁移)", () => {
    async function mountOwner() {
        // migrateLegacyWorkspace 会把 localStorage 旧键归一化为 {id,name}，
        // 角色必须直写 per-tab sessionStorage 才能进入 OWNER 分支。
        localStorage.removeItem("xihe-workspace");
        // task-414：编辑/删除的权威是 `workspace:admin` 能力位，不是角色名 OWNER。
        // 真实 OWNER 必带该能力（WS_OWNER 含 workspace:admin(cap)）⇒ 夹具从登录态恢复它。
        localStorage.setItem(
            "xihe-user",
            JSON.stringify({
                id: "u1",
                email: "owner@test.com",
                capabilities: {
                    isInstanceAdmin: false,
                    isInstanceSuper: false,
                    workspaceAdminOf: [WORKSPACE_ID],
                },
            }),
        );
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

/**
 * task-472（D-1367 健壮性/潜在缺陷）：页面必须**自己确保** `/me/permissions` 投影被加载。
 *
 * <p><b>受影响的不是「非实例管理员的工作区 OWNER」</b> —— WS_OWNER 种子含 `workspace:admin`
 * （`SystemAccessRoleCatalog.java:211`）⇒ CP 的 `workspaceAdminOf` 会把任何真 OWNER 列进去
 * ⇒ `canWorkspaceAdmin` 为真 ⇒ 无投影也能管理（真账号实测复现不出）。**真正的判别条件是
 * `user.capabilities` 缺失或过期**；本 spec 的 `xihe-user` 夹具故意不带 capabilities，正是那一类。</p>
 */
describe("WorkspaceSettingsView 投影加载（task-472 / D-1367）", () => {
    function routeProjection(projection: { status: number; body?: unknown }) {
        (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
            (input: RequestInfo | URL) => {
                const url = typeof input === "string" ? input : input.url;
                if (!url.includes("/me/permissions")) return mockConfigFetchResponse(input);
                return Promise.resolve(
                    new Response(
                        JSON.stringify(projection.status === 200 ? (projection.body ?? {}) : {}),
                        { status: projection.status },
                    ),
                );
            },
        );
    }

    function projectionCalls() {
        return (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
            (call) => {
                const arg = call[0] as string | Request;
                return String(typeof arg === "string" ? arg : arg.url).includes("/me/permissions");
            },
        ).length;
    }

    it("挂载即请求能力投影（恰好一次）", async () => {
        routeProjection({ status: 200, body: {} });
        await mountView();

        expect(projectionCalls()).toBe(1);
    });

    it("投影给该工作区 admin 时，编辑入口出现（修前必红：没人请求投影）", async () => {
        routeProjection({
            status: 200,
            body: {
                userId: "u1",
                instanceCapabilities: [],
                instancePermissions: [],
                workspaces: [{ workspaceId: WORKSPACE_ID, workspaceAdmin: true }],
            },
        });
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="ws-settings-edit"]').exists()).toBe(true);
    });

    it("投影 500 时页面仍然渲染，只是不给编辑入口（fail-closed 不是白屏）", async () => {
        routeProjection({ status: 500 });
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="workspace-settings-page"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="ws-settings-general"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="ws-settings-edit"]').exists()).toBe(false);
    });

    it("配置 tab 同时挂载面板时，投影仍然只请求一次（单飞去重）", async () => {
        routeProjection({ status: 200, body: {} });
        routeState.query = { tab: "config" };
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="ws-settings-config"]').exists()).toBe(true);
        expect(projectionCalls()).toBe(1);
    });
});
