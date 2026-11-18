package com.cc01cc.p.xihe.cp.chat;

import java.text.BreakIterator;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * D-1866 / task-24: <b>rule-based</b> session naming. Pure string processing — no model, no
 * provider client, no I/O, no clock.
 *
 * <p>Why no LLM: the title is derived from a message the user already sent. Piping that text to a
 * provider to summarise it would widen the privacy surface and add cost/latency to a purely
 * cosmetic field (D-1866 rationale ②). Every rule below is deterministic, so the same message
 * always yields the same title on every replica.
 *
 * <p>Two hard constraints live in {@link SessionTitleDeriver}, not here, because they are about
 * <i>when</i> to write: a title that is no longer a default value means the user renamed it
 * (never overwrite), and an empty derivation must keep the default (never persist a blank title).
 */
public final class SessionTitleRule {

    /** Visible budget in grapheme clusters; CJK and one emoji each count as one unit. */
    public static final int MAX_TITLE_UNITS = 24;

    /** Appended when the normalised text is longer than {@link #MAX_TITLE_UNITS}. */
    public static final String ELLIPSIS = "\u2026";

    /**
     * Titles that mean "no name chosen yet".
     *
     * <p><b>This list must contain every locale's {@code workspace.sessionDefaultTitle} from
     * {@code packages/ui/src/i18n/index.ts}</b> (plus {@code "Untitled"}, which is the CP's own
     * {@code SessionService.normalizeTitle} fallback). The UI sends that localised string as
     * {@code title} when it creates a Session, so the marker is <i>not</i> CP-defined and a new
     * locale silently disables auto-naming for that language if it is missing here.
     * {@code SessionTitleDefaultTitleConsistencyTest} reads the UI locale file and fails when a
     * value is absent — that test is this list's register, so edit the two together.
     */
    public static final List<String> DEFAULT_TITLES =
            List.of("Untitled", "Untitled session", "\u672a\u547d\u540d\u4f1a\u8bdd");

    /** The title is at most {@link #MAX_TITLE_UNITS} units, so only the head of the message matters. */
    private static final int SCAN_LIMIT_CODE_POINTS = 512;

    /** Punctuation that carries no title meaning once the markdown structure is gone. */
    private static final String NOISE = "#*`_~>-+:=|.()[]{}\\/!&;,@^$%";

    private static final Pattern ESCAPED_MARKER =
            Pattern.compile("\\\\([\\\\`*_{}\\[\\]()#+\\-.!>~|])");
    private static final Pattern FENCE_LINE = Pattern.compile("^\\s*(?:```|~~~).*$", Pattern.MULTILINE);
    private static final Pattern IMAGE = Pattern.compile("!\\[([^\\]\\n]*)]\\([^)\\n]*\\)");
    private static final Pattern LINK = Pattern.compile("\\[([^\\]\\n]*)]\\([^)\\n]*\\)");
    private static final Pattern REFERENCE_LINK = Pattern.compile("\\[([^\\]\\n]*)]\\[[^\\]\\n]*]");
    private static final Pattern AUTOLINK = Pattern.compile("<((?:https?|ftp|mailto):[^>\\s]*)>");
    private static final Pattern HTML_TAG = Pattern.compile("</?[A-Za-z][A-Za-z0-9-]*(?:\\s[^>\\n]*)?/?>");
    private static final Pattern RULE_LINE = Pattern.compile("^\\s*(?:[-*_]\\s*){3,}$");
    private static final Pattern SETEXT_LINE = Pattern.compile("^\\s*=+\\s*$");
    private static final Pattern TABLE_SEPARATOR = Pattern.compile("^\\s*\\|?[\\s:|-]+\\|?\\s*$");
    private static final Pattern LINE_PREFIX = Pattern.compile(
            "^(?:\\s*(?:#{1,6}\\s*|>\\s?|[-*+]\\s+|\\d{1,9}[.)]\\s+|\\[[ xX]]\\s+))+");
    private static final Pattern CLOSING_HASHES = Pattern.compile("\\s+#+\\s*$");
    private static final Pattern EMPHASIS = Pattern.compile("\\*\\*|__|~~|`|\\*");
    private static final Pattern UNDERSCORE_EMPHASIS =
            Pattern.compile("(?<![\\p{L}\\p{N}])_+|_+(?![\\p{L}\\p{N}])");
    private static final Pattern WHITESPACE = Pattern.compile("\\s+");
    private static final Pattern PIPES = Pattern.compile("\\|");

    private SessionTitleRule() {
    }

    /**
     * Derives a title from the first user message.
     *
     * @return the title, or the empty string when the message carries no usable text (blank, or
     *     nothing but markdown markers) — the caller must then leave the default title alone.
     */
    public static String derive(String rawContent) {
        if (rawContent == null || rawContent.isBlank()) {
            return "";
        }
        String text = head(rawContent);
        text = text.replace("\r\n", "\n").replace('\r', '\n').replace('\t', ' ');
        text = stripControlCharacters(text);
        text = ESCAPED_MARKER.matcher(text).replaceAll("$1");
        text = FENCE_LINE.matcher(text).replaceAll("");
        text = IMAGE.matcher(text).replaceAll("$1");
        text = LINK.matcher(text).replaceAll("$1");
        text = REFERENCE_LINK.matcher(text).replaceAll("$1");
        text = AUTOLINK.matcher(text).replaceAll("$1");
        text = HTML_TAG.matcher(text).replaceAll("");
        text = stripLineStructure(text);
        text = EMPHASIS.matcher(text).replaceAll("");
        text = UNDERSCORE_EMPHASIS.matcher(text).replaceAll("");
        text = PIPES.matcher(text).replaceAll(" ");
        text = WHITESPACE.matcher(text).replaceAll(" ").strip();
        text = stripEdgeNoise(text);
        if (!hasVisibleContent(text)) {
            return "";
        }
        return truncate(text);
    }

    /** True when {@code title} still means "no name chosen yet" (blank, or a known default). */
    public static boolean isDefaultTitle(String title) {
        if (title == null || title.isBlank()) {
            return true;
        }
        return DEFAULT_TITLES.contains(title.strip());
    }

    private static String head(String content) {
        if (content.codePointCount(0, content.length()) <= SCAN_LIMIT_CODE_POINTS) {
            return content;
        }
        return content.substring(0, content.offsetByCodePoints(0, SCAN_LIMIT_CODE_POINTS));
    }

    private static String stripControlCharacters(String text) {
        StringBuilder builder = new StringBuilder(text.length());
        text.codePoints().forEach(codePoint -> {
            if (codePoint == '\n' || !Character.isISOControl(codePoint)) {
                builder.appendCodePoint(codePoint);
            }
        });
        return builder.toString();
    }

    /** Drops block markers per line: headings, quotes, list/task items, rules, table separators. */
    private static String stripLineStructure(String text) {
        StringBuilder builder = new StringBuilder(text.length());
        for (String line : text.split("\n", -1)) {
            if (RULE_LINE.matcher(line).matches()
                    || SETEXT_LINE.matcher(line).matches()
                    || TABLE_SEPARATOR.matcher(line).matches()) {
                builder.append('\n');
                continue;
            }
            String stripped = CLOSING_HASHES.matcher(LINE_PREFIX.matcher(line).replaceAll("")).replaceAll("");
            builder.append(stripped).append('\n');
        }
        return builder.toString();
    }

    private static boolean hasVisibleContent(String text) {
        return text.codePoints().anyMatch(codePoint ->
                !Character.isWhitespace(codePoint) && NOISE.indexOf(codePoint) < 0);
    }

    private static String stripEdgeNoise(String text) {
        int start = 0;
        int end = text.length();
        while (start < end && isNoise(text.charAt(start))) {
            start++;
        }
        while (end > start && isNoise(text.charAt(end - 1))) {
            end--;
        }
        return text.substring(start, end).strip();
    }

    private static boolean isNoise(int codePoint) {
        return Character.isWhitespace(codePoint) || NOISE.indexOf(codePoint) >= 0;
    }

    /**
     * Cuts at a {@link BreakIterator} grapheme boundary, so a surrogate pair, an emoji ZWJ
     * sequence or a flag is never split in half (acceptance ④).
     */
    private static String truncate(String text) {
        BreakIterator boundaries = BreakIterator.getCharacterInstance(Locale.ROOT);
        boundaries.setText(text);
        int units = 0;
        int next = boundaries.next();
        while (next != BreakIterator.DONE) {
            units++;
            if (units == MAX_TITLE_UNITS) {
                if (next >= text.length()) {
                    return text;
                }
                return stripDanglingJoiners(text.substring(0, next)) + ELLIPSIS;
            }
            next = boundaries.next();
        }
        return text;
    }

    /** A trailing joiner/variation selector would render as a broken emoji, so drop it. */
    private static String stripDanglingJoiners(String text) {
        int end = text.length();
        while (end > 0) {
            int codePoint = text.codePointBefore(end);
            if (codePoint == 0x200D || codePoint == 0xFE0F || codePoint == 0xFE0E) {
                end -= Character.charCount(codePoint);
            } else {
                break;
            }
        }
        return text.substring(0, end);
    }
}
