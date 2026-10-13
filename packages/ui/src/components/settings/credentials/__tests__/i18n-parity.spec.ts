import { describe, it, expect } from "vitest";
import { i18n } from "../../../../i18n";

describe("credentials i18n parity (PLAN-0498 T4.3)", () => {
    it("zh-CN and en-US expose the same credentials key tree", () => {
        const zh = i18n.global.getLocaleMessage("zh-CN") as unknown as {
            credentials?: Record<string, string>;
        };
        const en = i18n.global.getLocaleMessage("en-US") as unknown as {
            credentials?: Record<string, string>;
        };
        expect(zh.credentials).toBeTruthy();
        expect(en.credentials).toBeTruthy();
        expect(Object.keys(zh.credentials!).sort()).toEqual(Object.keys(en.credentials!).sort());
        expect(Object.keys(zh.credentials!).length).toBeGreaterThan(60);
    });
});
