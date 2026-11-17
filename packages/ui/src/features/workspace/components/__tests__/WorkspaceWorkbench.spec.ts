import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import type { Router } from "vue-router";
import WorkspaceWorkbench from "../WorkspaceWorkbench.vue";
import { shouldOpenAgentsDockFromDeepLink } from "../workspaceDockTabs";
import { TREE_COLLAPSED_WIDTH } from "../../../../composables/useWorkspaceLayout";
import { useAuthStore } from "../../../../stores/auth";
import { useWorkspaceStore } from "../../stores/workspace";

const { toastWarning } = vi.hoisted(() => ({ toastWarning: vi.fn<(message: string) => void>() }));

vi.mock("vue-sonner", () => ({
    toast: {
        warning: toastWarning,
        success: vi.fn<(message?: string) => void>(),
        error: vi.fn<(message?: string) => void>(),
        info: vi.fn<(message?: string) => void>(),
    },
}));

/**
 * task-44：`useRoute()` 的 query 必须可改 —— 深链 `?agent=<pid>` 是**行为**，写死 `{}`
 * 就永远只能测到"没有深链"那一支。hook 里用 `vi.hoisted` 保证 mock 工厂拿到同一个对象。
 */
const routeQuery = vi.hoisted(() => ({ value: {} as Record<string, string> }));

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
    useRoute: () => ({ params: {}, path: "/workspace/workspace-1", query: routeQuery.value }),
    useRouter: () => ({
        push: vi.fn<Router["push"]>(),
        replace: vi.fn<Router["replace"]>(),
    }),
}));

const i18n = createI18n({
    legacy: false,
    locale: "en",
    messages: {
        en: {
            workspace: {
                panelCode: "Code",
                panelChanges: "Changes",
                panelMonitor: "Monitor",
                panelContext: "Session settings",
                panelAgents: "Agents",
                panelDelegation: "Delegation",
                toggleDelegation: "Toggle delegation",
                closePanel: "Close the auxiliary panel",
                dockTabs: "Workbench panels",
                dockOverflow: "More panels",
                dockCloseTab: "Close this panel",
                dockResize: "Resize the panel",
                dockFocusExpand: "Expand panel",
                dockFocusRestore: "Restore layout",
                dockFocusHint: "Fill the workspace with this panel",
                expandFiles: "Expand the file tree",
                collapseFiles: "Collapse the file tree",
                toggleCode: "Toggle code",
                toggleDiff: "Toggle changes",
                toggleMonitor: "Toggle monitor",
                noSession: "No active session",
                agentManagement: "Agent management",
                addWorkspace: "Add workspace",
                settingsTitle: "Workspace settings",
                scheduledTasks: { nav: "Scheduled tasks" },
            },
            sidebar: { newChat: "New chat", toolbarMore: "More" },
        },
    },
});

const stubs = {
    FileTreePanel: {
        emits: ["collapse"],
        template: `<div data-testid="file-tree-stub"><button data-testid="workspace-toolbar-toggle-tree" @click="$emit('collapse')" /></div>`,
    },
    FileEditor: { template: '<div data-testid="file-editor-stub" />' },
    WorkspaceChangesPanel: { template: '<div data-testid="changes-panel-stub" />' },
    SessionMonitorPanel: { template: '<div data-testid="session-monitor-stub" />' },
    SessionContextPanel: {
        props: { sessionId: { type: String, default: null } },
        template: '<div data-testid="session-context-panel-stub" />',
    },
    WorkspaceAgentsPanel: {
        props: {
            workspaceId: { type: String, default: "" },
            expandPrincipalId: { type: String, default: null },
        },
        template:
            '<div data-testid="agents-panel-stub" :data-expand-principal="expandPrincipalId" />',
    },
    DelegationDagPanel: {
        props: { sessionId: { type: String, default: "" } },
        template: '<div data-testid="delegation-dag-stub" />',
    },
};

/**
 * BL-376：**本文件所有挂载都必须经此函数登记**，`afterEach` 统一 `unmount()`。
 * 原因：布局持久化是 250 ms 合并写入（`createWorkspaceLayoutWriter`）。未被卸载的实例会让
 * pending timer 活到**下一条用例**里落地，把桌面布局写进"移动端不该持久化"的断言（时红时绿）。
 */
const mountedWrappers: VueWrapper[] = [];

function mountWorkbench(
    props: Partial<{
        workspaceId: string;
        sessionId: string | null;
        isMobile: boolean;
    }> = {},
) {
    const wrapper = mount(WorkspaceWorkbench, {
        props: {
            workspaceId: "workspace-1",
            sessionId: "session-1",
            isMobile: false,
            ...props,
        },
        global: { plugins: [i18n], stubs },
    }) as VueWrapper;
    mountedWrappers.push(wrapper);
    return wrapper;
}

afterEach(() => {
    // 卸载会把 pending 的合并写入 flush 在本用例内（`onBeforeUnmount`），下一条用例的
    // `localStorage.clear()` 就能清掉它 —— 这才是"没有活实例的 timer 跨用例"的真解。
    for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount();
    // 视口也要复位：漏掉这一步会让"设了 1920"的用例把宽度漏给下一条（顺序依赖）。
    setViewport(VIEWPORT_DEFAULT);
});

function storedLayout(workspaceId = "workspace-1"): Record<string, unknown> {
    return JSON.parse(localStorage.getItem(`xihe-layout-ws:${workspaceId}`) ?? "{}") as Record<
        string,
        unknown
    >;
}

/**
 * D-1777/D-1778（task-65 A 段）：宽屏首启布局 = 右栏开着，files（目录树）面板在右栏容器里。
 * jsdom 报 1024 ⇒ 默认（无存储）布局是 dock 收起、无 files 页签；要测树就先显式种一份。
 */
function seedWideLayout(overrides: Record<string, unknown> = {}): void {
    localStorage.setItem(
        "xihe-layout-ws:workspace-1",
        JSON.stringify({
            treeCollapsed: false,
            treeWidth: 240,
            dockCollapsed: false,
            dockWidth: 360,
            dockTabs: ["files", "monitor"],
            activeDockTab: "files",
            dockMode: "pinned",
            dockModeManual: false,
            openTabs: ["session:s1"],
            ...overrides,
        }),
    );
}

/** S3b P2-9: writes are coalesced, so persistence assertions have to poll. */
async function expectStored(check: () => void): Promise<void> {
    await vi.waitFor(check, { timeout: 2000, interval: 20 });
}

/**
 * task-94 S4：**视口是显式变量**。jsdom 恒 1024，而「两栏还是单栏」由挤压模型按 640 硬底线算
 * （`forceSingleColumn`）⇒ 凡是要断言**桌面两栏**的用例必须先写明宽视口，否则它测的是单栏形态，
 * 而单栏下右栏被规则挡在视口外（症状就是「`workspace-aux-panel` 取不到」）。
 *
 * <p>注意本文件挂载时**没有布局 provider**，挤压模型的兜底把「工作台行宽」当作 `innerWidth`
 * （真实 app 里还要减 56 rail + 会话列 240/280）。所以这里的单栏阈值是 `innerWidth < 1000`
 * 而不是产品上的 ~1390 —— 用例按这个口径取数，别拿产品阈值来对。</p>
 */
const VIEWPORT_DEFAULT = window.innerWidth;
function setViewport(width: number): void {
    window.innerWidth = width;
    window.dispatchEvent(new Event("resize"));
}

/** 桌面两栏 + **空右栏**（显式种子：<1800 首启现在也带 files 页签，别让默认值决定用例）。 */
function seedDesktopDock(overrides: Record<string, unknown> = {}): void {
    setViewport(1920);
    seedWideLayout({ dockTabs: [], activeDockTab: null, dockCollapsed: true, ...overrides });
}

beforeEach(() => {
    routeQuery.value = {};
    setActivePinia(createPinia());
    localStorage.clear();
    // BL-359：清掉 toast 警告的**调用记录**。`not.toHaveBeenCalled()` 断的是"本用例没触发警告"，
    // 但前一条用例的调用残留在同一个 mock 上 ⇒ 用例顺序一变就红。
    toastWarning.mockClear();
    const auth = useAuthStore();
    auth.$patch({
        token: "token",
        user: { id: "user-1", email: "test@xihe.local" },
        workspace: { id: "workspace-1", name: "Mock Workspace", ownerId: "user-1" },
    });
});

/**
 * task-174（S2b）：页签行的计数**只针对 dock** —— 容器页签行（树/内容）是独立的一层，
 * 用全页 `[role="tab"]` 数会把两层混在一起（本轮实测：四条用例各 +1，全部来自树容器行）。
 */
const DOCK_TAB = '[aria-label="Workbench panels"] [role="tab"]';

describe("WorkspaceWorkbench skeleton (PLAN-0582 S2)", () => {
    it("renders the toolbar, the file tree (right container files panel) and the conversation slot", async () => {
        seedWideLayout();
        const wrapper = mountWorkbench();
        await flushPromises();

        expect(wrapper.find('[data-testid="workspace-workbench"]').exists()).toBe(true);
        // D-1777/D-1778：树是右栏容器的 files 面板（不再是中栏里的独立列）。
        expect(wrapper.find('[data-testid="workspace-file-tree"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="file-tree-stub"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="workspace-toolbar-code"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="dock-tab-files"]').exists()).toBe(true);
        expect(
            wrapper
                .get('[data-testid="workspace-container-tabs"][data-container="right"]')
                .exists(),
        ).toBe(true);
    });

    it("D4（task-94 S5）：<1800 首启就带 files 页签，不是「树不在这个版本里」", async () => {
        // 旧缺口（C2）：1024 档首启 `dockTabs=[]` ⇒ 右栏没有树，用户会以为树不存在。
        setViewport(1024);
        const wrapper = mountWorkbench();
        await flushPromises();

        // 两档差异只剩「dock 是否已展开」：<1800 仍收起。
        expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(false);

        // 但 files 已经在页签集合里（首启默认值给的，不是用户自己找出来的）。
        await wrapper.get('[data-testid="workspace-toolbar-code"]').trigger("click");
        await expectStored(() =>
            expect(storedLayout().dockTabs).toEqual(["files", "monitor", "code"]),
        );
        expect(storedLayout().activeDockTab).toBe("code");

        // 切到 files ⇒ 恰好 1 个文件树面板（D4 判据后半句）。
        await wrapper.get('[data-testid="dock-tab-files"]').trigger("click");
        expect(wrapper.findAll('[data-testid="workspace-file-tree"]')).toHaveLength(1);
    });

    it("opens the dock on the requested tab and mounts only that panel", async () => {
        seedDesktopDock();
        const wrapper = mountWorkbench();
        await flushPromises();

        await wrapper.get('[data-testid="workspace-toolbar-code"]').trigger("click");

        expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(true);
        expect(
            wrapper.get('[data-testid="workspace-toolbar-code"]').attributes("aria-pressed"),
        ).toBe("true");
        expect(wrapper.find('[data-testid="dock-tab-code"]').attributes("aria-selected")).toBe(
            "true",
        );
        expect(wrapper.find('[data-testid="file-editor-stub"]').exists()).toBe(true);

        await wrapper.get('[data-testid="workspace-toolbar-changes"]').trigger("click");

        // Two tabs stay open; the inactive one keeps its tab but not its content.
        expect(wrapper.findAll(DOCK_TAB)).toHaveLength(2);
        expect(wrapper.find('[data-testid="dock-tab-code"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="file-editor-stub"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="changes-panel-stub"]').exists()).toBe(true);
        expect(
            wrapper.get('[data-testid="workspace-toolbar-code"]').attributes("aria-pressed"),
        ).toBe("false");
    });

    it("opens the delegation DAG panel from the toolbar toggle (PLAN-0659 T1.4)", async () => {
        const wrapper = mountWorkbench();
        await flushPromises();

        const toggle = wrapper.get('[data-testid="workspace-toolbar-delegation"]');
        expect(toggle.attributes("aria-pressed")).toBe("false");
        await toggle.trigger("click");

        // dock 里多出 delegation tab，且渲染的是委派面板（不是别的面板的槽位）。
        expect(wrapper.get('[data-testid="dock-tab-delegation"]').text()).toContain("Delegation");
        expect(wrapper.find('[data-testid="delegation-dag-stub"]').exists()).toBe(true);
        expect(toggle.attributes("aria-pressed")).toBe("true");
        await expectStored(() => {
            expect(storedLayout().dockTabs).toContain("delegation");
            expect(storedLayout().activeDockTab).toBe("delegation");
        });
    });

    it("collapses the dock from the active toolbar toggle but keeps the tab set", async () => {
        seedDesktopDock();
        const wrapper = mountWorkbench();
        await flushPromises();

        await wrapper.get('[data-testid="workspace-toolbar-code"]').trigger("click");
        await wrapper.get('[data-testid="workspace-toolbar-code"]').trigger("click");

        expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(false);
        await expectStored(() => {
            expect(storedLayout().dockCollapsed).toBe(true);
            expect(storedLayout().dockTabs).toEqual(["code"]);
        });

        await wrapper.get('[data-testid="workspace-toolbar-code"]').trigger("click");
        // Re-opening does not duplicate the tab.
        expect(wrapper.findAll(DOCK_TAB)).toHaveLength(1);
    });

    it("closes dock tabs and rolls the dock up when the last one closes", async () => {
        seedDesktopDock();
        const wrapper = mountWorkbench();
        await flushPromises();

        await wrapper.get('[data-testid="workspace-toolbar-code"]').trigger("click");
        await wrapper.get('[data-testid="workspace-toolbar-monitor"]').trigger("click");
        expect(wrapper.findAll(DOCK_TAB)).toHaveLength(2);

        await wrapper.get('[data-testid="dock-tab-close-monitor"]').trigger("click");
        expect(wrapper.findAll(DOCK_TAB)).toHaveLength(1);
        expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(true);

        // Middle click closes the remaining tab and the empty dock rolls up.
        await wrapper.get('[data-testid="dock-tab-code"]').trigger("auxclick", { button: 1 });
        expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(false);
        await expectStored(() => {
            expect(storedLayout().dockTabs).toEqual([]);
            expect(storedLayout().dockCollapsed).toBe(true);
        });
    });

    it("activates the neighbouring tab when the active tab closes (right first, then left)", async () => {
        // PLAN-0626 D26-13: browser-tab convention instead of "always jump to the first tab".
        seedDesktopDock();
        const wrapper = mountWorkbench();
        await flushPromises();

        // Strip order: code, changes, monitor.
        await wrapper.get('[data-testid="workspace-toolbar-code"]').trigger("click");
        await wrapper.get('[data-testid="workspace-toolbar-changes"]').trigger("click");
        await wrapper.get('[data-testid="workspace-toolbar-monitor"]').trigger("click");
        expect(wrapper.findAll(DOCK_TAB)).toHaveLength(3);

        // Close the middle tab while it is active: its right neighbour takes over.
        await wrapper.get('[data-testid="dock-tab-changes"]').trigger("click");
        expect(wrapper.get('[data-testid="dock-tab-changes"]').attributes("aria-selected")).toBe(
            "true",
        );
        await wrapper.get('[data-testid="dock-tab-close-changes"]').trigger("click");
        expect(wrapper.get('[data-testid="dock-tab-monitor"]').attributes("aria-selected")).toBe(
            "true",
        );
        expect(wrapper.get('[data-testid="dock-tab-code"]').attributes("aria-selected")).toBe(
            "false",
        );

        // The rightmost active tab has no right neighbour, so the left one wins.
        await wrapper.get('[data-testid="dock-tab-close-monitor"]').trigger("click");
        expect(wrapper.get('[data-testid="dock-tab-code"]').attributes("aria-selected")).toBe(
            "true",
        );
        expect(wrapper.findAll(DOCK_TAB)).toHaveLength(1);
    });

    it("expands the dock across the main column without unmounting it (D26-04)", async () => {
        const wrapper = mountWorkbench(),
            // Queried before focusing: the element survives a v-show toggle, so holding
            // the reference also proves the column was not remounted.
            center = wrapper.get("[data-main-hidden]");
        await flushPromises();
        await wrapper.get('[data-testid="workspace-toolbar-code"]').trigger("click");

        await wrapper.get('[data-testid="dock-focus-toggle"]').trigger("click");

        // The main column is only hidden: unmounting it would drop the chat SSE.
        expect(center.attributes("data-main-hidden")).toBe("true");
        expect(center.isVisible()).toBe(false);
        expect((center.element as HTMLElement).style.display).toBe("none");
        // The dock is the growing flex child and its resizer is gone.
        expect(wrapper.get('[data-testid="workspace-aux-panel"]').classes()).toContain("flex-1");
        expect(wrapper.find('[data-testid="dock-resizer"]').exists()).toBe(false);
        // task-81：整个中栏也退场，不只是藏里面那一列。
        // 只藏 workspace-main 时，它的祖父 workspace-center 仍是 flex-grow:1 的空盒子
        // ⇒ 跟右栏各拿 50%（实测 dock/workbench = 0.5003，「放大面板」只占半页）。
        // jsdom 没有布局引擎、量不到宽度（先例见 layouts/__tests__/AppLayout.spec.ts:191-197），
        // 所以这里只断机制；份额由 e2e/mock/task81-focus-share.spec.ts 断。
        const centerWrapper = wrapper.get('[data-testid="workspace-center"]');
        expect(centerWrapper.exists()).toBe(true); // 仍是 v-show：挂载着，只是不参与布局
        expect((centerWrapper.element as HTMLElement).style.display).toBe("none");
        // Focus is persisted and never reports a forced-floating fallback.
        await expectStored(() => expect(storedLayout().dockFocus).toBe(true));
        expect(toastWarning).not.toHaveBeenCalled();
    });

    it("restores the previous width when focus ends (D26-04)", async () => {
        seedDesktopDock();
        const wrapper = mountWorkbench();
        await flushPromises();
        await wrapper.get('[data-testid="workspace-toolbar-code"]').trigger("click");
        await wrapper.get('[data-testid="dock-resizer"]').trigger("keydown", { key: "End" });

        await wrapper.get('[data-testid="dock-focus-toggle"]').trigger("click");
        expect(
            wrapper.get('[data-testid="workspace-aux-panel"]').attributes("style"),
        ).toBeUndefined();

        await wrapper.get('[data-testid="dock-focus-toggle"]').trigger("click");

        // Back to the stored (non-focus) geometry: width 480, resizer available again.
        expect(wrapper.get('[data-testid="workspace-aux-panel"]').attributes("style")).toContain(
            "width: 480px",
        );
        expect(wrapper.find('[data-testid="dock-resizer"]').exists()).toBe(true);
        expect(wrapper.get("[data-main-hidden]").isVisible()).toBe(true);
        // task-81：中栏整列也必须还原回场上（v-show 撤回 ⇒ 不再 display:none）。
        expect(
            (wrapper.get('[data-testid="workspace-center"]').element as HTMLElement).style.display,
        ).not.toBe("none");
        await expectStored(() => expect(storedLayout().dockFocus).toBe(false));
    });

    it("leaves focus on Escape without rolling the dock up (D26-04)", async () => {
        const wrapper = mountWorkbench();
        await flushPromises();
        await wrapper.get('[data-testid="workspace-toolbar-code"]').trigger("click");
        await wrapper.get('[data-testid="dock-focus-toggle"]').trigger("click");

        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await flushPromises();

        // Focused docks are flex children, so the floating-only Escape rule must not
        // apply; Escape restores the layout instead of closing the panel.
        expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(true);
        expect(
            wrapper.get('[data-testid="workspace-aux-panel"]').attributes("data-dock-focus"),
        ).toBe("false");
        expect(wrapper.get("[data-main-hidden]").isVisible()).toBe(true);
    });

    it("clears focus when the dock collapses (D26-05)", async () => {
        const wrapper = mountWorkbench();
        await flushPromises();
        await wrapper.get('[data-testid="workspace-toolbar-code"]').trigger("click");
        await wrapper.get('[data-testid="dock-focus-toggle"]').trigger("click");

        await wrapper.get('[data-testid="workspace-aux-close"]').trigger("click");

        expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(false);
        // The main column comes back and the stored flag is cleared with the collapse.
        expect(wrapper.get("[data-main-hidden]").isVisible()).toBe(true);
        await expectStored(() => {
            expect(storedLayout().dockCollapsed).toBe(true);
            expect(storedLayout().dockFocus).toBe(false);
        });
    });

    it("opens the context panel through the exposed openDockTab (PLAN-0626 M2)", async () => {
        // The chat column is the page's slot content, so the page reaches the dock here.
        const wrapper = mountWorkbench();
        await flushPromises();

        (wrapper.vm as unknown as { openDockTab: (id: string) => void }).openDockTab("context");
        await flushPromises();

        expect(wrapper.get('[data-testid="dock-tab-context"]').attributes("aria-selected")).toBe(
            "true",
        );
        expect(wrapper.find('[data-testid="session-context-panel-stub"]').exists()).toBe(true);
        // Sticky panel wrapper proves it is mounted through the dock's slot path.
        expect(wrapper.find('[data-testid="dock-sticky-panel-context"]').exists()).toBe(true);
    });

    it("opens the agents panel through openDockTab and mounts exactly one copy (PLAN-0626 M3)", async () => {
        // M3 entry point: the toolbar's "Agent management" reaches the dock through the
        // same `openDockTab` hop M2 uses for `context`. One mount is the whole point of the
        // normalisation — two would put two elements behind every panel testid.
        const wrapper = mountWorkbench();
        await flushPromises();

        (wrapper.vm as unknown as { openDockTab: (id: string) => void }).openDockTab("agents");
        await flushPromises();

        expect(wrapper.get('[data-testid="dock-tab-agents"]').attributes("aria-selected")).toBe(
            "true",
        );
        expect(wrapper.findAll('[data-testid="agents-panel-stub"]')).toHaveLength(1);
        expect(wrapper.find('[data-testid="dock-sticky-panel-agents"]').exists()).toBe(true);
    });

    it("keeps width and collapsed state independent (collapse then re-open restores the width)", async () => {
        seedDesktopDock();
        const wrapper = mountWorkbench();
        await flushPromises();

        await wrapper.get('[data-testid="workspace-toolbar-code"]').trigger("click");
        await wrapper.get('[data-testid="dock-resizer"]').trigger("keydown", { key: "End" });
        await expectStored(() => expect(storedLayout().dockWidth).toBe(480));
        expect(wrapper.get('[data-testid="workspace-aux-panel"]').attributes("style")).toContain(
            "width: 480px",
        );

        await wrapper.get('[data-testid="workspace-aux-close"]').trigger("click");
        expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(false);
        // Collapsing must not rewrite the stored width.
        await expectStored(() => expect(storedLayout().dockWidth).toBe(480));

        await wrapper.get('[data-testid="workspace-toolbar-code"]').trigger("click");
        expect(wrapper.get('[data-testid="workspace-aux-panel"]').attributes("style")).toContain(
            "width: 480px",
        );
    });

    it("persists the file tree collapse state per workspace", async () => {
        seedWideLayout();
        const wrapper = mountWorkbench();
        await flushPromises();

        await wrapper.get('[data-testid="workspace-toolbar-toggle-tree"]').trigger("click");
        expect(wrapper.find('[data-testid="workspace-file-tree"]').exists()).toBe(false);
        await expectStored(() => expect(storedLayout().treeCollapsed).toBe(true));

        await wrapper.get('[data-testid="workspace-tree-expand"]').trigger("click");
        expect(wrapper.find('[data-testid="workspace-file-tree"]').exists()).toBe(true);
        await expectStored(() => expect(storedLayout().treeCollapsed).toBe(false));
    });

    it("swaps to a fresh layout when the workspace changes", async () => {
        const wrapper = mountWorkbench();
        await flushPromises();
        await wrapper.get('[data-testid="workspace-toolbar-code"]').trigger("click");
        expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(true);

        await wrapper.setProps({ workspaceId: "workspace-2" });

        // D-1777/D-1778：不同工作区回到默认布局。jsdom 1024 ⇒ <1800 右栏不占位，
        // files 页签不在默认 set 里 ⇒ 树不渲染（C2 已知缺口，task-94 承接）。
        expect(wrapper.find('[data-testid="workspace-file-tree"]').exists()).toBe(false);

        // Going back restores the first workspace's own set.
        await wrapper.setProps({ workspaceId: "workspace-1" });
        expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(true);
    });

    it("keeps the mobile body editor-first without rendering the tree or the dock", async () => {
        const wrapper = mountWorkbench({ isMobile: true });
        await flushPromises();

        expect(wrapper.find('[data-testid="file-editor-stub"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="workspace-file-tree"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="workspace-toolbar-files-mobile"]').exists()).toBe(true);
    });

    it("never persists layout from the mobile sheet", async () => {
        const wrapper = mountWorkbench({ isMobile: true });
        await flushPromises();

        // Mobile has no tree panel and no dock: nothing may be persisted.
        await wrapper.get('[data-testid="workspace-toolbar-files-mobile"]').trigger("click");

        expect(localStorage.getItem("xihe-layout-ws:workspace-1")).toBeNull();
    });
});
describe("WorkspaceWorkbench workspace switch (PLAN-0582 S3a audit P0)", () => {
    it("clears the open file buffer on a mobile workspace switch too", async () => {
        const wrapper = mountWorkbench({ isMobile: true });
        await flushPromises();
        const ws = useWorkspaceStore();
        ws.openFiles.set("notes.md", {
            path: "notes.md",
            content: "workspace A content",
            originalContent: "workspace A content",
            modified: true,
            language: "markdown",
        });
        ws.activeFilePath = "notes.md";
        expect(ws.openFiles.size).toBe(1);

        // Mobile must run the same reset: the sheet renders the tree and the editor,
        // so a stale buffer would be saved into the *new* workspace.
        await wrapper.setProps({ workspaceId: "workspace-2" });
        await flushPromises();

        expect(ws.openFiles.size).toBe(0);
        expect(ws.activeFilePath).toBeNull();
    });
});
/**
 * task-94 S2/S4 取代 PLAN-0582 S3b §4 的「让尽就转浮窗」。
 *
 * <p>旧用例钉的是「pinned 被挤压成 floating 并给一次 toast」—— 那条**前提被 `D-1754 ④` 判据 3 否了**：
 * 右栏不许叠在主列上。现在让尽后的出口是**单栏切换**（`D-1545` 既有机制），一次性 toast 一并退场。</p>
 */
describe("WorkspaceWorkbench 单栏切换（task-94 S2/S4，取代 S3b §4 forcibly-floating）", () => {
    it("装不下两栏时切单栏：右栏成为当前栏、主列 v-show 隐藏（不卸载），且不给 toast", async () => {
        // 本文件挂载时没有布局 provider ⇒ 行宽按 innerWidth 兜底：900 − 360 = 540 < 640 ⇒ 单栏。
        setViewport(900);
        // 单栏形态下「看得见哪一栏」由 activeColumn 决定 ⇒ 种子必须写明用户正看着右栏。
        seedWideLayout({
            dockTabs: ["files"],
            activeDockTab: "files",
            dockCollapsed: false,
            activeColumn: "right",
        });
        const wrapper = mountWorkbench();
        await flushPromises();

        // 单栏形态的可见入口：切换器渲染（D-1545）。
        expect(wrapper.find('[data-testid="workspace-container-switcher"]').exists()).toBe(true);
        // 右栏此刻是当前栏 ⇒ 树可见，且**恰好一个**（D-1777/D-1778 的树面板只有一份）。
        expect(wrapper.findAll('[data-testid="workspace-file-tree"]')).toHaveLength(1);
        // 主列**仍挂载**、只是 v-show 隐藏：卸载会丢 ChatPanel 的 SSE 订阅（D26-04 同一条理由）。
        expect(wrapper.get("[data-main-hidden]").isVisible()).toBe(false);

        await wrapper.get('[data-testid="workspace-toolbar-code"]').trigger("click");
        await flushPromises();

        // 点右栏页签不能把用户留在中栏：右栏自动成为当前栏。
        expect(
            wrapper.get('[data-testid="workspace-aux-panel"]').attributes("data-dock-mode"),
        ).toBe("pinned");
        // 形态由几何算出，不落盘（D-1552/D-1222 ⑥：不新增第二个持久键）。
        await expectStored(() => expect(storedLayout().dockTabs).toEqual(["files", "code"]));
        expect(storedLayout()).not.toHaveProperty("singleColumn");
        // 不是「被挤压成浮窗」：那条一次性提示随机制退场。
        expect(toastWarning).not.toHaveBeenCalled();
    });

    /**
     * **实测修正 Lead 的推断**（`D-1789`：以实测为准）：两条绕过路径确实存在
     * （`toggleDockTab` / `closeDockTab` 不走 `collapseDock`），但在当前树里**推不出白屏**——
     * `forceSingleColumn` 的判据带 `dockOpen`（`dockTakesSpace`），dock 一收 `containerMode`
     * 立刻回 `desktop`，两栏都渲染、中栏自然可见；而 `isMobile` 那条路（`containerMode` 恒 single）
     * 的移动壳渲染的是 `FileEditor`，根本不挂这套 dock。
     *
     * <p><b>但"没白屏"是巧合不是判据</b>：它依赖"单栏条件恰好随 dock 关闭而消失"。所以不变量照样
     * 挪到派生（`effectiveActiveColumn`），并在这里钉两条**今天能测**的判据：
     * ① 收起后不白屏且右栏确实不渲染；② <b>用户的栏偏好不被抹掉</b>（`activeColumn` 仍是 right，
     * 上一版 `collapseDock` 会把它写成 main ⇒ 这两条就是那个回归的哨兵）。</p>
     */
    it("收起右栏后不白屏，且用户的栏偏好不被抹掉（Lead 20:10 评审）", async () => {
        setViewport(900);
        seedWideLayout({
            dockTabs: ["files"],
            activeDockTab: "files",
            dockCollapsed: false,
            activeColumn: "right",
        });
        const wrapper = mountWorkbench();
        await flushPromises();

        expect(wrapper.findAll('[data-testid="workspace-file-tree"]')).toHaveLength(1);

        // (a) 工具栏 files 再按一次 = 收起（走 toggleDockTab，**不**走 collapseDock —— Lead 点的第一处）。
        await wrapper.get('[data-testid="workspace-toolbar-files"]').trigger("click");
        await flushPromises();

        expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(false);
        // 正文非空：中栏本体在 DOM 里且可见（若哪天单栏条件不再随 dock 关闭而消失，这里就是白屏线）。
        expect(wrapper.get("[data-main-hidden]").isVisible()).toBe(true);
        expect(wrapper.get("[data-main-hidden]").attributes("data-main-column-visible")).toBe(
            "true",
        );
        // 偏好留着：上一版在 collapseDock 里写 activeColumn='main'，这条会红。
        await expectStored(() => expect(storedLayout().activeColumn).toBe("right"));

        // (c) 再开回来 ⇒ 回到右栏（偏好回来了，不是 main）。
        await wrapper.get('[data-testid="workspace-toolbar-files"]').trigger("click");
        await flushPromises();
        expect(wrapper.findAll('[data-testid="workspace-file-tree"]')).toHaveLength(1);
    });

    it("关掉最后一个页签也不白屏、也不改写偏好（Lead 点的第二处绕过）", async () => {
        setViewport(900);
        seedWideLayout({
            dockTabs: ["files"],
            activeDockTab: "files",
            dockCollapsed: false,
            activeColumn: "right",
        });
        const wrapper = mountWorkbench();
        await flushPromises();

        // (b) 关掉最后一个页签：dockOpen 变 false 的**另一条**路径（closeDockTab）。
        await wrapper.get('[data-testid="dock-tab-close-files"]').trigger("click");
        await flushPromises();

        expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(false);
        expect(wrapper.get("[data-main-hidden]").isVisible()).toBe(true);
        await expectStored(() => expect(storedLayout().activeColumn).toBe("right"));

        // 重开 files ⇒ 又回到右栏。
        await wrapper.get('[data-testid="workspace-toolbar-files"]').trigger("click");
        await flushPromises();
        expect(wrapper.findAll('[data-testid="workspace-file-tree"]')).toHaveLength(1);
    });

    it("D5（形态不变式）：同一视口连开三次读数完全一致，且文件树面板恒 1 个", async () => {
        // Lead 2026-11-17：同视口 × 3 次开场 ⇒ 形态必须一致（否则「首启看着对、重进就变」）。
        setViewport(900);
        seedWideLayout({
            dockTabs: ["files"],
            activeDockTab: "files",
            dockCollapsed: false,
            activeColumn: "right",
        });

        const readShape = async () => {
            const wrapper = mountWorkbench();
            await flushPromises();
            const shape = {
                dockModes: wrapper
                    .findAll('[data-testid="workspace-aux-panel"]')
                    .map((panel) => panel.attributes("data-dock-mode")),
                dockWidth: wrapper.get('[data-testid="workspace-aux-panel"]').attributes("style"),
                mainVisible: wrapper.get("[data-main-hidden]").isVisible(),
                treePanels: wrapper.findAll('[data-testid="workspace-file-tree"]').length,
                railPanels: wrapper.findAll('[data-testid="workspace-file-rail"]').length,
            };
            wrapper.unmount();
            return shape;
        };

        const first = await readShape();
        expect(await readShape()).toEqual(first);
        expect(await readShape()).toEqual(first);
        // 「恒 1 个」：两条渲染路径（dockview 壳 / 手写 #files）合计也只能有一个树面板。
        expect(first.treePanels).toBe(1);
        expect(first.railPanels).toBe(0);
        expect(first.dockModes).toEqual(["pinned"]);
    });
});

describe("WorkspaceWorkbench dock Escape（task-94 S1 之后的语义）", () => {
    function escapeFrom(target: EventTarget = window): void {
        target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }

    it("does not roll up a pinned dock on Escape", async () => {
        // 浮窗退场后「Esc 关浮窗」这条规则一起退场：pinned 右栏是用户的持久选择，Esc 不该关它。
        seedDesktopDock({ dockTabs: ["monitor"], activeDockTab: "monitor", dockCollapsed: false });
        const wrapper = mountWorkbench();
        await flushPromises();
        expect(
            wrapper.get('[data-testid="workspace-aux-panel"]').attributes("data-dock-mode"),
        ).toBe("pinned");

        escapeFrom();
        await flushPromises();

        expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(true);
        await expectStored(() => expect(storedLayout().dockCollapsed).toBe(false));
    });

    it("ignores Escape typed inside a field", async () => {
        const wrapper = mountWorkbench();
        await flushPromises();
        await wrapper.get('[data-testid="workspace-toolbar-code"]').trigger("click");

        const field = document.createElement("input");
        document.body.appendChild(field);
        try {
            escapeFrom(field);
            await flushPromises();
            expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(true);
        } finally {
            field.remove();
            wrapper.unmount();
        }
    });

    it("leaves the dock open while a dialog owns Escape", async () => {
        const wrapper = mountWorkbench();
        await flushPromises();
        await wrapper.get('[data-testid="workspace-toolbar-code"]').trigger("click");

        const backdrop = document.createElement("div");
        backdrop.setAttribute("data-testid", "modal-backdrop");
        document.body.appendChild(backdrop);
        try {
            escapeFrom();
            await flushPromises();
            expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(true);
        } finally {
            backdrop.remove();
            wrapper.unmount();
        }
    });
});
describe("WorkspaceWorkbench dock policy (PLAN-0582 S3b P1-1 audit)", () => {
    it("keeps a dock the user explicitly re-opened open on the next mount", async () => {
        const first = mountWorkbench();
        await flushPromises();
        // Open the dock, close it, then open it again (all explicit user actions).
        await first.get('[data-testid="workspace-toolbar-code"]').trigger("click");
        await first.get('[data-testid="workspace-aux-close"]').trigger("click");
        await first.get('[data-testid="workspace-toolbar-code"]').trigger("click");
        await expectStored(() => expect(storedLayout().dockCollapsed).toBe(false));
        first.unmount();

        // A fresh mount must honour the stored state instead of a dismissal latch.
        const second = mountWorkbench();
        await flushPromises();
        expect(second.find('[data-testid="workspace-aux-panel"]').exists()).toBe(true);
        second.unmount();
    });
});

// PLAN-0623 U1：参与者面板按**会话**挂载，与 monitor 同构；tab 默认不打开。
describe("WorkspaceWorkbench participants tab (PLAN-0623 U1)", () => {
    it("does not open the participants tab by itself", async () => {
        const wrapper = mountWorkbench();
        await flushPromises();

        expect(wrapper.find('[data-testid="dock-tab-members"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="session-participants-panel"]').exists()).toBe(false);
        // 持久化里也不会被写入（默认 dockTabs 为空。
        expect(storedLayout().dockTabs ?? []).not.toContain("members");
        wrapper.unmount();
    });

    it("renders the participants empty state when the tab is open without a session", async () => {
        localStorage.setItem(
            "xihe-layout-ws:workspace-1",
            JSON.stringify({
                dockCollapsed: false,
                dockTabs: ["members"],
                activeDockTab: "members",
            }),
        );

        const wrapper = mountWorkbench({ sessionId: null });
        await flushPromises();

        expect(wrapper.find('[data-testid="dock-tab-members"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="session-participants-panel"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="participants-empty"]').exists()).toBe(true);
        wrapper.unmount();
    });
});

// BL-379：pagehide/visibilitychange 必须随实例成对移除。旧实现注册匿名闭包且永不移除 ⇒
// 每次挂载净增一对死监听器，把整棵已卸载组件（layout ref、writer、store 引用链）扣在
// window/document 上不可 GC。3 轮挂载-卸载后净存活必须为 0 —— 若实现丢了 remove 路径，
// 净存活 = 3，本用例红。spy 必须在 mount 前安装、finally 里 mockRestore，避免污染其他用例。
describe("WorkspaceWorkbench pagehide/visibilitychange listener pairing (BL-379)", () => {
    it("registers and removes pagehide/visibilitychange listeners pairwise across 3 mount cycles", () => {
        const addWindowListener = vi.spyOn(window, "addEventListener");
        const removeWindowListener = vi.spyOn(window, "removeEventListener");
        const addDocumentListener = vi.spyOn(document, "addEventListener");
        const removeDocumentListener = vi.spyOn(document, "removeEventListener");
        try {
            for (let round = 0; round < 3; round += 1) {
                const wrapper = mountWorkbench();
                wrapper.unmount();
            }

            const pagehideAdds = addWindowListener.mock.calls.filter(
                ([type]) => type === "pagehide",
            );
            const pagehideRemoves = removeWindowListener.mock.calls.filter(
                ([type]) => type === "pagehide",
            );
            const visibilityAdds = addDocumentListener.mock.calls.filter(
                ([type]) => type === "visibilitychange",
            );
            const visibilityRemoves = removeDocumentListener.mock.calls.filter(
                ([type]) => type === "visibilitychange",
            );
            expect(pagehideAdds).toHaveLength(3);
            expect(pagehideRemoves).toHaveLength(3);
            expect(visibilityAdds).toHaveLength(3);
            expect(visibilityRemoves).toHaveLength(3);
            // 净存活 0：没有 remove 路径时这里 = 3，抓的就是泄漏本体。
            expect(pagehideAdds.length - pagehideRemoves.length).toBe(0);
            expect(visibilityAdds.length - visibilityRemoves.length).toBe(0);
        } finally {
            addWindowListener.mockRestore();
            removeWindowListener.mockRestore();
            addDocumentListener.mockRestore();
            removeDocumentListener.mockRestore();
        }
    });
});

/**
 * D-1777/D-1778（task-65 A 段）：**树列的 splitter 机械已退场**。
 *
 * 用户 2026-11-17：「两栏各自是一个容器」「中栏容器有的组件右栏容器也都有」⇒ 树改为右栏容器的
 * `files` 面板，宽度 = 右栏 dock 宽；`tree-resizer` / `treeBridge` / `%` 换算 / 键盘步进一并删除
 *（PLAN-0753 T3 那套机械）。原用例锁的正是那套机械，这里改锁**它的不存在**与新的归属形态。
 */
describe("WorkspaceWorkbench 树列 splitter 退场（D-1777/D-1778）", () => {
    it("工作台行不再是 splitter group，树列把手与宽度气泡都不渲染", async () => {
        const wrapper = mountWorkbench();
        await flushPromises();
        expect(wrapper.find("[data-panel-group]").exists()).toBe(false);
        expect(wrapper.find('[data-testid="tree-resizer"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="tree-resize-bubble"]').exists()).toBe(false);
    });

    /**
     * **task-144 ③ 翻转本判据**（Lead 2026-11-17 批）。原判据是「折叠 = **右栏收成**
     * TREE_COLLAPSED_WIDTH 的 rail」，并显式断言 `workspace-aux-panel` 不渲染 —— 它钉住的
     * 正是「折叠树 ⇒ 整个右栏消失」这个回归：真浏览器实测（1920×1080，dockTabs=[files,monitor,code]）
     * 折叠后右栏行、`workspace-aux-panel`、`dock-active-panel` 全为 false，`dock-tab-code|monitor`
     * 命中 0 ⇒ monitor/code/changes 一并不可达。
     *
     * <p>现行语义：**折叠 = files 这个面板体收成 rail**，右栏与其余页签照常渲染；折叠**不回收列宽**，
     * 这是裁定接受的取舍（腾空间走单栏切换 task-94 S4，两件事不混）。</p>
     */
    it("折叠 = files 面板体收成 rail；右栏与其余页签照常渲染（task-144 ③）", async () => {
        seedWideLayout({
            treeCollapsed: true,
            treeWidth: 280,
            dockTabs: ["files", "monitor", "code"],
            activeDockTab: "files",
        });
        const wrapper = mountWorkbench();
        await flushPromises();

        // ① 折叠 ≠ 关闭：rail 仍在面板体里，宽度与展开键可断言。
        const rail = wrapper.get('[data-testid="workspace-file-rail"]');
        expect(rail.attributes("style")).toContain(`width: ${TREE_COLLAPSED_WIDTH}px`);
        expect(rail.find('[data-testid="workspace-tree-expand"]').exists()).toBe(true);

        // ② 折叠**不再**移走整栏：右栏行、dock 本体、其余页签全在（这就是 ③ 的判据本体）。
        expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(true);
        expect(
            wrapper
                .get('[data-testid="workspace-container-tabs"][data-container="right"]')
                .exists(),
        ).toBe(true);
        expect(wrapper.find('[data-testid="dock-tab-monitor"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="dock-tab-code"]').exists()).toBe(true);

        // ③ 折叠的是树本体：它不渲染，且折叠不改存储宽度（PLAN-0582 §1.5-A）。
        expect(wrapper.find('[data-testid="workspace-file-tree"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="file-tree-stub"]').exists()).toBe(false);
        expect(storedLayout().dockTabs).toEqual(["files", "monitor", "code"]);
        expect(storedLayout().treeWidth).toBe(280);
        // 反向控制：换一个不存在的 testid 必须查不到（防「拿不到就判过」）。
        expect(wrapper.find('[data-testid="workspace-file-tree-absent"]').exists()).toBe(false);

        // ④ 折叠态仍能切到别的页签 —— 旧实现拿不到这条读数（整栏当时已经不在）。
        await wrapper.get('[data-testid="dock-tab-monitor"]').trigger("click");
        expect(wrapper.find('[data-testid="session-monitor-stub"]').exists()).toBe(true);
    });
});

/**
 * task-65 A 段（D-1777/D-1778，Lead 裁定 C1）：反转 task-353 判据① 的归属。
 *
 * 原判据：文件树必须在中栏容器（`workspace-center`）内。现在反过来 —— 树是**右栏容器**的
 * `files` 面板 ⇒ 祖先必须是 `workspace-aux-panel`，而 `workspace-center` 必须**查不到**。
 * 负控照旧：同一个节点换一个不存在的 testid 必须为 null（防「找不到就判过」）。
 */
describe("WorkspaceWorkbench 文件树归属右栏容器（D-1777/D-1778 反转 task-353）", () => {
    it("文件树在右栏容器内，且不再在中栏容器内", async () => {
        seedWideLayout();
        const wrapper = mountWorkbench();
        await flushPromises();

        const treeStub = wrapper.get('[data-testid="file-tree-stub"]').element;
        const aux = treeStub.closest('[data-testid="workspace-aux-panel"]');
        expect(aux, "文件树的 DOM 祖先里必须有右栏容器（D-1777）").not.toBeNull();
        expect(
            treeStub.closest('[data-testid="workspace-center"]'),
            "反转 task-353：树不再在中栏容器内（D-1777）",
        ).toBeNull();

        // 负控（恒绿防线）：同一个节点查一个不存在的 testid 必须为 null。
        expect(treeStub.closest('[data-testid="workspace-center-absent"]')).toBeNull();

        // 右栏容器行 = 容器级页签行（Q2：复用 dock tab 数据，不新造 IA）。
        expect(
            wrapper
                .get('[data-testid="workspace-container-tabs"][data-container="right"]')
                .exists(),
        ).toBe(true);

        // 中栏容器仍只容纳主区（树搬走后语义更干净）。
        const main = wrapper.get('[data-testid="workspace-main"]').element;
        expect(main.closest('[data-testid="workspace-center"]')).not.toBeNull();
    });
});

// ── task-44（D-1440 / A 方案）：深链 `/workspace/{id}?agent=<pid>` 的**入口端** ──────────
// `/workspace/{id}/agents` 这个路由不存在（卡面已改），智能体面板的真实宿主是 dock 的
// `agents` 页签；页签状态归 `useWorkspaceLayout`，没有任何 URL 面能表达它 ⇒ 深链要落地，
// 只能在这里把"URL 说哪个主体"接到"布局开哪个页签"。这两条就是那个接线的正反面。
describe("WorkspaceWorkbench task-44 deep link (?agent=)", () => {
    const PRINCIPAL_ID = "12121212-1212-4212-8212-121212121212";

    it("opens the agents dock tab and forwards the principal to the panel", async () => {
        routeQuery.value = { agent: PRINCIPAL_ID };
        const wrapper = mountWorkbench();
        await flushPromises();

        const panel = wrapper.find('[data-testid="agents-panel-stub"]');
        expect(panel.exists()).toBe(true);
        expect(panel.attributes("data-expand-principal")).toBe(PRINCIPAL_ID);
        await expectStored(() => {
            expect(storedLayout().dockTabs).toContain("agents");
            expect(storedLayout().activeDockTab).toBe("agents");
        });
    });

    it("without the query nothing is opened (a deep link must not become the default layout)", async () => {
        const wrapper = mountWorkbench();
        await flushPromises();

        expect(wrapper.find('[data-testid="agents-panel-stub"]').exists()).toBe(false);
    });

    it("the deep-link decision is a pure predicate: mobile never opens the dock", () => {
        // 「手机不动布局」原本只是 workbench 里的一句 early return —— 手机没有 dock、布局也从不
        // 持久化 ⇒ 在集成用例里**看不见也不会红**（D-1046：不会红的判据等于没有判据）。
        // 抽成纯函数后才有一条能咬住的用例：把返回值改成 true，这条立刻红。
        expect(shouldOpenAgentsDockFromDeepLink(PRINCIPAL_ID, false)).toBe(true);
        expect(shouldOpenAgentsDockFromDeepLink(PRINCIPAL_ID, true)).toBe(false);
        expect(shouldOpenAgentsDockFromDeepLink(null, false)).toBe(false);
    });

    it("mounting on a mobile viewport with ?agent= does not crash and renders no dock panel", async () => {
        routeQuery.value = { agent: PRINCIPAL_ID };
        mountWorkbench({ isMobile: true });
        await flushPromises();

        // 手机没有 dock（那里由管理弹窗承载）⇒ 不渲染任何 dock 面板内容。
        expect(document.querySelector('[data-testid="agents-panel-stub"]')).toBeNull();
    });
});
