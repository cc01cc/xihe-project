import { describe, expect, it } from "vitest";
import { formatRunDuration, runShortCode } from "../runView";

/**
 * PLAN-0659 T1.1：run 头的纯展示派生。
 * `runShortCode` 只是展示用短码 —— 这里只钉"稳定、去横线、6 位、空值安全"，
 * 不把它当身份（身份用 `data-run-id` 全文，见 MessageList/RunGroupHeader）。
 */
describe("runView", () => {
    it("runShortCode strips dashes and keeps 6 chars, empty-safe", () => {
        expect(runShortCode("3f2a9c11-aaaa-bbbb-cccc-dddddddddddd")).toBe("3f2a9c");
        expect(runShortCode("")).toBe("");
        expect(runShortCode(null)).toBe("");
        expect(runShortCode(undefined)).toBe("");
    });

    it("formatRunDuration covers sub-second, seconds and minutes", () => {
        expect(formatRunDuration("2026-11-04T10:00:00.000Z", "2026-11-04T10:00:00.420Z")).toBe(
            "0.4s",
        );
        expect(formatRunDuration("2026-11-04T10:00:00.000Z", "2026-11-04T10:00:12.000Z")).toBe(
            "12s",
        );
        expect(formatRunDuration("2026-11-04T10:00:00.000Z", "2026-11-04T10:01:12.000Z")).toBe(
            "1m12s",
        );
    });

    it("formatRunDuration returns empty when the run has not terminated yet", () => {
        expect(formatRunDuration("2026-11-04T10:00:00.000Z", null)).toBe("");
        expect(formatRunDuration(null, "2026-11-04T10:00:01.000Z")).toBe("");
        expect(formatRunDuration("2026-11-04T10:00:00.000Z", "2026-11-04T09:59:59.000Z")).toBe("");
        expect(formatRunDuration("not-a-date", "2026-11-04T10:00:01.000Z")).toBe("");
    });
});
