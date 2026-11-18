import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { ApiError, api, type ApiTeamTask } from "../../composables/api";
import { useTeamTasksStore } from "../teamTasks";
import { notifySessionEvent } from "../../features/workspace/chat/sessionEvents";

/**
 * task-188 S2/S3 L0-S2：teamTasks store。
 * 反假绿对应：N1（失败吞成空）、N7（hint/轮询触发重读的 call count 严格等值）、
 * 切换守卫（迟到的响应不许回填旧会话 —— vue skill 硬约束同款）。
 */

const SESSION = "aaaaaaaa-1111-4111-8111-111111111111";
const OTHER_SESSION = "bbbbbbbb-2222-4222-8222-222222222222";
const ROOT = "11111111-1111-4111-8111-111111111111";

function wireTask(overrides: Partial<ApiTeamTask> = {}): ApiTeamTask {
    return {
        taskId: "cccccccc-0000-4000-8000-000000000001",
        teamRootSessionId: ROOT,
        taskNo: 1,
        revision: 1,
        subject: "修登录重试",
        description: null,
        status: "pending",
        ready: true,
        ownerSessionId: null,
        ownerName: null,
        blockedBy: [],
        writeScopeWarnings: [],
        createdBySessionId: ROOT,
        createdAt: "2026-11-18T00:00:00Z",
        updatedAt: "2026-11-18T00:00:00Z",
        ...overrides,
    };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("useTeamTasksStore", () => {
    let spy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        setActivePinia(createPinia());
        spy = vi.spyOn(api, "getSessionTeamTasks");
    });

    afterEach(() => {
        useTeamTasksStore().detach();
        vi.restoreAllMocks();
    });

    it("loads the projection on attach and exposes view rows + counts", async () => {
        spy.mockResolvedValue([
            wireTask(),
            wireTask({
                taskId: "cccccccc-0000-4000-8000-000000000002",
                taskNo: 2,
                status: "in_progress",
                ownerName: "ui-2",
            }),
        ]);
        const store = useTeamTasksStore();
        store.attach(SESSION, { rootSessionId: ROOT });
        await flush();

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(SESSION);
        expect(store.rows.map((row) => row.label)).toEqual(["task-1", "task-2"]);
        expect(store.counts).toEqual({ completed: 0, inProgress: 1, pending: 1 });
        expect(store.loading).toBe(false);
        expect(store.error).toBeNull();
        expect(store.hasContent).toBe(true);
    });

    it("refreshes exactly once per derived_state_changed hint (N7)", async () => {
        spy.mockResolvedValue([wireTask()]);
        const store = useTeamTasksStore();
        store.attach(SESSION, { rootSessionId: ROOT });
        await flush();
        expect(spy).toHaveBeenCalledTimes(1);

        notifySessionEvent(SESSION);
        await flush();
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it("pollTick refreshes when visible and skips when hidden (N7)", async () => {
        spy.mockResolvedValue([wireTask()]);
        const store = useTeamTasksStore();
        store.attach(SESSION, { rootSessionId: ROOT });
        await flush();
        expect(spy).toHaveBeenCalledTimes(1);

        const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        store.pollTick();
        await flush();
        expect(spy).toHaveBeenCalledTimes(1);
        hidden.mockReturnValue("visible");
        store.pollTick();
        await flush();
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it("dedups concurrent triggers while a refresh is in flight (方案 §3-3)", async () => {
        let release!: (value: ApiTeamTask[]) => void;
        spy.mockImplementation(
            () =>
                new Promise<ApiTeamTask[]>((resolve) => {
                    release = resolve;
                }),
        );
        const store = useTeamTasksStore();
        store.attach(SESSION, { rootSessionId: ROOT });
        // attach 首刷在途；同刻再来 hint + 手动 refresh + 轮询 tick。
        notifySessionEvent(SESSION);
        store.pollTick();
        void store.refresh();
        await flush();
        expect(spy).toHaveBeenCalledTimes(1);

        release([wireTask()]);
        await flush();
        expect(store.rows).toHaveLength(1);
        // 在途期间被丢弃的触发不会补跑（慢轮询不争抢）。
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("surfaces read failures as an explicit error, never a silent empty list (N1)", async () => {
        spy.mockRejectedValue(new Error("boom"));
        const store = useTeamTasksStore();
        store.configure({ presentError: (cause) => "已解析：" + (cause as Error).message });
        store.attach(SESSION, { rootSessionId: ROOT });
        await flush();

        expect(store.error).toBe("已解析：boom");
        expect(store.rows).toHaveLength(0);
        expect(store.hasContent).toBe(true);

        spy.mockResolvedValue([wireTask()]);
        store.attach(SESSION, { rootSessionId: ROOT }); // 同参 no-op？—— 不同实例状态已脏，直接手动 refresh
        await flush();
        // 上面的 attach 是 no-op（同参会话），手动重试走 refresh：
        await store.refresh();
        expect(store.error).toBeNull();
        expect(store.rows).toHaveLength(1);
    });

    it("does not backfill a stale session after switching (守卫)", async () => {
        let release!: (value: ApiTeamTask[]) => void;
        spy.mockImplementationOnce(
            () =>
                new Promise<ApiTeamTask[]>((resolve) => {
                    release = resolve;
                }),
        );
        spy.mockResolvedValue([wireTask({ subject: "新会话的任务" })]);
        const store = useTeamTasksStore();
        store.attach(SESSION, { rootSessionId: ROOT });
        store.attach(OTHER_SESSION);
        await flush();
        expect(spy).toHaveBeenCalledTimes(2);

        release([wireTask({ subject: "迟到的旧会话任务" })]);
        await flush();
        // 旧会话响应到达，但不得回填：行必须来自新会话那次调用。
        expect(store.rows.map((row) => row.subject)).toEqual(["新会话的任务"]);
    });

    it("treats a 404 as 'no board on this stack' instead of surfacing an error banner", async () => {
        // 端点未登记（旧 CP / 未挂路由的 mock 车道）⇒ 无板无横幅，hasContent 保持 false。
        spy.mockRejectedValue(
            new ApiError({ status: 404, code: "MOCK_ENDPOINT_MISSING", requestId: "t" }),
        );
        const store = useTeamTasksStore();
        store.attach(SESSION, { rootSessionId: ROOT });
        await flush();

        expect(store.error).toBeNull();
        expect(store.rows).toHaveLength(0);
        expect(store.hasContent).toBe(false);
    });

    it("stops reacting to signals after detach", async () => {
        spy.mockResolvedValue([wireTask()]);
        const store = useTeamTasksStore();
        store.attach(SESSION, { rootSessionId: ROOT });
        await flush();
        store.detach();
        notifySessionEvent(SESSION);
        store.pollTick();
        await flush();
        expect(spy).toHaveBeenCalledTimes(1);
    });
});
