package com.cc01cc.p.xihe.cp.mcp;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.chat.ApprovalDecision;
import com.cc01cc.p.xihe.cp.chat.ApprovalService;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.credentials.CredentialService;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Credential;
import com.cc01cc.p.xihe.cp.entity.CredentialEvent;
import com.cc01cc.p.xihe.cp.entity.McpInvocation;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;
import com.cc01cc.p.xihe.cp.repository.ConfigAuditRepository;
import com.cc01cc.p.xihe.cp.repository.CredentialEventRepository;
import com.cc01cc.p.xihe.cp.repository.CredentialLeaseRepository;
import com.cc01cc.p.xihe.cp.repository.CredentialRepository;
import com.cc01cc.p.xihe.cp.repository.McpInvocationRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import com.sun.net.httpserver.HttpServer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0497 M2 (T2.1 的 CP 契约面; contract: 0497 verify V3/V5 + design §方案 2):
 * the acquire_credential MCP path over the real HTTP tool surface —
 * - V3: a principal without credential_use is denied before any approval is created;
 * - V5: with askActionClasses=credential_use (manual) the call parks as
 *   APPROVAL_REQUIRED (payload carries no value), the decision approves it, and
 *   the replayed call delivers;
 * - delivery: the response carries the value exactly once while every durable
 *   surface (lease/events/invocation preview/approvals/audit stream) stays value-free.
 */
class CredentialToolAcquisitionContractTest extends AbstractIntegrationTest {

    private static final String SERVICE_TOKEN = "dev-token-not-secure";
    private static final String ACQUIRE_TOOL = "acquire_credential";
    private static final String DELIVERED_SECRET = "acquire-contract-secret-424242";

    private static HttpServer agentServer;
    private static final AtomicInteger AGENT_APPROVAL_HITS = new AtomicInteger();

    /**
     * decide() notifies the Agent process (ApprovalAgentClient) — a fake agent
     * endpoint keeps the approval loop real without a second process
     * (same pattern as ApprovalIntegrationTest).
     */
    @DynamicPropertySource
    static void configureFakeAgent(DynamicPropertyRegistry registry) {
        try {
            agentServer = HttpServer.create(new InetSocketAddress(0), 0);
            agentServer.createContext("/internal/v1/agent/approval/respond", exchange -> {
                AGENT_APPROVAL_HITS.incrementAndGet();
                exchange.getRequestBody().readAllBytes();
                byte[] body = "{\"status\":\"accepted\"}".getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", MediaType.APPLICATION_JSON_VALUE);
                exchange.sendResponseHeaders(200, body.length);
                try (OutputStream output = exchange.getResponseBody()) {
                    output.write(body);
                }
            });
            agentServer.createContext("/internal/v1/agent/health", exchange -> {
                byte[] body = ("{\"status\":\"ok\",\"liveness\":\"up\",\"llmReady\":\"ready\","
                        + "\"configRevision\":\"test-revision\"}").getBytes(StandardCharsets.UTF_8);
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
    static void stopFakeAgent() {
        if (agentServer != null) {
            agentServer.stop(0);
        }
    }

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceUserRepository workspaceUserRepository;
    @Autowired private AgentPrincipalRepository agentPrincipalRepository;
    @Autowired private WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired private SessionRepository sessionRepository;
    @Autowired private ChatRunRepository chatRunRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private McpInvocationRepository mcpInvocationRepository;
    @Autowired private CredentialRepository credentialRepository;
    @Autowired private CredentialLeaseRepository credentialLeaseRepository;
    @Autowired private CredentialEventRepository credentialEventRepository;
    @Autowired private ChatApprovalRepository chatApprovalRepository;
    @Autowired private ConfigJpaRepository configJpaRepository;
    @Autowired private ConfigAuditRepository configAuditRepository;
    @Autowired private CredentialService credentialService;
    @Autowired private ApprovalService approvalService;
    @Autowired private ConfigService configService;
    @Autowired private ObjectMapper objectMapper;

    private String userId;
    private String workspaceId;
    private String sessionId;
    private String runId;
    private UUID principalId;
    private Credential leaseCredential;
    private Credential revealCredential;
    private final java.util.List<UUID> configRowIds = new java.util.ArrayList<>();
    private ch.qos.logback.core.read.ListAppender<
            ch.qos.logback.classic.spi.ILoggingEvent> auditAppender;

    @BeforeEach
    void setUpCredentialFixture() {
        credentialLeaseRepository.deleteAll();
        auditAppender = new ch.qos.logback.core.read.ListAppender<>();
        auditAppender.start();
        ((ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger("AUDIT"))
                .addAppender(auditAppender);

        User user = userRepository.save(new User(
                "acquire-contract-" + UUID.randomUUID() + "@test.com", "hash", UserRole.USER,
                "Acquire contract"));
        userId = user.getId().toString();
        Workspace workspace = workspaceRepository.save(new Workspace("Acquire contract", user.getId().toString()));
        workspaceId = workspace.getId().toString();
        workspaceUserRepository.saveAndFlush(
                new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));

        leaseCredential = credentialService.create(new CredentialService.CreateRequest(
                "USER", userId, "leased-contract", "token", "lease",
                CredentialService.SecretPayload.ofToken(DELIVERED_SECRET)), null);
        revealCredential = credentialService.create(new CredentialService.CreateRequest(
                "USER", userId, "revealed-contract", "token", "reveal",
                CredentialService.SecretPayload.ofToken("reveal-only-secret")), null);

        // Both credentials ride the three snapshot layers so the reveal call reaches
        // the tier gate (a grant miss would 403 before the gate is exercised).
        principalId = seedPrincipalWithCredentialUse(leaseCredential, revealCredential);

        Session session = new Session(workspaceId, userId, "acquire-contract-session");
        session.setId(UUID.randomUUID());
        session.setAgentPrincipalId(principalId.toString());
        session.setAgentPermissionsSnapshot(credentialUseSnapshot(leaseCredential, revealCredential));
        session.setApprovalMode("manual");
        sessionRepository.saveAndFlush(session);
        sessionId = session.getId().toString();

        runId = UUID.randomUUID().toString();
        chatRunRepository.saveAndFlush(new ChatRun(
                runId, sessionId, userId, workspaceId,
                "acquire-contract-" + runId, "acquire-contract-hash",
                "provider", "model", "workspace", "running"));
    }

    @AfterEach
    void cleanCredentialFixture() {
        ((ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger("AUDIT"))
                .detachAppender(auditAppender);
        auditAppender.stop();
        if (!configRowIds.isEmpty()) {
            configRowIds.forEach(id -> configAuditRepository.deleteAll(
                    configAuditRepository.findByConfigIdOrderByChangedAtDesc(id.toString())));
            configRowIds.forEach(configJpaRepository::deleteById);
            configRowIds.clear();
        }
        credentialLeaseRepository.deleteAll();
        if (leaseCredential != null) {
            credentialRepository.deleteById(leaseCredential.getId());
        }
        if (revealCredential != null) {
            credentialRepository.deleteById(revealCredential.getId());
        }
        chatApprovalRepository.findAll().stream()
                .filter(approval -> sessionId.equals(approval.getSessionId()))
                .forEach(chatApprovalRepository::delete);
        // mcp_invocations are kept: each fixture seeds its own run/toolCall pair,
        // and their dispatch history rows would block the delete anyway (V64-era
        // fixture isolation relies on run scoping instead).
        if (runId != null) {
            chatRunRepository.deleteById(UUID.fromString(runId));
        }
        if (sessionId != null) {
            sessionRepository.deleteById(UUID.fromString(sessionId));
        }
        if (principalId != null) {
            workspaceAgentRepository.deleteAll(workspaceAgentRepository.findByIdPrincipalId(principalId));
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                    "agent_principal", principalId));
            agentPrincipalRepository.deleteById(principalId);
        }
        if (userId != null) {
            UUID userUuid = UUID.fromString(userId);
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("user", userUuid));
            if (workspaceId != null) {
                UUID workspaceUuid = UUID.fromString(workspaceId);
                workspaceUserRepository.deleteAll(workspaceUserRepository.findByIdWorkspaceId(workspaceUuid));
                workspaceRepository.deleteById(workspaceUuid);
            }
            userRepository.deleteById(userUuid);
        }
    }

    @Test
    void acquireDeliversTheValueOnceWhileEveryDurableSurfaceStaysValueFree() throws Exception {
        ResponseEntity<String> response = acquireCall(
                leaseCredential.getId().toString(), null, UUID.randomUUID().toString());

        assertEquals(HttpStatus.OK, response.getStatusCode(), response.getBody());
        assertTrue(response.getBody().contains(DELIVERED_SECRET),
                "the model-facing result must carry the delivered value exactly once");

        assertEquals(1, credentialLeaseRepository.findAll().size());
        var lease = credentialLeaseRepository.findAll().get(0);
        assertNotNull(lease.getRedeemedAt(), "one-step delivery consumes the lease");
        assertEquals(1, lease.getExpectedRevision());

        List<String> eventTypes = credentialEventRepository
                .findByCredentialIdOrderByCreatedAtDesc(leaseCredential.getId().toString())
                .stream()
                .map(CredentialEvent::getEventType)
                .toList();
        assertTrue(eventTypes.contains(CredentialEvent.TYPE_LEASE_ISSUED));
        assertTrue(eventTypes.contains(CredentialEvent.TYPE_LEASE_REDEEMED));

        // No approval is created on the allow path.
        assertEquals(0, approvalsForSession());

        // The durable invocation preview carries the id, never the value.
        McpInvocation invocation = mcpInvocationRepository.findAll().stream()
                .filter(row -> runId.equals(row.getRunId()))
                .findFirst()
                .orElseThrow();
        assertTrue(invocation.getArgumentsPreview().contains(leaseCredential.getId().toString()));
        assertFalse(invocation.getArgumentsPreview().contains(DELIVERED_SECRET));

        // The audit stream never sees the value (I5).
        String auditText = auditAppender.list.stream()
                .map(event -> event.getFormattedMessage())
                .collect(java.util.stream.Collectors.joining("\n"));
        assertFalse(auditText.contains(DELIVERED_SECRET));
        assertTrue(auditText.contains("credential_lease_issued"));

        // The reveal tier never rides the lease channel (decision #7).
        ResponseEntity<String> revealResponse = acquireCall(
                revealCredential.getId().toString(), null, UUID.randomUUID().toString());
        assertEquals(HttpStatus.OK, revealResponse.getStatusCode(), revealResponse.getBody());
        assertTrue(revealResponse.getBody().contains("CREDENTIAL_TIER_MISMATCH"),
                "reveal-tier credentials are rejected by the tier gate: " + revealResponse.getBody());
    }

    @Test
    void grantDenyStopsBeforeAnyApprovalIsCreated() throws Exception {
        // Remove the credential_use grant: the evaluation layer must deny before ask.
        grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                "agent_principal", principalId));

        ResponseEntity<String> response = acquireCall(
                leaseCredential.getId().toString(), null, UUID.randomUUID().toString());

        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode(), response.getBody());
        assertEquals(0, approvalsForSession(),
                "V3: a grant deny must not create a pending approval");
        assertEquals(0, credentialLeaseRepository.findAll().size(),
                "a denied call must not issue a lease");
    }

    @Test
    void manualAskParksPendingThenDeliversAfterApproval() throws Exception {
        configureManualAskForCredentialUse();

        String toolCallId = UUID.randomUUID().toString();
        ResponseEntity<String> parked = acquireCall(
                leaseCredential.getId().toString(), null, toolCallId);
        assertTrue(parked.getBody().contains("APPROVAL_REQUIRED"),
                "V5: manual ask must park the call: " + parked.getBody());
        assertEquals(1, approvalsForSession());

        String requestId = extractApprovalRequestId(parked.getBody());
        assertNotNull(requestId);

        // The approval payload (request body) carries the credential id, never the value.
        ChatApproval pending = chatApprovalRepository.findAll().stream()
                .filter(approval -> requestId.equals(approval.getRequestId().toString()))
                .findFirst()
                .orElseThrow();
        assertFalse(objectMapper.writeValueAsString(pending).contains(DELIVERED_SECRET),
                "the approval record must not contain the credential value");
        assertTrue(objectMapper.writeValueAsString(pending).contains(
                leaseCredential.getId().toString()));

        approvalService.decide(requestId, userId, workspaceId,
                new ApprovalDecision(ApprovalDecision.Kind.ONCE, null, null, null, null));

        ResponseEntity<String> replay = acquireCall(
                leaseCredential.getId().toString(), requestId, toolCallId);
        assertEquals(HttpStatus.OK, replay.getStatusCode(), replay.getBody());
        assertTrue(replay.getBody().contains(DELIVERED_SECRET),
                "the approved replay must deliver: " + replay.getBody());

        // Approvals never carry the value, before or after the decision.
        String approvalText = chatApprovalRepository.findAll().stream()
                .map(row -> safeJson(row))
                .collect(java.util.stream.Collectors.joining("\n"));
        assertFalse(approvalText.contains(DELIVERED_SECRET));
    }

    // ── fixture helpers ──────────────────────────────────────────────────

    private UUID seedPrincipalWithCredentialUse(Credential... credentials) {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("Acquire contract principal");
        principal.setCreatedByUserId(UUID.fromString(userId).toString());
        ObjectNode snapshot = objectMapper.createObjectNode();
        snapshot.set("permissions", credentialUseSnapshot(credentials));
        principal.setTemplateSnapshot(snapshot);
        principal = agentPrincipalRepository.saveAndFlush(principal);

        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setSubjectType("agent_principal");
        grant.setSubjectId(principal.getId());
        grant.setGranterType("user");
        grant.setGranterId(UUID.fromString(userId));
        grant.setSource("default");
        grant.setPermissions(credentialUseSnapshot(credentials));
        grantRepository.saveAndFlush(grant);

        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(
                principal.getId().toString(), workspaceId, credentialUseSnapshot(credentials)));
        return principal.getId();
    }

    private ArrayNode credentialUseSnapshot(Credential... credentials) {
        ArrayNode atoms = objectMapper.createArrayNode();
        for (Credential credential : credentials) {
            ObjectNode atom = objectMapper.createObjectNode();
            atom.put("actionClass", "credential_use");
            atom.put("resource", "credential:" + credential.getId());
            atoms.add(atom);
        }
        return atoms;
    }

    private void configureManualAskForCredentialUse() {
        configService.putLayer("workspace", "approval-policy",
                Map.of("askActionClasses", "[\"credential_use\"]"),
                "acquire-contract", UUID.fromString(userId), UUID.fromString(workspaceId));
        configJpaRepository.findByUserIdAndDomain(UUID.fromString(userId), "approval-policy")
                .forEach(row -> configRowIds.add(row.getId()));
    }

    private ResponseEntity<String> acquireCall(String credentialId, String approvalRequestId,
                                               String toolCallId) throws Exception {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(SERVICE_TOKEN);
        headers.set("X-Workspace-Id", workspaceId);
        headers.set("X-Session-Id", sessionId);
        headers.set("X-Chat-Run-Id", runId);
        headers.set("X-Tool-Call-Id", toolCallId);
        if (approvalRequestId != null) {
            headers.set("X-Xihe-Approval-Request-Id", approvalRequestId);
        }
        ObjectNode arguments = objectMapper.createObjectNode();
        arguments.put("credentialId", credentialId);
        String body = objectMapper.writeValueAsString(Map.of(
                "jsonrpc", "2.0",
                "method", "tools/call",
                "id", 21,
                "params", Map.of("name", ACQUIRE_TOOL, "arguments", arguments)));
        return restTemplate.postForEntity(
                url("/api/v1/mcp"), new HttpEntity<>(body, headers), String.class);
    }

    private String extractApprovalRequestId(String responseBody) throws Exception {
        return objectMapper.readTree(responseBody)
                .path("error").path("data").path("approvalRequestId").asText(null);
    }

    private int approvalsForSession() {
        return (int) chatApprovalRepository.findAll().stream()
                .filter(approval -> sessionId.equals(approval.getSessionId()))
                .count();
    }

    private String safeJson(Object row) {
        try {
            return objectMapper.writeValueAsString(row);
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }
}
