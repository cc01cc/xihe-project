import { ApiError } from "../../../composables/api";

/**
 * PLAN-0660 T5.20：把「提交答案失败」映射成本地化文案的 **i18n key**。
 *
 * 为什么不直显 CP 的 `detail`：那是服务端英文诊断串（`docs/api/inventory.md` 的
 * `POST /user-questions/{id}/answer` 一节），既是内部措辞、也会随实现变；用户需要的是
 * "怎么办"，不是"服务端说了什么"。所以只认**封闭错误码**，其余一律回落通用文案。
 *
 * 错误码语义（同节 inventory）：
 * - `409 QUESTION_ALREADY_SETTLED` —— 已被处理（可能在别的标签页回答过）；
 * - `409 QUESTION_EXPIRED` —— 超过 `expires_at`；
 * - `502 AGENT_QUESTION_DELIVERY_FAILED` —— 回传失败，**行仍是 `pending`**，可重试。
 *
 * 返回 key 而不是成品文案，是为了让这个函数保持纯函数（可单测、不依赖 i18n 实例），
 * 由调用方 `t(key)` 出字。
 */
export function questionErrorKey(cause: unknown): string {
    const code = cause instanceof ApiError ? cause.problem.code : "";
    switch (code) {
        case "QUESTION_ALREADY_SETTLED":
            return "userQuestions.errorAlreadySettled";
        case "QUESTION_EXPIRED":
            return "userQuestions.errorExpired";
        case "AGENT_QUESTION_DELIVERY_FAILED":
            return "userQuestions.errorDeliveryFailed";
        default:
            return "userQuestions.errorGeneric";
    }
}
