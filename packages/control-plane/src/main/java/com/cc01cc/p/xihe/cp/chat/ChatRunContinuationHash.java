package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;

/** Canonical identity for a continuation request, including its tenant and branch scope. */
final class ChatRunContinuationHash {
    private ChatRunContinuationHash() {}

    static String calculate(ObjectMapper mapper, String userId, String workspaceId, String sessionId,
                            String sourceRunId, ChatRunContinuationRequest request, String branchId) {
        try {
            Map<String, Object> canonical = new LinkedHashMap<>();
            canonical.put("principal", userId);
            canonical.put("workspaceId", workspaceId);
            canonical.put("sessionId", sessionId);
            canonical.put("sourceRunId", sourceRunId);
            canonical.put("mode", request.mode());
            if (ChatRunContinuationRequest.APPEND_USER_TURN.equals(request.mode())) {
                canonical.put("message", Map.of("content", request.content()));
            }
            canonical.put("branchId", branchId);
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(mapper.writeValueAsBytes(canonical)));
        } catch (Exception e) {
            throw new IllegalArgumentException("Unable to calculate continuation request hash", e);
        }
    }
}
