import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import FileTreePanel from "../FileTreePanel.vue";
import { i18n } from "../../../../i18n";
import { api } from "../../../../composables/api";

/**
 * task-939（R76，用户 2026-11-24 实拍批注）：「文件」页签只留文件树。
 *
 * 这份 spec 原来钉的是 task-36 的结论「树面板自己就有只读仓库状态，不必先打开 dock 的
 * 变更 tab」。R76 判定那条实现把「不必切换面板」误读成「把 git 状态塞进文件面板」：
 * 待提交读数已有权威宿主（dock「变更」面板的「待提交」tab，同一个
 * `GET /workspaces/{id}/git-status`），文件面板因此**既不渲染该块、也不再发这条请求**。
 *
 * 判据分两层，缺一层就是假绿：
 *   ① DOM：`workspace-git-readface*` 全部不存在；
 *   ② 数据面：`getWorkspaceGitStatus` 零调用 —— 只把块 `v-if` 掉、请求照发，②会红。
 */

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
    // 该 GET 在文件面板已无消费者；这里仍给出成功桩，好让「零调用」这条判据
    // 不可能因为请求失败而走别的路径（红点必须落在调用次数上）。
    mockedApi.getWorkspaceGitStatus.mockResolvedValue({
        isRepository: true,
        entries: [
            { status: " M", path: "README.md" },
            { status: "??", path: "new.txt" },
        ],
    });
});

describe("task-939（R76）：文件面板不再镜像仓库状态", () => {
    it("树面板里没有仓库状态块，也不发这条 GET（藏块不算修）", async () => {
        const wrapper = mount(FileTreePanel, {
            global: { plugins: [i18n], stubs: { FileTree: true } },
        });
        await flushPromises();

        for (const testid of [
            "workspace-git-readface",
            "workspace-git-readface-head-hint",
            "workspace-git-readface-count",
            "workspace-git-readface-entries",
            "workspace-git-readface-no-repo",
            "workspace-git-readface-loading",
        ]) {
            expect(wrapper.find(`[data-testid="${testid}"]`).exists(), testid).toBe(false);
        }
        // 数据面判据：读数的消费者只剩 dock「变更」面板一处。
        expect(mockedApi.getWorkspaceGitStatus).not.toHaveBeenCalled();
    });

    it("非 Git 工作区不再在文件页签里报「不是 Git 仓库」", async () => {
        mockedApi.getWorkspaceGitStatus.mockResolvedValue({ isRepository: false, entries: [] });
        const wrapper = mount(FileTreePanel, {
            global: { plugins: [i18n], stubs: { FileTree: true } },
        });
        await flushPromises();

        expect(wrapper.text()).not.toContain("不是 Git 仓库");
        expect(wrapper.find('[data-testid="workspace-git-readface"]').exists()).toBe(false);
    });

    it("面板仍是文件树：树本体照常渲染，git 文案零出现", async () => {
        const wrapper = mount(FileTreePanel, {
            global: { plugins: [i18n] },
        });
        await flushPromises();

        expect(wrapper.find('[data-testid="workspace-tree-head"]').exists()).toBe(true);
        const text = wrapper.text();
        // 改前这两串是面板顶部块的全部文案（zh 默认 locale：仓库状态（待提交）/ HEAD 见变更面板…）
        expect(text).not.toContain("仓库状态");
        expect(text).not.toContain("HEAD");
    });

    /**
     * task-78 的两条诊断面判据（折叠态不渲染码、展开后码可选中；重试复用 composable 的 reload）
     * **不删判据、只换宿主**：待提交读数的权威宿主是 dock「变更」面板，那里已有同一形状的用例
     * （`components/__tests__/WorkspaceChangesPanel.spec.ts` 钉 `errors.technicalDetail` 折叠区与
     * 「空壳不渲染」）。文件面板不再消费这条 GET，就没有这条诊断面可钉。
     */

    /**
     * task-89（触控目标，WCAG 2.2 SC 2.5.8 ≥24×24）：树头四个按钮改前 `p-1` + `size-3.5`
     * ⇒ **19.25×19.25**（3.5px 栅格：3.5 + 12.25 + 3.5；4px 栅格同一组类是 4 + 14 + 4 = 22，
     * 两值都 <24）；四者互相**矩形距 0**、圆心距 **22.75 < 24**（4px 栅格是 22），且都欠尺寸
     * ⇒ Spacing 例外不成立 ⇒ 真缺陷。补 `min-h-7 min-w-7` = 7 × **4px** = **28px** 达标
     * （本仓 `--spacing` = 4；3.5px 时代是 24.5px，旧注释「别按 4 算成 28」已随 D-1842 反转）；
     * 图标仍 `size-3.5`（今天 14px）不放大。
     * jsdom 不求值 Tailwind ⇒ 这里钉类名，真 rect 归 Playwright 复测。
     */
    it("task-89：树头四键命中盒 ≥24×24（min-h-7 min-w-7），图标档位不变", () => {
        const wrapper = mount(FileTreePanel, {
            global: { plugins: [i18n], stubs: { FileTree: true } },
        });

        for (const testid of [
            "workspace-file-create",
            "workspace-file-upload",
            "workspace-file-refresh",
            "workspace-toolbar-toggle-tree",
        ]) {
            const button = wrapper.get(`[data-testid="${testid}"]`);
            expect(button.classes(), testid).toEqual(
                expect.arrayContaining(["min-h-7", "min-w-7", "items-center", "justify-center"]),
            );
            expect(button.get("svg").classes(), testid).toContain("size-3.5");
        }
    });
});
