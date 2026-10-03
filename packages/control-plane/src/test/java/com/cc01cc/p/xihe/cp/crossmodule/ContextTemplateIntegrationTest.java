package com.cc01cc.p.xihe.cp.crossmodule;

import static com.github.tomakehurst.wiremock.client.WireMock.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.chat.SseEmitterManager;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.cc01cc.p.xihe.cp.service.AgentTemplateService;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.cc01cc.p.xihe.cp.status.HealthMonitor;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0414 T1.2/T1.3/T1.4: context-templates config layer contract, explicit
 * Session binding, and atomic ChatRun snapshot isolation.
 */
class ContextTemplateIntegrationTest extends AbstractWireMockTest {

    private static final String TEMPLATE_ID = "11111111-1111-4111-8111-111111111111";
    private static final String COMPONENT_ID = "22222222-2222-4222-8222-222222222222";
    private static final String BUILTIN_TEMPLATE_ID = "00000000-0000-4000-8000-000000000001";
    private static final Duration RUN_WAIT = Duration.ofSeconds(5);

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("cp.agent-url", () -> "http://localhost:" + wireMock.port() + "/internal/v1/agent/chat");
        registry.add("cp.agent-base-url", () -> "http://localhost:" + wireMock.port());
    }

    @Autowired private SseEmitterManager sseEmitterManager;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceUserRepository workspaceUserRepository;
    @Autowired private WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired private SessionRepository sessionRepository;
    @Autowired private ChatRunRepository chatRunRepository;
    @Autowired private JwtTokenProvider jwtTokenProvider;
    @Autowired private HealthMonitor healthMonitor;
    @Autowired private AgentPrincipalService agentPrincipalService;
    @Autowired private AgentTemplateService agentTemplateService;
    @Autowired private BranchPathService branchPathService;

    private String token;
    private String userId;
    private String workspaceId;
    private String principalId;
    private com.fasterxml.jackson.databind.JsonNode principalPermissions;
    private org.springframework.web.client.RestTemplate patchClient;

    @BeforeEach
    void setUp() {
        super.setUp();
        // The shared RestTemplate (JDK HttpURLConnection) cannot emit PATCH;
        // mirror ExecutionModeAuthorityTest's JDK request-factory client.
        patchClient = new org.springframework.web.client.RestTemplate(
                new org.springframework.http.client.JdkClientHttpRequestFactory());
        patchClient.setErrorHandler(new org.springframework.web.client.DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(org.springframework.http.HttpStatusCode statusCode) {
                return statusCode.is5xxServerError();
            }
        });
        wireMock.resetAll();
        wireMock.stubFor(get(urlEqualTo("/internal/v1/agent/health"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"status\":\"ok\",\"liveness\":\"up\",\"llmReady\":\"ready\",\"configRevision\":\"test-revision\"}")));
        healthMonitor.pollHealth();
        token = registerAndLogin();

        userId = jwtTokenProvider.getUserIdFromToken(token);
        Workspace ws = new Workspace("Context Template Test", userId);
        ws = workspaceRepository.save(ws);
        workspaceId = ws.getId().toString();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));
        token = jwtTokenProvider.createAccessToken(userId, jwtTokenProvider.getEmailFromToken(token), "USER", workspaceId);

        var defaultTemplate = agentTemplateService.resolveForCreation(userId, workspaceId, null);
        AgentPrincipal principal = agentPrincipalService.createPrincipal(
                userId, "Context template test principal", null, defaultTemplate.snapshot());
        principalId = principal.getId().toString();
        principalPermissions = principal.getTemplateSnapshot().get("permissions");
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(
                principalId, workspaceId, principalPermissions.deepCopy()));

        when(sseEmitterManager.hasEmitter(anyString())).thenReturn(true);
    }

    // ---- T1.2 / V1: explicit-layer config contract ----

    @Test
    void contextTemplatesRejectReadWithoutExplicitLayer() {
        ResponseEntity<Map> response = restTemplate.exchange(
                url("/api/v1/config/context-templates"), HttpMethod.GET,
                new HttpEntity<>(bearerJson(token)), Map.class);
        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
    }

    @Test
    void instanceLayerIsNotReadableByRegularUser() {
        ResponseEntity<Map> response = restTemplate.exchange(
                url("/api/v1/config/context-templates?layer=instance"), HttpMethod.GET,
                new HttpEntity<>(bearerJson(token)), Map.class);
        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode());
    }

    @Test
    void userLayerStartsWithEmptyTemplateSet() {
        ResponseEntity<Map> response = restTemplate.exchange(
                url("/api/v1/config/context-templates?layer=user"), HttpMethod.GET,
                new HttpEntity<>(bearerJson(token)), Map.class);
        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("[]", response.getBody().get("templates"));
    }

    @Test
    void contextTemplateRevisionsAreAppendOnly() {
        String v1 = "[" + fragment(1, "用户模板 v1") + "]";
        String modifiedV1 = "[" + fragment(1, "被篡改的 v1") + "]";
        String v1AndV2 = "[" + fragment(1, "用户模板 v1") + "," + fragment(2, "用户模板 v2") + "]";
        String v2Only = "[" + fragment(2, "用户模板 v2") + "]";

        assertEquals(HttpStatus.OK, putUserTemplates(v1).getStatusCode());

        ResponseEntity<Map> mutated = putUserTemplates(modifiedV1);
        assertEquals(HttpStatus.CONFLICT, mutated.getStatusCode());
        assertEquals("CONTEXT_TEMPLATE_REVISION_IMMUTABLE", mutated.getBody().get("code"));

        assertEquals(HttpStatus.OK, putUserTemplates(v1AndV2).getStatusCode());

        ResponseEntity<Map> dropped = putUserTemplates(v2Only);
        assertEquals(HttpStatus.CONFLICT, dropped.getStatusCode());
        assertEquals("CONTEXT_TEMPLATE_REVISION_IMMUTABLE", dropped.getBody().get("code"));
    }

    @Test
    void componentMarkerMustReferenceKnownInstance() {
        String broken = "[{\"id\":\"" + TEMPLATE_ID + "\",\"version\":1,\"name\":\"broken\","
                + "\"description\":\"d\",\"document\":\"{{component:33333333-3333-4333-8333-333333333333}}\","
                + "\"components\":[{\"instanceId\":\"" + COMPONENT_ID + "\",\"type\":\"text\","
                + "\"enabled\":true,\"config\":{\"text\":\"hi\"}}]}]";
        ResponseEntity<Map> response = putUserTemplates(broken);
        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
    }

    @Test
    void workspaceLayerCannotDefineDefaults() {
        String payload = "{\"templates\":[" + fragment(1, "workspace invalid") + "],"
                + "\"defaultTemplate\":{\"layer\":\"workspace\",\"templateId\":\""
                + TEMPLATE_ID + "\",\"version\":1}}";
        ResponseEntity<Map> response = restTemplate.exchange(
                url("/api/v1/config/workspace/context-templates?workspaceId=" + workspaceId),
                HttpMethod.PUT, new HttpEntity<>(payload, bearerJson(token)), Map.class);
        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
    }

    // ---- T1.3 / V3: explicit Session binding ----

    @Test
    void defaultResolutionPrefersProviderModelThenUserDefaultThenBuiltinAndNeverDriftsExistingSessions() {
        // userDefault + provider/model default both point at user template v1.
        assertEquals(HttpStatus.OK, putUserTemplatesWithDefaults(
                "[" + fragment(1, "用户模板 v1") + "]",
                "{\"layer\":\"user\",\"templateId\":\"" + TEMPLATE_ID + "\",\"version\":1}",
                "[{\"provider\":\"deepseek\",\"model\":\"deepseek-chat\",\"templateId\":\""
                        + TEMPLATE_ID + "\",\"version\":1}]").getStatusCode());

        // 1) provider/model match wins over the user default.
        Map<String, Object> matched = createSession("Provider match",
                "deepseek", "deepseek-chat");
        assertEquals("user", matched.get("contextTemplateLayer"));
        assertEquals(TEMPLATE_ID, String.valueOf(matched.get("contextTemplateId")));

        // 2) no provider match -> user default.
        Map<String, Object> userDefault = createSession("User default", "openai", "gpt-4o");
        assertEquals("user", userDefault.get("contextTemplateLayer"));
        assertEquals(TEMPLATE_ID, String.valueOf(userDefault.get("contextTemplateId")));

        // 3) remove defaults -> built-in instance template.
        assertEquals(HttpStatus.OK, putUserTemplatesWithDefaults(
                "[" + fragment(1, "用户模板 v1") + "]", null, null).getStatusCode());
        Map<String, Object> builtin = createSession("Builtin default", null, null);
        assertEquals("instance", builtin.get("contextTemplateLayer"));
        assertEquals(BUILTIN_TEMPLATE_ID, String.valueOf(builtin.get("contextTemplateId")));

        // 4) an already-created Session never drifts when defaults change afterwards.
        String pinnedSessionId = (String) builtin.get("id");
        assertEquals(HttpStatus.OK, putUserTemplatesWithDefaults(
                "[" + fragment(1, "用户模板 v1") + "]",
                "{\"layer\":\"user\",\"templateId\":\"" + TEMPLATE_ID + "\",\"version\":1}",
                null).getStatusCode());
        ResponseEntity<Map> reread = restTemplate.exchange(
                url("/api/v1/sessions/" + pinnedSessionId), HttpMethod.GET,
                new HttpEntity<>(bearerJson(token)), Map.class);
        assertEquals(HttpStatus.OK, reread.getStatusCode());
        assertEquals("instance", reread.getBody().get("contextTemplateLayer"));
        assertEquals(BUILTIN_TEMPLATE_ID, String.valueOf(reread.getBody().get("contextTemplateId")));
    }

    @Test
    void sessionCreationPinsBuiltinDefaultAndExplicitRebindIsVisible() {
        Map<String, Object> created = createSession("Binding test");
        assertEquals("instance", created.get("contextTemplateLayer"));
        assertEquals(BUILTIN_TEMPLATE_ID, String.valueOf(created.get("contextTemplateId")));
        assertEquals(1, created.get("contextTemplateVersion"));

        assertEquals(HttpStatus.OK, putUserTemplates("[" + fragment(1, "用户模板 v1") + "]").getStatusCode());

        String sessionId = (String) created.get("id");
        ResponseEntity<Map> rebound = patchClient.exchange(
                url("/api/v1/sessions/" + sessionId + "/context-template"),
                HttpMethod.PATCH,
                new HttpEntity<>(Map.of("layer", "user", "templateId", TEMPLATE_ID, "version", 1),
                        bearerJson(token)),
                Map.class);
        assertEquals(HttpStatus.OK, rebound.getStatusCode());
        assertEquals("user", rebound.getBody().get("contextTemplateLayer"));
        assertEquals(TEMPLATE_ID, String.valueOf(rebound.getBody().get("contextTemplateId")));
        assertEquals(1, rebound.getBody().get("contextTemplateVersion"));

        Session persisted = sessionRepository.findById(UUID.fromString(sessionId)).orElseThrow();
        assertEquals("user", persisted.getContextTemplateLayer());
        assertEquals(UUID.fromString(TEMPLATE_ID), persisted.getContextTemplateId());

        // A model/Agent-facing rename must not disturb the pinned binding.
        ResponseEntity<Map> renamed = patchClient.exchange(
                url("/api/v1/sessions/" + sessionId), HttpMethod.PATCH,
                new HttpEntity<>(Map.of("title", "Renamed"), bearerJson(token)), Map.class);
        assertEquals(HttpStatus.OK, renamed.getStatusCode());
        assertEquals("user", renamed.getBody().get("contextTemplateLayer"));
        assertEquals(TEMPLATE_ID, String.valueOf(renamed.getBody().get("contextTemplateId")));

        ResponseEntity<Map> missingRevision = patchClient.exchange(
                url("/api/v1/sessions/" + sessionId + "/context-template"),
                HttpMethod.PATCH,
                new HttpEntity<>(Map.of("layer", "user", "templateId", TEMPLATE_ID, "version", 99),
                        bearerJson(token)),
                Map.class);
        assertEquals(HttpStatus.NOT_FOUND, missingRevision.getStatusCode());
        assertEquals("CONTEXT_TEMPLATE_NOT_FOUND", missingRevision.getBody().get("code"));
    }

    // ---- T1.4 / V8: atomic admission snapshot ----

    @Test
    void chatRunSnapshotsBindingAndTemplateEditsNeverMutateIt() {
        String sessionId = UUID.randomUUID().toString();
        createAgentSession(sessionId, "Snapshot test");
        assertEquals(HttpStatus.OK,
                putUserTemplates("[" + fragment(1, "用户模板 v1") + "]").getStatusCode());

        ResponseEntity<Map> rebound = patchClient.exchange(
                url("/api/v1/sessions/" + sessionId + "/context-template"),
                HttpMethod.PATCH,
                new HttpEntity<>(Map.of("layer", "user", "templateId", TEMPLATE_ID, "version", 1),
                        bearerJson(token)),
                Map.class);
        assertEquals(HttpStatus.OK, rebound.getStatusCode());

        wireMock.stubFor(post(urlEqualTo("/internal/v1/agent/chat"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "text/event-stream")
                        .withBody("event: done\ndata: {\"content\":\"ok\"}\n\n")));

        Map<String, Object> body = Map.of(
                "sessionId", sessionId,
                "branchId", branchPathService.ensureRootBranchId(sessionId),
                "content", "snapshot please",
                "userId", userId,
                "workspaceId", workspaceId
        );
        ResponseEntity<Map> accepted = restTemplate.exchange(
                url("/api/v1/chat"), HttpMethod.POST, entityWithAuth(body, token), Map.class);
        assertEquals(HttpStatus.ACCEPTED, accepted.getStatusCode());

        ChatRun run = awaitPersistedSnapshot(sessionId);
        var snapshot = run.getContextTemplateSnapshot();
        assertEquals("user", snapshot.path("layer").asText());
        assertEquals(TEMPLATE_ID, snapshot.path("templateId").asText());
        assertEquals(1, snapshot.path("version").asInt());
        assertEquals("session-binding", snapshot.path("source").asText());
        assertEquals("用户模板 v1", snapshot.path("template").path("name").asText());
        String snapshotBeforeEdit = snapshot.toString();

        // Append v2 with different content: the admitted Run must not drift.
        assertEquals(HttpStatus.OK, putUserTemplates(
                "[" + fragment(1, "用户模板 v1") + "," + fragment(2, "用户模板 v2") + "]")
                .getStatusCode());
        ChatRun afterEdit = chatRunRepository.findById(run.getId()).orElseThrow();
        assertEquals(snapshotBeforeEdit, afterEdit.getContextTemplateSnapshot().toString());
        assertEquals("用户模板 v1",
                afterEdit.getContextTemplateSnapshot().path("template").path("name").asText());

        // Next Run after an explicit rebind follows the Session's CURRENT binding
        // (v2), while run1 above keeps its admission-time v1 snapshot.
        awaitRunTerminal(run.getId());
        ResponseEntity<Map> reboundV2 = patchClient.exchange(
                url("/api/v1/sessions/" + sessionId + "/context-template"),
                HttpMethod.PATCH,
                new HttpEntity<>(Map.of("layer", "user", "templateId", TEMPLATE_ID, "version", 2),
                        bearerJson(token)),
                Map.class);
        assertEquals(HttpStatus.OK, reboundV2.getStatusCode());
        wireMock.resetAll();
        wireMock.stubFor(post(urlEqualTo("/internal/v1/agent/chat"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "text/event-stream")
                        .withBody("event: done\ndata: {\"content\":\"again\"}\n\n")));
        Map<String, Object> second = Map.of(
                "sessionId", sessionId,
                "branchId", branchPathService.ensureRootBranchId(sessionId),
                "content", "second run",
                "userId", userId,
                "workspaceId", workspaceId
        );
        ResponseEntity<Map> acceptedSecond = restTemplate.exchange(
                url("/api/v1/chat"), HttpMethod.POST, entityWithAuth(second, token), Map.class);
        assertEquals(HttpStatus.ACCEPTED, acceptedSecond.getStatusCode());
        ChatRun secondRun = awaitPersistedSnapshotV2(sessionId, run.getId());
        assertEquals(2, secondRun.getContextTemplateSnapshot().path("version").asInt());
        assertEquals("用户模板 v2",
                secondRun.getContextTemplateSnapshot().path("template").path("name").asText());
        ChatRun firstRunAfterSecond = chatRunRepository.findById(run.getId()).orElseThrow();
        assertEquals(snapshotBeforeEdit, firstRunAfterSecond.getContextTemplateSnapshot().toString());
    }

    // ---- helpers ----

    private ChatRun awaitPersistedSnapshot(String sessionId) {
        return awaitPersistedSnapshotAfter(sessionId, null, 1);
    }

    private void awaitRunTerminal(UUID runId) {
        Instant deadline = Instant.now().plus(RUN_WAIT);
        while (Instant.now().isBefore(deadline)) {
            ChatRun run = chatRunRepository.findById(runId).orElseThrow();
            if (run.getTerminalAt() != null) {
                return;
            }
            try {
                Thread.sleep(100);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("Interrupted while waiting for ChatRun terminal state", e);
            }
        }
        throw new AssertionError("ChatRun " + runId + " did not reach a terminal state within " + RUN_WAIT);
    }

    private ChatRun awaitPersistedSnapshotV2(String sessionId, UUID excludeRunId) {
        return awaitPersistedSnapshotAfter(sessionId, excludeRunId, 2);
    }

    private ChatRun awaitPersistedSnapshotAfter(String sessionId, UUID excludeRunId, int version) {
        Instant deadline = Instant.now().plus(RUN_WAIT);
        while (Instant.now().isBefore(deadline)) {
            var run = chatRunRepository.findFirstBySessionIdOrderByCreatedAtDescIdDesc(sessionId);
            if (run.isPresent()
                    && !run.get().getContextTemplateSnapshot().isEmpty()
                    && (excludeRunId == null || !run.get().getId().equals(excludeRunId))
                    && run.get().getContextTemplateSnapshot().path("version").asInt() == version) {
                return run.get();
            }
            try {
                Thread.sleep(100);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("Interrupted while waiting for ChatRun snapshot", e);
            }
        }
        throw new AssertionError("ChatRun with Context Template snapshot v" + version
                + " was not persisted within " + RUN_WAIT);
    }

    private ResponseEntity<Map> putUserTemplates(String templatesJson) {
        return restTemplate.exchange(
                url("/api/v1/config/user/context-templates"),
                HttpMethod.PUT, new HttpEntity<>(Map.of("templates", templatesJson), bearerJson(token)),
                Map.class);
    }

    private Map<String, Object> createSession(String title) {
        return createSession(title, null, null);
    }

    private Map<String, Object> createSession(String title, String provider, String model) {
        Map<String, Object> body = new java.util.HashMap<>();
        body.put("title", title);
        body.put("agentPrincipalId", principalId);
        if (provider != null) body.put("modelProvider", provider);
        if (model != null) body.put("modelName", model);
        ResponseEntity<Map> response = restTemplate.exchange(
                url("/api/v1/sessions"), HttpMethod.POST,
                new HttpEntity<>(body, bearerJson(token)),
                Map.class);
        assertEquals(HttpStatus.CREATED, response.getStatusCode());
        return response.getBody();
    }

    private ResponseEntity<Map> putUserTemplatesWithDefaults(
            String templatesJson, String userDefaultJson, String providerDefaultsJson) {
        Map<String, String> body = new java.util.HashMap<>();
        body.put("templates", templatesJson);
        if (userDefaultJson != null) body.put("userDefault", userDefaultJson);
        if (providerDefaultsJson != null) body.put("providerModelDefaults", providerDefaultsJson);
        return restTemplate.exchange(
                url("/api/v1/config/user/context-templates"),
                HttpMethod.PUT, new HttpEntity<>(body, bearerJson(token)), Map.class);
    }

    private void createAgentSession(String sessionId, String title) {
        Session session = new Session(workspaceId, userId, title);
        session.setId(UUID.fromString(sessionId));
        session.setAgentPrincipalId(principalId);
        session.setAgentPermissionsSnapshot(principalPermissions.deepCopy());
        sessionRepository.saveAndFlush(session);
    }

    private static String fragment(int version, String name) {
        return "{\"id\":\"" + TEMPLATE_ID + "\",\"version\":" + version + ",\"name\":\"" + name + "\","
                + "\"description\":\"d\",\"document\":\"{{component:" + COMPONENT_ID + "}}\","
                + "\"components\":[{\"instanceId\":\"" + COMPONENT_ID + "\",\"type\":\"text\","
                + "\"enabled\":true,\"config\":{\"text\":\"hello\"}}]}";
    }

    private static HttpHeaders bearerJson(String bearer) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(bearer);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return headers;
    }

    @TestConfiguration
    static class TestMockConfig {
        @Bean
        @Primary
        SseEmitterManager testSseEmitterManager() {
            return Mockito.mock(SseEmitterManager.class);
        }
    }
}
