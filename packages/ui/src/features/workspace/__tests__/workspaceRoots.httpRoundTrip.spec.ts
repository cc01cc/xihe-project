import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
    clearTabWorkspace,
    readTabWorkspaceId,
    writeTabWorkspaceId,
} from "../../../lib/workspaceContext";
import { useAuthStore } from "../../../stores/auth";
import { useWorkspaceStore } from "../stores/workspace";
import { makeWorkspace } from "../../../tests/workspaceFixture";

/**
 * task-44（多根可见性，C 项）—— **经 HTTP 的链路用例**。
 *
 * <p><b>为什么必须新开一份而不是加在 `fileTreeRoots.spec.ts`</b>：那份 spec 直接写
 * `authState.workspace = { roots: [...] }`（`fileTreeRoots.spec.ts:69-75`），**绕过了
 * `normalizeWorkspace` 这一层** ⇒ 即使产品代码把 `roots` 整个丢掉，它也永远绿。实测：
 * `composables/api.ts` 的 `normalizeWorkspace` 直到 task-44 都没有映射 `roots`，于是
 * `authStore.workspace.roots` 恒 undefined ⇒ `isMultiRoot` 恒 false ⇒ 多根分组**不可能渲染**，
 * 而既有用例全绿。这是「测了形状、没测链路」的典型：形状对，链路断。</p>
 *
 * <p><b>本文件的三段链路</b>：`fetch`（桩成 CP 的 `GET /api/v1/workspaces/{id}` 响应）→
 * 真 `api.getWorkspace` → 真 `normalizeWorkspace` → 真 `authStore.hydrateWorkspace` →
 * 真 `workspaceStore` 的 `workspaceRoots` / `isMultiRoot` / `primaryRootId`。</p>
 *
 * <p><b>反假绿判据</b>：把 `normalizeWorkspace` 里 `roots` 那几行删掉，本文件必须红（task-44 验收
 * 原文）。2026-11-13 实测：删掉后 2 条用例红（`roots` 为 undefined、`isMultiRoot` 为 false）。</p>
 */

const WORKSPACE_ID = "ws-multi";

/** CP 的 `roots` 投影（PLAN-0639 M1：`Root[0].id == workspace.id`，这里故意不相等—— 见下条用例）。 */
const DECLARED_ROOTS = [
    { id: "mock-root-main", alias: "主根", position: 0, path: "mock/main" },
    { id: "mock-root-docs", alias: "文档根", position: 1, path: "mock/docs" },
];

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
    });
}

function requestUrl(input: RequestInfo | URL): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return input.url;
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    sessionStorage.clear();
    clearTabWorkspace();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    // `/workspaces/{id}` 请求要带 token 才会发（auth store 的 hydrate 有 token 门）。
    localStorage.setItem("xihe-token", "task-44-token");
});

afterEach(() => {
    vi.unstubAllGlobals();
    clearTabWorkspace();
    sessionStorage.clear();
    localStorage.clear();
});

async function hydrateFromHttp(workspace: Record<string, unknown>): Promise<void> {
    fetchMock.mockImplementation(async (input) => {
        const url = requestUrl(input as RequestInfo | URL);
        if (url.includes(`/api/v1/workspaces/${WORKSPACE_ID}`)) {
            return jsonResponse({ workspace });
        }
        if (url.includes("/api/v1/workspaces")) {
            return jsonResponse([workspace]);
        }
        return new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } });
    });
    // tab 上下文是唯一真源（I6）：先钉住「这个 tab 选了哪个工作区」，hydrate 才会去取它。
    writeTabWorkspaceId(WORKSPACE_ID);
    expect(readTabWorkspaceId()).toBe(WORKSPACE_ID);
    await useAuthStore().hydrateWorkspace();
}

describe("多根可见性：roots 必须经 HTTP 走完 normalizeWorkspace（task-44）", () => {
    it("GET /workspaces/{id} 的 roots 落在 authStore，并让 workspace store 认出多根", async () => {
        await hydrateFromHttp(
            makeWorkspace({
                id: WORKSPACE_ID,
                name: "多根工作区",
                hostPath: "H:/mock/alpha",
                roots: DECLARED_ROOTS,
            }),
        );

        // ① 归一化层：这一行就是 task-25 实测到的断点（旧实现里 roots 恒 undefined）。
        const auth = useAuthStore();
        expect(auth.workspace?.roots).toHaveLength(2);
        expect(auth.workspace?.roots?.map((root) => root.id)).toEqual([
            "mock-root-main",
            "mock-root-docs",
        ]);
        // `path` 是 B12 的组头标签来源（两个同末段名的根必须可区分），不能被归一化丢掉。
        expect(auth.workspace?.roots?.[0]?.path).toBe("mock/main");

        // ② store 层：多根判定与主根选择。
        const ws = useWorkspaceStore();
        expect(ws.workspaceRoots.map((root) => root.id)).toEqual([
            "mock-root-main",
            "mock-root-docs",
        ]);
        expect(ws.isMultiRoot).toBe(true);
        expect(ws.primaryRootId).toBe("mock-root-main");
    });

    it("wire 上只有 position 而无 path/alias 时仍排序可用，且不把单根错判成多根", async () => {
        await hydrateFromHttp(
            makeWorkspace({
                id: WORKSPACE_ID,
                name: "单根工作区",
                roots: [{ id: WORKSPACE_ID, alias: null, position: 0 }],
            }),
        );

        const auth = useAuthStore();
        expect(auth.workspace?.roots).toHaveLength(1);
        expect(auth.workspace?.roots?.[0]?.alias).toBeNull();
        expect(auth.workspace?.roots?.[0]?.path).toBeUndefined();

        const ws = useWorkspaceStore();
        expect(ws.workspaceRoots).toHaveLength(1);
        expect(ws.isMultiRoot).toBe(false);
        expect(ws.primaryRootId).toBe(WORKSPACE_ID);
    });

    it("没有 roots 投影的老工作区保持不分组（不抛错、不退化成空根）", async () => {
        await hydrateFromHttp(makeWorkspace({ id: WORKSPACE_ID, name: "老工作区" }));

        const ws = useWorkspaceStore();
        expect(useAuthStore().workspace?.roots).toBeUndefined();
        expect(ws.workspaceRoots).toEqual([]);
        expect(ws.isMultiRoot).toBe(false);
        expect(ws.primaryRootId).toBeNull();
    });
});
