package com.cc01cc.p.xihe.cp.chat;

/**
 * PLAN-0706 / BL-152: the user-facing copy of a stable chat error code.
 *
 * <p>CP no longer localizes user-facing errors: this helper returns {@code null} for every code
 * whose copy used to be an English sentence, and the UI renders {@code humanizeErrorCode(code)}.
 * Only the three codes whose product copy is already Chinese are kept here. Machine-readable
 * codes (and technical 400 details elsewhere) are untouched.</p>
 */
final class ChatErrorDetails {

    private ChatErrorDetails() {
    }

    static String safeErrorDetail(String code) {
        if (code == null) {
            return null;
        }
        return switch (code) {
            case "CONTEXT_OVERFLOW" -> "上下文超限，已压缩并重试一次，仍超出限制";
            case "RUN_BUDGET_EXHAUSTED" -> "本次运行已达到累计预算上限";
            case "RUN_NO_PROGRESS" -> "检测到重复或无进展动作，运行已停止";
            default -> null;
        };
    }
}
