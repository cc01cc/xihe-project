package com.cc01cc.p.xihe.cp.policy;

import java.util.Locale;
import java.util.Set;

/**
 * Pure reuse rules for the T1.7 grant core: which reuse tiers a tool shape may receive, and the
 * mode precedence that invalidates grants across mode switches (spec §9 R4 / §10, decisions
 * #20/#27/#29). No persistence, no Spring, no chat-package dependency.
 */
public final class ReusePolicy {

    /** Grant tiers that may outlive one exact invocation. */
    public enum Tier { ONCE, SESSION, SAVED }

    /** Strictest-first mode precedence: a grant survives only into equally or less strict modes. */
    private static final int RANK_MANUAL = 1;
    private static final int RANK_AUTO = 0;

    private ReusePolicy() {}

    /** Maps a decision kind wire name to its reuse tier; reject/reject_always are not tiers. */
    public static Tier tierOf(String decisionKind) {
        if (decisionKind == null) {
            return null;
        }
        return switch (decisionKind) {
            case "once" -> Tier.ONCE;
            case "session" -> Tier.SESSION;
            case "saved" -> Tier.SAVED;
            default -> null;
        };
    }

    /**
     * Allowed decision tiers by face shape (spec §8.1): structured → once/session/saved;
     * structured+delete → once; interpreter → once/session; opaque/unclassified → once.
     */
    public static Set<Tier> allowedTiers(ToolShape shape, String actionClass) {
        if (actionClass != null && PolicyLayer.UNCLASSIFIED_ACTION.equals(actionClass)) {
            return Set.of(Tier.ONCE);
        }
        if (shape == null) {
            return Set.of(Tier.ONCE);
        }
        return switch (shape) {
            case STRUCTURED -> ToolFaceRegistry.ACTION_DELETE.equals(actionClass)
                    ? Set.of(Tier.ONCE)
                    : Set.of(Tier.ONCE, Tier.SESSION, Tier.SAVED);
            case INTERPRETER -> Set.of(Tier.ONCE, Tier.SESSION);
            case OPAQUE -> Set.of(Tier.ONCE);
        };
    }

    /** Null tiers (reject/reject_always) are never gated; opaque and unknown shapes fail closed. */
    public static boolean allows(Tier tier, ToolShape shape, String actionClass) {
        return tier == null || allowedTiers(shape, actionClass).contains(tier);
    }

    /** Mode rank; null/unknown modes rank as manual so a missing mode never loosens a check. */
    public static int modeRank(String mode) {
        if (mode == null || mode.isBlank()) {
            return RANK_MANUAL;
        }
        return switch (mode.toLowerCase(Locale.ROOT)) {
            case "manual" -> RANK_MANUAL;
            case "auto" -> RANK_AUTO;
            default -> RANK_MANUAL;
        };
    }

    /** Canonical hashes always carry the SHA-256 prefix before they enter rows or session grants. */
    public static String normalizeArgumentsHash(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String normalized = raw.trim();
        return normalized.startsWith("sha256:") ? normalized : "sha256:" + normalized;
    }
}
