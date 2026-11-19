/**
 * task-146：team-board 真挂载读数用的 mock 任务投影夹具。
 *
 * <p>为什么需要：`ChatPanel.vue:1788` 用 `v-if="teamTasksStore.hasContent"` 挂载看板，
 * 真栈所有可得会话的 `team_tasks` 都是空集合，且 CP 只有读端点
 * （`TeamTaskController.java:34` GET 列表 / `:48` GET 单条，**无写端点**）⇒ 真栈造不出任务卡。
 * 预览车道此前也硬回 `{ tasks: [] }`（"合法空集，不伪造行"），于是看板在两条车道上都挂不起来。</p>
 *
 * <p>本夹具口径：**只给 S1 一份非空投影**，其余会话仍走合法空集（空态是真实形态，不能被抹掉）。
 * 字段集照 `ApiTeamTask`（api.ts:447，14 字段）与 `normalizeTeamTaskProjection`
 * （teamTasks.ts）的 fail-closed 判据，不发明字段；status 只取契约枚举
 * `pending | in_progress | completed | deleted`。</p>
 *
 * <p>行设计（覆盖看板的四种展示态 + 一条墓碑）：
 * completed / in_progress / pending+ready / pending+!ready（blocked，琥珀）/ deleted（只进
 * taskNoById，供 blockedBy 链展示，不进 rows）。</p>
 */
import type { ApiTeamTask } from "../../../composables/api";

/** 与 `data/sessions.ts` 的 S1 同一个会话（预制夹具之间不各造一套 id）。 */
const S1 = "c1f0c4d2-7b3e-4c55-8f10-5d2c9b000101";
const T0 = "2026-11-13T09:00:00.000Z";

const TASK_PLAN_ID = "f1f0c4d2-7b3e-4c55-8f10-5d2c9b000501";
const TASK_SCHEMA_ID = "f1f0c4d2-7b3e-4c55-8f10-5d2c9b000502";
const TASK_DOCS_ID = "f1f0c4d2-7b3e-4c55-8f10-5d2c9b000503";
const TASK_E2E_ID = "f1f0c4d2-7b3e-4c55-8f10-5d2c9b000504";
const TASK_RETIRED_ID = "f1f0c4d2-7b3e-4c55-8f10-5d2c9b000505";

/** 与 `api.getSessionTeamTasks` 同形：`{ tasks: ApiTeamTask[] }`（api.ts:3482 的 tasks 数组）。 */
export const mockTeamTasks: Record<string, ApiTeamTask[]> = {
    [S1]: [
        {
            taskId: TASK_PLAN_ID,
            teamRootSessionId: S1,
            taskNo: 1,
            revision: 3,
            subject: "核定团队看板宽度口径（同列 token）",
            description: "看板根容器必须与 composer / 消息列共用 --chat-column-max。",
            status: "completed",
            ready: true,
            ownerSessionId: S1,
            ownerName: "lead",
            blockedBy: [],
            writeScopeWarnings: [],
            createdBySessionId: S1,
            createdAt: T0,
            updatedAt: "2026-11-13T09:22:00.000Z",
        },
        {
            taskId: TASK_SCHEMA_ID,
            teamRootSessionId: S1,
            taskNo: 2,
            revision: 2,
            subject: "补 team_tasks 只读投影字段（14 字段）",
            description: "含 teamRootSessionId，供 UI 挡非本队任务。",
            status: "in_progress",
            ready: true,
            ownerSessionId: S1,
            ownerName: "cp-1",
            blockedBy: [],
            writeScopeWarnings: [],
            createdBySessionId: S1,
            createdAt: T0,
            updatedAt: "2026-11-13T09:31:00.000Z",
        },
        {
            taskId: TASK_DOCS_ID,
            teamRootSessionId: S1,
            taskNo: 3,
            revision: 1,
            subject: "写看板空态与加载态文案",
            description: null,
            status: "pending",
            ready: true,
            ownerSessionId: null,
            ownerName: null,
            blockedBy: [],
            writeScopeWarnings: [],
            createdBySessionId: S1,
            createdAt: T0,
            updatedAt: T0,
        },
        {
            taskId: TASK_E2E_ID,
            teamRootSessionId: S1,
            taskNo: 4,
            revision: 1,
            subject: "真机读数：dock 开合 × 三视口左缘对齐",
            description: "判据：board / composer / 消息列三处左缘差为 0。",
            status: "pending",
            ready: false,
            ownerSessionId: null,
            ownerName: null,
            // 指向任务 3（未完成）⇒ 看板按 blocked（琥珀）渲染，与 normalize 的 pending+!ready 映射一致。
            blockedBy: [TASK_DOCS_ID],
            writeScopeWarnings: ["A03-xihe/packages/ui/src/features/workspace/chat"],
            createdBySessionId: S1,
            createdAt: T0,
            updatedAt: T0,
        },
        {
            taskId: TASK_RETIRED_ID,
            teamRootSessionId: S1,
            taskNo: 5,
            revision: 4,
            subject: "早期草案：看板独立栅格",
            description: "已作废（宽度与列 token 分叉，与 D-1910 冲突）。",
            status: "deleted",
            ready: true,
            ownerSessionId: null,
            ownerName: null,
            blockedBy: [],
            writeScopeWarnings: [],
            createdBySessionId: S1,
            createdAt: T0,
            updatedAt: "2026-11-13T09:40:00.000Z",
        },
    ],
};

/** 路由用：未知会话仍是合法空集（不伪造行）。 */
export function teamTasksOfSession(sessionId: string): ApiTeamTask[] {
    return mockTeamTasks[sessionId] ?? [];
}
