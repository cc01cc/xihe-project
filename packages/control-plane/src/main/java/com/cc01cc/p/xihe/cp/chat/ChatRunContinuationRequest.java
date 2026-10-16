package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.springframework.http.HttpStatus;
import tools.jackson.databind.JsonNode;

import java.util.Iterator;
import java.util.Set;

/** Strict body parser for the two frozen ChatRun continuation modes. */
record ChatRunContinuationRequest(String mode, String content) {
    static final String RESUME_PENDING = "resume_pending";
    static final String APPEND_USER_TURN = "append_user_turn";

    static ChatRunContinuationRequest parse(JsonNode body) {
        if (body == null || !body.isObject()) {
            throw invalid("Request body must be an object");
        }
        JsonNode modeNode = body.get("mode");
        if (modeNode == null || !modeNode.isTextual()) {
            throw invalid("mode is required");
        }
        String mode = modeNode.textValue();
        if (RESUME_PENDING.equals(mode)) {
            requireExactFields(body, Set.of("mode"));
            return new ChatRunContinuationRequest(mode, null);
        }
        if (APPEND_USER_TURN.equals(mode)) {
            requireExactFields(body, Set.of("mode", "message"));
            JsonNode message = body.get("message");
            if (message == null || !message.isObject()) {
                throw invalid("message must be an object containing content");
            }
            requireExactFields(message, Set.of("content"));
            JsonNode content = message.get("content");
            if (content == null || !content.isTextual()) {
                throw invalid("message.content must be a string");
            }
            return new ChatRunContinuationRequest(mode, content.textValue());
        }
        throw invalid("mode must be resume_pending or append_user_turn");
    }

    static String requireIdempotencyKey(String value) {
        String key = value == null ? "" : value.trim();
        if (key.isEmpty() || key.length() > 128 || key.indexOf('\r') >= 0 || key.indexOf('\n') >= 0) {
            throw invalid("Idempotency-Key is required and must not exceed 128 characters");
        }
        return key;
    }

    private static void requireExactFields(JsonNode object, Set<String> expected) {
        int count = 0;
        Iterator<String> names = object.propertyNames().iterator();
        while (names.hasNext()) {
            String name = names.next();
            count++;
            if (!expected.contains(name)) {
                throw invalid("Request contains an unsupported field");
            }
        }
        if (count != expected.size()) {
            throw invalid("Request is missing a required field");
        }
    }

    private static CpApiException invalid(String detail) {
        return new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", detail);
    }
}
