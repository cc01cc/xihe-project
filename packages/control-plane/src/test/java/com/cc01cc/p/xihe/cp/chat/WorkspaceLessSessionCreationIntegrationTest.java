package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.SessionBranchRepository;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.service.SessionParticipantService;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import org.springframework.data.domain.Pageable;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0647 MVP (D-678/D-687): POST /api/v1/sessions with no workspace surface creates a
 * workspace-less session; an explicit body/header workspace keeps today's behaviour byte-identical.
 */
class WorkspaceLessSessionCreationIntegrationTest extends AbstractIntegrationTest {

    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private ObjectMapper json;
    @Autowired private SessionRepository sessions;
    @Autowired private ChatRunRepository chatRuns;
    @Autowired private SessionBranchRepository branches;
    @Autowired private ChatSubmissionService chatSubmissionService;
    @Autowired private ChatController chatController;
    @Autowired private ProviderConnectionRepository providerConnections;
    @Autowired private ConfigService configService;

    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5)).build();

    private String token;
    private String userId;
    private String workspaceId;
    private String otherWorkspaceId;
    private String principalId;
    private String connectionId;
    private String providerId;

    @BeforeEach
    void fixture() {
        AuthResponse owner = register("wsless-owner");
        token = owner.getAccessToken();
        userId = owner.getUser().getId();
        workspaceId = workspaceFixture.createOwnedWorkspace("wsless ws", userId).getId().toString();
        otherWorkspaceId = workspaceFixture.createOwnedWorkspace("wsless other", userId).getId().toString();
        JsonNode principal = send(workspaceId, "POST", "/api/v1/agent-principals",
                """
                {"name":"WslessAgent"}""").body();
        principalId = principal.path("principalId").asText();
        // A workspace-scoped Session resolves the principal's cap through its active workspace
        // binding (D-49); bind the fixture principal in both workspaces it may be created under.
        assertEquals(200, send(workspaceId, "PUT",
                "/api/v1/workspaces/" + workspaceId + "/agents/" + principalId,
                "{\"permissions\":[]}").status(), "fixture must bind the principal to the workspace");
        assertEquals(200, send(workspaceId, "PUT",
                "/api/v1/workspaces/" + otherWorkspaceId + "/agents/" + principalId,
                "{\"permissions\":[]}").status(), "fixture must bind the principal to the second workspace");
        var binding = ChatBindingTestSupport.ensureChatConnection(
                providerConnections, "USER", userId, "wsless-" + UUID.randomUUID().toString().substring(0, 8));
        connectionId = binding.getId().toString();
        providerId = binding.getProviderId();
    }

    @Test
    void noWorkspaceSurfaceCreatesAWorkspaceLessSession() {
        Reply created = send(null, "POST", "/api/v1/sessions", body(null));
        assertEquals(201, created.status(), created.body().toString());
        String sessionId = created.body().path("id").asText();
        assertTrue(created.body().path("workspaceId").isNull() || created.body().path("workspaceId").isMissingNode(),
                "workspaceless Session must expose workspaceId=null: " + created.body());

        Session row = sessions.findById(UUID.fromString(sessionId)).orElseThrow();
        assertNull(row.getWorkspaceId(), "D-678: no interceptor fallback may assign a workspace");
        assertNull(row.getAgentPermissionsSnapshot(),
                "D-686: the snapshot is null (no cap is derived for a workspace-less Session)");
        assertEquals(userId, row.getUserId());
    }

    @Test
    void explicitHeaderStillCreatesAWorkspaceSession() {
        Reply created = send(workspaceId, "POST", "/api/v1/sessions", body(null));
        assertEquals(201, created.status(), created.body().toString());
        String sessionId = created.body().path("id").asText();
        assertEquals(workspaceId, sessions.findById(UUID.fromString(sessionId)).orElseThrow().getWorkspaceId(),
                "the existing header surface must be byte-identical");
    }

    @Test
    void explicitBodyWorkspaceIdIsAnExplicitWorkspaceSurface() {
        Reply created = send(null, "POST", "/api/v1/sessions", body(otherWorkspaceId));
        assertEquals(201, created.status(), created.body().toString());
        String sessionId = created.body().path("id").asText();
        assertEquals(otherWorkspaceId, sessions.findById(UUID.fromString(sessionId)).orElseThrow().getWorkspaceId(),
                "body workspaceId is explicit: it wins and is membership/write-role checked");
    }

    @Test
    void explicitNullBodyWithHeaderKeepsTheHeaderWorkspace() {
        String payload = """
                {"agentPrincipalId":"%s","title":"t","workspaceId":null,"modelProvider":"%s",
                "modelName":"gpt-test","providerConnectionId":"%s"}"""
                .formatted(principalId, providerId, connectionId);
        Reply created = send(workspaceId, "POST", "/api/v1/sessions", payload);
        assertEquals(201, created.status(), created.body().toString());
        String sessionId = created.body().path("id").asText();
        assertEquals(workspaceId, sessions.findById(UUID.fromString(sessionId)).orElseThrow().getWorkspaceId());
    }

    @Test
    void workspaceLessChatDoorRejectsToolModeWithZeroRuns() {
        String sessionId = createWorkspaceless();
        String branchId = rootBranch(sessionId);
        Reply reply = send(null, "POST", "/api/v1/chat",
                """
                {"sessionId":"%s","branchId":"%s","content":"hi","toolMode":"workspace"}"""
                        .formatted(sessionId, branchId));
        assertEquals(400, reply.status(), reply.body().toString());
        assertEquals("WORKSPACE_LESS_TOOL_MODE_FORBIDDEN", reply.body().path("code").asText());
        assertTrue(chatRuns.findBySessionIdOrderByCreatedAtDescIdDesc(sessionId, Pageable.ofSize(10)).isEmpty(),
                "the workspaceless tool-mode refusal must leave zero runs");
    }

    @Test
    void workspaceLessChatDoorRejectsWorkspaceOnlyFeatures() throws Exception {
        String sessionId = createWorkspaceless();
        String branchId = rootBranch(sessionId);
        Reply attachments = send(null, "POST", "/api/v1/chat",
                """
                {"sessionId":"%s","branchId":"%s","content":"hi","toolMode":"none",
                "attachments":["%s"]}"""
                        .formatted(sessionId, branchId, UUID.randomUUID()));
        assertEquals(400, attachments.status(), attachments.body().toString());
        assertEquals("WORKSPACE_LESS_FEATURE_FORBIDDEN", attachments.body().path("code").asText());
        assertTrue(chatRuns.findBySessionIdOrderByCreatedAtDescIdDesc(sessionId, Pageable.ofSize(10)).isEmpty());

        // D-1438 / task-65: TO is no longer AGENT-only — a HUMAN target is DELIVERED as a
        // notification (zero runs), so the participant gate asks for deliverability, not speak-as.
        // This harness has no agent, so admission now stops at a LATER gate (202, or 503
        // AGENT_UNAVAILABLE/readiness) — the point is that it is no longer the TO gate's refusal.
        Reply joined = send(null, "POST", "/api/v1/sessions/" + sessionId + "/participants",
                """
                {"principalKind":"HUMAN","principalId":"%s"}""".formatted(userId));
        assertEquals(201, joined.status(), joined.body().toString());
        String humanParticipantId = joined.body().path("participantId").asText();
        try (java.io.InputStream stream = subscribe(sessionId, "").body()) {
            Reply fanout = send(null, "POST", "/api/v1/chat",
                    """
                    {"sessionId":"%s","branchId":"%s","content":"hi","toolMode":"none",
                    "toParticipantIds":["%s"]}"""
                            .formatted(sessionId, branchId, humanParticipantId));
            assertTrue(fanout.status() == 202 || fanout.status() == 503,
                    "task-65: a HUMAN TO target is admitted: " + fanout.body());
            assertNotEquals("INVALID_REQUEST", fanout.body().path("code").asText(),
                    "task-65: the TO gate no longer refuses a HUMAN target: " + fanout.body());
        }
    }

    @Test
    void workspaceLessChatDoorAcceptsCcObservers() throws Exception {
        String sessionId = createWorkspaceless();
        String branchId = rootBranch(sessionId);
        String primaryId = primaryParticipantId(sessionId);
        // Chat admission requires an active SSE subscription (409 otherwise) — unrelated to the
        // workspace-less gate, so the stream is opened first and closed with the block.
        try (java.io.InputStream stream = subscribe(sessionId, "").body()) {
            Reply cc = send(null, "POST", "/api/v1/chat",
                    """
                    {"sessionId":"%s","branchId":"%s","content":"hi","toolMode":"none","cc":["%s"]}"""
                            .formatted(sessionId, branchId, primaryId));
            // The harness has no agent, so admission may stop at the LLM-readiness gate (503
            // AGENT_UNAVAILABLE) — that gate runs AFTER this one, which is exactly the proof the
            // cc request is no longer refused for being workspace-less. Before D-1438 it never
            // got that far: it answered 400 WORKSPACE_LESS_FEATURE_FORBIDDEN here.
            assertTrue(cc.status() == 202 || cc.status() == 503,
                    "D-1438: cc is admitted past the workspace-less gate: " + cc.body());
            assertNotEquals("WORKSPACE_LESS_FEATURE_FORBIDDEN", cc.body().path("code").asText(),
                    "D-1438: cc must not be refused as a workspace-less-only feature: " + cc.body());
        }
    }

    /** Opens the session event stream; {@code extraQuery} carries extra params, e.g. asParticipantId. */
    private HttpResponse<java.io.InputStream> subscribe(String sessionId, String extraQuery)
            throws Exception {
        URI uri = URI.create(url("/api/v1/events?sessionId=" + sessionId + extraQuery));
        HttpRequest request = HttpRequest.newBuilder(uri)
                .header("Authorization", "Bearer " + token)
                .timeout(Duration.ofSeconds(5))
                .GET()
                .build();
        return http.send(request, HttpResponse.BodyHandlers.ofInputStream());
    }

    /**
     * D-1438 (task-48): the SSE declared participant view used to answer
     * {@code WORKSPACE_LESS_FEATURE_FORBIDDEN} and had <b>no test at all</b> pinning either
     * behaviour. The gate is gone, so this is the positive pin that keeps it from coming back.
     */
    @Test
    void workspaceLessSessionAllowsADeclaredParticipantViewOnTheEventStream() throws Exception {
        String sessionId = createWorkspaceless();
        String primaryId = primaryParticipantId(sessionId);
        HttpResponse<java.io.InputStream> response =
                subscribe(sessionId, "&asParticipantId=" + primaryId);
        assertEquals(200, response.statusCode(),
                "D-1438: a declared participant view needs the participant gate, not a workspace");
        try (java.io.InputStream stream = response.body()) {
            String head = new String(stream.readNBytes(64),
                    java.nio.charset.StandardCharsets.UTF_8);
            assertTrue(head.contains("connected"),
                    "the stream must open with the connected event, got: " + head);
        }
    }

    /**
     * D-1438 ruling 2: the default roster is seeded from {@code agent-runtime.defaultParticipants}
     * and a stale principal is <b>skipped with a WARN</b> — never a failed session create.
     */
    @Test
    void workspaceLessSessionSeedsTheConfiguredRosterAndSkipsAStalePrincipal() {
        String stalePrincipal = UUID.randomUUID().toString();
        String configured = """
                [{"principalKind":"HUMAN","principalId":"%s","role":"MEMBER",
                  "wakePolicy":"MENTION","respondPolicy":"WHEN_MENTIONED","deliveryDefaults":["cc"]},
                 {"principalKind":"HUMAN","principalId":"%s"}]"""
                .formatted(userId, stalePrincipal);
        configService.putLayer("user", "agent-runtime",
                Map.of("defaultParticipants", configured), "test", UUID.fromString(userId), null);

        String sessionId = createWorkspaceless();
        List<String> humanIds = new ArrayList<>();
        for (JsonNode participant : send(null, "GET",
                "/api/v1/sessions/" + sessionId + "/participants", null).body().path("participants")) {
            if ("HUMAN".equals(participant.path("principalKind").asText())) {
                humanIds.add(participant.path("principalId").asText());
            }
        }
        assertEquals(List.of(userId), humanIds,
                "the stale principal is skipped, the configured human is seeded");
    }

    private String primaryParticipantId(String sessionId) {
        JsonNode participants = send(null, "GET",
                "/api/v1/sessions/" + sessionId + "/participants", null).body().path("participants");
        assertEquals(1, participants.size(), participants.toString());
        return participants.get(0).path("participantId").asText();
    }
    private String body(String workspaceIdValue) {
        String workspaceField = workspaceIdValue == null ? "" : ",\"workspaceId\":\"" + workspaceIdValue + "\"";
        return """
                {"agentPrincipalId":"%s","title":"wsless","modelProvider":"%s",
                "modelName":"gpt-test","providerConnectionId":"%s"%s}"""
                .formatted(principalId, providerId, connectionId, workspaceField);
    }

    @Test
    void workspaceLessAdmissionPersistsARunWithNullWorkspaceAndAllowsNullSnapshot() {
        String sessionId = createWorkspaceless();
        String branchId = rootBranch(sessionId);
        Session row = sessions.findById(UUID.fromString(sessionId)).orElseThrow();
        assertNull(row.getAgentPermissionsSnapshot(), "D-686 keeps the snapshot null");
        ProviderConnection connection = providerConnections.findById(UUID.fromString(connectionId)).orElseThrow();
        ChatSubmissionService.Submission submission = chatSubmissionService.create(
                UUID.randomUUID().toString(), sessionId, userId, null, branchId,
                UUID.randomUUID().toString(), "a".repeat(64), providerId, "gpt-test", "none",
                connectionId, connection.getRevision(), null, "req-wsless", "hi", null,
                List.of(), null, null);
        assertNull(submission.run().getWorkspaceId(),
                "D-47-05: the run's workspace is the row's NULL, never the interceptor fallback");
        assertEquals(1, chatRuns.findBySessionIdOrderByCreatedAtDescIdDesc(sessionId, Pageable.ofSize(10)).size());
    }

    @Test
    void workspaceLessLeaseCapIsAnExplicitEmptyArray() {
        com.fasterxml.jackson.databind.JsonNode cap = chatController.leaseCapFor(
                new SessionParticipantService.Responder(UUID.randomUUID(), "AGENT", UUID.randomUUID()), null);
        assertTrue(cap.isArray(), "D-697: the cap is an array, not null");
        assertEquals(0, cap.size(), "D-697: explicit zero capability (never uncapped)");
    }
    private String createWorkspaceless() {
        Reply created = send(null, "POST", "/api/v1/sessions", body(null));
        assertEquals(201, created.status(), created.body().toString());
        return created.body().path("id").asText();
    }

    private String rootBranch(String sessionId) {
        return branches.findBySessionIdAndParentBranchIdIsNull(sessionId).orElseThrow()
                .getId().toString();
    }
    private AuthResponse register(String label) {
        var response = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new RegisterRequest(label + "-" + UUID.randomUUID() + "@test.com",
                        TestDataFactory.PASSWORD, label), AuthResponse.class);
        assertEquals(201, response.getStatusCode().value());
        assertNotNull(response.getBody());
        return response.getBody();
    }

    private Reply send(String workspaceHeader, String method, String path, String body) {
        try {
            HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(url(path)))
                    .header("Authorization", "Bearer " + token)
                    .header("Content-Type", "application/json");
            if (workspaceHeader != null) {
                builder.header("X-Workspace-Id", workspaceHeader);
            }
            HttpRequest request = builder.method(method, body == null
                            ? HttpRequest.BodyPublishers.noBody()
                            : HttpRequest.BodyPublishers.ofString(body))
                    .build();
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
            return new Reply(response.statusCode(), json.readTree(
                    response.body() == null || response.body().isBlank() ? "{}" : response.body()));
        } catch (java.io.IOException | InterruptedException e) {
            throw new IllegalStateException("HTTP " + method + " " + path + " failed", e);
        }
    }

    private record Reply(int status, JsonNode body) {}
}
