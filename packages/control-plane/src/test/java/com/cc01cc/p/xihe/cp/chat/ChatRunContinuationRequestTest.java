package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ChatRunContinuationRequestTest {
    private final JsonMapper mapper = JsonMapper.builder().build();

    @Test
    void parsesResumeWithoutMessage() throws Exception {
        ChatRunContinuationRequest request = ChatRunContinuationRequest.parse(
                mapper.readTree("{\"mode\":\"resume_pending\"}"));

        assertEquals(ChatRunContinuationRequest.RESUME_PENDING, request.mode());
        assertNull(request.content());
    }

    @Test
    void parsesExactlyOneAppendUserTurn() throws Exception {
        ChatRunContinuationRequest request = ChatRunContinuationRequest.parse(
                mapper.readTree("{\"mode\":\"append_user_turn\",\"message\":{\"content\":\"continue\"}}"));

        assertEquals(ChatRunContinuationRequest.APPEND_USER_TURN, request.mode());
        assertEquals("continue", request.content());
    }

    @Test
    void rejectsExtraFieldsAndMixedModes() throws Exception {
        assertThrows(CpApiException.class, () -> ChatRunContinuationRequest.parse(
                mapper.readTree("{\"mode\":\"resume_pending\",\"message\":{\"content\":\"x\"}}")));
        assertThrows(CpApiException.class, () -> ChatRunContinuationRequest.parse(
                mapper.readTree("{\"mode\":\"append_user_turn\",\"content\":\"x\",\"message\":{\"content\":\"y\"}}")));
        assertThrows(CpApiException.class, () -> ChatRunContinuationRequest.parse(
                mapper.readTree("{\"mode\":\"append_user_turn\",\"message\":{\"content\":\"x\",\"extra\":true}}")));
    }

    @Test
    void requiresBoundedIdempotencyKey() {
        assertThrows(CpApiException.class, () -> ChatRunContinuationRequest.requireIdempotencyKey(null));
        assertThrows(CpApiException.class, () -> ChatRunContinuationRequest.requireIdempotencyKey("  "));
        assertThrows(CpApiException.class, () -> ChatRunContinuationRequest.requireIdempotencyKey("k".repeat(129)));
        assertEquals("stable-key", ChatRunContinuationRequest.requireIdempotencyKey(" stable-key "));
    }
}
