import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import FileTreePanel from "../components/FileTreePanel.vue";
import { i18n } from "../../../i18n";
import type { FileOpError } from "../stores/workspace";

/**
 * task-59 / D-1708 缺陷 B —— **显示位**判据（组件层，真 i18n）。
 *
 * 两条判据必须**同时**成立，只满足一条就是拿一种误报换另一种：
 *   ①-1 单个文件打不开 ⇒ 画面里出现「无法打开「文件名」」+ 原因，**不出现**「文件树加载失败」；
 *        并且树本身仍可用（横幅不是阻断态、没有「重试整棵树」这条误导出口）。
 *   ①-2 树真的拉不起来 ⇒ 画面里仍然出现「文件树加载失败」（这条不许被新文案顶掉）。
 */

const { wsStub, authStub, apiStub, toastStub } = vi.hoisted(() => ({
    wsStub: {
        workspaceId: "workspace-a",
        fileTree: [] as unknown[],
        isMultiRoot: false,
        workspaceRoots: [] as { id: string; alias: string | null; position: number }[],
        rootTrees: new Map<string, { loaded: boolean; nodes: unknown[] }>(),
        rootTreeState: () => ({ loading: false, loaded: true, nodes: [], error: null }),
        isRootExpanded: () => false,
        primaryRootId: null as string | null,
        primaryRootPath: null as string | null,
        activeFilePath: null as string | null,
        treeError: null as string | null,
        treeErrorKind: "other" as string,
        errorScope: null as string | null,
        fileOpError: null as FileOpError | null,
        loading: false,
        loadTree: vi.fn<() => Promise<void>>(async () => {}),
        refreshTree: vi.fn<() => Promise<void>>(async () => {}),
        createFile: vi.fn<(path: string, name: string) => Promise<null>>(async () => null),
        openImportDialog: vi.fn<() => void>(),
        loadRootTree: vi.fn<() => Promise<void>>(async () => {}),
        toggleRoot: vi.fn<(rootId: string) => void>(),
        clearFileOpError: vi.fn<() => void>(),
    },
    authStub: {
        canWriteWorkspace: true,
        currentWorkspaceId: "workspace-a",
        workspace: { name: "ws-a" },
        refreshWorkspace: vi.fn<() => Promise<void>>(async () => {}),
    },
    apiStub: {
        listWorkspaceNestedRepos: vi.fn<() => Promise<unknown[]>>(async () => []),
        addWorkspaceRoot: vi.fn<() => Promise<unknown>>(async () => ({})),
    },
    toastStub: {
        success: vi.fn<(message?: string) => void>(),
        error: vi.fn<(message?: string) => void>(),
    },
}));

vi.mock("../stores/workspace", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useWorkspaceStore: () => wsStub,
}));
vi.mock("../../../stores/auth", () => ({ useAuthStore: () => authStub }));
vi.mock("vue-sonner", () => ({ toast: toastStub }));
vi.mock("../../../composables/api", () => ({ api: apiStub, ApiError: class extends Error {} }));

function mountPanel() {
    return mount(FileTreePanel, {
        global: { plugins: [i18n], stubs: { FileTree: true } },
    });
}

const FILE_OP: FileOpError = {
    kind: "open",
    path: "demo-approval.txt",
    reason: "notFound",
    code: "MCP_TOOL_ERROR",
};

beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    wsStub.treeError = null;
    wsStub.treeErrorKind = "other";
    wsStub.errorScope = null;
    wsStub.fileOpError = null;
});

describe("task-59 ①-1 单个文件打不开：点名文件 + 原因，不冒充「文件树加载失败」", () => {
    it("渲染行内提示（文件名 + 原因），树级横幅不出现", async () => {
        wsStub.treeError = "Failed to open demo-approval.txt: File not found";
        wsStub.errorScope = "file";
        wsStub.fileOpError = FILE_OP;
        const wrapper = mountPanel();
        await flushPromises();

        const notice = wrapper.find('[data-testid="workspace-file-op-error"]');
        expect(notice.exists(), "文件级提示必须存在").toBe(true);
        const message = wrapper.find('[data-testid="workspace-file-op-error-message"]').text();
        expect(message).toContain("无法打开");
        expect(message, "必须点名是哪个文件").toContain("demo-approval.txt");
        const reason = wrapper.find('[data-testid="workspace-file-op-error-reason"]').text();
        expect(reason).toContain("不存在");
        // 判据核心：这句话里不许出现「文件树加载失败」。
        expect(notice.text()).not.toContain("文件树加载失败");
        // 树没有被宣告不可用 ⇒ 不许给「重试文件树」这个误导出口。
        expect(wrapper.find('[data-testid="workspace-tree-error"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="workspace-tree-retry"]').exists()).toBe(false);
    });

    it("提示可关掉（不阻断继续用聊天与文件树）", async () => {
        wsStub.treeError = "Failed to open demo-approval.txt";
        wsStub.errorScope = "file";
        wsStub.fileOpError = FILE_OP;
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.find('[data-testid="workspace-file-op-error-dismiss"]').trigger("click");
        expect(wsStub.clearFileOpError).toHaveBeenCalledTimes(1);
    });

    it("只读拒绝（没有对象）不渲染成「文件树加载失败」", async () => {
        wsStub.treeError = "当前工作区为只读（VIEWER），无法修改内容";
        wsStub.errorScope = "file";
        wsStub.fileOpError = { kind: "readonly", path: null, reason: "other", code: null };
        const wrapper = mountPanel();
        await flushPromises();
        expect(wrapper.find('[data-testid="workspace-file-op-error-message"]').text()).toContain(
            "只读",
        );
        expect(wrapper.find('[data-testid="workspace-tree-error"]').exists()).toBe(false);
    });
});

describe("task-59 ①-2 树真的拉不起来：仍然显示「文件树加载失败」", () => {
    it("树级故障渲染横幅 + 重试，且不出现文件级提示", async () => {
        wsStub.treeError = "加载文件树失败: boom";
        wsStub.treeErrorKind = "other";
        wsStub.errorScope = "tree";
        const wrapper = mountPanel();
        await flushPromises();

        const banner = wrapper.find('[data-testid="workspace-tree-error"]');
        expect(banner.exists(), "树级故障必须仍然有横幅").toBe(true);
        expect(wrapper.find('[data-testid="workspace-tree-error-message"]').text()).toContain(
            "文件树加载失败",
        );
        expect(wrapper.find('[data-testid="workspace-tree-retry"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="workspace-file-op-error"]').exists()).toBe(false);
    });

    it("runtime / tool 分类的树故障文案仍走 treeLoadFailed* 那一组", async () => {
        wsStub.treeError = "boom";
        wsStub.treeErrorKind = "runtime";
        wsStub.errorScope = "tree";
        expect(mountPanel().find('[data-testid="workspace-tree-error-message"]').text()).toContain(
            "运行时未就绪",
        );
    });
});

describe("task-59 ③ 变异腿：分类被压平后这两条会红", () => {
    it("文件级故障**带**树的 scope 时必须变成「文件树加载失败」⇒ 本用例红", async () => {
        // 模拟变异：写入口不再区分，一律记 tree（旧行为）。
        wsStub.treeError = "Failed to open demo-approval.txt";
        wsStub.errorScope = "tree";
        wsStub.fileOpError = FILE_OP;
        const wrapper = mountPanel();
        await flushPromises();
        // 旧行为下这句话就是「文件树加载失败」——用它反证分类被压平时用户会看到什么。
        expect(wrapper.find('[data-testid="workspace-tree-error-message"]').text()).toContain(
            "文件树加载失败",
        );
        expect(wrapper.find('[data-testid="workspace-file-op-error"]').exists()).toBe(false);
    });
});
