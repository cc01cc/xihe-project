import { describe, expect, it } from "vitest";
import { ApiError } from "../../../composables/api";
import { roleErrorMessage } from "../roleErrorMessages";

/**
 * BL-288：角色/绑定错误优先展示 CP Problem `detail`（可行动信息，如“超限的原子名”），
 * 无 detail 才回退本地化通用文案。策划判据来自 Lead 2026-11-05。
 */
const t = (key: string) => `copy:${key}`;

function apiError(code: string, detail?: string): ApiError {
    return new ApiError({ status: 409, code, requestId: "req-1", detail });
}

describe("roleErrorMessage (BL-288)", () => {
    it("shows the Problem detail for ROLE_BINDING_EXCEEDS_CAP (offending atoms are in detail)", () => {
        const text = roleErrorMessage(
            apiError(
                "ROLE_BINDING_EXCEEDS_CAP",
                "绑定后角色超限：CREATE_ACCOUNT、MANAGE_WORKSPACE_AGENTS 超过上限 3 个",
            ),
            t,
        );
        expect(text).toContain("CREATE_ACCOUNT");
        expect(text).toContain("MANAGE_WORKSPACE_AGENTS");
        expect(text).not.toContain("copy:");
    });

    it("falls back to the localized mapped copy when the Problem has no detail", () => {
        expect(roleErrorMessage(apiError("ROLE_NOT_FOUND"), t)).toBe(
            "copy:settings.rolesError.roleNotFound",
        );
        expect(roleErrorMessage(apiError("ROLE_BINDING_EXCEEDS_CAP"), t)).toBe(
            "copy:settings.rolesError.generic",
        );
        expect(roleErrorMessage(new Error("boom"), t)).toBe("copy:settings.rolesError.generic");
    });

    it("keeps the detail for a mapped code too (detail wins over static copy)", () => {
        const text = roleErrorMessage(apiError("CONCURRENT_MODIFICATION", "版本 7 → 9"), t);
        expect(text).toContain("版本 7 → 9");
    });
});
