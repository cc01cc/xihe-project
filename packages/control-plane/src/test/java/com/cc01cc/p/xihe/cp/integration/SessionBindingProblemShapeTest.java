package com.cc01cc.p.xihe.cp.integration;

import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * task-425 PROBE (read-only inventory of the binding funnel's exception exits). It measures which
 * problem code each refusal actually answers with, per entry path, instead of assuming one shape:
 *
 * <ul>
 *   <li>{@code SessionService#updateBinding} pre-checks with lockConnection / requireVisible /
 *       requireChat / revision CAS BEFORE calling bindProviderConnection, so those refusals keep
 *       their own codes;</li>
 *   <li>the creation path calls {@code SessionService#bindProviderConnection} directly, whose
 *       {@code catch (IllegalArgumentException)} re-codes EVERY CpApiException (CpApiException
 *       extends IllegalArgumentException) into 400 PROVIDER_CONNECTION_UNAVAILABLE;</li>
 *   <li>{@code ProblemDetailsHandler#badRequest} preserves a CpApiException's status/code/detail and
 *       only falls back to the generic INVALID_REQUEST "Request validation failed" for a plain
 *       IllegalArgumentException.</li>
 * </ul>
 *
 * <p>Each case prints its reading and asserts only what must hold regardless of the ruling (a 4xx
 * and no persisted binding), so this class records facts before the fix shape is decided.</p>
 */
@SpringBootTest
@ActiveProfiles("h2")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class SessionBindingProblemShapeTest {

    @Autowired
    private WebApplicationContext webApplicationContext;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private ProviderConnectionRepository connectionRepository;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    @Autowired
    private WorkspaceFixture workspaceFixture;

    @Autowired
    private com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository principalRepository;

    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        mockMvc = MockMvcBuilders.webAppContextSetup(webApplicationContext).build();
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
        SecurityContextHolder.clearContext();
    }

    @Test
    void unknownConnectionOnTheCreatePath() throws Exception {
        AuthResponse owner = register("shape-create");
        ownedWorkspace(owner, "Shape create workspace");
        String body = objectMapper.writeValueAsString(Map.of(
                "title", "shape create", "modelProvider", "deepseek", "modelName", "deepseek-chat",
                "agentPrincipalId", savePrincipal(owner).toString(),
                "providerConnectionId", UUID.randomUUID().toString()));
        var response = mockMvc.perform(authorized(post("/api/v1/sessions"), owner, null)
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andReturn().getResponse();
        report("create + unknown connectionId", response);
        // task-425 A: the creation path now answers the SAME code as PATCH for the same input.
        assertEquals(404, response.getStatus(), "a missing connection is a 404, not a compressed 400");
        assertEquals("PROVIDER_CONNECTION_NOT_FOUND", code(response));
    }

    @Test
    void unknownConnectionOnThePatchPath() throws Exception {
        AuthResponse owner = register("shape-patch");
        Workspace workspace = ownedWorkspace(owner, "Shape patch workspace");
        Session session = saveSession(workspace.getId().toString(), owner.getUser().getId(), "shape patch");
        var response = mockMvc.perform(authorized(patch("/api/v1/sessions/" + session.getId()), owner,
                        workspace.getId().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(bindingBody(UUID.randomUUID().toString(), 2L, "deepseek-chat")))
                .andReturn().getResponse();
        report("PATCH + unknown connectionId", response);
        // Already correct today: updateBinding pre-checks with lockConnection BEFORE the funnel.
        assertEquals(404, response.getStatus());
        assertEquals("PROVIDER_CONNECTION_NOT_FOUND", code(response));
        assertEquals(null, sessionRepository.findById(session.getId()).orElseThrow().getProviderConnectionId());
    }

    @Test
    void malformedConnectionOnBothPaths() throws Exception {
        AuthResponse owner = register("shape-malformed");
        Workspace workspace = ownedWorkspace(owner, "Shape malformed workspace");
        Session session = saveSession(workspace.getId().toString(), owner.getUser().getId(), "shape malformed");
        var patchResponse = mockMvc.perform(authorized(patch("/api/v1/sessions/" + session.getId()), owner,
                        workspace.getId().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(bindingBody("not-a-uuid", 2L, "deepseek-chat")))
                .andReturn().getResponse();
        report("PATCH + malformed connectionId", patchResponse);
        assertMalformedIsReadable(patchResponse);
        String body = objectMapper.writeValueAsString(Map.of(
                "title", "shape malformed", "modelProvider", "deepseek", "modelName", "deepseek-chat",
                "agentPrincipalId", savePrincipal(owner).toString(),
                "providerConnectionId", "not-a-uuid"));
        var createResponse = mockMvc.perform(authorized(post("/api/v1/sessions"), owner, null)
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andReturn().getResponse();
        report("create + malformed connectionId", createResponse);
        assertMalformedIsReadable(createResponse);
    }

    @Test
    void staleRevisionAndUnregisteredModelKeepReadableCodes() throws Exception {
        AuthResponse owner = register("shape-controls");
        Workspace workspace = ownedWorkspace(owner, "Shape controls workspace");
        Session session = saveSession(workspace.getId().toString(), owner.getUser().getId(), "shape controls");
        ProviderConnection connection = saveConnection(ProviderConnection.OWNER_USER,
                owner.getUser().getId(), "shape-controls-key", "remote-models", null);

        var stale = mockMvc.perform(authorized(patch("/api/v1/sessions/" + session.getId()), owner,
                        workspace.getId().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(bindingBody(connection.getId().toString(), 99L, "deepseek-chat")))
                .andReturn().getResponse();
        report("PATCH + stale revision", stale);
        assertEquals(409, stale.getStatus());
        assertEquals("STALE_PROVIDER_CONNECTION", code(stale));

        ProviderConnection manual = saveConnection(ProviderConnection.OWNER_USER,
                owner.getUser().getId(), "shape-manual-key", "manual", "[\"another-model\"]");
        var model = mockMvc.perform(authorized(patch("/api/v1/sessions/" + session.getId()), owner,
                        workspace.getId().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(bindingBody(manual.getId().toString(), 2L, "deepseek-chat")))
                .andReturn().getResponse();
        report("PATCH + model not in the manual list", model);
        assertEquals(400, model.getStatus());
        assertEquals("INVALID_REQUEST", code(model));
        assertEquals("Model is not registered under this Connection", detail(model),
                "a CpApiException keeps its readable detail (it is NOT the generic fallback)");
        assertEquals(null, sessionRepository.findById(session.getId()).orElseThrow().getProviderConnectionId());
    }

    @Test
    void workspacelessWorkspaceConnectionKeepsTheTask418Code() throws Exception {
        AuthResponse owner = register("shape-418");
        Workspace workspace = ownedWorkspace(owner, "Shape 418 workspace");
        Session session = saveSession(null, owner.getUser().getId(), "shape 418");
        ProviderConnection workspaceConnection = saveConnection(ProviderConnection.OWNER_WORKSPACE,
                workspace.getId().toString(), "shape-ws-key", "remote-models", null);
        var response = mockMvc.perform(authorized(patch("/api/v1/sessions/" + session.getId()), owner, null)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(bindingBody(workspaceConnection.getId().toString(), 2L, "deepseek-chat")))
                .andReturn().getResponse();
        report("workspace-less + WORKSPACE connection (task-418 gate)", response);
        assertEquals(400, response.getStatus());
        assertEquals("WORKSPACE_CONNECTION_FORBIDDEN", code(response));
        assertEquals(null, sessionRepository.findById(session.getId()).orElseThrow().getProviderConnectionId());
    }

    // --- fixtures ---------------------------------------------------------------------------

    private void report(String label, org.springframework.mock.web.MockHttpServletResponse response) throws Exception {
        JsonNode body = objectMapper.readTree(response.getContentAsString());
        System.out.println("[task-425 probe] " + label + " -> status=" + response.getStatus()
                + " code=" + body.path("code").asText() + " detail=" + body.path("detail").asText());
    }

    /** task-425 B: both faces name the field, and neither leaks the Java parse text. */
    private void assertMalformedIsReadable(org.springframework.mock.web.MockHttpServletResponse response)
            throws Exception {
        assertEquals(400, response.getStatus());
        assertEquals("INVALID_REQUEST", code(response));
        assertEquals("providerConnectionId must be a UUID", detail(response));
        assertTrue(!detail(response).contains("Invalid UUID string"),
                "the raw Java parse message must not reach the client: " + detail(response));
        assertTrue(!"Request validation failed".equals(detail(response)),
                "the generic fallback tells the caller nothing: " + detail(response));
    }

    private String code(org.springframework.mock.web.MockHttpServletResponse response) throws Exception {
        return objectMapper.readTree(response.getContentAsString()).path("code").asText();
    }

    private String detail(org.springframework.mock.web.MockHttpServletResponse response) throws Exception {
        return objectMapper.readTree(response.getContentAsString()).path("detail").asText();
    }

    private String bindingBody(String connectionId, Long revision, String model) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("modelProvider", "deepseek");
        body.put("modelName", model);
        body.put("providerConnectionId", connectionId);
        body.put("connectionRevision", revision);
        return objectMapper.writeValueAsString(body);
    }

    private ProviderConnection saveConnection(String ownerType, String ownerId, String key,
                                              String discovery, String manualModels) {
        ProviderConnection connection = new ProviderConnection();
        connection.setId(UUID.randomUUID());
        connection.setOwnerType(ownerType);
        connection.setOwnerId(ownerId);
        connection.setProviderId("deepseek");
        connection.setConnectionKey(key);
        connection.setApiTypeId("openai-chat-completions");
        connection.setApiTypeVersion(1);
        connection.setLabel("task-425 probe");
        connection.setEnabled(true);
        connection.setStatus(ProviderConnection.STATUS_READY);
        connection.setModelDiscovery(discovery);
        connection.setManualModels(manualModels);
        connection.setRevision(2L);
        connection.setCreatedAt(Instant.parse("2026-11-14T00:00:00Z"));
        connection.setUpdatedAt(Instant.parse("2026-11-14T00:00:00Z"));
        return connectionRepository.save(connection);
    }

    private UUID savePrincipal(AuthResponse user) {
        com.cc01cc.p.xihe.cp.entity.AgentPrincipal principal = new com.cc01cc.p.xihe.cp.entity.AgentPrincipal();
        // @GeneratedValue(UUID): assigning the id would make Spring Data merge a non-existent row.
        principal.setName("shape-probe-" + UUID.randomUUID().toString().substring(0, 6));
        principal.setCreatedByUserId(user.getUser().getId());
        principal.setCreatedAt(Instant.parse("2026-11-14T00:00:00Z"));
        return principalRepository.save(principal).getId();
    }

    private Workspace ownedWorkspace(AuthResponse user, String name) {
        return workspaceFixture.ensureOwnedWorkspace(UUID.fromString(user.getUser().getId()), name);
    }

    private Session saveSession(String workspaceId, String userId, String title) {
        Session session = new Session(workspaceId, userId, title);
        session.setId(UUID.randomUUID());
        session.setCreatedAt(Instant.parse("2026-11-14T00:00:00Z"));
        return sessionRepository.save(session);
    }

    private AuthResponse register(String prefix) throws Exception {
        String email = prefix + "-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest request = new RegisterRequest(email, TestDataFactory.PASSWORD, prefix);
        String json = mockMvc.perform(post("/api/v1/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(request)))
                .andExpect(status().isCreated())
                .andReturn().getResponse().getContentAsString();
        return objectMapper.readValue(json, AuthResponse.class);
    }

    private MockHttpServletRequestBuilder authorized(MockHttpServletRequestBuilder builder, AuthResponse user,
                                                     String workspaceHeader) {
        String userId = jwtTokenProvider.getUserIdFromToken(user.getAccessToken());
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken(userId, null,
                        List.of(new SimpleGrantedAuthority("ROLE_USER"))));
        builder.header("Authorization", "Bearer " + user.getAccessToken());
        if (workspaceHeader != null) {
            builder.header("X-Workspace-Id", workspaceHeader);
        }
        return builder;
    }
}
