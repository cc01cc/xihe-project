import { describe, expect, it } from "vitest";

import {
    CONTAINER_IDS,
    FILES_PANEL_ID,
    containerOf,
    groupTabsByContainer,
    visibleContainers,
} from "../containers";

/**
 * task-65 A 段（`D-1777`/`D-1778`）：**容器只剩两个（main / right），树不再是容器**。
 * 树改成右栏的一个普通面板，面板 id = `files`（`containers.ts` 的 `FILES_PANEL_ID`）。
 *
 * <p>本文件此前按「三个容器（树 → 中栏 → 右栏）」断言，而 `containers.ts` 已收窄到两项 ⇒
 * 7 条用例全红（task-65 遗留漏项，task-144 顺手收账）。改法不是删断言，而是把判据换成
 * **两容器口径 + 树的面板身份**（`files → right`），并把「树不是容器」写成**可咬的判据**——
 * 否则下一个 lane 会把 `tree` 塞回 `CONTAINER_IDS` 而不红。</p>
 */
const PAGE_TABS = ["session:s1", "environment", "settings"];
/** 右栏面板值域 = `DOCK_TAB_IDS`（含 `files`；树的面板身份）。 */
const RIGHT_TABS = [
    FILES_PANEL_ID,
    "code",
    "changes",
    "monitor",
    "members",
    "context",
    "agents",
    "delegation",
];

describe("containerOf（D-1545：归属只由 tab 决定，与形态无关）", () => {
    it("文件树（files 面板）→ right；页面/会话 → main；其余 dock 面板 → right", () => {
        expect(containerOf(FILES_PANEL_ID)).toBe("right");
        for (const id of PAGE_TABS) expect(containerOf(id)).toBe("main");
        for (const id of RIGHT_TABS) expect(containerOf(id)).toBe("right");
    });

    /**
     * task-138（`D-1907` rev7/rev8）：**容器内页签** `pane:<container>:<view>[:<sid>]` 自带容器。
     *
     * 判据不是「能解析出容器」，而是「**同一个 view 在两栏的归属不同**」——
     * 那正是裸 id 表达不了、所以必须把容器写进 id 的那件事。
     */
    it("pane:<容器>:<view> 的归属取 id 里的容器，而不是 view 的默认归属", () => {
        expect(containerOf("pane:main:code")).toBe("main");
        expect(containerOf("pane:right:code")).toBe("right");
        // 同一个 view（code）落两栏 ⇒ 归属不同。
        expect(containerOf("pane:main:code")).not.toBe(containerOf("pane:right:code"));
        // 会话配置页签必须带 sid；sid 允许含冒号，容器仍取前缀那一段。
        expect(containerOf("pane:main:session-config:s1")).toBe("main");
        expect(containerOf("pane:right:session-config:s1:with:colons")).toBe("right");
        // 非法 pane（未知 view / 未知容器）不被当成右栏面板：回落到旧规则（main）。
        expect(containerOf("pane:main:not-a-view")).toBe("main");
        expect(containerOf("pane:left:code")).toBe("main");
        expect(containerOf("pane:")).toBe("main");
    });

    it("CONTAINER_IDS = 两个容器，顺序 = 渲染顺序（中栏 → 右栏）", () => {
        expect(CONTAINER_IDS).toEqual(["main", "right"]);
    });

    /**
     * D-1777/D-1778 的反面判据：树**不是**容器。
     * 只断言「文件树归属 right」不够 —— 那与「tree 仍是第三个容器、只是没人用」并存；
     * 这一条咬的是「三个容器」这个形态本身不许回来。
     */
    it("树不是容器：容器值域里没有 tree，且 files 面板归属右栏", () => {
        expect(CONTAINER_IDS).not.toContain("tree");
        expect(CONTAINER_IDS).toHaveLength(2);
        // 反向控制：换一个确实存在的容器 id 必须命中（防「永远 not.toContain 也绿」）。
        expect(CONTAINER_IDS).toContain("right");
    });

    /**
     * D-1545 的核心判据：**同一个 tab 在两种形态下归属必须相同**。
     * 它禁止的是「宽窄切换时页签搬家」—— 并集合并方案正是在破坏这一条。
     */
    it("同一 tab 的归属不随形态变化（宽窄切换不搬家）", () => {
        const ids = [...PAGE_TABS, ...RIGHT_TABS];
        const expected = new Map(ids.map((id) => [id, containerOf(id)]));
        for (const mode of ["desktop", "single"] as const) {
            for (const activeColumn of ["main", "right"] as const) {
                // 形态/可见性只影响渲染哪些容器行，不得影响任何 tab 的归属。
                void visibleContainers(mode, activeColumn);
                for (const id of ids) {
                    expect(containerOf(id)).toBe(expected.get(id));
                }
            }
        }
        // 直接对照：分组结果与可见性组合无关。
        const tabs = ids.map((id) => ({ id }));
        const once = groupTabsByContainer(tabs);
        for (const mode of ["desktop", "single"] as const) {
            for (const activeColumn of ["main", "right"] as const) {
                void visibleContainers(mode, activeColumn);
                expect(groupTabsByContainer(tabs)).toEqual(once);
            }
        }
        expect(once.right.map((tab) => tab.id)).toEqual(RIGHT_TABS);
        expect(once.main.map((tab) => tab.id)).toEqual(PAGE_TABS);
    });
});

describe("visibleContainers（D-1545：形态只决定看得见哪一栏）", () => {
    it("desktop ⇒ 两个容器全渲染", () => {
        expect(visibleContainers("desktop", "main")).toEqual(["main", "right"]);
        expect(visibleContainers("desktop", "right")).toEqual(["main", "right"]);
    });

    it("single ⇒ 恰一个：activeColumn=main 时只有 main，=right 时只有 right", () => {
        expect(visibleContainers("single", "main")).toEqual(["main"]);
        expect(visibleContainers("single", "right")).toEqual(["right"]);
    });

    it("single 下 files 面板不单独占一行（它是右栏面板，不是容器）", () => {
        for (const activeColumn of ["main", "right"] as const) {
            const visible = visibleContainers("single", activeColumn);
            expect(visible).not.toContain("tree");
            expect(visible).not.toContain(FILES_PANEL_ID);
        }
    });

    it("single 的可见集合恒为 1 个容器（不许「合并成一栏」把两栏压成一桶）", () => {
        for (const activeColumn of ["main", "right"] as const) {
            expect(visibleContainers("single", activeColumn)).toHaveLength(1);
        }
    });
});

describe("groupTabsByContainer", () => {
    it("两个桶恒在，空桶是空数组", () => {
        const grouped = groupTabsByContainer([]);
        expect(CONTAINER_IDS.map((id) => grouped[id])).toEqual([[], []]);
    });

    it("保持入参顺序：顺序由布局单一 writer 决定，这里只归类", () => {
        const grouped = groupTabsByContainer([
            { id: "session:s2" },
            { id: FILES_PANEL_ID },
            { id: "session:s1" },
            { id: "code" },
        ]);
        expect(grouped.main.map((tab) => tab.id)).toEqual(["session:s2", "session:s1"]);
        expect(grouped.right.map((tab) => tab.id)).toEqual([FILES_PANEL_ID, "code"]);
    });

    it("每个页签恰好落在一个容器里（不漏不重）", () => {
        const tabs = [FILES_PANEL_ID, "code", "monitor", "session:s9"].map((id) => ({ id }));
        const grouped = groupTabsByContainer(tabs);
        const flat = CONTAINER_IDS.flatMap((id) => grouped[id].map((tab) => tab.id));
        expect(flat.sort()).toEqual(tabs.map((tab) => tab.id).sort());
    });

    /**
     * 判据④的**替代读数**（跨容器拖拽是 dockview 能力，默认路径没有 DnD）：
     * 同一份 tabs 输入变化时两边集合各自更新、互不串扰 ⇒ 派生逻辑正确。
     */
    it("c4 替代：tabs 输入变化时两边集合各自更新（互不串扰）", () => {
        const before = groupTabsByContainer([{ id: "session:s1" }, { id: FILES_PANEL_ID }]);
        const after = groupTabsByContainer([
            { id: "session:s1" },
            { id: FILES_PANEL_ID },
            { id: "code" },
        ]);
        expect(after.main.map((tab) => tab.id)).toEqual(["session:s1"]);
        expect(after.right.map((tab) => tab.id)).toEqual([FILES_PANEL_ID, "code"]);
        // 右栏新增一个面板，不影响 main；左桶（main）在两个快照里都只有那一个会话。
        expect(before.main.map((tab) => tab.id)).toEqual(["session:s1"]);
        expect(before.right.map((tab) => tab.id)).toEqual([FILES_PANEL_ID]);
    });
});
