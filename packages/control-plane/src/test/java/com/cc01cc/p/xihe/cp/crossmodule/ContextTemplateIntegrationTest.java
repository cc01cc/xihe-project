package com.cc01cc.p.xihe.cp.crossmodule;

import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.equalTo;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.matchingJsonPath;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.chat.ChatBindingTestSupport;
import com.cc01cc.p.xihe.cp.chat.SseEmitterManager;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.ConfigEntity;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer;
import com.cc01cc.p.xihe.cp.policy.SystemAccessRoleCatalog;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;
import com.cc01cc.p.xihe.cp.service.InstanceIdentityService;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.cc01cc.p.xihe.cp.service.AgentTemplateService;
import com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService;
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
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0439/0485: the api-request-templates layer contract, explicit Session
 * binding (Model override → Connection default → built-in Type pin) and the
 * atomic ChatRun snapshot isolation guarantee.
 */
class ContextTemplateIntegrationTest extends AbstractWireMockTest {

    private static final String TEMPLATE_ID = "11111111-1111-4111-8111-111111111111";
    private static final String COMPONENT_ID = "22222222-2222-4222-8222-222222222222";
    private static final String CHAT_TYPE_ID = "openai-chat-completions";
    private static final int CHAT_TYPE_VERSION = 1;
    private static final Duration RUN_WAIT = Duration.ofSeconds(5);

    /**
     * A published revision must pass the chat Type validator; this is the
     * built-in openai-chat-completions body shape.
     */
    private static final String VALID_BODY_SOURCE = "{\"model\":\"${xh.model}\","
            + "\"messages\":[{\"role\":\"system\",\"content\":\"${xh.agent_instructions}\"},"
            + "\"${xh.conversation_history}\",{\"role\":\"user\",\"content\":\"${xh.user_input}\"}],"
            + "\"tools\":[\"${xh.tools}\"],\"stream\":true}";

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("cp.agent-url", () -> "http://localhost:" + wireMock.port() + "/internal/v1/agent/chat");
        registry.add("cp.agent-base-url", () -> "http://localhost:" + wireMock.port());
    }

    @Autowired private SseEmitterManager sseEmitterManager;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired private SessionRepository sessionRepository;
    @Autowired private ChatRunRepository chatRunRepository;
    @Autowired private ProviderConnectionRepository providerConnectionRepository;
    @Autowired private ConfigJpaRepository configs;
    @Autowired private ApiRequestTemplateService apiRequestTemplates;
    @Autowired private JwtTokenProvider jwtTokenProvider;
    @Autowired private HealthMonitor healthMonitor;
    @Autowired private AgentPrincipalService agentPrincipalService;
    @Autowired private AgentTemplateService agentTemplateService;
    @Autowired private BranchPathService branchPathService;
    @Autowired private InstanceIdentityService instanceIdentity;
    @Autowired private AuthzContext authzContext;
    @Autowired private AccessRoleRepository roleRepository;
    @Autowired private AccessRoleBindingRepository bindingRepository;
    @Autowired private RoleGrantMaterializer roleGrantMaterializer;

    private String token;
    private String userId;
    private String workspaceId;
    private String principalId;
    private String principalInstructions;
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
        Workspace ws = TestDataFactory.directAttachWorkspace("Context Template Test");
        ws = workspaceRepository.save(ws);
        workspaceId = ws.getId().toString();
        workspaceFixture.bindWorkspaceRole(workspaceId, userId, WorkspaceRole.OWNER);
        token = jwtTokenProvider.createAccessToken(userId, jwtTokenProvider.getEmailFromToken(token), "USER", workspaceId, 0);

        var defaultTemplate = agentTemplateService.resolveForCreation(userId, workspaceId, null);
        AgentPrincipal principal = agentPrincipalService.createPrincipal(
                userId, "ContextTemplateTestPrincipal", null, defaultTemplate.snapshot());
        principalId = principal.getId().toString();
        principalInstructions = principal.getTemplateSnapshot().path("systemPrompt").asText();
        principalPermissions = principal.getTemplateSnapshot().get("permissions");
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(
                principalId, workspaceId, principalPermissions.deepCopy()));

        when(sseEmitterManager.hasEmitter(anyString())).thenReturn(true);
    }

    // ---- T1.2 / V1: explicit-layer config contract (api-request-templates) ----

    @Test
    void contextTemplatesRejectReadWithoutExplicitLayer() {
        ResponseEntity<Map> response = restTemplate.exchange(
                url("/api/v1/config/api-request-templates"), HttpMethod.GET,
                new HttpEntity<>(bearerJson(token)), Map.class);
        // The superseding domain must be read from one explicit layer; the
        // projected (layer-less) read is rejected by the domain guard.
        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode());
        assertEquals("FORBIDDEN", response.getBody().get("code"));
    }

    @Test
    void instanceLayerIsReadOnlyForRegularUser() {
        // Published instance templates and built-ins stay visible to the user...
        ResponseEntity<Map> read = restTemplate.exchange(
                url("/api/v1/config/api-request-templates?layer=instance"), HttpMethod.GET,
                new HttpEntity<>(bearerJson(token)), Map.class);
        assertEquals(HttpStatus.OK, read.getStatusCode());
        assertTrue(String.valueOf(read.getBody().get("templates")).contains(CHAT_TYPE_ID),
                String.valueOf(read.getBody().get("templates")));

        // ...but instance mutations remain admin-only.
        ResponseEntity<Map> write = restTemplate.exchange(
                url("/api/v1/config/instance/api-request-templates"), HttpMethod.PUT,
                new HttpEntity<>(Map.of("templates", "[]"), bearerJson(token)), Map.class);
        assertEquals(HttpStatus.FORBIDDEN, write.getStatusCode());
    }

    @Test
    void userLayerStartsWithEmptyTemplateSet() {
        ResponseEntity<Map> response = restTemplate.exchange(
                url("/api/v1/config/api-request-templates?layer=user"), HttpMethod.GET,
                new HttpEntity<>(bearerJson(token)), Map.class);
        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("[]", response.getBody().get("templates"));
    }

    @Test
    void contextTemplateRevisionsAreAppendOnly() {
        String v1 = "[" + publishedFragment(1, "用户模板 v1") + "]";
        String modifiedV1 = "[" + publishedFragment(1, "被篡改的 v1") + "]";
        String v1AndV2 = "[" + publishedFragment(1, "用户模板 v1") + "," + publishedFragment(2, "用户模板 v2") + "]";
        String v2Only = "[" + publishedFragment(2, "用户模板 v2") + "]";

        assertEquals(HttpStatus.OK, putUserTemplates(v1).getStatusCode());

        ResponseEntity<Map> mutated = putUserTemplates(modifiedV1);
        assertEquals(HttpStatus.CONFLICT, mutated.getStatusCode());
        assertEquals("API_REQUEST_TEMPLATE_REVISION_IMMUTABLE", mutated.getBody().get("code"));

        assertEquals(HttpStatus.OK, putUserTemplates(v1AndV2).getStatusCode());

        ResponseEntity<Map> dropped = putUserTemplates(v2Only);
        assertEquals(HttpStatus.CONFLICT, dropped.getStatusCode());
        assertEquals("API_REQUEST_TEMPLATE_REVISION_IMMUTABLE", dropped.getBody().get("code"));
    }

    @Test
    void componentMarkersAreOpaqueAndBodySourceGatesPublication() {
        // The retired context-templates domain rejected docs whose
        // {{component:<id>}} marker had no matching instance. The frozen
        // api-request-templates contract validates the chat bodySource instead
        // and carries component metadata opaquely, so an unknown marker is
        // accepted while an invalid published bodySource is rejected.
        var markerTemplate = objectMapper.createObjectNode();
        markerTemplate.put("id", TEMPLATE_ID).put("version", 1).put("name", "broken marker")
                .put("description", "d").put("apiTypeId", CHAT_TYPE_ID).put("apiTypeVersion", CHAT_TYPE_VERSION)
                .put("bodySource", VALID_BODY_SOURCE).put("status", "published")
                .put("document", "{{component:33333333-3333-4333-8333-333333333333}}");
        markerTemplate.putArray("components").addObject().put("instanceId", COMPONENT_ID)
                .put("type", "text").put("enabled", true);
        assertEquals(HttpStatus.OK, putUserTemplates("[" + markerTemplate + "]").getStatusCode());

        String invalidBody = objectMapper.createObjectNode()
                .put("id", "33333333-3333-4333-8333-333333333333").put("version", 1).put("name", "invalid body")
                .put("description", "d").put("apiTypeId", CHAT_TYPE_ID).put("apiTypeVersion", CHAT_TYPE_VERSION)
                .put("bodySource", "{}").put("status", "published").toString();
        assertEquals(HttpStatus.BAD_REQUEST, putUserTemplates("[" + invalidBody + "]").getStatusCode());
    }

    @Test
    void foreignLayerCannotBindAnotherOwnersConnectionModels() {
        var connection = ChatBindingTestSupport.ensureChatConnection(
                providerConnectionRepository, "USER", userId, "ctx-workspace");
        String overrides = "{\"" + connection.getId() + "\":{\"wire-model\":{\"layer\":\"user\","
                + "\"templateId\":\"" + TEMPLATE_ID + "\",\"version\":1}}}";
        ResponseEntity<Map> response = restTemplate.exchange(
                url("/api/v1/config/workspace/api-request-templates?workspaceId=" + workspaceId),
                HttpMethod.PUT, new HttpEntity<>(Map.of("providerModelBindings", overrides), bearerJson(token)),
                Map.class);
        // task-343 / D-1140: a model override may live in the consumer's own user row or in the
        // Connection owner's layer. A USER-owned Connection is out of scope for the workspace
        // layer, so the widening does not turn into "any layer may bind any Connection": from
        // this layer the row does not exist, which is a 404 rather than a 400 (the old
        // "user-scope only" blanket rejection).
        assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode(), String.valueOf(response.getBody()));
        assertEquals("PROVIDER_CONNECTION_NOT_FOUND", response.getBody().get("code"));

        // 判据③: the widening is not "stop validating" — an id that exists nowhere still fails
        // closed on the same code, even for an instance admin.
        grantInstanceAdmin(UUID.fromString(userId));
        String unknown = UUID.randomUUID().toString();
        ResponseEntity<Map> bogus = restTemplate.exchange(
                url("/api/v1/config/instance/api-request-templates"), HttpMethod.PUT,
                new HttpEntity<>(Map.of("providerModelBindings",
                        "{\"" + unknown + "\":{\"x\":{\"layer\":\"instance\",\"templateId\":\""
                                + TEMPLATE_ID + "\",\"version\":1}}}"), bearerJson(token)),
                Map.class);
        assertEquals(HttpStatus.NOT_FOUND, bogus.getStatusCode(), String.valueOf(bogus.getBody()));
        assertEquals("PROVIDER_CONNECTION_NOT_FOUND", bogus.getBody().get("code"));
    }

    // ---- task-343 / D-1140: instance layer owns model overrides for its own Connections ----

    @Test
    void instanceLayerBindsItsOwnConnectionModelsAndAPlainUserResolvesThem() {
        UUID actor = UUID.fromString(userId);
        grantInstanceAdmin(actor);
        var connection = instanceChatConnection("ctx-instance");
        String connectionId = connection.getId().toString();
        // two bindings on the instance layer: one resolved only here, one also bound in the
        // caller's own user row (the precedence case below)
        String overrides = "{\"" + connectionId + "\":{"
                + "\"instance-model\":{\"layer\":\"instance\",\"templateId\":\"" + TEMPLATE_ID
                + "\",\"version\":1},"
                + "\"precedence-model\":{\"layer\":\"instance\",\"templateId\":\"" + TEMPLATE_ID
                + "\",\"version\":1}}}";

        // write half: the instance layer now accepts a model override for an INSTANCE Connection
        ResponseEntity<Map> written = restTemplate.exchange(
                url("/api/v1/config/instance/api-request-templates"), HttpMethod.PUT,
                new HttpEntity<>(Map.of(
                        "templates", "[" + publishedFragment(1, "实例模板 v1") + "]",
                        "providerModelBindings", overrides), bearerJson(token)),
                Map.class);
        assertEquals(HttpStatus.OK, written.getStatusCode(), String.valueOf(written.getBody()));

        // round-trip: the row really landed at the instance layer
        ResponseEntity<Map> read = restTemplate.exchange(
                url("/api/v1/config/api-request-templates?layer=instance"), HttpMethod.GET,
                new HttpEntity<>(bearerJson(token)), Map.class);
        assertEquals(HttpStatus.OK, read.getStatusCode());
        assertTrue(String.valueOf(read.getBody().get("providerModelBindings")).contains(connectionId),
                String.valueOf(read.getBody().get("providerModelBindings")));

        // read half (D-1140 后半句的最小可测形态): a plain non-admin user resolving through this
        // INSTANCE Connection gets the instance-layer override instead of falling through to the
        // built-in template.
        var snapshot = apiRequestTemplates.resolve(connection, "instance-model", actor,
                UUID.fromString(workspaceId), null);
        assertEquals("provider-model", snapshot.path("source").asText());
        assertEquals("instance", snapshot.path("layer").asText());
        assertEquals(TEMPLATE_ID, snapshot.path("template").path("id").asText());
        assertEquals(1, snapshot.path("template").path("version").asInt());

        // Precedence (card 判据②): the caller's OWN user row wins over the Connection owner
        // layer, which is exactly the order resolve() already had - step 2 (user row) runs
        // before the owner-layer fallback this card adds. Pinned with two different template
        // ids so the assertion cannot pass by accident.
        UUID userTemplateId = UUID.randomUUID();
        ResponseEntity<Map> userWritten = putUserTemplateConfig(Map.of(
                "templates", "[" + publishedFragment(userTemplateId.toString(), 1, "用户模板 v1") + "]",
                "providerModelBindings", "{\"" + connectionId + "\":{\"precedence-model\":{"
                        + "\"layer\":\"user\",\"templateId\":\"" + userTemplateId + "\",\"version\":1}}}"));
        assertEquals(HttpStatus.OK, userWritten.getStatusCode(), String.valueOf(userWritten.getBody()));
        var withUserRow = apiRequestTemplates.resolve(connection, "precedence-model", actor,
                UUID.fromString(workspaceId), null);
        assertEquals("user", withUserRow.path("layer").asText(), String.valueOf(withUserRow));
        assertEquals(userTemplateId.toString(), withUserRow.path("template").path("id").asText());
    }

    @Test
    void instanceLayerCannotBindAUserOwnedConnectionModels() {
        grantInstanceAdmin(UUID.fromString(userId));
        var userOwned = ChatBindingTestSupport.ensureChatConnection(
                providerConnectionRepository, "USER", userId, "ctx-foreign");
        String overrides = "{\"" + userOwned.getId() + "\":{\"foreign-model\":{\"layer\":\"instance\","
                + "\"templateId\":\"" + TEMPLATE_ID + "\",\"version\":1}}}";
        ResponseEntity<Map> response = restTemplate.exchange(
                url("/api/v1/config/instance/api-request-templates"), HttpMethod.PUT,
                new HttpEntity<>(Map.of("providerModelBindings", overrides), bearerJson(token)),
                Map.class);
        // Widening the layer is not "the instance may bind anyone's Connection": an override
        // belongs to the Connection owner layer, so a USER-owned Connection is invisible here.
        assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode(), String.valueOf(response.getBody()));
        assertEquals("PROVIDER_CONNECTION_NOT_FOUND", response.getBody().get("code"));
    }

    @Test
    void refreshPolicyIsOpaqueAndBodySourceSlotsGatePublication() {
        // The retired domain whitelisted root_agents_md refreshPolicy scope
        // names at write time. The frozen contract instead validates the chat
        // bodySource variable slots at publication (spec §API Request Template
        // and Chat Admission).
        assertEquals(HttpStatus.OK, putUserTemplates("[" + publishedFragment(1, "valid slots") + "]")
                .getStatusCode());

        String forgedTools = objectMapper.createObjectNode()
                .put("id", "44444444-4444-4444-8444-444444444444").put("version", 1).put("name", "forged tools")
                .put("description", "d").put("apiTypeId", CHAT_TYPE_ID).put("apiTypeVersion", CHAT_TYPE_VERSION)
                .put("bodySource", "{\"model\":\"${xh.model}\",\"messages\":"
                        + "[{\"role\":\"user\",\"content\":\"${xh.user_input}\"}],"
                        + "\"tools\":[{\"name\":\"forged\"}]}")
                .put("status", "published").toString();
        assertEquals(HttpStatus.BAD_REQUEST, putUserTemplates("[" + forgedTools + "]").getStatusCode());
    }


    // ---- task-354: the connection OWNER layer row is a real binding scope since task-343 ----

    @Test
    void deletingAnInstanceConnectionCascadesItsInstanceLayerBindings() {
        grantInstanceAdmin(UUID.fromString(userId));
        var connection = instanceChatConnection("ctx-cascade-instance");
        String connectionId = connection.getId().toString();
        ResponseEntity<Map> written = restTemplate.exchange(
                url("/api/v1/config/instance/api-request-templates"), HttpMethod.PUT,
                new HttpEntity<>(Map.of(
                        "templates", "[" + publishedFragment(1, "实例模板 v1") + "]",
                        "providerModelBindings", "{\"" + connectionId + "\":{\"cascade-model\":{\"layer\":\"instance\",\"templateId\":\""
                                + TEMPLATE_ID + "\",\"version\":1}}}"),
                        bearerJson(token)),
                Map.class);
        assertEquals(HttpStatus.OK, written.getStatusCode(), String.valueOf(written.getBody()));

        // Preview BEFORE the delete: the owner-layer binding is counted (0 before task-354), but it is
        // not a user scope, so bindingUserScopes stays a user-row count.
        ResponseEntity<Map> impact = restTemplate.exchange(
                url("/api/v1/provider-connections/" + connectionId + "/delete-impact"), HttpMethod.GET,
                new HttpEntity<>(bearerJson(token)), Map.class);
        assertEquals(HttpStatus.OK, impact.getStatusCode(), String.valueOf(impact.getBody()));
        assertEquals(1, ((Number) impact.getBody().get("bindingCount")).intValue(), String.valueOf(impact.getBody()));
        assertEquals(0, ((Number) impact.getBody().get("bindingUserScopes")).intValue(),
                "owner-layer bindings are not user scopes");

        ResponseEntity<Map> deleted = restTemplate.exchange(
                url("/api/v1/provider-connections/" + connectionId), HttpMethod.DELETE,
                new HttpEntity<>(bearerJson(token)), Map.class);
        assertEquals(HttpStatus.NO_CONTENT, deleted.getStatusCode());

        ResponseEntity<Map> read = restTemplate.exchange(
                url("/api/v1/config/api-request-templates?layer=instance"), HttpMethod.GET,
                new HttpEntity<>(bearerJson(token)), Map.class);
        assertEquals(HttpStatus.OK, read.getStatusCode());
        assertFalse(String.valueOf(read.getBody().get("providerModelBindings")).contains(connectionId),
                "delete must not leave a dangling instance-layer binding: " + read.getBody().get("providerModelBindings"));
    }

    @Test
    void typeChangeImpactReportsInstanceLayerBindings() {
        grantInstanceAdmin(UUID.fromString(userId));
        var connection = instanceChatConnection("ctx-impact-instance");
        String connectionId = connection.getId().toString();
        assertEquals(HttpStatus.OK, restTemplate.exchange(
                url("/api/v1/config/instance/api-request-templates"), HttpMethod.PUT,
                new HttpEntity<>(Map.of(
                        "templates", "[" + publishedFragment(1, "实例模板 v1") + "]",
                        "providerModelBindings", "{\"" + connectionId + "\":{\"impact-model\":{\"layer\":\"instance\",\"templateId\":\""
                                + TEMPLATE_ID + "\",\"version\":1}}}"),
                        bearerJson(token)),
                Map.class).getStatusCode());
        // The HTTP door also runs catalog.supportedPair(provider, target) and the fixture provider
        // (custom-openai-compatible) supports exactly one chat type, so the scanning predicate is
        // exercised through the service; the HTTP shape stays covered by
        // ApiRequestTemplateHttpIntegrationTest.
        Map<String, Object> impact = apiRequestTemplates.impact(connection, "anthropic-messages", 1);
        Object raw = impact.get("incompatibleOverrides");
        assertTrue(raw instanceof java.util.List<?>, String.valueOf(raw));
        Map<?, ?> instanceBucket = ((java.util.List<?>) raw).stream()
                .map(bucket -> (Map<?, ?>) bucket)
                .filter(bucket -> "instance".equals(bucket.get("scope")))
                .findFirst().orElseThrow(() -> new AssertionError("no instance bucket: " + impact));
        assertEquals(1, ((Number) instanceBucket.get("count")).intValue(), String.valueOf(impact));
    }

    @Test
    void connectionDefaultChangePurgesIncompatibleInstanceLayerBindings() {
        grantInstanceAdmin(UUID.fromString(userId));
        var connection = instanceChatConnection("ctx-defaults-instance");
        String connectionId = connection.getId().toString();
        assertEquals(HttpStatus.OK, restTemplate.exchange(
                url("/api/v1/config/instance/api-request-templates"), HttpMethod.PUT,
                new HttpEntity<>(Map.of(
                        "templates", "[" + publishedFragment(1, "实例模板 v1") + "]",
                        "providerModelBindings", "{\"" + connectionId + "\":{\"purge-model\":{\"layer\":\"instance\",\"templateId\":\""
                                + TEMPLATE_ID + "\",\"version\":1}}}"),
                        bearerJson(token)),
                Map.class).getStatusCode());
        // Fixture: the Connection API Type changed (the PATCH/impact path has its own coverage);
        // under test here is that the purge walks the OWNER layer row, not only user rows.
        connection.setApiTypeId("anthropic-messages");
        connection.setApiTypeVersion(1);
        providerConnectionRepository.saveAndFlush(connection);
        assertEquals(1, apiRequestTemplates.changeConnectionDefault(connection, null));
        ResponseEntity<Map> read = restTemplate.exchange(
                url("/api/v1/config/api-request-templates?layer=instance"), HttpMethod.GET,
                new HttpEntity<>(bearerJson(token)), Map.class);
        assertEquals(HttpStatus.OK, read.getStatusCode());
        assertFalse(String.valueOf(read.getBody().get("providerModelBindings")).contains(connectionId),
                "type change must not leave an incompatible instance-layer binding: "
                        + read.getBody().get("providerModelBindings"));
    }


    // ---- task-344 / D-1213: the whole-key clear follows the KEY, not the domain ----

    @Test
    void instanceBindingKeyClearsWithAReceiptWhilePublishedTemplatesStillRefuse() {
        grantInstanceAdmin(UUID.fromString(userId));
        var connection = instanceChatConnection("ctx-clear-instance");
        String connectionId = connection.getId().toString();
        assertEquals(HttpStatus.OK, restTemplate.exchange(
                url("/api/v1/config/instance/api-request-templates"), HttpMethod.PUT,
                new HttpEntity<>(Map.of(
                        "templates", "[" + publishedFragment(1, "实例模板 v1") + "]",
                        "providerModelBindings", "{\"" + connectionId + "\":{\"clear-model\":{\"layer\":\"instance\",\"templateId\":\""
                                + TEMPLATE_ID + "\",\"version\":1}}}"),
                        bearerJson(token)),
                Map.class).getStatusCode());

        // positive half: a non-templates key really is clearable, and the receipt says how many
        // bindings went with it (the whole-row clear on a shared layer removes EVERY connection entry)
        ResponseEntity<Map> cleared = restTemplate.exchange(
                url("/api/v1/config/instance/api-request-templates/providerModelBindings"), HttpMethod.DELETE,
                new HttpEntity<>(bearerJson(token)), Map.class);
        assertEquals(HttpStatus.OK, cleared.getStatusCode(), String.valueOf(cleared.getBody()));
        assertEquals("ok", cleared.getBody().get("status"));
        Map<?, ?> receipt = (Map<?, ?>) cleared.getBody().get("cleared");
        assertEquals("providerModelBindings", receipt.get("key"));
        assertEquals(1, ((Number) receipt.get("entries")).intValue(), String.valueOf(cleared.getBody()));
        ResponseEntity<Map> after = restTemplate.exchange(
                url("/api/v1/config/api-request-templates?layer=instance"), HttpMethod.GET,
                new HttpEntity<>(bearerJson(token)), Map.class);
        assertEquals(HttpStatus.OK, after.getStatusCode());
        assertFalse(after.getBody().containsKey("providerModelBindings"), String.valueOf(after.getBody()));

        // idempotent by contract: clearing again answers 200 with an explicit zero, not 404
        ResponseEntity<Map> again = restTemplate.exchange(
                url("/api/v1/config/instance/api-request-templates/providerModelBindings"), HttpMethod.DELETE,
                new HttpEntity<>(bearerJson(token)), Map.class);
        assertEquals(HttpStatus.OK, again.getStatusCode(), String.valueOf(again.getBody()));
        assertEquals(0, ((Number) ((Map<?, ?>) again.getBody().get("cleared")).get("entries")).intValue());

        // negative half: the key that IS immutable still refuses, and the body says why
        ResponseEntity<Map> refused = restTemplate.exchange(
                url("/api/v1/config/instance/api-request-templates/templates"), HttpMethod.DELETE,
                new HttpEntity<>(bearerJson(token)), Map.class);
        assertEquals(HttpStatus.CONFLICT, refused.getStatusCode(), String.valueOf(refused.getBody()));
        assertEquals("API_REQUEST_TEMPLATE_REVISION_IMMUTABLE", refused.getBody().get("code"));
        assertTrue(String.valueOf(refused.getBody().get("detail")).contains("immutable"),
                String.valueOf(refused.getBody()));
    }

    /**
     * The task-332 residual row: {@code connectionDefaultTemplates = "{}"} at the instance layer, written
     * by the dedicated writer (it always upserts) and impossible to remove through any API before task-344.
     */
    @Test
    void emptyBindingRowOnTheInstanceLayerCanFinallyBeCleared() {
        grantInstanceAdmin(UUID.fromString(userId));
        // Reuse the instance row if an earlier test already wrote one: findExisting() looks the key up
        // by (layer, domain, key), so a second row with the same triple would make it ambiguous.
        ConfigEntity residual = configs.findByLayerAndDomain("instance", "api-request-templates").stream()
                .filter(row -> "connectionDefaultTemplates".equals(row.getConfigKey()))
                .findFirst().orElseGet(() -> {
                    ConfigEntity created = new ConfigEntity();
                    created.setLayer("instance");
                    created.setDomain("api-request-templates");
                    created.setConfigKey("connectionDefaultTemplates");
                    return created;
                });
        residual.setConfigValue("{}");
        residual.setUpdatedBy("test");
        configs.saveAndFlush(residual);

        ResponseEntity<Map> cleared = restTemplate.exchange(
                url("/api/v1/config/instance/api-request-templates/connectionDefaultTemplates"),
                HttpMethod.DELETE, new HttpEntity<>(bearerJson(token)), Map.class);
        assertEquals(HttpStatus.OK, cleared.getStatusCode(), String.valueOf(cleared.getBody()));
        assertEquals(0, ((Number) ((Map<?, ?>) cleared.getBody().get("cleared")).get("entries")).intValue());

        ResponseEntity<Map> after = restTemplate.exchange(
                url("/api/v1/config/api-request-templates?layer=instance"), HttpMethod.GET,
                new HttpEntity<>(bearerJson(token)), Map.class);
        assertEquals(HttpStatus.OK, after.getStatusCode());
        assertFalse(after.getBody().containsKey("connectionDefaultTemplates"), String.valueOf(after.getBody()));
    }

    /**
     * task-183 keeps the domain gate BEFORE the key judgment at the workspace-default layer: that layer
     * cannot serve this domain at all, so there is no row here to clear and the answer stays 400.
     * Recorded as-is on purpose — reordering the two guards would be a separate ruling.
     */
    @Test
    void workspaceDefaultLayerStillRefusesTheTemplateDomainBeforeTheKeyJudgment() {
        grantInstanceAdmin(UUID.fromString(userId));
        ResponseEntity<Map> refused = restTemplate.exchange(
                url("/api/v1/config/workspace-default/api-request-templates/providerModelBindings"),
                HttpMethod.DELETE, new HttpEntity<>(bearerJson(token)), Map.class);
        assertEquals(HttpStatus.BAD_REQUEST, refused.getStatusCode(), String.valueOf(refused.getBody()));
        assertEquals("DOMAIN_NOT_WORKSPACE_WRITABLE", refused.getBody().get("code"));
    }

    // ---- T1.3 / V3: explicit Session binding ----

    @Test
    void defaultResolutionPrefersModelOverrideThenConnectionDefaultThenBuiltinAndNeverDriftsExistingSessions() {
        var connection = ChatBindingTestSupport.ensureChatConnection(
                providerConnectionRepository, "USER", userId, "ctx-defaults");
        String connectionId = connection.getId().toString();

        // Model override + user default both point at user template v1.
        assertEquals(HttpStatus.OK, putUserTemplateConfig(Map.of(
                "templates", "[" + publishedFragment(1, "用户模板 v1") + "]",
                "providerModelBindings", "{\"" + connectionId + "\":{\"override-model\":{\"layer\":\"user\","
                        + "\"templateId\":\"" + TEMPLATE_ID + "\",\"version\":1}}}")).getStatusCode());

        // 1) Model override wins over the Connection default.
        Map<String, Object> matched = createSession("Model override", "custom-openai-compatible", "override-model");
        assertEquals("user", matched.get("contextTemplateLayer"));
        assertEquals(TEMPLATE_ID, String.valueOf(matched.get("contextTemplateId")));

        // 2) no model override -> Connection default.
        assertEquals(HttpStatus.OK, putUserTemplateConfig(Map.of(
                "providerModelBindings", "{}",
                "connectionDefaultTemplates", "{\"" + connectionId + "\":{\"layer\":\"user\","
                        + "\"templateId\":\"" + TEMPLATE_ID + "\",\"version\":1}}}")).getStatusCode());
        Map<String, Object> connectionDefault = createSession(
                "Connection default", "custom-openai-compatible", "default-model");
        assertEquals("user", connectionDefault.get("contextTemplateLayer"));
        assertEquals(TEMPLATE_ID, String.valueOf(connectionDefault.get("contextTemplateId")));

        // 3) remove defaults -> built-in Type template pin.
        assertEquals(HttpStatus.OK, putUserTemplateConfig(Map.of("connectionDefaultTemplates", "{}"))
                .getStatusCode());
        String builtinTemplateId = apiRequestTemplates
                .builtinRef(CHAT_TYPE_ID, CHAT_TYPE_VERSION).path("templateId").asText();
        Map<String, Object> builtin = createSession("Builtin default", "custom-openai-compatible", "builtin-model");
        assertEquals("instance", builtin.get("contextTemplateLayer"));
        assertEquals(builtinTemplateId, String.valueOf(builtin.get("contextTemplateId")));
        // PLAN-0632 Gate G-0: a newly created Session pins the CURRENT built-in revision (v2, the one
        // carrying ${xh.skill_catalog}/${xh.agent_memory}), not the frozen pre-G-0 revision.
        assertEquals(2, builtin.get("contextTemplateVersion"));

        // 4) an already-created Session never drifts when defaults change afterwards.
        String pinnedSessionId = (String) builtin.get("id");
        assertEquals(HttpStatus.OK, putUserTemplateConfig(Map.of(
                "connectionDefaultTemplates", "{\"" + connectionId + "\":{\"layer\":\"user\","
                        + "\"templateId\":\"" + TEMPLATE_ID + "\",\"version\":1}}}")).getStatusCode());
        ResponseEntity<Map> reread = restTemplate.exchange(
                url("/api/v1/sessions/" + pinnedSessionId), HttpMethod.GET,
                new HttpEntity<>(bearerJson(token)), Map.class);
        assertEquals(HttpStatus.OK, reread.getStatusCode());
        assertEquals("instance", reread.getBody().get("contextTemplateLayer"));
        assertEquals(builtinTemplateId, String.valueOf(reread.getBody().get("contextTemplateId")));

        // 5) PLAN-0632 Gate G-0, the other direction: revision 1 stays a published, resolvable
        // revision. An explicit v1 pin (an already-pinned Session, or a connection that chose it)
        // must still resolve — upgrading never rewrites a published revision in place.
        assertEquals(HttpStatus.OK, putUserTemplateConfig(Map.of(
                "connectionDefaultTemplates", "{\"" + connectionId + "\":{\"layer\":\"instance\","
                        + "\"templateId\":\"" + builtinTemplateId + "\",\"version\":1}}}")).getStatusCode());
        Map<String, Object> legacyPin = createSession("Builtin v1 pin", "custom-openai-compatible", "default-model");
        assertEquals("instance", legacyPin.get("contextTemplateLayer"));
        assertEquals(builtinTemplateId, String.valueOf(legacyPin.get("contextTemplateId")));
        assertEquals(1, legacyPin.get("contextTemplateVersion"));
    }

    @Test
    void sessionCreationPinsBuiltinDefaultAndExplicitRebindIsVisible() {
        ChatBindingTestSupport.ensureChatConnection(
                providerConnectionRepository, "USER", userId, "ctx-rebind");
        Map<String, Object> created = createSession(
                "Binding test", "custom-openai-compatible", "bind-model");
        String builtinTemplateId = apiRequestTemplates
                .builtinRef(CHAT_TYPE_ID, CHAT_TYPE_VERSION).path("templateId").asText();
        assertEquals("instance", created.get("contextTemplateLayer"));
        assertEquals(builtinTemplateId, String.valueOf(created.get("contextTemplateId")));
        // PLAN-0632 Gate G-0: new Sessions pin built-in revision 2 (with the context-block slots).
        assertEquals(2, created.get("contextTemplateVersion"));

        assertEquals(HttpStatus.OK, putUserTemplates("[" + publishedFragment(1, "用户模板 v1") + "]").getStatusCode());

        String sessionId = (String) created.get("id");
        Map<String, Object> rebind = new HashMap<>();
        rebind.put("layer", "user");
        rebind.put("templateId", TEMPLATE_ID);
        rebind.put("version", 1);
        rebind.put("connectionRevision", created.get("connectionRevision"));
        ResponseEntity<Map> rebound = patchClient.exchange(
                url("/api/v1/sessions/" + sessionId + "/api-request-template"),
                HttpMethod.PATCH,
                new HttpEntity<>(rebind, bearerJson(token)),
                Map.class);
        assertEquals(HttpStatus.OK, rebound.getStatusCode(), String.valueOf(rebound.getBody()));
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

        // An unpublished revision cannot be bound; the new domain reports the
        // stable mismatch conflict instead of a bare not-found.
        Map<String, Object> missingRevision = new HashMap<>(rebind);
        missingRevision.put("version", 99);
        ResponseEntity<Map> missing = patchClient.exchange(
                url("/api/v1/sessions/" + sessionId + "/api-request-template"),
                HttpMethod.PATCH,
                new HttpEntity<>(missingRevision, bearerJson(token)),
                Map.class);
        assertEquals(HttpStatus.CONFLICT, missing.getStatusCode(), String.valueOf(missing.getBody()));
        assertEquals("API_TYPE_TEMPLATE_MISMATCH", missing.getBody().get("code"));
    }

    // ---- T1.4 / V8: atomic admission snapshot ----

    @Test
    void chatRunSnapshotsBindingAndTemplateEditsNeverMutateIt() {
        String sessionId = UUID.randomUUID().toString();
        createAgentSession(sessionId, "Snapshot test");
        assertEquals(HttpStatus.OK,
                putUserTemplates("[" + publishedFragment(1, "用户模板 v1") + "]").getStatusCode());

        Session bound = sessionRepository.findById(UUID.fromString(sessionId)).orElseThrow();
        Map<String, Object> rebind = new HashMap<>();
        rebind.put("layer", "user");
        rebind.put("templateId", TEMPLATE_ID);
        rebind.put("version", 1);
        rebind.put("connectionRevision", bound.getConnectionRevision());
        ResponseEntity<Map> rebound = patchClient.exchange(
                url("/api/v1/sessions/" + sessionId + "/api-request-template"),
                HttpMethod.PATCH,
                new HttpEntity<>(rebind, bearerJson(token)),
                Map.class);
        assertEquals(HttpStatus.OK, rebound.getStatusCode(), String.valueOf(rebound.getBody()));

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
        assertEquals("explicit", snapshot.path("source").asText());
        assertEquals(CHAT_TYPE_ID, snapshot.path("apiTypeId").asText());
        assertEquals("用户模板 v1", snapshot.path("template").path("name").asText());
        String snapshotBeforeEdit = snapshot.toString();

        // Append v2 with different content: the admitted Run must not drift.
        assertEquals(HttpStatus.OK, putUserTemplates(
                "[" + publishedFragment(1, "用户模板 v1") + "," + publishedFragment(2, "用户模板 v2") + "]")
                .getStatusCode());
        ChatRun afterEdit = chatRunRepository.findById(run.getId()).orElseThrow();
        assertEquals(snapshotBeforeEdit, afterEdit.getContextTemplateSnapshot().toString());
        assertEquals("用户模板 v1",
                afterEdit.getContextTemplateSnapshot().path("template").path("name").asText());

        // Next Run after an explicit rebind follows the Session's CURRENT binding
        // (v2), while run1 above keeps its admission-time v1 snapshot.
        awaitRunTerminal(run.getId());
        // PLAN-0416 T3.1/D1: a template-less principal now carries the CP-owned
        // default baseline, and that resolved value (not any principal authority)
        // is what crosses to the Agent.
        wireMock.verify(postRequestedFor(urlEqualTo("/internal/v1/agent/chat"))
                .withRequestBody(matchingJsonPath("$.instructions", equalTo(principalInstructions))));
        Session reboundSession = sessionRepository.findById(UUID.fromString(sessionId)).orElseThrow();
        Map<String, Object> rebindV2 = new HashMap<>();
        rebindV2.put("layer", "user");
        rebindV2.put("templateId", TEMPLATE_ID);
        rebindV2.put("version", 2);
        rebindV2.put("connectionRevision", reboundSession.getConnectionRevision());
        ResponseEntity<Map> rebindV2Response = patchClient.exchange(
                url("/api/v1/sessions/" + sessionId + "/api-request-template"),
                HttpMethod.PATCH,
                new HttpEntity<>(rebindV2, bearerJson(token)),
                Map.class);
        assertEquals(HttpStatus.OK, rebindV2Response.getStatusCode(), String.valueOf(rebindV2Response.getBody()));
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

    /** task-343: the fixture must really hold instance:admin, otherwise the 200 is meaningless. */
    private void grantInstanceAdmin(UUID target) {
        AccessRole adminRole = roleRepository.findByName(SystemAccessRoleCatalog.ADMIN).orElseThrow();
        bindingRepository.saveAndFlush(new AccessRoleBinding(adminRole.getId(),
                AuthzContext.SUBJECT_USER, target, AccessScope.INSTANCE, null, target));
        // Action atoms are answered from the materialized grants(source='role') rows, not from
        // the binding itself: without this the capability cache says admin while the
        // @PreAuthorize atom gate still answers 403.
        roleGrantMaterializer.materializeSubject("user", target, target, null);
        authzContext.invalidate(target);
        assertTrue(authzContext.isInstanceAdmin(target),
                "fixture must really hold instance:admin, otherwise the positive case proves nothing");
    }

    /**
     * task-343: an INSTANCE-owned chat Connection (D-922: consumable by every bound consumer).
     * Built directly instead of through {@link ChatBindingTestSupport} because the credential
     * fixture creates its row as the owner actor, which is not what this contract is about.
     */
    private ProviderConnection instanceChatConnection(String connectionKey) {
        ProviderConnection connection = new ProviderConnection();
        connection.setId(UUID.randomUUID());
        connection.setOwnerType(ProviderConnection.OWNER_INSTANCE);
        connection.setOwnerId(instanceIdentity.ownerId());
        connection.setProviderId("custom-openai-compatible");
        connection.setConnectionKey(connectionKey);
        connection.setApiTypeId(CHAT_TYPE_ID);
        connection.setApiTypeVersion(CHAT_TYPE_VERSION);
        connection.setLabel("instance chat fixture " + connectionKey);
        connection.setModelDiscovery("remote-models");
        connection.setEnabled(true);
        connection.setStatus(ProviderConnection.STATUS_READY);
        connection.setRevision(1L);
        return providerConnectionRepository.saveAndFlush(connection);
    }

    private ResponseEntity<Map> putUserTemplates(String templatesJson) {
        return putUserTemplateConfig(Map.of("templates", templatesJson));
    }

    private ResponseEntity<Map> putUserTemplateConfig(Map<String, String> entries) {
        return restTemplate.exchange(
                url("/api/v1/config/user/api-request-templates"),
                HttpMethod.PUT, new HttpEntity<>(entries, bearerJson(token)),
                Map.class);
    }

    private Map<String, Object> createSession(String title, String provider, String model) {
        Map<String, Object> body = new HashMap<>();
        body.put("title", title);
        body.put("agentPrincipalId", principalId);
        body.put("modelProvider", provider);
        body.put("modelName", model);
        // PLAN-0608 C′: ownership is stated explicitly via the path form; the
        // legacy header-less route now answers 409 when the caller belongs to
        // more than one workspace (this fixture creates a second one).
        ResponseEntity<Map> response = restTemplate.exchange(
                url("/api/v1/workspaces/" + workspaceId + "/sessions"), HttpMethod.POST,
                new HttpEntity<>(body, bearerJson(token)),
                Map.class);
        assertEquals(HttpStatus.CREATED, response.getStatusCode(), String.valueOf(response.getBody()));
        return response.getBody();
    }

    private void createAgentSession(String sessionId, String title) {
        Session session = new Session(workspaceId, userId, title);
        session.setId(UUID.fromString(sessionId));
        session.setAgentPermissionsSnapshot(principalPermissions.deepCopy());
        ChatBindingTestSupport.bindNewChatConnection(
                session, providerConnectionRepository, apiRequestTemplates, userId);
        sessionRepository.saveAndFlush(session);
        bindPrimaryParticipant(sessionId, principalId);
    }

    /** A published, Type-valid revision of the shared TEMPLATE_ID. */
    private String publishedFragment(int version, String name) {
        return publishedFragment(TEMPLATE_ID, version, name);
    }

    /** A published, Type-valid revision of an arbitrary template id (task-343 precedence case). */
    private String publishedFragment(String templateId, int version, String name) {
        var node = objectMapper.createObjectNode();
        node.put("id", templateId).put("version", version).put("name", name)
                .put("description", "d").put("apiTypeId", CHAT_TYPE_ID).put("apiTypeVersion", CHAT_TYPE_VERSION)
                .put("bodySource", VALID_BODY_SOURCE).put("status", "published");
        return node.toString();
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
