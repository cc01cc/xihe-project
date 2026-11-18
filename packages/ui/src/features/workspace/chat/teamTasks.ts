/**
 * task-188 S2（MVP⑤）：TeamBoard 口径 SSOT —— wire 类型之外的**全部判定只许出现在本文件**
 * （组件/ store 不复制第二份；纯函数层先例：delegationGraph.ts / runView.ts）。
 *
 * <p>契约 = ui-1/cp-1 W0 对齐读面（api.ts ApiTeamTask 14 字段，含 teamRootSessionId ——
 * 挡「非本队任务」必需）。ETA 字段确认无 schema 列，本层不做。</p>
 *
 * <p>纪律（settings-ui-issue-inventory ⑨ 类 + WorkspaceSkillsPanel 硬口径同源）：fail-closed —
 * 形状破坏行丢弃并计数；UI 再挡一层（foreign/deleted），挡了要记日志。</p>
 */
import type { ApiTeamTask } from "../../../composables/api";

export type TeamTaskWire = ApiTeamTask;

/** 契约 status 枚举（unknown 值在 normalize 里 fail-closed 丢弃并计数）。 */
export const TEAM_TASK_STATUSES = ["pending", "in_progress", "completed", "deleted"] as const;
export type TeamTaskStatus = (typeof TEAM_TASK_STATUSES)[number];

/** 行展示态：pending + !ready = blocked（琥珀），与方案 §2.2 映射表一一对应。 */
export type TeamBoardDisplayStatus = "pending" | "blocked" | "in_progress" | "completed";

export interface TeamBoardTaskView {
    taskId: string;
    taskNo: number;
    label: string;
    subject: string;
    description: string | null;
    displayStatus: TeamBoardDisplayStatus;
    ready: boolean;
    ownerName: string | null;
    blockedBy: string[];
    writeScopeWarnings: string[];
    createdAt: string;
    updatedAt: string;
}

export interface TeamBoardProjection {
    rows: TeamBoardTaskView[];
    /** taskId → taskNo 反查（含 deleted —— blockedBy 可能指向已删任务；foreign/malformed 不进）。 */
    taskNoById: Record<string, number>;
    droppedMalformed: number;
    droppedForeign: number;
    droppedDeleted: number;
}

function isPlainRecord(raw: unknown): raw is Record<string, unknown> {
    return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function isStringArray(raw: unknown): raw is string[] {
    return Array.isArray(raw) && raw.every((entry) => typeof entry === "string");
}

/**
 * fail-closed 归一化（先例：AgentPrincipalDetailDrawer.parseAdvisors「畸形行丢弃」、
 * WorkspaceSkillsPanel「UI 再挡一层」）：
 * 形状破坏（缺必需键/类型错/status 越界）→ droppedMalformed；非本队 → droppedForeign
 * （rootSessionId 为 null 时不做此挡 —— 调用方未知根会话，交给 CP 侧域校验）；
 * deleted 墓碑 → droppedDeleted（不进 rows，但进 taskNoById 供 blockedBy 链展示）。
 */
export function normalizeTeamTaskProjection(
    rawTasks: unknown[],
    rootSessionId: string | null,
): TeamBoardProjection {
    const rows: TeamBoardTaskView[] = [];
    const taskNoById: Record<string, number> = {};
    let droppedMalformed = 0,
        droppedForeign = 0,
        droppedDeleted = 0;

    for (const raw of rawTasks) {
        if (!isPlainRecord(raw) || typeof raw.taskId !== "string") {
            droppedMalformed += 1;
            continue;
        }
        if (
            typeof raw.teamRootSessionId !== "string" ||
            typeof raw.taskNo !== "number" ||
            !Number.isFinite(raw.taskNo) ||
            typeof raw.revision !== "number" ||
            typeof raw.subject !== "string" ||
            typeof raw.status !== "string" ||
            !(TEAM_TASK_STATUSES as readonly string[]).includes(raw.status) ||
            typeof raw.ready !== "boolean" ||
            !isStringArray(raw.blockedBy) ||
            !isStringArray(raw.writeScopeWarnings) ||
            typeof raw.createdAt !== "string" ||
            typeof raw.updatedAt !== "string"
        ) {
            droppedMalformed += 1;
            continue;
        }
        const wire = raw as unknown as TeamTaskWire;
        taskNoById[wire.taskId] = wire.taskNo;

        if (rootSessionId !== null && wire.teamRootSessionId !== rootSessionId) {
            droppedForeign += 1;
            continue;
        }
        if (wire.status === "deleted") {
            droppedDeleted += 1;
            continue;
        }
        rows.push({
            taskId: wire.taskId,
            taskNo: wire.taskNo,
            label: "task-" + wire.taskNo,
            subject: wire.subject,
            description: typeof wire.description === "string" ? wire.description : null,
            displayStatus:
                wire.status === "completed"
                    ? "completed"
                    : wire.status === "in_progress"
                      ? "in_progress"
                      : wire.ready
                        ? "pending"
                        : "blocked",
            ready: wire.ready,
            ownerName: typeof wire.ownerName === "string" ? wire.ownerName : null,
            blockedBy: wire.blockedBy,
            writeScopeWarnings: wire.writeScopeWarnings,
            createdAt: wire.createdAt,
            updatedAt: wire.updatedAt,
        });
    }

    rows.sort((a, b) => a.taskNo - b.taskNo);
    return { rows, taskNoById, droppedMalformed, droppedForeign, droppedDeleted };
}

/** 计数带（纯派生）：completed / in_progress / pending（blocked 计入 pending）。 */
export function countBoardTasks(rows: TeamBoardTaskView[]): {
    completed: number;
    inProgress: number;
    pending: number;
} {
    let completed = 0,
        inProgress = 0,
        pending = 0;
    for (const row of rows) {
        if (row.displayStatus === "completed") completed += 1;
        else if (row.displayStatus === "in_progress") inProgress += 1;
        else pending += 1;
    }
    return { completed, inProgress, pending };
}
