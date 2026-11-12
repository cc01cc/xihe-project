import { describe, expect, it } from "vitest";
import { safeRedirect } from "../safeRedirect";

/**
 * task-224 档 4：`safeRedirect` 的反向用例。
 *
 * 这四条对应任务卡点名要拒的输入（`/login` 开头、嵌套 `redirect=`、超长、正常路径），
 * 另补 `//host`（协议相对 URL）与被回收的空白/非字符串入参 —— 它们都会让"回跳"变成
 * "被带到任意站点"或"再套一层"。
 */
describe("safeRedirect", () => {
    it("拒入口页自己（/login 开头）", () => {
        expect(safeRedirect("/login")).toBe("/workspace");
        expect(safeRedirect("/login?redirect=/workspace")).toBe("/workspace");
        expect(safeRedirect("/register")).toBe("/workspace");
        expect(safeRedirect("/onboarding")).toBe("/workspace");
        // 前缀相同但不是入口页，必须放行（别把 /loginx 误伤成入口）
        expect(safeRedirect("/loginx")).toBe("/loginx");
    });

    it("拒已嵌套 redirect= 的串", () => {
        expect(safeRedirect("/login?redirect=/login?redirect=/workspace")).toBe("/workspace");
        expect(safeRedirect("/workspace?redirect=%2Flogin")).toBe("/workspace");
    });

    it("拒超长目标", () => {
        const long = `/workspace/${"a".repeat(4096)}`;
        expect(long.length).toBeGreaterThan(2048);
        expect(safeRedirect(long)).toBe("/workspace");
        // 恰好在上限内的正常路径要放行
        expect(safeRedirect(`/workspace/${"b".repeat(100)}`)).not.toBe("/workspace");
    });

    it("正常站内路径原样返回", () => {
        expect(safeRedirect("/workspace/ws-1/sessions")).toBe("/workspace/ws-1/sessions");
        expect(safeRedirect("/workspace/ws-1/sessions?s=abc")).toBe(
            "/workspace/ws-1/sessions?s=abc",
        );
        expect(safeRedirect("/settings/user/provider")).toBe("/settings/user/provider");
    });

    it("拒站外/协议相对/非法入参", () => {
        expect(safeRedirect("//evil.example.com/")).toBe("/workspace");
        expect(safeRedirect("https://evil.example.com/")).toBe("/workspace");
        expect(safeRedirect("javascript:alert(1)")).toBe("/workspace");
        expect(safeRedirect("")).toBe("/workspace");
        expect(safeRedirect(undefined)).toBe("/workspace");
        expect(safeRedirect(null)).toBe("/workspace");
        expect(safeRedirect(["a", "b"])).toBe("/workspace");
    });
});
