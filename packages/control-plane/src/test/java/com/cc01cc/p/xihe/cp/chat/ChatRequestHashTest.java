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

    // --- PLAN-0689 A2 (T1.2 / verify.md V16): the two identity generations, pinned as constants.
    // Same logical inputs throughout (content/provider/model/toolMode, empty attachments and
    // timeouts); only the principal input differs, so the hex strings isolate that one variable.
    private static final String V16_PRINCIPAL = "11111111-1111-1111-1111-111111111111";
    private static final String V16_BRANCH = "22222222-2222-2222-2222-222222222222";
    /** v2: the principal was part of the identity — this is the value stored by the old code. */
    private static final String V16_V2_WITH_PRINCIPAL =
            "6b4ef24474584aa3fbe4aca62dd9cc5a18adce6cb4f89292cbfac745bb7ee751";
    /** v2: a path that never carried a principal (spawn/inherit chains). */
    private static final String V16_NO_PRINCIPAL =
            "e59dc6fee74caa3779344b48e1454c6da3c9fd149aa2497bacf87285cc3de67e";
    /** v3: the main path after the wire field was deleted — same inputs, principal passed null. */
    private static final String V16_V3_MAIN_PATH =
            "42228392df6371f6fd0689b58e9aa2517d5e63c6e2a58d0b9972c2b7c3d38352";

    @Test
    void v2_withPrincipal_keepsItsExactHash() {
        String hash = ChatRequestHash.calculate(objectMapper, "hello", "openai", "gpt-4o", "none",
                List.of(), Map.of(), V16_PRINCIPAL, V16_BRANCH);
        assertThat(hash).isEqualTo(V16_V2_WITH_PRINCIPAL);
    }

    @Test
    void v2_wideOverload_withSameInputs_matchesTheNarrowOne() {
        // An empty target set and an absent asParticipantId add no canonical keys, so the 11-arg
        // overload the main path uses must agree with the 9-arg one the follow-up path uses.
        String hash = ChatRequestHash.calculate(objectMapper, "hello", "openai", "gpt-4o", "none",
                List.of(), Map.of(), V16_PRINCIPAL, V16_BRANCH, List.of(), null);
        assertThat(hash).isEqualTo(V16_V2_WITH_PRINCIPAL);
    }

    @Test
    void v3_mainPath_passesNullPrincipal_andDropsTheKey() {
        // PLAN-0689 design §3 B3: the wire field is retired, so the main path always passes null
        // and "agentPrincipalId" never enters the canonical form — this is identity v3.
        String hash = ChatRequestHash.calculate(objectMapper, "hello", "openai", "gpt-4o", "none",
                List.of(), Map.of(), null, V16_BRANCH, List.of(), null);
        assertThat(hash).isEqualTo(V16_V3_MAIN_PATH);
        assertThat(hash).isNotEqualTo(V16_V2_WITH_PRINCIPAL);
    }

    @Test
    void v3_dropsTheKey_withoutDisturbingTheBareOverload() {
        // The key removal must not disturb paths that never carried a principal at all.
        String hash = ChatRequestHash.calculate(objectMapper, "hello", "openai", "gpt-4o", "none",
                List.of(), Map.of());
        assertThat(hash).isEqualTo(V16_NO_PRINCIPAL);
    }
}
