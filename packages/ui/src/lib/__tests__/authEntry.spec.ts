/**
 * PLAN-0612 T6.3：**非 localMode 回归**的入口判定（守卫三态）。
 *
 * 断言的是"未登录访问受保护路由时的入口决策"：普通部署仍然跳 `/login`（不得因为 BL-150 的
 * 免密改动被带偏），空实例去 onboarding，localMode 才走免密 `/local-login`。
 */
import { describe, expect, it } from "vitest";
import { resolveUnauthenticatedEntry } from "../authEntry";

describe("resolveUnauthenticatedEntry (PLAN-0612 T6.3)", () => {
    it("普通部署（非 localMode）仍然跳登录页", () => {
        expect(resolveUnauthenticatedEntry({ initialized: true, localMode: false })).toBe("login");
    });

    it("空实例先走 onboarding（即使开了 localMode）", () => {
        expect(resolveUnauthenticatedEntry({ initialized: false, localMode: true })).toBe(
            "onboarding",
        );
        expect(resolveUnauthenticatedEntry({ initialized: false, localMode: false })).toBe(
            "onboarding",
        );
    });

    it("只有 localMode 才允许免密入口", () => {
        expect(resolveUnauthenticatedEntry({ initialized: true, localMode: true })).toBe(
            "local-login",
        );
    });
});
