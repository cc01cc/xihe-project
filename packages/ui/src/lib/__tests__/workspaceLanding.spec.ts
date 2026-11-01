/**
 * PLAN-0614 决策 #5 / BL-173：免密自动登录（localMode 守卫分支）的落点三态。
 *
 * 规则优先级（守卫里就是这三条）：
 * 1. 已有 tab 上下文 → 用它（记住用户上次选择，不被登录响应覆盖）；
 * 2. 否则用登录响应里的第一个活跃工作区（`workspace` 对象，或 `workspaceId` + 默认名）；
 * 3. 两者都没有 → `null`，停在选择面（空白起步后注册不再建工作区）。
 */
import { describe, expect, it } from "vitest";
import { resolveLocalModeLanding } from "../workspaceLanding";

const TAB = { id: "11111111-1111-1111-1111-111111111111", name: "Chosen" };
const LOGIN_WS = {
    id: "22222222-2222-2222-2222-222222222222",
    name: "First Active",
} as never;

describe("resolveLocalModeLanding (PLAN-0614 #5 / BL-173)", () => {
    it("有 tab 上下文时优先用它（不覆盖用户上次选择）", () => {
        expect(
            resolveLocalModeLanding({
                tabWorkspace: TAB,
                loginWorkspace: LOGIN_WS,
                loginWorkspaceId: "22222222-2222-2222-2222-222222222222",
            }),
        ).toEqual(TAB);
    });

    it("没有 tab 上下文时用登录响应的第一个活跃工作区", () => {
        expect(
            resolveLocalModeLanding({
                tabWorkspace: null,
                loginWorkspace: LOGIN_WS,
                loginWorkspaceId: "22222222-2222-2222-2222-222222222222",
            }),
        ).toEqual(LOGIN_WS);
    });

    it("只有 workspaceId 时补默认名", () => {
        expect(
            resolveLocalModeLanding({
                tabWorkspace: null,
                loginWorkspace: null,
                loginWorkspaceId: "33333333-3333-3333-3333-333333333333",
                fallbackName: "Default Workspace",
            }),
        ).toEqual({ id: "33333333-3333-3333-3333-333333333333", name: "Default Workspace" });
    });

    it("都没有时返回 null（停在空态选择面）", () => {
        expect(
            resolveLocalModeLanding({
                tabWorkspace: null,
                loginWorkspace: null,
                loginWorkspaceId: null,
            }),
        ).toBeNull();
    });
});
