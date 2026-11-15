import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useWorkspaceStore } from "../stores/workspace";

/**
 * task-532：首载双载（同一份树被拉两轮）。
 *
 * 机制（task-531 / runtime-1 已经钉死，本 spec 只做**可复算的判定**）：
 * `loadTree` 入口把「排队的调用」记进 `loadTreePending`，但 finally 里的排空循环
 * **只判 targetId、不判 loadedWorkspaceId** ⇒ 首载期间来第二次调用（面板 onMounted +
 * Workbench watch 两个触发点），第二轮必然整轮重跑。
 *
 * 判据（与卡面 A/B/C 对应，时间类读数交给浏览器，这里钉**次数**这一条确定性的）：
 *  1 首载只许一轮：`listDirectory` 调用次数 == distinct path 数（夹具 7 path）
 *  2 负向对照：切工作区时排空**仍要**为新 id 真拉一次（跳过条件只对「已加载的同 id」生效）
 *  3 同 id 重复调用（加载完成后）依旧 0 次新请求
 */

const refs = vi.hoisted(() => ({ workspace: null as unknown as { value: unknown } }));

vi.mock("../../../stores/auth", async () => {
    const { ref } = await import("vue");
    const workspace = ref<unknown>(null);
    (refs as { workspace: unknown }).workspace = workspace;
    const base = {
        get workspace() {
            return workspace.value;
        },
        get currentWorkspaceId() {
            return (workspace.value as { id?: string } | null)?.id ?? null;
        },
        get canWriteWorkspace() {
            return true;
        },
        refreshWorkspace: async () => {},
    };
    return {
        useAuthStore: () =>
            new Proxy(base, { get: (t, k) => (k in t ? (t as never)[k] : undefined) }),
    };
});

vi.mock("../../../stores/session", () => ({
    useSessionStore: () => new Proxy({}, { get: () => undefined }),
}));

type Entry = { name: string; type: "file" | "directory"; size: number; modified: string };
const calledPaths = vi.hoisted(() => [] as string[]);

/**
 * 夹具规模：**7 个 path**（"", d1..d6）。卡面要求写明规模 —— 2–3 path 的夹具与 7 path
 * 的读数在耗时上差数倍，不写明就不可比（D-1419 ③）。
 */
const apiState = vi.hoisted(() => ({
    listDirectory: vi.fn<(path: string) => Promise<{ entries: Entry[] }>>(),
}));

vi.mock("../../../composables/api", () => ({
    api: new Proxy(
        { listDirectory: apiState.listDirectory },
        { get: (t, k) => (k in t ? (t as never)[k] : undefined) },
    ),
    apiPost: vi.fn<() => Promise<Record<string, unknown>>>(async () => ({})),
    ApiError: class ApiError extends Error {
        problem: { code: string } | null = null;
        constructor(input: { code?: string } = {}) {
            super(input.code ?? "ERR");
            this.problem = input.code ? { code: input.code } : null;
        }
    },
}));

vi.mock("../composables/fileService", () => ({
    readFilePreview: vi.fn<() => Promise<string>>(async () => ""),
}));

function entry(name: string, type: "file" | "directory"): Entry {
    return { name, type, size: 1, modified: "2026-11-14T00:00:00Z" };
}

/** 根返回 6 个目录 + 1 个文件 ⇒ distinct path = root + 6 目录 = 7。 */
function installSevenPathFixture() {
    apiState.listDirectory.mockImplementation(async (path: string) => {
        calledPaths.push(path);
        if (path === "") {
            return {
                entries: [
                    ...Array.from({ length: 6 }, (_, i) => entry(`d${i + 1}`, "directory")),
                    entry("README.md", "file"),
                ],
            };
        }
        return { entries: [] };
    });
}

function setWorkspace(id: string) {
    (refs.workspace as { value: unknown }).value = { id, name: id, roots: [] };
}

beforeEach(() => {
    setActivePinia(createPinia());
    calledPaths.length = 0;
    apiState.listDirectory.mockReset();
    installSevenPathFixture();
});

describe("task-532 首载双载：排空循环必须判「已加载同 id」", () => {
    it("C: 首载只许一轮 —— listDirectory 次数 == path 数（7）", async () => {
        setWorkspace("ws-1");
        const ws = useWorkspaceStore();
        // 两个触发点：面板 onMounted 与 Workbench 的 workspaceId watch 在同一帧先后调用。
        void ws.loadTree();
        void ws.loadTree();
        await flushPromises();
        await flushPromises();

        const distinct = new Set(calledPaths);
        expect(distinct.size, "夹具必须是 7 个 path（否则读数不可比）").toBe(7);
        expect(
            calledPaths.length,
            `首载把同一份树拉了两轮：${calledPaths.length} 次，应为 7 次（7 path × 1 轮）`,
        ).toBe(distinct.size);
        // ③ 行数与最终值：次数从 14 压到 7 也可能是「少加载了一轮」，次数判据本身看不出来
        // ⇒ 同一份断言里另给**内容**读数（节点数 + 名字逐项 + 子目录都挂上）。
        expect(ws.fileTree.map((n) => n.name).sort(), "树的最终内容必须完整（7 个根节点）").toEqual(
            [...Array.from({ length: 6 }, (_, i) => `d${i + 1}`), "README.md"].sort(),
        );
        expect(
            ws.fileTree
                .filter((n) => n.type === "directory")
                .every((n) => Array.isArray(n.children)),
            "每个目录都要挂上 children（子目录那 6 次 list_directory 的结果必须落地）",
        ).toBe(true);
    });

    it("负向对照：切工作区时排空仍为 **新 id** 真拉一次（跳过只对已加载的同 id 生效）", async () => {
        setWorkspace("ws-1");
        const ws = useWorkspaceStore();
        void ws.loadTree();
        // 第一轮还在飞时切到 ws-2，并再调一次（标准排队场景）
        setWorkspace("ws-2");
        void ws.loadTree();
        await flushPromises();
        await flushPromises();

        // ws-1 一轮 7 次 + ws-2 一轮 7 次 = 14；关键是 ws-2 那一轮**必须发生**
        expect(calledPaths.length, "切工作区必须重新取树，不能因为跳过条件吞掉").toBe(14);
        expect(calledPaths.filter((p) => p === "").length, "根目录每个工作区各拉一次").toBe(2);
        expect(ws.fileTree.length).toBe(7);
    });

    it("同 id 重复调用（加载完成后）不得再发请求", async () => {
        setWorkspace("ws-1");
        const ws = useWorkspaceStore();
        await ws.loadTree();
        const afterFirst = calledPaths.length;
        await ws.loadTree();
        await ws.loadTree();
        expect(calledPaths.length).toBe(afterFirst);
    });
});
