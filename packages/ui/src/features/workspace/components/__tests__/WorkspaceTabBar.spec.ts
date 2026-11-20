import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import type { Router } from "vue-router";
import WorkspaceTabBar from "../WorkspaceTabBar.vue";
import { useSessionStore } from "../../../../stores/session";
import {
    hasWorkspaceLayout,
    readWorkspaceLayout,
} from "../../../../composables/useWorkspaceLayout";

const { pushSpy, routeState } = vi.hoisted(() => ({
    pushSpy: vi.fn<Router["push"]>(),
    routeState: {
        name: "workspace-session",
        path: "/workspace/workspace-1/session/session-1",
        fullPath: "/workspace/workspace-1/session/session-1",
        params: { workspaceId: "workspace-1", sessionId: "session-1" },
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
    useRoute: () => routeState,
    useRouter: () => ({ push: pushSpy, replace: vi.fn<() => void>() }),
}));

const i18n = createI18n({
    legacy: false,
    locale: "en",
    messages: {
        en: {
            workspace: {
                tabBarLabel: "Workbench tabs",
                tabChatFallback: "Chat",
                tabClose: "Close tab",
            },
        },
    },
});

function mountBar() {
    return mount(WorkspaceTabBar, {
        props: { workspaceId: "workspace-1", sessionId: "session-1" },
        global: { plugins: [i18n] },
    });
}

function gotoSession(sessionId: string): void {
    routeState.name = "workspace-session";
    routeState.path = `/workspace/workspace-1/session/${sessionId}`;
    routeState.fullPath = `/workspace/workspace-1/session/${sessionId}`;
    routeState.params = { workspaceId: "workspace-1", sessionId };
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    pushSpy.mockClear();
    gotoSession("session-1");
});

describe("WorkspaceTabBar (C3: session indicator, PLAN-0582 S3a semantics)", () => {
    it("shows only the pinned session tab on a chat route (task-365 D)", async () => {
        const wrapper = mountBar();
        await flushPromises();

        // The visited session is pinned and active; the fixed chat tab is gone
        // (task-365 D / D-1220 ①) — its absence is the assertion, not a count-0
        // on some testid that never existed.
        expect(
            wrapper
                .get('[data-testid="workspace-tab-session-session-1"]')
                .attributes("aria-selected"),
        ).toBe("true");
        expect(wrapper.find('[data-testid="workspace-tab-chat"]').exists()).toBe(false);
        expect(wrapper.findAll("[data-tab-id]")).toHaveLength(1);
        // C3: workspace pages never render as tabs (page entries live only in the
        // secondary nav).
        expect(wrapper.find('[data-testid="workspace-toolbar-settings"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="workspace-toolbar-environment"]').exists()).toBe(false);
    });

    it("adds a tab for a deep-linked session and marks it active", async () => {
        gotoSession("session-2");
        const wrapper = mountBar();
        await flushPromises();

        const tab = wrapper.get('[data-testid="workspace-tab-session-session-2"]');
        expect(tab.attributes("aria-selected")).toBe("true");
        // The open set is persisted per workspace.
        expect(readWorkspaceLayout("workspace-1").openTabs).toContain("session:session-2");
    });

    it("navigates with router.push only (no navigation interception)", async () => {
        // task-365 D：固定页签删除后，「点当前页签」是 no-op（selectTab 提前返回），
        // 所以用**另一个钉住的会话**做点击对象 —— 判据仍是「恰好一次 push、不拦截」。
        localStorage.setItem(
            "xihe-layout-ws:workspace-1",
            JSON.stringify({ openTabs: ["session:other"] }),
        );
        const wrapper = mountBar();
        await flushPromises();

        await wrapper.get('[data-testid="workspace-tab-session-other"]').trigger("click");

        expect(pushSpy).toHaveBeenCalledWith("/workspace/workspace-1/session/other");
        // Exactly one push: the tab bar never intercepts or re-dispatches navigation.
        expect(pushSpy).toHaveBeenCalledTimes(1);
    });

    it("returns to the current session route when the active tab is closed", async () => {
        gotoSession("session-2");
        const wrapper = mountBar();
        await flushPromises();

        await wrapper.get('[data-testid="workspace-tab-close-session:session-2"]').trigger("click");

        expect(pushSpy).toHaveBeenCalledWith("/workspace/workspace-1/session/session-1");
        expect(readWorkspaceLayout("workspace-1").openTabs).not.toContain("session:session-2");
    });

    /**
     * task-89（WCAG 2.2 SC 2.5.8 ≥24×24）：顶栏页签关闭键改前 `p-0.5` + `size-3` ⇒
     * **14×14**（3.5px 栅格：1.75×2 + 10.5；4px 栅格同一组类是 2×2 + 12 = 16，两值都 <24），
     * 与同 chip 的 `workspace-tab-` 本体矩形距 **7**（4px 栅格是 8）⇒ 真缺陷（24 圆心圆与
     * 本体矩形相交，Spacing 例外不成立）。`min-h-7 min-w-7` = 7 × **4px** = **28px**
     * （3.5px 时代是 24.5px）；`X` 仍 `size-3`（今天 12px）不放大 ⇒ 视觉档位不动。
     * jsdom 不求值 Tailwind ⇒ 钉类名。
     */
    it("task-89：关闭键命中盒 ≥24×24（min-h-7 min-w-7），图标尺寸不变", async () => {
        gotoSession("session-2");
        const wrapper = mountBar();
        await flushPromises();

        const closer = wrapper.get('[data-testid="workspace-tab-close-session:session-2"]');
        expect(closer.classes()).toEqual(
            expect.arrayContaining(["min-h-7", "min-w-7", "items-center", "justify-center"]),
        );
        expect(closer.get("svg").classes()).toContain("size-3");
    });

    it("keeps the session title on the pinned tab (task-365 D)", async () => {
        useSessionStore().sessions = [
            {
                id: "session-1",
                title: "Session title",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                workspaceId: "workspace-1",
                context: { agents: [] },
            } as never,
        ];
        useSessionStore().currentSessionId = "session-1";
        const wrapper = mountBar();
        await flushPromises();

        expect(wrapper.get('[data-testid="workspace-tab-session-session-1"]').text()).toContain(
            "Session title",
        );
    });

    /**
     * task-52 / batch-02（P1-3，D-1703）：**同名不同物**必须能看出来。
     *
     * <p>现象：侧栏会话行与顶栏页签都渲染同一个 `title`，两者外观要素（圆角、字号相邻、
     * 无图标差异）不足以让人分清「这行是会话项」还是「这是页签」。修法是给页签加**窗口图标**
     * （身份差异，与侧栏的对话气泡图标区分），本用例钉的就是这个差异存在。</p>
     *
     * <p>承重点（变异）：把 `WorkspaceTabBar` 里那个 `AppWindow` 图标删掉 / 换成与侧栏同款
     * `MessageSquareText` ⇒ 本行红（找不到 `workspace-tab-identity`，或它与侧栏图标同名）。
     * 另钉一条**语义**承重：页签的角色是 `tab`（与侧栏会话行的 button/link 不同），
     * 所以「视觉差异」不是唯一区分手段 —— 读屏用户靠角色区分，两者都要在。</p>
     */
    it("keeps the tab visually distinct from the sidebar session row (same title, different object)", async () => {
        useSessionStore().sessions = [
            {
                id: "session-1",
                title: "Session title",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                workspaceId: "workspace-1",
                context: { agents: [] },
            } as never,
        ];
        useSessionStore().currentSessionId = "session-1";
        const wrapper = mountBar();
        await flushPromises();

        const trigger = wrapper.get('[data-testid="workspace-tab-session-session-1"]');
        // ① 身份图标在页签里（不在侧栏会话行里）。
        expect(trigger.find('[data-testid="workspace-tab-identity"]').exists()).toBe(true);
        // ② 页签的可访问角色是 tab —— 与侧栏会话行（可激活的列表项）不是同一个角色。
        expect(trigger.attributes("role")).toBe("tab");
    });
});

describe("WorkspaceTabBar storage hygiene (PLAN-0582 S3a audit P1-1)", () => {
    it("pins a visited session without fabricating stored geometry", async () => {
        const wrapper = mountBar();
        await flushPromises();

        // Visiting a chat session persists the openTabs slice (the pin), but an
        // openTabs-only payload is NOT stored geometry: the workbench's first-run
        // policy (≥1800 opens the monitor) must not be disabled by a tab visit.
        expect(readWorkspaceLayout("workspace-1").openTabs).toContain("session:session-1");
        expect(hasWorkspaceLayout("workspace-1")).toBe(false);
        wrapper.unmount();
    });

    it("writes the emptied set when the last pinned tab is closed", async () => {
        gotoSession("session-2");
        const wrapper = mountBar();
        await flushPromises();
        expect(readWorkspaceLayout("workspace-1").openTabs).toContain("session:session-2");

        await wrapper.get('[data-testid="workspace-tab-close-session:session-2"]').trigger("click");
        await flushPromises();

        const stored = JSON.parse(localStorage.getItem("xihe-layout-ws:workspace-1") ?? "{}") as {
            openTabs?: string[];
        };
        expect(stored.openTabs).not.toContain("session:session-2");
        wrapper.unmount();
    });
});

describe("WorkspaceTabBar tab semantics (BL-476 L1 reka Tabs pilot)", () => {
    it("renders the vendored Tabs list with roving focus instead of a hand-rolled tablist", async () => {
        const wrapper = mountBar();
        await flushPromises();

        // The `role="tablist"` markup is gone from the component: reka renders it
        // (and owns aria-selected / the roving tabindex) while the bar keeps
        // owning navigation and layout persistence.
        const list = wrapper.get('[role="tablist"]');
        expect(list.attributes("data-orientation")).toBe("horizontal");
        // reka's tab stop sits on the list itself; Tab lands there and focus is
        // forwarded to the selected tab, so the triggers themselves stay at -1.
        expect(list.attributes("tabindex")).toBe("0");

        // task-365 D：固定页签删除 ⇒ roving-focus 判据落在钉住的页签上。
        const pinned = wrapper.get('[data-testid="workspace-tab-session-session-1"]');
        expect(pinned.attributes("role")).toBe("tab");
        expect(
            wrapper.get('[data-testid="workspace-tab-session-session-1"]').attributes("tabindex"),
        ).toBe("-1");

        wrapper.unmount();
    });
});

describe("WorkspaceTabBar tab ordering (PLAN-0753 T5)", () => {
    const OPEN_KEY = "xihe-layout-ws:workspace-1";

    it("renders the open set in the persisted order", async () => {
        localStorage.setItem(
            OPEN_KEY,
            JSON.stringify({ openTabs: ["session:s3", "session:s1", "session:s2"] }),
        );
        const wrapper = mountBar();
        await flushPromises();

        // The visited session is pinned after the stored set.
        const ids = wrapper.findAll("[data-tab-id]").map((node) => node.attributes("data-tab-id"));
        expect(ids).toEqual(["session:s3", "session:s1", "session:s2", "session:session-1"]);
        wrapper.unmount();
    });

    it("moves a tab with ArrowLeft and persists the new order (keyboard path)", async () => {
        localStorage.setItem(OPEN_KEY, JSON.stringify({ openTabs: ["session:a", "session:b"] }));
        const wrapper = mountBar();
        await flushPromises();

        const pinned = wrapper.get('[data-testid="workspace-tab-session-session-1"]');
        await pinned.trigger("keydown", { key: "ArrowLeft" });
        await flushPromises();

        expect(readWorkspaceLayout("workspace-1").openTabs).toEqual([
            "session:a",
            "session:session-1",
            "session:b",
        ]);
        const ids = wrapper.findAll("[data-tab-id]").map((node) => node.attributes("data-tab-id"));
        expect(ids).toEqual(["session:a", "session:session-1", "session:b"]);
        wrapper.unmount();
    });

    it("clamps ArrowLeft on the first pinned tab (task-365 D)", async () => {
        // 原判据是「固定页签不动」；固定页签删除后，同一不变量落在**首位钉住页签**上：
        // 左移到头即钳制，顺序不变（不是把这条覆盖删掉）。
        localStorage.setItem(OPEN_KEY, JSON.stringify({ openTabs: ["session:a", "session:b"] }));
        const wrapper = mountBar();
        await flushPromises();

        await wrapper.get('[data-testid="workspace-tab-session-a"]').trigger("keydown", {
            key: "ArrowLeft",
        });
        await flushPromises();

        expect(readWorkspaceLayout("workspace-1").openTabs).toEqual([
            "session:a",
            "session:b",
            "session:session-1",
        ]);
        wrapper.unmount();
    });

    it("moves a tab with ArrowRight and clamps at the end", async () => {
        localStorage.setItem(OPEN_KEY, JSON.stringify({ openTabs: ["session:a", "session:b"] }));
        const wrapper = mountBar();
        await flushPromises();

        const first = wrapper.get('[data-testid="workspace-tab-session-a"]');
        await first.trigger("keydown", { key: "ArrowRight" });
        await flushPromises();
        await first.trigger("keydown", { key: "ArrowRight" });
        await flushPromises();
        // Second move hits the clamp: "a" stays at the end.
        await first.trigger("keydown", { key: "ArrowRight" });
        await flushPromises();

        expect(readWorkspaceLayout("workspace-1").openTabs).toEqual([
            "session:b",
            "session:session-1",
            "session:a",
        ]);
        wrapper.unmount();
    });

    it("syncs the store from a drag reorder (onDragUpdate)", async () => {
        localStorage.setItem(OPEN_KEY, JSON.stringify({ openTabs: ["session:a", "session:b"] }));
        const wrapper = mountBar();
        await flushPromises();

        // Simulate Sortable's update: the first tab row was dragged to the end.
        // task-365 D：列表里不再有固定页签 ⇒ 索引整体前移一位（0..2 而不是 1..3）。
        const draggable = wrapper.findComponent({ name: "VueDraggable" });
        draggable.vm.$emit("update", { oldIndex: 0, newIndex: 2 });
        await flushPromises();

        expect(readWorkspaceLayout("workspace-1").openTabs).toEqual([
            "session:b",
            "session:session-1",
            "session:a",
        ]);
        wrapper.unmount();
    });
});
