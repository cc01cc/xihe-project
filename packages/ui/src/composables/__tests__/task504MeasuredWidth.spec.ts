import { describe, expect, it } from "vitest";
import {
    computeWorkbenchSqueeze,
    MAIN_COMFORT_MIN_WIDTH,
    MAIN_MIN_WIDTH,
} from "../useWorkspaceLayout";

/**
 * task-504 A 步（D-1413 同族）：挤压模型的输入必须是**实测行宽**，不能是派生值。
 *
 * <p>**D-1829 后口径又变了**：主列允许破 640（桌面不切单栏），所以「<640」不再翻形态，只是
 * 一个可报告的度量。这条用例守的不是数字，而是**「模型信实测」**：只要有人把实测行宽这一路
 * 丢掉、改回自己算，同样的输入就会算出不一样的 mainWidth（偏差会原样漏进破线提示的判据）。</p>
 */
const baseInput = { dockWidth: 360, dockOpen: true };

describe("task-504 挤压模型要吃实测行宽", () => {
    it("派生行宽 1000（旧口径）⇒ main 恰好 640 ⇒ 不破线", () => {
        const result = computeWorkbenchSqueeze({ ...baseInput, workbenchWidth: 1000 });
        expect(1000 - 360).toBe(MAIN_MIN_WIDTH);
        expect(result.navYielded).toBe(false);
        expect(result.mainWidth).toBe(640);
    });

    it("实测行宽 961（1024 档 DOM 读数）⇒ main 601 < 640 ⇒ 破线，但两栏仍同行（D-1829）", () => {
        const result = computeWorkbenchSqueeze({ ...baseInput, workbenchWidth: 961 });
        // 负例：主列宽原样返回（<640 不被任何第二出口改写）⇒ 上层据此给一次性提示。
        expect(result.mainWidth).toBe(601);
        expect(result.mainWidth).toBeLessThan(MAIN_MIN_WIDTH);
    });

    it("实测行宽足够时既不让位也不破线（避免把「有实测」变成「总是让位」）", () => {
        const result = computeWorkbenchSqueeze({ ...baseInput, workbenchWidth: 1200 });
        expect(result.navYielded).toBe(false);
        expect(result.mainWidth).toBe(1200 - 360);
        expect(result.mainWidth).toBeGreaterThanOrEqual(MAIN_COMFORT_MIN_WIDTH);
    });
});
