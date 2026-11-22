import { describe, expect, it } from "vitest";
import { ApiError } from "../../../composables/api";
import { presetErrorMessage } from "../roleErrorMessages";

/**
 * BL-288：授权预设/绑定错误优先展示 CP Problem `detail`（可行动信息，如“超限的原子名”），
 * 无 detail 才回退本地化通用文案。策划判据来自 Lead 2026-11-05。
 */
const t = (key: string) => `copy:${key}`;

function apiError(code: string, detail?: string): ApiError {
    return new ApiError({ status: 409, code, requestId: "req-1", detail });
}

describe("presetErrorMessage (BL-288)", () => {
    it("shows the Problem detail for ROLE_BINDING_EXCEEDS_CAP (offending atoms are in detail)", () => {
        const text = presetErrorMessage(
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
        expect(presetErrorMessage(apiError("ROLE_NOT_FOUND"), t)).toBe(
            "copy:settings.presetsError.presetNotFound",
        );
        expect(presetErrorMessage(apiError("ROLE_BINDING_EXCEEDS_CAP"), t)).toBe(
            "copy:settings.presetsError.generic",
        );
        expect(presetErrorMessage(new Error("boom"), t)).toBe("copy:settings.presetsError.generic");
    });

    it("keeps the detail for a mapped code too (detail wins over static copy)", () => {
        const text = presetErrorMessage(apiError("CONCURRENT_MODIFICATION", "版本 7 → 9"), t);
        expect(text).toContain("版本 7 → 9");
    });

    it("localizes AGENT_PRINCIPAL_FORBIDDEN_ATOMS instead of echoing the English detail", () => {
        const text = presetErrorMessage(
            apiError(
                "AGENT_PRINCIPAL_FORBIDDEN_ATOMS",
                "role carries atoms an agent principal may never hold: credential.use,instance:admin",
            ),
            t,
        );
        expect(text).toBe("copy:settings.presetsError.agentPresetForbiddenAtoms");
        expect(text).not.toContain("credential.use");
    });
});
