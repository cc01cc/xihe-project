package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * PLAN-0665 M1: {@code toParticipantIds} wire-shape validation + canonicalization.
 *
 * <p>Fail-closed by design: a malformed selector answers {@code 400 INVALID_REQUEST} instead of being
 * silently dropped (a dropped target would look like "the agent ignored me" rather than a bad request).
 * Order matters for dispatch/queueing (D2) but NOT for the idempotency identity (D6).</p>
 */
class ChatToTargetsTest {

    private static final String ALPHA = "11111111-1111-4111-8111-111111111111";
    private static final String BETA = "22222222-2222-4222-8222-222222222222";

    @Test
    void absentField_isTheSingleTargetPath() {
        assertThat(ChatToTargets.parse(null)).isEmpty();
    }

    @Test
    void emptyArray_isAllowedAndMeansNoExplicitTarget() {
        assertThat(ChatToTargets.parse(List.of())).isEmpty();
    }

    // task-443 (F-12 / D-1273): parse() collapses absent and explicit-empty to the same empty list,
    // so the presence distinction the suppression branch needs lives in this classifier.
    @Test
    void explicitEmptySelection_absentField_isNotExplicitEmpty() {
        assertThat(ChatToTargets.isExplicitEmptySelection(null)).isFalse();
    }

    @Test
    void explicitEmptySelection_presentEmptyArray_isExplicitEmpty() {
        assertThat(ChatToTargets.isExplicitEmptySelection(List.of())).isTrue();
        assertThat(ChatToTargets.isExplicitEmptySelection(new java.util.ArrayList<>())).isTrue();
    }

    @Test
    void explicitEmptySelection_nonEmptyArray_isNotExplicitEmpty() {
        assertThat(ChatToTargets.isExplicitEmptySelection(List.of(ALPHA))).isFalse();
    }

    @Test
    void explicitEmptySelection_nonArray_isNotExplicitEmpty() {
        // a non-array shape is rejected by parse() before the classifier is consulted; defensively false
        assertThat(ChatToTargets.isExplicitEmptySelection(ALPHA)).isFalse();
        assertThat(ChatToTargets.isExplicitEmptySelection("")).isFalse();
    }

    @Test
    void preservesFirstSeenOrder_andDeduplicates() {
        assertThat(ChatToTargets.parse(List.of(BETA, ALPHA, BETA)))
                .containsExactly(UUID.fromString(BETA), UUID.fromString(ALPHA));
    }

    @Test
    void nonArrayValue_isRejected() {
        assertThatThrownBy(() -> ChatToTargets.parse(ALPHA))
                .isInstanceOf(CpApiException.class)
                .satisfies(thrown -> {
                    CpApiException problem = (CpApiException) thrown;
                    assertThat(problem.getStatus()).isEqualTo(HttpStatus.BAD_REQUEST);
                    assertThat(problem.getCode()).isEqualTo("INVALID_REQUEST");
                });
    }

    @Test
    void nonStringEntries_areRejected() {
        assertThatThrownBy(() -> ChatToTargets.parse(List.of(42)))
                .isInstanceOf(CpApiException.class);
        assertThatThrownBy(() -> ChatToTargets.parse(java.util.Arrays.asList((Object) null)))
                .isInstanceOf(CpApiException.class);
    }

    @Test
    void blankEntries_areRejected() {
        assertThatThrownBy(() -> ChatToTargets.parse(List.of("  ")))
                .isInstanceOf(CpApiException.class);
    }

    @Test
    void nonUuidEntries_areRejected() {
        assertThatThrownBy(() -> ChatToTargets.parse(List.of("not-a-uuid")))
                .isInstanceOf(CpApiException.class)
                .hasMessageContaining("UUID");
    }

    @Test
    void canonicalForm_isSortedAndDistinct() {
        assertThat(ChatToTargets.canonical(List.of(UUID.fromString(BETA), UUID.fromString(ALPHA))))
                .containsExactly(ALPHA, BETA);
        assertThat(ChatToTargets.canonical(List.of())).isEmpty();
        assertThat(ChatToTargets.canonical(null)).isEmpty();
    }
}
