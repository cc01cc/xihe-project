import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useWorkspaceStore } from "../stores/workspace";

/**
 * task-253（由 `task-252` 转入，`D-1629`）：**换仪器** —— 用 store 级单测直接构造
 * 「旧树请求在新树之后 resolve」的 stale 竞态，判定 `workspace.ts` 的两处陈旧丢弃守卫
 * （M1 `:400`、M2 `:431`）到底是不是必要条件。
 *
 * <p>**为什么不用 e2e 判**（`task-252` 实测）：`task585-wsless-header-audit.spec.ts` 的 P1 用例
 * 只看**请求头/参数**，而这两个守卫改变的是「旧树会不会覆盖新树」——覆盖本身不发请求，
 * 所以该仪器**天生看不见**这类副作用（`D-1629②`）；且该用例构造里点击时 A 的树加载早已落地
 * （边界后两次 `mcp list_directory` 都在 +98/+102 ms 且带 B 头），连触发窗口都没有。两条同向，
 * 结论是「不可判」而不是「不必要」。本文件就是把仪器换成能看见覆盖的那一台。</p>
 *
 * <p>**判据（双向）**：守卫在 ⇒ 两例皆绿；把 M1 / M2 任一守卫注释掉 ⇒ 对应用例必须红。
 * 这是「判据能红」的标准形态：不是「我写了断言并且它绿了」，而是「把被保护的行为去掉，断言就崩」。</p>
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
            this.name = "ApiError";
            this.problem = input.code ? { code: input.code } : null;
        }
    },
}));

vi.mock("../composables/fileService", () => ({
    readFilePreview: vi.fn<() => Promise<string>>(async () => ""),
}));

function entry(name: string): Entry {
    return { name, type: "file", size: 1, modified: "2026-11-15T00:00:00Z" };
}

/** 受控 promise：由用例决定「哪一个工作区的树先落地」—— 竞态的**唯一变量**。 */
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

function setWorkspace(id: string) {
    (refs.workspace as { value: unknown }).value = { id, name: id, roots: [] };
}

function treeNames(tree: { name: string }[]): string[] {
    return tree.map((node) => node.name);
}

beforeEach(() => {
    setActivePinia(createPinia());
    apiState.listDirectory.mockReset();
    setWorkspace("ws-A");
});

describe("task-253 M1/M2：旧树请求后到，不得覆盖当前工作区的树", () => {
    it("M1 首载陈旧丢弃：A 的树在切到 B 之后才 resolve ⇒ 不得画出来", async () => {
        const rootA = deferred<{ entries: Entry[] }>();
        const rootB = deferred<{ entries: Entry[] }>();
        apiState.listDirectory
            .mockImplementationOnce(() => rootA.promise)
            .mockImplementationOnce(() => rootB.promise);

        const ws = useWorkspaceStore();
        void ws.loadTree(); // A 的首载在途（rootA 未决）
        await flushPromises();

        setWorkspace("ws-B"); // 切工作区：A 的请求仍在途
        void ws.loadTree(); // loading 中 ⇒ 进排队（loadTreePending += 1）
        await flushPromises();

        rootA.resolve({ entries: [entry("a-only.txt")] }); // 旧结果**后到**
        await flushPromises();

        // 此时 B 的树还没回来：画面上只可能是「空白」或「A 的树」——后者就是本守卫要挡的。
        expect(treeNames(ws.fileTree)).not.toContain("a-only.txt");

        rootB.resolve({ entries: [] });
        await flushPromises();
        expect(treeNames(ws.fileTree)).toEqual([]);
    });

    it("M2 排队重载陈旧丢弃：排空轮里 B 的树在切到 C 之后才 resolve ⇒ 不得画出来", async () => {
        const rootA = deferred<{ entries: Entry[] }>();
        const rootB = deferred<{ entries: Entry[] }>();
        apiState.listDirectory
            .mockImplementationOnce(() => rootA.promise)
            .mockImplementationOnce(() => rootB.promise);

        const ws = useWorkspaceStore();
        void ws.loadTree(); // A 的首载在途
        await flushPromises();

        setWorkspace("ws-B");
        void ws.loadTree(); // 排队等 A 那轮收尾
        await flushPromises();

        rootA.resolve({ entries: [entry("a-only.txt")] }); // M1 守卫丢弃 A 的结果
        await flushPromises(); // finally 排空 ⇒ 发起 B 的请求（rootB 未决）

        setWorkspace("ws-C"); // 排空轮还在途时又切走
        rootB.resolve({ entries: [entry("b-only.txt")] }); // 旧结果后到
        await flushPromises();

        expect(treeNames(ws.fileTree)).not.toContain("b-only.txt");
    });
});
