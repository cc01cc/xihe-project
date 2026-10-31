import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import type { Router } from "vue-router";
import WorkspaceWorkbench from "../WorkspaceWorkbench.vue";
import { useAuthStore } from "../../../../stores/auth";
import { useWorkspaceStore } from "../../stores/workspace";

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
    useRoute: () => ({ params: {}, path: "/workspace/workspace-1", query: {} }),
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
                closePanel: "Close the auxiliary panel",
                dockTabs: "Workbench panels",
                dockOverflow: "More panels",
                dockCloseTab: "Close this panel",
                dockResize: "Resize the panel",
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
};

function mountWorkbench(
    props: Partial<{
        workspaceId: string;
        sessionId: string | null;
        isMobile: boolean;
    }> = {},
) {
    return mount(WorkspaceWorkbench, {
        props: {
            workspaceId: "workspace-1",
            sessionId: "session-1",
            isMobile: false,
            ...props,
        },
        global: { plugins: [i18n], stubs },
    });
}

function storedLayout(workspaceId = "workspace-1"): Record<string, unknown> {
    return JSON.parse(localStorage.getItem(`xihe-layout-ws:${workspaceId}`) ?? "{}") as Record<
        string,
        unknown
    >;
}

/** S3b P2-9: writes are coalesced, so persistence assertions have to poll. */
async function expectStored(check: () => void): Promise<void> {
    await vi.waitFor(check, { timeout: 2000, interval: 20 });
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    const auth = useAuthStore();
    auth.$patch({
        token: "token",
        user: { id: "user-1", email: "test@xihe.local" },
        workspace: { id: "workspace-1", name: "Mock Workspace", ownerId: "user-1" },
    });
});

describe("WorkspaceWorkbench skeleton (PLAN-0582 S2)", () => {
    it("renders the toolbar, the file tree column and the conversation slot with the dock closed", async () => {
        const wrapper = mountWorkbench();
        await flushPromises();

        expect(wrapper.find('[data-testid="workspace-workbench"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="workspace-file-tree"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="file-tree-stub"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="workspace-toolbar-code"]').exists()).toBe(true);

        // Ruling #3: the dock is closed by default — no panel, no panel content.
        expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="workspace-conversation"]').exists()).toBe(false);
    });

    it("opens the dock on the requested tab and mounts only that panel", async () => {
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
        expect(wrapper.findAll('[role="tab"]')).toHaveLength(2);
        expect(wrapper.find('[data-testid="dock-tab-code"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="file-editor-stub"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="changes-panel-stub"]').exists()).toBe(true);
        expect(
            wrapper.get('[data-testid="workspace-toolbar-code"]').attributes("aria-pressed"),
        ).toBe("false");
    });

    it("collapses the dock from the active toolbar toggle but keeps the tab set", async () => {
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
        expect(wrapper.findAll('[role="tab"]')).toHaveLength(1);
    });

    it("closes dock tabs and rolls the dock up when the last one closes", async () => {
        const wrapper = mountWorkbench();
        await flushPromises();

        await wrapper.get('[data-testid="workspace-toolbar-code"]').trigger("click");
        await wrapper.get('[data-testid="workspace-toolbar-monitor"]').trigger("click");
        expect(wrapper.findAll('[role="tab"]')).toHaveLength(2);

        await wrapper.get('[data-testid="dock-tab-close-monitor"]').trigger("click");
        expect(wrapper.findAll('[role="tab"]')).toHaveLength(1);
        expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(true);

        // Middle click closes the remaining tab and the empty dock rolls up.
        await wrapper.get('[data-testid="dock-tab-code"]').trigger("auxclick", { button: 1 });
        expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(false);
        await expectStored(() => {
            expect(storedLayout().dockTabs).toEqual([]);
            expect(storedLayout().dockCollapsed).toBe(true);
        });
    });

    it("keeps width and collapsed state independent (collapse then re-open restores the width)", async () => {
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

        // A different workspace starts with the default (closed dock, expanded tree).
        expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="workspace-file-tree"]').exists()).toBe(true);

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
