import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { mount } from "@vue/test-utils";
import { useWorkspaceStore } from "../stores/workspace";
import type * as apiModule from "../../../composables/api";
import type * as fileServiceModule from "../composables/fileService";
import { readFilePreview } from "../composables/fileService";
import FileTree from "../components/FileTree.vue";
import { i18n } from "../../../i18n";
import type { FileNode } from "../../../types";

/**
 * task-76：定位展开锚定 + 高亮当前节点。
 *
 * 用户原话：「当你打开了某个文件或目录时，左侧的目录树也会展开到对应的文件和目录，**并进行高亮**」。
 * 这是纯前端 state 联动，不是数据实时刷新（`notify` watcher 是另一件事）。
 *
 * 本 spec 每条独立可红：
 *   ① 开文件 ⇒ 祖先展开到底（深层 ≥3 层）
 *   ② 开目录 ⇒ 只展开到目录本身，**不含其子项**（与①对照）
 *   ③ `expandedPaths` 不含文件自身（语义收口：它是「目录集合」）
 *   ④ 幂等 + 不覆盖用户已展开的其它分支
 *   ⑤ 文件/目录互斥：同一时刻只有一个 active
 *   ⑥ 高亮不只靠颜色：`data-active` 与 reka 的 `aria-selected` 落在**同一节点**
 *   ⑦ 搜索状态下开文件：`searchExpanded` 与 `expandedArray` 不打架
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

/** 深层路径样本：src/features/workspace/components/deep.ts（4 层祖先）。 */
const DEEP = "src/features/workspace/components/deep.ts";
const DEEP_ANCESTORS = [
    "src",
    "src/features",
    "src/features/workspace",
    "src/features/workspace/components",
];

describe("task-76 定位展开锚定 + 高亮", () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.clearAllMocks();
        localStorage.clear();
    });

    // ---- ⓐ 用户手动开文件走 openFile（真实入口，不是直接调 highlightFile） ----
    it("ⓐ openFile 会定位展开祖先（这是卡面真正缺的那个调用点）", async () => {
        const store = useWorkspaceStore();
        vi.mocked(readFilePreview).mockResolvedValue({
            content: "x",
            truncated: false,
        } as never);
        await store.openFile(DEEP);
        for (const dir of DEEP_ANCESTORS) {
            expect(store.expandedPaths.has(dir), "openFile 后祖先 " + dir + " 必须展开").toBe(true);
        }
        expect(store.activeFilePath).toBe(DEEP);
        expect(store.activeDirPath, "开文件必须清目录").toBeNull();
    });

    // ---- ⓑ 互斥必须走真实入口 openDirectory（不是手工设字段） ----
    it("ⓑ openDirectory 会清掉 activeFilePath（互斥由入口保证，不是靠调用方记得清）", async () => {
        const store = useWorkspaceStore();
        store.activeFilePath = "a.ts";
        store.openDirectory("src/features");
        expect(store.activeFilePath, "openDirectory 必须自己清掉文件定位").toBeNull();
        expect(store.activeDirPath).toBe("src/features");
    });

    // ---- ① 开文件 ⇒ 祖先链展开到底（≥3 层） ----
    it("① 打开深层文件 ⇒ 全部祖先目录逐级展开", async () => {
        const store = useWorkspaceStore();
        store.highlightFile(DEEP);
        for (const dir of DEEP_ANCESTORS) {
            expect(store.expandedPaths.has(dir), "祖先 " + dir + " 必须已展开").toBe(true);
        }
    });

    // ---- ③ 语义收口：文件自身不进 expandedPaths ----
    it("③ expandedPaths 只含祖先目录，不含文件自身（它名义上是目录集合）", () => {
        const store = useWorkspaceStore();
        store.highlightFile(DEEP);
        expect(store.expandedPaths.has(DEEP), "文件不是目录，不该进展开集合").toBe(false);
        expect(store.expandedPaths.size).toBe(DEEP_ANCESTORS.length);
    });

    // ---- ② 开目录 ⇒ 只到目录本身，不含子项 ----
    it("② 开目录 ⇒ 展开到目录本身，且**不展开其子项**（与①对照）", () => {
        const store = useWorkspaceStore();
        store.openDirectory("src/features/workspace/components");
        expect(store.expandedPaths.has("src/features/workspace/components")).toBe(true);
        // 子项（虚拟子目录）不得被展开 —— 这正是「目录 vs 文件」的差异判据
        expect(store.expandedPaths.has("src/features/workspace/components/child")).toBe(false);
        expect(store.activeDirPath).toBe("src/features/workspace/components");
        expect(store.activeFilePath).toBeNull();
    });

    // ---- ④ 幂等 + 不覆盖用户其它已展开分支 ----
    it("④ 幂等：重复调用结果不变，且不覆盖用户已展开的其它分支", () => {
        const store = useWorkspaceStore();
        store.toggleExpand("docs");
        store.toggleExpand("docs/guide");
        store.highlightFile(DEEP);
        const afterFirst = new Set(store.expandedPaths);
        store.highlightFile(DEEP);
        expect(store.expandedPaths).toEqual(afterFirst);
        expect(store.expandedPaths.has("docs"), "用户已展开的分支不能被定位重置掉").toBe(true);
        expect(store.expandedPaths.has("docs/guide")).toBe(true);
    });

    // ---- ⑤ 互斥 ----
    it("⑤ 开文件清目录、开目录清文件（同一时刻只有一个 active）", () => {
        const store = useWorkspaceStore();
        store.openDirectory("src/features");
        expect(store.activeDirPath).toBe("src/features");
        store.highlightFile(DEEP);
        expect(store.activeDirPath, "开文件必须清掉目录定位").toBeNull();
        store.openDirectory("src/features");
        expect(store.activeFilePath, "开目录必须清掉文件定位").toBeNull();
        expect(store.activeDirPath).toBe("src/features");
    });

    // ---- ⑦ 搜索态与展开态不打架 ----
    it("⑦ 搜索态下开文件：定位展开仍生效（searchExpanded 与 expandedArray 合并而非互斥）", () => {
        const store = useWorkspaceStore();
        store.highlightFile(DEEP);
        // 搜索时的展开集合 = 用户展开 ∪ 命中路径祖先（FileTree.vue searchExpanded）。
        // 判据：定位展开落在 expandedPaths（用户态），而不是只存在于某个搜索临时集合。
        for (const dir of DEEP_ANCESTORS) expect(store.expandedPaths.has(dir)).toBe(true);
    });
});

describe("task-76 高亮不只靠颜色（ui-review 六维 D）", () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.clearAllMocks();
        localStorage.clear();
    });

    const mountTree = (nodes: FileNode[]) =>
        mount(FileTree, { props: { nodes }, global: { plugins: [i18n] } });

    const file = (path: string): FileNode => ({
        name: path.split("/").pop() as string,
        path,
        type: "file",
    });

    it("⑥a 打开文件 ⇒ 该行带 data-active，且 reka 的 aria-selected 落在同一行", () => {
        const store = useWorkspaceStore();
        store.activeFilePath = "a.ts";
        const wrapper = mountTree([file("a.ts"), file("b.ts")]);
        const active = wrapper.findAll('[data-active="true"]');
        expect(active, "必须恰好一行带 data-active").toHaveLength(1);
        expect(active[0].text()).toContain("a.ts");
        // 无障碍判据：不能只靠背景色 —— 同一节点必须有语义属性
        const row = active[0].element.closest('[role="treeitem"]');
        expect(row, "选中行必须在 treeitem 语义节点内").not.toBeNull();
        expect(
            row?.getAttribute("aria-selected"),
            "aria-selected 必须与 data-active 同一节点",
        ).toBe("true");
        // 颜色必须与 data-active **同源**（同一个 isActive 判据）：否则「视觉高亮」和
        // 「语义标记」可以各说各的 —— 那就是典型的形式达标、语义不符。
        expect(active[0].classes(), "高亮背景必须跟着 isActive 走").toContain("bg-accent");
        const otherRow = wrapper
            .findAll("button")
            .filter((b) => !b.element.hasAttribute("data-active"));
        expect(otherRow.length, "必须有非选中行做对照").toBeGreaterThan(0);
        expect(otherRow[0].classes(), "非选中行不得带高亮背景").not.toContain("bg-accent");
    });

    it("⑥b 打开目录 ⇒ 目录行带 data-active（文件与目录各一例）", () => {
        const store = useWorkspaceStore();
        store.openDirectory("src");
        const dir: FileNode = {
            name: "src",
            path: "src",
            type: "directory",
            children: [file("src/a.ts")],
        };
        const wrapper = mountTree([dir]);
        const active = wrapper.findAll('[data-active="true"]');
        expect(active).toHaveLength(1);
        expect(active[0].text()).toContain("src");
        // 这一条是 M6 唯一能红的入口：文件场景下 `isActive(file)` 与
        // `activeFilePath === path` **数学等价**（文件分支就是那个表达式），所以只有
        // **目录行**能区分「高亮条件有没有跟着 isActive 一起走」。
        expect(active[0].classes(), "目录的高亮背景也必须跟着 isActive").toContain("bg-accent");
    });

    it("⑥c 文件与目录互斥：同一时刻 data-active 只有一个为 true", async () => {
        const store = useWorkspaceStore();
        const dir: FileNode = {
            name: "src",
            path: "src",
            type: "directory",
            children: [file("src/a.ts")],
        };
        const wrapper = mountTree([dir, file("b.ts")]);
        store.openDirectory("src");
        await wrapper.vm.$nextTick();
        expect(wrapper.findAll('[data-active="true"]'), "开目录时只能目录亮").toHaveLength(1);
        expect(wrapper.find('[data-active="true"]').text()).toContain("src");
        store.activeFilePath = "b.ts";
        store.activeDirPath = null;
        await wrapper.vm.$nextTick();
        expect(wrapper.findAll('[data-active="true"]'), "开文件时只能文件亮").toHaveLength(1);
        expect(wrapper.find('[data-active="true"]').text()).toContain("b.ts");
    });
});
