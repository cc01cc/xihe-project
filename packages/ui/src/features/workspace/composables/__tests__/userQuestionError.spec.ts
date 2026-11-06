import { describe, expect, it } from "vitest";
import { ApiError } from "../../../../composables/api";
import { questionErrorKey } from "../userQuestionError";

/**
 * PLAN-0660 T5.20 —— `QUESTION_*` 错误码 → 本地化文案的唯一映射点。
 *
 * 判据是"封闭集 + 回落"：三个已知码各走各的文案，别的（含 CP 新加的码、网络错误、非 ApiError）
 * 一律回落通用文案，**绝不把 CP 的英文 `detail` 透给用户**。
 */
function apiError(code: string, status: number): ApiError {
    return new ApiError({ status, code, requestId: "req-1", detail: "SERVICE ENGLISH DETAIL" });
}

describe("questionErrorKey（PLAN-0660 T5.20）", () => {
    it("三个已登记错误码各映射到自己的键", () => {
        expect(questionErrorKey(apiError("QUESTION_ALREADY_SETTLED", 409))).toBe(
            "userQuestions.errorAlreadySettled",
        );
        expect(questionErrorKey(apiError("QUESTION_EXPIRED", 409))).toBe(
            "userQuestions.errorExpired",
        );
        expect(questionErrorKey(apiError("AGENT_QUESTION_DELIVERY_FAILED", 502))).toBe(
            "userQuestions.errorDeliveryFailed",
        );
    });

    it("未知码 / 非 ApiError / 空值都回落通用文案", () => {
        expect(questionErrorKey(apiError("SOMETHING_ELSE", 400))).toBe(
            "userQuestions.errorGeneric",
        );
        expect(questionErrorKey(new Error("network down"))).toBe("userQuestions.errorGeneric");
        expect(questionErrorKey(null)).toBe("userQuestions.errorGeneric");
        expect(questionErrorKey(undefined)).toBe("userQuestions.errorGeneric");
    });
});
