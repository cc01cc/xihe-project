package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.springframework.http.HttpStatus;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.UUID;

/**
 * PLAN-0665 M1: the {@code toParticipantIds} wire field — parse + canonicalization.
 *
 * <p>Semantics (design §2, Q1/Q3): the composer's "发送" may select 1..N <b>AGENT</b> participants;
 * each selected target answers with its own run. This class owns the pure, side-effect-free parts so
 * they can be unit-tested without a Spring context:</p>
 *
 * <ul>
 *   <li>{@link #parse(Object)} — validate the raw JSON value and return de-duplicated UUIDs in
 *       <b>first-seen order</b> (selection order matters for dispatch/queueing, D2).</li>
 *   <li>{@link #canonical(List)} — sorted + de-duplicated string form used by the idempotency hash
 *       (D6: set order must not fork the request identity).</li>
 * </ul>
 *
 * <p>Entries are participant ids, not principal ids. Authz classification (AGENT-only in M1) lives in
 * {@code SessionParticipantService#authorizeToTargets} because it needs the roster.</p>
 */
final class ChatToTargets {

    static final String FIELD = "toParticipantIds";

    private ChatToTargets() {}

    /**
     * Parse the raw JSON value: {@code null} → empty list (field absent = today's single-TO path),
     * otherwise it must be an array of participant UUID strings. Blank/non-UUID entries answer
     * {@code 400 INVALID_REQUEST} (fail-closed; never silently dropped), duplicates collapse while
     * preserving first-seen order.
     */
    static List<UUID> parse(Object raw) {
        if (raw == null) {
            return List.of();
        }
        if (!(raw instanceof List<?> list)) {
            throw invalid("toParticipantIds must be an array of participant UUID strings");
        }
        LinkedHashSet<UUID> ordered = new LinkedHashSet<>();
        for (Object item : list) {
            if (!(item instanceof String value) || value.isBlank()) {
                throw invalid("toParticipantIds entries must be participant UUID strings");
            }
            try {
                ordered.add(UUID.fromString(value.trim()));
            } catch (IllegalArgumentException notAUuid) {
                throw invalid("toParticipantIds entries must be participant UUID strings");
            }
        }
        return new ArrayList<>(ordered);
    }

    /** Sorted, de-duplicated, blank-filtered string form — the hash input (order-insensitive). */
    static List<String> canonical(List<UUID> participantIds) {
        if (participantIds == null || participantIds.isEmpty()) {
            return List.of();
        }
        return participantIds.stream()
                .filter(java.util.Objects::nonNull)
                .map(UUID::toString)
                .distinct()
                .sorted()
                .toList();
    }

    private static CpApiException invalid(String detail) {
        return new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", detail);
    }
}
