import { describe, expect, it } from "vitest";
import { ApiError } from "../../../composables/api";
import { presetErrorMessage } from "../roleErrorMessages";

/**
 * task-855：授权预设/绑定错误统一「本地化文案 + （CODE）」。
 * CP 的 Problem `detail` 只作诊断，不回到用户面（BL-288 detail-first 已撤销）。
 */
const t = (key: string) => `copy:${key}`;

function apiError(code: string, detail?: string): ApiError {
    return new ApiError({ status: 409, code, requestId: "req-1", detail });
}

describe("presetErrorMessage (task-855)", () => {
    it("never surfaces the Problem detail, even when it names offending atoms", () => {
        const text = presetErrorMessage(
            apiError(
                "ROLE_BINDING_EXCEEDS_CAP",
                "绑定后角色超限：CREATE_ACCOUNT、MANAGE_WORKSPACE_AGENTS 超过上限 3 个",
            ),
            t,
        );
        expect(text).toBe("copy:settings.presetsError.generic（ROLE_BINDING_EXCEEDS_CAP）");
        expect(text).not.toContain("CREATE_ACCOUNT");
    });

    it("maps known codes to localized copy and appends the stable code", () => {
        expect(presetErrorMessage(apiError("ROLE_NOT_FOUND"), t)).toBe(
            "copy:settings.presetsError.presetNotFound（ROLE_NOT_FOUND）",
        );
        expect(presetErrorMessage(apiError("ROLE_BINDING_EXCEEDS_CAP"), t)).toBe(
            "copy:settings.presetsError.generic（ROLE_BINDING_EXCEEDS_CAP）",
        );
        expect(presetErrorMessage(new Error("boom"), t)).toBe("copy:settings.presetsError.generic");
    });

    it("drops the detail even when the code is mapped", () => {
        const text = presetErrorMessage(apiError("CONCURRENT_MODIFICATION", "版本 7 → 9"), t);
        expect(text).toBe(
            "copy:settings.presetsError.concurrentModification（CONCURRENT_MODIFICATION）",
        );
        expect(text).not.toContain("版本 7 → 9");
    });

    it("localizes AGENT_PRINCIPAL_FORBIDDEN_ATOMS instead of echoing the atom list", () => {
        const text = presetErrorMessage(
            apiError(
                "AGENT_PRINCIPAL_FORBIDDEN_ATOMS",
                "role carries atoms an agent principal may never hold: credential.use,instance:admin",
            ),
            t,
        );
        expect(text).toBe(
            "copy:settings.presetsError.agentPresetForbiddenAtoms（AGENT_PRINCIPAL_FORBIDDEN_ATOMS）",
        );
        expect(text).not.toContain("credential.use");
    });
});
