package com.cc01cc.p.xihe.cp.chat;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/** PLAN-0706 / BL-152: CP returns code only (no English sentence) for localizable chat errors. */
class ChatErrorDetailsTest {

    private static final List<String> ENGLISH_CODES = List.of(
            "LLM_NOT_CONFIGURED", "LLM_CREDENTIALS_INVALID", "LLM_PROVIDER_UNREACHABLE",
            "LLM_MODEL_UNAVAILABLE", "LLM_REQUEST_REJECTED", "LLM_TOOL_ROUTE_UNSUPPORTED",
            "AGENT_TIMEOUT", "AGENT_CIRCUIT_OPEN", "SSE_SUBSCRIPTION_REQUIRED", "CHAT_IN_PROGRESS",
            "IDEMPOTENCY_KEY_CONFLICT", "APPROVAL_REJECTED", "APPROVAL_EXPIRED",
            "APPROVAL_EXECUTOR_UNSUPPORTED", "APPROVAL_DECISION_CONFLICT", "AGENT_EVENT_ID_MISMATCH",
            "RAG_PROFILE_UNAVAILABLE", "RAG_LEASE_INVALID", "RAG_LEASE_UNAVAILABLE",
            "RAG_LEASE_MISMATCH", "RAG_QUERY_FAILED", "BASELINE_UNAUTHORIZED");

    @Test
    void englishFallbackCodesReturnNullSoTheUiCanLocalize() {
        for (String code : ENGLISH_CODES) {
            assertNull(ChatErrorDetails.safeErrorDetail(code),
                    "BL-152: " + code + " must not ship an English user-facing detail");
        }
        assertNull(ChatErrorDetails.safeErrorDetail("SOMETHING_UNKNOWN"));
        assertNull(ChatErrorDetails.safeErrorDetail(null));
    }

    @Test
    void chineseProductCopyStaysOnTheCpSide() {
        assertEquals("上下文超限，已压缩并重试一次，仍超出限制", ChatErrorDetails.safeErrorDetail("CONTEXT_OVERFLOW"));
        assertEquals("本次运行已达到累计预算上限", ChatErrorDetails.safeErrorDetail("RUN_BUDGET_EXHAUSTED"));
        assertEquals("检测到重复或无进展动作，运行已停止", ChatErrorDetails.safeErrorDetail("RUN_NO_PROGRESS"));
    }
}
