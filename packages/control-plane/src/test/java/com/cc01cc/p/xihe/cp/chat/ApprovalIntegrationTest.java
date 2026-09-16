package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.policy.SessionPolicyState;
import com.cc01cc.p.xihe.cp.policy.PolicyEffect;
import com.cc01cc.p.xihe.cp.policy.PolicyRule;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.PolicyRuleRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.client.DefaultResponseErrorHandler;
import org.springframework.web.client.RestTemplate;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ApprovalIntegrationTest extends AbstractIntegrationTest {

    private static HttpServer agentServer;
    private static final AtomicReference<Integer> AGENT_DECISION_STATUS = new AtomicReference<>(200);
    private static final AtomicReference<String> AGENT_DECISION_AUTH = new AtomicReference<>("");
    private static final AtomicReference<String> AGENT_DECISION_BODY = new AtomicReference<>("");

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private ChatApprovalRepository approvalRepository;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    @Autowired
    private ApprovalService approvalService;

    @Autowired
    private AuditLogger auditLogger;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private SessionPolicyState sessionPolicyState;

    @Autowired
    private PolicyRuleRepository policyRuleRepository;

    @Autowired
    private com.cc01cc.p.xihe.cp.policy.PolicyRevision policyRevision;

    private String authToken;
    private String userId;
    private String workspaceId;
    private String sessionId;
    private String runId;
    private String requestId;

    @DynamicPropertySource
    static void configureAgent(DynamicPropertyRegistry registry) {
        try {
            agentServer = HttpServer.create(new InetSocketAddress(0), 0);
            agentServer.createContext("/internal/v1/agent/approval/respond", exchange -> {
                String auth = exchange.getRequestHeaders().getFirst("Authorization");
                AGENT_DECISION_AUTH.set(auth == null ? "" : auth);
                AGENT_DECISION_BODY.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
                byte[] body = "{\"status\":\"accepted\"}".getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", MediaType.APPLICATION_JSON_VALUE);
                exchange.sendResponseHeaders(AGENT_DECISION_STATUS.get(), body.length);
                try (OutputStream output = exchange.getResponseBody()) {
                    output.write(body);
                }
            });
            agentServer.createContext("/internal/v1/agent/health", exchange -> {
                byte[] body = "{\"status\":\"ok\",\"liveness\":\"up\",\"llmReady\":\"ready\",\"configRevision\":\"test-revision\"}"
                        .getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", MediaType.APPLICATION_JSON_VALUE);
                exchange.sendResponseHeaders(200, body.length);
                try (OutputStream output = exchange.getResponseBody()) {
                    output.write(body);
                }
            });
            agentServer.start();
        } catch (IOException e) {
            throw new ExceptionInInitializerError(e);
        }
        registry.add("cp.agent-base-url", () -> "http://localhost:" + agentServer.getAddress().getPort());
    }

    @AfterAll
    static void stopAgentServer() {
        if (agentServer != null) {
            agentServer.stop(0);
        }
    }

    @BeforeEach
    void setUp() {
        AGENT_DECISION_STATUS.set(200);
        AGENT_DECISION_BODY.set("");
        String email = "approval-int-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest register = new RegisterRequest(email, TestDataFactory.PASSWORD, "ApprovalIntTest");
        ResponseEntity<AuthResponse> regResponse = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", register, AuthResponse.class);
        authToken = regResponse.getBody().getAccessToken();

        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        Workspace ws = workspaceRepository.findActiveByMemberUserId(UUID.fromString(userId)).stream().findFirst().orElseThrow();
        workspaceId = ws.getId().toString();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));
        authToken = jwtTokenProvider.createAccessToken(userId, email, "USER", workspaceId);

        sessionId = UUID.randomUUID().toString();
        Session session = new Session(workspaceId, userId, "Approval Integration");
        session.setId(UUID.fromString(sessionId));
        sessionRepository.save(session);

        runId = UUID.randomUUID().toString();
        requestId = UUID.randomUUID().toString();
    }

    private ChatRun activeRun(String status) {
        ChatRun run = new ChatRun(runId, sessionId, userId, workspaceId,
                "idem-" + UUID.randomUUID(), "hash", "openai", "gpt-test", "workspace", status);
        return chatRunRepository.save(run);
    }

    private ChatApproval pendingApproval(String reqId, Instant expiresAt) {
        ChatApproval approval = new ChatApproval(reqId, runId, sessionId, userId, workspaceId,
                "request_approval", "delete file", "README.md", "pending", expiresAt, null, null);
        return approvalRepository.save(approval);
    }

    private ResponseEntity<Map> decide(String reqId, boolean approved) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return restTemplate.exchange(
                baseUrl + "/api/v1/chat/approvals/" + reqId + "/decision",
                HttpMethod.POST, new HttpEntity<>(Map.of("approved", approved), headers), Map.class);
    }

    private RestTemplate noErrorClient() {
        RestTemplate client = new RestTemplate();
        client.setErrorHandler(new DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(HttpStatusCode statusCode) {
                return false;
            }
        });
        return client;
    }

    @Test
    void recordPendingPersistsApprovalForActiveRun() {
        activeRun("running");

        approvalService.recordPending(Map.of(
                        "requestId", requestId,
                        "runId", runId,
                        "sessionId", sessionId,
                        "action", "delete file",
                        "details", "README.md",
                        "expiresAt", Instant.now().plusSeconds(300).toString()),
                sessionId, runId, userId, workspaceId);

        ChatApproval saved = approvalRepository.findById(UUID.fromString(requestId)).orElseThrow();
        assertEquals("pending", saved.getState());
        assertEquals(runId, saved.getRunId());
        assertEquals("delete file", saved.getAction());
        assertNotNull(saved.getExpiresAt());
    }

    @Test
    @SuppressWarnings("unchecked")
    void recordPendingSnapshotsPolicyAndReplayDoesNotReevaluateAfterModeChanges() throws Exception {
        activeRun("running");
        approvalService.recordPending(Map.of(
                        "requestId", requestId,
                        "runId", runId,
                        "sessionId", sessionId,
                        "tool", "write_file",
                        "action", "Execute write_file",
                        "details", "{\"tool\":\"write_file\",\"arguments\":{\"path\":\"secret.md\"}}",
                        "expiresAt", Instant.now().plusSeconds(300).toString()),
                sessionId, runId, userId, workspaceId);

        ChatApproval saved = approvalRepository.findById(UUID.fromString(requestId)).orElseThrow();
        assertNotNull(saved.getPolicySummary());
        Map<String, Object> stored = objectMapper.readValue(saved.getPolicySummary(), Map.class);
        assertEquals("ask", stored.get("effect"));
        assertEquals("builtin", stored.get("sourceLayer"));
        assertEquals("manual", stored.get("mode"));
        assertEquals("write", stored.get("actionClass"));
        assertEquals("structured", stored.get("shape"));
        assertTrue(stored.get("reason") instanceof String reason && !reason.isBlank());
        assertFalse(saved.getPolicySummary().contains("secret.md"));

        String auditKey = sessionId + ":write_file:policy_verdict";
        AuditLogger.AuditRecord creationAudit = auditLogger.getRecentRecords().get(auditKey);
        assertNotNull(creationAudit);

        sessionPolicyState.setMode(sessionId, "auto");
        sessionPolicyState.addRule(sessionId, PolicyRule.of("write", "*", PolicyEffect.ALLOW));
        Map<String, Object> replay = approvalService.replayPending(sessionId, userId, workspaceId).stream()
                .filter(item -> requestId.equals(String.valueOf(item.get("requestId"))))
                .findFirst().orElseThrow();
        Map<String, Object> replayPolicy = (Map<String, Object>) replay.get("policy");

        assertEquals(stored, replayPolicy);
        assertSame(creationAudit, auditLogger.getRecentRecords().get(auditKey));
    }

    @Test
    void replayReturnsOnlyLivePendingApprovalsForOwnedSession() {
        activeRun("running");
        pendingApproval(requestId, Instant.now().plusSeconds(300));
        String expiredId = UUID.randomUUID().toString();
        pendingApproval(expiredId, Instant.now().minusSeconds(1));
        String decidedId = UUID.randomUUID().toString();
        ChatApproval decided = new ChatApproval(
                decidedId, runId, sessionId, userId, workspaceId,
                "request_approval", "delete file", "README.md", "approved", Instant.now().plusSeconds(300), null, null);
        approvalRepository.save(decided);

        List<Map<String, Object>> replay = approvalService.replayPending(sessionId, userId, workspaceId);

        assertEquals(1, replay.size());
        assertEquals(requestId, replay.get(0).get("requestId").toString());
        assertEquals(Boolean.TRUE, replay.get(0).get("replayed"));
        assertFalse(replay.get(0).containsKey("policy"));
    }

    @Test
    void decideApprovesAndPersistsAfterAgentAccepts() {
        activeRun("running");
        pendingApproval(requestId, Instant.now().plusSeconds(300));

        ResponseEntity<Map> response = decide(requestId, true);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("accepted", response.getBody().get("status"));
        ChatApproval saved = approvalRepository.findById(UUID.fromString(requestId)).orElseThrow();
        assertEquals("approved", saved.getState());
        assertTrue(saved.getApproved());
        assertNotNull(saved.getDecidedAt());
        assertTrue(AGENT_DECISION_AUTH.get().startsWith("Bearer "));
    }

    @Test
    void decideIsIdempotentForSameDecision() {
        activeRun("running");
        pendingApproval(requestId, Instant.now().plusSeconds(300));
        decide(requestId, true);

        ResponseEntity<Map> second = decide(requestId, true);

        assertEquals(HttpStatus.OK, second.getStatusCode());
        assertEquals("accepted", second.getBody().get("status"));
        assertEquals("approved", approvalRepository.findById(UUID.fromString(requestId)).orElseThrow().getState());
    }

    @Test
    void decidePersistsModeAtGrantAndKeepsItAcrossLaterModeChanges() {
        activeRun("running");
        pendingApproval(requestId, Instant.now().plusSeconds(300));
        sessionPolicyState.setMode(sessionId, "manual");

        ResponseEntity<Map> first = decide(requestId, true);

        assertEquals(HttpStatus.OK, first.getStatusCode());
        assertEquals("manual", first.getBody().get("modeAtGrant"));
        assertEquals("manual", approvalRepository.findById(UUID.fromString(requestId)).orElseThrow()
                .getModeAtGrant());

        sessionPolicyState.setMode(sessionId, "auto");
        ResponseEntity<Map> repeated = decide(requestId, true);

        assertEquals(HttpStatus.OK, repeated.getStatusCode());
        assertEquals("manual", repeated.getBody().get("modeAtGrant"));
        assertEquals("manual", approvalRepository.findById(UUID.fromString(requestId)).orElseThrow()
                .getModeAtGrant());
    }

    @Test
    void decideConflictsOnDifferentDecision() {
        activeRun("running");
        pendingApproval(requestId, Instant.now().plusSeconds(300));
        decide(requestId, true);

        ResponseEntity<Map> conflict = decide(requestId, false);

        assertEquals(HttpStatus.CONFLICT, conflict.getStatusCode());
        assertEquals("APPROVAL_DECISION_CONFLICT", conflict.getBody().get("code"));
    }

    @Test
    void decideReturns410ForExpiredApproval() {
        activeRun("running");
        pendingApproval(requestId, Instant.now().minusSeconds(1));

        ResponseEntity<Map> response = noErrorClient().exchange(
                baseUrl + "/api/v1/chat/approvals/" + requestId + "/decision",
                HttpMethod.POST,
                authorizedBody(true),
                Map.class);

        assertEquals(HttpStatus.GONE, response.getStatusCode());
        assertEquals("APPROVAL_EXPIRED", response.getBody().get("code"));
        ChatApproval expired = approvalRepository.findById(UUID.fromString(requestId)).orElseThrow();
        assertEquals("expired", expired.getState());
        assertNotNull(expired.getDecidedAt());
    }

    @Test
    void decideReturns404ForUnknownApproval() {
        ResponseEntity<Map> response = noErrorClient().exchange(
                baseUrl + "/api/v1/chat/approvals/" + UUID.randomUUID() + "/decision",
                HttpMethod.POST,
                authorizedBody(true),
                Map.class);

        assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode());
        assertEquals("APPROVAL_NOT_FOUND", response.getBody().get("code"));
    }

    private HttpEntity<Map<String, Object>> authorizedBody(boolean approved) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return new HttpEntity<>(Map.of("approved", approved), headers);
    }

    @Test
    void decideEnforcesOwnerBinding() {
        activeRun("running");
        pendingApproval(requestId, Instant.now().plusSeconds(300));
        String otherEmail = "approval-other-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest register = new RegisterRequest(otherEmail, TestDataFactory.PASSWORD, "Other");
        ResponseEntity<AuthResponse> reg = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", register, AuthResponse.class);
        User otherUser = userRepository.findByEmail(otherEmail).orElseThrow();
        String otherTokenScoped = jwtTokenProvider.createAccessToken(
                otherUser.getId().toString(), otherEmail, "USER", workspaceId);

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(otherTokenScoped);
        headers.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/chat/approvals/" + requestId + "/decision",
                HttpMethod.POST, new HttpEntity<>(Map.of("approved", true), headers), Map.class);

        assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode());
        assertEquals("pending", approvalRepository.findById(UUID.fromString(requestId)).orElseThrow().getState());
    }

    @Test
    void decidePersistsDispatchUnknownWhenAgentFails() {
        activeRun("running");
        pendingApproval(requestId, Instant.now().plusSeconds(300));
        AGENT_DECISION_STATUS.set(500);

        ResponseEntity<Map> response = noErrorClient().exchange(
                baseUrl + "/api/v1/chat/approvals/" + requestId + "/decision",
                HttpMethod.POST, authorizedBody(true), Map.class);

        assertEquals(HttpStatus.BAD_GATEWAY, response.getStatusCode());
        ChatApproval unknown = approvalRepository.findById(UUID.fromString(requestId)).orElseThrow();
        assertEquals("dispatch_unknown", unknown.getState());
        assertNotNull(unknown.getDispatchErrorCode());
    }

    @Test
    void retryDoesNotRewriteModeAtGrantAfterDispatchUnknown() {
        activeRun("running");
        pendingApproval(requestId, Instant.now().plusSeconds(300));
        sessionPolicyState.setMode(sessionId, "manual");
        AGENT_DECISION_STATUS.set(500);

        ResponseEntity<Map> first = noErrorClient().exchange(
                baseUrl + "/api/v1/chat/approvals/" + requestId + "/decision",
                HttpMethod.POST, authorizedBody(true), Map.class);

        assertEquals(HttpStatus.BAD_GATEWAY, first.getStatusCode());
        assertEquals("manual", approvalRepository.findById(UUID.fromString(requestId)).orElseThrow()
                .getModeAtGrant());

        sessionPolicyState.setMode(sessionId, "auto");
        AGENT_DECISION_STATUS.set(200);
        ResponseEntity<Map> retry = decide(requestId, true);

        assertEquals(HttpStatus.OK, retry.getStatusCode());
        assertEquals("manual", retry.getBody().get("modeAtGrant"));
        assertEquals("manual", approvalRepository.findById(UUID.fromString(requestId)).orElseThrow()
                .getModeAtGrant());
    }

    @Test
    void consumeApprovedGrantIsBoundToInvocationAndOneShot() {
        activeRun("running");
        ChatApproval approval = new ChatApproval(
                requestId, runId, sessionId, userId, workspaceId,
                "write_file", "Execute write_file",
                "{\"tool\":\"write_file\",\"arguments\":{\"path\":\"a.txt\"}}",
                "approved", Instant.now().plusSeconds(300), null, "require_approval");
        approval.setApproved(true);
        // PLAN-0328 T1.7: the V20 columns decide whether the grant is still consumable.
        approval.setPolicyRevision(policyRevision.current());
        Workspace workspace = workspaceRepository.findById(UUID.fromString(workspaceId)).orElseThrow();
        approval.setSandboxGeneration(workspace.getGeneration() == null ? 0 : workspace.getGeneration());
        approval.setReuseScope("once");
        approvalRepository.save(approval);
        String body = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\","
                + "\"params\":{\"name\":\"write_file\",\"arguments\":{\"path\":\"a.txt\"}},\"id\":1}";

        assertTrue(approvalService.consumeApprovedGrant(
                requestId, userId, workspaceId, sessionId, "write_file", body));
        ChatApproval consumed = approvalRepository.findById(UUID.fromString(requestId)).orElseThrow();
        assertNotNull(consumed.getGrantConsumedAt());
        assertFalse(approvalService.consumeApprovedGrant(
                requestId, userId, workspaceId, sessionId, "write_file", body));
    }

    @Test
    void consumeRejectsLegacyRowWithoutV20GrantColumns() {
        activeRun("running");
        ChatApproval legacy = new ChatApproval(
                requestId, runId, sessionId, userId, workspaceId,
                "write_file", "Execute write_file",
                "{\"tool\":\"write_file\",\"arguments\":{\"path\":\"a.txt\"}}",
                "approved", Instant.now().plusSeconds(300), null, "require_approval");
        legacy.setApproved(true);
        approvalRepository.save(legacy);

        assertFalse(approvalService.consumeApprovedGrant(
                requestId, userId, workspaceId, sessionId, "write_file",
                "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\","
                        + "\"params\":{\"name\":\"write_file\",\"arguments\":{\"path\":\"a.txt\"}},\"id\":1}"));
        assertNull(approvalRepository.findById(UUID.fromString(requestId)).orElseThrow().getGrantConsumedAt());
    }

    @Test
    void decideReturns400ForMalformedRequestId() {
        ResponseEntity<Map> response = noErrorClient().exchange(
                baseUrl + "/api/v1/chat/approvals/not-a-uuid/decision",
                HttpMethod.POST, authorizedBody(true), Map.class);

        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
        assertEquals("INVALID_REQUEST", response.getBody().get("code"));
    }

    @Test
    void decideRetriesDispatchUnknownWhenAgentRecovers() {
        activeRun("running");
        ChatApproval approval = new ChatApproval(
                requestId, runId, sessionId, userId, workspaceId,
                "request_approval", "delete file", "README.md", "dispatch_unknown",
                Instant.now().plusSeconds(300), null, null);
        approval.setDispatchErrorCode("AGENT_APPROVAL_FAILED");
        approvalRepository.save(approval);

        ResponseEntity<Map> response = decide(requestId, true);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("accepted", response.getBody().get("status"));
        ChatApproval saved = approvalRepository.findById(UUID.fromString(requestId)).orElseThrow();
        assertEquals("approved", saved.getState());
        assertNull(saved.getDispatchErrorCode());
    }

    // ------------------------------------------------------------------
    // T1.7 retry window: a re-claim after dispatch_unknown must re-stamp the
    // decision-time revision/generation/scope, or consumeStillValid would
    // reject the freshly re-approved grant forever.
    // ------------------------------------------------------------------

    @Test
    void retryClaimRefreshesRevisionGenerationAndScopeButKeepsTheFirstMode() {
        activeRun("running");
        pendingApproval(requestId, Instant.now().plusSeconds(300));
        UUID id = UUID.fromString(requestId);
        Instant now = Instant.now();

        assertEquals(1, approvalRepository.markDispatching(id, true, "manual", "once", 11L, 1, now));
        assertEquals(1, approvalRepository.markDispatchUnknown(id, "AGENT_APPROVAL_FAILED", now));
        assertEquals(1, approvalRepository.markDispatching(id, true, "auto", "session", 22L, 2, now));

        ChatApproval claimed = approvalRepository.findById(id).orElseThrow();
        assertEquals("dispatching", claimed.getState());
        assertEquals(Long.valueOf(22L), claimed.getPolicyRevision(),
                "a retry must re-stamp the decision-time revision");
        assertEquals(Integer.valueOf(2), claimed.getSandboxGeneration(),
                "a retry must re-stamp the decision-time generation");
        assertEquals("session", claimed.getReuseScope(),
                "a retry must re-stamp the decision-time reuse scope");
        assertEquals("manual", claimed.getModeAtGrant(),
                "the first grant's mode must stay conservative across the retry");
    }

    @Test
    void retryAfterDispatchUnknownRefreshesTheGrantWindowAndStaysConsumable() {
        activeRun("running");
        String body = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\","
                + "\"params\":{\"name\":\"write_file\",\"arguments\":{\"path\":\"retry.txt\"}},\"id\":1}";
        ChatApproval pending = approvalService.recordGatePending(sessionId, runId, userId, workspaceId,
                "write_file", body, Instant.now().plusSeconds(300)).orElseThrow().row();

        // The first claim landed in dispatch_unknown stamped with the revision of that moment
        // and an unset generation. Any rule/face write between claim and retry moves the durable
        // revision, so the retry must re-stamp both instead of coalescing the stale values.
        sessionPolicyState.setMode(sessionId, "manual");
        long staleRevision = policyRevision.current() - 1;
        ChatApproval claimed = approvalRepository.findById(pending.getRequestId()).orElseThrow();
        claimed.setState("dispatch_unknown");
        claimed.setApproved(true);
        claimed.setDecisionKind("once");
        claimed.setModeAtGrant("manual");
        claimed.setReuseScope("saved");
        claimed.setPolicyRevision(staleRevision);
        claimed.setSandboxGeneration(null);
        approvalRepository.save(claimed);

        sessionPolicyState.setMode(sessionId, "auto");
        AGENT_DECISION_STATUS.set(200);
        ResponseEntity<Map> retry = decideWithoutErrorHandling(
                pending.getRequestId().toString(), Map.of("decision", "once"));

        assertEquals(HttpStatus.OK, retry.getStatusCode());
        ChatApproval approved = approvalRepository.findById(pending.getRequestId()).orElseThrow();
        assertEquals("approved", approved.getState());
        assertNotEquals(staleRevision, policyRevision.current());
        assertEquals(Long.valueOf(policyRevision.current()), approved.getPolicyRevision(),
                "the retry must re-stamp the decision-time revision, not keep the stale claim value");
        assertNotNull(approved.getSandboxGeneration(),
                "the retry must re-stamp the decision-time sandbox generation");
        assertEquals("once", approved.getReuseScope(),
                "the retry must re-stamp the decision-time reuse scope");
        assertEquals("manual", approved.getModeAtGrant(),
                "the retry must not rewrite the first grant's mode");
        assertTrue(approvalService.consumeApprovedGrant(pending.getRequestId().toString(), userId,
                        workspaceId, sessionId, "write_file", body),
                "the retried grant must stay consumable under the decision-time revision");
    }

    private ResponseEntity<Map> decideWithoutErrorHandling(String reqId, Map<String, Object> body) {
        return noErrorClient().exchange(
                baseUrl + "/api/v1/chat/approvals/" + reqId + "/decision",
                HttpMethod.POST, new HttpEntity<>(body, authorizedHeaders()), Map.class);
    }

    @Test
    void decideExpiresStaleDispatchUnknownApproval() {
        activeRun("running");
        ChatApproval approval = new ChatApproval(
                requestId, runId, sessionId, userId, workspaceId,
                "request_approval", "delete file", "README.md", "dispatch_unknown",
                Instant.now().minusSeconds(1), null, null);
        approvalRepository.save(approval);

        ResponseEntity<Map> response = noErrorClient().exchange(
                baseUrl + "/api/v1/chat/approvals/" + requestId + "/decision",
                HttpMethod.POST, authorizedBody(true), Map.class);

        assertEquals(HttpStatus.GONE, response.getStatusCode());
        assertEquals("expired", approvalRepository.findById(UUID.fromString(requestId)).orElseThrow().getState());
    }

    @Test
    void recordPendingRejectsDetailsBeyondAgentPreviewBound() {
        activeRun("running");
        Map<String, Object> payload = Map.of(
                "requestId", requestId,
                "runId", runId,
                "sessionId", sessionId,
                "action", "delete file",
                "details", "x".repeat(513),
                "expiresAt", Instant.now().plusSeconds(300).toString());

        CpApiException error = assertThrows(CpApiException.class,
                () -> approvalService.recordPending(payload, sessionId, runId, userId, workspaceId));

        assertEquals("AGENT_EVENT_INVALID", error.getCode());
        assertTrue(approvalRepository.findById(UUID.fromString(requestId)).isEmpty());
    }

    // ------------------------------------------------------------------
    // PLAN-0328 M1 batch 4b — decision tiers, feedback, propagation, pending indicator
    // ------------------------------------------------------------------

    private ChatApproval pendingToolApproval(String reqId, String tool, String run, String session,
                                             String user, String workspace, Instant expiresAt) {
        ChatApproval approval = new ChatApproval(reqId, run, session, user, workspace,
                tool, "Execute " + tool, "preview", "pending", expiresAt, null, "require_approval");
        return approvalRepository.save(approval);
    }

    private ResponseEntity<Map> decideWithBody(String reqId, Map<String, Object> body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return restTemplate.exchange(
                baseUrl + "/api/v1/chat/approvals/" + reqId + "/decision",
                HttpMethod.POST, new HttpEntity<>(body, headers), Map.class);
    }

    @Test
    void sessionTierRecordsAnExactInvocationFingerprintInsteadOfACoarseRule() {
        activeRun("running");
        String body = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\","
                + "\"params\":{\"name\":\"write_file\",\"arguments\":{\"path\":\"a.txt\"}},\"id\":1}";
        ChatApproval pending = approvalService.recordGatePending(sessionId, runId, userId, workspaceId,
                "write_file", body, Instant.now().plusSeconds(300)).orElseThrow().row();

        ResponseEntity<Map> response = decideWithBody(pending.getRequestId().toString(),
                Map.of("decision", "session"));

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("session", response.getBody().get("decision"));
        ChatApproval decided = approvalRepository.findById(pending.getRequestId()).orElseThrow();
        assertEquals("approved", decided.getState());
        // T1.7: the decision records the reuse scope, the durable revision and the sandbox generation.
        assertEquals("session", decided.getReuseScope());
        assertNotNull(decided.getPolicyRevision());
        assertNotNull(decided.getSandboxGeneration());
        assertNotNull(decided.getArgumentsHash());
        assertTrue(sessionPolicyState
                        .grantOf(sessionId, "write_file", decided.getArgumentsHash()).isPresent(),
                "session tier must record the exact-invocation fingerprint");
        assertTrue(sessionPolicyState.rulesOf(sessionId).isEmpty(),
                "session tier must not write a coarse L4 rule anymore");
        assertTrue(approvalService.tryReuseSessionGrant(sessionId, workspaceId, "write_file", body),
                "the recorded fingerprint must authorize the same invocation at the gate");
    }

    @Test
    void gatePendingLookupIsIdempotentForTheSameInvocation() {
        activeRun("running");
        String body = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\","
                + "\"params\":{\"name\":\"write_file\",\"arguments\":{\"path\":\"a.txt\"}},\"id\":1}";

        ChatApproval first = approvalService.recordGatePending(sessionId, runId, userId, workspaceId,
                "write_file", body, Instant.now().plusSeconds(300)).orElseThrow().row();
        ChatApproval second = approvalService.recordGatePending(sessionId, runId, userId, workspaceId,
                "write_file", body, Instant.now().plusSeconds(300)).orElseThrow().row();

        assertEquals(first.getRequestId(), second.getRequestId(),
                "the gate must reuse the live row instead of creating a duplicate");
        assertEquals(1, approvalRepository
                .findBySessionIdAndToolAndArgumentsHashAndStateInOrderByCreatedAtAsc(
                        sessionId, "write_file", first.getArgumentsHash(),
                        List.of("pending", "dispatching", "dispatch_unknown")).size());
        assertEquals("awaiting_approval",
                chatRunRepository.findById(UUID.fromString(runId)).orElseThrow().getStatus());
        assertFalse(approvalService.tryReuseSessionGrant(sessionId, workspaceId, "write_file", body),
                "a pending row without a session decision is not reusable");
    }

    @Test
    void savedTierWritesWorkspaceRuleAndApprovesRow() {
        activeRun("running");
        pendingToolApproval(requestId, "write_file", runId, sessionId, userId, workspaceId,
                Instant.now().plusSeconds(300));

        ResponseEntity<Map> response = decideWithBody(requestId, Map.of("decision", "saved"));

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("saved", response.getBody().get("decision"));
        ChatApproval decided = approvalRepository.findById(UUID.fromString(requestId)).orElseThrow();
        assertEquals("approved", decided.getState());
        // T1.7: persistent grants keep writing rules, but also record their reuse scope + revisions.
        assertEquals("saved", decided.getReuseScope());
        assertNotNull(decided.getPolicyRevision());
        assertNotNull(decided.getSandboxGeneration());
        assertTrue(policyRuleRepository
                        .findByLayerAndOwnerIdOrderByCreatedAtAscIdAsc("workspace", workspaceId).stream()
                        .anyMatch(rule -> "write".equals(rule.getActionClass()) && "allow".equals(rule.getEffect())),
                "saved tier must persist the workspace-layer allow rule");
    }

    @Test
    void rejectCarriesFeedbackToTheAgent() {
        activeRun("running");
        pendingToolApproval(requestId, "write_file", runId, sessionId, userId, workspaceId,
                Instant.now().plusSeconds(300));

        ResponseEntity<Map> response = decideWithBody(requestId,
                Map.of("decision", "reject", "feedback", "use append mode instead"));

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("rejected", approvalRepository.findById(UUID.fromString(requestId)).orElseThrow().getState());
        assertTrue(AGENT_DECISION_BODY.get().contains("\"feedback\":\"use append mode instead\""),
                "feedback must be forwarded to the Agent: " + AGENT_DECISION_BODY.get());
        assertTrue(AGENT_DECISION_BODY.get().contains("\"decision\":\"reject\""));
    }

    @Test
    void rejectPropagatesToOtherPendingRequestsOfTheSameSession() {
        activeRun("running");
        String otherId = UUID.randomUUID().toString();
        pendingToolApproval(requestId, "write_file", runId, sessionId, userId, workspaceId,
                Instant.now().plusSeconds(300));
        pendingToolApproval(otherId, "execute_command", runId, sessionId, userId, workspaceId,
                Instant.now().plusSeconds(300));

        ResponseEntity<Map> response = decideWithBody(requestId, Map.of("decision", "reject"));

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(1, response.getBody().get("propagated"));
        assertEquals("rejected", approvalRepository.findById(UUID.fromString(requestId)).orElseThrow().getState());
        assertEquals("rejected", approvalRepository.findById(UUID.fromString(otherId)).orElseThrow().getState());
    }

    @Test
    void savedTierRefusesUnclassifiedToolWithoutClaimingTheRow() {
        activeRun("running");
        pendingToolApproval(requestId, "third_party_tool", runId, sessionId, userId, workspaceId,
                Instant.now().plusSeconds(300));

        ResponseEntity<Map> response = noErrorClient().exchange(
                baseUrl + "/api/v1/chat/approvals/" + requestId + "/decision",
                HttpMethod.POST,
                new HttpEntity<>(Map.of("decision", "saved"), authorizedHeaders()),
                Map.class);

        assertEquals(HttpStatus.CONFLICT, response.getStatusCode());
        assertEquals("TOOL_UNCLASSIFIED", response.getBody().get("code"));
        assertEquals("pending", approvalRepository.findById(UUID.fromString(requestId)).orElseThrow().getState());
    }

    @Test
    @SuppressWarnings("unchecked")
    void unknownToolCreatesOpaqueAskSnapshotAndOnlyOnceCanBeApproved() throws Exception {
        activeRun("running");
        approvalService.recordPending(Map.of(
                        "requestId", requestId,
                        "runId", runId,
                        "sessionId", sessionId,
                        "tool", "third_party_tool",
                        "action", "Execute third_party_tool",
                        "details", "{\"tool\":\"third_party_tool\",\"arguments\":{}}",
                        "expiresAt", Instant.now().plusSeconds(300).toString()),
                sessionId, runId, userId, workspaceId);

        ChatApproval pending = approvalRepository.findById(UUID.fromString(requestId)).orElseThrow();
        Map<String, Object> policy = objectMapper.readValue(pending.getPolicySummary(), Map.class);
        assertEquals("ask", policy.get("effect"));
        assertEquals("unclassified", policy.get("actionClass"));
        assertEquals("opaque", policy.get("shape"));
        assertTrue(String.valueOf(policy.get("reason"))
                .contains("unclassified tool requires explicit classification"));

        ResponseEntity<Map> response = decideWithBody(requestId, Map.of("decision", "once"));

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("once", response.getBody().get("decision"));
        assertEquals("approved", approvalRepository.findById(UUID.fromString(requestId)).orElseThrow().getState());
        assertTrue(policyRuleRepository.findByLayerAndOwnerIdOrderByCreatedAtAscIdAsc("workspace", workspaceId)
                .stream().noneMatch(rule -> "unclassified".equals(rule.getActionClass())));
    }

    @Test
    void pendingEndpointReturnsCountsScopedToUserAndSession() {
        activeRun("running");
        pendingToolApproval(requestId, "write_file", runId, sessionId, userId, workspaceId,
                Instant.now().plusSeconds(300));
        pendingToolApproval(UUID.randomUUID().toString(), "write_file", runId, sessionId, userId, workspaceId,
                Instant.now().plusSeconds(300));
        String expiredId = UUID.randomUUID().toString();
        pendingToolApproval(expiredId, "write_file", runId, sessionId, userId, workspaceId,
                Instant.now().minusSeconds(1));

        String otherSession = UUID.randomUUID().toString();
        Session session = new Session(workspaceId, userId, "Other session");
        session.setId(UUID.fromString(otherSession));
        sessionRepository.save(session);
        String otherRun = UUID.randomUUID().toString();
        chatRunRepository.save(new ChatRun(otherRun, otherSession, userId, workspaceId,
                "idem-" + UUID.randomUUID(), "hash", "openai", "gpt-test", "workspace", "running"));
        pendingToolApproval(UUID.randomUUID().toString(), "execute_command", otherRun, otherSession,
                userId, workspaceId, Instant.now().plusSeconds(300));

        ResponseEntity<List> response = restTemplate.exchange(
                baseUrl + "/api/v1/approvals/pending", HttpMethod.GET,
                new HttpEntity<>(authorizedHeaders()), List.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        List<Map<String, Object>> summaries = response.getBody();
        assertEquals(2, summaries.size());
        Map<String, Object> first = summaries.stream()
                .filter(row -> sessionId.equals(row.get("sessionId"))).findFirst().orElseThrow();
        assertEquals(2, first.get("count"));
        assertEquals(workspaceId, first.get("workspaceId"));
        assertNotNull(first.get("oldestRequestedAt"));
        assertFalse(first.containsKey("tool") || first.containsKey("details"));
        Map<String, Object> second = summaries.stream()
                .filter(row -> otherSession.equals(row.get("sessionId"))).findFirst().orElseThrow();
        assertEquals(1, second.get("count"));
    }

    private HttpHeaders authorizedHeaders() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return headers;
    }
}
