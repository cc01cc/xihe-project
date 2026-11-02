import { describe, expect, it } from "vitest";
import { i18n } from "../../../../i18n";
import { runStateLabelKey, runStateTier } from "../runStateView";

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
});
