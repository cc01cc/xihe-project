import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";

import FileTreePanel from "../components/FileTreePanel.vue";

/**
 * PLAN-0641 T2.5 judges (design D41-14 / contract F2): the undeclared-nested-repo
 * section renders the whole workspace-relative path (B12) with a type label, the
 * declare entry is enabled because the V9 gate is green while the greying path
 * stays testable, and a declaration goes through the existing root CRUD (B1:
 * the click only opens the confirm step; the POST happens on confirm).
 */

type NestedRepo = { path: string; type: string; declared: boolean };
type RootRow = { id: string; alias: string | null; position: number; path?: string | null };

const { wsStub, authStub, apiStub, toastStub } = vi.hoisted(() => ({
    wsStub: {
        workspaceId: "workspace-a",
        fileTree: [] as unknown[],
        isMultiRoot: false,
        workspaceRoots: [] as RootRow[],
        rootTrees: new Map<string, { loaded: boolean; nodes: unknown[] }>(),
        rootTreeState: () => ({ loading: false, loaded: true, nodes: [], error: null }),
        isRootExpanded: () => false,
        treeError: null as string | null,
        treeErrorKind: null as string | null,
        loading: false,
        loadTree: vi.fn<() => Promise<void>>(async () => {}),
        refreshTree: vi.fn<() => Promise<void>>(async () => {}),
        createFile: vi.fn<(path: string, name: string) => Promise<null>>(async () => null),
        openImportDialog: vi.fn<() => void>(),
        loadRootTree: vi.fn<() => Promise<void>>(async () => {}),
    },
    authStub: {
        canWriteWorkspace: true,
        currentWorkspaceId: "workspace-a",
        workspace: { name: "ws-a" },
    },
    apiStub: {
        listWorkspaceNestedRepos: vi.fn<() => Promise<NestedRepo[]>>(),
        addWorkspaceRoot: vi.fn<(wsId: string, input: { path: string }) => Promise<RootRow>>(),
    },
    toastStub: {
        success: vi.fn<(message?: string) => void>(),
        error: vi.fn<(message?: string) => void>(),
    },
}));

vi.mock("../stores/workspace", () => ({ useWorkspaceStore: () => wsStub }));
vi.mock("../../../stores/auth", () => ({ useAuthStore: () => authStub }));
vi.mock("vue-sonner", () => ({ toast: toastStub }));
vi.mock("../../../composables/api", () => ({ api: apiStub }));

const i18n = createI18n({
    legacy: false,
    locale: "en",
    messages: {
        en: {
            sidebar: { workspace: "Workspace" },
            workspace: {
                noFiles: "No files",
                createFile: "New file",
                createFilePlaceholder: "File name",
                uploadFile: "Upload",
                refreshFiles: "Refresh",
                collapseFiles: "Collapse",
                filterFiles: "Filter",
                clearFilter: "Clear",
                dropHint: "Drop files here",
                retry: "Retry",
                viewerReadOnly: "Read-only workspace",
                rootGroupFallback: "Root {position}",
                rootEmpty: "No files in this root",
                nestedReposTitle: "Undeclared nested git repositories",
                nestedRepoDeclare: "Declare as root",
                nestedRepoDeclareYes: "Confirm",
                nestedRepoDeclareCancel: "Cancel",
                nestedRepoDeclareConfirm: "This directory becomes an independent root.",
                nestedRepoDeclared: "Declared as an independent root",
                nestedRepoDeclareFailed: "Declaration failed",
                nestedReposCostHint: "Many roots: each root adds cost.",
                nestedRepoType_nested: "Nested repo",
                nestedRepoType_gitdir: "Linked worktree",
                nestedRepoType_submodule: "Submodule",
                nestedRepoType_bare: "Bare repo",
                nestedRepoType_symlink: "Symlink",
            },
        },
    },
});

function mountPanel(props: Record<string, unknown> = {}) {
    return mount(FileTreePanel, {
        props,
        global: { plugins: [i18n], stubs: { FileTree: true } },
    });
}

const REPOS: NestedRepo[] = [
    { path: "vendor/lib", type: "nested", declared: false },
    { path: "deep/tools/helper", type: "submodule", declared: false },
];

beforeEach(() => {
    vi.clearAllMocks();
    wsStub.workspaceRoots = [];
    authStub.canWriteWorkspace = true;
    apiStub.listWorkspaceNestedRepos.mockResolvedValue([...REPOS]);
    apiStub.addWorkspaceRoot.mockResolvedValue({ id: "root-1", alias: null, position: 1 });
});

describe("nested repos panel", () => {
    it("renders the whole path (B12) with a type label", async () => {
        const wrapper = mountPanel();
        await flushPromises();

        const rows = wrapper.findAll('[data-testid="nested-repo-row"]');
        expect(rows).toHaveLength(2);
        expect(rows[0]!.find('[data-testid="nested-repo-path"]').text()).toBe("vendor/lib");
        expect(rows[0]!.find('[data-testid="nested-repo-type"]').text()).toBe("Nested repo");
        expect(rows[1]!.find('[data-testid="nested-repo-path"]').text()).toBe("deep/tools/helper");
        expect(rows[1]!.find('[data-testid="nested-repo-type"]').text()).toBe("Submodule");
        expect(apiStub.listWorkspaceNestedRepos).toHaveBeenCalledWith("workspace-a");
    });

    it("hides the section when nothing undeclared remains", async () => {
        apiStub.listWorkspaceNestedRepos.mockResolvedValue([
            { path: "vendor/lib", type: "nested", declared: true },
        ]);
        const wrapper = mountPanel();
        await flushPromises();
        expect(wrapper.find('[data-testid="nested-repos-panel"]').exists()).toBe(false);
    });

    it("keeps the greying path: gate closed or viewer disables the declare entry", async () => {
        const gateClosed = mountPanel({ nestedRepoDeclareEnabled: false });
        await flushPromises();
        expect(
            gateClosed.find('[data-testid="nested-repo-declare"]').attributes("disabled"),
        ).toBeDefined();

        authStub.canWriteWorkspace = false;
        const viewer = mountPanel();
        await flushPromises();
        expect(
            viewer.find('[data-testid="nested-repo-declare"]').attributes("disabled"),
        ).toBeDefined();
    });

    it("only declares after the confirm step, then refreshes discovery (B1)", async () => {
        const wrapper = mountPanel();
        await flushPromises();

        await wrapper.find('[data-testid="nested-repo-declare"]').trigger("click");
        expect(wrapper.find('[data-testid="nested-repo-confirm"]').exists()).toBe(true);
        expect(apiStub.addWorkspaceRoot).not.toHaveBeenCalled();

        apiStub.listWorkspaceNestedRepos.mockResolvedValue([]);
        await wrapper.find('[data-testid="nested-repo-declare-confirm"]').trigger("click");
        await flushPromises();

        expect(apiStub.addWorkspaceRoot).toHaveBeenCalledWith("workspace-a", {
            path: "vendor/lib",
        });
        expect(wsStub.refreshTree).toHaveBeenCalled();
        // The cache was evicted CP-side; the refetch reports nothing left to offer.
        expect(wrapper.find('[data-testid="nested-repos-panel"]').exists()).toBe(false);
        expect(toastStub.success).toHaveBeenCalled();
    });

    it("surfaces the problem code when the declaration is rejected", async () => {
        apiStub.addWorkspaceRoot.mockRejectedValue({
            problem: { code: "ROOT_PATH_CONFLICT" },
        });
        const wrapper = mountPanel();
        await flushPromises();

        await wrapper.find('[data-testid="nested-repo-declare"]').trigger("click");
        await wrapper.find('[data-testid="nested-repo-declare-confirm"]').trigger("click");
        await flushPromises();

        expect(toastStub.error).toHaveBeenCalledWith("ROOT_PATH_CONFLICT");
        // Failure keeps the confirm step open for a retry.
        expect(wrapper.find('[data-testid="nested-repo-confirm"]').exists()).toBe(true);
    });

    it("shows the soft cost hint only above sixteen roots (B11)", async () => {
        wsStub.workspaceRoots = Array.from({ length: 16 }, (_, i) => ({
            id: `root-${i}`,
            alias: null,
            position: i,
        }));
        const sixteen = mountPanel();
        await flushPromises();
        expect(sixteen.find('[data-testid="roots-cost-hint"]').exists()).toBe(false);

        wsStub.workspaceRoots = Array.from({ length: 17 }, (_, i) => ({
            id: `root-${i}`,
            alias: null,
            position: i,
        }));
        const seventeen = mountPanel();
        await flushPromises();
        expect(seventeen.find('[data-testid="roots-cost-hint"]').exists()).toBe(true);
    });

    it("labels root groups with the workspace-relative path so leaf-name twins differ (B12)", async () => {
        wsStub.isMultiRoot = true;
        // A non-empty tree keeps the empty-state branch (which precedes the grouped
        // branch) out of the way; FileTree itself is stubbed.
        wsStub.fileTree = [{ name: "a.txt", path: "a.txt" }];
        wsStub.workspaceRoots = [
            { id: "workspace-a", alias: null, position: 0, path: null },
            { id: "root-1", alias: null, position: 1, path: "vendor/lib" },
            { id: "root-2", alias: "工具", position: 2, path: "tools/lib" },
        ];
        const wrapper = mountPanel();
        await flushPromises();

        const headers = wrapper
            .findAll('[data-testid="workspace-tree-root-header"]')
            .map((header) => header.text());
        expect(headers).toHaveLength(3);
        // Path beats alias (the two `lib` roots must stay distinguishable — B12).
        expect(headers[1]).toBe("vendor/lib");
        expect(headers[2]).toBe("tools/lib");
        wsStub.isMultiRoot = false;
        wsStub.fileTree = [];
    });
});
