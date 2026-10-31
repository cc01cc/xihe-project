import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import type { Router } from "vue-router";
import WorkspaceTabBar from "../WorkspaceTabBar.vue";
import { useSessionStore } from "../../../../stores/session";
import { readWorkspaceLayout } from "../../../../composables/useWorkspaceLayout";

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
                environmentState: "Environment",
                scheduledTasks: { nav: "Scheduled tasks" },
                settingsTitle: "Workspace settings",
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

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    pushSpy.mockClear();
    routeState.name = "workspace-chat";
    routeState.path = "/workspace/workspace-1/chat/session-1";
    routeState.fullPath = "/workspace/workspace-1/chat/session-1";
});

describe("WorkspaceTabBar (PLAN-0582 S3a)", () => {
    it("shows the chat tab and highlights it on a chat route", async () => {
        const wrapper = mountBar();
        await flushPromises();

        expect(wrapper.get('[data-testid="workspace-tab-chat"]').attributes("aria-selected")).toBe(
            "true",
        );
        // All route tabs are entry points by default; only the chat one is active.
        expect(
            wrapper
                .get('[data-testid="workspace-toolbar-environment"]')
                .attributes("aria-selected"),
        ).toBe("false");
    });

    it("adds a tab for a deep-linked route and marks it active", async () => {
        routeState.name = "workspace-environment";
        routeState.path = "/workspace/workspace-1/environment";
        routeState.fullPath = "/workspace/workspace-1/environment";
        const wrapper = mountBar();
        await flushPromises();

        const tab = wrapper.get('[data-testid="workspace-toolbar-environment"]');
        expect(tab.attributes("aria-selected")).toBe("true");
        expect(wrapper.get('[data-testid="workspace-tab-chat"]').attributes("aria-selected")).toBe(
            "false",
        );
        // The open set is persisted per workspace.
        expect(readWorkspaceLayout("workspace-1").openTabs).toContain("environment");
    });

    it("navigates with router.push only (no navigation interception)", async () => {
        routeState.name = "workspace-environment";
        routeState.path = "/workspace/workspace-1/environment";
        routeState.fullPath = "/workspace/workspace-1/environment";
        const wrapper = mountBar();
        await flushPromises();

        await wrapper.get('[data-testid="workspace-tab-chat"]').trigger("click");

        expect(pushSpy).toHaveBeenCalledWith("/workspace/workspace-1/chat/session-1");
        // Exactly one push: the tab bar never intercepts or re-dispatches navigation.
        expect(pushSpy).toHaveBeenCalledTimes(1);
    });

    it("falls back to the chat tab when the active tab is closed", async () => {
        routeState.name = "workspace-settings";
        routeState.path = "/workspace/workspace-1/settings";
        routeState.fullPath = "/workspace/workspace-1/settings";
        const wrapper = mountBar();
        await flushPromises();

        await wrapper.get('[data-testid="workspace-tab-close-settings"]').trigger("click");

        expect(pushSpy).toHaveBeenCalledWith("/workspace/workspace-1/chat/session-1");
        expect(readWorkspaceLayout("workspace-1").openTabs).not.toContain("settings");
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
