import { describe, expect, it } from "vitest";
import type { ApiTeamTask } from "../../../../composables/api";
import { countBoardTasks, normalizeTeamTaskProjection } from "../teamTasks";

/**
 * task-188 S2 L0-S1：teamTasks.ts SSOT 纯函数。
 * 反假绿对应：N3（墓碑过滤）、N4（他队任务上屏）、N5（blocked 映射）、S7（形状漂移 fail-closed）。
 */

const ROOT = "11111111-1111-4111-8111-111111111111";
const OTHER_ROOT = "22222222-2222-4222-8222-222222222222";
const TASK_1 = "aaaaaaaa-0000-4000-8000-000000000001";
const TASK_2 = "aaaaaaaa-0000-4000-8000-000000000002";
const TASK_3 = "aaaaaaaa-0000-4000-8000-000000000003";

function wireTask(overrides: Partial<ApiTeamTask> = {}): ApiTeamTask {
    return {
        taskId: TASK_1,
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

describe("normalizeTeamTaskProjection", () => {
    it("maps statuses per §2.2 (pending/blocked/in_progress/completed)", () => {
        const projection = normalizeTeamTaskProjection(
            [
                wireTask(),
                wireTask({ taskId: TASK_2, taskNo: 2, ready: false, blockedBy: [TASK_1] }),
                wireTask({ taskId: TASK_3, taskNo: 3, status: "in_progress", ownerName: "ui-2" }),
                wireTask({ taskNo: 4, status: "completed" }),
            ],
            ROOT,
        );
        expect(projection.rows.map((row) => row.displayStatus)).toEqual([
            "pending",
            "blocked",
            "in_progress",
            "completed",
        ]);
        expect(projection.rows[1].label).toBe("task-2");
        expect(projection.rows[2].ownerName).toBe("ui-2");
    });

    it("keeps deleted tombstones out of rows but in taskNoById (N3)", () => {
        const projection = normalizeTeamTaskProjection(
            [wireTask(), wireTask({ taskId: TASK_2, taskNo: 2, status: "deleted" })],
            ROOT,
        );
        expect(projection.rows).toHaveLength(1);
        expect(projection.droppedDeleted).toBe(1);
        // blockedBy 可能指向墓碑：反查表必须仍含 taskNo。
        expect(projection.taskNoById[TASK_2]).toBe(2);
    });

    it("drops foreign-root rows when rootSessionId is known (N4)", () => {
        const projection = normalizeTeamTaskProjection(
            [wireTask(), wireTask({ taskId: TASK_2, taskNo: 2, teamRootSessionId: OTHER_ROOT })],
            ROOT,
        );
        expect(projection.rows).toHaveLength(1);
        expect(projection.droppedForeign).toBe(1);
        expect(projection.rows.some((row) => row.taskId === TASK_2)).toBe(false);
    });

    it("skips the foreign filter when rootSessionId is null (unknown root)", () => {
        const projection = normalizeTeamTaskProjection(
            [wireTask({ teamRootSessionId: OTHER_ROOT })],
            null,
        );
        expect(projection.rows).toHaveLength(1);
        expect(projection.droppedForeign).toBe(0);
    });

    it("drops malformed rows fail-closed and counts them (S7)", () => {
        const projection = normalizeTeamTaskProjection(
            [
                wireTask(),
                { ...wireTask({ taskId: TASK_2, taskNo: 2 }), subject: undefined },
                { ...wireTask({ taskId: TASK_3, taskNo: 3 }), status: "in_review" },
                null,
                "garbage",
            ],
            ROOT,
        );
        expect(projection.rows).toHaveLength(1);
        expect(projection.droppedMalformed).toBe(4);
    });

    it("sorts rows by taskNo", () => {
        const projection = normalizeTeamTaskProjection(
            [wireTask({ taskNo: 7 }), wireTask({ taskId: TASK_2, taskNo: 3 })],
            ROOT,
        );
        expect(projection.rows.map((row) => row.taskNo)).toEqual([3, 7]);
    });
});

describe("countBoardTasks", () => {
    it("counts completed/in_progress/pending with blocked folded into pending", () => {
        const { rows } = normalizeTeamTaskProjection(
            [
                wireTask({ status: "completed" }),
                wireTask({ taskId: TASK_2, taskNo: 2, status: "in_progress" }),
                wireTask({ taskId: TASK_3, taskNo: 3, ready: false }),
            ],
            ROOT,
        );
        expect(countBoardTasks(rows)).toEqual({ completed: 1, inProgress: 1, pending: 1 });
    });
});
