import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import { setActivePinia, createPinia } from "pinia";
import ScheduledTasksView from "../pages/ScheduledTasksView.vue";
import { api, ApiError } from "../../../composables/api";
import type * as apiModule from "../../../composables/api";
import { chatTransport } from "@/services/chatTransport";
import { i18n } from "../../../i18n";
import type { ScheduledTask } from "../../../types";

vi.mock("vue-router", () => ({
    createRouter: () => ({
        push: vi.fn(),
        replace: vi.fn(),
        beforeEach: vi.fn(),
        afterEach: vi.fn(),
        isReady: () => Promise.resolve(),
        currentRoute: { value: {} },
    }),
    createWebHistory: () => ({}),
    useRoute: () => ({
        params: { workspaceId: "ws-1" },
        path: "/workspace/ws-1/scheduled-tasks",
        query: {},
    }),
}));

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message: string) => void>(),
        error: vi.fn<(message: string) => void>(),
    },
}));

vi.mock("@/services/chatTransport", () => ({
    chatTransport: {
        sendMessages: vi.fn<typeof chatTransport.sendMessages>().mockResolvedValue(undefined),
        stop: vi.fn<typeof chatTransport.stop>(),
    },
}));

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            listScheduledTasks: vi.fn<typeof apiModule.api.listScheduledTasks>(),
            rerunScheduledTask: vi.fn<typeof apiModule.api.rerunScheduledTask>(),
            removeScheduledTask: vi.fn<typeof apiModule.api.removeScheduledTask>(),
            postponeScheduledTask: vi.fn<typeof apiModule.api.postponeScheduledTask>(),
            deleteScheduledTask: vi.fn<typeof apiModule.api.deleteScheduledTask>(),
        },
    };
});

const mockedApi = vi.mocked(api, true);

function setPrincipal(user: { id: string; name?: string; email: string; role?: string }) {
    localStorage.setItem("xihe-token", "mock-token");
    localStorage.setItem("xihe-user", JSON.stringify(user));
    localStorage.setItem("xihe-workspace", JSON.stringify({ id: "ws-1", name: "Workspace" }));
}

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

let wrappers: VueWrapper[] = [];

async function mountView(): Promise<VueWrapper> {
    const wrapper = mount(ScheduledTasksView, {
        attachTo: document.body,
        global: { plugins: [i18n] },
    });
    wrappers.push(wrapper);
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setPrincipal({ id: "user-1", email: "alice@example.com", name: "Alice" });
    setActivePinia(createPinia());
    mockedApi.listScheduledTasks.mockResolvedValue(listPage([]) as never);
});

afterEach(() => {
    for (const wrapper of wrappers) wrapper.unmount();
    wrappers = [];
});

describe("ScheduledTasksView list rendering", () => {
    it("renders status badges, missed flags with reasons, creator chips and next fire", async () => {
        mockedApi.listScheduledTasks.mockResolvedValue(
            listPage([
                task(),
                task({
                    id: "task-2",
                    status: "missed",
                    missedCount: 2,
                    missedReason: "overdue_grace",
                    nextFireAt: "2026-10-10T09:00:00Z",
                    createdBy: { name: "Ops Agent", type: "agent" },
                }),
                task({
                    id: "task-3",
                    status: "expired",
                    prompt: "Nightly build",
                    expiresAt: "2026-10-09T00:00:00Z",
                    createdBy: { name: "Ops Agent", type: "agent" },
                }),
            ]) as never,
        );

        const wrapper = await mountView(),
            // 前三个徽标来自桌面表格，后三个来自同一数据的移动端卡片（响应式双渲染）。
            statuses = wrapper.findAll('[data-testid="scheduled-task-status"]').slice(0, 3),
            creators = wrapper.findAll('[data-testid="scheduled-task-creator-type"]').slice(0, 3);

        expect(statuses.map((node) => node.text())).toEqual([
            "调度中",
            "错过 · 待处理",
            "已过期 · 待处理",
        ]);
        expect(wrapper.get('[data-testid="scheduled-task-missed-count"]').text()).toContain("×2");
        expect(wrapper.get('[data-testid="scheduled-task-reason"]').text()).toContain("宽限期");
        expect(creators[0]?.text()).toBe("human");
        expect(creators[1]?.text()).toBe("agent");
        // scheduled row shows the cron expression and timezone under next fire.
        expect(wrapper.text()).toContain("0 9 * * *");
        expect(wrapper.text()).toContain("UTC");
    });

    it("shows the empty state with a create entry when there are no tasks", async () => {
        const wrapper = await mountView();

        expect(wrapper.get('[data-testid="scheduled-tasks-empty"]').text()).toContain(
            "还没有定时任务",
        );
        expect(wrapper.get('[data-testid="scheduled-tasks-empty-create"]').exists()).toBe(true);
    });

    it("shows a retryable error when the list request fails", async () => {
        mockedApi.listScheduledTasks.mockRejectedValue(
            new ApiError({ status: 500, code: "INTERNAL", detail: "boom", requestId: "r" }),
        );

        const wrapper = await mountView();

        expect(wrapper.get('[data-testid="scheduled-tasks-error"]').text()).toContain("INTERNAL");
        expect(wrapper.get('[data-testid="scheduled-tasks-retry"]').exists()).toBe(true);
    });

    it("filters the list through the status chips", async () => {
        mockedApi.listScheduledTasks.mockResolvedValue(
            listPage([
                task(),
                task({ id: "task-2", status: "missed", missedCount: 1 }),
                task({ id: "task-3", status: "completed" }),
            ]) as never,
        );

        const wrapper = await mountView();
        expect(wrapper.findAll('[data-testid="scheduled-task-row"]')).toHaveLength(3);

        await wrapper.get('[data-testid="scheduled-tasks-filter-pending"]').trigger("click");
        await nextTick();
        const pendingRows = wrapper.findAll('[data-testid="scheduled-task-row"]');
        expect(pendingRows).toHaveLength(1);
        expect(pendingRows[0]?.text()).toContain("Morning report");

        await wrapper.get('[data-testid="scheduled-tasks-filter-done"]').trigger("click");
        await nextTick();
        expect(wrapper.findAll('[data-testid="scheduled-task-row"]')).toHaveLength(1);

        await wrapper.get('[data-testid="scheduled-tasks-filter-all"]').trigger("click");
        await nextTick();
        expect(wrapper.findAll('[data-testid="scheduled-task-row"]')).toHaveLength(3);
    });
});

describe("ScheduledTasksView disposition", () => {
    it("disables dispose buttons for tasks the user cannot manage", async () => {
        mockedApi.listScheduledTasks.mockResolvedValue(
            listPage([
                task({
                    id: "task-foreign",
                    status: "missed",
                    missedCount: 1,
                    createdBy: { name: "someone-else@example.com", type: "human" },
                }),
            ]) as never,
        );

        const wrapper = await mountView(),
            rerun = wrapper.get('[data-testid="scheduled-task-rerun"]');

        expect(rerun.attributes("disabled")).toBeDefined();
        expect(rerun.attributes("title")).toContain("MANAGE_SCHEDULED_TASK");
        expect(
            wrapper.get('[data-testid="scheduled-task-remove"]').attributes("disabled"),
        ).toBeDefined();
    });

    it("enables dispose buttons for the creator and reruns on click", async () => {
        mockedApi.listScheduledTasks.mockResolvedValue(
            listPage([task({ status: "missed", missedCount: 2 })]) as never,
        );
        mockedApi.rerunScheduledTask.mockResolvedValue(
            task({ status: "scheduled", missedCount: 0 }) as never,
        );

        const wrapper = await mountView();
        await wrapper.get('[data-testid="scheduled-task-rerun"]').trigger("click");
        await flushPromises();

        expect(mockedApi.rerunScheduledTask).toHaveBeenCalledWith("ws-1", "task-1");
        // rerun triggers a list refetch to pick up the recomputed next fire.
        expect(mockedApi.listScheduledTasks).toHaveBeenCalledTimes(2);
    });

    it("removes a missed task after confirmation and surfaces the idempotent result", async () => {
        mockedApi.listScheduledTasks.mockResolvedValue(
            listPage([task({ status: "missed", missedCount: 1 })]) as never,
        );
        mockedApi.removeScheduledTask.mockResolvedValue({
            taskId: "task-1",
            status: "cancelled",
            changed: false,
            task: task({ status: "cancelled", missedCount: 0 }),
        } as never);

        const wrapper = await mountView();
        await wrapper.get('[data-testid="scheduled-task-remove"]').trigger("click");
        await nextTick();

        expect(
            document.body.querySelector('[data-testid="scheduled-task-remove-confirm"]'),
        ).toBeTruthy();

        (
            document.body.querySelector(
                '[data-testid="scheduled-task-remove-confirm-btn"]',
            ) as HTMLButtonElement
        ).click();
        await flushPromises();

        expect(mockedApi.removeScheduledTask).toHaveBeenCalledWith("ws-1", "task-1");
        const { toast } = await import("vue-sonner");
        expect(toast.success).toHaveBeenCalledWith("该任务已是取消状态，无需重复移除。");
    });

    it("cancels a scheduled task through the confirm dialog", async () => {
        mockedApi.listScheduledTasks.mockResolvedValue(listPage([task()]) as never);
        mockedApi.deleteScheduledTask.mockResolvedValue({
            taskId: "task-1",
            status: "cancelled",
            changed: true,
            task: task({ status: "cancelled" }),
        } as never);

        const wrapper = await mountView();
        await wrapper.get('[data-testid="scheduled-task-cancel"]').trigger("click");
        await nextTick();

        (
            document.body.querySelector(
                '[data-testid="scheduled-task-cancel-confirm-btn"]',
            ) as HTMLButtonElement
        ).click();
        await flushPromises();

        expect(mockedApi.deleteScheduledTask).toHaveBeenCalledWith("ws-1", "task-1");
    });

    it("postpones with an ISO instant picked in the dialog", async () => {
        mockedApi.listScheduledTasks.mockResolvedValue(
            listPage([task({ status: "missed", missedCount: 1 })]) as never,
        );
        mockedApi.postponeScheduledTask.mockResolvedValue(
            task({ status: "scheduled", nextFireAt: "2026-10-16T18:00:00.000Z" }) as never,
        );

        const wrapper = await mountView();
        await wrapper.get('[data-testid="scheduled-task-postpone"]').trigger("click");
        await nextTick();

        const input = document.body.querySelector(
            '[data-testid="st-postpone-at"]',
        ) as HTMLInputElement;
        expect(input).toBeTruthy();
        const future = new Date(Date.now() + 3_600_000);
        const pad = (n: number) => String(n).padStart(2, "0");
        input.value = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T${pad(future.getHours())}:${pad(future.getMinutes())}`;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await nextTick();

        (
            document.body.querySelector('[data-testid="st-postpone-submit"]') as HTMLButtonElement
        ).click();
        await flushPromises();

        expect(mockedApi.postponeScheduledTask).toHaveBeenCalledTimes(1);
        const [, , at] = mockedApi.postponeScheduledTask.mock.calls[0]!;
        expect(new Date(at).getTime()).toBeGreaterThan(Date.now());
    });
});

describe("ScheduledTasksView workspace events", () => {
    it("refetches the list when scheduled_tasks_changed arrives", async () => {
        mockedApi.listScheduledTasks.mockResolvedValue(listPage([task()]) as never);

        await mountView();
        expect(mockedApi.listScheduledTasks).toHaveBeenCalledTimes(1);

        expect(chatTransport.sendMessages).toHaveBeenCalledWith(
            "workspace:ws-1",
            expect.objectContaining({ url: "/api/v1/workspaces/ws-1/events" }),
        );
        const options = vi.mocked(chatTransport.sendMessages).mock.calls[0]![1];
        await options.onmessage?.({
            id: "2",
            event: "scheduled_tasks_changed",
            data: JSON.stringify({
                workspaceId: "ws-1",
                sequence: 2,
                kind: "scheduled_tasks_changed",
                source: "control-plane",
            }),
        });
        await flushPromises();

        expect(mockedApi.listScheduledTasks).toHaveBeenCalledTimes(2);
    });
});
