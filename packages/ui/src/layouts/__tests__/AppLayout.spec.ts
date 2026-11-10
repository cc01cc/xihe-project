import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import { api } from "../../composables/api";
import type * as apiModule from "../../composables/api";
import { useAuthStore } from "../../stores/auth";
import { useSessionStore } from "../../stores/session";
import AppLayout from "../AppLayout.vue";

vi.mock("../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            getPendingApprovals: vi.fn<typeof apiModule.api.getPendingApprovals>(),
            getWorkspace: vi.fn<typeof apiModule.api.getWorkspace>(),
            decideChatApproval: vi.fn<typeof apiModule.api.decideChatApproval>(),
        },
    };
});

const i18n = createI18n({
    legacy: false,
    locale: "en",
    messages: {
        en: {
            sidebar: {
                pendingApprovalBadge: "Pending approval",
                pendingApprovalBanner: "A session is waiting for approval",
                pendingApprovalCount: "items pending",
                pendingApprovalGoTo: "Review now",
                pendingApprovalLive: "Pending approval count updated",
                resize: "Resize navigation panel",
            },
        },
    },
});

function createTestRouter() {
    return createRouter({
        history: createMemoryHistory(),
        routes: [
            {
                path: "/workspace/:workspaceId/chat/:sessionId",
                component: { template: '<div data-testid="route-view" />' },
            },
            { path: "/workspace", component: { template: '<div data-testid="route-view" />' } },
            {
                path: "/workspace/:workspaceId",
                component: { template: '<div data-testid="route-view" />' },
            },
        ],
    });
}

async function mountLayout(
    router: ReturnType<typeof createTestRouter>,
    path = "/workspace/workspace-1/chat/current",
) {
    await router.push(path);
    await router.isReady();
    const wrapper = mount(AppLayout, {
        global: {
            plugins: [router, i18n],
            stubs: {
                Sidebar: { template: '<aside data-testid="sidebar-stub" />' },
                "router-view": { template: '<div data-testid="route-view" />' },
            },
        },
    });
    await flushPromises();
    return wrapper;
}

beforeEach(async () => {
    setActivePinia(createPinia());
    localStorage.clear();
    // PLAN-0660 T5.6：AppLayout 现在挂载时就会订阅 user-channel。本套用例考的是布局与审批 IA，
    // 所以这里把 `fetch` 停在一个**永不完结**的请求上：既不真的出网，也不触发退避重连定时器，
    // 输出里就不会混进与本套件无关的连接噪音（`AppLayoutUserChannel.spec.ts` 专测那条链路）。
    vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined)),
    );
    // PLAN-0608 I6（预期变更，判据未削弱）：`hydrateWorkspace` 不再用
    // `/workspaces/current` 回填回退值，所以「已有 workspace」必须由 tab 上下文提供。
    // 本组用例考的是审批 banner/轮询，不是上下文解析 ⇒ 显式播种上下文即可，
    // 断言（banner 出现/计数/轮询次数/导航）一条未改。
    const { writeTabWorkspaceId } = await import("../../lib/workspaceContext");
    writeTabWorkspaceId("workspace-1");
    vi.clearAllMocks();
    vi.mocked(api.getPendingApprovals).mockResolvedValue([]);
    vi.mocked(api.getWorkspace).mockResolvedValue({ id: "workspace-1", name: "Workspace" });
    const auth = useAuthStore();
    auth.$patch({
        token: "token",
        user: { id: "user-1", email: "test@xihe.local" },
        workspace: { id: "workspace-1", name: "Workspace" },
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("AppLayout navigation IA (PLAN-0582 S1/S2 → PLAN-0753 T3 splitter)", () => {
    it("renders nav|main as splitter panels with the resize handle between them", async () => {
        const wrapper = await mountLayout(createTestRouter());

        // PLAN-0753 T3: 壳的几何归 reka SplitterGroup —— 导航是 panel #1（aside 不再
        // fixed、main 不再用 margin 清位），main 是 panel #2，handle 是两项之间的
        // flex 项（`-ml-1` 抵消自身 4px ⇒ 主列起始位与旧几何一致）。
        const group = wrapper.get("[data-panel-group]");
        expect(group.attributes("data-orientation")).toBe("horizontal");

        const panels = wrapper.findAll("[data-panel]");
        expect(panels.length).toBe(2);
        // `as-child`：导航面板**就是 aside 本身**（不另套一层 div），这也是像素几何
        // 与旧 `aside + fixed` 对齐的前提。
        expect(panels[0].element.tagName).toBe("ASIDE");
        expect(panels[0].attributes("data-testid")).toBe("sidebar-stub");
        expect(panels[1].find("main").exists()).toBe(true);
        // S2 ruling #1 / R-D：navOpen 默认开 ⇒ 可折叠面板处于 expanded。
        expect(panels[0].attributes("data-panel-collapsible")).toBe("true");
        expect(panels[0].attributes("data-state")).toBe("expanded");

        // 主列不再由 margin-left 偏移（旧的 fixed aside + marginLeft 组合退场）。
        expect(wrapper.get("main").attributes("style") ?? "").not.toContain("margin");

        // testid/aria 走 handle 的 fallthrough attrs（不 fork SplitterResizeHandle）。
        // data-panel-resize-handle-id 是桥接 keydown 路由的定位键：必须等于
        // AppLayout 的 NAV_RESIZE_HANDLE_ID（否则键盘纪律整条失效）。
        const handle = wrapper.get('[data-testid="sidebar-resizer"]');
        expect(handle.attributes("role")).toBe("separator");
        expect(handle.attributes("aria-orientation")).toBe("vertical");
        expect(handle.attributes("aria-label")).toBe("Resize navigation panel");
        expect(handle.attributes("data-panel-resize-handle-id")).toBe("nav-resize-handle");
        // aria-valuenow/min/max 的**标度所有权**：首帧是 fallthrough 的像素初值，
        // group 测量到几何后由 reka 用 0–100 百分比接管（dev-3 裁定 ③）；首帧值见下一条用例。
    });

    it("exposes the stored width as px aria range values on the first frame (fallthrough)", async () => {
        const router = createTestRouter();
        await router.push("/workspace/workspace-1/chat/current");
        await router.isReady();
        const wrapper = mount(AppLayout, {
            global: {
                plugins: [router, i18n],
                stubs: {
                    Sidebar: { template: '<aside data-testid="sidebar-stub" />' },
                    "router-view": { template: '<div data-testid="route-view" />' },
                },
            },
        });

        // 测量前：fallthrough 绑定就是消费面看到的初值（像素标度，与旧手写 handle 一致）。
        const handle = wrapper.get('[data-testid="sidebar-resizer"]');
        expect(handle.attributes("aria-valuenow")).toBe("280");
        expect(handle.attributes("aria-valuemin")).toBe("220");
        expect(handle.attributes("aria-valuemax")).toBe("360");

        // 测量后：reka 的 useWindowSplitterPanelGroupBehavior 会 remove/set 这三个属性，
        // 生产环境里落成百分比标度（min/now/max 同标度自洽）。jsdom 无可测几何 ⇒ 该效果
        // 删掉后不再写；故此后只锁语义属性仍在，不锁测量后的标度（浏览器侧由 e2e/AB 核）。
        await flushPromises();
        expect(wrapper.get('[data-testid="sidebar-resizer"]').attributes("role")).toBe("separator");
    });

    it("collapses the nav panel to the rail button when the stored state is closed", async () => {
        localStorage.setItem(
            "xihe-layout-global",
            JSON.stringify({ railCollapsed: false, navOpen: false, navWidth: 300 }),
        );
        const wrapper = await mountLayout(createTestRouter());

        // R-D: 收起只发生在 panel 内（collapsible + collapsedSize = 56px rail），
        // 面板 data-state 是 reka 的折叠语义（defaultSize === collapsedSize）。
        const panels = wrapper.findAll("[data-panel]");
        expect(panels[0].attributes("data-state")).toBe("collapsed");
        // 收起时 handle 卸载（旧行为 `v-if="!isMobile && open"`）。
        expect(wrapper.find('[data-testid="sidebar-resizer"]').exists()).toBe(false);
        // 主列仍然渲染（面板收起不等于主列退场）。
        expect(wrapper.find("main").exists()).toBe(true);
    });

    it("keeps the mobile drawer out of the flex flow (zero width footprint)", async () => {
        // dev-3 carve-out A：移动端 panel #1 不得参与 split ⇒ 不得有占位宽度。
        // jsdom 无布局引擎，用「不参与 flex 流」的等效判据（浏览器侧
        // getBoundingClientRect().width===0 由 e2e/AB 轮取证）：
        //   ① aside 的 computed class 是 fixed（position:fixed 的 flex 子项不参与 flex 布局）；
        //   ② 该面板的 defaultSize 退化为 collapsedSize=56 且 handle 卸载（无拖拽面）；
        //   ③ 主列（panel #2）是唯一 flex 项，独占整行。
        vi.stubGlobal("matchMedia", ((query: string) => ({
            matches: true,
            media: query,
            onchange: null,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            addListener: () => undefined,
            removeListener: () => undefined,
            dispatchEvent: () => false,
        })) as unknown as typeof window.matchMedia);
        vi.resetModules();
        const { default: FreshAppLayout } = await import("../AppLayout.vue");
        const { default: FreshSidebar } = await import("../../components/sidebar/Sidebar.vue");
        const router = createTestRouter();
        await router.push("/workspace/workspace-1/chat/current");
        await router.isReady();
        const wrapper = mount(FreshAppLayout, {
            global: {
                plugins: [router, i18n],
                stubs: {
                    Sidebar: FreshSidebar,
                    "router-view": { template: '<div data-testid="route-view" />' },
                },
            },
        });
        await flushPromises();

        const aside = wrapper.get('[data-testid="sidebar"]');
        expect(aside.classes()).toContain("fixed");
        // 宽度载体在 panel 层（dev-3 存量缺陷修法）：组件不再声明 aside 宽度，
        // 改由 AppLayout 的 `navPanelStyle` 在 panel 载体上声明 `flex: none` + 显式宽度。
        const panelStyle = aside.attributes("style") ?? "";
        expect(panelStyle).toContain("flex: 0 0 auto");
        expect(panelStyle).toContain("width: 0px");
        // 抽屉面板的默认宽退化为 56（collapsedSize）⇒ 无内容宽度声明，不参与 flex 分配。
        expect(aside.attributes("data-panel-size")).toBe("56.0");
        // handle 在移动端卸载（抽屉不进 split）。
        expect(wrapper.find('[data-testid="sidebar-resizer"]').exists()).toBe(false);
        // 主列（panel #2）是唯一 flex 项，独占整行。
        const panels = wrapper.findAll("[data-panel]");
        expect(panels.length).toBe(2);
        expect(panels[1].find("main").exists()).toBe(true);
        wrapper.unmount();
    });

    it("commits keyboard and double-click widths through the shell bridge", async () => {
        localStorage.setItem(
            "xihe-layout-global",
            JSON.stringify({ navOpen: true, navWidth: 340 }),
        );
        const wrapper = await mountLayout(createTestRouter());
        const readNavWidth = () =>
            (
                JSON.parse(localStorage.getItem("xihe-layout-global") ?? "{}") as {
                    navWidth?: number;
                }
            ).navWidth;

        // 键盘纪律：ArrowRight = +16（夹到 220–360），一次按键恰一次存储写。
        await wrapper.get('[data-testid="sidebar-resizer"]').trigger("keydown", {
            key: "ArrowRight",
        });
        await flushPromises();
        expect(readNavWidth()).toBe(356);

        // 双击复位默认宽（280），同样只写一次。
        await wrapper.get('[data-testid="sidebar-resizer"]').trigger("dblclick");
        await flushPromises();
        expect(readNavWidth()).toBe(280);
    });

    it("clears the user-scoped layout keys when the session is logged out", async () => {
        localStorage.setItem("xihe-layout-global", JSON.stringify({ navOpen: true }));
        localStorage.setItem("xihe-layout-ws:workspace-1", "{}");
        await mountLayout(createTestRouter());

        useAuthStore().$patch({ token: null, user: null });
        await flushPromises();

        expect(localStorage.getItem("xihe-layout-global")).toBeNull();
        expect(localStorage.getItem("xihe-layout-ws:workspace-1")).toBeNull();
    });
});

describe("AppLayout pending approval indicators", () => {
    it("renders the global banner for another session and navigates without deciding", async () => {
        vi.mocked(api.getPendingApprovals).mockResolvedValue([
            {
                sessionId: "other-session",
                workspaceId: "workspace-1",
                count: 2,
                oldestRequestedAt: "2026-09-14T12:00:00Z",
            },
        ]);
        const router = createTestRouter(),
            wrapper = await mountLayout(router);

        expect(wrapper.find('[data-testid="global-pending-approval-banner"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="global-pending-approval-banner"]').text()).toContain(
            "2",
        );
        expect(wrapper.find('[data-testid="pending-approval-live"]').attributes("aria-live")).toBe(
            "polite",
        );

        await wrapper.find('[data-testid="global-pending-approval-go-to"]').trigger("click");
        await flushPromises();

        expect(router.currentRoute.value.fullPath).toBe(
            "/workspace/workspace-1/chat/other-session",
        );
        expect(api.decideChatApproval).not.toHaveBeenCalled();
    });

    it("does not render a global banner for the current session", async () => {
        vi.mocked(api.getPendingApprovals).mockResolvedValue([
            {
                sessionId: "current",
                workspaceId: "workspace-1",
                count: 1,
                oldestRequestedAt: "2026-09-14T12:00:00Z",
            },
        ]);
        const wrapper = await mountLayout(createTestRouter());

        expect(wrapper.find('[data-testid="global-pending-approval-banner"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="pending-approval-live"]').text()).toContain("1");
    });

    it("uses the session store current session for the workspace landing route", async () => {
        useSessionStore().selectSession("current");
        vi.mocked(api.getPendingApprovals).mockResolvedValue([
            {
                sessionId: "current",
                workspaceId: "workspace-1",
                count: 1,
                oldestRequestedAt: "2026-09-14T12:00:00Z",
            },
        ]);
        const wrapper = await mountLayout(createTestRouter(), "/workspace");

        expect(wrapper.find('[data-testid="global-pending-approval-banner"]').exists()).toBe(false);
    });

    it("uses the session store current session for workspace routes", async () => {
        useSessionStore().selectSession("current");
        vi.mocked(api.getPendingApprovals).mockResolvedValue([
            {
                sessionId: "current",
                workspaceId: "workspace-1",
                count: 1,
                oldestRequestedAt: "2026-09-14T12:00:00Z",
            },
        ]);
        const wrapper = await mountLayout(createTestRouter(), "/workspace/workspace-1");

        expect(wrapper.find('[data-testid="global-pending-approval-banner"]').exists()).toBe(false);
    });

    it("does not render a banner for zero-count summaries", async () => {
        vi.mocked(api.getPendingApprovals).mockResolvedValue([
            {
                sessionId: "other-session",
                workspaceId: "workspace-1",
                count: 0,
                oldestRequestedAt: "",
            },
        ]);
        const wrapper = await mountLayout(createTestRouter());

        expect(wrapper.find('[data-testid="global-pending-approval-banner"]').exists()).toBe(false);
    });

    it("refreshes once on mount and once per conservative poll interval", async () => {
        vi.useFakeTimers();
        try {
            const wrapper = await mountLayout(createTestRouter());
            expect(api.getPendingApprovals).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(10_000);
            await flushPromises();
            expect(api.getPendingApprovals).toHaveBeenCalledTimes(2);
            wrapper.unmount();
        } finally {
            vi.useRealTimers();
        }
    });
});
