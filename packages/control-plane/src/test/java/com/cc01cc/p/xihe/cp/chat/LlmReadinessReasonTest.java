package com.cc01cc.p.xihe.cp.chat;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * BL-350 (B): the 503 {@code LLM_NOT_CONFIGURED} detail must name the missing layer.
 *
 * <p>The three reasons come from CP's two-layer view — the Agent readiness gate only sees the
 * instance layer (decision #19), so "仅用户层有配置" is not observable there.</p>
 */
class LlmReadinessReasonTest {

    @Test
    void noProfileAnywhereIsInstanceProfileMissing() {
        LlmReadinessReason.Diagnosis diagnosis = LlmReadinessReason.diagnose(false, false);
        assertEquals(LlmReadinessReason.INSTANCE_PROFILE_MISSING, diagnosis.reason());
        assertTrue(diagnosis.detail().contains("instance 层未配置 llm-provider"),
                diagnosis.detail());
    }

    @Test
    void userLayerProfileWithoutInstanceProfileIsUserProfileOnly() {
        LlmReadinessReason.Diagnosis diagnosis = LlmReadinessReason.diagnose(false, true);
        assertEquals(LlmReadinessReason.USER_PROFILE_ONLY, diagnosis.reason());
        assertTrue(diagnosis.detail().contains("仅检测到用户层配置"), diagnosis.detail());
        assertTrue(diagnosis.detail().contains("instance 层"), diagnosis.detail());
    }

    @Test
    void profileWithUnusableCredentialsIsCredentialMissing() {
        LlmReadinessReason.Diagnosis diagnosis = LlmReadinessReason.diagnose(true, true);
        assertEquals(LlmReadinessReason.CREDENTIAL_MISSING, diagnosis.reason());
        assertTrue(diagnosis.detail().contains("凭据不可用"), diagnosis.detail());
    }

    @Test
    void theThreeReasonsAreDistinguishable() {
        String a = LlmReadinessReason.diagnose(false, false).reason();
        String b = LlmReadinessReason.diagnose(false, true).reason();
        String c = LlmReadinessReason.diagnose(true, true).reason();
        assertNotEquals(a, b);
        assertNotEquals(b, c);
        assertNotEquals(a, c);
    }
}
