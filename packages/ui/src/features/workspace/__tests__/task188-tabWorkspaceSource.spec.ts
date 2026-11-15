import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

/**
 * `task-188`（A→B 切换后 2 条请求仍带 A 头）—— **上下文来源**判据。
 *
 * 唯一入口是 `lib/workspaceContext.ts#readTabWorkspaceId()`：路由在导航**之前**写入
 * （`router/index.ts:619-622`，原注释「Set the tab workspace before child components issue their
 * first request」）⇒ 切到 B 那一拍它已是 B；而 `auth.currentWorkspaceId` 要等 `/auth/me` 回来才变。
 *
 * 本文件钉 store 侧（文件树 → `list_directory` → `POST /mcp` 那条 A 头的上游）：
 * ① 逐 tab 上下文与登录态不同时，树请求用**逐 tab**；
 * ② 逐 tab 为空时回落登录态（不许因为改这个把空上下文变成「静默不发」）；
 * ③ 两者都空 ⇒ **一个请求都不发**（`loadTree` 早退），不许静默发 ws-less 请求。
 */

const AUTH_WS = "11111111-1111-4111-8111-aaaaaaaaaaaa";
const TAB_WS = "22222222-2222-4222-8222-bbbbbbbbbbbb";

const { apiStub, authStub, sessionStub } = vi.hoisted(() => ({
    apiStub: {
        listDirectory: vi.fn<
            (path: string, workspaceId: string, rootId?: string) => Promise<unknown>
        >(async () => ({ entries: [] })),
    },
    authStub: {
        currentWorkspaceId: "11111111-1111-4111-8111-aaaaaaaaaaaa" as string | null,
        canWriteWorkspace: true,
        workspace: { name: "ws" },
        refreshWorkspace: vi.fn<() => Promise<void>>(async () => {}),
    },
    sessionStub: {
        currentSessionId: null,
        currentSessionAttachments: [] as unknown[],
        currentSessionFileContext: null,
        currentAgentIds: [] as string[],
    },
}));

vi.mock("../../../stores/auth", () => ({ useAuthStore: () => authStub }));
vi.mock("../../../stores/session", () => ({ useSessionStore: () => sessionStub }));
vi.mock("../../../composables/api", () => ({
    api: apiStub,
    apiPost: vi.fn<() => Promise<unknown>>(async () => ({})),
    // **不继承 `Error`**：`unicorn(custom-error-definition)` 会把结算成 warning，
    // 而 warnings 基线只许变小（今天已为这条驳回过一次 `--write-baseline`）。
    // store 只用到 `new ApiError({...})` + `throw` + 读 `.code`，结构够用。
    ApiError: class ApiError {
        readonly status: number;
        readonly code: string;
        readonly detail: string;
        constructor(init: { status: number; code: string; detail?: string; requestId?: string }) {
            this.status = init.status;
            this.code = init.code;
            this.detail = init.detail ?? init.code;
        }
    },
}));
vi.mock("../composables/fileService", () => ({
    readFilePreview: vi.fn<() => Promise<null>>(async () => null),
}));

const { useWorkspaceStore } = await import("../stores/workspace");
const { writeTabWorkspace, clearTabWorkspace, readTabWorkspaceId, tabWorkspaceRevisionRef } =
    await import("../../../lib/workspaceContext");
const { computed } = await import("vue");
const { flushPromises } = await import("@vue/test-utils");

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setActivePinia(createPinia());
    authStub.currentWorkspaceId = AUTH_WS;
    clearTabWorkspace();
});

describe("task-188 工作区上下文来源（store 侧）", () => {
    it("① 逐 tab 上下文与登录态不同 ⇒ 树请求用逐 tab（不是滞后的 auth）", async () => {
        writeTabWorkspace({ id: TAB_WS });
        const store = useWorkspaceStore();
        await store.loadTree();
        expect(apiStub.listDirectory).toHaveBeenCalledTimes(1);
        expect(apiStub.listDirectory.mock.calls[0]![1]).toBe(TAB_WS);
    });

    it("② 逐 tab 为空 ⇒ 回落登录态（修来源不是把空上下文变成不发请求）", async () => {
        const store = useWorkspaceStore();
        await store.loadTree();
        expect(apiStub.listDirectory).toHaveBeenCalledTimes(1);
        expect(apiStub.listDirectory.mock.calls[0]![1]).toBe(AUTH_WS);
    });

    it("③ 两个上下文都空 ⇒ 一个请求都不发（不许静默发 ws-less 请求）", async () => {
        authStub.currentWorkspaceId = null;
        const store = useWorkspaceStore();
        await store.loadTree();
        expect(apiStub.listDirectory).not.toHaveBeenCalled();
    });

    // D-1565：这两条钉的是「computed 会不会随 ctx 变化重算」。
    // 上面的 ①②③ 都是「先写 ctx、再首次求值」⇒ 即使 computed 不响应式也会绿（假绿），
    // 所以这里必须显式覆盖「先求值成 A，再写 B」这一顺序。
    it("④ 先求值成 A，再写 ctx=B ⇒ 之后的请求全部是 B（不是缓存的 A）", async () => {
        const store = useWorkspaceStore();
        await store.loadTree();
        expect(apiStub.listDirectory.mock.calls[0]![1]).toBe(AUTH_WS);
        const before = apiStub.listDirectory.mock.calls.length;
        writeTabWorkspace({ id: TAB_WS });
        await store.loadTree();
        // 计数器让 watch(workspaceId) 也重入一次（缺陷修好后它才会触发）⇒ 不钉次数，
        // 钉「写 ctx 之后的每一条都必须是 B」，否则这条用例会被合法的重入次数变化打红。
        await flushPromises();
        const after = apiStub.listDirectory.mock.calls.slice(before);
        expect(after.length, "写 ctx 后必须至少再有一条树请求").toBeGreaterThan(0);
        for (const call of after) expect(call[1]).toBe(TAB_WS);
    });

    it("⑤ 写 ctx 后依赖它的 computed 立即失效（不靠任何副作用顺序）", () => {
        writeTabWorkspace({ id: AUTH_WS });
        const seen = computed(() => {
            void tabWorkspaceRevisionRef().value;
            return readTabWorkspaceId();
        });
        expect(seen.value).toBe(AUTH_WS);
        writeTabWorkspace({ id: TAB_WS });
        expect(seen.value).toBe(TAB_WS);
        clearTabWorkspace();
        expect(seen.value).toBeNull();
    });
});
