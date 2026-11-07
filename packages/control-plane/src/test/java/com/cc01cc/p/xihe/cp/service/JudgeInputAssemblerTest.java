package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.data.domain.Pageable;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyIterable;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0690 T1.2b (CP-2) / spec §4: the judge input window, roster, duty line and prompt are
 * assembled from durable facts with fixed caps — not from a one-line "trigger=… round=…" string.
 */
class JudgeInputAssemblerTest {

    private static final UUID SESSION_ID = UUID.randomUUID();
    private static final UUID AGENT_PRINCIPAL_ID = UUID.randomUUID();
    private static final String ROUND = "wake:mention:root-1";

    private MessageRepository messages;
    private SessionParticipantRepository participants;
    private AgentPrincipalRepository principals;
    private JudgeInputAssembler assembler;
    private Session session;
    private SessionParticipant judgeParticipant;

    @BeforeEach
    void setUp() {
        messages = mock(MessageRepository.class);
        participants = mock(SessionParticipantRepository.class);
        principals = mock(AgentPrincipalRepository.class);
        assembler = new JudgeInputAssembler(messages, participants, principals);

        session = mock(Session.class);
        when(session.getId()).thenReturn(SESSION_ID);
        when(session.getTitle()).thenReturn("Secret title that must not reach the judge");

        judgeParticipant = participant("MEMBER", 10, "MENTION");
        when(participants.findBySessionIdOrderByOrderIndexAsc(SESSION_ID))
                .thenReturn(List.of(judgeParticipant));

        AgentPrincipal principal = mock(AgentPrincipal.class);
        when(principal.getId()).thenReturn(AGENT_PRINCIPAL_ID);
        when(principal.getName()).thenReturn("ann");
        when(principals.findAllById(anyIterable())).thenReturn(List.of(principal));

        when(messages.findLatestPage(eq(SESSION_ID.toString()), any(Pageable.class)))
                .thenReturn(List.of());
    }

    @Test
    void emptyHistoryUsesThePlaceholderSoInputWindowIsNotNull() {
        JudgeDecisionService.JudgeInput input = assemble();

        assertEquals(JudgeInputAssembler.EMPTY_WINDOW, input.inputWindow());
        assertTrue(input.prompt().contains(JudgeInputAssembler.EMPTY_WINDOW));
        assertTrue(input.dutyDescription().contains("respondPolicy=JUDGE"));
        assertTrue(input.prompt().contains("ann=MEMBER/MENTION"), input.prompt());
        assertFalse(input.prompt().contains("Secret title"), "session title must not enter the prompt");
        assertTrue(input.prompt().contains("{\"speak\": true|false"), "prompt asks for the §1 verdict");
        assertEquals(ROUND, input.wakeRoundId());
        assertEquals("mention", input.triggerSource());
        assertEquals("bailian", input.modelProvider());
        assertEquals("decision-model-preview", input.modelName());
    }

    @Test
    void windowIsOldestFirstAndSkipsBlankMessages() {
        List<Message> newestFirst = new ArrayList<>();
        newestFirst.add(message("third", AGENT_PRINCIPAL_ID));
        newestFirst.add(message("   ", AGENT_PRINCIPAL_ID));
        newestFirst.add(message("first", AGENT_PRINCIPAL_ID));
        when(messages.findLatestPage(eq(SESSION_ID.toString()), any(Pageable.class)))
                .thenReturn(newestFirst);

        assertEquals("ann: first\nann: third", assemble().inputWindow());
    }

    @Test
    void senderFallsBackToRoleWhenNoPrincipalNameExists() {
        when(messages.findLatestPage(eq(SESSION_ID.toString()), any(Pageable.class)))
                .thenReturn(List.of(message("hello", null)));

        assertEquals("user: hello", assemble().inputWindow());
    }

    @Test
    void messageIsRedactedAndCutTo500CodePoints() {
        String secret = "Bearer sk-live-abcdef123456 " + "x".repeat(600);
        when(messages.findLatestPage(eq(SESSION_ID.toString()), any(Pageable.class)))
                .thenReturn(List.of(message(secret, AGENT_PRINCIPAL_ID)));

        String window = assemble().inputWindow();

        assertFalse(window.contains("sk-live-abcdef123456"), "secrets must be redacted before the window");
        assertTrue(window.contains("***redacted***"), window);
        int bodyStart = window.indexOf("ann: ") + "ann: ".length();
        String body = window.substring(bodyStart);
        assertTrue(codePoints(body) <= JudgeInputAssembler.MESSAGE_MAX_CHARS,
                "per-message cut is " + JudgeInputAssembler.MESSAGE_MAX_CHARS + " code points, got "
                        + codePoints(body));
    }

    @Test
    void windowTotalIsCappedByDroppingTheOldestLines() {
        List<Message> newestFirst = new ArrayList<>();
        for (int i = 0; i < 12; i++) {
            newestFirst.add(message("m" + i + "-" + "y".repeat(495), AGENT_PRINCIPAL_ID));
        }
        when(messages.findLatestPage(eq(SESSION_ID.toString()), any(Pageable.class)))
                .thenReturn(newestFirst);

        String window = assemble().inputWindow();

        assertTrue(window.startsWith(JudgeInputAssembler.OLDER_OMITTED + "\n"), "oldest lines are dropped");
        assertTrue(codePoints(window) <= JudgeInputAssembler.WINDOW_MAX_CHARS,
                "window cap is " + JudgeInputAssembler.WINDOW_MAX_CHARS + " code points, got "
                        + codePoints(window));
        assertTrue(window.endsWith("m0-" + "y".repeat(495)), "newest message always survives");
    }

    @Test
    void rosterNamesAtMost20ParticipantsAndSaysHowManyMore() {
        List<SessionParticipant> roster = new ArrayList<>();
        for (int i = 0; i < 21; i++) {
            roster.add(participant("MEMBER", 10 + i, "ALWAYS"));
        }
        when(participants.findBySessionIdOrderByOrderIndexAsc(SESSION_ID)).thenReturn(roster);

        String prompt = assemble().prompt();

        assertTrue(prompt.contains("ann=MEMBER/ALWAYS"), prompt);
        assertTrue(prompt.contains("+1 more"), "over 20 participants collapse to +N more");
        assertEquals(20, countOccurrences(prompt, "ann=MEMBER/ALWAYS"), "roster stops at 20 entries");
    }

    @Test
    void dutyIsCutTo200CodePoints() {
        SessionParticipant longRole = participant("R".repeat(300), 10, "MENTION");
        when(participants.findBySessionIdOrderByOrderIndexAsc(SESSION_ID))
                .thenReturn(List.of(longRole));

        String duty = assemble(longRole).dutyDescription();

        assertTrue(codePoints(duty) <= JudgeInputAssembler.DUTY_MAX_CHARS,
                "duty cap is " + JudgeInputAssembler.DUTY_MAX_CHARS + " code points, got " + codePoints(duty));
        assertTrue(duty.startsWith("name=ann role=RR"), duty);
    }

    @Test
    void truncateNeverSplitsSurrogatePairs() {
        String emoji = "\uD83D\uDE00"; // U+1F600, two UTF-16 units
        String cut = JudgeInputAssembler.truncate(emoji.repeat(3), 2);

        assertEquals(2, codePoints(cut));
        assertEquals(emoji + emoji, cut);
    }

    private JudgeDecisionService.JudgeInput assemble() {
        return assemble(judgeParticipant);
    }

    private JudgeDecisionService.JudgeInput assemble(SessionParticipant participant) {
        return assembler.assemble(session, participant, "mention", ROUND, "bailian",
                "decision-model-preview");
    }

    private SessionParticipant participant(String role, int orderIndex, String wakePolicy) {
        return new SessionParticipant(SESSION_ID, SessionParticipant.KIND_AGENT, AGENT_PRINCIPAL_ID,
                role, orderIndex, wakePolicy, SessionParticipant.RESPOND_JUDGE);
    }

    private static Message message(String content, UUID participantId) {
        Message message = new Message(SESSION_ID.toString(), MessageRole.USER, content);
        message.setParticipantId(participantId);
        return message;
    }

    private static int codePoints(String text) {
        return text.codePointCount(0, text.length());
    }

    private static int countOccurrences(String text, String needle) {
        int count = 0;
        int from = 0;
        while ((from = text.indexOf(needle, from)) >= 0) {
            count++;
            from += needle.length();
        }
        return count;
    }
}
