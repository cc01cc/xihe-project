package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.AgentMemory;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * PLAN-0629 M1-6 (D29-26/27): the passive writer's decision matrix, pinned without Spring.
 *
 * <p>The durable half (a candidate really lands, promotion, the DB CHECK) is asserted against a real
 * PostgreSQL in {@link AgentMemoryServiceTest}; this class owns the part a database cannot show: what the
 * writer decides, what idempotency key it uses, that a judge failure never degrades into a summary write,
 * and that nothing it does can propagate an exception into the compaction path.</p>
 */
class AgentMemoryPassiveWriterTest {

    private static final UUID PRINCIPAL_ID = UUID.fromString("11111111-1111-4111-8111-111111111111");
    private static final UUID WORKSPACE_ID = UUID.fromString("22222222-2222-4222-8222-222222222222");
    private static final String SESSION_ID = "33333333-3333-4333-8333-333333333333";
    /** The durable audit actor is a USER id (fk_audit_logs_user), i.e. the session owner. */
    private static final String SESSION_OWNER_ID = "77777777-7777-4777-8777-777777777777";
    private static final long CURSOR = 42L;
    private static final String SUMMARY = "[Goal] ship M1-6\n[Constraints] candidate only";

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private SessionRepository sessions;
    private AgentPrincipalRepository principals;
    private AgentMemoryService memoryService;
    private PassiveMemoryJudge judge;
    private AgentMemoryPassiveWriter writer;

    private ch.qos.logback.classic.Logger writerLogger;
    private ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> logs;

    @BeforeEach
    void setUp() {
        sessions = mock(SessionRepository.class);
        principals = mock(AgentPrincipalRepository.class);
        memoryService = mock(AgentMemoryService.class);
        judge = mock(PassiveMemoryJudge.class);
        writer = new AgentMemoryPassiveWriter(sessions, principals, memoryService, judge);

        Session session = mock(Session.class);
        when(session.getAgentPrincipalId()).thenReturn(PRINCIPAL_ID.toString());
        when(session.getUserId()).thenReturn(SESSION_OWNER_ID);
        when(sessions.findById(UUID.fromString(SESSION_ID))).thenReturn(Optional.of(session));
        when(principals.findById(PRINCIPAL_ID)).thenReturn(Optional.of(principalWith(
                "{\"memory\":{\"enabled\":true,\"passive\":\"summary\",\"types\":[\"fact\"]}}")));
        when(memoryService.rememberPassive(any())).thenReturn(Optional.of(storedCandidate()));

        writerLogger = (ch.qos.logback.classic.Logger)
                org.slf4j.LoggerFactory.getLogger(AgentMemoryPassiveWriter.class);
        logs = new ch.qos.logback.core.read.ListAppender<>();
        logs.start();
        writerLogger.addAppender(logs);
    }

    @AfterEach
    void tearDown() {
        writerLogger.detachAppender(logs);
        logs.stop();
    }

    // ---------------------------------------------------------------------------------------
    // opt-in / fail-closed gates
    // ---------------------------------------------------------------------------------------

    @Test
    void passiveOffWritesNothingAtAll() {
        policy("{\"memory\":{\"enabled\":true,\"types\":[\"fact\"]}}");

        writer.onCompaction(end());

        verifyNoInteractions(memoryService);
        verifyNoInteractions(judge);
    }

    @Test
    void aDisabledMemoryPolicyWritesNothing() {
        policy("{\"memory\":{\"enabled\":false,\"passive\":\"summary\",\"types\":[\"fact\"]}}");

        writer.onCompaction(end());

        verify(memoryService, never()).rememberPassive(any());
        assertEquals(AgentMemoryPassiveWriter.REASON_MEMORY_DISABLED, lastReason());
    }

    @Test
    void aTypeListWithoutFactWritesNothing() {
        policy("{\"memory\":{\"enabled\":true,\"passive\":\"summary\",\"types\":[\"profile\"]}}");

        writer.onCompaction(end());

        verify(memoryService, never()).rememberPassive(any());
        assertEquals(AgentMemoryPassiveWriter.REASON_TYPE_NOT_ALLOWED, lastReason());
    }

    @Test
    void aSessionWithoutABoundSubjectIsASkipNotAFailure() {
        when(sessions.findById(UUID.fromString(SESSION_ID))).thenReturn(Optional.empty());

        writer.onCompaction(end());

        verifyNoInteractions(memoryService);
        assertEquals(AgentMemoryPassiveWriter.REASON_NO_PRINCIPAL, lastReason());
    }

    @Test
    void aSessionWithoutAnOwnerIsASkipNotAWrite() {
        Session ownerless = mock(Session.class);
        when(ownerless.getAgentPrincipalId()).thenReturn(PRINCIPAL_ID.toString());
        when(ownerless.getUserId()).thenReturn(null);
        when(sessions.findById(UUID.fromString(SESSION_ID))).thenReturn(Optional.of(ownerless));

        writer.onCompaction(end());

        verify(memoryService, never()).rememberPassive(any());
        assertEquals(AgentMemoryPassiveWriter.REASON_NO_SESSION_OWNER, lastReason(),
                "without a user there is no legal audit actor, so the write is skipped, not forged");
    }

    @Test
    void anEmptySummaryWritesNothing() {
        writer.onCompaction(new AgentMemoryPassiveWriter.CompactionEnd(SESSION_ID, WORKSPACE_ID.toString(),
                "auto", CURSOR, "   \n\t  "));

        verify(memoryService, never()).rememberPassive(any());
        assertEquals(AgentMemoryPassiveWriter.REASON_EMPTY_SUMMARY, lastReason());
    }

    // ---------------------------------------------------------------------------------------
    // summary mode: one candidate, with the natural key
    // ---------------------------------------------------------------------------------------

    @Test
    void summaryModeWritesOneCandidateThroughTheMemoryService() {
        writer.onCompaction(end());

        ArgumentCaptor<AgentMemoryService.PassiveWrite> write =
                ArgumentCaptor.forClass(AgentMemoryService.PassiveWrite.class);
        verify(memoryService).rememberPassive(write.capture());
        AgentMemoryService.PassiveWrite captured = write.getValue();
        assertEquals(PRINCIPAL_ID, captured.principalId());
        assertEquals(WORKSPACE_ID, captured.workspaceId());
        assertEquals(AgentMemory.ORIGIN_PASSIVE_SUMMARY, captured.origin());
        assertEquals("passive.summary:" + SESSION_ID + ":" + CURSOR, captured.sourceRef(),
                "the idempotency key is the natural key: mode + session + compaction cursor");
        assertEquals(SESSION_OWNER_ID, captured.actorId(),
                "the audit actor must be the session owner (a user id), never the subject");
        assertTrue(captured.content().contains("candidate only"));

        String line = onlyEventLine();
        assertTrue(line.contains("outcome=ok"), line);
        assertTrue(line.contains("event=agent_memory_passive_write"), line);
        assertFalse(line.contains("candidate only"),
                "the summary text is untrusted content and must not enter the log");
    }

    @Test
    void theSameSessionEndIsWrittenOnlyOnce() {
        when(memoryService.passiveAlreadyWritten(PRINCIPAL_ID, WORKSPACE_ID,
                "passive.summary:" + SESSION_ID + ":" + CURSOR)).thenReturn(true);

        writer.onCompaction(end());

        verify(memoryService, never()).rememberPassive(any());
        assertEquals(AgentMemoryPassiveWriter.REASON_ALREADY_WRITTEN, lastReason());
    }

    @Test
    void theStoredContentIsBoundedToTheDdlLimit() {
        writer.onCompaction(new AgentMemoryPassiveWriter.CompactionEnd(SESSION_ID, WORKSPACE_ID.toString(),
                "auto", CURSOR, "x".repeat(AgentMemory.MAX_CONTENT_LENGTH + 500)));

        ArgumentCaptor<AgentMemoryService.PassiveWrite> write =
                ArgumentCaptor.forClass(AgentMemoryService.PassiveWrite.class);
        verify(memoryService).rememberPassive(write.capture());
        assertEquals(AgentMemory.MAX_CONTENT_LENGTH, write.getValue().content().length(),
                "content must fit the D29-33 bound or the write would be rejected");
        assertTrue(write.getValue().content().endsWith(AgentMemoryPassiveWriter.TRUNCATION_MARKER.trim()),
                "a truncated candidate says so instead of silently dropping the tail");
    }

    @Test
    void anAlreadyActiveAssertionIsReportedAsSkipped() {
        when(memoryService.rememberPassive(any())).thenReturn(Optional.empty());

        writer.onCompaction(end());

        assertEquals(AgentMemoryPassiveWriter.REASON_ALREADY_ACTIVE, lastReason());
    }

    // ---------------------------------------------------------------------------------------
    // judge mode: fail-closed, never a silent downgrade to the summary
    // ---------------------------------------------------------------------------------------

    @Test
    void judgeModeWritesTheCandidateWhenTheJudgeApproves() {
        policy("{\"memory\":{\"enabled\":true,\"passive\":\"judge\",\"types\":[\"fact\"]}}");
        when(judge.judge(PRINCIPAL_ID, SESSION_ID, AgentMemoryPassiveWriter.passiveContent(SUMMARY)))
                .thenReturn(PassiveMemoryJudge.Verdict.answer(true, "stable fact", 12L, 3L));

        writer.onCompaction(end());

        ArgumentCaptor<AgentMemoryService.PassiveWrite> write =
                ArgumentCaptor.forClass(AgentMemoryService.PassiveWrite.class);
        verify(memoryService).rememberPassive(write.capture());
        assertEquals(AgentMemory.ORIGIN_PASSIVE_JUDGE, write.getValue().origin());
        assertEquals("passive.judge:" + SESSION_ID + ":" + CURSOR, write.getValue().sourceRef());
    }

    @Test
    void judgeModeSkipsWhenTheJudgeDeclines() {
        policy("{\"memory\":{\"enabled\":true,\"passive\":\"judge\",\"types\":[\"fact\"]}}");
        when(judge.judge(any(), anyString(), anyString()))
                .thenReturn(PassiveMemoryJudge.Verdict.answer(false, "small talk", null, null));

        writer.onCompaction(end());

        verify(memoryService, never()).rememberPassive(any());
        assertEquals(AgentMemoryPassiveWriter.REASON_JUDGE_DECLINED, lastReason());
    }

    @Test
    void judgeModeDoesNotDegradeToTheSummaryWhenTheJudgeIsUnavailable() {
        // D29-26: "no model ⇒ no write" — the rule summary must NOT be written instead, or a subject with
        // passive=judge would silently get the very writes the judge was supposed to veto.
        policy("{\"memory\":{\"enabled\":true,\"passive\":\"judge\",\"types\":[\"fact\"]}}");
        when(judge.judge(any(), anyString(), anyString()))
                .thenReturn(PassiveMemoryJudge.Verdict.unavailable("judge_unavailable"));

        writer.onCompaction(end());

        verify(memoryService, never()).rememberPassive(any());
        assertTrue(lastReason().startsWith(AgentMemoryPassiveWriter.REASON_JUDGE_UNAVAILABLE),
                "the skip reason carries the judge's own reason: " + lastReason());
    }

    @Test
    void summaryModeNeverCallsTheJudge() {
        writer.onCompaction(end());

        verifyNoInteractions(judge);
    }

    // ---------------------------------------------------------------------------------------
    // failure isolation
    // ---------------------------------------------------------------------------------------

    @Test
    void aFailingWriteNeverEscapesIntoTheCompactionPath() {
        when(memoryService.passiveAlreadyWritten(any(), any(), anyString()))
                .thenThrow(new IllegalStateException("database is on fire"));

        assertDoesNotThrow(() -> writer.onCompaction(end()),
                "a passive write is a side effect: it may never fail the compaction that triggered it");
        verify(memoryService, never()).rememberPassive(any());
        String line = onlyEventLine();
        assertTrue(line.contains("outcome=failed"), line);
        assertTrue(line.contains("reason=" + AgentMemoryPassiveWriter.REASON_UNEXPECTED), line);
        assertTrue(line.contains("error=IllegalStateException"), line);
    }

    @Test
    void anInvalidScopeIsASkipNotAFailure() {
        writer.onCompaction(new AgentMemoryPassiveWriter.CompactionEnd("not-a-uuid", "also-not-a-uuid",
                "auto", CURSOR, SUMMARY));

        verifyNoInteractions(memoryService);
        assertEquals(AgentMemoryPassiveWriter.REASON_INVALID_SCOPE, lastReason());
    }

    // ---------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------

    private AgentMemoryPassiveWriter.CompactionEnd end() {
        return new AgentMemoryPassiveWriter.CompactionEnd(SESSION_ID, WORKSPACE_ID.toString(), "auto",
                CURSOR, SUMMARY);
    }

    private void policy(String contextPolicy) {
        when(principals.findById(PRINCIPAL_ID)).thenReturn(Optional.of(principalWith(contextPolicy)));
    }

    private static AgentPrincipal principalWith(String contextPolicy) {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setId(PRINCIPAL_ID);
        principal.setContextPolicy(json(contextPolicy));
        return principal;
    }

    private static JsonNode json(String raw) {
        try {
            return MAPPER.readTree(raw);
        } catch (Exception invalid) {
            throw new IllegalStateException("fixture JSON is invalid: " + raw, invalid);
        }
    }

    private static AgentMemory storedCandidate() {
        AgentMemory memory = new AgentMemory();
        memory.setId(UUID.fromString("44444444-4444-4444-8444-444444444444"));
        memory.setStatus(AgentMemory.STATUS_CANDIDATE);
        memory.setOrigin(AgentMemory.ORIGIN_PASSIVE_SUMMARY);
        return memory;
    }

    private List<String> eventLines() {
        List<String> lines = new ArrayList<>();
        for (ch.qos.logback.classic.spi.ILoggingEvent event : logs.list) {
            if (event.getFormattedMessage().contains("event=" + AgentMemoryPassiveWriter.EVENT)) {
                lines.add(event.getFormattedMessage());
            }
        }
        return lines;
    }

    private String onlyEventLine() {
        List<String> lines = eventLines();
        assertEquals(1, lines.size(), "exactly one structured line per attempt: " + lines);
        return lines.getFirst();
    }

    /** The {@code reason=…} token of the last emitted event line. */
    private String lastReason() {
        List<String> lines = eventLines();
        assertFalse(lines.isEmpty(), "a skip must still be observable (rule 5)");
        String line = lines.getLast();
        int start = line.indexOf("reason=");
        assertTrue(start >= 0, "the line must carry a reason: " + line);
        int end = line.indexOf(' ', start);
        return end < 0 ? line.substring(start + "reason=".length())
                : line.substring(start + "reason=".length(), end);
    }
}
