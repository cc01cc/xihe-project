package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0665 D3 (V120): build the durable delivery audience written on the user Message.
 *
 * <p>Shape: {@code {"to":["<participantId>",...],"cc":["<participantId>",...]}}. Participant ids only
 * — display names are resolved from the roster at render time, so a rename never leaves stale text
 * behind. {@code @}-mentions are deliberately <b>not</b> stored here: they are rebuilt from the
 * message body + roster, which already survives refreshes today (BL-239 only lost TO/CC).</p>
 *
 * <p>{@code to} falls back to the explicit responder ({@code asParticipantId}) when the caller did not
 * send a TO set — that keeps the "发送→X" badge alive across refreshes for the plain speak-as path
 * too. Returns {@code null} when there is nothing to persist (no TO and no CC), so Messages written
 * by non-composer callers keep the pre-V120 shape.</p>
 */
final class ChatDeliveryPayload {

    private ChatDeliveryPayload() {}

    static String toJson(ObjectMapper objectMapper, List<UUID> toTargets, String explicitResponder,
                         List<UUID> ccParticipantIds) {
        List<String> to = new ArrayList<>();
        if (toTargets != null && !toTargets.isEmpty()) {
            toTargets.forEach(id -> to.add(id.toString()));
        } else if (explicitResponder != null && !explicitResponder.isBlank()) {
            to.add(explicitResponder.trim());
        }
        List<String> cc = new ArrayList<>();
        if (ccParticipantIds != null) {
            ccParticipantIds.forEach(id -> cc.add(id.toString()));
        }
        if (to.isEmpty() && cc.isEmpty()) {
            return null;
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("to", to);
        payload.put("cc", cc);
        try {
            return objectMapper.writeValueAsString(payload);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("Unable to serialize message delivery payload", e);
        }
    }
}
