package com.cc01cc.p.xihe.cp.chat;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0328 M1 T1.9 (spec §3 ⑦/⑧, §12, decisions #18/#22): the pluggable answerer chain —
 * fall-through, per-answerer failure isolation and the fail-closed all-UNAVAILABLE verdict.
 */
class AnswererChainTest {

    private static final ApprovalAnswerer.Ask ASK = new ApprovalAnswerer.Ask(
            "55555555-5555-5555-5555-555555555555", "write_file", "Execute write_file", "preview");

    private static ApprovalAnswerer answerer(String id, ApprovalAnswerer.Answer answer) {
        return new ApprovalAnswerer() {
            @Override
            public String id() {
                return id;
            }

            @Override
            public Answer answer(Ask ask) {
                return answer;
            }
        };
    }

    private static ApprovalAnswerer throwing(String id) {
        return new ApprovalAnswerer() {
            @Override
            public String id() {
                return id;
            }

            @Override
            public Answer answer(Ask ask) {
                throw new IllegalStateException("answerer exploded");
            }
        };
    }

    @Test
    void deferFallsThroughAndALaterAnswerWins() {
        AnswererChain chain = new AnswererChain(List.of(
                answerer("first", ApprovalAnswerer.Answer.defer("not mine")),
                answerer("second", ApprovalAnswerer.Answer.allow("reviewed"))));

        AnswererChain.Resolution resolution = chain.resolve(ASK);

        assertEquals(ApprovalAnswerer.Outcome.ALLOW, resolution.outcome());
        assertEquals("second", resolution.answerer());
        assertEquals("reviewed", resolution.reason());
    }

    @Test
    void unavailableFallsThroughToTheNextAnswerer() {
        AnswererChain chain = new AnswererChain(List.of(
                answerer(AutoReviewAnswerer.ID, ApprovalAnswerer.Answer.unavailable("tier off")),
                new UserAnswerer()));

        AnswererChain.Resolution resolution = chain.resolve(ASK);

        assertEquals(ApprovalAnswerer.Outcome.DEFER, resolution.outcome());
        assertEquals(UserAnswerer.ID, resolution.answerer());
    }

    @Test
    void deferSurvivesWhenEveryLaterAnswererIsUnavailable() {
        AnswererChain chain = new AnswererChain(List.of(
                new UserAnswerer(),
                answerer(AutoReviewAnswerer.ID, ApprovalAnswerer.Answer.unavailable("tier off"))));

        AnswererChain.Resolution resolution = chain.resolve(ASK);

        assertEquals(ApprovalAnswerer.Outcome.DEFER, resolution.outcome());
        assertEquals(UserAnswerer.ID, resolution.answerer());
    }

    @Test
    void firstAllowOrDenyWinsInOrder() {
        AnswererChain chain = new AnswererChain(List.of(
                answerer("first", ApprovalAnswerer.Answer.deny("no")),
                answerer("second", ApprovalAnswerer.Answer.allow("yes"))));

        AnswererChain.Resolution resolution = chain.resolve(ASK);

        assertEquals(ApprovalAnswerer.Outcome.DENY, resolution.outcome());
        assertEquals("first", resolution.answerer());
    }

    @Test
    void allUnavailableResolvesFailClosedAsNone() {
        AnswererChain chain = new AnswererChain(List.of(
                answerer(AutoReviewAnswerer.ID, ApprovalAnswerer.Answer.unavailable("tier off")),
                answerer("fallback", ApprovalAnswerer.Answer.unavailable("nothing to add"))));

        AnswererChain.Resolution resolution = chain.resolve(ASK);

        assertEquals(ApprovalAnswerer.Outcome.UNAVAILABLE, resolution.outcome());
        assertEquals(AnswererChain.ANSWERER_NONE, resolution.answerer());
        assertEquals("none", resolution.answerer());
    }

    @Test
    void emptyChainResolvesFailClosedAsNone() {
        AnswererChain.Resolution resolution = new AnswererChain(List.of()).resolve(ASK);

        assertEquals(ApprovalAnswerer.Outcome.UNAVAILABLE, resolution.outcome());
        assertEquals(AnswererChain.ANSWERER_NONE, resolution.answerer());
    }

    @Test
    void throwingAnswererBecomesUnavailableAndCanNeverAllow() {
        AnswererChain.Resolution alone = new AnswererChain(List.of(throwing(AutoReviewAnswerer.ID)))
                .resolve(ASK);

        assertEquals(ApprovalAnswerer.Outcome.UNAVAILABLE, alone.outcome());
        assertNotEquals(ApprovalAnswerer.Outcome.ALLOW, alone.outcome());
        assertEquals(AnswererChain.ANSWERER_NONE, alone.answerer());
    }

    @Test
    void throwingAnswererFallsThroughToTheHumanAnswerer() {
        AnswererChain chain = new AnswererChain(List.of(throwing(AutoReviewAnswerer.ID), new UserAnswerer()));

        AnswererChain.Resolution resolution = chain.resolve(ASK);

        assertEquals(ApprovalAnswerer.Outcome.DEFER, resolution.outcome());
        assertEquals(UserAnswerer.ID, resolution.answerer());
        assertNotEquals(ApprovalAnswerer.Outcome.ALLOW, resolution.outcome());
    }

    @Test
    void answererReturningNothingIsTreatedAsUnavailable() {
        AnswererChain chain = new AnswererChain(List.of(answerer("silent", null), new UserAnswerer()));

        AnswererChain.Resolution resolution = chain.resolve(ASK);

        assertEquals(ApprovalAnswerer.Outcome.DEFER, resolution.outcome());
        assertEquals(UserAnswerer.ID, resolution.answerer());
    }

    @Test
    void userAnswererOnlyDefersAndNeverAllows() {
        UserAnswerer answerer = new UserAnswerer();
        ApprovalAnswerer.Answer answer = answerer.answer(ASK);

        assertEquals(UserAnswerer.ID, answerer.id());
        assertEquals(ApprovalAnswerer.Outcome.DEFER, answer.outcome());
        assertNotEquals(ApprovalAnswerer.Outcome.ALLOW, answer.outcome());
        assertNotEquals(ApprovalAnswerer.Outcome.DENY, answer.outcome());
    }

    @Test
    void autoReviewAnswererIsOffAndNeverAllows() {
        AutoReviewAnswerer answerer = new AutoReviewAnswerer();
        ApprovalAnswerer.Answer answer = answerer.answer(ASK);

        assertEquals(AutoReviewAnswerer.Tier.OFF, AutoReviewAnswerer.TIER);
        assertEquals(AutoReviewAnswerer.ID, answerer.id());
        assertEquals(ApprovalAnswerer.Outcome.UNAVAILABLE, answer.outcome());
        assertNotEquals(ApprovalAnswerer.Outcome.ALLOW, answer.outcome());

        AnswererChain.Resolution resolution = new AnswererChain(List.of(answerer)).resolve(ASK);
        assertEquals(ApprovalAnswerer.Outcome.UNAVAILABLE, resolution.outcome());
        assertEquals(AnswererChain.ANSWERER_NONE, resolution.answerer());
    }

    @Test
    void answerReasonIsBoundedAndRedacted() {
        ApprovalAnswerer.Answer answer = ApprovalAnswerer.Answer.defer(
                "Bearer abc123tokenvalue " + "x".repeat(400));

        assertNotNull(answer.reason());
        assertTrue(answer.reason().length() <= 201, "reason must stay bounded");
        assertTrue(answer.reason().contains("***redacted***"));
        assertFalse(answer.reason().contains("abc123tokenvalue"));
        assertNull(ApprovalAnswerer.Answer.unavailable("   ").reason());
    }
}
