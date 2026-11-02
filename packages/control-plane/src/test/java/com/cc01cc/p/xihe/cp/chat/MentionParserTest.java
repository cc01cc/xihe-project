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

    @Test
    void reservedDisplayNameCheck() {
        assertTrue(MentionParser.isReservedDisplayName("all"));
        assertTrue(MentionParser.isReservedDisplayName(" ALL "));
        assertFalse(MentionParser.isReservedDisplayName("Allison"));
        assertFalse(MentionParser.isReservedDisplayName(null));
    }
}
