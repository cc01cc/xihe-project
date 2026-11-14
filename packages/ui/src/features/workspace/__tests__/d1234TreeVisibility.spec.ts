import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { mount } from "@vue/test-utils";
import { useWorkspaceStore, isEmptyDirectoryNode } from "../stores/workspace";
import { api } from "../../../composables/api";
import type * as apiModule from "../../../composables/api";
import type * as fileServiceModule from "../composables/fileService";
import FileTreeNode from "../components/FileTreeNode.vue";
import type { FileNode } from "../../../types";

/**
 * D-1234（台账 lead-decisions-ledger.md:9449-9452，用户 2026-11-14 00:1x 裁）：
 * 文件树「都显示」—— dotfile 排在普通文件之后、置灰；空目录可见且淡样式。
 * 边界与 T2/T4 独立成立：**显示 dotfile ≠ 显示 .git**（.git 目录属 VCS 内部，不进树）。
 *
 * 本 spec 四条各自独立可红（task-484 变异验证口径）：
 *   A 排序：dotfile 排普通文件后
 *   B VCS：.git 目录不进树；.git 作为文件（worktree gitdir 指针）保留
 *   C 空目录：可见 + store 层露出 isEmpty 判据 + 渲染淡样式
 *   D 例外：空 logs 仍隐藏（D-1234 由 Lead 裁为合法例外），非空 logs 仍可见
 */

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            listDirectory: vi.fn<typeof apiModule.api.listDirectory>(),
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

vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => ({
        workspace: { id: "ws-test", hostPath: "H:/mock/ws" },
        currentWorkspaceId: "ws-test",
        canWriteWorkspace: true,
    }),
}));

const mockedApi = vi.mocked(api, true);

type Entry = { name: string; type: "file" | "directory"; size?: number };

// 只在根层返回给定条目；子目录返回空列表 —— 否则 fetchDirectoryTree 会沿目录项无限递归
// （第一版就踩了这个：mock 忽略 path ⇒ worker 直接崩，错误看起来像产品问题）。
function mockListing(entries: Entry[]) {
    mockedApi.listDirectory.mockImplementation((path: string) =>
        Promise.resolve({ entries: path === "" ? entries : [] } as never),
    );
}

async function loadTree() {
    const store = useWorkspaceStore();
    await store.loadTree();
    return store;
}

function names(nodes: FileNode[]): string[] {
    return nodes.map((n) => n.name);
}

describe("D-1234 文件树可见性（task-484）", () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.clearAllMocks();
        localStorage.clear();
    });

    // ---- A 排序：dotfile 排普通文件之后 ----
    it("A: dotfile 排在普通文件之后（组内），目录仍整体在前", async () => {
        mockListing([
            { name: ".editorconfig", type: "file" },
            { name: "a.ts", type: "file" },
            { name: "README.md", type: "file" },
            { name: ".env", type: "file" },
            { name: ".github", type: "directory" },
            { name: "src", type: "directory" },
        ]);
        const store = await loadTree();
        expect(names(store.fileTree)).toEqual([
            "src",
            ".github",
            "a.ts",
            "README.md",
            ".editorconfig",
            ".env",
        ]);
    });

    // ---- B VCS 内部：.git 目录不进树，.git 文件保留 ----
    it("B: .git 目录不进树", async () => {
        mockListing([
            { name: ".git", type: "directory" },
            { name: "src", type: "directory" },
            { name: "a.ts", type: "file" },
        ]);
        const store = await loadTree();
        expect(names(store.fileTree)).not.toContain(".git");
        expect(names(store.fileTree)).toEqual(["src", "a.ts"]);
    });

    it("B: .git 作为文件（worktree gitdir 指针）保留 —— T3 要求可读", async () => {
        mockListing([
            { name: ".git", type: "file", size: 42 },
            { name: "a.ts", type: "file" },
        ]);
        const store = await loadTree();
        const git = store.fileTree.find((n) => n.name === ".git");
        expect(git).toBeDefined();
        expect(git?.type).toBe("file");
    });

    // ---- C 空目录：可见 + store 判据 + 渲染淡样式 ----
    it("C: 空目录可见，且 store 露出 isEmpty 判据", async () => {
        mockListing([
            { name: "empty-dir", type: "directory" },
            { name: "src", type: "directory" },
            { name: "a.ts", type: "file" },
        ]);
        const store = await loadTree();
        const emptyDir = store.fileTree.find((n) => n.name === "empty-dir");
        expect(emptyDir).toBeDefined();
        expect(isEmptyDirectoryNode(emptyDir as FileNode)).toBe(true);
        const src = store.fileTree.find((n) => n.name === "src");
        expect(isEmptyDirectoryNode(src as FileNode)).toBe(true); // src 无子项 ⇒ 也是空
        const file = store.fileTree.find((n) => n.name === "a.ts");
        expect(isEmptyDirectoryNode(file as FileNode)).toBe(false);
    });

    it("C: 空目录节点渲染带淡样式标记，非空不带", () => {
        const emptyDir: FileNode = {
            name: "empty-dir",
            path: "empty-dir",
            type: "directory",
            children: [],
        };
        const nonEmpty: FileNode = {
            name: "src",
            path: "src",
            type: "directory",
            children: [{ name: "a.ts", path: "src/a.ts", type: "file" }],
        };
        const emptyW = mount(FileTreeNode, {
            props: {
                node: emptyDir,
                depth: 0,
                selectedPath: null,
                expandedPaths: new Set<string>(),
            },
        });
        const fullW = mount(FileTreeNode, {
            props: {
                node: nonEmpty,
                depth: 0,
                selectedPath: null,
                expandedPaths: new Set<string>(),
            },
        });
        expect(emptyW.get('[data-testid="file-tree-node"]').attributes("data-empty-dir")).toBe(
            "true",
        );
        expect(
            fullW.get('[data-testid="file-tree-node"]').attributes("data-empty-dir"),
        ).toBeUndefined();
        expect(emptyW.get('[data-testid="file-tree-node"]').classes().join(" ")).toContain(
            "opacity-60",
        );
    });

    // ---- D 例外：空 logs 仍隐藏 ----
    it("D: 空 logs 目录仍隐藏（Lead 裁定的合法例外）", async () => {
        mockListing([
            { name: "logs", type: "directory" },
            { name: "empty-dir", type: "directory" },
            { name: "a.ts", type: "file" },
        ]);
        const store = await loadTree();
        expect(names(store.fileTree)).not.toContain("logs");
        expect(names(store.fileTree)).toContain("empty-dir");
    });

    it("D: 非空 logs 目录仍可见（不是一刀切隐藏 logs）", async () => {
        mockedApi.listDirectory.mockImplementation((path: string) =>
            Promise.resolve({
                entries: (path === "logs"
                    ? [{ name: "app.log", type: "file" }]
                    : [{ name: "logs", type: "directory" }]) as Entry[],
            } as never),
        );
        const store = await loadTree();
        const logs = store.fileTree.find((n) => n.name === "logs");
        expect(logs).toBeDefined();
        expect(logs?.children?.map((c) => c.name)).toEqual(["app.log"]);
    });

    // ---- 渲染：dotfile 置灰，非 dotfile 不受影响 ----
    it("dotfile 节点带置灰标记与 muted class，普通文件不带", () => {
        const dot: FileNode = { name: ".editorconfig", path: ".editorconfig", type: "file" };
        const plain: FileNode = { name: "a.ts", path: "a.ts", type: "file" };
        const dotW = mount(FileTreeNode, {
            props: { node: dot, depth: 0, selectedPath: null, expandedPaths: new Set<string>() },
        });
        const plainW = mount(FileTreeNode, {
            props: { node: plain, depth: 0, selectedPath: null, expandedPaths: new Set<string>() },
        });
        expect(dotW.get('[data-testid="file-tree-node"]').attributes("data-dotfile")).toBe("true");
        expect(
            plainW.get('[data-testid="file-tree-node"]').attributes("data-dotfile"),
        ).toBeUndefined();
        expect(dotW.get(".truncate").classes().join(" ")).toContain("text-muted-foreground");
        expect(plainW.get(".truncate").classes().join(" ")).not.toContain("text-muted-foreground");
    });
});
