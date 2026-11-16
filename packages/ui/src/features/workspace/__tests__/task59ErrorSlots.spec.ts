import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { ApiError, api } from "../../../composables/api";
import type * as apiModule from "../../../composables/api";
import type * as fileServiceModule from "../composables/fileService";
import {
    classifyFileOpReason,
    fileOpReasonKey,
    fileOpTitleKey,
    useWorkspaceStore,
    visibleErrorSlot,
    type ErrorScope,
    type FileOpError,
    type FileOpKind,
    type FileOpReason,
} from "../stores/workspace";

/**
 * task-59 / D-1708 缺陷 B：`setTreeError` 六种语义共用一个显示位。
 *
 * 本 spec 是这张卡的**主交付**：证明的是「分类能力」而不是「改了句文案」。
 * 三条互相独立的判据：
 *   ① store 每个调用点落对 (scope, kind, reason, path) —— 逐点一条；
 *   ② 显示位判定是纯函数且表测（`visibleErrorSlot`）—— 变异腿在这里红；
 *   ③ 文件级故障不得借用树级文案，树级故障不得被文件级覆盖。
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

const authMock = vi.hoisted(() => ({ canWriteWorkspace: true }));

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
        currentWorkspaceId: "ws-test",
        get canWriteWorkspace() {
            return authMock.canWriteWorkspace;
        },
    }),
}));

const mockedApi = vi.mocked(api, true);

function problemError(status: number, code: string, detail?: string): ApiError {
    return new ApiError({ status, code, detail: detail ?? code, requestId: "test" });
}

function seedOpenFile(store: ReturnType<typeof useWorkspaceStore>, path: string) {
    store.openFiles.set(path, {
        path,
        name: path.split("/").pop() ?? path,
        content: "edited",
        originalContent: "",
        language: "plaintext",
        modified: true,
        loading: false,
    });
}

function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    authMock.canWriteWorkspace = true;
});
describe("task-59 ① 逐调用点分类（6 处 + 同族扩展点）", () => {
    it("site :187 只读拒绝 ⇒ file/readonly，不是树故障", async () => {
        authMock.canWriteWorkspace = false;
        const store = useWorkspaceStore();
        // 具体动作不重要：ensureWritable 是 save/delete/create 共同的门。
        await store.saveFile("a.txt");
        expect(store.errorScope).toBe("file");
        expect(store.fileOpError).toMatchObject<Partial<FileOpError>>({
            kind: "readonly",
            path: null,
            reason: "other",
        });
    });

    it("site :407 树加载失败 ⇒ tree/runtime（显示位仍是横幅）", async () => {
        mockedApi.listDirectory.mockRejectedValue(problemError(500, "RUNTIME_ERROR"));
        const store = useWorkspaceStore();
        await store.loadTree();
        expect(store.errorScope).toBe("tree");
        expect(store.treeErrorKind).toBe("runtime");
        expect(store.fileOpError).toBeNull();
    });

    it("site :435 排队重跑失败 ⇒ 同样分类为树故障（与首载同一条判据）", async () => {
        const first = deferred<{ entries: [] }>(),
            second = deferred<{ entries: [] }>();
        mockedApi.listDirectory
            .mockReturnValueOnce(first.promise as never)
            .mockReturnValueOnce(second.promise as never);
        const store = useWorkspaceStore();
        const initial = store.loadTree();
        await Promise.resolve();
        // 载入进行中再请求一次 ⇒ 排队，由首载的 finally 排水重跑（workspace.ts 的 site :435）。
        const queued = store.loadTree();
        first.reject(problemError(500, "RUNTIME_ERROR"));
        // 排水那一次用**不同的码**，才能证明 :435 自己也分类（而不是沿用上一轮结果）。
        await Promise.resolve();
        second.reject(problemError(502, "UNKNOWN_TOOL"));
        await Promise.all([initial, queued]);
        expect(store.errorScope).toBe("tree");
        expect(store.treeErrorKind).toBe("tool");
        expect(store.fileOpError).toBeNull();
    });
    it("site :707 打开单个文件失败 ⇒ file/open + 原因 + 文件名（本卡根因）", async () => {
        const { readFilePreview } = await import("../composables/fileService");
        vi.mocked(readFilePreview).mockRejectedValue(
            problemError(502, "MCP_TOOL_ERROR", "File not found: demo-approval.txt"),
        );
        const store = useWorkspaceStore();
        await store.openFile("demo-approval.txt");
        expect(store.errorScope).toBe("file");
        expect(store.fileOpError).toMatchObject<Partial<FileOpError>>({
            kind: "open",
            path: "demo-approval.txt",
            reason: "notFound",
            code: "MCP_TOOL_ERROR",
        });
        // 兼容通道：FileNodeMenu 仍从 treeError 取可读消息（拆的是显示位，不是消息面）。
        expect(store.treeError).toContain("demo-approval.txt");
    });

    it("site :747 保存失败 ⇒ file/save", async () => {
        mockedApi.writeFile.mockRejectedValue(problemError(500, "RUNTIME_ERROR"));
        const store = useWorkspaceStore();
        seedOpenFile(store, "notes.md");
        await store.saveFile("notes.md");
        expect(store.errorScope).toBe("file");
        expect(store.fileOpError).toMatchObject<Partial<FileOpError>>({
            kind: "save",
            path: "notes.md",
            reason: "runtime",
        });
    });

    it("site :825 删除失败 ⇒ file/delete", async () => {
        mockedApi.deleteFile.mockRejectedValue(problemError(404, "FILE_NOT_FOUND"));
        const store = useWorkspaceStore();
        expect(await store.deleteNode("gone.txt")).toBe(false);
        expect(store.errorScope).toBe("file");
        expect(store.fileOpError).toMatchObject<Partial<FileOpError>>({
            kind: "delete",
            path: "gone.txt",
            reason: "notFound",
        });
    });
});
describe("task-59 ① 同族扩展点：动作失败都走文件通道", () => {
    it("create/rename/move/duplicate/mkdir/read/splitPdf 逐点分类", async () => {
        const store = useWorkspaceStore();

        mockedApi.writeFile.mockRejectedValueOnce(problemError(400, "INVALID_REQUEST"));
        await store.createFile("", "bad.txt");
        expect(store.fileOpError?.kind).toBe("create");

        mockedApi.moveFile.mockRejectedValueOnce(problemError(404, "FILE_NOT_FOUND"));
        await store.renameNode("a.txt", "b.txt");
        expect(store.fileOpError?.kind).toBe("rename");

        mockedApi.moveFile.mockRejectedValueOnce(problemError(404, "FILE_NOT_FOUND"));
        await store.moveNode("a.txt", "dst");
        expect(store.fileOpError?.kind).toBe("move");

        mockedApi.copyFile.mockRejectedValueOnce(problemError(404, "FILE_NOT_FOUND"));
        await store.duplicateNode("a.txt");
        expect(store.fileOpError?.kind).toBe("duplicate");

        mockedApi.createDirectory.mockRejectedValueOnce(problemError(404, "FILE_NOT_FOUND"));
        await store.createDirectory("src", "assets");
        expect(store.fileOpError?.kind).toBe("mkdir");

        // rename 的**校验拒绝**（原文是英文硬编码）也要晋级成可本地化的原因枚举。
        expect(await store.renameNode("a.txt", "b/c")).toBe(false);
        expect(store.fileOpError?.kind).toBe("rename");
        expect(store.fileOpError?.reason).toBe("invalidName");

        mockedApi.readFile.mockRejectedValueOnce(problemError(404, "FILE_NOT_FOUND"));
        await store.loadFullContent("big.log");
        expect(store.fileOpError?.kind).toBe("read");

        await store.splitPdf("doc.pdf");
        expect(store.fileOpError?.kind).toBe("splitPdf");
        expect(store.fileOpError?.reason).toBe("unavailable");
        expect(store.fileOpError?.path).toBe("doc.pdf");

        expect(store.errorScope).toBe("file");
    });
});

describe("task-59 ② 显示位判定（纯函数表测；变异腿在此变红）", () => {
    const fileOp: FileOpError = {
        kind: "open",
        path: "demo-approval.txt",
        reason: "notFound",
        code: "MCP_TOOL_ERROR",
    };

    const cases: [string, ErrorScope | null, string | null, FileOpError | null, string][] = [
        ["树级故障 ⇒ 横幅", "tree", "加载文件树失败: boom", null, "tree"],
        ["文件级故障 ⇒ 行内提示", "file", "Failed to open demo-approval.txt", fileOp, "file"],
        ["无故障 ⇒ 都不显示", null, null, null, "none"],
        ["文件级但已清除 ⇒ 都不显示", "file", null, null, "none"],
        ["树级且同时有文件级残留 ⇒ 树级优先（一屏一条红）", "tree", "boom", fileOp, "tree"],
    ];

    it.each(cases)("%s", (_label, scope, treeError, opErr, expected) => {
        expect(visibleErrorSlot(scope, treeError, opErr)).toBe(expected);
    });

    it("文件级标题/原因键与树级键是两组，不共用「文件树加载失败」", () => {
        expect(fileOpTitleKey(fileOp.kind)).toBe("workspace.fileOpOpenFailed");
        expect(fileOpTitleKey("open")).not.toContain("treeLoadFailed");
        expect(fileOpReasonKey(fileOp.reason)).toBe("workspace.fileOpReasonNotFound");
    });
});

describe("task-59 ③ 原因判定与 i18n 键覆盖", () => {
    const cases: [string, unknown, FileOpReason][] = [
        ["FILE_NOT_FOUND 码", problemError(404, "FILE_NOT_FOUND"), "notFound"],
        [
            "MCP_TOOL_ERROR 的 detail 说文件不存在（截图里的真实形态）",
            problemError(502, "MCP_TOOL_ERROR", "File not found: demo-approval.txt"),
            "notFound",
        ],
        [
            "IO_ERROR + ENOENT",
            new ApiError({ status: 500, code: "IO_ERROR", detail: "ENOENT", requestId: "t" }),
            "notFound",
        ],
        ["403 ACCESS_DENIED", problemError(403, "ACCESS_DENIED"), "permission"],
        [
            "MCP_TOOL_ERROR + permission denied",
            problemError(403, "MCP_TOOL_ERROR", "Permission denied"),
            "permission",
        ],
        ["runtime 族", problemError(500, "RUNTIME_UNAVAILABLE"), "runtime"],
        ["tool 族", problemError(502, "UNKNOWN_TOOL"), "tool"],
        ["其余码", problemError(400, "INVALID_REQUEST"), "other"],
        [
            "裸 Error：二进制预览被拒（fileService 的真实抛法）",
            new Error("Binary files cannot be opened as text previews"),
            "binary",
        ],
        ["非 ApiError", new Error("boom"), "unknown"],
    ];

    it.each(cases)("%s ⇒ %s", (_label, error, expected) => {
        expect(classifyFileOpReason(error).reason).toBe(expected);
    });

    it("每个 kind / reason 在 zh 与 en 两侧都有键", async () => {
        const { i18n } = await import("../../../i18n");
        // vue-i18n v11 composition 模式下 `messages` 是 ComputedRef，取值要走 `.value`。
        const messages = i18n.global.messages.value as unknown as Record<
            string,
            { workspace: Record<string, string> }
        >;
        const kinds: FileOpKind[] = [
            "open",
            "save",
            "delete",
            "create",
            "rename",
            "move",
            "duplicate",
            "mkdir",
            "read",
            "splitPdf",
            "readonly",
        ];
        const reasons: FileOpReason[] = [
            "notFound",
            "permission",
            "runtime",
            "tool",
            "invalidName",
            "unavailable",
            "binary",
            "other",
            "unknown",
        ];
        for (const locale of ["zh-CN", "en-US"]) {
            const block = messages[locale].workspace;
            for (const kind of kinds) {
                const key = fileOpTitleKey(kind).split(".")[1];
                expect(block[key], `${locale} 缺 ${kind} 的标题键`).toBeTruthy();
            }
            for (const reason of reasons) {
                const key = fileOpReasonKey(reason).split(".")[1];
                expect(block[key], `${locale} 缺 ${reason} 的原因键`).toBeTruthy();
            }
        }
    });
});

describe("task-59 ④ 打开失败后树仍可用；一次后台刷新不能把它悄悄抹掉", () => {
    it("树重新加载成功不清除文件级提示（否则用户看不到刚失败的那条）", async () => {
        const { readFilePreview } = await import("../composables/fileService");
        vi.mocked(readFilePreview).mockRejectedValue(
            problemError(502, "MCP_TOOL_ERROR", "File not found: demo-approval.txt"),
        );
        mockedApi.listDirectory.mockResolvedValue({ entries: [] });
        const store = useWorkspaceStore();
        await store.openFile("demo-approval.txt");
        expect(store.errorScope).toBe("file");
        // 后台刷新（文件事件）成功：树级通道被清空，但文件级提示必须留着。
        await store.loadTree();
        expect(store.treeError).toBeNull();
        expect(store.errorScope).toBe("file");
        expect(store.fileOpError?.kind).toBe("open");
        expect(visibleErrorSlot(store.errorScope, store.treeError, store.fileOpError)).toBe("file");
    });

    it("真·树故障出现时文件级提示让路（一屏只留一条红）", async () => {
        const { readFilePreview } = await import("../composables/fileService");
        vi.mocked(readFilePreview).mockRejectedValue(problemError(502, "MCP_TOOL_ERROR", "boom"));
        const store = useWorkspaceStore();
        await store.openFile("a.txt");
        expect(store.fileOpError).not.toBeNull();
        mockedApi.listDirectory.mockRejectedValueOnce(problemError(500, "RUNTIME_ERROR"));
        await store.loadTree();
        expect(store.errorScope).toBe("tree");
        expect(store.fileOpError).toBeNull();
    });

    it("失败只影响那一个文件；另一个文件照常打开，且下一条提示替换上一条", async () => {
        const { readFilePreview } = await import("../composables/fileService");
        vi.mocked(readFilePreview).mockImplementation(async (path: string) => {
            if (path === "demo-approval.txt") {
                throw problemError(502, "MCP_TOOL_ERROR", "File not found: demo-approval.txt");
            }
            return { content: "hello", truncated: false };
        });
        mockedApi.listDirectory.mockResolvedValue({ entries: [] });
        const store = useWorkspaceStore();
        await store.loadTree();
        expect(store.treeError).toBeNull();
        expect(store.errorScope).toBeNull();

        await store.openFile("demo-approval.txt");
        expect(store.errorScope).toBe("file");
        expect(store.openFiles.has("demo-approval.txt")).toBe(false);

        await store.openFile("a.txt");
        expect(store.openFiles.get("a.txt")?.content).toBe("hello");
        expect(store.fileOpError).toBeNull();
        expect(store.treeError).toBeNull();

        // 手动清除也回到无故障态。
        await store.openFile("demo-approval.txt");
        expect(store.errorScope).toBe("file");
        store.clearFileOpError();
        expect(store.fileOpError).toBeNull();
        expect(store.treeError).toBeNull();
        expect(visibleErrorSlot(store.errorScope, store.treeError, store.fileOpError)).toBe("none");
    });
});
