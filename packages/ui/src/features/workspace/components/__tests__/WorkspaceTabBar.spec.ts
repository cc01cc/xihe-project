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
        name: "workspace-chat",
        path: "/workspace/workspace-1/chat/session-1",
        fullPath: "/workspace/workspace-1/chat/session-1",
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
    routeState.name = "workspace-chat";
    routeState.path = `/workspace/workspace-1/chat/${sessionId}`;
    routeState.fullPath = `/workspace/workspace-1/chat/${sessionId}`;
    routeState.params = { workspaceId: "workspace-1", sessionId };
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    pushSpy.mockClear();
    gotoSession("session-1");
});

describe("WorkspaceTabBar (C3: session indicator, PLAN-0582 S3a semantics)", () => {
    it("shows the chat tab and the pinned session tab on a chat route", async () => {
        const wrapper = mountBar();
        await flushPromises();

        // The visited session is pinned and active; the chat tab is the fallback.
        expect(
            wrapper
                .get('[data-testid="workspace-tab-session-session-1"]')
                .attributes("aria-selected"),
        ).toBe("true");
        expect(wrapper.get('[data-testid="workspace-tab-chat"]').attributes("aria-selected")).toBe(
            "false",
        );
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
        const wrapper = mountBar();
        await flushPromises();

        await wrapper.get('[data-testid="workspace-tab-chat"]').trigger("click");

        expect(pushSpy).toHaveBeenCalledWith("/workspace/workspace-1/chat/session-1");
        // Exactly one push: the tab bar never intercepts or re-dispatches navigation.
        expect(pushSpy).toHaveBeenCalledTimes(1);
    });

    it("falls back to the chat tab when the active session tab is closed", async () => {
        gotoSession("session-2");
        const wrapper = mountBar();
        await flushPromises();

        await wrapper.get('[data-testid="workspace-tab-close-session:session-2"]').trigger("click");

        expect(pushSpy).toHaveBeenCalledWith("/workspace/workspace-1/chat/session-1");
        expect(readWorkspaceLayout("workspace-1").openTabs).not.toContain("session:session-2");
    });

    it("keeps the session title on the chat tab", async () => {
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

        expect(wrapper.get('[data-testid="workspace-tab-chat"]').text()).toContain("Session title");
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

        const chat = wrapper.get('[data-testid="workspace-tab-chat"]');
        expect(chat.attributes("role")).toBe("tab");
        expect(chat.attributes("tabindex")).toBe("-1");
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
        expect(ids).toEqual([
            "chat",
            "session:s3",
            "session:s1",
            "session:s2",
            "session:session-1",
        ]);
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
        expect(ids).toEqual(["chat", "session:a", "session:session-1", "session:b"]);
        wrapper.unmount();
    });

    it("keeps the chat tab first and ignores ArrowLeft on it", async () => {
        localStorage.setItem(OPEN_KEY, JSON.stringify({ openTabs: ["session:a", "session:b"] }));
        const wrapper = mountBar();
        await flushPromises();

        await wrapper.get('[data-testid="workspace-tab-chat"]').trigger("keydown", {
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

        // Simulate Sortable's update: the first open tab row was dragged to the end.
        const draggable = wrapper.findComponent({ name: "VueDraggable" });
        draggable.vm.$emit("update", { oldIndex: 1, newIndex: 3 });
        await flushPromises();

        expect(readWorkspaceLayout("workspace-1").openTabs).toEqual([
            "session:b",
            "session:session-1",
            "session:a",
        ]);
        wrapper.unmount();
    });
});
