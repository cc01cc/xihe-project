package com.cc01cc.p.xihe.cp.skill;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0628 M1 (taskbook T8): the token estimate.
 *
 * <p>This is the piece most likely to look right and be wrong: a naive port of the Python
 * {@code len(text) // 2} becomes {@code String.length() / 2} in Java, which silently disagrees for
 * every astral character (an emoji is 2 UTF-16 units but 1 code point). The estimate feeds
 * {@code body_tokens_est}, the {@code oversize} flag and therefore the Agent's budget, so a mismatch
 * would surface as "the listing was cut for no reason".</p>
 *
 * <p>Contract: mirrors {@code injection_budget.conservative_token_count} —
 * {@code max(1, codePointCount // 2)}, and exactly {@code 0} for empty input.</p>
 */
class SkillTokenEstimatorTest {

    @Test
    void emptyAndNullAreZero() {
        assertEquals(0, SkillTokenEstimator.estimate(""));
        assertEquals(0, SkillTokenEstimator.estimate(null));
    }

    @Test
    void aSingleCharacterIsNeverFree() {
        // max(1, 0//2) — a one-character body must still cost something, or "free" text could pile up.
        assertEquals(1, SkillTokenEstimator.estimate("a"));
        assertEquals(1, SkillTokenEstimator.estimate("写"));
    }

    @Test
    void latinIsTwoCodePointsPerToken() {
        assertEquals(1, SkillTokenEstimator.estimate("ab"));
        assertEquals(2, SkillTokenEstimator.estimate("abcd"));
        assertEquals(5, SkillTokenEstimator.estimate("abcdefghij"));
    }

    @Test
    void cjkCountsByCodePointNotByte() {
        // "写作规范" is 4 code points (12 UTF-8 bytes): bytes would give 6, UTF-16 length gives 4.
        assertEquals(2, SkillTokenEstimator.estimate("写作规范"));
        assertEquals(4, SkillTokenEstimator.estimate("写作规范写作规范"));
    }

    @Test
    void astralCharactersAreOneCodePointEach() {
        // "a😀b": 3 code points but String.length() == 4 ⇒ the naive port would say 2, the contract
        // says 1. This single assertion is the reason the class uses codePointCount.
        assertEquals(3, "a😀b".codePointCount(0, "a😀b".length()));
        assertEquals(4, "a😀b".length());
        assertEquals(1, SkillTokenEstimator.estimate("a😀b"));
        assertEquals(1, SkillTokenEstimator.estimate("😀😀"));
        assertEquals(2, SkillTokenEstimator.estimate("😀😀😀😀"));
    }

    @Test
    void theOversizeThresholdIsStrictlyGreaterThanFiveThousand() {
        // 10 000 code points ⇒ exactly 5000 tokens ⇒ NOT oversize (D28-15 boundary is "> 5000").
        int atThreshold = SkillTokenEstimator.estimate("x".repeat(10_000));
        assertEquals(Skill.OVERSIZE_TOKENS, atThreshold);
        assertFalse(SkillTokenEstimator.isOversize(atThreshold));

        // One more token crosses it.
        int justOver = SkillTokenEstimator.estimate("x".repeat(10_002));
        assertEquals(Skill.OVERSIZE_TOKENS + 1, justOver);
        assertTrue(SkillTokenEstimator.isOversize(justOver));

        // 10 001 code points floors to 5000 — the boundary is a floor, not a round.
        assertEquals(Skill.OVERSIZE_TOKENS, SkillTokenEstimator.estimate("x".repeat(10_001)));
    }

    @Test
    void theThresholdMatchesTheMigrationCheck() {
        // V101: ck_skills_oversize CHECK (oversize = (body_tokens_est > 5000)).
        assertTrue(SkillTokenEstimator.isOversize(Skill.OVERSIZE_TOKENS + 1));
        assertFalse(SkillTokenEstimator.isOversize(Skill.OVERSIZE_TOKENS));
        assertFalse(SkillTokenEstimator.isOversize(0));
    }
}
