package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.AuthService;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.mcp.McpProxyController;
import com.cc01cc.p.xihe.cp.mcp.McpInvocationService;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuditLogRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.util.ReflectionTestUtils;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * V11 / design #13 (PLAN-0407 G2 Q4 correction): bare execution removes only the sandbox hard
 * constraint on the capability plane — the carrier is the existing {@code windows-host} execution
 * mode. The authorization intersection and the approval gate take <b>zero</b> exemption: under a
 * bare workspace plus manual approval mode an on-list write tool must still be parked at the
 * approval gate (verdict ASK + durable pending row), and switching {@code executionMode} must not
 * change that verdict.
 *
 * <p>Fixtures run on the real PostgreSQL integration stack: real {@link PolicyEngine},
 * {@link GrantAuthorizationService}, {@link ApprovalService} and a real {@link McpProxyController}
 * gate invocation — no mocked verdict anywhere in this class.</p>
 */
class BareExecutionApprovalTest extends AbstractIntegrationTest {

    private static final List<String> LIVE_APPROVAL_STATES =
            List.of("pending", "dispatching", "dispatch_unknown", "approved", "rejected", "expired");

    @Autowired
    private AuthService authService;

    @Autowired
    private com.cc01cc.p.xihe.cp.service.WorkspaceService workspaceService;

    @Autowired
    private PolicyEngine policyEngine;

    @Autowired
    private SessionApprovalMode sessionApprovalMode;

    @Autowired
    private McpProxyController mcpProxyController;

    @Autowired
    private com.cc01cc.p.xihe.cp.mcp.McpToolTimeoutService mcpToolTimeoutService;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private ChatApprovalRepository chatApprovalRepository;

    @Autowired
    private AgentPrincipalRepository agentPrincipalRepository;

    @Autowired
    private WorkspaceAgentRepository workspaceAgentRepository;

    @Autowired
    private AuthorizationGrantRepository grantRepository;

    @Autowired
    private AuditLogRepository auditLogRepository;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private McpInvocationService mcpInvocationService;

    private String userId;
    private String workspaceId;
    private String sessionId;
    private String runId;
    private String toolCallId;
    private UUID principalId;
    private WorkspaceAgentId bindingId;
    private final List<UUID> grantIds = new ArrayList<>();
    private final List<UUID> auditIds = new ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        if (sessionId != null) {
            chatApprovalRepository.deleteAll(chatApprovalRepository.findBySessionIdAndStateInOrderByCreatedAtDesc(
                    sessionId, LIVE_APPROVAL_STATES));
            chatRunRepository.deleteById(UUID.fromString(runId));
            sessionRepository.deleteById(UUID.fromString(sessionId));
            sessionId = null;
        }
        grantRepository.deleteAllById(grantIds);
        grantIds.clear();
        auditLogRepository.deleteAllById(auditIds);
        auditIds.clear();
        if (bindingId != null) {
            workspaceAgentRepository.deleteById(bindingId);
            bindingId = null;
        }
        if (principalId != null) {
            agentPrincipalRepository.deleteById(principalId);
            principalId = null;
        }
        if (workspaceId != null) {
            workspaceRepository.deleteById(UUID.fromString(workspaceId));
            workspaceId = null;
        }
        if (userId != null) {
            userRepository.deleteById(UUID.fromString(userId));
            userId = null;
        }
    }

    /** design #13: the bare carrier (windows-host) is active while approval mode stays manual. */
    @Test
    void bareWindowsHostStillParksAnOnListWriteAtTheApprovalGate() throws Exception {
        bareWorkspaceFixture();

        Workspace workspace = workspaceRepository.findById(UUID.fromString(workspaceId)).orElseThrow();
        assertEquals("windows-host", workspace.getExecutionMode(),
                "fixture sanity: the bare execution carrier is the workspace execution mode");

        String body = writeBody("bare.md");
        PolicyContext context = policyEngine.loadContext(userId, workspaceId, sessionId);
        assertTrue(policyEngine.allowsByGrant(context, "write_file", body, sessionId, userId, workspaceId, false),
                "gate 1 (authorization) passes for the bound Agent principal");
        PolicyVerdict verdict = policyEngine.evaluateVerdict(
                context, "write_file", body, sessionId, null, userId, workspaceId);
        assertEquals(PolicyEffect.ASK, verdict.effect(),
                "gate 3 (approval) still asks under bare windows-host + manual mode");
        assertEquals("manual", verdict.mode(), "manual approval mode is in force");
        assertEquals("action class on the approval ask list", verdict.reason());
        assertNull(verdict.allowedBy(), "manual mode never auto-passes an on-list action");

        ResponseEntity<String> response = callGate(body);
        assertEquals(HttpStatus.CONFLICT, response.getStatusCode());
        assertNotNull(response.getBody());
        assertTrue(response.getBody().contains("APPROVAL_REQUIRED"),
                "the real MCP gate answers the approval frame, got: " + response.getBody());

        String approvalRequestId = new ObjectMapper().readTree(response.getBody())
                .path("error").path("data").path("approvalRequestId").asText();
        ChatApproval row = chatApprovalRepository.findById(UUID.fromString(approvalRequestId)).orElseThrow();
        assertEquals("pending", row.getState(), "a durable pending approval row exists under bare execution");
        assertEquals(workspaceId, row.getWorkspaceId());
        assertEquals(sessionId, row.getSessionId());
    }

    /** Negative control: docker ↔ windows-host is invisible to the approval decision. */
    @Test
    void switchingExecutionModeDoesNotChangeTheApprovalVerdict() throws Exception {
        bareWorkspaceFixture();

        String bareBody = writeBody("bare-control.md");
        PolicyContext bareContext = policyEngine.loadContext(userId, workspaceId, sessionId);
        PolicyVerdict underBare = policyEngine.evaluateVerdict(
                bareContext, "write_file", bareBody, sessionId, null, userId, workspaceId);
        ResponseEntity<String> bareGate = callGate(bareBody);
        assertEquals(HttpStatus.CONFLICT, bareGate.getStatusCode(),
                "bare windows-host parks the call at the approval gate");

        Workspace workspace = workspaceRepository.findById(UUID.fromString(workspaceId)).orElseThrow();
        workspace.setExecutionMode("docker");
        workspaceRepository.save(workspace);
        assertEquals("docker", workspaceRepository.findById(UUID.fromString(workspaceId))
                .orElseThrow().getExecutionMode(), "fixture sanity: mode switched to docker");

        PolicyVerdict underDocker = policyEngine.evaluateVerdict(
                policyEngine.loadContext(userId, workspaceId, sessionId),
                "write_file", bareBody, sessionId, null, userId, workspaceId);
        String dockerBody = writeBody("sandbox-control.md");
        createAgentToolCall(dockerBody);
        ResponseEntity<String> dockerGate = callGate(dockerBody);

        assertEquals(PolicyEffect.ASK, underBare.effect());
        assertEquals(PolicyEffect.ASK, underDocker.effect());
        assertEquals(underBare.effect(), underDocker.effect(),
                "executionMode never reaches the approval verdict");
        assertEquals(underBare.reason(), underDocker.reason());
        assertEquals(underBare.mode(), underDocker.mode());

        assertEquals(HttpStatus.CONFLICT, dockerGate.getStatusCode());
        assertNotNull(dockerGate.getBody());
        assertTrue(dockerGate.getBody().contains("APPROVAL_REQUIRED"),
                "docker parks the call exactly like the bare carrier, got: " + dockerGate.getBody());
        assertEquals(2, chatApprovalRepository
                        .findBySessionIdAndStateInOrderByCreatedAtDesc(sessionId, List.of("pending")).size(),
                "both execution modes park one pending approval row each");
    }

    /**
     * Real MCP gate invocation: seeds only the tool-name cache, everything else (grant gate,
     * verdict, approval service, durable row) is the production wiring.
     *
     * <p>PLAN-0470 batch note: the tool-name cache moved to
     * {@code McpToolTimeoutService} in 3994a50e; the reflection target here
     * was stale on HEAD and is corrected to the owning service.
     */
    @SuppressWarnings("unchecked")
    private ResponseEntity<String> callGate(String body) throws Exception {
        Map<String, Map<String, String>> cache =
                (Map<String, Map<String, String>>) ReflectionTestUtils.getField(
                        mcpToolTimeoutService, "toolServerCache");
        Map<String, Instant> timestamps =
                (Map<String, Instant>) ReflectionTestUtils.getField(mcpToolTimeoutService, "cacheTimestamps");
        cache.put(workspaceId, new ConcurrentHashMap<>(Map.of("write_file", "__system__")));
        timestamps.put(workspaceId, Instant.now());

        HttpHeaders headers = new HttpHeaders();
        headers.set("X-Chat-Run-Id", runId);
        headers.set("X-Tool-Call-Id", toolCallId);

        return ReflectionTestUtils.invokeMethod(mcpProxyController, "handleToolsCall",
                workspaceId, body, headers, sessionId,
                accessContext(workspaceId, userId, sessionId));
    }

    private static Object accessContext(String wsId, String userId, String sessionId) throws Exception {
        Class<?> accessClass = Class.forName(
                "com.cc01cc.p.xihe.cp.mcp.McpProxyController$AccessContext");
        var constructor = accessClass.getDeclaredConstructor(
                String.class, String.class, String.class, String.class, boolean.class);
        constructor.setAccessible(true);
        // tools/call is the internal Agent path; the public user path correctly rejects direct MCP mutation.
        return constructor.newInstance(wsId, userId, sessionId, null, true);
    }

    private static String writeBody(String path) {
        return "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":1,"
                + "\"params\":{\"name\":\"write_file\",\"arguments\":{\"path\":\"" + path + "\"}}}";
    }

    /** Registration default + stable principal/binding/Session caps + bare workspace + manual mode. */
    private void bareWorkspaceFixture() {
        // PLAN-0470 #25: reproduces the AuthController register orchestration.
        com.cc01cc.p.xihe.cp.entity.User user = authService.registerUser(new RegisterRequest(
                "bare-execution-" + UUID.randomUUID() + "@test.com", "grant-test-password",
                "Bare execution test"));
        AuthResponse registered = authService.issueTokens(user, workspaceService
                .getOrCreateDefaultWorkspace(user.getId().toString()).getId().toString());
        userId = registered.getUser().getId();
        workspaceId = registered.getWorkspaceId();

        grantRepository.findBySubjectTypeAndSubjectId("user", UUID.fromString(userId))
                .forEach(grant -> grantIds.add(grant.getId()));
        auditLogRepository.findByUserIdOrderByCreatedAtDesc(userId).stream()
                .filter(row -> "authorization_default_grant_created".equals(row.getAction()))
                .forEach(row -> auditIds.add(row.getId()));

        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("Bare execution agent");
        principal.setCreatedByUserId(userId);
        principal.setTemplateSnapshot(objectMapper.createObjectNode());
        principalId = agentPrincipalRepository.saveAndFlush(principal).getId();

        ArrayNode capability = atoms("read", "write", "delete", "exec", "network");
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setSubjectType(GrantPrincipalPathResolver.AGENT_PRINCIPAL);
        grant.setSubjectId(principalId);
        grant.setSource("default");
        grant.setPermissions(capability);
        grantIds.add(grantRepository.save(grant).getId());

        WorkspaceAgent binding = workspaceAgentRepository.saveAndFlush(
                new WorkspaceAgent(principalId.toString(), workspaceId, capability));
        bindingId = binding.getId();

        Session session = new Session(workspaceId, userId, "Bare execution Session");
        session.setId(UUID.randomUUID());
        session.setAgentPrincipalId(principalId.toString());
        session.setAgentPermissionsSnapshot(capability);
        sessionId = sessionRepository.save(session).getId().toString();

        runId = UUID.randomUUID().toString();
        chatRunRepository.save(new ChatRun(runId, sessionId, userId, workspaceId,
                "bare-execution-" + UUID.randomUUID(), "hash", "openai", "gpt-test",
                "workspace", "running"));
        createAgentToolCall(writeBody("bare.md"));

        Workspace workspace = workspaceRepository.findById(UUID.fromString(workspaceId)).orElseThrow();
        workspace.setExecutionMode("windows-host");
        workspaceRepository.save(workspace);

        sessionApprovalMode.setMode(sessionId, "manual");
    }

    private ArrayNode atoms(String... actionClasses) {
        ArrayNode permissions = objectMapper.createArrayNode();
        for (String actionClass : actionClasses) {
            ObjectNode atom = objectMapper.createObjectNode();
            atom.put("actionClass", actionClass);
            permissions.add(atom);
        }
        return permissions;
    }

    private void createAgentToolCall(String body) {
        toolCallId = UUID.randomUUID().toString();
        mcpInvocationService.openAgentInvocation(runId, toolCallId, "write_file",
                UUID.randomUUID().toString(), body).orElseThrow();
    }
}
