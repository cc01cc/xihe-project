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
        return calculate(objectMapper, content, provider, model, toolMode, attachmentIds, toolTimeouts, null);
    }

    static String calculate(ObjectMapper objectMapper, String content, String provider, String model,
                            String toolMode, List<String> attachmentIds,
                            Map<String, Integer> toolTimeouts, String agentPrincipalId) {
        return calculate(objectMapper, content, provider, model, toolMode, attachmentIds,
                toolTimeouts, agentPrincipalId, null);
    }

    static String calculate(ObjectMapper objectMapper, String content, String provider, String model,
                            String toolMode, List<String> attachmentIds,
                            Map<String, Integer> toolTimeouts, String agentPrincipalId, String branchId) {
        return calculate(objectMapper, content, provider, model, toolMode, attachmentIds,
                toolTimeouts, agentPrincipalId, branchId, null, null);
    }

    /**
     * PLAN-0665 D6: the {@code toParticipantIds} set and {@code asParticipantId} are part of the
     * idempotency identity — they change the <b>material outcome</b> (how many runs, who answers).
     *
     * <p>{@code asParticipantId} was missing from the hash before this change: the same content sent
     * as two different participants under one {@code Idempotency-Key} replayed the first run (wrong
     * responder). That is a pre-existing bug fixed in the same batch (design §2.2 supersede row:
     * hashes change ⇒ replays of pre-upgrade keys answer {@code 409 IDEMPOTENCY_KEY_CONFLICT}).</p>
     *
     * <p>Canonical form: {@code toParticipantIds} is sorted + de-duplicated (the selection order of
     * a set must not fork the identity); blank/null entries are ignored. {@code cc} stays OUT of the
     * hash (notify-only, D30-14).</p>
     */
    static String calculate(ObjectMapper objectMapper, String content, String provider, String model,
                            String toolMode, List<String> attachmentIds,
                            Map<String, Integer> toolTimeouts, String agentPrincipalId, String branchId,
                            List<String> toParticipantIds, String asParticipantId) {
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
            if (agentPrincipalId != null) {
                canonical.put("agentPrincipalId", agentPrincipalId);
            }
            if (branchId != null) {
                canonical.put("branchId", branchId);
            }
            List<String> canonicalTo = canonicalToTargets(toParticipantIds);
            if (!canonicalTo.isEmpty()) {
                canonical.put("toParticipantIds", canonicalTo);
            }
            if (asParticipantId != null && !asParticipantId.isBlank()) {
                canonical.put("asParticipantId", asParticipantId);
            }
            byte[] bytes = objectMapper.writeValueAsBytes(canonical);
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception e) {
            throw new IllegalArgumentException("Unable to calculate request hash", e);
        }
    }

    /** Sorted, de-duplicated, blank-filtered canonical form of the TO target set. */
    static List<String> canonicalToTargets(List<String> toParticipantIds) {
        if (toParticipantIds == null || toParticipantIds.isEmpty()) {
            return List.of();
        }
        return toParticipantIds.stream()
                .filter(id -> id != null && !id.isBlank())
                .map(String::trim)
                .distinct()
                .sorted()
                .toList();
    }
}
