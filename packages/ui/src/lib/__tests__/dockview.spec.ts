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
