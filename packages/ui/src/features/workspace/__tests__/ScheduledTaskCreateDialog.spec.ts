import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import { setActivePinia, createPinia } from "pinia";
import ScheduledTaskCreateDialog from "../components/ScheduledTaskCreateDialog.vue";
import { api, ApiError } from "../../../composables/api";
import type * as apiModule from "../../../composables/api";
import { i18n } from "../../../i18n";
import type { ScheduledTask, ScheduledTaskCreateRequest } from "../../../types";

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message: string) => void>(),
        error: vi.fn<(message: string) => void>(),
    },
}));

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            createScheduledTask: vi.fn<typeof apiModule.api.createScheduledTask>(),
            getSessions: vi.fn<typeof apiModule.api.getSessions>(),
        },
    };
});

const mockedApi = vi.mocked(api, true);

function task(): ScheduledTask {
    return {
        id: "task-new",
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
    };
}

let wrappers: VueWrapper[] = [];

async function mountDialog(): Promise<VueWrapper> {
    const wrapper = mount(ScheduledTaskCreateDialog, {
        props: { open: true, workspaceId: "ws-1" },
        attachTo: document.body,
        global: { plugins: [i18n] },
    });
    wrappers.push(wrapper);
    await flushPromises();
    return wrapper;
}

function bodyEl<T extends Element>(selector: string): T | null {
    return document.body.querySelector(selector) as T | null;
}

async function clickBody(selector: string) {
    const el = bodyEl<HTMLElement>(selector);
    expect(el).toBeTruthy();
    el!.click();
    await nextTick();
}

async function setBodyValue(selector: string, value: string) {
    const input = bodyEl<HTMLInputElement>(selector);
    expect(input).toBeTruthy();
    input!.value = value;
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
}

async function selectBodyValue(selector: string, value: string) {
    const select = bodyEl<HTMLSelectElement>(selector);
    expect(select).toBeTruthy();
    select!.value = value;
    select!.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
}

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem("xihe-token", "mock-token");
    localStorage.setItem("xihe-user", JSON.stringify({ id: "user-1", email: "alice@example.com" }));
    setActivePinia(createPinia());
    mockedApi.getSessions.mockResolvedValue({
        sessions: [
            {
                id: "session-1",
                title: "Daily chat",
                createdAt: "2026-10-01T00:00:00Z",
                updatedAt: "2026-10-01T00:00:00Z",
                workspaceId: "ws-1",
            },
        ],
        workspace: undefined,
    } as never);
});

afterEach(() => {
    for (const wrapper of wrappers) wrapper.unmount();
    wrappers = [];
});

describe("ScheduledTaskCreateDialog", () => {
    it("creates a cron task with the entered expression and timezone", async () => {
        mockedApi.createScheduledTask.mockResolvedValue(task() as never);

        const wrapper = await mountDialog();
        await selectBodyValue('[data-testid="st-create-session"]', "session-1");
        await setBodyValue('[data-testid="st-create-cron-expr"]', "30 8 * * 1-5");
        await setBodyValue('[data-testid="st-create-timezone"]', "Asia/Shanghai");
        await setBodyValue('[data-testid="st-create-prompt"]', "Morning report");
        await clickBody('[data-testid="st-create-submit"]');
        await flushPromises();

        const body = mockedApi.createScheduledTask.mock.calls[0]![1] as ScheduledTaskCreateRequest;
        expect(body.triggerKind).toBe("cron");
        expect(body.cronExpr).toBe("30 8 * * 1-5");
        expect(body.timezone).toBe("Asia/Shanghai");
        expect(body.targetKind).toBe("session_wakeup");
        expect(body.targetSessionId).toBe("session-1");
        expect(body.prompt).toBe("Morning report");
        expect(wrapper.emitted("created")).toBeTruthy();
    });

    it("switches to delay mode and builds a future ISO instant", async () => {
        mockedApi.createScheduledTask.mockResolvedValue(task() as never);

        await mountDialog();
        await selectBodyValue('[data-testid="st-create-session"]', "session-1");
        await clickBody('[data-testid="st-create-mode-delay"]');
        await setBodyValue('[data-testid="st-create-delay-amount"]', "30");
        await setBodyValue('[data-testid="st-create-prompt"]', "Later report");
        const before = Date.now();
        await clickBody('[data-testid="st-create-submit"]');
        await flushPromises();

        const body = mockedApi.createScheduledTask.mock.calls[0]![1] as ScheduledTaskCreateRequest;
        expect(body.triggerKind).toBe("delay_once");
        expect(body.cronExpr).toBeUndefined();
        const at = new Date(body.at!).getTime();
        expect(at).toBeGreaterThanOrEqual(before + 30 * 60_000 - 1_000);
        expect(at).toBeLessThanOrEqual(Date.now() + 30 * 60_000 + 5_000);
    });

    it("shows an inline cron error for INVALID_CRON_EXPR", async () => {
        mockedApi.createScheduledTask.mockRejectedValue(
            new ApiError({
                status: 400,
                code: "INVALID_CRON_EXPR",
                detail: "bad expr",
                requestId: "r",
            }),
        );

        await mountDialog();
        await selectBodyValue('[data-testid="st-create-session"]', "session-1");
        await setBodyValue('[data-testid="st-create-cron-expr"]', "not a cron");
        await setBodyValue('[data-testid="st-create-prompt"]', "p");
        await clickBody('[data-testid="st-create-submit"]');
        await flushPromises();

        const error = bodyEl('[data-testid="st-create-field-error"]');
        expect(error?.textContent).toContain("cron 表达式无效");
    });

    it("shows the workspace-limit error for SCHEDULED_TASK_LIMIT", async () => {
        mockedApi.createScheduledTask.mockRejectedValue(
            new ApiError({
                status: 409,
                code: "SCHEDULED_TASK_LIMIT",
                detail: "limit",
                requestId: "r",
            }),
        );

        await mountDialog();
        await selectBodyValue('[data-testid="st-create-session"]', "session-1");
        await setBodyValue('[data-testid="st-create-cron-expr"]', "0 9 * * *");
        await setBodyValue('[data-testid="st-create-prompt"]', "p");
        await clickBody('[data-testid="st-create-submit"]');
        await flushPromises();

        const error = bodyEl('[data-testid="st-create-form-error"]');
        expect(error?.textContent).toContain("50");
    });

    it("blocks a delay beyond the 7-day TTL before calling the API", async () => {
        await mountDialog();
        await clickBody('[data-testid="st-create-mode-delay"]');
        await setBodyValue('[data-testid="st-create-delay-amount"]', "8");
        await clickBody('[data-testid="st-create-delay-unit"]');
        const unitSelect = bodyEl<HTMLSelectElement>('[data-testid="st-create-delay-unit"]');
        unitSelect!.value = "days";
        unitSelect!.dispatchEvent(new Event("change", { bubbles: true }));
        await nextTick();
        await setBodyValue('[data-testid="st-create-prompt"]', "p");
        await clickBody('[data-testid="st-create-submit"]');
        await nextTick();

        expect(mockedApi.createScheduledTask).not.toHaveBeenCalled();
        expect(bodyEl('[data-testid="st-create-field-error"]')?.textContent).toContain("TTL");
    });
});
