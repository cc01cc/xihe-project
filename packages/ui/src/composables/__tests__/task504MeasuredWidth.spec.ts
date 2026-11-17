import { describe, expect, it } from "vitest";
import {
    computeWorkbenchSqueeze,
    MAIN_COMFORT_MIN_WIDTH,
    MAIN_MIN_WIDTH,
} from "../useWorkspaceLayout";

/**
 * task-504 A 步（D-1413 同族）：挤压模型的输入必须是**实测行宽**，不能是派生值。
 *
 * <p>**task-94 S2 后口径变了**：树不再占行宽（它是右栏的一个面板），所以这条用例原先靠树项拉开的
 * 差值（688 vs 621）不存在了，改成直接用右栏宽守同一个缺陷：同一个渲染态（右栏 360 开、会话列已收），
 * 只换行宽来源 —— 派生 1000 ⇒ main 恰好 640（两栏，不让位）；实测 961 ⇒ main 601（<640 ⇒ 单栏）。</p>
 *
 * <p>这条用例守的不是数字，而是**「模型信实测」**：只要有人把实测行宽这一路丢掉、改回自己算，
 * 结论就会翻回去（从「该切单栏」翻成「两栏刚好够」）。</p>
 */
const baseInput = { dockWidth: 360, dockOpen: true };

describe("task-504 挤压模型要吃实测行宽", () => {
    it("派生行宽 1000（旧口径）⇒ main 恰好 640 ⇒ 两栏", () => {
        const result = computeWorkbenchSqueeze({ ...baseInput, workbenchWidth: 1000 });
        expect(1000 - 360).toBe(MAIN_MIN_WIDTH);
        expect(result.navYielded).toBe(false);
        expect(result.mainWidth).toBe(640);
        expect(result.forceSingleColumn).toBe(false);
    });

    it("实测行宽 961（1024 档 DOM 读数）⇒ main 601 < 640 ⇒ 切单栏", () => {
        const result = computeWorkbenchSqueeze({ ...baseInput, workbenchWidth: 961 });
        expect(result.mainWidth).toBe(601);
        expect(result.forceSingleColumn).toBe(true);
    });

    it("实测行宽足够时既不让位也不单栏（避免把「有实测」变成「总是让位」）", () => {
        const result = computeWorkbenchSqueeze({ ...baseInput, workbenchWidth: 1200 });
        expect(result.navYielded).toBe(false);
        expect(result.mainWidth).toBe(1200 - 360);
        expect(result.mainWidth).toBeGreaterThanOrEqual(MAIN_COMFORT_MIN_WIDTH);
        expect(result.forceSingleColumn).toBe(false);
    });
});
