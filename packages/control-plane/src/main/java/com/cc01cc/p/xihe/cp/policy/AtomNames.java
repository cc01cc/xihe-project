package com.cc01cc.p.xihe.cp.policy;

import java.util.Locale;

/**
 * task-835: the canonical spelling of a permission atom.
 *
 * <p>Two prefixes, one per atom family (DEV-037 / DEV-038):</p>
 *
 * <ul>
 *   <li>{@code action:} — the 42 action atoms, e.g. {@code action:read},
 *       {@code action:MANAGE_WORKSPACE_MEMBERS}, {@code action:session:permission:configure}.</li>
 *   <li>{@code cap:} — the 3 capability atoms, e.g. {@code cap:instance:admin}. The authority
 *       string of a capability is the atom name itself; there is no second {@code cap:} layer.</li>
 * </ul>
 *
 * <p>The canonical form is the <b>only</b> form a grant atom, a preset seed, an API field or an
 * evaluation result may carry. {@link #action(String)} exists for the one documented boundary that
 * speaks a different vocabulary: the tool-face layer ({@link ToolFaceRegistry}'s action classes and
 * the persisted {@code policy_rules}/{@code tool_faces} rows) maps a face to an atom there. This is
 * a layer translation, not an alias: nothing accepts {@code read} where an atom is expected.</p>
 */
public final class AtomNames {

    public static final String ACTION_PREFIX = "action:";
    public static final String CAPABILITY_PREFIX = "cap:";

    private AtomNames() {
    }

    /** The canonical action-atom name ({@code action:<class>}); idempotent, null-safe. */
    public static String action(String actionClass) {
        if (actionClass == null) {
            return null;
        }
        String value = actionClass.trim();
        if (value.isEmpty() || value.startsWith(ACTION_PREFIX) || value.startsWith(CAPABILITY_PREFIX)) {
            return value;
        }
        return ACTION_PREFIX + value;
    }

    /** The canonical capability-atom name ({@code cap:<atom>}); idempotent, null-safe. */
    public static String capability(String capability) {
        if (capability == null) {
            return null;
        }
        String value = capability.trim();
        if (value.isEmpty() || value.startsWith(CAPABILITY_PREFIX)) {
            return value;
        }
        return CAPABILITY_PREFIX + value;
    }

    /** The atom without its family prefix ({@code read}, {@code instance:admin}). */
    public static String bare(String atom) {
        if (atom == null) {
            return null;
        }
        String value = atom.trim();
        if (value.startsWith(ACTION_PREFIX)) {
            return value.substring(ACTION_PREFIX.length());
        }
        if (value.startsWith(CAPABILITY_PREFIX)) {
            return value.substring(CAPABILITY_PREFIX.length());
        }
        return value;
    }

    /** True when the atom carries one of the two canonical family prefixes. */
    public static boolean isPrefixed(String atom) {
        if (atom == null) {
            return false;
        }
        String value = atom.trim();
        return value.startsWith(ACTION_PREFIX) || value.startsWith(CAPABILITY_PREFIX);
    }

    /**
     * Shapes an atom for a scope comparison: lowercase, family prefix kept. Only used for
     * diagnostic/legacy spellings; the vocabulary itself is case-sensitive.
     */
    public static String normalize(String atom) {
        String value = isPrefixed(atom) ? atom.trim() : action(atom);
        return value == null ? null : value.toLowerCase(Locale.ROOT);
    }
}
