import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import type { Router } from "vue-router";
import Sidebar from "../sidebar/Sidebar.vue";
import { useSessionStore } from "../../stores/session";
import { useAuthStore } from "../../stores/auth";
import { useAgentStore } from "../../stores/agent";

const messages = {
    "zh-CN": {
        sidebar: {
            newChat: "新建对话",
            search: "搜索对话...",
            today: "今天",
            yesterday: "昨天",
            earlier: "更早",
            rename: "重命名",
            delete: "删除",
            empty: "暂无对话",
            settings: "设置",
            workspace: "工作区",
            logout: "退出登录",
            noWorkspace: "没有可用工作区",
            pendingApprovalBadge: "待审批",
            admin: "管理",
            collapse: "收起侧边栏",
            expand: "展开侧边栏",
            collapseRail: "收起导航栏",
            expandRail: "展开导航栏",
            clearSearch: "清除搜索",
            resize: "调整导航面板宽度",
        },
        // task-36 ③：移动端用户区新增紧凑语言切换，需要这三条文案。
        settings: {
            languageLabel: "界面语言",
            languageZh: "中文（zh-Hans）",
            languageEn: "English (en)",
        },
    },
};

const { pushSpy, routeState } = vi.hoisted(() => ({
    pushSpy: vi.fn<Router["push"]>(),
    routeState: {
        params: {} as Record<string, string>,
        name: "workspace-chat",
        path: "/workspace/ws-test/chat/session-1",
    },
}));

vi.mock("vue-router", () => ({
    createRouter: () => ({
        push: vi.fn<() => void>(),
        replace: vi.fn<() => void>(),
        beforeEach: vi.fn<() => void>(),
        afterEach: vi.fn<() => void>(),
        isReady: () => Promise.resolve(),
        currentRoute: { value: {} },
    }),
    createWebHistory: () => ({}),
    useRouter: () => ({ push: pushSpy }),
    useRoute: () => routeState,
}));

function mockAuth(workspaceId = "ws-test") {
    const auth = useAuthStore();
    auth.$patch({
        token: "mock-token",
        user: { id: "u-1", email: "tester@xihe.local" },
        workspace: { id: workspaceId, name: "Default Workspace" },
    });
    return auth;
}

// PLAN-0668：成功的 Session 详情响应必须包含 archived；列表摘要夹具不能冒充详情。
function stubSessionResponse(record: { id: string; title?: string; createdAt?: string }) {
    return {
        id: record.id,
        title: record.title ?? "New Chat",
        workspaceId: "ws-test",
        archived: false,
        createdAt: record.createdAt ?? new Date().toISOString(),
        updatedAt: record.createdAt ?? new Date().toISOString(),
    };
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    // BL-365：tab 工作区上下文存在 **sessionStorage**（`lib/workspaceContext.ts` 的 `xihe-workspace`），
    // 只清 localStorage 会让上一条用例的 `writeTabWorkspaceId("ws-late")` 漏到后续用例 ⇒
    // 组件"有工作区"，把「无工作区时不该 push」的断言打红（`--sequence.shuffle.tests` 稳定复现）。
    sessionStorage.clear();
    pushSpy.mockClear();
    vi.restoreAllMocks();
    routeState.name = "workspace-chat";
    routeState.path = "/workspace/ws-test/chat/session-1";
    routeState.params = {};
});

const i18n = createI18n({
    legacy: false,
    locale: "zh-CN",
    fallbackLocale: "zh-CN",
    messages,
});

async function mountSidebar(
    props: Partial<{
        open: boolean;
        isMobile: boolean;
        width: number;
        forceCollapsed: boolean;
        resizing: boolean;
    }> = {},
) {
    const wrapper = mount(Sidebar, {
        props: {
            open: true,
            width: 280,
            isMobile: false,
            ...props,
        },
        global: {
            plugins: [i18n],
            stubs: { Teleport: { template: "<div><slot /></div>" } },
        },
    });
    await flushPromises();
    return wrapper;
}

describe("Sidebar", () => {
    it("renders new chat button with correct text", async () => {
        mockAuth();
        const wrapper = await mountSidebar();
        expect(wrapper.text()).toContain("新建对话");
    });

    it("clicking new chat routes through the explicit Workspace Agent selector", async () => {
        mockAuth();
        const store = useSessionStore();
        expect(store.sessions.length).toBe(0);
        const spy = vi.spyOn(globalThis, "fetch");

        const wrapper = await mountSidebar(),
            buttons = wrapper.findAll("button"),
            newChatBtn = buttons.find((b) => b.text().trim() === "新建对话");
        expect(newChatBtn).toBeDefined();
        await newChatBtn!.trigger("click");
        await flushPromises();

        expect(spy).not.toHaveBeenCalledWith(
            "/api/v1/sessions",
            expect.objectContaining({ method: "POST" }),
        );
        expect(store.sessions).toHaveLength(0);
        expect(pushSpy).toHaveBeenCalledWith({
            path: "/workspace/ws-test",
            query: { newChat: "1" },
        });
    });

    it("clicking new chat shows toast when no current workspace is set", async () => {
        const auth = useAuthStore();
        auth.$patch({ token: "mock", user: { id: "u-1", email: "x@xihe.local" } });
        const store = useSessionStore(),
            spy = vi.spyOn(globalThis, "fetch"),
            wrapper = await mountSidebar(),
            buttons = wrapper.findAll("button"),
            newChatBtn = buttons.find((b) => b.text().trim() === "新建对话");
        await newChatBtn!.trigger("click");
        await flushPromises();

        // The click first tries to resolve the workspace (hydrate), then refuses;
        // a Session must never be created without workspace context.
        expect(spy).not.toHaveBeenCalledWith(
            "/api/v1/sessions",
            expect.objectContaining({ method: "POST" }),
        );
        expect(store.sessions.length).toBe(0);
        expect(pushSpy).not.toHaveBeenCalled();
    });

    // PLAN-0608 I6（预期变更，判据未削弱）：登录不再把回退值写进 tab 上下文，
    // 因此「点击新建对话前已有 workspace」这件事必须由 **tab 上下文**（用户的显式
    // 选择）提供，而不是靠 `hydrateWorkspace` 去 `/workspaces/current` 猜一个回退值。
    // 本用例原本依赖后者；现改为显式播种 tab 上下文，断言（hydrate → 导航到该 ws
    // 且不建会话）完全不变。
    it("clicking new chat hydrates the workspace before opening the Agent selector", async () => {
        const { writeTabWorkspaceId } = await import("../../lib/workspaceContext");
        writeTabWorkspaceId("ws-late");
        const auth = useAuthStore();
        auth.$patch({ token: "mock", user: { id: "u-1", email: "x@xihe.local" } });
        const spy = vi.spyOn(globalThis, "fetch");
        spy.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ id: "ws-late", name: "Late Workspace", ownerId: "u-1" }),
        } as Response);
        const store = useSessionStore(),
            wrapper = await mountSidebar(),
            buttons = wrapper.findAll("button"),
            newChatBtn = buttons.find((b) => b.text().trim() === "新建对话");
        await newChatBtn!.trigger("click");
        await flushPromises();

        expect(store.sessions.length).toBe(0);
        expect(pushSpy).toHaveBeenCalledWith({
            path: "/workspace/ws-late",
            query: { newChat: "1" },
        });
    });

    it("renders empty state when no sessions exist", async () => {
        mockAuth();
        const wrapper = await mountSidebar();
        expect(wrapper.text()).toContain("暂无对话");
    });

    it("renders session time group headers when sessions exist", async () => {
        mockAuth();
        const store = useSessionStore(),
            spy = vi.spyOn(globalThis, "fetch");
        spy.mockResolvedValueOnce({
            ok: true,
            status: 201,
            json: () => Promise.resolve(stubSessionResponse({ id: "hdr-1" })),
        } as Response);
        await store.createSession("principal-test");
        spy.mockResolvedValueOnce({
            ok: true,
            status: 201,
            json: () => Promise.resolve(stubSessionResponse({ id: "hdr-2" })),
        } as Response);
        await store.createSession("principal-test");
        const wrapper = await mountSidebar();
        expect(wrapper.text()).toContain("今天");
    });

    it("no longer owns module entries: settings/logout moved to the global rail", async () => {
        mockAuth();
        const wrapper = await mountSidebar();
        // PLAN-0762 T2.1：设置 / 登出属于全局条（GlobalRail，App.vue 常驻），模块面板不再提供，
        // 避免「同一入口两处按钮」（DEV-011 按钮意义判据）。
        expect(wrapper.text()).not.toContain("设置");
        expect(wrapper.text()).not.toContain("退出登录");
    });

    it("shows the pending approval count on the matching session row", async () => {
        mockAuth();
        const sessions = useSessionStore();
        sessions.sessions.push({
            id: "pending-session",
            title: "Pending chat",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });
        const agent = useAgentStore();
        agent.pendingApprovalSummaries = [
            {
                sessionId: "pending-session",
                workspaceId: "ws-test",
                count: 3,
                oldestRequestedAt: new Date().toISOString(),
            },
        ];

        const wrapper = await mountSidebar();

        expect(wrapper.find('[data-testid="session-pending-badge"]').text()).toContain("3");
        expect(wrapper.find('[data-testid="session-pending-badge"]').text()).toContain("待审批");
    });

    it("renders a collapsed strip with an expand control when collapsed on desktop", async () => {
        mockAuth();
        const wrapper = await mountSidebar({ open: false });

        // PLAN-0762 T2.1：全局 rail 已提升到 App.vue 的全局层（GlobalRail），本组件不再自带
        // NavRail；桌面折叠态改渲染 56px 折叠条（宽度由壳层 splitter 的 collapsedSize 决定），
        // 「面板关闭后仍有可点的重新打开入口」这条 P-class 语义保持不变。
        expect(wrapper.find("aside").attributes("style")).toBeUndefined();
        expect(wrapper.find('[data-testid="nav-rail"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="sidebar-collapsed-strip"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="sidebar-expand"]').exists()).toBe(true);
        // 折叠态面板整块不渲染（v-else），不是渲染了再隐藏。
        expect(wrapper.find('[data-testid="sidebar-panel"]').exists()).toBe(false);
        expect(wrapper.find("aside").attributes("aria-hidden")).toBeUndefined();
        // handle 上移到壳层（两个 splitter panel 之间），不再挂载在 aside 内。
        expect(wrapper.find('[data-testid="sidebar-resizer"]').exists()).toBe(false);
    });

    it("collapses to a zero-width sheet on mobile", async () => {
        mockAuth();
        const wrapper = await mountSidebar({ isMobile: true, open: false });

        // 宽度载体上移到 AppLayout 的 panel 层（dev-3 存量缺陷修法）⇒ aside 不再声明宽度；
        // 「零宽」由壳层 `navPanelStyle` 的 `width: 0px` 持有（见 AppLayout.spec 移动端用例）。
        expect(wrapper.find("aside").attributes("style")).toBeUndefined();
        expect(wrapper.find("aside").attributes("aria-hidden")).toBe("true");
        // PLAN-0762 T2.1：全局 rail 不在任何模块布局内（移动端也不渲染），移动端设置/工作台
        // 仍走各自的抽屉入口。
        expect(wrapper.find('[data-testid="global-rail"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="sidebar-collapsed-strip"]').exists()).toBe(false);
    });

    it("moves the workspace identity to the panel header and drops the lone bottom entry", async () => {
        mockAuth();
        routeState.name = "workspace";
        routeState.path = "/workspace/ws-test";
        const wrapper = await mountSidebar();

        const rows = wrapper.findAll('[data-testid="sidebar-workspace"]');
        expect(rows).toHaveLength(1);
        expect(rows[0]!.text()).toContain("Default Workspace");
        expect(rows[0]!.attributes("aria-current")).toBe("page");

        // The workspace row now precedes the session list instead of trailing it.
        const html = wrapper.html();
        expect(html.indexOf('data-testid="sidebar-workspace"')).toBeLessThan(
            html.indexOf('data-testid="sidebar-session-list"'),
        );

        await rows[0]!.trigger("click");
        await flushPromises();
        expect(pushSpy).toHaveBeenCalledWith("/workspace/ws-test");
    });

    it("filters the session list through the shared search query", async () => {
        mockAuth();
        const store = useSessionStore();
        store.sessions = [
            {
                id: "alpha-1",
                title: "Alpha planning",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
            {
                id: "beta-1",
                title: "Beta review",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
        ];
        const wrapper = await mountSidebar();
        const input = wrapper.get('[data-testid="sidebar-session-search"]');
        expect(input.attributes("placeholder")).toBe("搜索对话...");

        await input.setValue("alpha");
        await flushPromises();

        expect(store.searchQuery).toBe("alpha");
        expect(wrapper.text()).toContain("Alpha planning");
        expect(wrapper.text()).not.toContain("Beta review");

        await wrapper.get('[data-testid="sidebar-search-clear"]').trigger("click");
        expect(store.searchQuery).toBe("");
        expect(wrapper.text()).toContain("Beta review");
    });

    it("shows the live width bubble only while the shell reports resizing (PLAN-0753 T3)", async () => {
        mockAuth();
        // 指针/键盘/双击三条 resize 路径整体上移到壳层（useSplitterPanelBridge 的
        // 6 条契约单测覆盖）；组件侧只剩 render-only 的显隐。
        const idle = await mountSidebar();
        expect(idle.find('[data-testid="sidebar-resize-bubble"]').exists()).toBe(false);

        const resizing = await mountSidebar({ resizing: true });
        // 文本由桥接在 @resize 里命令式写入（不进响应式宽度通道）。
        expect(resizing.get('[data-testid="sidebar-resize-bubble"]').exists()).toBe(true);
    });

    it("collapses the panel from its own header control (S2 ruling #1)", async () => {
        mockAuth();
        const wrapper = await mountSidebar();

        const collapse = wrapper.get('[data-testid="sidebar-collapse"]');
        expect(collapse.attributes("aria-expanded")).toBe("true");
        expect(collapse.attributes("aria-label")).toBe("收起侧边栏");

        await collapse.trigger("click");

        expect(wrapper.emitted("update:open")?.at(-1)).toEqual([false]);
        // The rail no longer exposes any panel/collapse toggle.
        expect(wrapper.find('[data-testid="nav-rail-panel-toggle"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="nav-rail-toggle"]').exists()).toBe(false);
    });
});
describe("Sidebar nav yield (PLAN-0582 S5-W2)", () => {
    it("renders rail-only when the shell yielded the panel, without touching the stored state", async () => {
        mockAuth();
        const wrapper = await mountSidebar({ open: true, forceCollapsed: true });
        // PLAN-0753 T3: 收起由壳层的 collapse() 驱动（panelSizeBeforeCollapseRef 记住
        // 原宽），Sidebar 不再写 aside 宽度 —— 宽度归 splitter panel。
        // PLAN-0762 T2.1：让位不是用户选择 ⇒ 不渲染"折叠条"的重新打开入口，面板保持渲染但 inert。
        expect(wrapper.find('[data-testid="sidebar-collapsed-strip"]').exists()).toBe(false);
        // 让位：面板仍渲染（不是用户折叠），但没有"折叠条"的重新打开入口。
        expect(wrapper.find('[data-testid="sidebar-panel"]').exists()).toBe(true);
        expect(wrapper.get('[data-testid="sidebar"]').attributes("style")).toBeUndefined();
        // Render-only: no state write happens on its own.
        expect(wrapper.emitted("update:open")).toBeUndefined();
    });

    it("leaves the panel rendered when forceCollapsed is false (no false positive)", async () => {
        mockAuth();
        const wrapper = await mountSidebar({ open: true, forceCollapsed: false });
        // 断点夹取（S3a audit P1-3）随几何一起上移到壳层（panel display resize）。
        expect(wrapper.get('[data-testid="sidebar"]').attributes("style")).toBeUndefined();
        expect(
            wrapper.get('[data-testid="sidebar-panel"]').attributes("aria-hidden"),
        ).toBeUndefined();
        expect(wrapper.get('[data-testid="sidebar-workspace"]').exists()).toBe(true);
    });
});
