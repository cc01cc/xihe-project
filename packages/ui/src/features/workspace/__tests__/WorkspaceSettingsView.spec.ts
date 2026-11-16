import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { RouteLocationNormalizedLoaded } from "vue-router";
import { i18n } from "../../../i18n";
import { expectModalDialog } from "../../../test-utils/modalDialog";
import { makeWorkspace } from "../../../tests/workspaceFixture";

const routeState = vi.hoisted(() => ({
    workspaceId: "66666666-6666-4666-8666-666666666666",
    domain: "" as string,
    query: {} as Record<string, string>,
}));

/** 工作区角色（D-1432 权限门用例要切 VIEWER；默认 OWNER = 可写）。 */
const roleState = vi.hoisted(() => ({ workspaceRole: "OWNER" as "OWNER" | "EDITOR" | "VIEWER" }));

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

/**
 * D-1432 / task-41 搬回来的两个面板：用替身挂在这里，断言「页签真的把面板挂出来了」+
 * 「只读门 prop 真的传下去了」。替身形状按 packages/ui/AGENTS.md 的 async 替身约定写成
 * 组件对象（本 spec 直接同步 vi.mock，不涉及 defineAsyncComponent）。
 * 承重：**删掉 WorkspaceSettingsView 里的 `:readonly="!auth.canWriteWorkspace"` ⇒ 必红**。
 */
vi.mock("../components/WorkspaceMcpPanel.vue", () => ({
    default: {
        name: "WorkspaceMcpPanel",
        props: ["workspaceId", "readonly"],
        template:
            "<div data-testid='stub-mcp-panel' :data-ws='workspaceId' :data-readonly='String(readonly)' />",
    },
}));
vi.mock("../../../components/resources/WorkspaceSkillsPanel.vue", () => ({
    default: {
        name: "WorkspaceSkillsPanel",
        props: ["workspaceId"],
        template: "<div data-testid='stub-skills-panel' :data-ws='workspaceId' />",
    },
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
                    makeWorkspace({
                        id: WORKSPACE_ID,
                        name: "Workspace",
                        workspaceRole: roleState.workspaceRole,
                    }),
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
    roleState.workspaceRole = "OWNER";
    localStorage.setItem("xihe-token", "test-token");
    // PLAN-0610 W3-2b: the wire no longer carries `role`; this spec covers the workspace settings
    // tabs, which are gated by the workspace role/ownership, not by instance capabilities.
    localStorage.setItem("xihe-user", JSON.stringify({ id: "u1", email: "owner@xihe.local" }));
    localStorage.setItem("xihe-workspace", JSON.stringify({ id: WORKSPACE_ID, name: "Workspace" }));
    mockConfigFetch();
});

describe("WorkspaceSettingsView (PLAN-0560)", () => {
    it("renders the workspace header and the four tabs (D-1432 搬回 mcp/skills)", async () => {
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
        // D-1432 / task-41（用户 2026-11-15 裁定）：mcp 与 skills 的**本工作区层**搬回来了；
        // credentials / knowledge 仍在资源区（用户没点它们），members 仍是一级页。
        expect(wrapper.find('[data-testid="ws-settings-tab-mcp"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="ws-settings-tab-skills"]').exists()).toBe(true);
        // 正面守卫计数：加/撤页签都必须来这里改，否则红（删掉这几行只能证明"这一刻没写"）。
        expect(wrapper.findAll('[data-testid^="ws-settings-tab-"]')).toHaveLength(4);
        for (const removed of ["credentials", "knowledge", "members"]) {
            expect(wrapper.find(`[data-testid="ws-settings-tab-${removed}"]`).exists()).toBe(false);
            expect(wrapper.find(`[data-testid="ws-settings-${removed}"]`).exists()).toBe(false);
        }
        wrapper.unmount();
    });

    it("task-60：移动页签与 go-environment 命中盒 ≥24（min-h-7 锁定）", async () => {
        // ui-2 batch-4 开抽屉复测：页签 20.8 高（×4）、go-environment 48×19.2 ⇒ 均 <24 违例。
        // `min-h-7` = 3.5px × 7 = 24.5；jsdom 不求值 Tailwind ⇒ 钉类名，真 rect 归复测。
        // go-environment 在 `v-if=auth.canManageWorkspace` 块内 ⇒ 必须给 workspace:admin 能力位
        // （同 OWNER describe 的 mountOwner 夹具；默认登录态无此能力，元素不渲染）。
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
        const wrapper = await mountView();
        for (const key of ["config", "mcp", "skills", "general"]) {
            const tab = wrapper.get(`[data-testid="ws-settings-tab-${key}"]`);
            expect(tab.classes(), `ws-settings-tab-${key}`).toContain("min-h-7");
        }
        const goEnv = wrapper.get('[data-testid="ws-settings-go-environment"]');
        // RouterLink 是 <a>（inline）⇒ 没有 inline-flex 时 min-h 不生效，两个断言必须成对。
        expect(goEnv.classes()).toEqual(
            expect.arrayContaining(["min-h-7", "inline-flex", "items-center"]),
        );
        wrapper.unmount();
    });

    // ---- task-81 P1-2：页签组的可访问结构与选中语义 ----
    it("四个页签由 vendor `role=tablist` 承载，组名在 tablist 上，当前项只有一个", async () => {
        // 改前实测（同一 URL）：四个 tab 的 `role` / `aria-selected` / `aria-current` /
        // `tabindex` **全为 null**，祖先四层无 nav/tablist/aria-label ⇒ 屏幕阅读器读到
        // 四个无状态按钮，不知道当前在哪个 tab；选中态只由 `border-b-2` 的颜色表达。
        //
        // 判据是**结构**（role / 属性 / 关联），不猜 CSS —— 与 task-484 落 data 属性同一口径。
        const wrapper = await mountView();
        const lists = wrapper.findAll('[role="tablist"]');
        expect(lists.length, "必须有且只有一个 tablist").toBe(1);
        expect(
            lists[0].attributes("aria-label"),
            "组名必须在 tablist 自身（放 Tabs 根上会挂到无 role 的外层 div ⇒ 念不到组名）",
        ).toBe("工作区设置页签");
        const tabs = wrapper.findAll('[role="tab"]');
        expect(tabs.length, "四个页签都是 role=tab").toBe(4);
        const selected = wrapper.findAll('[role="tab"][aria-selected="true"]');
        expect(selected.length, "当前项只能有一个（不能一个都没有、也不能多个）").toBe(1);
        for (const tab of tabs)
            expect(tab.attributes("aria-selected"), "每个页签都要有选中状态").toMatch(
                /^(true|false)$/,
            );
        // 键盘可达性由 vendor 提供（roving tabindex）。**不钉具体 tabindex 数值** ——
        // 实测 tablist 是 "0"、页签在组内由 roving focus 决定谁可聚焦；钉死某个数会把
        // vendor 的内部实现细节变成我们的契约（升级就会假红）。判据只要求「tablist 可聚焦」。
        expect(lists[0].attributes("tabindex"), "tablist 必须可聚焦").toBeDefined();
        wrapper.unmount();
    });

    it.each([
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
        expect(wrapper.findAll('[data-testid^="ws-settings-tab-"]')).toHaveLength(4);
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

    /**
     * task-32（ui-2 自审 batch-1 D1，读数 `readings/verify4.json deleteGuard`）：destructive
     * 确认按钮的 `disabled` 必须**由输入派生** —— 空名 / 写错的名称都不可点，逐字完整的名称
     * 才可点。改前实测 `confirmDisabled=false`（空名也可点），限制只在 handler 里 ⇒ 用户点下去
     * 才知道不行，而 `disabled` 是键盘与读屏都能先读到的状态。
     *
     * <p>第 ④ 段守的是卡面「保留 handler 兜底」：`disabled` 只挡**用户激活**（HTML 规范：
     * disabled 控件的 `click()` 直接 return），挡不住程序化派发事件 ⇒ 用 `dispatchEvent` 绕过
     * disabled，看 handler 自己拦不拦。删掉 handler 里的判断这段就红（会发出 DELETE）。</p>
     */
    it("确认删除按钮的 disabled 由名称输入派生，handler 兜底仍在（task-32）", async () => {
        const wrapper = await mountOwner();
        await wrapper.find('[data-testid="ws-settings-delete"]').trigger("click");
        const confirmBtn = () =>
            document.body.querySelector(
                '[data-testid="ws-delete-confirm-btn"]',
            ) as HTMLButtonElement | null;
        await vi.waitFor(() => expect(confirmBtn()).toBeTruthy());

        // task-49：同页另一个确认层（本卡补的那条）——role/aria-modal/名字来自标题。
        expectModalDialog("workspace-delete-confirm", "alertdialog", "删除工作区？");

        // ① 空名 ⇒ disabled（改前这里是 false：按钮看着能点）
        expect(confirmBtn()!.disabled).toBe(true);

        // ② 写错的名称 ⇒ 仍 disabled
        await setBodyInput("ws-delete-confirm-input", "Wrong Name");
        await vi.waitFor(() => expect(confirmBtn()!.disabled).toBe(true));

        // ③ 逐字完整的名称 ⇒ 可点（判据与 handler 同一条：trim() 后相等）
        await setBodyInput("ws-delete-confirm-input", "Workspace");
        await vi.waitFor(() => expect(confirmBtn()!.disabled).toBe(false));

        // ④ handler 兜底：绕过 disabled 直接派发 click，既不发出 DELETE，也要给出原因文案。
        await setBodyInput("ws-delete-confirm-input", "Wrong Name");
        await vi.waitFor(() => expect(confirmBtn()!.disabled).toBe(true));
        confirmBtn()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await flushPromises();

        const deleteCalls = () =>
            vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "DELETE");
        expect(deleteCalls().length).toBe(0);
        expect(document.body.textContent).toContain("请输入完整的工作区名称以确认删除");
        // 门失败时对话框保持打开（不静默关掉、也不静默放行）。
        expect(document.body.querySelector("#ws-delete-confirm-input")).toBeTruthy();
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

/**
 * D-1432 / task-41：搬回来的两个页签。
 *
 * 守两件事，缺一都不算数：
 * 1 **页签真的挂面板**（不是只有个空 div）；
 * 2 **权限门 prop 真的传下去** —— `task-209` 记过一次真事故（搬家漏 `:readonly`，VIEWER 看到可编辑
 *   JSON 框）。这里的 VIEWER 用例就是那次事故的机器守卫：把 `:readonly="!auth.canWriteWorkspace"`
 *   删掉 ⇒ `data-readonly` 变成 `"false"` ⇒ 红。
 */
describe("WorkspaceSettingsView — 搬回来的 mcp / skills 页签（D-1432）", () => {
    it("?tab=mcp ⇒ 挂载本工作区 MCP 面板，OWNER 下 readonly=false", async () => {
        routeState.query = { tab: "mcp" };
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="ws-settings-mcp"]').exists()).toBe(true);
        const panel = wrapper.find('[data-testid="stub-mcp-panel"]');
        expect(panel.exists()).toBe(true);
        expect(panel.attributes("data-ws")).toBe(WORKSPACE_ID);
        expect(panel.attributes("data-readonly")).toBe("false");
        wrapper.unmount();
    });

    it("权限门承重：VIEWER ⇒ MCP 面板 readonly=true（去掉 :readonly 这条必红）", async () => {
        routeState.query = { tab: "mcp" };
        const wrapper = await mountView();
        // 本用例守的是**绑定**（模板是否把 !canWriteWorkspace 传到 readonly），不是取数路径；
        // 取数/角色解析在 auth store 自己的 spec 里钉。所以直接改 store 的工作区角色再等一次渲染。
        const { useAuthStore } = await import("../../../stores/auth");
        const auth = useAuthStore();
        auth.workspace = {
            ...(auth.workspace as Record<string, unknown>),
            workspaceRole: "VIEWER",
            canWrite: false,
        } as typeof auth.workspace;
        await flushPromises();

        expect(wrapper.find('[data-testid="stub-mcp-panel"]').attributes("data-readonly")).toBe(
            "true",
        );
        wrapper.unmount();
    });

    it("?tab=skills ⇒ 挂载本工作区技能面板（该面板无写面，故无 readonly prop 可传）", async () => {
        routeState.query = { tab: "skills" };
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="ws-settings-skills"]').exists()).toBe(true);
        const panel = wrapper.find('[data-testid="stub-skills-panel"]');
        expect(panel.exists()).toBe(true);
        expect(panel.attributes("data-ws")).toBe(WORKSPACE_ID);
        // 结构性说明：这个面板没有 readonly/disabled 面（写面未接线），门是 vacuous 而不是"已处理"。
        expect(panel.attributes("data-readonly")).toBeUndefined();
        wrapper.unmount();
    });

    /**
     * task-53（P0 收口最后一条文案 P1，批次01 D3）：设置页主描述原先写「本工作区的常规信息**与成员**」，
     * 但成员自 task-236 起已是一级页（`/workspace/:id/members`，自带 `membersPageDesc`）⇒
     * 描述许诺了本页没有的能力。
     *
     * <p><b>承重方向</b>：把「与成员」/「and members」加回任一语言的 `workspace.settingsDesc` ⇒
     * 本用例必红；反向把整段描述删空也会红（下面钉了「信息量不许缩水」的三段文本）。
     * 刻意**不**改成「成员见成员页」这类指路句：该页左侧导航已有成员入口，再指一次是重复。</p>
     */
    describe("WorkspaceSettingsView — 描述文案与本页能力一致（task-53）", () => {
        it("主描述不再许诺「与成员」，且两种语言同时守住", async () => {
            const wrapper = await mountView();
            const text = wrapper.text();

            expect(text).not.toContain("与成员");
            // 信息量不许缩水：配置层与资源层的去处仍在句子里（只删不实的那半句）。
            expect(text).toContain("本工作区的常规信息");
            expect(text).toContain("实例 / 工作区默认 / 个人");
            expect(text).toContain("资源区");
            wrapper.unmount();

            // en 侧不是"晚一步翻译"：同一循环把每个 locale 都断言一遍，
            // 只改 zh 会让这条红（这正是 task-53 卡面要求的"两侧都要改"）。
            for (const locale of i18n.global.availableLocales) {
                const messages = i18n.global.getLocaleMessage(locale) as {
                    workspace?: { settingsDesc?: string };
                };
                const desc = String(messages.workspace?.settingsDesc ?? "");
                expect(desc, "settingsDesc 不得再写 与成员 / and members: " + locale).not.toMatch(
                    /与成员|and members/,
                );
                expect(desc.length, "settingsDesc 不得为空: " + locale).toBeGreaterThan(20);
            }
        });
    });

    it("点页签把 ?tab= 写进 URL（可分享深链；general 作为默认页签省略）", async () => {
        routeState.query = { tab: "config" };
        const wrapper = await mountView();

        // task-81 P1-2：改用 vendor `Tabs` 后，**触发事件从 click 改为 mousedown**。
        //
        // **这是对 vendor 激活机制的依赖，不是行为判据** —— 老实说清，不假装它中性：
        //   reka `TabsTrigger` 的激活事件是 `mousedown`（`TabsTrigger.js:57` 的 `onMousedown`，
        //   配 `withModifiers(..., ["left"])` ⇒ 左键才生效），此外还有 `keydown` 的
        //   enter/space 与 `focus`（activationMode !== manual 时聚焦即切）。**没有 `click`**。
        //
        // 「若上游改成 click/pointerdown」的后果（实测，不是推测）：把本行换回 `trigger("click")`
        // 后本用例**红在下一行的 routerSpies 断言**（`expected "vi.fn()" to be called with
        // arguments: [ { query: { tab: 'mcp' } } ]`），即症状会指向「切页没发生」而不是
        // 「事件名过期」—— 所以 vendor 升级时**必须回来看这一行**，别去查 switchTab 逻辑。
        //
        // **被断言的判据一字未改**：改前 `expect(routerSpies.push).toHaveBeenCalledWith({ query:
        // { tab: "mcp" } })`，改后同一句、同一对象、同一期望值（`git diff` 里那一行是上下文行，
        // 不在 `-`/`+` 两侧）。
        await wrapper.find('[data-testid="ws-settings-tab-mcp"]').trigger("mousedown");
        expect(routerSpies.push).toHaveBeenCalledWith({ query: { tab: "mcp" } });
        wrapper.unmount();
    });

    it("旧 ?tab=mcp 不再走「迁到资源区」提示条（它已是真页签）", async () => {
        routeState.query = { tab: "mcp" };
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="ws-settings-resource-moved"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="ws-settings-mcp"]').exists()).toBe(true);
        wrapper.unmount();
    });
});
