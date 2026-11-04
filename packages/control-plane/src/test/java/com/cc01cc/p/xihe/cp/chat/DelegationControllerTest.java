package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.service.SessionService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0655: the human delegation route's gate shape — 400 preconditions, 403 capability refusal,
 * 202 approval hand-off with the frozen body keys, 201 with the approved response body.
 */
class DelegationControllerTest {

    private static final String SESSION_ID = UUID.randomUUID().toString();
    private static final String PARENT_RUN_ID = UUID.randomUUID().toString();
    private static final String PRINCIPAL_ID = UUID.randomUUID().toString();
    private static final String USER_ID = UUID.randomUUID().toString();
    private static final String WORKSPACE_ID = UUID.randomUUID().toString();

    private SessionService sessions;
    private DelegationBudgetService budget;
    private ChatSubmissionService submissions;
    private AgentSpawnAuthorizationService authorization;
    private ChatRunRepository runs;
    private ApplicationEventPublisher events;
    private DelegationController controller;

    @BeforeEach
    void setUp() {
        sessions = mock(SessionService.class);
        budget = mock(DelegationBudgetService.class);
        submissions = mock(ChatSubmissionService.class);
        authorization = mock(AgentSpawnAuthorizationService.class);
        runs = mock(ChatRunRepository.class);
        events = mock(ApplicationEventPublisher.class);
        controller = new DelegationController(sessions, budget, submissions, authorization, runs, events);

        TenantContext.setUserId(USER_ID);
        TenantContext.setWorkspaceId(WORKSPACE_ID);

        Session session = new Session(WORKSPACE_ID, USER_ID, "parent");
        session.setId(UUID.fromString(SESSION_ID));
        when(sessions.requireCurrent(anyString(), anyString(), anyString())).thenReturn(session);
        ChatRun parentRun = mock(ChatRun.class);
        when(parentRun.getId()).thenReturn(UUID.fromString(PARENT_RUN_ID));
        when(runs.findFirstBySessionIdOrderByCreatedAtDescIdDesc(SESSION_ID))
                .thenReturn(Optional.of(parentRun));
        when(submissions.delegationAuthorizationBody(anyString())).thenReturn("{canonical}");
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    private static Map<String, Object> body(String principalId, String task) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("agentPrincipalId", principalId);
        body.put("task", task);
        return body;
    }

    private static DelegationBudgetService.DelegationUsage usage(String rootId, int depth) {
        return new DelegationBudgetService.DelegationUsage(rootId, 1, 8, depth, 3,
                PRINCIPAL_ID, "Root Agent", "subject", false);
    }

    @Test
    void missingIdempotencyKeyIsRejectedBeforeAnyLookup() {
        ResponseEntity<?> response = controller.spawn(SESSION_ID, body(PRINCIPAL_ID, "do it"), "  ", null);

        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
        verify(sessions, never()).requireCurrent(anyString(), anyString(), anyString());
    }

    @Test
    void bodyShapeIsEnforced() {
        Map<String, Object> extra = body(PRINCIPAL_ID, "do it");
        extra.put("surprise", "x");

        ResponseEntity<?> response = controller.spawn(SESSION_ID, extra, "key-1", null);

        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
    }

    @Test
    void capabilityRefusalMapsToTheForbiddenProblem() {
        when(authorization.authorize(any(), any()))
                .thenThrow(new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                        "An explicit SPAWN_AGENT grant is required"));

        ResponseEntity<?> response = controller.spawn(SESSION_ID, body(PRINCIPAL_ID, "do it"), "key-1", null);

        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode());
        verify(submissions, never()).createDelegation(anyString(), anyString(), anyString(), anyString(), any());
        verify(events, never()).publishEvent(any());
    }

    @Test
    void askAnswerTravelsAs202WithTheFrozenBodyKeys() {
        when(authorization.authorize(any(), any()))
                .thenReturn(AgentSpawnAuthorizationService.GateResult.pending("appr-1",
                        java.time.Instant.now()));

        ResponseEntity<?> response = controller.spawn(SESSION_ID, body(PRINCIPAL_ID, "do it"), "key-1", null);

        assertEquals(HttpStatus.ACCEPTED, response.getStatusCode());
        @SuppressWarnings("unchecked")
        Map<String, Object> parsed = (Map<String, Object>) response.getBody();
        assertNotNull(parsed);
        assertEquals("appr-1", parsed.get("approvalRequestId"));
        assertEquals("/api/v1/approvals/appr-1", parsed.get("statusUrl"));
        assertEquals(AgentSpawnAuthorizationService.APPROVAL_GRANT_HEADER, parsed.get("retryHeader"));
        // No child is created before the grant: the pending answer is the whole response.
        verify(submissions, never()).createDelegation(anyString(), anyString(), anyString(), anyString(), any());
        verify(events, never()).publishEvent(any());
    }

    @Test
    void allowedAnswerCreatesDispatchesAndAnswers201WithTheBudget() {
        String childSessionId = UUID.randomUUID().toString();
        String childRunId = UUID.randomUUID().toString();
        when(authorization.authorize(any(), any()))
                .thenReturn(AgentSpawnAuthorizationService.GateResult.allowed(
                        new ChatSubmissionService.SpawnAuthorization("{canonical}", null, null)));
        when(submissions.createDelegation(eq(PARENT_RUN_ID), eq(PRINCIPAL_ID), eq("do it"),
                eq("key-1"), any()))
                .thenReturn(new ChatSubmissionService.SpawnResult(childSessionId, childRunId,
                        PRINCIPAL_ID, WORKSPACE_ID));
        when(budget.usageFor(any(Session.class))).thenReturn(usage(childSessionId, 2));

        ResponseEntity<?> response = controller.spawn(SESSION_ID, body(PRINCIPAL_ID, "do it"), "key-1", null);

        assertEquals(HttpStatus.CREATED, response.getStatusCode());
        assertEquals("/api/v1/sessions/" + childSessionId, response.getHeaders().getFirst("Location"));
        @SuppressWarnings("unchecked")
        Map<String, Object> parsed = (Map<String, Object>) response.getBody();
        assertNotNull(parsed);
        assertEquals(childSessionId, parsed.get("childSessionId"));
        assertEquals(childRunId, parsed.get("childRunId"));
        assertEquals(2, parsed.get("chainDepth"));
        assertNotNull(parsed.get("budget"));
        ArgumentCaptor<Object> published = ArgumentCaptor.forClass(Object.class);
        verify(events).publishEvent(published.capture());
        assertEquals(published.getValue().toString().contains(childRunId), true,
                "the dispatched event carries the child run");
    }

    @Test
    void sessionWithoutARunIsRejectedBeforeAnyGate() {
        when(runs.findFirstBySessionIdOrderByCreatedAtDescIdDesc(SESSION_ID)).thenReturn(Optional.empty());

        ResponseEntity<?> response = controller.spawn(SESSION_ID, body(PRINCIPAL_ID, "do it"), "key-1", null);

        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
        verify(authorization, never()).authorize(any(), any());
        assertNull(response.getHeaders().getLocation());
    }
}
