import { describe, expect, it } from "vitest";
import type { Page } from "@playwright/test";
import { SELECT_LABELS, selectLabelFor, triggerLabel } from "../../../e2e/helpers/select";

// PLAN-0707/0709/0713 共用的 e2e Select 适配层：映射与文案读取是纯函数，锁住行为，
// 避免后续迁移时把 value→label 映射改乱或把空 trigger 伪造出占位。
function fakePage(text: string): Page {
    return {
        getByTestId: () => ({ innerText: async () => text }),
    } as unknown as Page;
}

describe("e2e select helper", () => {
    it("① value→label 命中（按 testid 分组）", () => {
        expect(selectLabelFor("approval-rule-layer", "user")).toBe("用户层");
        expect(selectLabelFor("approval-classify-shape", "interpreter")).toBe("解释器型");
        expect(selectLabelFor("config-select-approval-policy-mode", "auto")).toBe("自动放行");
    });

    it("② 未知 value 回退原值（不静默改写；Playwright 报错会带该文案便于定位）", () => {
        expect(selectLabelFor("approval-rule-layer", "bogus")).toBe("bogus");
        expect(selectLabelFor("no-such-testid", "x")).toBe("x");
        expect(SELECT_LABELS["approval-rule-layer"]).not.toHaveProperty("bogus");
    });

    it("③ triggerLabel 去空白；无文案时返回空串（不伪造占位）", async () => {
        await expect(triggerLabel(fakePage("  用户层 \n"), "approval-rule-layer")).resolves.toBe(
            "用户层",
        );
        await expect(triggerLabel(fakePage("   "), "approval-rule-layer")).resolves.toBe("");
    });
});
