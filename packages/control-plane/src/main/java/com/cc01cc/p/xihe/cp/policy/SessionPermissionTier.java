package com.cc01cc.p.xihe.cp.policy;

import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;

/**
 * Session permission tier (D-1908 rev4): {@code view | workspace | full}, stored on
 * {@code sessions.permission_tier}; {@code NULL} means "inherit the workspace layer".
 *
 * <p><b>One direction only</b>: the tier is the source of truth and {@code sessions.approval_mode}
 * is DERIVED from it ({@link #modeForTier}: view/workspace {@code ->} manual, full {@code ->} auto).
 * The legacy column stays readable for rows written before V176 — never the other way round.</p>
 *
 * <p><b>Strictest wins</b> ({@link #strictestMode}): the session tier and the workspace
 * {@code approval-policy.mode} are combined by taking the stricter one, so a session can never
 * relax the workspace. The pre-V176 precedence (a session value replaced the workspace value
 * whenever it was present, even when looser) is intentionally gone.</p>
 *
 * <p><b>Scope</b>: this card tiers only the SESSION layer. The workspace layer still speaks
 * manual/auto through {@code approval-policy.mode}; turning that layer into
 * view/workspace/full is D-1908's follow-up card (task-107b), not this one. Do not mix the two
 * vocabularies without that note.</p>
 */
public final class SessionPermissionTier {

    public static final String VIEW = "view";
    public static final String WORKSPACE = "workspace";
    public static final String FULL = "full";

    /** Allowed values of {@code sessions.permission_tier}; mirrors the V176 CHECK constraint. */
    public static final Set<String> TIERS = Set.of(VIEW, WORKSPACE, FULL);

    /** Ordered strictest to loosest, for humans and tests. */
    public static final List<String> STRICTNESS_ORDER = List.of(VIEW, WORKSPACE, FULL);

    /** Fail-closed tier when the session row cannot be read at all. */
    public static final String FAIL_CLOSED_TIER = VIEW;

    /** Audit marker stored on {@link PolicyContext#tierFallback()} when the tier read failed. */
    public static final String FALLBACK_SESSION_READ_FAILED = "session-tier-unreadable";

    private SessionPermissionTier() {}

    /** Normalizes a stored tier; empty for null/blank/unknown (an unknown value is never guessed). */
    public static Optional<String> normalize(String raw) {
        if (raw == null || raw.isBlank()) {
            return Optional.empty();
        }
        String tier = raw.trim().toLowerCase(Locale.ROOT);
        return TIERS.contains(tier) ? Optional.of(tier) : Optional.empty();
    }

    /** Approval mode derived from a tier: view/workspace become manual, full becomes auto. */
    public static String modeForTier(String tier) {
        return FULL.equals(normalize(tier).orElse(null))
                ? LayeredPolicyResolver.MODE_AUTO
                : LayeredPolicyResolver.MODE_MANUAL;
    }

    /** Tier equivalent of a legacy {@code approval_mode} row: auto becomes full, everything else
     * workspace. Used only to READ rows written before V176; new writes always set the tier. */
    public static String tierForMode(String mode) {
        return LayeredPolicyResolver.MODE_AUTO.equalsIgnoreCase(mode) ? FULL : WORKSPACE;
    }

    /** The stricter of two approval modes; equal values keep {@code a}, and null never wins. */
    public static String strictestMode(String a, String b) {
        return modeRank(a) >= modeRank(b) ? a : b;
    }

    /** manual is stricter than auto; an unknown/null mode has no opinion (-1). */
    public static int modeRank(String mode) {
        if (LayeredPolicyResolver.MODE_MANUAL.equalsIgnoreCase(mode)) {
            return 1;
        }
        if (LayeredPolicyResolver.MODE_AUTO.equalsIgnoreCase(mode)) {
            return 0;
        }
        return -1;
    }
}
