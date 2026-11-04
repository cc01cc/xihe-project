package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * PLAN-0665 D3 (V120): the durable delivery payload written on the user Message.
 *
 * <p>Pins the contract the UI (and later history reads) rely on: participant ids only, TO falls back
 * to the explicit responder, CC is always a list, and "nothing to persist" is a NULL payload rather
 * than an empty object (so pre-V120-shaped messages stay distinguishable).</p>
 */
class ChatDeliveryPayloadTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    private static final UUID ALPHA = UUID.fromString("11111111-1111-4111-8111-111111111111");
    private static final UUID BETA = UUID.fromString("22222222-2222-4222-8222-222222222222");

    @Test
    void nothingToPersist_isNull() {
        assertThat(ChatDeliveryPayload.toJson(objectMapper, List.of(), null, null)).isNull();
        assertThat(ChatDeliveryPayload.toJson(objectMapper, null, "  ", List.of())).isNull();
    }

    @Test
    void toSetWins_overExplicitResponderFallback() {
        String json = ChatDeliveryPayload.toJson(objectMapper, List.of(ALPHA, BETA), BETA.toString(), null);

        assertThat(json).isNotNull();
        assertThat(json).contains("11111111-1111-4111-8111-111111111111")
                .contains("22222222-2222-4222-8222-222222222222");
        // TO list is the explicit set, so the single-value fallback must not be added twice.
        assertThat(json.indexOf(ALPHA.toString())).isEqualTo(json.lastIndexOf(ALPHA.toString()));
    }

    @Test
    void explicitResponder_isPersistedAsTo_whenNoToSetIsGiven() {
        String json = ChatDeliveryPayload.toJson(objectMapper, List.of(), ALPHA.toString(), List.of());

        assertThat(json).isEqualTo("{\"to\":[\"" + ALPHA + "\"],\"cc\":[]}");
    }

    @Test
    void ccIsPersistedEvenWithoutAnyTo() {
        String json = ChatDeliveryPayload.toJson(objectMapper, null, null, List.of(BETA));

        assertThat(json).isEqualTo("{\"to\":[],\"cc\":[\"" + BETA + "\"]}");
    }

    @Test
    void orderingIsPreserved_forBothLists() {
        String json = ChatDeliveryPayload.toJson(objectMapper, List.of(BETA, ALPHA), null, List.of(ALPHA, BETA));

        assertThat(json).isEqualTo("{\"to\":[\"" + BETA + "\",\"" + ALPHA + "\"],\"cc\":[\""
                + ALPHA + "\",\"" + BETA + "\"]}");
    }

    @Test
    void blankExplicitResponder_isIgnored() {
        assertThat(ChatDeliveryPayload.toJson(objectMapper, List.of(), "   ", List.of())).isNull();
    }
}
