package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

/** PLAN-0690 T2.1: validation/normalisation of the roster-level default delivery set. */
class SessionParticipantDeliveryDefaultsTest {

    @Test
    void aLegalSubsetPasses() {
        assertArrayEquals(new String[] {"to", "cc", "mention_only"},
                SessionParticipantDeliveryDefaults.normalize(List.of("to", "cc", "mention_only")));
    }

    @Test
    void anOutOfVocabularyValueIsA400WithTheStableCode() {
        CpApiException refused = assertThrows(CpApiException.class,
                () -> SessionParticipantDeliveryDefaults.normalize(List.of("bcc")));
        assertEquals(HttpStatus.BAD_REQUEST, refused.getStatus());
        assertEquals("PARTICIPANT_DELIVERY_DEFAULTS_INVALID", refused.getCode());
    }

    @Test
    void duplicatesAreCollapsedKeepingFirstSeenOrder() {
        assertArrayEquals(new String[] {"to", "cc"},
                SessionParticipantDeliveryDefaults.normalize(List.of("to", "to", "cc", "to")));
    }

    @Test
    void nullStaysNullAndEmptyStaysEmpty() {
        assertNull(SessionParticipantDeliveryDefaults.normalize(null),
                "omitted defaults are not backfilled; null is a distinct state");
        assertArrayEquals(new String[0],
                SessionParticipantDeliveryDefaults.normalize(List.of()));
        assertNull(SessionParticipantDeliveryDefaults.viewOf(null));
        assertEquals(List.of("cc"),
                SessionParticipantDeliveryDefaults.viewOf(new String[] {"cc"}));
    }
}
