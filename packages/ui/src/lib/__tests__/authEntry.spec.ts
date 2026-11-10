/**
 * PLAN-0612 T6.3 / PLAN-0758：入口判定（守卫两态）。
 *
 * 断言的是"未登录访问受保护路由时的入口决策"：空实例去 onboarding，其余一律 `/login`
 * （本地模式移除后不再有免密分支）。
 */
import { describe, expect, it } from "vitest";
import { resolveUnauthenticatedEntry } from "../authEntry";

describe("resolveUnauthenticatedEntry (PLAN-0612 T6.3 / PLAN-0758)", () => {
    it("普通部署仍然跳登录页", () => {
        expect(resolveUnauthenticatedEntry({ initialized: true })).toBe("login");
    });

    it("空实例先走 onboarding", () => {
        expect(resolveUnauthenticatedEntry({ initialized: false })).toBe("onboarding");
    });
});
