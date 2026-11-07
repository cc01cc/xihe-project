package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.springframework.http.HttpStatus;

import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * PLAN-0690 T2.1: the roster-level default delivery roles stored in
 * {@code session_participants.delivery_defaults}. The values are lower-case wire tokens (not the
 * upper-case policy vocabulary) because they travel in the same shape the composer consumes.
 *
 * <p>The database CHECK is the last line of defence; this class gives the API a stable 400 before
 * the row is written and normalises duplicates so the stored array stays a set.</p>
 */
public final class SessionParticipantDeliveryDefaults {

    public static final String TO = "to";
    public static final String CC = "cc";
    public static final String MENTION_ONLY = "mention_only";
    public static final Set<String> ALLOWED = Set.of(TO, CC, MENTION_ONLY);

    private SessionParticipantDeliveryDefaults() {}

    /**
     * Validates and de-duplicates a requested set, preserving the caller's first-seen order.
     * {@code null} means "no defaults configured" and stays {@code null}; an empty list is legal
     * and stores an empty array.
     */
    public static String[] normalize(List<String> requested) {
        if (requested == null) {
            return null;
        }
        LinkedHashSet<String> values = new LinkedHashSet<>();
        for (String value : requested) {
            if (value == null || !ALLOWED.contains(value)) {
                throw invalid();
            }
            values.add(value);
        }
        return values.toArray(String[]::new);
    }

    /** The read face: {@code null} stays {@code null}; a stored array becomes an ordered list. */
    public static List<String> viewOf(String[] stored) {
        return stored == null ? null : List.copyOf(Arrays.asList(stored));
    }

    private static CpApiException invalid() {
        return new CpApiException(HttpStatus.BAD_REQUEST, "PARTICIPANT_DELIVERY_DEFAULTS_INVALID",
                "deliveryDefaults may contain only to, cc, mention_only");
    }
}
