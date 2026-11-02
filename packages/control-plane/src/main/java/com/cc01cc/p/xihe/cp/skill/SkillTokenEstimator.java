package com.cc01cc.p.xihe.cp.skill;

/**
 * PLAN-0628 M1: the Java half of the cross-language token estimate.
 *
 * <p><b>This formula is a contract with Python</b> —
 * {@code packages/agent/src/xihe_agent/context/injection_budget.py#conservative_token_count} is
 * {@code max(1, len(text) // 2)} where Python's {@code len} counts <b>code points</b>. The Java
 * mirror is therefore {@code codePointCount // 2}, never {@code String.length() // 2}: an astral
 * character (emoji) is 2 UTF-16 units but 1 code point, and a mismatch would make
 * {@code body_tokens_est} / the {@code oversize} flag disagree with the Agent's budget (risk R4).</p>
 *
 * <p>Migration line it must stay consistent with:
 * {@code V101__skills_and_bindings.sql} → {@code ck_skills_oversize CHECK (oversize =
 * (body_tokens_est > 5000))}, i.e. {@link Skill#OVERSIZE_TOKENS}.</p>
 */
public final class SkillTokenEstimator {

    private SkillTokenEstimator() {}

    /** Empty ⇒ 0; otherwise at least 1, so a tiny body is never free. */
    public static int estimate(String body) {
        if (body == null || body.isEmpty()) {
            return 0;
        }
        return Math.max(1, body.codePointCount(0, body.length()) / 2);
    }

    /** D28-15: marked, never rejected — this is the single place that decides the flag. */
    public static boolean isOversize(int estimatedTokens) {
        return estimatedTokens > Skill.OVERSIZE_TOKENS;
    }
}
