package com.cc01cc.p.xihe.cp.chat;

import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0624 M4 (D24-12/13): the mention parser against the 0623 UI wire format
 * ({@code @displayName } — bare name + trailing space, produced by InputArea.insertMention).
 */
class MentionParserTest {

    private static final UUID ANN = UUID.randomUUID();
    private static final UUID JOHN = UUID.randomUUID();
    private static final UUID JOHN_DOE = UUID.randomUUID();
    private static final UUID BOT = UUID.randomUUID();
    private static final UUID DISABLED = UUID.randomUUID();

    private static MentionParser.RosterEntry entry(UUID id, String name, String respondPolicy) {
        return new MentionParser.RosterEntry(id, "AGENT", name, "MEMBER", respondPolicy, null);
    }

    private static final List<MentionParser.RosterEntry> ROSTER = List.of(
            entry(ANN, "Ann", "WHEN_MENTIONED"),
            entry(JOHN, "John", "ALWAYS"),
            entry(JOHN_DOE, "John Doe", "ALWAYS"),
            entry(BOT, "夜班助手", "MUTED"),
            new MentionParser.RosterEntry(DISABLED, "Ghost", "AGENT", "MEMBER",
                    "WHEN_MENTIONED", Instant.now()));

    @Test
    void longestMatchWinsWhenNamesShareAPrefix() {
        MentionParser.ParseResult result = MentionParser.parse("@John Doe 看看这个", ROSTER);
        assertEquals(1, result.mentions().size());
        assertEquals(JOHN_DOE, result.mentions().getFirst().participantId(),
                "the longer name consumes the token; John (prefix) must not win");
    }

    @Test
    void shortNameStillMatchesWhenItIsTheWholeToken() {
        MentionParser.ParseResult result = MentionParser.parse("@John 看看", ROSTER);
        assertEquals(1, result.mentions().size());
        assertEquals(JOHN, result.mentions().getFirst().participantId(),
                "@John with a boundary resolves to John even though John Doe exists");
    }

    @Test
    void allIsAReservedToken() {
        MentionParser.ParseResult result = MentionParser.parse("@ALL 大家看下", ROSTER);
        assertTrue(result.all(), "@all is case-insensitive");
        assertTrue(result.mentions().isEmpty());
        assertTrue(result.unresolvedTokens().isEmpty());
    }

    @Test
    void unicodeNamesResolve() {
        MentionParser.ParseResult result = MentionParser.parse("辛苦 @夜班助手 看下日志", ROSTER);
        assertEquals(1, result.mentions().size());
        assertEquals(BOT, result.mentions().getFirst().participantId());
    }

    @Test
    void disabledParticipantsAreInvisible() {
        MentionParser.ParseResult result = MentionParser.parse("@Ghost 在吗", ROSTER);
        assertTrue(result.mentions().isEmpty(), "a disabled member cannot be woken (D23-26)");
        assertEquals(1, result.unresolvedTokens().size());
    }

    @Test
    void missesStayLiteralAndAreReported() {
        MentionParser.ParseResult result = MentionParser.parse("@Nobody @Ann", ROSTER);
        assertEquals(1, result.mentions().size());
        assertEquals(ANN, result.mentions().getFirst().participantId());
        assertEquals(List.of("@Nobody"), result.unresolvedTokens(),
                "an unknown token is never guessed");
    }

    @Test
    void ambiguousNamesFailClosed() {
        UUID a = UUID.randomUUID();
        UUID b = UUID.randomUUID();
        List<MentionParser.RosterEntry> twins = List.of(
                entry(a, "Twin", "ALWAYS"), entry(b, "Twin", "ALWAYS"));
        MentionParser.ParseResult result = MentionParser.parse("@Twin hello", twins);
        assertTrue(result.mentions().isEmpty());
        assertEquals(List.of("@Twin"), result.unresolvedTokens(),
                "two enabled participants sharing a display name never resolve");
    }

    @Test
    void emailAtSignsAreNotMentions() {
        MentionParser.ParseResult result = MentionParser.parse("发到 ops@example.com 即可 @Ann", ROSTER);
        assertEquals(1, result.mentions().size());
        assertEquals(ANN, result.mentions().getFirst().participantId());
        assertTrue(result.unresolvedTokens().isEmpty());
    }

    @Test
    void nameGluedToFollowingWordWithoutBoundaryIsNotAMention() {
        MentionParser.ParseResult result = MentionParser.parse("@Annx 看看", ROSTER);
        assertTrue(result.mentions().isEmpty(), "no boundary after the name → literal text");
    }

    // ── task-21: an '@' inside markdown code is neither a mention nor an unresolved token ──

    @Test
    void atSignInsideAFencedCodeBlockIsNotAMention() {
        String content = "看这段模板：\n```vue\n<button @click=\"toTop\">top</button>\n```\n就这样。";
        MentionParser.ParseResult result = MentionParser.parse(content, ROSTER);
        assertTrue(result.mentions().isEmpty());
        assertEquals(List.of(), result.unresolvedTokens(),
                "a pasted @click is code, not an unresolved mention (task-4's red chip)");
    }

    @Test
    void atSignInsideAnInlineCodeSpanIsNotAMention() {
        MentionParser.ParseResult result = MentionParser.parse("把 `@Ann ` 换成真实名字", ROSTER);
        assertTrue(result.mentions().isEmpty());
        assertTrue(result.unresolvedTokens().isEmpty());
    }

    @Test
    void realMentionsOutsideCodeStillResolve() {
        MentionParser.ParseResult result = MentionParser.parse("@Ann 看下 `@John ` 这行", ROSTER);
        assertEquals(1, result.mentions().size());
        assertEquals(ANN, result.mentions().getFirst().participantId(),
                "masking is scoped to the code span; the prose mention before it still resolves");
    }

    @Test
    void fencedCodeBlockNamingARealMemberResolvesNobody() {
        MentionParser.ParseResult result = MentionParser.parse(
                "示例：\n```\n@Ann @John Doe\n```\n结束", ROSTER);
        assertTrue(result.mentions().isEmpty(),
                "a roster name inside a fence must not open a wake chain (same parse call is the entry point)");
        assertTrue(result.unresolvedTokens().isEmpty());
    }

    @Test
    void unclosedFenceRunsToTheEndOfTheContent() {
        MentionParser.ParseResult result = MentionParser.parse("示例：\n```\n@Nobody 还没闭合", ROSTER);
        assertTrue(result.mentions().isEmpty());
        assertTrue(result.unresolvedTokens().isEmpty(),
                "CommonMark reads an unclosed fence as code until EOF — stated in spec as a known limit");
    }

    @Test
    void tildeFenceClosesOnlyOnItsOwnMarker() {
        MentionParser.ParseResult result = MentionParser.parse(
                "~~~\n@Ann\n```\n@John\n~~~\n@Nobody 之后", ROSTER);
        assertTrue(result.mentions().isEmpty(),
                "a backtick line does not close a ~~~ fence");
        assertEquals(List.of("@Nobody"), result.unresolvedTokens(),
                "the prose token after the closing fence is still reported");
    }

    @Test
    void unmatchedBacktickIsLiteralText() {
        MentionParser.ParseResult result = MentionParser.parse("一个反引号 ` 后面 @Ann", ROSTER);
        assertEquals(1, result.mentions().size(),
                "an unmatched backtick run is literal text, not a code span");
    }

    @Test
    void reservedDisplayNameCheck() {
        assertTrue(MentionParser.isReservedDisplayName("all"));
        assertTrue(MentionParser.isReservedDisplayName(" ALL "));
        assertFalse(MentionParser.isReservedDisplayName("Allison"));
        assertFalse(MentionParser.isReservedDisplayName(null));
    }

    // ── PLAN-0648 D1: "an explicit @ of someone else outranks the PRIMARY's default answer" ──

    @Test
    void mentionOfAnotherParticipantSuppressesThePrimary() {
        MentionParser.ParseResult parsed = MentionParser.parse("@Ann 你来答这个", ROSTER);

        assertTrue(MentionParser.suppressesPrimary(parsed, JOHN, false));
    }

    @Test
    void mentionThatIncludesThePrimaryNeverSuppresses() {
        MentionParser.ParseResult parsed = MentionParser.parse("@Ann @John 一起看", ROSTER);

        assertFalse(MentionParser.suppressesPrimary(parsed, JOHN, false));
    }

    @Test
    void mentionAllNeverSuppresses() {
        MentionParser.ParseResult parsed = MentionParser.parse("@all 大家看一下", ROSTER);

        assertFalse(MentionParser.suppressesPrimary(parsed, JOHN, false));
    }

    @Test
    void unresolvedTypoNeverSuppresses() {
        // A misspelt name must not leave the message unanswered (interim ruling, D1).
        MentionParser.ParseResult parsed = MentionParser.parse("@An 你来", ROSTER);

        assertTrue(parsed.mentions().isEmpty());
        assertFalse(MentionParser.suppressesPrimary(parsed, JOHN, false));
    }

    @Test
    void explicitAsIsNeverSuppressedByMentions() {
        MentionParser.ParseResult parsed = MentionParser.parse("@Ann 你来答这个", ROSTER);

        assertFalse(MentionParser.suppressesPrimary(parsed, JOHN, true));
    }

    @Test
    void sessionWithoutPrimaryNeverSuppresses() {
        MentionParser.ParseResult parsed = MentionParser.parse("@Ann 你来答这个", ROSTER);

        assertFalse(MentionParser.suppressesPrimary(parsed, null, false));
    }

}
