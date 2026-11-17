import { defineStore } from "pinia";
import { ref } from "vue";
import { ApiError, api } from "../../../composables/api";
import { i18n } from "../../../i18n";
import { presentCauseError, type ErrorPresentation } from "../../../lib/errorMessages";
import { logger } from "../../../lib/logger";
import type {
    ScheduledTask,
    ScheduledTaskCreateRequest,
    ScheduledTaskDisposeResult,
    WorkspaceEvent,
} from "../../../types";

/**
 * task-67：列表加载失败是**诊断面**（持久在屏的错误卡），所以要留住整份呈现
 * （`{ copy, code, technicalDetail }`）而不只是 `copy`。
 *
 * <p>为什么不能只存文案：本页兜底文案是 `errors.unknownCode`（"…联系管理员并**提供错误码**"），
 * 而只存 `copy` 时界面拿不到 `code` ⇒ 文案要求用户做一件界面没提供的事（task-67 实测
 * `main.innerText` 里 `hasCode=false`，同一横幅自相矛盾）。原始 detail 仍由调用点的
 * `logger.warn` cause 留痕；这里多存的 `code`/`technicalDetail` 只用于诊断面渲染。</p>
 */
function errorPresentation(cause: unknown, fallback: string): ErrorPresentation {
    return presentCauseError(i18n.global.t, cause, fallback);
}

/**
 * RFC 9457 `code` → i18n key（openapi scheduled-tasks 错误表）。
 *
 * D-1706: CP declares one code per trigger/action parameter, so each missing parameter has its own
 * sentence instead of the shared "triggerKind and targetKind are required". An unmapped code still
 * degrades to `code: detail` (below), so a brand-new server code is visible rather than silent.
 */
const SCHEDULED_TASK_ERROR_KEYS: Record<string, string> = {
    INVALID_CRON_EXPR: "errInvalidCronExpr",
    INVALID_TIMEZONE: "errInvalidTimezone",
    INVALID_INTERVAL: "errInvalidInterval",
    SCHEDULED_TASK_AT_REQUIRED: "errAtRequired",
    SCHEDULED_TASK_TARGET_SESSION_REQUIRED: "errTargetSessionRequired",
    SCHEDULED_TASK_PROMPT_REQUIRED: "errPromptRequired",
    SCHEDULED_TASK_PAYLOAD_REQUIRED: "errPayloadRequired",
    SCHEDULED_TASK_LIMIT: "errLimit",
    SCHEDULED_TASK_PRINCIPAL_LIMIT: "errPrincipalLimit",
    SCHEDULED_TASK_STATE: "errState",
    INVALID_REQUEST: "errInvalidRequest",
    FORBIDDEN: "errForbidden",
    SCHEDULED_TASK_NOT_FOUND: "errNotFound",
};

export function scheduledTaskErrorText(t: (key: string) => string, cause: unknown): string {
    const code = cause instanceof ApiError ? cause.problem.code : undefined;
    const key = code === undefined ? undefined : SCHEDULED_TASK_ERROR_KEYS[code];
    if (key) return t(`workspace.scheduledTasks.${key}`);
    // task-45：码表之外的码不再拼 `CODE: english detail`，统一走可读文案入口。
    return presentCauseError(t, cause, t("workspace.scheduledTasks.actionFailed")).copy;
}

/**
 * 处置权（0486 #10）的客户端近似：读 DTO `createdBy` 只投影 principal 名 + 类型，
 * 不含 user/principal id，UI 无法核验 `MANAGE_SCHEDULED_TASK` grant。fail-closed：
 * 仅 human 创建者（createdBy.name 命中当前用户 name/email）启用处置，其余禁用并
 * 提示所需授权；CP 仍是权威（无权时 403 可见）。
 */
export function canManageScheduledTask(
    task: ScheduledTask,
    user: { name?: string; email: string } | null,
): boolean {
    if (!user || task.createdBy.type !== "human") return false;
    const name = task.createdBy.name;
    if (!name) return false;
    return name === user.name || name === user.email;
}

export const useScheduledTasksStore = defineStore("scheduledTasks", () => {
    const tasks = ref<ScheduledTask[]>([]),
        loading = ref(false),
        /** task-67：诊断面需要 `code`/`technicalDetail`，故存整份呈现（不是单个字符串）。 */
        error = ref<ErrorPresentation | null>(null),
        loadedWorkspaceId = ref<string | null>(null),
        mutatingTaskId = ref<string | null>(null);
    let storeGeneration = 0,
        inFlight: Promise<ScheduledTask[] | null> | null = null;

    function upsert(task: ScheduledTask) {
        const index = tasks.value.findIndex((item) => item.id === task.id);
        if (index >= 0) tasks.value.splice(index, 1, task);
        else tasks.value.unshift(task);
    }

    async function fetchScheduledTasks(
        workspaceId: string,
        options: { force?: boolean } = {},
    ): Promise<ScheduledTask[] | null> {
        if (!workspaceId) return null;
        if (!options.force && loadedWorkspaceId.value === workspaceId && !error.value) {
            return tasks.value;
        }
        if (inFlight && !options.force) return inFlight;
        if (inFlight && options.force) {
            await inFlight.catch(() => null);
        }

        const requestGeneration = storeGeneration;
        loading.value = true;
        const request = (async (): Promise<ScheduledTask[] | null> => {
            try {
                const page = await api.listScheduledTasks(workspaceId, { size: 200 });
                if (requestGeneration !== storeGeneration) return null;
                tasks.value = page.tasks;
                loadedWorkspaceId.value = workspaceId;
                error.value = null;
                return tasks.value;
            } catch (cause) {
                if (requestGeneration === storeGeneration) {
                    error.value = errorPresentation(cause, i18n.global.t("errors.requestFailed"));
                    logger.warn("Failed to load scheduled tasks", cause);
                }
                return null;
            } finally {
                // force refetch 会先等旧 inFlight 再替换 inFlight 引用；
                // 只清掉仍是自己的槽位，避免误清新一轮请求。
                if (requestGeneration === storeGeneration) loading.value = false;
            }
        })();
        inFlight = request;
        void request.finally(() => {
            if (inFlight === request) inFlight = null;
        });
        return request;
    }

    /** WorkspaceEvent 驱动的失效刷新（决策 #1：粗粒度事件，收到即 refetch）。 */
    function applyWorkspaceEvent(workspaceId: string, event: WorkspaceEvent) {
        if (workspaceId !== loadedWorkspaceId.value) return;
        if (event.kind === "scheduled_tasks_changed" || event.kind === "snapshot_required") {
            void fetchScheduledTasks(workspaceId, { force: true });
        }
    }

    async function createTask(
        workspaceId: string,
        body: ScheduledTaskCreateRequest,
    ): Promise<ScheduledTask> {
        const created = await api.createScheduledTask(workspaceId, body);
        upsert(created);
        return created;
    }

    async function rerunTask(workspaceId: string, task: ScheduledTask): Promise<ScheduledTask> {
        mutatingTaskId.value = task.id;
        try {
            const fresh = await api.rerunScheduledTask(workspaceId, task.id);
            upsert(fresh);
            return fresh;
        } finally {
            mutatingTaskId.value = null;
        }
    }

    /** 幂等：已 cancelled 时后端返回 `{changed:false}`，UI 仍刷新展示。 */
    async function removeTask(
        workspaceId: string,
        task: ScheduledTask,
    ): Promise<ScheduledTaskDisposeResult> {
        mutatingTaskId.value = task.id;
        try {
            const result = await api.removeScheduledTask(workspaceId, task.id);
            upsert(result.task);
            return result;
        } finally {
            mutatingTaskId.value = null;
        }
    }

    async function postponeTask(
        workspaceId: string,
        task: ScheduledTask,
        at: string,
    ): Promise<ScheduledTask> {
        mutatingTaskId.value = task.id;
        try {
            const fresh = await api.postponeScheduledTask(workspaceId, task.id, at);
            upsert(fresh);
            return fresh;
        } finally {
            mutatingTaskId.value = null;
        }
    }

    /** DELETE：scheduled→cancelled；missed/expired 走 removeTask（后端 409 指引）。 */
    async function cancelTask(
        workspaceId: string,
        task: ScheduledTask,
    ): Promise<ScheduledTaskDisposeResult> {
        mutatingTaskId.value = task.id;
        try {
            const result = await api.deleteScheduledTask(workspaceId, task.id);
            upsert(result.task);
            return result;
        } finally {
            mutatingTaskId.value = null;
        }
    }

    function clearForUserSwitch() {
        storeGeneration += 1;
        tasks.value = [];
        error.value = null;
        loadedWorkspaceId.value = null;
        mutatingTaskId.value = null;
        inFlight = null;
    }

    return {
        tasks,
        loading,
        error,
        loadedWorkspaceId,
        mutatingTaskId,
        fetchScheduledTasks,
        applyWorkspaceEvent,
        createTask,
        rerunTask,
        removeTask,
        postponeTask,
        cancelTask,
        clearForUserSwitch,
    };
});
