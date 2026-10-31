import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import type { Router } from "vue-router";
import Sidebar from "../sidebar/Sidebar.vue";
import NavRail from "../sidebar/NavRail.vue";
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

function stubSessionResponse(record: { id: string; title?: string; createdAt?: string }) {
    return {
        id: record.id,
        title: record.title ?? "New Chat",
        workspaceId: "ws-test",
        createdAt: record.createdAt ?? new Date().toISOString(),
        updatedAt: record.createdAt ?? new Date().toISOString(),
    };
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
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

    it("renders settings and logout buttons", async () => {
        mockAuth();
        const wrapper = await mountSidebar();
        expect(wrapper.text()).toContain("设置");
        expect(wrapper.text()).toContain("退出登录");
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

    it("keeps the 56px icon rail mounted and zero-width panel when collapsed on desktop", async () => {
        mockAuth();
        const wrapper = await mountSidebar({ open: false });

        // R-D / S2 ruling #1: collapsing the panel must keep the 56px rail offset.
        expect(wrapper.find("aside").attributes("style")).toContain("width: 56px");
        expect(wrapper.find("[data-testid='sidebar-panel']").attributes("style")).toContain(
            "width: 0px",
        );
        expect(wrapper.findComponent(NavRail).exists()).toBe(true);
        expect(wrapper.find("[data-testid='sidebar-panel']").attributes("aria-hidden")).toBe(
            "true",
        );
        // R-C: the rail itself must stay reachable while the panel is inert.
        expect(wrapper.find("aside").attributes("aria-hidden")).toBeUndefined();
        expect(wrapper.find('[data-testid="nav-rail"]').attributes("inert")).toBeUndefined();
    });

    it("collapses to a zero-width sheet on mobile", async () => {
        mockAuth();
        const wrapper = await mountSidebar({ isMobile: true, open: false });

        expect(wrapper.find("aside").attributes("style")).toContain("width: 0px");
        expect(wrapper.find("aside").attributes("aria-hidden")).toBe("true");
        expect(wrapper.findComponent(NavRail).exists()).toBe(false);
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

    it("resizes the panel with the keyboard on the separator", async () => {
        mockAuth();
        const wrapper = await mountSidebar();
        const separator = wrapper.get('[data-testid="sidebar-resizer"]');
        expect(separator.attributes("role")).toBe("separator");
        expect(separator.attributes("aria-valuenow")).toBe("280");
        expect(separator.attributes("aria-valuemin")).toBe("220");
        expect(separator.attributes("aria-valuemax")).toBe("360");

        await separator.trigger("keydown", { key: "ArrowRight" });
        expect(wrapper.emitted("update:width")?.at(-1)).toEqual([296]);

        await separator.trigger("keydown", { key: "Home" });
        expect(wrapper.emitted("update:width")?.at(-1)).toEqual([220]);

        await separator.trigger("keydown", { key: "End" });
        expect(wrapper.emitted("update:width")?.at(-1)).toEqual([360]);

        await separator.trigger("keydown", { key: "ArrowLeft" });
        expect(wrapper.emitted("update:width")?.at(-1)).toEqual([264]);
    });

    it("resets the panel width on a handle double-click (S3b P2-1)", async () => {
        mockAuth();
        const wrapper = await mountSidebar({ width: 340 });
        await wrapper.get('[data-testid="sidebar-resizer"]').trigger("dblclick");
        expect(wrapper.emitted("update:width")?.at(-1)).toEqual([280]);
    });

    it("shows a live width bubble only while dragging (S3b P2-2)", async () => {
        mockAuth();
        const wrapper = await mountSidebar();
        const separator = wrapper.get('[data-testid="sidebar-resizer"]');
        expect(wrapper.find('[data-testid="sidebar-resize-bubble"]').exists()).toBe(false);

        await separator.trigger("mousedown", { clientX: 300 });
        document.dispatchEvent(new MouseEvent("mousemove", { clientX: 320 }));
        await wrapper.vm.$nextTick();
        expect(wrapper.get('[data-testid="sidebar-resize-bubble"]').text()).toContain("px");

        document.dispatchEvent(new MouseEvent("mouseup"));
        await wrapper.vm.$nextTick();
        expect(wrapper.find('[data-testid="sidebar-resize-bubble"]').exists()).toBe(false);
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
        // The aside collapses to the fixed rail (56px); the panel itself is 0 wide.
        expect(wrapper.get('[data-testid="sidebar"]').attributes("style")).toContain("width: 56px");
        expect(wrapper.get('[data-testid="sidebar-panel"]').attributes("style")).toContain(
            "width: 0px",
        );
        // Render-only: no state write happens on its own.
        expect(wrapper.emitted("update:open")).toBeUndefined();
    });

    it("leaves the panel rendered when forceCollapsed is false (no false positive)", async () => {
        mockAuth();
        const wrapper = await mountSidebar({ open: true, forceCollapsed: false });
        // jsdom viewport is 1024 -> the panel width is breakpoint-clamped to 240
        // (S3a audit P1-3), so rail 56 + 240 = 296.
        expect(wrapper.get('[data-testid="sidebar-panel"]').attributes("style")).toContain(
            "width: 240px",
        );
        expect(wrapper.get('[data-testid="sidebar"]').attributes("style")).toContain(
            "width: 296px",
        );
    });
});
