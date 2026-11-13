import { describe, expect, it } from "vitest";
import {
    bridgeDockviewLayout,
    buildDockviewLayout,
    DOCKVIEW_OPTIONS,
    type DockviewSerializedLayout,
} from "../dockview";

/**
 * PLAN-0756 T2/T3/V5：序列化桥 + 全局选项的**纯逻辑**单测（决策 #18：jsdom 只测纯逻辑，
 * dockview 组件集成归 Playwright）。这里不 import dockview，纯函数可直接断言。
 */
describe("dockview serialization bridge (PLAN-0756 T2)", () => {
    it("keeps proportionalLayout disabled globally (clamp-not-written-back invariant)", () => {
        expect(DOCKVIEW_OPTIONS.proportionalLayout).toBe(false);
    });

    it("extracts dock tabs, active tab and dock width from a dockview toJSON() shape", () => {
        const json: DockviewSerializedLayout = {
            grid: {
                root: {
                    data: [
                        {
                            data: { views: ["code", "changes", "monitor"], activeView: "changes" },
                            size: 360,
                        },
                    ],
                },
            },
            panels: {},
        };
        expect(bridgeDockviewLayout(json)).toEqual({
            dockTabs: ["code", "changes", "monitor"],
            activeDockTab: "changes",
            dockWidth: 360,
        });
    });

    it("returns an empty bridge for an empty / malformed layout", () => {
        expect(bridgeDockviewLayout(null)).toEqual({
            dockTabs: [],
            activeDockTab: null,
            dockWidth: null,
        });
        expect(bridgeDockviewLayout({})).toEqual({
            dockTabs: [],
            activeDockTab: null,
            dockWidth: null,
        });
    });

    it("round-trips XH layout semantics through buildDockviewLayout (V2 保真)", () => {
        const json = buildDockviewLayout({
            dockTabs: ["code", "changes", "monitor"],
            activeDockTab: "changes",
            dockWidth: 360,
        });
        expect(bridgeDockviewLayout(json)).toEqual({
            dockTabs: ["code", "changes", "monitor"],
            activeDockTab: "changes",
            dockWidth: 360,
        });
    });

    it("buildDockviewLayout drops to an empty grid when no tabs are open", () => {
        const json = buildDockviewLayout({ dockTabs: [], activeDockTab: null, dockWidth: 360 });
        expect(bridgeDockviewLayout(json)).toEqual({
            dockTabs: [],
            activeDockTab: null,
            dockWidth: null,
        });
    });
});

describe("dockview serialization bridge — 双 group 选组（task-369 S1 正确性前提）", () => {
    /** 双 group 的真实形态：首个 leaf 是中栏组（树 + 主列），右栏组在后面。 */
    const twoGroups: DockviewSerializedLayout = {
        grid: {
            root: {
                data: [
                    {
                        data: { id: "center", views: ["tree", "main"], activeView: "main" },
                        size: 918,
                    },
                    {
                        data: { id: "dock", views: ["code", "monitor"], activeView: "monitor" },
                        size: 360,
                    },
                ],
            },
        },
    };

    const EMPTY = { dockTabs: [], activeDockTab: null, dockWidth: null };

    it("按 groupId 命中右栏组（不是首个 leaf）", () => {
        expect(bridgeDockviewLayout(twoGroups, { groupId: "dock" })).toEqual({
            dockTabs: ["code", "monitor"],
            activeDockTab: "monitor",
            dockWidth: 360,
        });
    });

    it("不给 groupId 且关掉兼容回退 ⇒ 空结果（Lead 点名的陷阱：读错组比读不到更糟）", () => {
        expect(bridgeDockviewLayout(twoGroups, { fallbackToFirstLeaf: false })).toEqual(EMPTY);
    });

    it("兼容默认（无 options）仍读首个 leaf —— 这就是双 group 下必须给判据的原因", () => {
        expect(bridgeDockviewLayout(twoGroups)).toEqual({
            dockTabs: ["tree", "main"],
            activeDockTab: "main",
            dockWidth: 918,
        });
    });

    it("panelIds 判据（组 id 尚未稳定时）同样命中右栏组", () => {
        expect(
            bridgeDockviewLayout(twoGroups, { panelIds: ["code", "changes", "monitor"] }),
        ).toEqual({
            dockTabs: ["code", "monitor"],
            activeDockTab: "monitor",
            dockWidth: 360,
        });
    });

    it("dock 转 floating 后不在 grid 里 ⇒ 从 floatingGroups 找（POC ② 实测形态）", () => {
        const floating: DockviewSerializedLayout = {
            grid: {
                root: {
                    data: [
                        {
                            data: { id: "center", views: ["tree", "main"], activeView: "main" },
                            size: 1280,
                        },
                    ],
                },
            },
            floatingGroups: [
                {
                    data: { id: "dock", views: ["code"], activeView: "code" },
                    size: 360,
                },
            ],
        };
        expect(bridgeDockviewLayout(floating, { groupId: "dock" })).toEqual({
            dockTabs: ["code"],
            activeDockTab: "code",
            dockWidth: 360,
        });
        expect(
            bridgeDockviewLayout(floating, { groupId: "dock", fallbackToFirstLeaf: false }),
        ).toEqual({
            dockTabs: ["code"],
            activeDockTab: "code",
            dockWidth: 360,
        });
    });
});
