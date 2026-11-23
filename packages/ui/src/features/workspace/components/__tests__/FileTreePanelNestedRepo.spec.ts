import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import FileTreePanel from "../FileTreePanel.vue";
import { i18n } from "../../../../i18n";

/**
 * task-939（R76）—— 嵌套仓声明从「顶部两张全宽卡片」改成「树内节点操作」后，
 * 面板侧的三件事必须仍然成立：
 *
 *   ① 文件面板里不再有卡片块（`nested-repos-panel` / `nested-repo-row` 不存在）；
 *   ② 树仍照常渲染（发现列表是咨询性的，空/失败都不许影响树）；
 *   ③ 行内确认上来的路径才落 POST：POST 用**现有 root CRUD**（`addWorkspaceRoot`），
 *      成功后刷新树 + 重新发现 + 刷新工作区视图；陈旧路径（已声明/已消失）不得 POST。
 */

const { wsStub, authStub, apiStub, toastStub } = vi.hoisted(() => ({
    wsStub: {
        workspaceId: "workspace-a",
        fileTree: [
            { name: "repo-a", path: "repo-a", type: "directory", children: [] },
            { name: "repo-b", path: "repo-b", type: "directory", children: [] },
        ],
        isMultiRoot: false,
        workspaceRoots: [] as { id: string; alias: string | null; position: number }[],
        rootTrees: new Map<string, { loaded: boolean; nodes: unknown[] }>(),
        rootTreeState: () => ({ loading: false, loaded: true, nodes: [], error: null }),
        isRootExpanded: () => false,
        primaryRootId: null as string | null,
        primaryRootPath: null as string | null,
        activeFilePath: null as string | null,
        activeDirPath: null as string | null,
        // 真树（FileTree/TreeNodeList）在本 spec 里照常挂载 ⇒ 需要展开集与打开动作。
        expandedPaths: new Set<string>(),
        openFile: vi.fn<(path: string, rootId?: string) => void>(),
        openDirectory: vi.fn<(path: string) => void>(),
        treeError: null as string | null,
        treeErrorKind: null as string | null,
        errorScope: null as string | null,
        fileOpError: null as unknown,
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
        workspace: { name: "评审夹具工作区" },
        refreshWorkspace: vi.fn<() => Promise<void>>(async () => {}),
    },
    apiStub: {
        listWorkspaceNestedRepos: vi.fn<() => Promise<unknown[]>>(),
        addWorkspaceRoot: vi.fn<(wsId: string, input: { path: string }) => Promise<unknown>>(),
        getWorkspaceGitStatus: vi.fn<() => Promise<unknown>>(),
    },
    toastStub: {
        success: vi.fn<(message?: string) => void>(),
        error: vi.fn<(message?: string) => void>(),
    },
}));

vi.mock("../../stores/workspace", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useWorkspaceStore: () => wsStub,
}));
vi.mock("../../../../stores/auth", () => ({ useAuthStore: () => authStub }));
vi.mock("vue-sonner", () => ({ toast: toastStub }));
vi.mock("../../../../composables/api", (importOriginal) => ({
    ...(importOriginal as Record<string, unknown>),
    api: apiStub,
    ApiError: class extends Error {},
}));

/** 发现列表夹具：repo-a 可申报、repo-b 是 linked worktree（也可申报）、plain-dir 已声明。 */
const REPOS = [
    { path: "repo-a", type: "nested", declared: false },
    { path: "repo-b", type: "gitdir", declared: false },
];

beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    sessionStorage.clear();
    wsStub.isMultiRoot = false;
    wsStub.workspaceRoots = [];
    apiStub.listWorkspaceNestedRepos.mockResolvedValue([...REPOS]);
    apiStub.addWorkspaceRoot.mockResolvedValue({ id: "root-1", alias: null, position: 1 });
    apiStub.getWorkspaceGitStatus.mockResolvedValue({ isRepository: true, entries: [] });
});

describe("task-939 面板侧：卡片块退场、行内动作接管", () => {
    it("顶部不再有嵌套仓卡片块，树照常渲染", async () => {
        const wrapper = mount(FileTreePanel, { global: { plugins: [i18n] } });
        await flushPromises();

        expect(wrapper.find('[data-testid="nested-repos-panel"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="nested-repo-row"]').exists()).toBe(false);
        expect(wrapper.findAll('[role="treeitem"]').length).toBeGreaterThan(0);
    });

    it("行内确认后的路径走既有 root CRUD，并刷新树/发现/工作区视图", async () => {
        const wrapper = mount(FileTreePanel, { global: { plugins: [i18n] } });
        await flushPromises();

        const entry = wrapper.get('[data-testid="nested-repo-declare"]');
        await entry.trigger("click");
        await wrapper.get('[data-testid="nested-repo-declare-confirm"]').trigger("click");
        await flushPromises();

        expect(apiStub.addWorkspaceRoot).toHaveBeenCalledWith("workspace-a", { path: "repo-a" });
        expect(wsStub.refreshTree).toHaveBeenCalled();
        expect(authStub.refreshWorkspace).toHaveBeenCalled();
        expect(toastStub.success).toHaveBeenCalledWith(
            i18n.global.t("workspace.nestedRepoDeclared"),
        );
        // 申报成功后行内确认态仍在原地（失败要能原地重试）；成功路径靠重新发现把整行收起。
        expect(wrapper.find('[data-testid="nested-repo-confirm"]').exists()).toBe(true);
    });

    it("申报失败：每条 problem code 映射成本地化文案，不直显 CP 原文", async () => {
        apiStub.addWorkspaceRoot.mockRejectedValue({
            problem: { code: "ROOT_PATH_CONFLICT", detail: "backend detail" },
        });
        const wrapper = mount(FileTreePanel, { global: { plugins: [i18n] } });
        await flushPromises();

        await wrapper.get('[data-testid="nested-repo-declare"]').trigger("click");
        await wrapper.get('[data-testid="nested-repo-declare-confirm"]').trigger("click");
        await flushPromises();

        expect(toastStub.error).toHaveBeenCalledWith(
            i18n.global.t("workspace.nestedRepoDeclareErrorConflict"),
        );
        expect(toastStub.error).not.toHaveBeenCalledWith("backend detail");
    });

    it("发现失败不许影响树：列表清空、树仍渲染、不出现任何入口", async () => {
        apiStub.listWorkspaceNestedRepos.mockRejectedValue(new Error("probe unavailable"));
        const wrapper = mount(FileTreePanel, { global: { plugins: [i18n] } });
        await flushPromises();

        expect(wrapper.findAll('[role="treeitem"]').length).toBeGreaterThan(0);
        expect(wrapper.find('[data-testid="nested-repos-panel"]').exists()).toBe(false);
        expect(wrapper.findAll('[data-testid="nested-repo-declare"]')).toHaveLength(0);
    });

    it("只读工作区：入口置灰且点击不 POST（写权限判据仍在面板侧）", async () => {
        authStub.canWriteWorkspace = false;
        const wrapper = mount(FileTreePanel, { global: { plugins: [i18n] } });
        await flushPromises();

        const entry = wrapper.get('[data-testid="nested-repo-declare"]');
        expect(entry.attributes("disabled")).toBeDefined();
        await entry.trigger("click");
        expect(apiStub.addWorkspaceRoot).not.toHaveBeenCalled();
        authStub.canWriteWorkspace = true;
    });
});
