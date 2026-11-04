package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * PLAN-0665 D6: the idempotency request hash must cover the TO target set and the explicit
 * responder ({@code asParticipantId}), while staying order-insensitive for the set itself.
 *
 * <p>Also pins the pre-existing bug fix: before this change {@code asParticipantId} was absent from
 * the hash, so the same content sent as two different participants under one Idempotency-Key
 * replayed the first run (design §2.2 supersede row: hashes change ⇒ old-key replays answer
 * {@code 409 IDEMPOTENCY_KEY_CONFLICT}).</p>
 */
class ChatRequestHashTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    private String hash(List<String> to, String as) {
        return ChatRequestHash.calculate(objectMapper, "hello", "openai", "fake-openai", "none",
                List.of(), Map.of(), "principal-1", "branch-1", to, as);
    }

    @Test
    void differentTargetSets_produceDifferentHashes() {
        String single = hash(List.of("p-alpha"), null);
        String pair = hash(List.of("p-alpha", "p-beta"), null);
        String otherPair = hash(List.of("p-alpha", "p-gamma"), null);

        assertThat(pair).isNotEqualTo(single);
        assertThat(pair).isNotEqualTo(otherPair);
    }

    @Test
    void targetSetOrder_doesNotForkIdentity() {
        assertThat(hash(List.of("p-alpha", "p-beta"), null))
                .isEqualTo(hash(List.of("p-beta", "p-alpha"), null));
    }

    @Test
    void duplicateTargets_collapseToTheSameIdentity() {
        assertThat(hash(List.of("p-alpha", "p-alpha"), null))
                .isEqualTo(hash(List.of("p-alpha"), null));
    }

    @Test
    void asParticipantId_isPartOfIdentity() {
        assertThat(hash(null, "participant-a")).isNotEqualTo(hash(null, "participant-b"));
        assertThat(hash(null, "participant-a")).isNotEqualTo(hash(null, null));
    }

    @Test
    void blankAsParticipantId_isTreatedAsAbsent() {
        assertThat(hash(null, "  ")).isEqualTo(hash(null, null));
    }

    @Test
    void emptyOrNullTargetSet_isTreatedAsAbsent() {
        assertThat(hash(List.of(), null)).isEqualTo(hash(null, null));
        assertThat(hash(List.of("  "), null)).isEqualTo(hash(null, null));
    }

    @Test
    void legacyOverloads_keepTheirExactHash() {
        // Backward compatibility: the 8/9-arg overloads (used by queued follow-up replay) must keep
        // producing today's value — otherwise stored hashes would stop matching after an upgrade.
        String legacy = ChatRequestHash.calculate(objectMapper, "hello", "openai", "fake-openai",
                "none", List.of(), Map.of(), "principal-1", "branch-1");
        assertThat(legacy).isEqualTo(hash(null, null));
    }

    @Test
    void canonicalToTargets_sortsDeduplicatesAndFiltersBlanks() {
        assertThat(ChatRequestHash.canonicalToTargets(List.of("b", "a", "b", "  ", "c")))
                .containsExactly("a", "b", "c");
        assertThat(ChatRequestHash.canonicalToTargets(null)).isEmpty();
        assertThat(ChatRequestHash.canonicalToTargets(List.of())).isEmpty();
    }
}
