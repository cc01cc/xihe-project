import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { api, ApiError } from "../../../composables/api";
import type * as apiModule from "../../../composables/api";
import {
    canManageScheduledTask,
    scheduledTaskErrorText,
    useScheduledTasksStore,
} from "../stores/scheduledTasks";
import type { ScheduledTask } from "../../../types";
import { i18n } from "../../../i18n";

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            listScheduledTasks: vi.fn<typeof apiModule.api.listScheduledTasks>(),
            createScheduledTask: vi.fn<typeof apiModule.api.createScheduledTask>(),
            rerunScheduledTask: vi.fn<typeof apiModule.api.rerunScheduledTask>(),
            removeScheduledTask: vi.fn<typeof apiModule.api.removeScheduledTask>(),
            postponeScheduledTask: vi.fn<typeof apiModule.api.postponeScheduledTask>(),
            deleteScheduledTask: vi.fn<typeof apiModule.api.deleteScheduledTask>(),
        },
    };
});

const mockedApi = vi.mocked(api, true);

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
    return {
        id: "task-1",
        triggerKind: "cron",
        cronExpr: "0 9 * * *",
        timezone: "UTC",
        targetKind: "session_wakeup",
        targetSessionId: "session-1",
        prompt: "Morning report",
        status: "scheduled",
        nextFireAt: "2026-10-13T09:00:00Z",
        expiresAt: null,
        missedCount: 0,
        lastMissedAt: null,
        missedReason: null,
        lastRunId: null,
        createdBy: { name: "alice@example.com", type: "human" },
        createdAt: "2026-10-12T00:00:00Z",
        updatedAt: "2026-10-12T00:00:00Z",
        ...overrides,
    };
}

function listPage(tasks: ScheduledTask[]) {
    return { workspaceId: "ws-1", page: 0, size: 200, tasks };
}

beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
});

describe("useScheduledTasksStore", () => {
    it("fetches and stores the workspace task list", async () => {
        mockedApi.listScheduledTasks.mockResolvedValue(listPage([task()]) as never);
        const store = useScheduledTasksStore();

        const result = await store.fetchScheduledTasks("ws-1");

        expect(mockedApi.listScheduledTasks).toHaveBeenCalledWith("ws-1", { size: 200 });
        expect(result).toHaveLength(1);
        expect(store.tasks[0]?.id).toBe("task-1");
        expect(store.error).toBeNull();
    });

    it("serves the cached list without a refetch until forced", async () => {
        mockedApi.listScheduledTasks.mockResolvedValue(listPage([task()]) as never);
        const store = useScheduledTasksStore();

        await store.fetchScheduledTasks("ws-1");
        await store.fetchScheduledTasks("ws-1");

        expect(mockedApi.listScheduledTasks).toHaveBeenCalledTimes(1);

        await store.fetchScheduledTasks("ws-1", { force: true });
        expect(mockedApi.listScheduledTasks).toHaveBeenCalledTimes(2);
    });

    /**
     * task-67：列表错误必须**整份呈现**（{ copy, code, technicalDetail }），因为本页卡片是
     * 诊断面 —— 只留 copy 会让「请提供错误码」这句话没有对应物（Lead 实测 hasCode=false）。
     *
     * <p>判据按 AGENTS.md 三件事：可读文案在 + 不含错误码字样 + 不含 API error 数字；再加
     * 一条**正向**：code 确实留住了具体码（供屏上渲染与复制）。改前这里断言的是
     * toContain("WORKSPACE_NOT_FOUND")（记录缺陷的形态），已按「不许只删不加」换成下面这套。</p>
     *
     * <p><b>码名用 SCHEDULED_TASK_INTERNAL（task-67 复审 Lead 裁定）：</b>它在本仓 `src` 里
     * 出现 **0** 次 ⇒ 落在 `mappedErrorCopy` 码表之外，正好走本题要测的「未登记码」路径；
     * 而先前用的 `AUDIT_ERROR` 虽同样是「未登记码」，却在审计面有**本义**（`src` 里 20 处，
     * 多为审计/错误面用例）⇒ 混用会让下一个人 grep 时命中两个不相干的面。**码名是模板的一部分**
     * ——这份 spec 会被当作下一个诊断面用例的模板抄走，故取一个本域自洽、且全仓无歧义的名字。</p>
     */
    it("records a readable, code-bearing error when the list request fails", async () => {
        mockedApi.listScheduledTasks.mockRejectedValue(
            new ApiError({
                status: 500,
                code: "SCHEDULED_TASK_INTERNAL",
                detail: "API error 500",
                requestId: "r",
            }),
        );
        const store = useScheduledTasksStore();

        await store.fetchScheduledTasks("ws-1");

        expect(store.error?.copy).toBe(i18n.global.t("errors.unknownCode"));
        expect(store.error?.copy).not.toContain("SCHEDULED_TASK_INTERNAL");
        expect(store.error?.copy).not.toMatch(/API error \d+/);
        // 正向：具体码留在呈现里（诊断面靠它渲染可复制的 code 元素）。
        expect(store.error?.code).toBe("SCHEDULED_TASK_INTERNAL");
        expect(store.error?.technicalDetail).toBe("API error 500");
        expect(store.tasks).toHaveLength(0);
    });

    it("keeps the code null and the detail absent when the failure carries neither", async () => {
        mockedApi.listScheduledTasks.mockRejectedValue(new Error("boom: socket hang up"));
        const store = useScheduledTasksStore();

        await store.fetchScheduledTasks("ws-1");

        // 无码 ⇒ 不渲染 code 行；无 detail ⇒ 不渲染空折叠区。
        expect(store.error?.code).toBeNull();
        expect(store.error?.technicalDetail).toBeNull();
        expect(store.error?.copy).toBe(i18n.global.t("errors.requestFailed"));
    });

    it("refetches on scheduled_tasks_changed workspace events", async () => {
        mockedApi.listScheduledTasks.mockResolvedValue(listPage([task()]) as never);
        const store = useScheduledTasksStore();
        await store.fetchScheduledTasks("ws-1");

        store.applyWorkspaceEvent("ws-1", {
            workspaceId: "ws-1",
            sequence: 2,
            kind: "scheduled_tasks_changed",
            source: "control-plane",
        });
        await vi.waitFor(() => {
            expect(mockedApi.listScheduledTasks).toHaveBeenCalledTimes(2);
        });
    });

    it("ignores workspace events for a different workspace", async () => {
        mockedApi.listScheduledTasks.mockResolvedValue(listPage([task()]) as never);
        const store = useScheduledTasksStore();
        await store.fetchScheduledTasks("ws-1");

        store.applyWorkspaceEvent("ws-2", {
            workspaceId: "ws-2",
            sequence: 2,
            kind: "scheduled_tasks_changed",
            source: "control-plane",
        });
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(mockedApi.listScheduledTasks).toHaveBeenCalledTimes(1);
    });

    it("upserts the refreshed task returned by rerun", async () => {
        mockedApi.listScheduledTasks.mockResolvedValue(
            listPage([task({ status: "missed", missedCount: 2 })]),
        );
        const store = useScheduledTasksStore();
        await store.fetchScheduledTasks("ws-1");
        mockedApi.rerunScheduledTask.mockResolvedValue(
            task({
                status: "scheduled",
                missedCount: 0,
                nextFireAt: "2026-10-20T09:00:00Z",
            }) as never,
        );

        await store.rerunTask("ws-1", store.tasks[0]!);

        expect(store.tasks[0]?.status).toBe("scheduled");
        expect(store.tasks[0]?.missedCount).toBe(0);
        expect(store.mutatingTaskId).toBeNull();
    });

    it("reports the idempotent remove result and refreshes the task", async () => {
        mockedApi.listScheduledTasks.mockResolvedValue(listPage([task({ status: "missed" })]));
        const store = useScheduledTasksStore();
        await store.fetchScheduledTasks("ws-1");
        mockedApi.removeScheduledTask.mockResolvedValue({
            taskId: "task-1",
            status: "cancelled",
            changed: false,
            task: task({ status: "cancelled", missedCount: 0 }),
        } as never);

        const result = await store.removeTask("ws-1", store.tasks[0]!);

        expect(result.changed).toBe(false);
        expect(store.tasks[0]?.status).toBe("cancelled");
    });

    it("postpones with the ISO instant and upserts the refreshed task", async () => {
        mockedApi.listScheduledTasks.mockResolvedValue(
            listPage([task({ status: "missed", nextFireAt: "2026-10-10T09:00:00Z" })]),
        );
        const store = useScheduledTasksStore();
        await store.fetchScheduledTasks("ws-1");
        const at = "2026-10-16T18:00:00.000Z";
        mockedApi.postponeScheduledTask.mockResolvedValue(
            task({ status: "scheduled", nextFireAt: at }) as never,
        );

        await store.postponeTask("ws-1", store.tasks[0]!, at);

        expect(mockedApi.postponeScheduledTask).toHaveBeenCalledWith("ws-1", "task-1", at);
        expect(store.tasks[0]?.nextFireAt).toBe(at);
        expect(store.tasks[0]?.status).toBe("scheduled");
    });

    it("cancels a scheduled task through DELETE and upserts the result", async () => {
        mockedApi.listScheduledTasks.mockResolvedValue(listPage([task()]));
        const store = useScheduledTasksStore();
        await store.fetchScheduledTasks("ws-1");
        mockedApi.deleteScheduledTask.mockResolvedValue({
            taskId: "task-1",
            status: "cancelled",
            changed: true,
            task: task({ status: "cancelled" }),
        } as never);

        await store.cancelTask("ws-1", store.tasks[0]!);

        expect(mockedApi.deleteScheduledTask).toHaveBeenCalledWith("ws-1", "task-1");
        expect(store.tasks[0]?.status).toBe("cancelled");
    });

    it("clears all state on user switch", async () => {
        mockedApi.listScheduledTasks.mockResolvedValue(listPage([task()]));
        const store = useScheduledTasksStore();
        await store.fetchScheduledTasks("ws-1");

        store.clearForUserSwitch();

        expect(store.tasks).toHaveLength(0);
        expect(store.loadedWorkspaceId).toBeNull();
    });
});

describe("canManageScheduledTask", () => {
    it("enables disposition for the human creator", () => {
        expect(canManageScheduledTask(task(), { name: "Alice", email: "alice@example.com" })).toBe(
            true,
        );
    });

    it("matches the creator by email when the name differs", () => {
        expect(canManageScheduledTask(task(), { email: "alice@example.com" })).toBe(true);
    });

    it("fails closed for another user's task", () => {
        expect(canManageScheduledTask(task(), { name: "Bob", email: "bob@example.com" })).toBe(
            false,
        );
    });

    it("fails closed for agent-created tasks", () => {
        expect(
            canManageScheduledTask(task({ createdBy: { name: "Ops Agent", type: "agent" } }), {
                name: "Ops Agent",
                email: "alice@example.com",
            }),
        ).toBe(false);
    });

    it("fails closed without a signed-in user", () => {
        expect(canManageScheduledTask(task(), null)).toBe(false);
    });
});

describe("scheduledTaskErrorText", () => {
    const t = (key: string) => key;

    it("maps stable Problem codes to i18n keys", () => {
        const error = new ApiError({
            status: 409,
            code: "SCHEDULED_TASK_LIMIT",
            detail: "limit",
            requestId: "r",
        });
        expect(scheduledTaskErrorText(t, error)).toBe("workspace.scheduledTasks.errLimit");
    });

    /**
     * task-67（顺带收的一条**存量红**，HEAD 上同样红 —— 已用 `git show HEAD:` 版本实跑证实）：
     * 这条断言原本记录的是 task-45 **改前**的缺陷形态（码表之外的码拼 `CODE: english detail`）。
     * 实现已按 task-45 契约改成「码表之外统一走可读文案入口」，断言没跟上 ⇒ 长期红。
     * 按 AGENTS.md「改既有断言不许只删不加」，把记录缺陷的 `toContain("CODE")` 换成判据三件事。
     */
    it("falls back to the readable copy for unmapped problems (no raw code, no English detail)", () => {
        const error = new ApiError({
            status: 500,
            code: "INTERNAL_ERROR",
            detail: "boom",
            requestId: "r",
        });
        const copy = scheduledTaskErrorText(t, error);
        // 可读文案在（未知码 ⇒ unknownCode 兜底句）。
        expect(copy).toBe("errors.unknownCode");
        // 不含错误码字样 / 不含英文 detail。
        expect(copy).not.toContain("INTERNAL_ERROR");
        expect(copy).not.toContain("boom");
        expect(copy).not.toMatch(/API error \d+/);
    });
});
