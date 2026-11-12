import { describe, expect, it } from "vitest";
import { isEntryRouteName, shouldBounceEntryToWorkspace } from "../loginEntry";

/**
 * task-224 档 3 的反向用例：入口页守卫不再"有 token 就弹 /workspace"。
 *
 * 这是**行为变更**点，所以两侧都要钉住：完整会话照旧让路（不许把它顺手改坏），
 * 半个会话留在入口页（新语义，也是递归的起点所在）。
 */
describe("loginEntry（task-224 档 3）", () => {
    it("入口页判定只认 login/register/onboarding", () => {
        expect(isEntryRouteName("login")).toBe(true);
        expect(isEntryRouteName("register")).toBe(true);
        expect(isEntryRouteName("onboarding")).toBe(true);
        expect(isEntryRouteName("workspace-home")).toBe(false);
        expect(isEntryRouteName("settings-user")).toBe(false);
        expect(isEntryRouteName(undefined)).toBe(false);
        expect(isEntryRouteName(null)).toBe(false);
    });

    it("会话材料齐备（token + 缓存 user）才弹走 /workspace", () => {
        expect(shouldBounceEntryToWorkspace(true, true)).toBe(true);
    });

    it("半个会话不弹走（行为变更：停在登录页，不再进站即被踢出）", () => {
        // 改前的判据只看 token ⇒ 这两种情况都会被弹进 /workspace，触发 401 风暴
        expect(shouldBounceEntryToWorkspace(true, false)).toBe(false);
        expect(shouldBounceEntryToWorkspace(false, true)).toBe(false);
        expect(shouldBounceEntryToWorkspace(false, false)).toBe(false);
    });
});
