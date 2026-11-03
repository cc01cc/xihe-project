package com.cc01cc.p.xihe.cp.chat;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * PLAN-0624 M4 (D24-12/13): resolves the mention tokens a user's message carries into the
 * session's participant roster.
 *
 * <p>The wire format is fixed by the 0623 UI (the parser's established consumer):
 * {@code @displayName } — a bare display name with a trailing space, inserted by
 * {@code InputArea.insertMention} ({@code packages/ui/.../InputArea.vue}). Parsing rules:</p>
 *
 * <ul>
 *   <li><b>Resolve once, at submission</b>, against the current roster — a later rename can
 *       never re-interpret history;</li>
 *   <li><b>Greedy longest match</b>: names may contain spaces, so the longest roster name that
 *       prefixes the token (followed by whitespace or end of text) wins — "John" vs
 *       "John Doe" both present resolves to "John Doe";</li>
 *   <li>{@code @all} is a reserved token (case-insensitive); a participant may not carry the
 *       display name "all" (application-layer validation in SessionParticipantService);</li>
 *   <li><b>Ambiguity and misses fail closed</b>: a token matching zero or multiple enabled
 *       participants stays literal text and is reported in {@code unresolvedTokens} — the
 *       caller audits it, the parser never guesses.</li>
 * </ul>
 */
public final class MentionParser {

    /** One enabled-or-not roster row, already displayName-resolved (AGENT=principal name, HUMAN=user name). */
    public record RosterEntry(UUID participantId, String principalKind, String displayName,
                              String role, String respondPolicy, Instant disabledAt) {

        public boolean enabled() {
            return disabledAt == null;
        }
    }

    /** A resolved single mention. */
    public record Mention(UUID participantId, String displayName) {}

    /** The parse outcome: @all flag, resolved mentions, tokens that stayed literal. */
    public record ParseResult(boolean all, List<Mention> mentions, List<String> unresolvedTokens) {

        public static ParseResult empty() {
            return new ParseResult(false, List.of(), List.of());
        }
    }

    private MentionParser() {}

    public static boolean isReservedDisplayName(String displayName) {
        return displayName != null && "all".equalsIgnoreCase(displayName.trim());
    }

    /**
     * Scans {@code content} for {@code @} tokens and resolves them against the roster.
     * Disabled participants are invisible (D23-26: a disabled member cannot be woken).
     */
    public static ParseResult parse(String content, List<RosterEntry> roster) {
        if (content == null || content.isBlank() || roster == null || roster.isEmpty()) {
            return ParseResult.empty();
        }
        List<Mention> mentions = new ArrayList<>();
        List<String> unresolved = new ArrayList<>();
        boolean all = false;
        int index = 0;
        while (index < content.length()) {
            int at = content.indexOf('@', index);
            if (at < 0) {
                break;
            }
            int tokenStart = at + 1;
            if (tokenStart < content.length() && !isTokenBoundary(content.charAt(tokenStart - 2 < 0
                    ? 0 : tokenStart - 1)) && at > 0 && !isTokenBoundary(content.charAt(at - 1))) {
                // '@' glued to the previous word (e.g. an email address) is not a mention.
                index = tokenStart;
                continue;
            }
            if (content.regionMatches(true, tokenStart, "all", 0, 3)
                    && boundaryAt(content, tokenStart + 3)) {
                all = true;
                index = tokenStart + 3;
                continue;
            }
            RosterEntry match = longestMatch(content, tokenStart, roster);
            if (match == null) {
                int end = tokenEnd(content, tokenStart);
                unresolved.add(content.substring(at, end));
                index = end;
            } else {
                mentions.add(new Mention(match.participantId(), match.displayName()));
                index = tokenStart + match.displayName().length();
            }
        }
        return new ParseResult(all, List.copyOf(mentions), List.copyOf(unresolved));
    }

    /**
     * PLAN-0648 D1 (interim ruling, 2026-11-04): an explicit {@code @} of a non-PRIMARY participant
     * outranks the PRIMARY participant's default respond policy — "pointing at someone" is a
     * stronger signal than "the bound agent answers by default", otherwise {@code @} would not mean
     * anything. Two deliberate non-suppressing cases:
     *
     * <ul>
     *   <li>{@code @all} always includes the PRIMARY, so it never suppresses;</li>
     *   <li>a message whose only {@code @} tokens are unresolved (a typo) keeps the default policy —
     *       a misspelt name must not leave the message unanswered.</li>
     * </ul>
     *
     * <p>An explicit {@code asParticipantId} (the owner speaking as a member) is already a targeted
     * answer and is never suppressed by mentions.</p>
     *
     * @param parsed                the parse of the submitted content against the current roster
     * @param primaryParticipantId  the PRIMARY participant row, or {@code null} when the Session has none
     * @param explicitAs            whether the submission carries an explicit {@code asParticipantId}
     */
    public static boolean suppressesPrimary(ParseResult parsed, UUID primaryParticipantId,
                                            boolean explicitAs) {
        if (parsed == null || primaryParticipantId == null || explicitAs) {
            return false;
        }
        if (parsed.all() || parsed.mentions().isEmpty()) {
            return false;
        }
        return parsed.mentions().stream()
                .noneMatch(mention -> primaryParticipantId.equals(mention.participantId()));
    }

    /**
     * Longest enabled-roster display name that prefixes the text at {@code from} with a
     * boundary after it. Ties are ambiguity: two enabled participants sharing the longest
     * matching name fail closed (returns {@code null}).
     */
    private static RosterEntry longestMatch(String content, int from, List<RosterEntry> roster) {
        int bestLength = 0;
        int matchesAtBest = 0;
        RosterEntry best = null;
        for (RosterEntry entry : roster) {
            String name = entry.displayName();
            if (!entry.enabled() || name == null || name.isEmpty()) {
                continue;
            }
            if (!content.startsWith(name, from) || !boundaryAt(content, from + name.length())) {
                continue;
            }
            if (name.length() > bestLength) {
                bestLength = name.length();
                matchesAtBest = 1;
                best = entry;
            } else if (name.length() == bestLength) {
                matchesAtBest++;
            }
        }
        return matchesAtBest == 1 ? best : null;
    }

    private static boolean boundaryAt(String content, int index) {
        return index >= content.length() || isTokenBoundary(content.charAt(index));
    }

    private static boolean isTokenBoundary(char c) {
        return Character.isWhitespace(c) || c == '\n' || c == '\r' || c == '\t';
    }

    private static int tokenEnd(String content, int from) {
        int end = from;
        while (end < content.length() && !isTokenBoundary(content.charAt(end))) {
            end++;
        }
        return end;
    }
}
