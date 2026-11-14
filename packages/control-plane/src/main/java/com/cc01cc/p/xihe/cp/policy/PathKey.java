package com.cc01cc.p.xihe.cp.policy;

import java.io.IOException;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;

/**
 * task-505 (D-1320/D-1357): the single path-normalisation implementation, with the
 * <b>lexical</b> and <b>real</b> levels kept strictly apart.
 *
 * <p>Two sites disagreed before this class: the workspace-root containment check folded case and
 * stripped trailing slashes, while the policy resource matcher did neither. The same physical path
 * produced opposite verdicts with no error. A third ({@code WorkspaceService.comparablePath}) and a
 * fourth ({@code normalizeRoots}' duplicate key) variant existed too; all comparison sites now call
 * this class.</p>
 *
 * <p><b>Same-source rule (load-bearing):</b> a comparison is either <b>lexical vs lexical</b> or
 * <b>real vs real</b> — never mixed. Mixing is what makes {@code ws/src/../secrets} pass a literal
 * (lexical) check yet resolve outside the workspace (real).</p>
 * <ul>
 *   <li>{@link #lexical(String)}: pure string, <b>no filesystem access</b>, so a directory that
 *       does not exist yet is still comparable — the only form usable at <b>config time</b>. Uses
 *       {@link Path#normalize()} (OS separator rules, redundant separators, trailing slash) instead
 *       of hand-parsing; {@code .}/{@code ..} segments, UNC and extended-length prefixes are
 *       rejected fail-closed rather than resolved.</li>
 *   <li>{@link #real(String)}: {@link Path#toRealPath()} — OS canonicalise, resolving symlinks /
 *       junctions and 8.3 short names. Requires the target to <b>exist</b>; returns {@code null}
 *       when it does not, so a stale authorization root is skipped (the caller counts/logs it)
 *       rather than silently allowed. Execution-time only.</li>
 * </ul>
 */
public final class PathKey {

    private PathKey() {}

    /** LEXICAL normalisation (config-time): dotted separators to {@code /}, no trailing slash,
     *  lowercase; {@code null} when the value is null, dot-segmented, UNC/extended or invalid. */
    public static String lexical(String raw) {
        if (raw == null) {
            return null;
        }
        if (hasDotSegments(raw) || isUncOrExtended(raw)) {
            return null;
        }
        try {
            String normalized = Path.of(raw).normalize().toString().replace('\\', '/');
            int end = normalized.length();
            while (end > 1 && normalized.charAt(end - 1) == '/') {
                end--;
            }
            return normalized.substring(0, end).toLowerCase(java.util.Locale.ROOT);
        } catch (InvalidPathException invalid) {
            return null;
        }
    }

    /** LEXICAL normalisation for a glob PATTERN: {@code Path.of} rejects {@code *} on Windows, so
     *  this collapses separators / trailing slash / case only; dot segments fail closed. */
    public static String lexicalPattern(String raw) {
        if (raw == null) {
            return null;
        }
        if (hasDotSegments(raw) || isUncOrExtended(raw)) {
            return null;
        }
        String normalized = raw.replace('\\', '/');
        int end = normalized.length();
        while (end > 1 && normalized.charAt(end - 1) == '/') {
            end--;
        }
        return normalized.substring(0, end).toLowerCase(java.util.Locale.ROOT);
    }

    /** REAL normalisation (execution-time): OS canonicalise; {@code null} when it does not exist. */
    public static String real(String raw) {
        if (raw == null) {
            return null;
        }
        try {
            return Path.of(raw).toRealPath().toString().replace('\\', '/')
                    .toLowerCase(java.util.Locale.ROOT);
        } catch (IOException | InvalidPathException notResolvable) {
            return null;
        }
    }

    public static boolean sameLexical(String a, String b) {
        String normalized = lexical(a);
        return normalized != null && normalized.equals(lexical(b));
    }

    public static boolean withinLexical(String candidate, String base) {
        String normalizedBase = lexical(base);
        String normalizedCandidate = lexical(candidate);
        if (normalizedBase == null || normalizedCandidate == null || normalizedBase.isEmpty()) {
            return false;
        }
        return normalizedCandidate.equals(normalizedBase)
                || normalizedCandidate.startsWith(normalizedBase + "/");
    }

    public static boolean sameReal(String a, String b) {
        String normalized = real(a);
        return normalized != null && normalized.equals(real(b));
    }

    /** Fail-closed: a value carrying a {@code .} or {@code ..} segment is not comparable. */
    public static boolean hasDotSegments(String raw) {
        if (raw == null) {
            return false;
        }
        for (String segment : raw.replace('\\', '/').split("/")) {
            if (".".equals(segment) || "..".equals(segment)) {
                return true;
            }
        }
        return false;
    }

    /** Fail-closed: UNC ({@code \\server\share}) or extended-length ({@code \\?\}, {@code \\.\}). */
    public static boolean isUncOrExtended(String raw) {
        return raw != null && raw.replace('/', '\\').startsWith("\\\\");
    }

    /** Canonical physical identity for a path string (lexical; the intersection key). */
    public static String phys(String raw) {
        String normalized = lexical(raw);
        return normalized == null ? null : "phys:" + normalized;
    }
}
