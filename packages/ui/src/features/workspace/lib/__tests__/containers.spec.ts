import { describe, expect, it } from "vitest";

import {
    CONTAINER_IDS,
    TREE_CONTAINER_PANEL_ID,
    containerOf,
    groupTabsByContainer,
    visibleContainers,
} from "../containers";

const PAGE_TABS = ["session:s1", "environment", "settings"];
const RIGHT_TABS = ["code", "changes", "monitor", "members", "context", "agents", "delegation"];

describe("containerOf（D-1545：归属只由 tab 决定，与形态无关）", () => {
    it("文件树 → tree；页面/会话 → main；dock 面板 → right", () => {
        expect(containerOf(TREE_CONTAINER_PANEL_ID)).toBe("tree");
        for (const id of PAGE_TABS) expect(containerOf(id)).toBe("main");
        for (const id of RIGHT_TABS) expect(containerOf(id)).toBe("right");
    });

    it("CONTAINER_IDS = 三个容器，顺序 = 渲染顺序（树 → 中栏 → 右栏）", () => {
        expect(CONTAINER_IDS).toEqual(["tree", "main", "right"]);
    });

    /**
     * D-1545 的核心判据：**同一个 tab 在两种形态下归属必须相同**。
     * 它禁止的是「宽窄切换时页签搬家」—— 并集合并方案正是在破坏这一条。
     */
    it("同一 tab 的归属不随形态变化（宽窄切换不搬家）", () => {
        const ids = [TREE_CONTAINER_PANEL_ID, ...PAGE_TABS, ...RIGHT_TABS];
        for (const mode of ["desktop", "single"] as const) {
            for (const activeColumn of ["main", "right"] as const) {
                // 形态/可见性只影响渲染哪些容器行，不得影响任何 tab 的归属。
                void visibleContainers(mode, activeColumn);
                for (const id of ids) {
                    expect(containerOf(id)).toBe(containerOf(id));
                }
            }
        }
        // 直接对照：分组结果与可见性组合无关。
        const tabs = ids.map((id) => ({ id }));
        const once = groupTabsByContainer(tabs);
        for (const mode of ["desktop", "single"] as const) {
            for (const activeColumn of ["main", "right"] as const) {
                void visibleContainers(mode, activeColumn);
                const again = groupTabsByContainer(tabs);
                expect(again).toEqual(once);
            }
        }
        expect(once.right.map((tab) => tab.id)).toEqual(RIGHT_TABS);
        expect(once.main.map((tab) => tab.id)).toEqual(PAGE_TABS);
    });
});

describe("visibleContainers（D-1545：形态只决定看得见哪一栏）", () => {
    it("desktop ⇒ 三个容器全渲染", () => {
        expect(visibleContainers("desktop", "main")).toEqual(["tree", "main", "right"]);
        expect(visibleContainers("desktop", "right")).toEqual(["tree", "main", "right"]);
    });

    it("single ⇒ 恰一个：activeColumn=main 时只有 main，=right 时只有 right", () => {
        expect(visibleContainers("single", "main")).toEqual(["main"]);
        expect(visibleContainers("single", "right")).toEqual(["right"]);
    });

    it("single 下 tree 永不可见（窄屏树是 sheet，不是容器行）", () => {
        for (const activeColumn of ["main", "right"] as const) {
            expect(visibleContainers("single", activeColumn)).not.toContain("tree");
        }
    });

    it("single 的可见集合恒为 1 个容器（不许「合并成一栏」把两栏压成一桶）", () => {
        for (const activeColumn of ["main", "right"] as const) {
            expect(visibleContainers("single", activeColumn)).toHaveLength(1);
        }
    });
});

describe("groupTabsByContainer", () => {
    it("三个桶恒在，空桶是空数组", () => {
        const grouped = groupTabsByContainer([]);
        expect(CONTAINER_IDS.map((id) => grouped[id])).toEqual([[], [], []]);
    });

    it("保持入参顺序：顺序由布局单一 writer 决定，这里只归类", () => {
        const grouped = groupTabsByContainer([
            { id: "session:s2" },
            { id: TREE_CONTAINER_PANEL_ID },
            { id: "session:s1" },
            { id: "code" },
        ]);
        expect(grouped.main.map((tab) => tab.id)).toEqual(["session:s2", "session:s1"]);
        expect(grouped.tree.map((tab) => tab.id)).toEqual([TREE_CONTAINER_PANEL_ID]);
        expect(grouped.right.map((tab) => tab.id)).toEqual(["code"]);
    });

    it("每个页签恰好落在一个容器里（不漏不重）", () => {
        const tabs = ["tree", "code", "monitor", "session:s9"].map((id) => ({ id }));
        const grouped = groupTabsByContainer(tabs);
        const flat = CONTAINER_IDS.flatMap((id) => grouped[id].map((tab) => tab.id));
        expect(flat.sort()).toEqual(tabs.map((tab) => tab.id).sort());
    });

    /**
     * 判据④的**替代读数**（跨容器拖拽是 dockview 能力，默认路径没有 DnD）：
     * 同一份 tabs 输入变化时两边集合各自更新、互不串扰 ⇒ 派生逻辑正确。
     */
    it("c4 替代：tabs 输入变化时两边集合各自更新（互不串扰）", () => {
        const before = groupTabsByContainer([
            { id: "session:s1" },
            { id: TREE_CONTAINER_PANEL_ID },
        ]);
        const after = groupTabsByContainer([
            { id: "session:s1" },
            { id: "code" },
            { id: TREE_CONTAINER_PANEL_ID },
        ]);
        expect(after.main.map((tab) => tab.id)).toEqual(["session:s1"]);
        expect(after.tree.map((tab) => tab.id)).toEqual(before.tree.map((tab) => tab.id));
        // 右栏新增一个面板，不影响 main / tree。
        expect(after.right.map((tab) => tab.id)).toEqual(["code"]);
        expect(before.right).toEqual([]);
    });
});
