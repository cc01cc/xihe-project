package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.repository.RunTraceSourceRepository;
import com.cc01cc.p.xihe.cp.repository.RunTraceSourceRepository.RunMetadata;
import com.cc01cc.p.xihe.cp.repository.RunTraceSourceRepository.RunIdentity;
import com.cc01cc.p.xihe.cp.repository.RunTraceSourceRepository.SourceRecord;
import com.cc01cc.p.xihe.cp.service.SessionService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class RunTraceReadServiceTest {

    private final SessionService sessionService = mock(SessionService.class);
    private final RunTraceSourceRepository sourceRepository = mock(RunTraceSourceRepository.class);
    private final RunTraceReadService service = new RunTraceReadService(
            sessionService, sourceRepository);

    private final UUID runId = UUID.randomUUID();
    private final UUID sessionId = UUID.randomUUID();
    private final String userId = "user-1";
    private final String workspaceId = "workspace-1";
    private RunMetadata run;

    @BeforeEach
    void setUp() {
        run = metadata(userId, workspaceId, Instant.now().minusSeconds(60), null, null,
                "provider/unsafe value", "model:valid-1", null, null, null, null, null, null, null);
        when(sourceRepository.readRunMetadata(runId)).thenReturn(java.util.Optional.of(run));
        when(sourceRepository.readRunIdentity(runId)).thenReturn(java.util.Optional.of(
                new RunIdentity(runId, sessionId.toString(), userId, workspaceId)));
        when(sourceRepository.readContextEvents(any(), any(), any(), any(Integer.class))).thenReturn(List.of());
        when(sourceRepository.readProviderAttempts(any(), any(), any(), any(Integer.class))).thenReturn(List.of());
        when(sourceRepository.readMcpInvocations(any(), any(), any(), any(Integer.class))).thenReturn(List.of());
        when(sourceRepository.readRuntimeJobs(any(), any(), any(), any(Integer.class))).thenReturn(List.of());
        when(sourceRepository.hasUnlinkedRuntimeJobCandidate(
                any(UUID.class), any(Instant.class), any(Instant.class), any(Instant.class)))
                .thenReturn(false);
    }

    @Test
    void missingTenantContextFailsBeforeAnySourceRead() {
        CpApiException error = assertThrows(CpApiException.class,
                () -> service.getTrace(runId, null, workspaceId, null, null));

        assertEquals("AUTHORIZATION_REQUIRED", error.getCode());
        verifyNoInteractions(sessionService, sourceRepository);
    }

    @Test
    void foreignRunIsRejectedBeforeSessionOrTraceSourcesAreRead() {
        run = metadata("someone-else", workspaceId, run.createdAt(), null, null,
                run.provider(), run.model(), null, null, null, null, null, null, null);
        when(sourceRepository.readRunMetadata(runId)).thenReturn(java.util.Optional.of(run));
        when(sourceRepository.readRunIdentity(runId)).thenReturn(java.util.Optional.of(
                new RunIdentity(runId, sessionId.toString(), "someone-else", workspaceId)));

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.getTrace(runId, userId, workspaceId, null, null));

        assertEquals("FORBIDDEN", error.getCode());
        verify(sourceRepository).readRunIdentity(runId);
        verify(sourceRepository, never()).readRunMetadata(runId);
        verifyNoInteractions(sessionService);
    }

    @Test
    void invalidSessionIsRejectedBeforeRunMetadataAndTraceSourcesAreRead() {
        when(sessionService.requireCurrent(sessionId.toString(), userId, workspaceId))
                .thenThrow(new CpApiException(org.springframework.http.HttpStatus.NOT_FOUND,
                        "SESSION_NOT_FOUND", "Session not found"));

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.getTrace(runId, userId, workspaceId, null, null));

        assertEquals("SESSION_NOT_FOUND", error.getCode());
        verify(sourceRepository).readRunIdentity(runId);
        verify(sourceRepository, never()).readRunMetadata(runId);
        verify(sourceRepository, never()).readContextEvents(any(), any(), any(), any(Integer.class));
    }

    @Test
    void cursorPagesRemainStableAndDoNotRepeatAnEvent() {
        Instant firstAt = Instant.now().minusSeconds(20);
        Instant secondAt = firstAt.plusSeconds(1);
        SourceRecord first = contextRecord("10000000-0000-0000-0000-000000000001", firstAt);
        SourceRecord second = contextRecord("10000000-0000-0000-0000-000000000002", secondAt);
        when(sourceRepository.readContextEvents(any(), any(), any(), any(Integer.class)))
                .thenReturn(List.of(first, second));

        RunTraceReadService.TraceResponse pageOne = service.getTrace(
                runId, userId, workspaceId, null, "1");
        RunTraceReadService.TraceResponse pageTwo = service.getTrace(
                runId, userId, workspaceId, pageOne.nextCursor(), "1");

        assertEquals(1, pageOne.events().size());
        assertEquals("context_event:10000000-0000-0000-0000-000000000001",
                pageOne.events().getFirst().eventId());
        assertEquals(1, pageTwo.events().size());
        assertEquals("context_event:10000000-0000-0000-0000-000000000002",
                pageTwo.events().getFirst().eventId());
        assertNull(pageTwo.nextCursor());
        assertEquals("complete", pageOne.completeness());
        assertEquals(pageOne.asOf(), pageTwo.asOf());
    }

    @Test
    void unpairedCustomToolIsVisibleWithoutArgumentsOrResultsAndMarksTracePartial() {
        Instant occurredAt = Instant.now().minusSeconds(5);
        SourceRecord unpaired = new SourceRecord("context_event",
                "20000000-0000-0000-0000-000000000001", occurredAt,
                "agent.tool", "started", 987L, null, null, null, null, null, null,
                "tool-call-1", "ApprovalAgentTool", null, true, false);
        when(sourceRepository.readContextEvents(any(), any(), any(), any(Integer.class)))
                .thenReturn(List.of(unpaired));

        RunTraceReadService.TraceResponse response = service.getTrace(
                runId, userId, workspaceId, null, null);

        assertEquals("partial", response.completeness());
        RunTraceReadService.TraceEvent event = response.events().getFirst();
        assertEquals("agent.tool", event.kind());
        assertEquals("started", event.status());
        assertEquals("ApprovalAgentTool", event.toolName());
        assertNull(event.durationMs());
        assertTrue(event.references().containsKey("toolCallId"));
        assertEquals("context_event:20000000-0000-0000-0000-000000000001", event.eventId());
    }

    @Test
    void invalidCursorIsRejectedBeforeReadingRunOrSources() {
        CpApiException error = assertThrows(CpApiException.class,
                () -> service.getTrace(runId, userId, workspaceId, "not-a-cursor", null));

        assertEquals("TRACE_CURSOR_INVALID", error.getCode());
        verifyNoInteractions(sessionService, sourceRepository);
    }

    @Test
    void terminalRunUsesTerminalOutcomeAndSanitizesProviderIdentifiers() {
        run = metadata(userId, workspaceId, run.createdAt(), Instant.now().minusSeconds(1),
                "success", run.provider(), run.model(), null, null, null, null, null, null, null);
        when(sourceRepository.readRunMetadata(runId)).thenReturn(java.util.Optional.of(run));

        RunTraceReadService.TraceResponse response = service.getTrace(
                runId, userId, workspaceId, null, null);

        RunTraceReadService.TraceEvent event = response.events().getFirst();
        assertEquals("completed", event.status());
        assertNull(event.providerId());
        assertEquals("model:valid-1", event.modelId());
    }

    @Test
    void unlinkedSameSessionJobMakesRuntimeCoverageUnknownWithoutProjectingIt() {
        Instant runCreatedAt = run.createdAt();
        when(sourceRepository.hasUnlinkedRuntimeJobCandidate(
                eq(sessionId), eq(runCreatedAt), any(), any())).thenReturn(true);

        RunTraceReadService.TraceResponse response = service.getTrace(
                runId, userId, workspaceId, null, null);

        assertEquals("unknown", response.completeness());
        assertTrue(response.sources().stream().anyMatch(source ->
                "runtime_job".equals(source.source()) && "unknown".equals(source.status())));
        assertTrue(response.events().isEmpty());
        verify(sourceRepository).hasUnlinkedRuntimeJobCandidate(
                eq(sessionId), eq(runCreatedAt), any(), any());
    }

    @Test
    void provenanceIsAnAllowlistedProjectionWithIndependentCompleteness() {
        run = metadata(userId, workspaceId, run.createdAt(), null, null,
                "provider", "model", "11111111-1111-4111-8111-111111111111", 4L,
                "openai-chat-completions", "2", "workspace",
                "22222222-2222-4222-8222-222222222222", "3");
        when(sourceRepository.readRunMetadata(runId)).thenReturn(java.util.Optional.of(run));

        RunTraceReadService.TraceResponse response = service.getTrace(
                runId, userId, workspaceId, null, null);

        assertEquals("complete", response.provenance().status());
        assertEquals("openai-chat-completions", response.provenance().apiTypeId());
        assertEquals("workspace", response.provenance().contextTemplateLayer());
        assertEquals(3, response.provenance().contextTemplateVersion());

        run = metadata(userId, workspaceId, run.createdAt(), null, null,
                "provider", "model", "not-a-uuid", -1L,
                "unsafe api type/body", "0", "invalid-layer", "template body secret", "-1");
        when(sourceRepository.readRunMetadata(runId)).thenReturn(java.util.Optional.of(run));
        RunTraceReadService.TraceResponse partialResponse = service.getTrace(
                runId, userId, workspaceId, null, null);

        assertEquals("unknown", partialResponse.provenance().status());
        assertNull(partialResponse.provenance().providerConnectionId());
        assertNull(partialResponse.provenance().contextTemplateId());
        assertNull(partialResponse.provenance().apiTypeId());
    }

    @Test
    void inputAdmissionUsesItsOwnKindAndOnlyCarriesSourceReference() {
        Instant occurredAt = Instant.now().minusSeconds(3);
        SourceRecord admission = new SourceRecord("context_event",
                "30000000-0000-4000-8000-000000000001", occurredAt,
                "input.admitted", "admitted", null, null, null, null, null, null, null,
                null, null, null, true, true);
        when(sourceRepository.readContextEvents(any(), any(), any(), any(Integer.class)))
                .thenReturn(List.of(admission));

        RunTraceReadService.TraceResponse response = service.getTrace(
                runId, userId, workspaceId, null, null);

        RunTraceReadService.TraceEvent event = response.events().getFirst();
        assertEquals("input.admitted", event.kind());
        assertEquals("admitted", event.status());
        assertEquals("30000000-0000-4000-8000-000000000001",
                event.references().get("contextEventId"));
        assertEquals(1, event.references().size());
    }

    private static SourceRecord contextRecord(String id, Instant occurredAt) {
        return new SourceRecord("context_event", id, occurredAt,
                "context.source", "resolved", null, null, null, null, null, null, null,
                null, null, null, true, true);
    }

    private RunMetadata metadata(String ownerUser, String ownerWorkspace, Instant createdAt,
                                 Instant terminalAt, String terminalOutcome, String provider,
                                 String model, String providerConnectionId, Long connectionRevision,
                                 String apiTypeId, String apiTypeVersion, String templateLayer,
                                 String templateId, String templateVersion) {
        return new RunMetadata(runId, sessionId.toString(), ownerUser, ownerWorkspace,
                provider, model, "running", terminalAt, terminalOutcome, null, createdAt,
                providerConnectionId, connectionRevision, templateLayer, templateId,
                templateVersion, apiTypeId, apiTypeVersion);
    }
}
