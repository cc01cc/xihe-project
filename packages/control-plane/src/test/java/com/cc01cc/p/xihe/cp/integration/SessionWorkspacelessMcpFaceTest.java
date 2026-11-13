package com.cc01cc.p.xihe.cp.integration;

import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.Workspace;
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
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * task-435 (D-1269 ruling: PIN the current behaviour, do NOT relax the filter).
 *
 * <p>{@code SessionService#findMcpSessionOwner} filters on {@code workspaceId.equals(session
 * .getWorkspaceId())}, which is never true for an independent session (null column) — the third
 * copy of the same equality judgment (task-399 read/delete, task-418 binding). Both consumers sit
 * inside {@code McpProxyController#authorize} (:3033 internal-service, :3077 public), and BOTH are
 * reached only after a workspace context already exists (:3020 400 / :3062 401). This class records
 * whether the equality is the binding constraint on this face, or whether the entry gate fires
 * first — that decides whether a D-1247-shaped minimal fix changes anything observable here.</p>
 *
 * <p>Measured before the ruling: both workspace-less cases answer 404 SESSION_NOT_FOUND, while a
 * workspace-bound session in its own workspace reaches dispatch (503 RUNTIME_UNAVAILABLE in this
 * lane, which has no runtime). That 404-vs-503 split is the evidence for WHICH layer refuses: the
 * independent session is stopped at the visibility filter, not by a broken chain.
 *
 * <p>Why pinning is the right call (unlike task-399 / task-418): those guards protect the caller's
 * OWN row (read/delete a session, bind a connection), so skipping the workspace-equality half only
 * makes the user's own resource reachable. Here {@code authorize} continues with
 * {@code workspaceId = effectiveWorkspaceId} (McpProxyController:3071) and tools resolve in the
 * CALLER's workspace — relaxing the filter would hand an independent session the ambient
 * workspace's MCP tools, i.e. a cross-resource privilege widening. The instance-level MCP arm
 * (D-1006 B5) does not exist yet (zero INSTANCE hits in the whole cp/mcp package), so an
 * independent session must wait for that arm before it can use tools at all.</p>
 */
@SpringBootTest
@ActiveProfiles("h2")
@DirtiesContext
class SessionWorkspacelessMcpFaceTest {

    @Autowired private WebApplicationContext context;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private JwtTokenProvider jwtTokenProvider;
    @Autowired private SessionRepository sessionRepository;
    @Autowired private WorkspaceFixture workspaceFixture;

    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        mockMvc = MockMvcBuilders.webAppContextSetup(context).build();
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
        SecurityContextHolder.clearContext();
    }

    @Test
    void workspacelessSessionWithOnlyAnAmbientWorkspace() throws Exception {
        AuthResponse user = register("mcp-ambient");
        ownedWorkspace(user, "mcp-ambient-ws");
        Session session = saveSession(null, user.getUser().getId(), "independent");
        var response = call(user, null, session.getId());
        report("workspace-less session, ambient workspace only", response);
        // D-1269: pinned. The ambient workspace satisfies the entry gate, so the visibility filter
        // is the binding constraint on this face — and it must keep refusing.
        assertEquals(404, response.getStatus());
        assertEquals("SESSION_NOT_FOUND", code(response));
    }

    @Test
    void workspacelessSessionWithAnExplicitWorkspaceHeader() throws Exception {
        AuthResponse user = register("mcp-header");
        Workspace workspace = ownedWorkspace(user, "mcp-header-ws");
        Session session = saveSession(null, user.getUser().getId(), "independent");
        var response = call(user, workspace.getId().toString(), session.getId());
        report("workspace-less session, explicit workspace header", response);
        assertEquals(404, response.getStatus());
        assertEquals("SESSION_NOT_FOUND", code(response));
    }

    @Test
    void workspaceBoundSessionInItsOwnWorkspacePassesTheOwnerFilter() throws Exception {
        AuthResponse user = register("mcp-bound");
        Workspace workspace = ownedWorkspace(user, "mcp-bound-ws");
        Session session = saveSession(workspace.getId().toString(), user.getUser().getId(), "bound");
        var response = call(user, workspace.getId().toString(), session.getId());
        report("CONTROL workspace-bound session, own workspace", response);
        assertNotEquals("SESSION_NOT_FOUND", code(response),
                "the owner filter must not reject a session in its own workspace");
        assertEquals(503, response.getStatus(),
                "it reaches dispatch (no runtime in this lane) — proving the 404 above is the "
                        + "visibility filter, not a broken chain");
    }

    @Test
    void workspaceBoundSessionFromAnotherWorkspaceStaysNotFound() throws Exception {
        AuthResponse owner = register("mcp-owner");
        Workspace ownWorkspace = ownedWorkspace(owner, "mcp-owner-ws");
        Session session = saveSession(ownWorkspace.getId().toString(), owner.getUser().getId(), "bound");
        AuthResponse stranger = register("mcp-stranger");
        Workspace foreign = ownedWorkspace(stranger, "mcp-stranger-ws");
        var response = call(stranger, foreign.getId().toString(), session.getId());
        report("CONTROL workspace-bound session, foreign workspace", response);
        assertEquals(404, response.getStatus(), "cross-workspace access stays refused");
        assertEquals("SESSION_NOT_FOUND", code(response));
    }

    private org.springframework.mock.web.MockHttpServletResponse call(AuthResponse user, String workspaceHeader,
                                                                     UUID sessionId) throws Exception {
        MockHttpServletRequestBuilder builder = post("/api/v1/mcp")
                .contentType(MediaType.APPLICATION_JSON)
                .header("X-Session-Id", sessionId.toString())
                .content("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}");
        return mockMvc.perform(authorized(builder, user, workspaceHeader)).andReturn().getResponse();
    }

    private void report(String label, org.springframework.mock.web.MockHttpServletResponse response) throws Exception {
        System.out.println("[task-435 probe] " + label + " -> status=" + response.getStatus()
                + " code=" + code(response) + " detail=" + detail(response));
    }

    private String code(org.springframework.mock.web.MockHttpServletResponse response) throws Exception {
        String body = response.getContentAsString();
        if (body == null || body.isBlank()) {
            return "(empty body)";
        }
        return objectMapper.readTree(body).path("code").asText("(no code field)");
    }

    private String detail(org.springframework.mock.web.MockHttpServletResponse response) throws Exception {
        String body = response.getContentAsString();
        if (body == null || body.isBlank()) {
            return "(empty body)";
        }
        var node = objectMapper.readTree(body);
        return node.has("detail") ? node.path("detail").asText() : node.path("message").asText("(no detail)");
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
