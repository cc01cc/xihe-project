/**
 * task-188 S2/S3（MVP⑤）：team_tasks 只读板的会话域 store。
 *
 * <p>刷新机制（方案 §3，「不新增 SSE」硬约束下的选型落地）：</p>
 * <ul>
 *   <li><b>主路径</b>：既有 derived_state_changed hint —— useSSE（useSSE.ts:466）收到后调
 *       notifySessionEvent，sessionEvents.ts（PLAN-0507 进程内总线）分发给本 store 重读投影。
 *       不开新 SSE 连接、不登记新 event kind；CP 侧仅对既有 kind 多推（cp-1 W0 对齐 ③）。</li>
 *   <li><b>兜底</b>：可见性感知轮询（30 s，document hidden 即停；hint 到达不重置计时器 —
 *       定时器本身已去抖同刻触发，靠 inFlight 去重）。</li>
 *   <li><b>去重</b>：inFlight 期间的重入直接丢弃，慢轮询不争抢（方案 §3-3）。</li>
 * </ul>
 *
 * <p>只读裁定（D-1821）：本 store 只有 GET 消费 + 本地状态，零写方法。</p>
 */
import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { ApiError, api } from "../composables/api";
import { logger } from "@/lib/logger";
import {
    countBoardTasks,
    normalizeTeamTaskProjection,
    type TeamBoardTaskView,
} from "../features/workspace/chat/teamTasks";
import { onSessionSignals } from "../features/workspace/chat/sessionEvents";

export const TEAM_TASKS_POLL_INTERVAL_MS = 30000;

export interface TeamTasksDropped {
    malformed: number;
    foreign: number;
    deleted: number;
}

export const useTeamTasksStore = defineStore("teamTasks", () => {
    const rows = ref<TeamBoardTaskView[]>([]);
    const taskNoById = ref<Record<string, number>>({});
    const dropped = ref<TeamTasksDropped>({ malformed: 0, foreign: 0, deleted: 0 });
    /** 仅首载为 true；增量刷新保留旧行（面板不闪烁）。 */
    const loading = ref(false);
    /** 已解析的用户文案（configure 注入 presentError）；null = 无错误。 */
    const error = ref<string | null>(null);

    const counts = computed(() => countBoardTasks(rows.value));
    /** ChatPanel 挂载判据：有任务或出过错才渲染板（空队不抢注意力预算）。 */
    const hasContent = computed(() => rows.value.length > 0 || error.value !== null);

    let attachedSessionId: string | null = null;
    let rootSessionId: string | null = null;
    let detachSignals: (() => void) | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let inFlight = false;
    let initialized = false;
    let presentError: (cause: unknown) => string = (cause) =>
        cause instanceof Error ? cause.message : String(cause);

    /** 错误文案解析器注入（组件侧用 presentCauseError + i18n 装配）。 */
    function configure(options: { presentError?: (cause: unknown) => string } = {}): void {
        if (options.presentError) presentError = options.presentError;
    }

    async function refresh(): Promise<void> {
        const sessionId = attachedSessionId;
        if (!sessionId || inFlight) return;
        inFlight = true;
        if (!initialized) loading.value = true;
        try {
            const raw = await api.getSessionTeamTasks(sessionId);
            // 守卫：等待期间可能已切会话/卸载（vue skill 硬约束同款 —— 不回填旧会话数据）。
            if (sessionId !== attachedSessionId) return;
            const projection = normalizeTeamTaskProjection(raw, rootSessionId);
            rows.value = projection.rows;
            taskNoById.value = projection.taskNoById;
            dropped.value = {
                malformed: projection.droppedMalformed,
                foreign: projection.droppedForeign,
                deleted: projection.droppedDeleted,
            };
            if (
                projection.droppedMalformed +
                    projection.droppedForeign +
                    projection.droppedDeleted >
                0
            ) {
                // 挡了要说（WorkspaceSkillsPanel 纪律）：debug 级，上用户面的是计数三态本身。
                logger.debug("team_tasks_projection_filtered", dropped.value);
            }
            error.value = null;
            initialized = true;
        } catch (cause) {
            if (sessionId !== attachedSessionId) return;
            // 404 = 端点未登记（旧 CP / 未挂该路由的 mock 车道）⇒ 按「本队无板」处理并留 warn，
            // 不上错误横幅 —— N1 针对的是读面存在时的失败；端点缺席时挂横幅会让 mock 车道
            // 每会话都出假错误。其余失败（5xx/403/形状破坏）照旧显式。
            if (cause instanceof ApiError && cause.problem.status === 404) {
                logger.warn("team_tasks_endpoint_missing", { sessionId });
                error.value = null;
                initialized = true;
                return;
            }
            error.value = presentError(cause);
        } finally {
            inFlight = false;
            loading.value = false;
        }
    }

    /** 轮询 tick：页面不可见即跳过一次（可见性感知轮询裁定的落点；可单测）。 */
    function pollTick(): void {
        if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
        void refresh();
    }

    function startPolling(): void {
        stopPolling();
        pollTimer = setInterval(pollTick, TEAM_TASKS_POLL_INTERVAL_MS);
    }

    function stopPolling(): void {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    /**
     * 挂到某会话：订信号总线（主）+ 开轮询（兜底）+ 首刷。
     * rootSessionId 未知（child 会话视图且委派树未解析）时传 undefined —— 此时不做 foreign 挡。
     */
    function attach(sessionId: string, options: { rootSessionId?: string | null } = {}): void {
        const nextRoot = options.rootSessionId ?? null;
        if (attachedSessionId === sessionId && rootSessionId === nextRoot) return;
        detach();
        attachedSessionId = sessionId;
        rootSessionId = nextRoot;
        initialized = false;
        rows.value = [];
        taskNoById.value = {};
        dropped.value = { malformed: 0, foreign: 0, deleted: 0 };
        error.value = null;
        detachSignals = onSessionSignals(sessionId, { onData: () => void refresh() });
        startPolling();
        void refresh();
    }

    function detach(): void {
        detachSignals?.();
        detachSignals = null;
        stopPolling();
        attachedSessionId = null;
        inFlight = false;
    }

    return {
        rows,
        taskNoById,
        dropped,
        loading,
        error,
        counts,
        hasContent,
        configure,
        attach,
        detach,
        refresh,
        pollTick,
    };
});
