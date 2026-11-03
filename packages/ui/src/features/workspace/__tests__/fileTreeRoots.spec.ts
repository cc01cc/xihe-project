import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useWorkspaceStore } from "../stores/workspace";
import { api } from "../../../composables/api";
import type * as apiModule from "../../../composables/api";
import type * as fileServiceModule from "../composables/fileService";

/**
 * PLAN-0639 M2 (design §5 candidate ①): the file tree groups by declared root.
 * These tests pin the store contract — expansion gating, root-scoped listing,
 * and event routing by rootId — without a live CP+MCP chain.
 */

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            deleteFile: vi.fn<typeof apiModule.api.deleteFile>(),
            writeFile: vi.fn<typeof apiModule.api.writeFile>(),
            readFile: vi.fn<typeof apiModule.api.readFile>(),
            readFileRange: vi.fn<typeof apiModule.api.readFileRange>(),
            listDirectory: vi.fn<typeof apiModule.api.listDirectory>(),
            moveFile: vi.fn<typeof apiModule.api.moveFile>(),
            copyFile: vi.fn<typeof apiModule.api.copyFile>(),
            createDirectory: vi.fn<typeof apiModule.api.createDirectory>(),
        },
    };
});

vi.mock("../composables/fileService", () => ({
    readFilePreview: vi.fn<typeof fileServiceModule.readFilePreview>(),
}));

vi.mock("../../../stores/session", () => ({
    useSessionStore: () => ({
        currentSessionId: null,
        currentSessionAttachments: [],
        currentSessionFileContext: undefined,
        currentAgentIds: [],
        setFileContext: vi.fn<(file: unknown) => void>(),
    }),
}));

const authState = vi.hoisted(() => ({
    workspace: null as null | {
        id: string;
        hostPath?: string | null;
        roots?: { id: string; alias: string | null; position: number }[];
    },
}));

vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => ({
        get workspace() {
            return authState.workspace;
        },
        currentWorkspaceId: "ws-test",
        canWriteWorkspace: true,
    }),
}));

const mockedApi = vi.mocked(api, true);

const PRIMARY_ROOT = { id: "ws-test", alias: "alpha", position: 0 },
    SECONDARY_ROOT = { id: "root-b", alias: "beta", position: 1 };

function seedMultiRootWorkspace() {
    authState.workspace = {
        id: "ws-test",
        hostPath: "H:/mock/alpha",
        roots: [PRIMARY_ROOT, SECONDARY_ROOT],
    };
}

function mockDirectoryListing() {
    mockedApi.listDirectory.mockImplementation((_path: string, _wsId: string, rootId?: string) =>
        Promise.resolve({
            entries:
                rootId === SECONDARY_ROOT.id ? [{ name: "beta.md", type: "file", size: 5 }] : [],
        }),
    );
}

async function loadSecondaryRoot(store: ReturnType<typeof useWorkspaceStore>) {
    await store.loadRootTree(SECONDARY_ROOT.id);
}

describe("workspace store multi-root grouping (PLAN-0639 M2)", () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.clearAllMocks();
        localStorage.clear();
        authState.workspace = null;
    });

    it("treats a single-root workspace as flat (no grouping)", () => {
        authState.workspace = { id: "ws-test", roots: [PRIMARY_ROOT] };
        const store = useWorkspaceStore();
        expect(store.workspaceRoots).toHaveLength(1);
        expect(store.isMultiRoot).toBe(false);
        expect(store.primaryRootId).toBe("ws-test");
    });

    it("treats a legacy workspace without the roots projection as flat", () => {
        authState.workspace = { id: "ws-test" };
        const store = useWorkspaceStore();
        expect(store.workspaceRoots).toEqual([]);
        expect(store.isMultiRoot).toBe(false);
    });

    it("expansion gates loading: the secondary root lists only after selection", async () => {
        seedMultiRootWorkspace();
        mockDirectoryListing();
        const store = useWorkspaceStore();

        expect(store.isRootExpanded(SECONDARY_ROOT.id)).toBe(false);
        expect(mockedApi.listDirectory).not.toHaveBeenCalled();

        store.toggleRoot(SECONDARY_ROOT.id);
        expect(store.isRootExpanded(SECONDARY_ROOT.id)).toBe(true);
        await vi.waitFor(() => expect(store.rootTreeState(SECONDARY_ROOT.id).loaded).toBe(true));

        expect(mockedApi.listDirectory).toHaveBeenCalledWith("", "ws-test", SECONDARY_ROOT.id);
        const state = store.rootTreeState(SECONDARY_ROOT.id);
        expect(state.loaded).toBe(true);
        expect(state.error).toBeNull();
        expect(state.nodes.map((n) => n.name)).toEqual(["beta.md"]);
    });

    it("auto-expands the primary root group but honors an explicit collapse", () => {
        seedMultiRootWorkspace();
        const store = useWorkspaceStore();
        expect(store.isRootExpanded(PRIMARY_ROOT.id)).toBe(true);
        store.toggleRoot(PRIMARY_ROOT.id);
        expect(store.isRootExpanded(PRIMARY_ROOT.id)).toBe(false);
        store.toggleRoot(PRIMARY_ROOT.id);
        expect(store.isRootExpanded(PRIMARY_ROOT.id)).toBe(true);
    });

    it("primary root load delegates to the legacy unscoped chain", async () => {
        seedMultiRootWorkspace();
        mockDirectoryListing();
        const store = useWorkspaceStore();
        await store.loadRootTree(PRIMARY_ROOT.id);
        expect(mockedApi.listDirectory).toHaveBeenCalledWith("", "ws-test", undefined);
    });

    it("records the load error on the root state instead of throwing", async () => {
        seedMultiRootWorkspace();
        mockedApi.listDirectory.mockRejectedValue(
            new Error("list directory: path traversal detected"),
        );
        const store = useWorkspaceStore();
        await store.loadRootTree(SECONDARY_ROOT.id);
        const state = store.rootTreeState(SECONDARY_ROOT.id);
        expect(state.loaded).toBe(false);
        expect(state.loading).toBe(false);
        expect(state.error).toContain("加载根文件列表失败");
    });

    it("routes a file_changed event by rootId to the owning group only", async () => {
        seedMultiRootWorkspace();
        mockDirectoryListing();
        const store = useWorkspaceStore();
        await loadSecondaryRoot(store);
        vi.clearAllMocks();

        await store.applyWorkspaceEvent({
            workspaceId: "ws-test",
            sequence: 42,
            kind: "file_changed",
            path: "beta.md",
            changeType: "modified",
            source: "runtime",
            rootId: SECONDARY_ROOT.id,
        });

        expect(mockedApi.listDirectory).toHaveBeenCalledTimes(1);
        expect(mockedApi.listDirectory).toHaveBeenCalledWith("", "ws-test", SECONDARY_ROOT.id);
    });

    it("keeps the primary-root refresh for events without rootId (legacy chain)", async () => {
        seedMultiRootWorkspace();
        mockDirectoryListing();
        const store = useWorkspaceStore();
        await loadSecondaryRoot(store);
        vi.clearAllMocks();

        await store.applyWorkspaceEvent({
            workspaceId: "ws-test",
            sequence: 7,
            kind: "file_changed",
            path: "alpha.md",
            changeType: "modified",
            source: "runtime",
        });

        expect(mockedApi.listDirectory).toHaveBeenCalledWith("", "ws-test", undefined);
        expect(mockedApi.listDirectory).not.toHaveBeenCalledWith("", "ws-test", SECONDARY_ROOT.id);
    });

    it("snapshot_required refreshes the primary tree and every loaded secondary root", async () => {
        seedMultiRootWorkspace();
        mockDirectoryListing();
        const store = useWorkspaceStore();
        await loadSecondaryRoot(store);
        vi.clearAllMocks();

        await store.applyWorkspaceEvent({
            workspaceId: "ws-test",
            sequence: 9,
            kind: "snapshot_required",
            source: "runtime",
            reason: "overflow",
        });

        const calls = mockedApi.listDirectory.mock.calls;
        expect(calls).toContainEqual(["", "ws-test", undefined]);
        expect(calls).toContainEqual(["", "ws-test", SECONDARY_ROOT.id]);
    });

    it("openFile scopes the read to the owning root of a secondary-tree path", async () => {
        seedMultiRootWorkspace();
        mockDirectoryListing();
        const { readFilePreview } = await import("../composables/fileService");
        vi.mocked(readFilePreview).mockResolvedValue({ content: "beta", truncated: false });
        const store = useWorkspaceStore();
        await loadSecondaryRoot(store);

        await store.openFile("beta.md");
        expect(readFilePreview).toHaveBeenCalledWith("beta.md", undefined, "ws-test", "root-b");
        expect(store.activeFilePath).toBe("beta.md");
    });

    it("resetWorkspaceScoped clears root groups and loaded secondary trees", async () => {
        seedMultiRootWorkspace();
        mockDirectoryListing();
        const store = useWorkspaceStore();
        await loadSecondaryRoot(store);
        store.toggleRoot(SECONDARY_ROOT.id);

        store.resetWorkspaceScoped();
        expect(store.rootTrees.size).toBe(0);
        expect(store.expandedRootIds.size).toBe(0);
        expect(store.isRootExpanded(SECONDARY_ROOT.id)).toBe(false);
    });
});
