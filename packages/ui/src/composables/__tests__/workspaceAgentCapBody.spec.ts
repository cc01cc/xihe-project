import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type WorkspaceAgentPermission } from "../api";

/**
 * 47A（`task-152` / D-1109）—— **上限三态在 wire 上是三种不同的请求体**。
 *
 * <p>为什么不在面板 spec 里了事：那边只能断言「组件把哪个参数交给了 api 方法」，
 * 而真正决定 CP 记 `capSource=baseline` 还是 `explicit` 的是**序列化后的 body** ——
 * `permissions === undefined ? {} : { permissions }`（`composables/api.ts:4067`）。
 * 两者之间隔着一层，只有真跑 `fetch` 才能看见。三态合并成一个 flag 时，
 * 「不传」与「传 []」在 TS 里都能过，只有断 body 才能把它们分开。</p>
 *
 * <p>反假绿判据：把 `api.ts:4067` 改成恒 `{ permissions: permissions ?? [] }`，
 * 本文件第 1 条必须红（省略态会变成 `{"permissions":[]}` ⇒ 零权限）。</p>
 */

const WORKSPACE_ID = "ws-cap";
const PRINCIPAL_ID = "pppppppp-1111-4111-8111-pppppppppppp";

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
    });
}

/** 取**唯一一次**请求的 URL / method / body（body 只解析一次，断言时不会再被读走）。 */
function onlyRequest(): { url: string; method: string; raw: string } {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    const url =
        typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url;
    const raw = String((init as RequestInit | undefined)?.body ?? "");
    return { url, method: String((init as RequestInit | undefined)?.method ?? "GET"), raw };
}

function bodyOf(raw: string): Record<string, unknown> {
    return JSON.parse(raw) as Record<string, unknown>;
}

beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () =>
        jsonResponse({ permissions: [], capSource: "baseline" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    localStorage.setItem("xihe-token", "task-152-token");
});

afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
});

describe("47A 上限三态：请求体必须能区分「省略 / 零权限 / 非空」", () => {
    it("继承态：不传 permissions ⇒ body 里**没有**该字段（CP 据此记 capSource=baseline）", async () => {
        await api.updateWorkspaceAgentCap(WORKSPACE_ID, PRINCIPAL_ID);

        const { url, method, raw } = onlyRequest();
        expect(method).toBe("PUT");
        expect(url).toContain(`/api/v1/workspaces/${WORKSPACE_ID}/agents/${PRINCIPAL_ID}`);
        // 正向断言「真的没有这个字段」—— 不是「传了个空数组也能过」。
        expect(bodyOf(raw)).not.toHaveProperty("permissions");
        expect(raw).toBe("{}");
    });

    it("显式零权限：传 [] ⇒ body 里 permissions 是空数组（不是省略）", async () => {
        await api.updateWorkspaceAgentCap(
            WORKSPACE_ID,
            PRINCIPAL_ID,
            [] as WorkspaceAgentPermission[],
        );

        const { raw } = onlyRequest();
        expect(bodyOf(raw)).toHaveProperty("permissions");
        expect(bodyOf(raw).permissions).toEqual([]);
        expect(raw).toBe('{"permissions":[]}');
    });

    it("显式非零：传数组 ⇒ body 原样带上逐原子条目", async () => {
        const permissions: WorkspaceAgentPermission[] = [
            { actionClass: "write", resource: "src/*" },
        ];
        await api.updateWorkspaceAgentCap(WORKSPACE_ID, PRINCIPAL_ID, permissions);

        const { raw } = onlyRequest();
        expect(bodyOf(raw).permissions).toEqual([{ actionClass: "write", resource: "src/*" }]);
    });
});
