import { describe, expect, it } from "vitest";
import { resourceDetailPath, shouldUseBrowserBack } from "../resourceDetail";

/**
 * task-228：详情页路径与返回栈的纯函数口径。
 *
 * <p>这两条都是**可判定**的（拼 URL / 判断有没有应用内历史），所以钉在单测里；
 * "装到页面上还成立"那部分由 `e2e/mock/resource-detail.spec.ts` 在浏览器里验。</p>
 */
describe("resourceDetailPath（资源详情深链）", () => {
    it("层进 query、pk 进路径段：/resources/<id>/<pk>?layer=<LAYER>", () => {
        expect(resourceDetailPath("credentials", "USER", "cred-1")).toBe(
            "/resources/credentials/cred-1?layer=USER",
        );
        expect(resourceDetailPath("agents", "WORKSPACE", "principal-1")).toBe(
            "/resources/agents/principal-1?layer=WORKSPACE",
        );
    });

    it("pk 里的保留字符必须编码（否则 `/` 会把路径段吃掉）", () => {
        expect(resourceDetailPath("skills", "INSTANCE", "a/b c")).toBe(
            "/resources/skills/a%2Fb%20c?layer=INSTANCE",
        );
    });

    it("同一 pk 在两层是两条不同 URL（pk 唯一性 = 资源 + 层，不是全局 UUID）", () => {
        const user = resourceDetailPath("skills", "USER", "same-pk");
        const instance = resourceDetailPath("skills", "INSTANCE", "same-pk");
        expect(user).not.toBe(instance);
        expect(user).toContain("layer=USER");
        expect(instance).toContain("layer=INSTANCE");
    });
});

describe("shouldUseBrowserBack（返回栈：后退优先）", () => {
    it("有应用内历史（history.state.back 非空）⇒ 用浏览器后退", () => {
        expect(shouldUseBrowserBack("/resources/skills?layer=WORKSPACE")).toBe(true);
        expect(shouldUseBrowserBack("/workspace/ws-1/chat/s-1")).toBe(true);
    });

    it("无历史（直接粘 URL / 新标签页）⇒ 不用后退（否则会把人送出应用）", () => {
        expect(shouldUseBrowserBack(null)).toBe(false);
        expect(shouldUseBrowserBack(undefined)).toBe(false);
        expect(shouldUseBrowserBack("")).toBe(false);
        expect(shouldUseBrowserBack(0)).toBe(false);
        expect(shouldUseBrowserBack({})).toBe(false);
    });
});
