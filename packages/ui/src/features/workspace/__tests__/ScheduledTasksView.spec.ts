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
        push: vi.fn<() => void>(),
        replace: vi.fn<() => void>(),
        beforeEach: vi.fn<() => void>(),
        afterEach: vi.fn<() => void>(),
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
            // 表格与卡片是 CSS 断点双渲染（两套 DOM 同时在树里）⇒ 同名内层 testid 必须靠容器后缀区分：
            // -row = 桌面表格，-card = 移动卡片。裸用 'scheduled-task-status' 会命中两个。
            statuses = wrapper.findAll('[data-testid="scheduled-task-status-row"]'),
            creators = wrapper.findAll('[data-testid="scheduled-task-creator-type-row"]');

        expect(statuses.map((node) => node.text())).toEqual([
            "调度中",
            "错过 · 待处理",
            "已过期 · 待处理",
        ]);
        expect(wrapper.get('[data-testid="scheduled-task-missed-count-row"]').text()).toContain(
            "×2",
        );
        // 移动卡片侧同样渲染：同一数据两套 DOM，各用各的后缀。
        expect(wrapper.findAll('[data-testid="scheduled-task-status-card"]')).toHaveLength(3);
        expect(wrapper.findAll('[data-testid="scheduled-task-creator-type-card"]')).toHaveLength(3);
        expect(wrapper.get('[data-testid="scheduled-task-reason-row"]').text()).toContain("宽限期");
        expect(creators[0]?.text()).toBe("human");
        expect(creators[1]?.text()).toBe("智能体");
        // scheduled row shows the cron expression and timezone under next fire.
        expect(wrapper.text()).toContain("0 9 * * *");
        expect(wrapper.text()).toContain("UTC");
    });

    it("两套断点 DOM 里没有同名内层 testid（CSS 互斥的伪装）", async () => {
        // 根因：表格是 `hidden md:block`、卡片是 `md:hidden` —— 互斥由**CSS 断点**表达，
        // 两套 DOM 同时挂在树里。所以 `scheduled-task-status` 这类内层名必须带容器后缀
        // （-row / -card），否则任何 getByTestId 都命中 2 个（JSdom 与浏览器都一样）。
        // 判据是**DOM 计数**，不是「可见的只有一个」——后者验的是视觉，缺陷恰在 DOM 层。
        mockedApi.listScheduledTasks.mockResolvedValue(listPage([task()]) as never);
        const wrapper = await mountView();

        // 前提：两侧真的都渲染了（否则下面的唯一性会假绿）
        expect(wrapper.findAll('[data-testid="scheduled-task-row"]')).toHaveLength(1);
        expect(wrapper.findAll('[data-testid="scheduled-task-card"]')).toHaveLength(1);

        const ids = wrapper
            .findAll('[data-testid^="scheduled-task-"]')
            .map((el) => el.attributes("data-testid") ?? "");
        const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
        expect(dupes).toEqual([]);
        // 内层名两侧都在、且各自唯一 —— 直接点名两个最关键的，防「改名改到只剩一侧」
        expect(ids).toContain("scheduled-task-status-row");
        expect(ids).toContain("scheduled-task-status-card");
        wrapper.unmount();
    });

    it("shows the empty state with a create entry when there are no tasks", async () => {
        const wrapper = await mountView();

        expect(wrapper.get('[data-testid="scheduled-tasks-empty"]').text()).toContain(
            "还没有自动化任务",
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

    it("筛选计数不用 opacity 表达次要性（task-42：opacity 会把前景压到 2.74:1）", async () => {
        mockedApi.listScheduledTasks.mockResolvedValue(
            listPage([task(), task({ id: "task-2", status: "missed", missedCount: 1 })]) as never,
        );

        const wrapper = await mountView();
        // 不新增内层 testid：本页两套断点 DOM 同时挂在树里，新增内层名会破坏
        // 「两套断点里没有同名 testid」的不变式（见上一条）。改用 chip 结构定位计数。
        const chips = wrapper.findAll('[data-testid^="scheduled-tasks-filter-"]');
        expect(chips.length).toBeGreaterThanOrEqual(3);
        let asserted = 0;
        for (const chip of chips) {
            const spans = chip.findAll("span");
            if (spans.length === 0) continue;
            for (const span of spans) {
                // opacity 不是背景层：它把前景按 alpha 二次合成，未选中态实测 2.740:1 < 4.5。
                // 次要性改由实色（muted / accent-foreground）承担 ⇒ 锁死「不得再用 opacity-*」。
                expect(
                    span.classes().join(" "),
                    "计数的次要性由实色承担，禁止 opacity-*",
                ).not.toMatch(/(^|\s)opacity-\d/);
                expect(span.text()).toMatch(/^\d+$/);
                asserted += 1;
            }
        }
        expect(asserted, "确实断言到了计数（防选择器空跑假绿）").toBeGreaterThanOrEqual(3);
    });

    /**
     * task-43（ui-2 batch-2 S 维）：筛选 chip 的选中态必须**进可访问树**。改前只有 class
     * （border-ring + bg-accent），`ariaSnapshot` 里四颗 chip 全是一样的 `- button "全部 3"`
     * ⇒ 读屏用户听不出当前筛选（WCAG 4.1.2）。
     *
     * <p>判据落在 **DOM 属性**上：同一时刻恰好一颗 `aria-pressed="true"`，且它随点击移动。
     * 形态是 `aria-pressed`（单选按下集合），**不是** tablist ⇒ 这里同时守「不混用」：
     * chip 上不得出现 `role=tab` / `aria-selected`。</p>
     */
    it("筛选 chip 的选中态由 aria-pressed 表达，且同时只有一颗为 true（task-43）", async () => {
        const wrapper = await mountView();
        const chips = () =>
            wrapper.get('[data-testid="scheduled-tasks-filters"]').findAll("button");
        const pressed = () =>
            chips()
                .filter((chip) => chip.attributes("aria-pressed") === "true")
                .map((chip) => chip.text().replace(/\s+/g, " ").trim());

        // 结构定位 + 计数守卫：本页两套断点 DOM 同时挂树，chip 内层 testid 只有一个（在共享
        // 头部之外的分支里没有再渲染一份），但断言仍先钉住「确实找到了四颗」（防空跑假绿）。
        expect(chips().length, "四颗筛选 chip 都要在树里").toBe(4);
        let asserted = 0;
        for (const chip of chips()) {
            expect(chip.attributes("aria-pressed"), "每颗 chip 都要有 aria-pressed").toMatch(
                /^(true|false)$/,
            );
            // 不混用第二套语义。
            expect(chip.attributes("role")).toBeUndefined();
            expect(chip.attributes("aria-selected")).toBeUndefined();
            asserted += 1;
        }
        expect(asserted, "确实断言到了 aria-pressed（防选择器空跑假绿）").toBe(4);

        // 初始：只有「全部」按下（filter 默认 all）。
        expect(pressed()).toEqual([expect.stringContaining("全部")]);

        // 点「待处理」⇒ pressed 移动到它，且仍只有一颗。
        await wrapper.get('[data-testid="scheduled-tasks-filter-pending"]').trigger("click");
        await nextTick();
        expect(pressed()).toEqual([expect.stringContaining("待处理")]);

        // 点回「全部」⇒ 回到初始态（证明是**移动**而不是累积）。
        await wrapper.get('[data-testid="scheduled-tasks-filter-all"]').trigger("click");
        await nextTick();
        expect(pressed()).toEqual([expect.stringContaining("全部")]);
        wrapper.unmount();
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
            rerun = wrapper.get('[data-testid="scheduled-task-rerun-row"]');

        expect(rerun.attributes("disabled")).toBeDefined();
        expect(rerun.attributes("title")).toContain("MANAGE_SCHEDULED_TASK");
        expect(
            wrapper.get('[data-testid="scheduled-task-remove-row"]').attributes("disabled"),
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
        await wrapper.get('[data-testid="scheduled-task-rerun-row"]').trigger("click");
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
        await wrapper.get('[data-testid="scheduled-task-remove-row"]').trigger("click");
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
        await wrapper.get('[data-testid="scheduled-task-cancel-row"]').trigger("click");
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
        await wrapper.get('[data-testid="scheduled-task-postpone-row"]').trigger("click");
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

        // PLAN-0676 T2：上游连接现在由 leader 层建立（选举含 50–150ms 抢占抖动），所以这里
        // 用 waitFor 轮询而不是假设"挂载后立即连"——断言本身不变，只是不再与实现时序耦合。
        await vi.waitFor(() =>
            expect(chatTransport.sendMessages).toHaveBeenCalledWith(
                "workspace:ws-1",
                expect.objectContaining({ url: "/api/v1/workspaces/ws-1/events" }),
            ),
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
