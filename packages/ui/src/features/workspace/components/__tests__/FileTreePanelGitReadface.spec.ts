import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import FileTreePanel from "../FileTreePanel.vue";
import { i18n } from "../../../../i18n";
import type * as apiModule from "../../../../composables/api";
import { api } from "../../../../composables/api";

/** task-36：文件树面板「读现状」探针的单测形状（真组件 + mock API；不替代 mock E2E）。 */

const { wsStub, authStub, apiStub, toastStub } = vi.hoisted(() => ({
    wsStub: {
        workspaceId: "workspace-a",
        fileTree: [{ name: "README.md", path: "README.md", type: "file", size: 12 }],
        isMultiRoot: false,
        workspaceRoots: [] as { id: string; alias: string | null; position: number }[],
        rootTrees: new Map<string, { loaded: boolean; nodes: unknown[] }>(),
        rootTreeState: () => ({ loading: false, loaded: true, nodes: [], error: null }),
        isRootExpanded: () => false,
        primaryRootId: null as string | null,
        primaryRootPath: null as string | null,
        activeFilePath: null as string | null,
        activeDirPath: null as string | null,
        treeError: null as string | null,
        treeErrorKind: "other" as string,
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
        workspace: { name: "ws-a" },
        refreshWorkspace: vi.fn<() => Promise<void>>(async () => {}),
    },
    apiStub: {
        listWorkspaceNestedRepos: vi.fn<() => Promise<unknown[]>>(async () => []),
        addWorkspaceRoot: vi.fn<() => Promise<unknown>>(async () => ({})),
        getWorkspaceGitStatus: vi.fn<typeof apiModule.api.getWorkspaceGitStatus>(),
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
vi.mock("../../../../stores/auth", () => ({ useAuthStore: () => authStub }));
vi.mock("vue-sonner", () => ({ toast: toastStub }));
vi.mock("../../../../composables/api", (importOriginal) => ({
    ...(importOriginal as Record<string, unknown>),
    api: apiStub,
    ApiError: class extends Error {},
}));

const mockedApi = vi.mocked(api, true);

beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    sessionStorage.clear();
    mockedApi.getWorkspaceGitStatus.mockResolvedValue({
        isRepository: true,
        entries: [
            { status: " M", path: "README.md" },
            { status: "??", path: "new.txt" },
        ],
    });
});

describe("task-36 文件树面板 git 读面", () => {
    it("脏文件数与摘要直接出现在树面板，HEAD 不伪造数字", async () => {
        const wrapper = mount(FileTreePanel, {
            global: { plugins: [i18n], stubs: { FileTree: true } },
        });
        await flushPromises();

        expect(mockedApi.getWorkspaceGitStatus).toHaveBeenCalledWith("workspace-a");
        expect(wrapper.find('[data-testid="workspace-git-readface"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="workspace-git-readface-count"]').text()).toContain("2");
        const entries = wrapper.find('[data-testid="workspace-git-readface-entries"]').text();
        expect(entries).toContain("README.md");
        expect(entries).toContain("new.txt");
        const head = wrapper.find('[data-testid="workspace-git-readface-head-hint"]').text();
        expect(head).toContain("HEAD");
        expect(head).toContain("checkpoint timeline");
        expect(head).not.toMatch(/[0-9a-f]{7,40}/);
    });

    it("加载失败只显示本地化文案，不直显英文 detail", async () => {
        mockedApi.getWorkspaceGitStatus.mockRejectedValue(new Error("API error 503"));
        const wrapper = mount(FileTreePanel, {
            global: { plugins: [i18n], stubs: { FileTree: true } },
        });
        await flushPromises();

        const error = wrapper.get('[data-testid="workspace-git-readface-error"]');
        expect(error.text()).not.toContain("API error");
        expect(error.text()).toBe(i18n.global.t("workspace.gitReadfaceLoadFailed"));
    });
});
