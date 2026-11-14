import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

/**
 * task-498：深链进工作区后文件树永久为空。
 *
 * 红态机制（infra-1 实测 [LT-ENTER] wsId=null loading=false loaded=null + MCP 0 次调用）：
 * FileTreePanel 的 onMounted 在 auth.workspace 还没 hydrate 时就调 loadTree，
 * `workspaceId` 为 null ⇒ 命中 loadTree 的 `if (!currentWorkspaceId) return;`；
 * 随后 auth.workspace 到位，但**没有任何 watcher 重入 loadTree** ⇒ 树永远空。
 *
 * 本 spec 用真实 store（不 stub）复现该时序，判据四组：
 *  1 多根深链：hydrate 前 0 次请求 + 空树；hydrate 后必须自己发起 1 次并渲染（红→绿）
 *  2 单根深链（Lead 判据三）：同样的时序，证明缺陷与根数无关
 *  3 负向对照（判据四）：workspace 在调用前就绪时必须照常加载 1 次
 *  4 无重复请求（判据五）：hydrate 之后重复调用 loadTree 不得再发请求（给次数读数，不 sleep）
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

const apiState = vi.hoisted(() => ({
    listDirectory: vi.fn<
        () => Promise<{
            entries: Array<{ name: string; type: string; size: number; modified: string }>;
        }>
    >(async () => ({
        entries: [{ name: "README.md", type: "file", size: 3, modified: "2026-11-14T00:00:00Z" }],
    })),
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

import { useWorkspaceStore } from "../stores/workspace";

type MultiRoot = { id: string; alias: string | null; position: number };

function workspace(id: string, roots: MultiRoot[]) {
    return { id, name: "ws", roots };
}

beforeEach(() => {
    setActivePinia(createPinia());
    (refs.workspace as { value: unknown }).value = null;
    apiState.listDirectory.mockClear();
});

describe("task-498 深链文件树：auth hydrate 晚于挂载时必须自我重入", () => {
    it("多根深链：hydrate 前不发请求，hydrate 后自动加载一次并渲染", async () => {
        const ws = useWorkspaceStore();
        // 触发点 A（FileTreePanel.onMounted）此刻 auth.workspace 还没到
        void ws.loadTree();
        await flushPromises();
        expect(
            apiState.listDirectory,
            "hydrate 前不该发请求（没有 workspaceId，requireWorkspaceId 会抛）",
        ).toHaveBeenCalledTimes(0);
        expect(ws.fileTree, "此时树必须是空的（这就是用户看到的现象）").toHaveLength(0);

        // GET /workspaces/{id} 返回
        (refs.workspace as { value: unknown }).value = workspace("ws-a", [
            { id: "ws-a", alias: "alpha", position: 0 },
            { id: "root-2", alias: "beta", position: 1 },
        ]);
        await flushPromises();

        expect(
            apiState.listDirectory,
            "auth hydrate 之后必须自己重入 loadTree（修法要点）",
        ).toHaveBeenCalledTimes(1);
        expect(ws.fileTree.map((n) => n.name)).toEqual(["README.md"]);
    });

    it("单根深链：同一时序同病（证明与多根无关）", async () => {
        const ws = useWorkspaceStore();
        void ws.loadTree();
        await flushPromises();
        expect(apiState.listDirectory).toHaveBeenCalledTimes(0);

        (refs.workspace as { value: unknown }).value = workspace("ws-b", [
            { id: "ws-b", alias: null, position: 0 },
        ]);
        await flushPromises();

        expect(apiState.listDirectory, "单根工作区同样要重生").toHaveBeenCalledTimes(1);
        expect(ws.fileTree).toHaveLength(1);
    });

    it("负向对照：workspace 就绪时调用必须照常加载", async () => {
        (refs.workspace as { value: unknown }).value = workspace("ws-c", [
            { id: "ws-c", alias: null, position: 0 },
        ]);
        const ws = useWorkspaceStore();
        await ws.loadTree();
        await flushPromises();

        expect(apiState.listDirectory).toHaveBeenCalledTimes(1);
        expect(ws.fileTree).toHaveLength(1);
    });

    it("无重复请求：hydrate 之后再次调用 loadTree 不得重复发请求", async () => {
        const ws = useWorkspaceStore();
        void ws.loadTree();
        await flushPromises();

        (refs.workspace as { value: unknown }).value = workspace("ws-d", [
            { id: "ws-d", alias: null, position: 0 },
        ]);
        await flushPromises();
        expect(apiState.listDirectory, "hydrate 触发的那一次").toHaveBeenCalledTimes(1);

        // 两个触发点（面板 onMounted 已返回、Workbench watch 亦可能补一次）都调它
        await ws.loadTree();
        await ws.loadTree();
        await flushPromises();
        expect(
            apiState.listDirectory,
            "已加载同一 workspaceId ⇒ loadTree 的 loadedWorkspaceId 守卫必须拦住",
        ).toHaveBeenCalledTimes(1);
    });
    it("同一 tick 内连跳两次身份：只按最终身份发一次请求（代次合并，不替旧身份加载）", async () => {
        const ws = useWorkspaceStore();
        void ws.loadTree();
        await flushPromises();
        expect(apiState.listDirectory).toHaveBeenCalledTimes(0);

        // Vue 会把同一 tick 的两次赋值合并成一次 watcher 触发 ⇒ 只剩最终身份
        (refs.workspace as { value: unknown }).value = workspace("ws-hop-a", [
            { id: "ws-hop-a", alias: null, position: 0 },
        ]);
        (refs.workspace as { value: unknown }).value = workspace("ws-hop-b", [
            { id: "ws-hop-b", alias: null, position: 0 },
        ]);
        await flushPromises();

        expect(apiState.listDirectory, "只发一次").toHaveBeenCalledTimes(1);
        expect(
            apiState.listDirectory.mock.calls[0][1],
            "发的是最终身份，不是被跳过的中间身份",
        ).toBe("ws-hop-b");
    });
});
