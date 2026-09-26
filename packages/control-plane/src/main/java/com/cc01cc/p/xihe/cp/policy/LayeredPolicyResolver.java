package com.cc01cc.p.xihe.cp.policy;

/**
 * Shape-aware resource matcher and approval mode constants.
 *
 * <p>PLAN-0407 T2.8 (design #18/#21/#27) retired the layered rule adjudication that used to live
 * here ({@code resolve} → layer selection → allow/ask/deny): authorization is now the grant
 * lookup and the approval trigger is the approval-policy ask list. What remains is the shared
 * matcher consumed by {@link GrantIntersectionEvaluator} (design #27: keep the shared
 * implementation, drop the rule verdict machinery) plus the {@code manual}/{@code auto} approval
 * mode constants that belong to the approval system.</p>
 */
public class LayeredPolicyResolver {

    public static final String MODE_MANUAL = "manual";
    public static final String MODE_AUTO = "auto";

    /** Path-style matching: {@code *} does not cross {@code /}, {@code **} does. */
    static boolean matches(String pattern, String value) {
        return matches(pattern, value, ToolShape.STRUCTURED);
    }

    /**
     * Shape-aware matching (spec §8.1): structured tools treat resources as paths ({@code *} does not
     * cross {@code /}), while interpreter/opaque tools treat them as free text (command strings), where
     * {@code *} must be able to match arguments containing {@code /} (e.g. {@code rm -rf *}).
     */
    static boolean matches(String pattern, String value, ToolShape shape) {
        if (pattern == null || value == null) {
            return false;
        }
        if ("*".equals(pattern)) {
            return true;
        }
        String normalizedPattern = pattern.replace('\\', '/');
        String normalizedValue = value.replace('\\', '/');
        if (!normalizedPattern.contains("*")) {
            return normalizedPattern.equals(normalizedValue);
        }
        boolean pathSemantics = shape == ToolShape.STRUCTURED;
        return normalizedValue.matches(toRegex(normalizedPattern, pathSemantics));
    }

    /**
     * Glob → regex. Under path semantics a single {@code *} does not cross path separators and
     * {@code **} does; under free-text semantics both match anything.
     */
    private static String toRegex(String pattern, boolean pathSemantics) {
        StringBuilder regex = new StringBuilder();
        for (int i = 0; i < pattern.length(); i++) {
            char c = pattern.charAt(i);
            if (c == '*') {
                boolean doubleStar = i + 1 < pattern.length() && pattern.charAt(i + 1) == '*';
                if (doubleStar) {
                    i++;
                }
                regex.append(doubleStar || !pathSemantics ? ".*" : "[^/]*");
            } else if ("\\.[]{}()+-^$|?".indexOf(c) >= 0) {
                regex.append('\\').append(c);
            } else {
                regex.append(c);
            }
        }
        return regex.toString();
    }
}
