package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

final class ChatRequestHash {

    private ChatRequestHash() {}

    static String calculate(ObjectMapper objectMapper, String content, String provider, String model,
                            String toolMode, List<String> attachmentIds,
                            Map<String, Integer> toolTimeouts) {
        try {
            Map<String, Object> canonical = new LinkedHashMap<>();
            canonical.put("content", content == null ? "" : content);
            canonical.put("provider", provider == null ? "" : provider);
            canonical.put("model", model == null ? "" : model);
            canonical.put("toolMode", toolMode == null || toolMode.isBlank() ? "none" : toolMode);
            canonical.put("attachments", attachmentIds == null ? List.of() : attachmentIds);
            if (toolTimeouts != null && !toolTimeouts.isEmpty()) {
                canonical.put("toolTimeouts", new TreeMap<>(toolTimeouts));
            }
            byte[] bytes = objectMapper.writeValueAsBytes(canonical);
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception e) {
            throw new IllegalArgumentException("Unable to calculate request hash", e);
        }
    }
}
