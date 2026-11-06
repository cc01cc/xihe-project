import { describe, expect, it } from "vitest";
import { decideReadMode, FILE_SIZE_THRESHOLDS } from "../fileSize";

describe("decideReadMode", () => {
    const captureCap = 32 * 1024 * 1024;

    it("intercepts at and above the 32 MiB capture cap", () => {
        expect(FILE_SIZE_THRESHOLDS.INTERCEPT).toBe(captureCap);
        expect(decideReadMode(captureCap - 1)).toEqual({
            action: "truncate",
            maxBytes: FILE_SIZE_THRESHOLDS.TRUNCATE_BYTES,
        });
        expect(decideReadMode(captureCap)).toEqual({ action: "intercept" });
        expect(decideReadMode(captureCap + 1)).toEqual({ action: "intercept" });
    });

    it("keeps the full-read behavior for an unknown size", () => {
        expect(decideReadMode(undefined)).toEqual({ action: "full" });
    });
});
