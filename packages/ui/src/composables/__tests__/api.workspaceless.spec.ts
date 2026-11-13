import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { writeTabWorkspace } from "../../lib/workspaceContext";

/**
 * task-373 / `D-1236` 甲案的**线上形状**判据（不是实现细节）：
 * ① 不带 scope 的 `GET /sessions` 逐字节不变（URL 无 scope、tab 工作区头照旧注入）；
 * ② `scope=workspaceless` 必须**不带工作区上下文** —— CP 的读门按 workspace 相等过滤，
 *    带着 tab 工作区头读独立会话必 404（`SessionReadAccess#resolve`）；
 * ③ 新建独立会话永远落 `POST /sessions`，即使 tab 里有工作区（否则会被建到那个工作区去）。
 */
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let fetchSpy: ReturnType<typeof vi.spyOn>;

function sessionRow(id: string, workspaceId: string | null) {
    return {
        id,
        title: "Standalone chat",
        workspaceId,
        archived: false,
        createdAt: "2026-11-14T00:00:00Z",
        updatedAt: "2026-11-14T00:00:00Z",
    };
}

function okJson(body: unknown) {
    return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("xihe-token", "test-token");
    fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
    fetchSpy.mockRestore();
});

describe("api.getWorkspacelessSessions (task-373)", () => {
    it("asks for scope=workspaceless and sends a blank workspace header even with a tab workspace", async () => {
        writeTabWorkspace({ id: WORKSPACE_ID, name: "Ws" });
        fetchSpy.mockResolvedValueOnce(okJson({ sessions: [sessionRow(SESSION_ID, null)] }));

        const page = await api.getWorkspacelessSessions();

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("/api/v1/sessions?scope=workspaceless");
        expect((init.headers as Record<string, string>)["X-Workspace-Id"]).toBe("");
        expect(page.sessions).toHaveLength(1);
        expect(page.sessions[0]!.workspaceId).toBeNull();
    });

    it("keeps the plain list face byte-identical: no scope, tab workspace header injected", async () => {
        writeTabWorkspace({ id: WORKSPACE_ID });
        fetchSpy.mockResolvedValueOnce(
            okJson({ sessions: [sessionRow(SESSION_ID, WORKSPACE_ID)] }),
        );

        await api.getSessions();

        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("/api/v1/sessions");
        expect((init.headers as Record<string, string>)["X-Workspace-Id"]).toBe(WORKSPACE_ID);
    });

    it("drops a malformed row with a WARN instead of failing the whole standalone list (D4)", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        fetchSpy.mockResolvedValueOnce(
            okJson({ sessions: [{ id: "bad-row" }, sessionRow(SESSION_ID, null)] }),
        );

        const page = await api.getWorkspacelessSessions();

        expect(page.sessions.map((row) => row.id)).toEqual([SESSION_ID]);
        expect(warn).toHaveBeenCalledWith("[sessions] dropping malformed row", expect.anything());
        warn.mockRestore();
    });
});

describe("api.createStandaloneSession (task-373)", () => {
    it("POSTs /sessions with no workspace input even when the tab holds a workspace", async () => {
        writeTabWorkspace({ id: WORKSPACE_ID });
        fetchSpy.mockResolvedValueOnce({
            ok: true,
            status: 201,
            json: () => Promise.resolve(sessionRow(SESSION_ID, null)),
        } as Response);

        const created = await api.createStandaloneSession("principal-1", "Plan");

        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("/api/v1/sessions");
        expect(init.method).toBe("POST");
        expect((init.headers as Record<string, string>)["X-Workspace-Id"]).toBe("");
        expect(JSON.parse(String(init.body))).toEqual({
            title: "Plan",
            agentPrincipalId: "principal-1",
        });
        expect(created.workspaceId).toBeNull();
    });
});
