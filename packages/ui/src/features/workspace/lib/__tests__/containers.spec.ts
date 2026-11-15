import { describe, expect, it } from "vitest";

import {
    CONTAINER_IDS,
    TREE_CONTAINER_PANEL_ID,
    containerOf,
    groupTabsByContainer,
} from "../containers";

describe("containerOf（task-174 S2b：容器归属的唯一映射）", () => {
    it("文件树面板归 tree 容器", () => {
        expect(containerOf(TREE_CONTAINER_PANEL_ID)).toBe("tree");
    });

    it("页面/会话/面板一律归 main 容器", () => {
        for (const id of ["code", "changes", "monitor", "members", "delegation", "session:s1"]) {
            expect(containerOf(id)).toBe("main");
        }
    });

    it("CONTAINER_IDS 就是两组，顺序 = 渲染顺序（树在左）", () => {
        expect(CONTAINER_IDS).toEqual(["tree", "main"]);
    });
});

describe("groupTabsByContainer", () => {
    it("保持入参顺序：顺序由布局单一 writer 决定，这里只归类", () => {
        const grouped = groupTabsByContainer([
            { id: "session:s2" },
            { id: TREE_CONTAINER_PANEL_ID },
            { id: "session:s1" },
        ]);
        expect(grouped.main.map((tab) => tab.id)).toEqual(["session:s2", "session:s1"]);
        expect(grouped.tree.map((tab) => tab.id)).toEqual([TREE_CONTAINER_PANEL_ID]);
    });

    it("空输入返回两个空数组（调用方无需判空即可遍历 CONTAINER_IDS）", () => {
        const grouped = groupTabsByContainer([]);
        expect(CONTAINER_IDS.map((id) => grouped[id])).toEqual([[], []]);
    });

    /**
     * task-174 判据④的**替代读数**（Lead 2026-11-15 裁定走乙：跨容器拖拽是 dockview 能力，
     * 默认路径没有 DnD ⇒ 把「拖拽通道未验证」与「派生逻辑错误」分开，这里证明后者）。
     * 同一份 tabs 输入变化时，两边的集合**各自**更新：树容器不受内容容器增减影响，反之亦然。
     */
    it("c4 替代：tabs 输入变化时两边集合各自更新（互不串扰）", () => {
        const before = groupTabsByContainer([
            { id: "session:s1" },
            { id: TREE_CONTAINER_PANEL_ID },
        ]);
        const after = groupTabsByContainer([
            { id: "session:s1" },
            { id: "session:s2" },
            { id: TREE_CONTAINER_PANEL_ID },
        ]);
        // 内容容器：新增一个页签 ⇒ 集合变大；树容器：一字不动。
        expect(after.main.map((tab) => tab.id)).toEqual(["session:s1", "session:s2"]);
        expect(after.tree.map((tab) => tab.id)).toEqual(before.tree.map((tab) => tab.id));
        // 反向：树面板被关掉时，内容容器不受影响。
        const noTree = groupTabsByContainer([{ id: "session:s1" }, { id: "session:s2" }]);
        expect(noTree.tree).toEqual([]);
        expect(noTree.main.map((tab) => tab.id)).toEqual(["session:s1", "session:s2"]);
    });

    it("每个页签恰好落在一个容器里（不漏不重）", () => {
        const tabs = ["tree", "code", "monitor", "session:s9"].map((id) => ({ id }));
        const grouped = groupTabsByContainer(tabs);
        const flat = CONTAINER_IDS.flatMap((id) => grouped[id].map((tab) => tab.id));
        expect(flat.sort()).toEqual(tabs.map((tab) => tab.id).sort());
    });
});
