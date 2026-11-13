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
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * task-418 (D-1247 / task-399 residual): the model-binding WRITE face of a workspace-less session.
 *
 * <p>The dispatch card assumed {@code ApiRequestTemplateService.requireVisible} still judged by
 * workspace and therefore blocked an independent session's model binding. Reading the source says
 * otherwise: that gate is owner-based (INSTANCE consumable by any bound consumer per D-922, USER by
 * owner equality, only WORKSPACE by workspace equality), {@code effectiveConnections} skips the
 * workspace tier when the id is null, and {@code bindApiTemplate} carries an explicit PLAN-0647
 * D-678 ruling for the workspace-less template chain (user -> instance). The mutation funnel
 * {@code lockCurrentForMutation} delegates to {@code lockForDelete}, which task-399 already opened
 * for workspace-less rows.</p>
 *
 * <p>So this class is a PROBE: it pins what the write face actually does for an independent session,
 * with and without a workspace header (the interceptor's server-side ambient fallback is the
 * decisive fact of D-1247), and keeps a workspace-bound counterpart so the old boundary is visibly
 * untouched. H2 lane, same arrangement as {@code SessionWorkspacelessAccessTest}.</p>
 */
@SpringBootTest
@ActiveProfiles("h2")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class SessionWorkspacelessBindingTest {

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
    private com.cc01cc.p.xihe.cp.service.InstanceIdentityService instanceIdentity;

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
    void workspacelessSessionBindsAUserConnectionWithoutAWorkspaceHeader() throws Exception {
        AuthResponse owner = register("bind-user");
        ownedWorkspace(owner, "Binding ambient workspace");
        Session session = saveSession(null, owner.getUser().getId(), "independent binding");
        ProviderConnection connection = saveConnection(ProviderConnection.OWNER_USER,
                owner.getUser().getId(), "user-key");

        String body = mockMvc.perform(authorized(patch("/api/v1/sessions/" + session.getId()), owner, null)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(bindingBody(connection)))
                .andReturn().getResponse().getContentAsString();
        System.out.println("[task-418 probe] user connection, no header -> " + body);

        Session stored = sessionRepository.findById(session.getId()).orElseThrow();
        assertEquals(connection.getId().toString(), stored.getProviderConnectionId(),
                "the independent session really binds the user's connection");
        assertEquals("deepseek-chat", stored.getModelName());
        assertNotNull(stored.getContextTemplateId(),
                "D-678: the workspace-less chain still resolves a template (user -> instance)");
    }

    @Test
    void workspacelessSessionBindsAUserConnectionWithTheAmbientWorkspaceHeader() throws Exception {
        AuthResponse owner = register("bind-header");
        Workspace workspace = ownedWorkspace(owner, "Binding header workspace");
        Session session = saveSession(null, owner.getUser().getId(), "independent with header");
        ProviderConnection connection = saveConnection(ProviderConnection.OWNER_USER,
                owner.getUser().getId(), "user-header-key");

        mockMvc.perform(authorized(patch("/api/v1/sessions/" + session.getId()), owner,
                        workspace.getId().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(bindingBody(connection)))
                .andExpect(status().isOk());
        assertEquals(connection.getId().toString(),
                sessionRepository.findById(session.getId()).orElseThrow().getProviderConnectionId());
    }

    @Test
    void workspacelessSessionCannotBindAnotherUsersConnection() throws Exception {
        AuthResponse owner = register("bind-owner");
        AuthResponse stranger = register("bind-stranger");
        ownedWorkspace(owner, "Binding owner workspace");
        Session session = saveSession(null, owner.getUser().getId(), "independent not yours");
        ProviderConnection foreign = saveConnection(ProviderConnection.OWNER_USER,
                stranger.getUser().getId(), "stranger-key");

        mockMvc.perform(authorized(patch("/api/v1/sessions/" + session.getId()), owner, null)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(bindingBody(foreign)))
                .andExpect(status().isForbidden());
        assertEquals(null, sessionRepository.findById(session.getId()).orElseThrow().getProviderConnectionId(),
                "a refused binding writes nothing");
    }

    @Test
    void workspacelessSessionAndAnAmbientWorkspaceConnection() throws Exception {
        AuthResponse owner = register("bind-ambient");
        Workspace workspace = ownedWorkspace(owner, "Binding ambient ws connection");
        Session session = saveSession(null, owner.getUser().getId(), "independent ambient connection");
        ProviderConnection workspaceConnection = saveConnection(ProviderConnection.OWNER_WORKSPACE,
                workspace.getId().toString(), "workspace-key");

        // Reading [实测]: still refused AFTER the task-418 ownership fix, and NOT by the ownership
        // gate. SessionService#bindApiTemplate re-checks requireUsableForOwner with the SESSION's own
        // workspace (null), so a WORKSPACE-owned connection can never enter a workspace-less session
        // — the "too wide" concern is closed by that second gate, not by the caller's ambient scope.
        // The refusal surfaces as a generic INVALID_REQUEST (ProblemDetailsHandler:245) because
        // bindApiTemplate's IllegalArgumentException is outside bindProviderConnection's try/catch;
        // that error-shape wart is reported, not changed here.
        var response = mockMvc.perform(authorized(patch("/api/v1/sessions/" + session.getId()), owner, null)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(bindingBody(workspaceConnection)))
                .andReturn().getResponse();
        int status = response.getStatus();
        String bound = sessionRepository.findById(session.getId()).orElseThrow().getProviderConnectionId();
        System.out.println("[task-418 probe] ambient workspace connection -> status=" + status
                + " bound=" + bound + " body=" + response.getContentAsString());
        assertEquals(400, status, "a workspace connection does not enter a workspace-less session");
        assertEquals("WORKSPACE_CONNECTION_FORBIDDEN",
                objectMapper.readTree(response.getContentAsString()).path("code").asText(),
                "D-1256 ②: the refusal is explicit and readable, not a generic validation error");
        assertEquals(null, bound, "and nothing is persisted");
    }

    @Test
    void workspacelessSessionBindsAnInstanceConnection() throws Exception {
        AuthResponse owner = register("bind-instance");
        ownedWorkspace(owner, "Binding instance workspace");
        Session session = saveSession(null, owner.getUser().getId(), "independent instance connection");
        ProviderConnection shared = saveConnection(ProviderConnection.OWNER_INSTANCE,
                instanceIdentity.ownerId(), "instance-key");

        // D-922: the shared INSTANCE connection is consumable by any bound consumer.
        mockMvc.perform(authorized(patch("/api/v1/sessions/" + session.getId()), owner, null)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(bindingBody(shared)))
                .andExpect(status().isOk());
        assertEquals(shared.getId().toString(),
                sessionRepository.findById(session.getId()).orElseThrow().getProviderConnectionId());
    }

    @Test
    void workspacelessSessionCannotBindAConnectionOfAnotherWorkspace() throws Exception {
        AuthResponse owner = register("bind-other-ws");
        ownedWorkspace(owner, "Binding first workspace");
        Workspace second = workspaceFixture.createOwnedWorkspace("Binding second workspace",
                owner.getUser().getId());
        Session session = saveSession(null, owner.getUser().getId(), "independent other workspace");
        ProviderConnection foreign = saveConnection(ProviderConnection.OWNER_WORKSPACE,
                second.getId().toString(), "second-workspace-key");

        // Negative counterpart (a fix must not become a blanket allow): the ambient workspace is the
        // FIRST one, so a connection of the second workspace is not the caller's to bind here.
        mockMvc.perform(authorized(patch("/api/v1/sessions/" + session.getId()), owner, null)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(bindingBody(foreign)))
                .andExpect(status().is4xxClientError());
        assertEquals(null, sessionRepository.findById(session.getId()).orElseThrow().getProviderConnectionId(),
                "the refused foreign workspace binding writes nothing");
    }

    @Test
    void workspaceBoundSessionKeepsItsConnectionBoundary() throws Exception {
        AuthResponse owner = register("bind-ws");
        Workspace workspace = ownedWorkspace(owner, "Binding bound workspace");
        Workspace other = workspaceFixture.createOwnedWorkspace("Binding bound other workspace",
                owner.getUser().getId());
        Session session = saveSession(workspace.getId().toString(), owner.getUser().getId(), "bound session");
        ProviderConnection own = saveConnection(ProviderConnection.OWNER_WORKSPACE,
                workspace.getId().toString(), "bound-own-key");
        ProviderConnection foreign = saveConnection(ProviderConnection.OWNER_WORKSPACE,
                other.getId().toString(), "bound-other-key");

        mockMvc.perform(authorized(patch("/api/v1/sessions/" + session.getId()), owner,
                        workspace.getId().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(bindingBody(own)))
                .andExpect(status().isOk());
        mockMvc.perform(authorized(patch("/api/v1/sessions/" + session.getId()), owner,
                        workspace.getId().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(bindingBody(foreign)))
                .andExpect(status().isForbidden());
        assertEquals(own.getId().toString(),
                sessionRepository.findById(session.getId()).orElseThrow().getProviderConnectionId(),
                "the refused foreign binding left the own binding in place");
    }

    // --- fixtures ---------------------------------------------------------------------------

    private String bindingBody(ProviderConnection connection) throws Exception {
        return objectMapper.writeValueAsString(java.util.Map.of(
                "modelProvider", "deepseek",
                "modelName", "deepseek-chat",
                "providerConnectionId", connection.getId().toString(),
                "connectionRevision", connection.getRevision()));
    }

    private ProviderConnection saveConnection(String ownerType, String ownerId, String key) {
        ProviderConnection connection = new ProviderConnection();
        connection.setId(UUID.randomUUID());
        connection.setOwnerType(ownerType);
        connection.setOwnerId(ownerId);
        connection.setProviderId("deepseek");
        connection.setConnectionKey(key);
        connection.setApiTypeId("openai-chat-completions");
        connection.setApiTypeVersion(1);
        connection.setLabel("task-418 probe");
        connection.setEnabled(true);
        connection.setStatus(ProviderConnection.STATUS_READY);
        // remote-models: requireModel only validates a manual list, so the probe stays about scope.
        connection.setModelDiscovery("remote-models");
        connection.setRevision(2L);
        connection.setCreatedAt(Instant.parse("2026-11-14T00:00:00Z"));
        connection.setUpdatedAt(Instant.parse("2026-11-14T00:00:00Z"));
        return connectionRepository.save(connection);
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
                .andReturn()
                .getResponse()
                .getContentAsString();
        return objectMapper.readValue(json, AuthResponse.class);
    }

    /** Same arrangement as SessionWorkspacelessAccessTest: no security filter chain, Bearer drives
     *  TenantContextInterceptor (including its server-side ambient workspace fallback). */
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
