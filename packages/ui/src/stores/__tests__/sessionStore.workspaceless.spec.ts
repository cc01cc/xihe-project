import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useSessionStore } from "../session";
import { api } from "../../composables/api";
import type { Session } from "../../types";

/**
 * task-373：独立会话投影的三条判据 —— 缓存命中不重拉、新建立刻可见、切用户清空。
 * 它与 `sessions`（当前工作区 live 投影）和 `sessionsByWorkspace`（别组快照）是**三份**状态。
 */
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function row(id: string, title: string) {
    return {
        id,
        title,
        workspaceId: null,
        archived: false,
        createdAt: "2026-11-14T00:00:00Z",
        updatedAt: "2026-11-14T00:00:00Z",
    };
}

function liveSession(id: string): Session {
    return {
        id,
        title: "Workspace session",
        createdAt: "2026-11-14T00:00:00Z",
        updatedAt: "2026-11-14T00:00:00Z",
        workspaceId: WORKSPACE_ID,
        context: { agents: [] },
    } as Session;
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    sessionStorage.clear();
});

describe("sessionStore workspaceless projection (task-373)", () => {
    it("loads once and serves the cache afterwards; force reloads", async () => {
        const load = vi.spyOn(api, "getWorkspacelessSessions").mockResolvedValue({
            sessions: [row(SESSION_ID, "Standalone")] as never,
            workspace: null,
        });
        const store = useSessionStore();

        await store.loadWorkspacelessSessions();
        await store.loadWorkspacelessSessions();
        expect(load).toHaveBeenCalledTimes(1);
        expect(store.workspacelessSessions.map((item) => item.id)).toEqual([SESSION_ID]);

        await store.loadWorkspacelessSessions(true);
        expect(load).toHaveBeenCalledTimes(2);
    });

    it("makes a newly created standalone session visible immediately without refetching", async () => {
        const store = useSessionStore();
        store.addWorkspacelessSession(row(SESSION_ID, "First") as never);
        store.addWorkspacelessSession(
            row("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "Second") as never,
        );
        store.addWorkspacelessSession(row(SESSION_ID, "First renamed") as never);

        expect(store.workspacelessSessions.map((item) => item.title)).toEqual([
            "First renamed",
            "Second",
        ]);
        expect(store.workspacelessLoaded).toBe(true);
    });

    it("clears the projection on user switch", async () => {
        const store = useSessionStore();
        store.addWorkspacelessSession(row(SESSION_ID, "Mine") as never);
        store.resetForUserSwitch();
        expect(store.workspacelessSessions).toEqual([]);
        expect(store.workspacelessLoaded).toBe(false);
    });

    it("cacheLiveSessionsFor keeps the last workspace group readable after leaving its context", async () => {
        const store = useSessionStore();
        store.sessions = [liveSession(SESSION_ID)];
        store.cacheLiveSessionsFor(WORKSPACE_ID);
        store.sessions = [];
        expect(store.sessionsByWorkspace[WORKSPACE_ID]?.map((item) => item.id)).toEqual([
            SESSION_ID,
        ]);

        // 已有缓存就不覆盖（别组快照可能是更新的权威读数）。
        store.sessions = [liveSession("dddddddd-dddd-4ddd-8ddd-dddddddddddd")];
        store.cacheLiveSessionsFor(WORKSPACE_ID);
        expect(store.sessionsByWorkspace[WORKSPACE_ID]).toHaveLength(1);
    });
});
