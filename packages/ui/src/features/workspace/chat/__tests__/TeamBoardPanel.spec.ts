import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { i18n } from "../../../../i18n";
import type { ApiTeamTask } from "../../../../composables/api";
import { normalizeTeamTaskProjection } from "../teamTasks";
import TeamBoardPanel from "../components/TeamBoardPanel.vue";

/**
 * task-188 S2 L0-S3：TeamBoardPanel。
 * 反假绿断言表（方案 §4.2）组件级落地：N1/N2/N3/N5/N6/N8/N9/N10；
 * N4（他队过滤）与 N7（刷新触发）分别归 S1（normalize）/ S2（store）钉。
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

function mountPanel(props: { tasks: unknown[]; loading?: boolean; error?: string | null }) {
    const projection = normalizeTeamTaskProjection(props.tasks, ROOT);
    return mount(TeamBoardPanel, {
        props: {
            tasks: projection.rows,
            taskNoById: projection.taskNoById,
            dropped: {
                malformed: projection.droppedMalformed,
                foreign: projection.droppedForeign,
                deleted: projection.droppedDeleted,
            },
            loading: props.loading ?? false,
            error: props.error ?? null,
        },
        global: { plugins: [i18n] },
    });
}

const rowTestids = (wrapper: ReturnType<typeof mountPanel>) =>
    wrapper.findAll('[data-testid="team-board-row"]');

describe("TeamBoardPanel", () => {
    it("renders exactly one row per visible projection row — exact equality (N2)", () => {
        const wrapper = mountPanel({
            tasks: [
                wireTask(),
                wireTask({ taskId: TASK_2, taskNo: 2, status: "in_progress", ownerName: "ui-2" }),
                wireTask({ taskId: TASK_3, taskNo: 3, status: "completed" }),
            ],
        });
        expect(rowTestids(wrapper)).toHaveLength(3);
        const counts = wrapper.get('[data-testid="team-board-counts"]').text();
        expect(counts).toContain("1");
        expect(wrapper.find('[data-testid="team-board-legend"]').exists()).toBe(true);
        expect(wrapper.get('[data-testid="team-board-readonly-note"]').text()).toContain(
            i18n.global.t("teamBoard.readonlyNote"),
        );
    });

    it("hides deleted tombstones and foreign rows from the board (N3/N4)", () => {
        const wrapper = mountPanel({
            tasks: [
                wireTask(),
                wireTask({ taskId: TASK_2, taskNo: 2, status: "deleted" }),
                wireTask({ taskId: TASK_3, taskNo: 3, teamRootSessionId: OTHER_ROOT }),
            ],
        });
        // 3 行进、2 行被挡 ⇒ 恰好 1 行，精确等值（少一行即红）。
        expect(rowTestids(wrapper)).toHaveLength(1);
        expect(wrapper.find('[data-testid="team-board-row"][data-task-no="task-2"]').exists()).toBe(
            false,
        );
        expect(wrapper.find('[data-testid="team-board-row"][data-task-no="task-3"]').exists()).toBe(
            false,
        );
    });

    it("maps blocked rows to the amber blocked state (N5)", () => {
        const wrapper = mountPanel({
            tasks: [
                wireTask(),
                wireTask({ taskId: TASK_2, taskNo: 2, ready: false, blockedBy: [TASK_1] }),
            ],
        });
        const blockedRow = wrapper.get('[data-testid="team-board-row"][data-task-no="task-2"]');
        expect(blockedRow.get('[data-testid="team-board-status"]').attributes("data-status")).toBe(
            "blocked",
        );
        expect(blockedRow.find('[data-testid="team-board-blocked"]').exists()).toBe(true);
        const pendingRow = wrapper.get('[data-testid="team-board-row"][data-task-no="task-1"]');
        expect(pendingRow.get('[data-testid="team-board-status"]').attributes("data-status")).toBe(
            "pending",
        );
    });

    it("renders an explicit unowned label instead of a blank owner (N6)", () => {
        const wrapper = mountPanel({
            tasks: [wireTask(), wireTask({ taskId: TASK_2, taskNo: 2, ownerName: "ui-2" })],
        });
        expect(
            wrapper
                .get('[data-testid="team-board-row"][data-task-no="task-1"]')
                .find('[data-testid="team-board-unowned"]')
                .exists(),
        ).toBe(true);
        expect(
            wrapper
                .get('[data-testid="team-board-row"][data-task-no="task-2"]')
                .get('[data-testid="team-board-owner"]')
                .text(),
        ).toContain("ui-2");
    });

    it("error state is exclusive with empty/rows and offers retry (N1)", async () => {
        const wrapper = mountPanel({ tasks: [], error: "读面挂了" });
        expect(wrapper.find('[data-testid="team-board-error"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="team-board-retry"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="team-board-empty"]').exists()).toBe(false);
        expect(rowTestids(wrapper)).toHaveLength(0);

        await wrapper.get('[data-testid="team-board-retry"]').trigger("click");
        expect(wrapper.emitted("retry")).toHaveLength(1);
    });

    it("empty projection renders exactly one empty state — nothing else (N10)", () => {
        const wrapper = mountPanel({ tasks: [] });
        expect(wrapper.findAll('[data-testid="team-board-empty"]')).toHaveLength(1);
        expect(wrapper.find('[data-testid="team-board-error"]').exists()).toBe(false);
        expect(rowTestids(wrapper)).toHaveLength(0);
        // 空态必须有标题文案（不是一块空白）。
        expect(wrapper.get('[data-testid="team-board-empty"]').text()).toContain(
            i18n.global.t("teamBoard.emptyTitle"),
        );
    });

    it("loading renders skeletons exclusively（⑨ 类 H-06：禁灰字加载）", () => {
        const wrapper = mountPanel({ tasks: [], loading: true });
        expect(wrapper.find('[data-testid="team-board-loading"]').exists()).toBe(true);
        expect(rowTestids(wrapper)).toHaveLength(0);
        expect(wrapper.find('[data-testid="team-board-empty"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="team-board-error"]').exists()).toBe(false);
    });

    it("contains zero write controls — every button is expand/blocked-by/retry (N8)", () => {
        const wrapper = mountPanel({
            tasks: [
                wireTask({ blockedBy: [TASK_3] }),
                wireTask({ taskId: TASK_2, taskNo: 2, ready: false, blockedBy: [TASK_1] }),
            ],
        });
        const allowed = /^(team-board-expand|team-board-blocked-by-item-)/;
        const buttons = wrapper.findAll("button");
        expect(buttons.length).toBeGreaterThan(0);
        for (const button of buttons) {
            const testid = button.attributes("data-testid") ?? "";
            expect(testid).toMatch(allowed);
        }
    });

    it("keeps a 200-char subject row rendered with full text in title (N9)", () => {
        const longSubject = "长".repeat(200);
        const wrapper = mountPanel({ tasks: [wireTask({ subject: longSubject })] });
        const row = wrapper.get('[data-testid="team-board-row"]');
        const subject = row.get('[data-testid="team-board-subject"]');
        expect(subject.attributes("title")).toBe(longSubject);
        expect(row.text()).toContain(longSubject);
    });

    it("expands a row to description/dependencies/warnings/timestamps and emits navigate", async () => {
        const wrapper = mountPanel({
            tasks: [
                wireTask({
                    description: "先复现 409，再修重试预算。",
                    blockedBy: [TASK_3],
                    writeScopeWarnings: ["write scopes overlap with task-9"],
                }),
                wireTask({ taskId: TASK_3, taskNo: 3, status: "completed" }),
            ],
        });
        // reka CollapsibleContent 闭合时仍挂 DOM（hidden 属性；jsdom 无布局，isVisible 不可靠）
        // ⇒ 断言 hidden 属性的开合。
        expect(
            wrapper.find('[data-testid="team-board-detail"]').attributes("hidden"),
        ).toBeDefined();

        await wrapper.get('[data-testid="team-board-expand"]').trigger("click");
        await nextTick();
        await nextTick();

        const detail = wrapper.get('[data-testid="team-board-detail"]');
        expect(detail.attributes("hidden")).toBeUndefined();
        expect(detail.get('[data-testid="team-board-description"]').text()).toContain("先复现 409");
        expect(detail.find('[data-testid="team-board-timestamps"]').exists()).toBe(true);
        const warning = detail.get('[data-testid="team-board-scope-warning"]');
        expect(warning.text()).toContain("overlap");

        const dep = detail.get('[data-testid="team-board-blocked-by-item-' + TASK_3 + '"]');
        expect(dep.text()).toContain("task-3");
        await dep.trigger("click");
        expect(wrapper.emitted("navigate")).toEqual([[TASK_3]]);
    });

    it("force-opens the highlighted row for in-board dependency jumps (M2)", async () => {
        const wrapper = mountPanel({
            tasks: [
                wireTask({ blockedBy: [TASK_2] }),
                wireTask({ taskId: TASK_2, taskNo: 2, description: "被依赖的行" }),
            ],
        });
        // 未高亮时两行都闭合。
        expect(
            wrapper.find('[data-testid="team-board-detail"]').attributes("hidden"),
        ).toBeDefined();

        await wrapper.setProps({ highlightedTaskId: TASK_2 });
        await nextTick();
        await nextTick();

        const rows = wrapper.findAll('[data-testid="team-board-row"]');
        // 只有目标行走开（forceOpen 精确匹配 taskId）。
        const detailOfTarget = rows[1].find('[data-testid="team-board-detail"]');
        expect(detailOfTarget.exists()).toBe(true);
        expect(detailOfTarget.attributes("hidden")).toBeUndefined();
        expect(detailOfTarget.text()).toContain("被依赖的行");
        const detailOfOther = rows[0].find('[data-testid="team-board-detail"]');
        expect(detailOfOther.attributes("hidden")).toBeDefined();
    });

    it("renders an unknown dependency as a short-id fallback instead of dropping it", async () => {
        const wrapper = mountPanel({
            tasks: [
                wireTask({ ready: false, blockedBy: ["ffffffff-ffff-4fff-8fff-ffffffffffff"] }),
            ],
        });
        await wrapper.get('[data-testid="team-board-expand"]').trigger("click");
        await nextTick();
        await nextTick();
        const detail = wrapper.get('[data-testid="team-board-detail"]');
        expect(detail.attributes("hidden")).toBeUndefined();
        expect(
            detail
                .get(
                    '[data-testid="team-board-blocked-by-item-ffffffff-ffff-4fff-8fff-ffffffffffff"]',
                )
                .text(),
        ).toContain("ffffffff");
    });
});
