import { describe, expect, it } from "vitest";
import {
    computeWorkbenchSqueeze,
    MAIN_MIN_WIDTH,
    TREE_COLLAPSED_WIDTH,
} from "../useWorkspaceLayout";

/**
 * task-504 A 步（D-1413 同族）：挤压模型的输入必须是**实测行宽**。
 *
 * <p>这两条用例把「缺陷」与「修法」钉在一起：同一个渲染态（树折叠 40、dock floating、导航 240），
 * 只换**行宽来源**，结论就必须相反 —— 派生值 728 认为 main 688 ≥ 640 不让位（旧行为，DOM 里其实 621），
 * 实测值 661 得到 main 621 < 640 ⇒ 导航让位（新行为）。</p>
 */
const baseInput = {
    treeCollapsed: true,
    treeWidth: 240,
    dockWidth: 360,
    dockOpen: false,
    dockMode: "floating" as const,
    navPanelWidth: 240,
};

describe("task-504 挤压模型要吃实测行宽", () => {
    it("派生行宽 728（旧口径）⇒ 不让位：这就是缺陷本身", () => {
        const result = computeWorkbenchSqueeze({ ...baseInput, workbenchWidth: 728 });
        expect(728 - TREE_COLLAPSED_WIDTH).toBeGreaterThanOrEqual(MAIN_MIN_WIDTH);
        expect(result.navYielded).toBe(false);
        expect(result.mainWidth).toBe(688);
    });

    it("实测行宽 661（1024 档 DOM 读数）⇒ main 621 < 640 ⇒ 导航让位", () => {
        const result = computeWorkbenchSqueeze({ ...baseInput, workbenchWidth: 661 });
        expect(result.navYielded).toBe(true);
        // 让位后 main = 621 + 导航面板 240（整列收成 56px rail 的语义由渲染层负责）
        expect(result.mainWidth).toBe(621 + 240);
    });

    it("实测行宽足够时不让位（避免把「有实测」变成「总是让位」）", () => {
        const result = computeWorkbenchSqueeze({ ...baseInput, workbenchWidth: 1000 });
        expect(result.navYielded).toBe(false);
        expect(result.mainWidth).toBe(1000 - TREE_COLLAPSED_WIDTH);
    });
});
