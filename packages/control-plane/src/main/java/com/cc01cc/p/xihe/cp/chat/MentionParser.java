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
 *       "John Doe" both present resolves to "John Doe". <b>Historical-compatibility only</b>:
 *       决策 v23/v29 (2026-11-04) forbid spaces in every new name surface (username / agent
 *       subject name / displayName), so newly created participants cannot carry a spaced name;
 *       the greedy path is kept so mentions inside <em>pre-ruling</em> messages still resolve,
 *       and it stays fail-closed (a tie or a miss leaves the token literal);</li>
 *   <li>{@code @all} is a reserved token (case-insensitive); a participant may not carry the
 *       display name "all" (application-layer validation in SessionParticipantService);</li>
 *   <li><b>Ambiguity and misses fail closed</b>: a token matching zero or multiple enabled
 *       participants stays literal text and is reported in {@code unresolvedTokens} — the
 *       caller audits it, the parser never guesses;</li>
 *   <li><b>Markdown code is not speech</b> (task-21): an {@code @} inside a fenced code block or
 *       an inline code span is neither a mention nor an unresolved token. Agent replies paste
 *       code such as {@code @click="toTop"}; those tokens must not show up as "未识别" chips, and
 *       — because this same parse call is the wake-chain entry point — a pasted sample that
 *       happens to spell a real display name must not wake that participant. The known gaps are
 *       listed in {@code spec/session/chat-session.md}: 4-space indented code blocks, HTML
 *       {@code <code>/<pre>} and table-cell spans are not masked, and an unclosed fence runs to
 *       the end of the content (CommonMark's reading).</li>
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
        boolean[] code = codeMask(content);
        int index = 0;
        while (index < content.length()) {
            int at = content.indexOf('@', index);
            if (at < 0) {
                break;
            }
            if (code[at]) {
                // Markdown code is not speech: a pasted @click / @example is not a mention (task-21).
                index = at + 1;
                continue;
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

    // ── task-21: markdown code masking (an '@' in code is neither a mention nor a wake target) ──

    /**
     * Marks every character that belongs to markdown code. Two passes: fenced code blocks first
     * (they win over inline spans, as in CommonMark's block-level precedence), then backtick code
     * spans inside the remaining prose. Not covered — and not claimed: 4-space indented blocks,
     * HTML {@code <code>/<pre>}, table-cell spans.
     */
    private static boolean[] codeMask(String content) {
        boolean[] code = new boolean[content.length()];
        List<int[]> fences = fenceRegions(content);
        for (int[] region : fences) {
            for (int index = region[0]; index < region[1]; index++) {
                code[index] = true;
            }
        }
        int proseStart = 0;
        for (int[] region : fences) {
            maskInlineCodeSpans(content, proseStart, region[0], code);
            proseStart = region[1];
        }
        maskInlineCodeSpans(content, proseStart, content.length(), code);
        return code;
    }

    /** Half-open {@code [start, end)} ranges of fenced code blocks, fences included. */
    private static List<int[]> fenceRegions(String content) {
        List<int[]> regions = new ArrayList<>();
        int cursor = 0;
        while (cursor < content.length()) {
            int lineEnd = lineEndOf(content, cursor);
            int markerStart = skipIndent(content, cursor, lineEnd);
            int opening = markerStart < 0 || markerStart >= lineEnd
                    ? 0 : fenceOpeningLength(content, markerStart, lineEnd);
            if (opening == 0) {
                cursor = lineEnd >= content.length() ? content.length() : lineEnd + 1;
                continue;
            }
            char marker = content.charAt(markerStart);
            int closeEnd = -1;
            int probe = lineEnd + 1;
            while (probe < content.length()) {
                int probeEnd = lineEndOf(content, probe);
                if (isClosingFence(content, probe, probeEnd, marker, opening)) {
                    closeEnd = probeEnd;
                    break;
                }
                probe = probeEnd + 1;
            }
            int regionEnd = closeEnd < 0 ? content.length()
                    : Math.min(closeEnd + 1, content.length());
            regions.add(new int[]{cursor, regionEnd});
            cursor = regionEnd;
        }
        return regions;
    }

    /** The opening run length ({@code >= 3}) when this line opens a fence, else {@code 0}. */
    private static int fenceOpeningLength(String content, int from, int lineEnd) {
        char marker = content.charAt(from);
        if (marker != '`' && marker != '~') {
            return 0;
        }
        int run = runLength(content, from, lineEnd, marker);
        if (run < 3) {
            return 0;
        }
        if (marker == '`' && content.indexOf('`', from + run) >= 0
                && content.indexOf('`', from + run) < lineEnd) {
            // A backtick fence's info string may not contain backticks (CommonMark).
            return 0;
        }
        return run;
    }

    private static boolean isClosingFence(String content, int lineStart, int lineEnd,
                                          char marker, int opening) {
        int markerStart = skipIndent(content, lineStart, lineEnd);
        if (markerStart < 0 || runLength(content, markerStart, lineEnd, marker) < opening) {
            return false;
        }
        for (int index = markerStart; index < lineEnd; index++) {
            char c = content.charAt(index);
            if (c != marker && !Character.isWhitespace(c)) {
                return false;
            }
        }
        return true;
    }

    /** Masks backtick code spans inside {@code [from, to)}; an unmatched run stays literal text. */
    private static void maskInlineCodeSpans(String content, int from, int to, boolean[] code) {
        int index = from;
        while (index < to) {
            if (content.charAt(index) != '`') {
                index++;
                continue;
            }
            int opening = runLength(content, index, to, '`');
            int close = closingBacktickRun(content, index + opening, to, opening);
            if (close < 0) {
                index += opening;
                continue;
            }
            int end = Math.min(close + opening, to);
            for (int marked = index; marked < end; marked++) {
                code[marked] = true;
            }
            index = end;
        }
    }

    /** Start of the next backtick run whose length is exactly {@code length}, or {@code -1}. */
    private static int closingBacktickRun(String content, int from, int to, int length) {
        int index = from;
        while (index < to) {
            if (content.charAt(index) != '`') {
                index++;
                continue;
            }
            int run = runLength(content, index, to, '`');
            if (run == length) {
                return index;
            }
            index += run;
        }
        return -1;
    }

    private static int lineEndOf(String content, int lineStart) {
        int newline = content.indexOf('\n', lineStart);
        return newline < 0 ? content.length() : newline;
    }

    /** First non-space index when the leading indent is at most three spaces, else {@code -1}. */
    private static int skipIndent(String content, int from, int to) {
        int index = from;
        while (index < to && content.charAt(index) == ' ') {
            index++;
        }
        return index - from <= 3 ? index : -1;
    }

    private static int runLength(String content, int from, int to, char marker) {
        int index = from;
        while (index < to && content.charAt(index) == marker) {
            index++;
        }
        return index - from;
    }
}
