import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, nextTick } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import FileTreePanel from "../components/FileTreePanel.vue";
import { i18n } from "../../../i18n";

/**
 * task-945（收口 task-939 的遗留）—— 本文件原来钉的是 PLAN-0641 的**卡片 IA**：面板顶部一个
 * `nested-repos-panel` 块，里面逐行渲染路径 + 类型 + 「Declare as root」。task-939 / R76 把
 * 声明改成**树行内的一次性动作**之后，卡片块、行、`nestedReposTitle` 全部退场，这里的 5 条用例
 * 因此红在「找不到 `nested-repo-row`」（实跑读数：10 例 5 红，见
 * `internal/A03-xihe/evidence/2026-11-24-filetree-carryover/README.md`）。
 *
 * <p>重写口径：**判据留在面板这一侧的那些事**——面板把发现列表**原样**（整条工作区相对路径 +
 * 类型 + 未声明过滤）下传给树、把「能不能申报」的两个来源（V9 门属性 × 写权限）合成后下传、
 * 以及申报失败时把 CP 的 problem code 映射成本地化文案。行内两步确认、徽标、置灰本身**不在这里
 * 重钉**，宿主见下。</p>
 *
 * <p>退场判据的去向（删除不等于丢判据；逐条写明承接者）：</p>
 * <ul>
 *   <li>「只有 nested / gitdir 可申报，子模块/符号链接/裸库只留徽标不给入口」(T4.4)
 *       ⇒ 已由 `components/__tests__/TreeNodeListRow.spec.ts`
 *       「不可申报的类型（子模块/符号链接/裸库）只留徽标，不给入口」承接；</li>
 *   <li>「第一次点击只展开确认、确认后才 POST，成功后刷新树/发现/工作区视图」(B1)
 *       ⇒ 已由 `components/__tests__/FileTreePanelNestedRepo.spec.ts`
 *       「行内确认后的路径走既有 root CRUD，并刷新树/发现/工作区视图」承接；</li>
 *   <li>「没有未声明项时整块隐藏」⇒ 新语义是「行内不出现任何控件」，已由
 *       `TreeNodeListRow.spec.ts`「没有发现项时树照常渲染，行内不出现任何声明控件」承接；
 *       本文件把它改写成**数据面**判据（面板不下传未声明项），因为「块消失」在新 IA 下恒真，
 *       留原断言就是假绿。</li>
 * </ul>
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
        primaryRootId: null as string | null,
        primaryRootPath: null as string | null,
        activeFilePath: null as string | null,
        activeDirPath: null as string | null,
        expandedPaths: new Set<string>(),
        errorScope: null as string | null,
        fileOpError: null as unknown,
        treeError: null as string | null,
        treeErrorKind: null as string | null,
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
        listWorkspaceNestedRepos: vi.fn<() => Promise<NestedRepo[]>>(),
        addWorkspaceRoot: vi.fn<(wsId: string, input: { path: string }) => Promise<RootRow>>(),
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
// 真语言包，不再自带副本（task-945）：本文件原来复制了一整份 en 文案，`check:i18n-fixture-copies`
// 把这类副本判为「改源仍绿」的真坑（(a) 档）。断言一律走 `i18n.global.t(...)`，语言包缺键即红。
vi.mock("../../../composables/api", (importOriginal) => ({
    ...(importOriginal as Record<string, unknown>),
    api: apiStub,
    ApiError: class extends Error {},
}));

function mountPanel(props: Record<string, unknown> = {}) {
    return mount(FileTreePanel, {
        props,
        global: { plugins: [i18n], stubs: { FileTree: FileTreeStub } },
    });
}

/** 树本体（stub）—— 读它收到的 props，或从它发出 `declare-nested-repo`。 */
function treeOf(wrapper: ReturnType<typeof mountPanel>): ReturnType<typeof mountPanel> {
    return wrapper.findComponent(FileTreeStub);
}

/**
 * 替身树：本文件只判**面板侧**（下传什么、POST 什么），行内徽标/入口/置灰归
 * `components/__tests__/TreeNodeListRow.spec.ts`。props 与真 `FileTree.vue` 的入参同名同形，
 * 否则「下传」判据会在替身上失真。
 */
const FileTreeStub = defineComponent({
    name: "FileTree",
    props: {
        nodes: { type: Array, default: undefined },
        rootId: { type: String, default: undefined },
        searchQuery: { type: String, default: "" },
        nestedRepos: { type: Array, default: () => [] },
        nestedRepoCanDeclare: { type: Boolean, default: false },
        nestedRepoDeclaring: { type: Boolean, default: false },
    },
    emits: ["declare-nested-repo"],
    template: "<div />",
});

const REPOS: NestedRepo[] = [
    { path: "vendor/lib", type: "nested", declared: false },
    { path: "deep/tools/helper", type: "submodule", declared: false },
];

beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    sessionStorage.clear();
    wsStub.workspaceRoots = [];
    authStub.canWriteWorkspace = true;
    apiStub.listWorkspaceNestedRepos.mockResolvedValue([...REPOS]);
    apiStub.addWorkspaceRoot.mockResolvedValue({ id: "root-1", alias: null, position: 1 });
});

describe("task-188 nested-repos 的工作区上下文来源", () => {
    it("逐 tab 上下文优先于滞后的 auth.currentWorkspaceId（A→B 后不许再带 A）", async () => {
        sessionStorage.setItem(
            "xihe-workspace",
            JSON.stringify({ id: "22222222-2222-4222-8222-bbbbbbbbbbbb" }),
        );
        authStub.currentWorkspaceId = "11111111-1111-4111-8111-aaaaaaaaaaaa";
        mountPanel();
        await flushPromises();
        expect(apiStub.listWorkspaceNestedRepos).toHaveBeenCalledTimes(1);
        expect(apiStub.listWorkspaceNestedRepos.mock.calls[0]![0]).toBe(
            "22222222-2222-4222-8222-bbbbbbbbbbbb",
        );
    });

    it("逐 tab 为空 ⇒ 回落 auth（修来源不是把空上下文变成不发请求）", async () => {
        authStub.currentWorkspaceId = "workspace-a";
        mountPanel();
        await flushPromises();
        expect(apiStub.listWorkspaceNestedRepos).toHaveBeenCalledTimes(1);
        expect(apiStub.listWorkspaceNestedRepos.mock.calls[0]![0]).toBe("workspace-a");
    });
});

describe("nested repos panel（新 IA：面板下传 + root CRUD，卡片 IA 已退场）", () => {
    /**
     * 原「renders the whole path (B12) with a type label」的承接：卡片行退场后，面板这一侧仍然
     * 要保证**身份是整条工作区相对路径**（B12）—— 它现在体现为下传给树行的数据。行内徽标/入口
     * 的渲染判据在 `TreeNodeListRow.spec.ts`。
     */
    it("把未声明项原样下传给树行：整条相对路径 + 类型都在（B12）", async () => {
        wsStub.fileTree = [{ name: "README.md", path: "README.md", type: "file", size: 1 }];
        const wrapper = mountPanel();
        await flushPromises();

        expect(apiStub.listWorkspaceNestedRepos).toHaveBeenCalledWith("workspace-a");
        expect(treeOf(wrapper).props("nestedRepos")).toEqual([
            { path: "vendor/lib", type: "nested", declared: false },
            { path: "deep/tools/helper", type: "submodule", declared: false },
        ]);
    });

    /**
     * 原「hides the section when nothing undeclared remains」在新 IA 下**恒真**（那块 DOM 已经
     * 不存在了），照抄就是假绿 ⇒ 改成数据面判据：已声明项不得下传。
     */
    it("已声明的下传值为空（原「整块隐藏」在新 IA 下恒真，改钉数据面）", async () => {
        wsStub.fileTree = [{ name: "README.md", path: "README.md", type: "file", size: 1 }];
        apiStub.listWorkspaceNestedRepos.mockResolvedValue([
            { path: "vendor/lib", type: "nested", declared: true },
        ]);
        const wrapper = mountPanel();
        await flushPromises();

        expect(treeOf(wrapper).props("nestedRepos")).toEqual([]);
    });

    it("面板不按类型过滤（可申报性是行内判据，T4.4 由 TreeNodeListRow.spec.ts 承接）", async () => {
        wsStub.fileTree = [{ name: "README.md", path: "README.md", type: "file", size: 1 }];
        apiStub.listWorkspaceNestedRepos.mockResolvedValue([
            { path: "vendor/lib", type: "nested", declared: false },
            { path: "linked-wt", type: "gitdir", declared: false },
            { path: "deep/tools/helper", type: "submodule", declared: false },
            { path: "linked", type: "symlink", declared: false },
            { path: "mirror", type: "bare", declared: false },
        ]);
        const wrapper = mountPanel();
        await flushPromises();

        // 面板若“顺手”按类型筛掉 submodule/symlink/bare，行内就再也渲染不出类型徽标（用户看不到
        // 为什么没有入口）。下传必须保持五项完整。
        expect(treeOf(wrapper).props("nestedRepos")).toHaveLength(5);
    });

    /**
     * 原「keeps the greying path」的承接：置灰发生在行内，但**置灰的依据是面板合成的两个来源**
     * （V9 门属性 × 写权限）。这里钉合成，行内 disabled 的渲染归 `TreeNodeListRow.spec.ts`。
     */
    it("可申报性 = V9 门属性 且 写权限（两个来源任一关闭即下传 false）", async () => {
        wsStub.fileTree = [{ name: "README.md", path: "README.md", type: "file", size: 1 }];

        const bothOpen = mountPanel();
        await flushPromises();
        expect(treeOf(bothOpen).props("nestedRepoCanDeclare")).toBe(true);

        const gateClosed = mountPanel({ nestedRepoDeclareEnabled: false });
        await flushPromises();
        expect(treeOf(gateClosed).props("nestedRepoCanDeclare")).toBe(false);

        authStub.canWriteWorkspace = false;
        const viewer = mountPanel();
        await flushPromises();
        expect(treeOf(viewer).props("nestedRepoCanDeclare")).toBe(false);
        authStub.canWriteWorkspace = true;
    });

    /**
     * 原「only declares after the confirm step, then refreshes discovery (B1)」的承接：两步确认
     * 的**第一步**归 `TreeNodeListRow.spec.ts`（点击只展开确认、不 emit）；本卡 `FileTreePanel`
     * 已无 git 状态取数通道，面板侧要钉的是「emit 上来的路径 → POST → 三路刷新」。
     */
    it("行内确认后 POST 该路径，并刷新树 / 重新发现 / 工作区视图（B1 + T3.1）", async () => {
        wsStub.fileTree = [{ name: "README.md", path: "README.md", type: "file", size: 1 }];
        const wrapper = mountPanel();
        await flushPromises();
        expect(apiStub.addWorkspaceRoot).not.toHaveBeenCalled();

        // 发现列表清空 ⇒ 下传集必须跟着变空（成功路径靠重新发现把行内入口收起）。
        apiStub.listWorkspaceNestedRepos.mockResolvedValue([]);
        treeOf(wrapper).vm.$emit("declare-nested-repo", "vendor/lib");
        await flushPromises();
        await nextTick();

        expect(apiStub.addWorkspaceRoot).toHaveBeenCalledWith("workspace-a", {
            path: "vendor/lib",
        });
        expect(wsStub.refreshTree).toHaveBeenCalled();
        expect(authStub.refreshWorkspace).toHaveBeenCalled();
        expect(apiStub.listWorkspaceNestedRepos).toHaveBeenCalledTimes(2);
        expect(treeOf(wrapper).props("nestedRepos")).toEqual([]);
        expect(toastStub.success).toHaveBeenCalledWith(
            i18n.global.t("workspace.nestedRepoDeclared"),
        );
    });

    it("发现列表里没有/已声明的路径一律不 POST（行内确认态可能已经过期）", async () => {
        wsStub.fileTree = [{ name: "README.md", path: "README.md", type: "file", size: 1 }];
        const wrapper = mountPanel();
        await flushPromises();

        // ① 发现列表里根本没有这条路径（目录改名/树已变）。
        treeOf(wrapper).vm.$emit("declare-nested-repo", "vendor/renamed");
        await flushPromises();
        expect(apiStub.addWorkspaceRoot).not.toHaveBeenCalled();

        // ② 路径还在但已被声明（别处点过 / 发现缓存已更新）⇒ 同样不该再打 root CRUD。
        apiStub.listWorkspaceNestedRepos.mockResolvedValue([{ ...REPOS[0]!, declared: true }]);
        const second = mountPanel();
        await flushPromises();
        expect(treeOf(second).props("nestedRepos")).toEqual([]);
        treeOf(second).vm.$emit("declare-nested-repo", "vendor/lib");
        await flushPromises();

        expect(apiStub.addWorkspaceRoot).not.toHaveBeenCalled();
        expect(toastStub.success).not.toHaveBeenCalled();
    });

    it("在途申报未结束前重复 emit 不再 POST（防重复提交）", async () => {
        wsStub.fileTree = [{ name: "README.md", path: "README.md", type: "file", size: 1 }];
        let release: (value: RootRow) => void = () => {};
        apiStub.addWorkspaceRoot.mockReturnValue(
            new Promise<RootRow>((resolve) => {
                release = resolve;
            }),
        );
        const wrapper = mountPanel();
        await flushPromises();

        const tree = treeOf(wrapper);
        tree.vm.$emit("declare-nested-repo", "vendor/lib");
        await nextTick();
        expect(tree.props("nestedRepoDeclaring")).toBe(true);
        tree.vm.$emit("declare-nested-repo", "vendor/lib");
        expect(apiStub.addWorkspaceRoot).toHaveBeenCalledTimes(1);

        release({ id: "root-1", alias: null, position: 1 });
        await flushPromises();
        await nextTick();
        expect(tree.props("nestedRepoDeclaring")).toBe(false);
    });

    /**
     * 原「maps the problem code to a localized declaration error (T3.1)」的扩展：改前只钉一个码，
     * 且钉的是**副本文案**（改源仍绿）。现在按真语言包钉全表，未知码必须回落到通用文案。
     */
    it("每条 problem code 映射本地化文案，未知码回落通用文案；CP 原文不外泄", async () => {
        wsStub.fileTree = [{ name: "README.md", path: "README.md", type: "file", size: 1 }];
        const cases: [string, string][] = [
            ["ROOT_IN_USE", "workspace.nestedRepoDeclareErrorRootInUse"],
            ["ROOT_PATH_CONFLICT", "workspace.nestedRepoDeclareErrorConflict"],
            ["INVALID_ROOT_OVERLAP", "workspace.nestedRepoDeclareErrorOverlap"],
            ["SOMETHING_NEW", "workspace.nestedRepoDeclareFailed"],
        ];
        for (const [code, key] of cases) {
            apiStub.addWorkspaceRoot.mockRejectedValue({
                problem: { code, detail: `raw cp detail for ${code}` },
            });
            const wrapper = mountPanel();
            await flushPromises();
            treeOf(wrapper).vm.$emit("declare-nested-repo", "vendor/lib");
            await flushPromises();
            await nextTick();

            expect(toastStub.error).toHaveBeenCalledWith(i18n.global.t(key));
            expect(toastStub.error).not.toHaveBeenCalledWith(`raw cp detail for ${code}`);
            // 失败后必须松开在途标志，否则行内入口会永久置灰（重试契约）。
            expect(treeOf(wrapper).props("nestedRepoDeclaring")).toBe(false);
            vi.clearAllMocks();
            apiStub.listWorkspaceNestedRepos.mockResolvedValue([...REPOS]);
        }
    });

    it("发现失败不许影响文件树：下传空集、树照常、也不出现卡片 IA 的任何残留", async () => {
        wsStub.fileTree = [{ name: "README.md", path: "README.md", type: "file", size: 1 }];
        apiStub.listWorkspaceNestedRepos.mockRejectedValue(new Error("probe unavailable"));
        const wrapper = mountPanel();
        await flushPromises();

        expect(treeOf(wrapper).props("nestedRepos")).toEqual([]);
        // 退场的 DOM 不许回潮（真树侧的同一判据在 FileTreePanelNestedRepo.spec.ts）。
        expect(wrapper.find('[data-testid="nested-repos-panel"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="nested-repo-row"]').exists()).toBe(false);
    });

    it("「纳入快照」是行内动作的文案，不得写成旧的「声明为根」", async () => {
        const declare = i18n.global.t("workspace.nestedRepoDeclare");
        expect(declare).toBe("纳入快照");
        expect(declare).not.toContain("声明为根");
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
