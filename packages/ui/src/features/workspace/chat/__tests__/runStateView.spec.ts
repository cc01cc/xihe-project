import { describe, expect, it } from "vitest";
import { i18n } from "../../../../i18n";
import {
    isTerminalRunStatus,
    runStateIsFailure,
    runStateLabelKey,
    runStateTier,
    runStatusOfDerivedChild,
    terminalMarkerOf,
} from "../runStateView";

/**
 * PLAN-0631 D31-01: the resolver is the only place a wire status becomes a tier/label.
 * These assertions are the contract new surfaces must not bypass.
 */
describe("runStateView", () => {
    it("maps every ChatRunResponse status to exactly one attention tier", () => {
        const tiers = {
            accepted: "active",
            queued: "active",
            dispatching: "active",
            running: "active",
            streaming: "active",
            awaiting_approval: "needs-human",
            cancelling: "stopping",
            succeeded: "terminal",
            failed: "terminal",
            partial: "terminal",
            ambiguous: "terminal",
            cancelled: "terminal",
        } as const;

        for (const [status, tier] of Object.entries(tiers)) {
            expect(runStateTier(status), status).toBe(tier);
        }
    });

    it("returns null for an unknown or absent status instead of guessing", () => {
        expect(runStateTier(undefined)).toBeNull();
        expect(runStateTier(null)).toBeNull();
        expect(runStateTier("")).toBeNull();
        expect(runStateTier("interrupted")).toBeNull();
        expect(runStateLabelKey("interrupted")).toBeNull();
    });

    it("resolves every label to existing copy in both locales (no raw key can reach the UI)", () => {
        const statuses = [
            "accepted",
            "queued",
            "dispatching",
            "running",
            "streaming",
            "awaiting_approval",
            "cancelling",
            "succeeded",
            "failed",
            "partial",
            "ambiguous",
            "cancelled",
        ] as const;

        for (const locale of ["zh-CN", "en-US"] as const) {
            for (const status of statuses) {
                const key = runStateLabelKey(status);
                expect(key, status).toBeTruthy();
                const text = i18n.global.t(key!, {}, { locale });
                expect(text, `${locale}:${status} (${key})`).not.toBe(key);
                expect(text.length, `${locale}:${status}`).toBeGreaterThan(0);
            }
        }
    });

    // PLAN-0631 M1-C: the two end states that now get a visible row-end marker.
    it.each([
        ["zh-CN", "partial", "部分完成"],
        ["zh-CN", "cancelled", "已取消"],
        ["en-US", "partial", "Partial"],
        ["en-US", "cancelled", "Cancelled"],
    ])("renders %s wording for the %s marker", (locale, status, expected) => {
        const key = runStateLabelKey(status);
        expect(key).toBeTruthy();
        expect(i18n.global.t(key!, {}, { locale })).toContain(expected);
    });
});

describe("terminalMarkerOf (BL-406)", () => {
    it("marks exactly partial and cancelled, from status or terminal outcome", () => {
        expect(terminalMarkerOf("partial", "partial")).toBe("partial");
        expect(terminalMarkerOf("cancelled", "cancelled")).toBe("cancelled");
        // 两路任一侧给出即可：旧 CP 只回 outcome，或消息只带 runStatus。
        expect(terminalMarkerOf(undefined, "partial")).toBe("partial");
        expect(terminalMarkerOf("cancelled", undefined)).toBe("cancelled");
    });

    it("stays silent for succeeded/failed/ambiguous and for live or unknown states", () => {
        expect(terminalMarkerOf("succeeded", "success")).toBeNull();
        expect(terminalMarkerOf("failed", "error")).toBeNull();
        expect(terminalMarkerOf("ambiguous", "ambiguous")).toBeNull();
        for (const status of ["accepted", "streaming", "awaiting_approval", "cancelling"]) {
            expect(terminalMarkerOf(status, null), status).toBeNull();
        }
        expect(terminalMarkerOf(undefined, null)).toBeNull();
        expect(terminalMarkerOf(null, "interrupted")).toBeNull();
    });
});

describe("isTerminalRunStatus", () => {
    it("treats exactly the five end states as terminal", () => {
        for (const status of ["succeeded", "failed", "partial", "ambiguous", "cancelled"]) {
            expect(isTerminalRunStatus(status), status).toBe(true);
        }
    });

    it("never treats a live/known-unknown status as terminal", () => {
        for (const status of [
            "accepted",
            "queued",
            "dispatching",
            "running",
            "streaming",
            "awaiting_approval",
            "cancelling",
        ]) {
            expect(isTerminalRunStatus(status), status).toBe(false);
        }
        // Unknown is not "over": callers must not retire UI for a state they cannot read.
        expect(isTerminalRunStatus(undefined)).toBe(false);
        expect(isTerminalRunStatus(null)).toBe(false);
        expect(isTerminalRunStatus("interrupted")).toBe(false);
    });
});

/**
 * task-1 / D-1846：derived-state 的**两套**词表 → 冻结的 12 值 wire 词表。
 * 断言三条：active 原样透传、terminal 两词被映射、未知不猜。
 */
describe("runStatusOfDerivedChild (task-1 derived anchors)", () => {
    it("passes the seven in-flight derived statuses through unchanged", () => {
        const active = [
            "accepted",
            "queued",
            "dispatching",
            "running",
            "streaming",
            "awaiting_approval",
            "cancelling",
        ] as const;
        for (const status of active) {
            expect(runStatusOfDerivedChild(status, null), status).toBe(status);
            // 两条轴同时到达时在途优先（终态收口还没被读到）。
            expect(runStatusOfDerivedChild(status, "success"), status).toBe(status);
            expect(runStateTier(runStatusOfDerivedChild(status, null))).not.toBeNull();
        }
    });

    it("maps the five derived terminal words onto existing wire statuses", () => {
        expect(runStatusOfDerivedChild(null, "success")).toBe("succeeded");
        expect(runStatusOfDerivedChild(null, "error")).toBe("failed");
        expect(runStatusOfDerivedChild(null, "partial")).toBe("partial");
        expect(runStatusOfDerivedChild(null, "ambiguous")).toBe("ambiguous");
        expect(runStatusOfDerivedChild(null, "cancelled")).toBe("cancelled");
        // 映射的每个结果都必须是既有 tier 表里的成员（= 没有新增状态词）。
        for (const terminal of ["success", "error", "partial", "ambiguous", "cancelled"] as const) {
            const status = runStatusOfDerivedChild(null, terminal);
            expect(status, terminal).not.toBeNull();
            expect(runStateTier(status), String(status)).not.toBeNull();
        }
    });

    it("returns null for absent or unreadable vocabularies instead of guessing", () => {
        expect(runStatusOfDerivedChild(null, null)).toBeNull();
        expect(runStatusOfDerivedChild(undefined, undefined)).toBeNull();
        // 运行期越界值（本 UI 不认识的新词）不得被当成在途。
        expect(runStatusOfDerivedChild("paused" as never, null)).toBeNull();
        expect(runStatusOfDerivedChild(null, "timed_out" as never)).toBeNull();
    });

    it("gives the failure predicate one home (anchor + run header share it)", () => {
        expect(runStateIsFailure("failed")).toBe(true);
        expect(runStateIsFailure("cancelled")).toBe(true);
        for (const status of ["succeeded", "partial", "ambiguous", "running", undefined, null]) {
            expect(runStateIsFailure(status), String(status)).toBe(false);
        }
    });
});
