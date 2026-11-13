package com.cc01cc.p.xihe.cp.integration;

import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
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
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * D-1236 (task-390): the optional {@code scope=workspaceless} read face on
 * {@code GET /api/v1/sessions}. Five behaviours are pinned, each one something the workspace-scoped
 * list cannot express:
 * <ol>
 *   <li>the scope branch returns exactly the caller's {@code workspace_id IS NULL} rows — not the
 *       workspace rows, not another user's rows, not archived rows;</li>
 *   <li>it works with <em>no</em> workspace context at all (a user who owns no workspace), while the
 *       no-scope path still answers 409 WORKSPACE_CONTEXT_REQUIRED for that same user;</li>
 *   <li>unknown scope values answer 400 INVALID_SCOPE, including the empty value;</li>
 *   <li>without the parameter the list stays workspace-scoped — the additive change is inert;</li>
 *   <li>the D1/D5 visibility rule carries over: owner OR enabled HUMAN participant, disabled rows
 *       grant nothing.</li>
 * </ol>
 * H2 lane (entity DDL, Flyway off): the V145 partial index itself is a PG-lane concern, this class
 * pins the read-face semantics.
 */
@SpringBootTest
@ActiveProfiles("h2")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class SessionWorkspacelessScopeTest {

    @Autowired
    private WebApplicationContext webApplicationContext;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private SessionParticipantRepository sessionParticipantRepository;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    @Autowired
    private WorkspaceFixture workspaceFixture;

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
    void workspacelessScopeReturnsOnlyTheCallersNullWorkspaceRows() throws Exception {
        AuthResponse owner = register("scope-owner");
        String ownerId = owner.getUser().getId();
        Workspace workspace = workspaceFixture.ensureOwnedWorkspace(UUID.fromString(ownerId), "Scope workspace");
        AuthResponse other = register("scope-other");

        Session mine = saveSession(null, ownerId, "mine workspaceless", Instant.parse("2026-11-14T00:00:00Z"));
        Session archived = saveSession(null, ownerId, "mine archived", Instant.parse("2026-11-14T00:01:00Z"));
        archived.setArchived(true);
        sessionRepository.save(archived);
        saveSession(workspace.getId().toString(), ownerId, "mine in workspace",
                Instant.parse("2026-11-14T00:02:00Z"));
        saveSession(null, other.getUser().getId(), "other workspaceless", Instant.parse("2026-11-14T00:03:00Z"));

        List<String> ids = listIds(owner.getAccessToken(), null, "?scope=workspaceless");

        assertEquals(List.of(mine.getId().toString()), ids,
                "scope=workspaceless must return only the caller's unarchived workspace-less sessions");
    }

    @Test
    void workspacelessScopeNeedsNoWorkspaceContextWhileTheDefaultPathStillDoes() throws Exception {
        // PLAN-0614: registration provisions no workspace, so this user has no workspace context at all.
        AuthResponse loner = register("scope-loner");
        Session session = saveSession(null, loner.getUser().getId(), "loner workspaceless",
                Instant.parse("2026-11-14T00:00:00Z"));
        authenticate(loner.getAccessToken());

        mockMvc.perform(get("/api/v1/sessions?scope=workspaceless")
                        .header("Authorization", "Bearer " + loner.getAccessToken()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.sessions.length()").value(1))
                .andExpect(jsonPath("$.sessions[0].id").value(session.getId().toString()));

        // The same user, same rows, no scope: the workspace hard gate is untouched.
        mockMvc.perform(get("/api/v1/sessions")
                        .header("Authorization", "Bearer " + loner.getAccessToken()))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("WORKSPACE_CONTEXT_REQUIRED"));
    }

    @Test
    void unknownScopeValuesAnswer400InvalidScope() throws Exception {
        AuthResponse owner = register("scope-bad-value");
        workspaceFixture.ensureOwnedWorkspace(UUID.fromString(owner.getUser().getId()), "Bad scope workspace");
        authenticate(owner.getAccessToken());

        mockMvc.perform(get("/api/v1/sessions?scope=bogus")
                        .header("Authorization", "Bearer " + owner.getAccessToken()))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_SCOPE"));

        // An empty value is a value too: it is not "no parameter", so it must not silently fall back.
        mockMvc.perform(get("/api/v1/sessions?scope=")
                        .header("Authorization", "Bearer " + owner.getAccessToken()))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_SCOPE"));
    }

    @Test
    void withoutScopeTheListStaysWorkspaceScoped() throws Exception {
        AuthResponse owner = register("scope-default");
        String ownerId = owner.getUser().getId();
        Workspace workspace = workspaceFixture.ensureOwnedWorkspace(UUID.fromString(ownerId), "Default workspace");

        Session inWorkspace = saveSession(workspace.getId().toString(), ownerId, "in workspace",
                Instant.parse("2026-11-14T00:00:00Z"));
        Session workspaceless = saveSession(null, ownerId, "workspaceless",
                Instant.parse("2026-11-14T00:01:00Z"));

        List<String> ids = listIds(owner.getAccessToken(), workspace.getId().toString(), "");

        assertTrue(ids.contains(inWorkspace.getId().toString()),
                "the default list must still return the workspace's sessions");
        assertFalse(ids.contains(workspaceless.getId().toString()),
                "the default list must not leak workspace-less sessions into the workspace read face");
    }

    @Test
    void workspacelessScopeKeepsTheParticipantVisibilityRule() throws Exception {
        AuthResponse owner = register("scope-participant-owner");
        AuthResponse guest = register("scope-participant-guest");
        String guestId = guest.getUser().getId();

        Session invited = saveSession(null, owner.getUser().getId(), "invited workspaceless",
                Instant.parse("2026-11-14T00:00:00Z"));
        Session disabled = saveSession(null, owner.getUser().getId(), "disabled workspaceless",
                Instant.parse("2026-11-14T00:01:00Z"));
        Session unrelated = saveSession(null, owner.getUser().getId(), "unrelated workspaceless",
                Instant.parse("2026-11-14T00:02:00Z"));

        saveParticipant(invited.getId(), guestId, null);
        saveParticipant(disabled.getId(), guestId, Instant.parse("2026-11-14T00:00:00Z"));

        List<String> ids = listIds(guest.getAccessToken(), null, "?scope=workspaceless");

        assertTrue(ids.contains(invited.getId().toString()),
                "an enabled HUMAN participant reads the workspace-less session (D1/D5 carried over)");
        assertFalse(ids.contains(disabled.getId().toString()),
                "a disabled participant row must not grant read access");
        assertFalse(ids.contains(unrelated.getId().toString()),
                "a stranger's workspace-less session stays invisible");
    }

    private Session saveSession(String workspaceId, String userId, String title, Instant createdAt) {
        Session session = new Session(workspaceId, userId, title);
        session.setId(UUID.randomUUID());
        session.setCreatedAt(createdAt);
        return sessionRepository.save(session);
    }

    private void saveParticipant(UUID sessionId, String principalId, Instant disabledAt) {
        SessionParticipant participant = new SessionParticipant(sessionId, SessionParticipant.KIND_HUMAN,
                UUID.fromString(principalId), SessionParticipant.ROLE_MEMBER, 1,
                SessionParticipant.WAKE_ALL_MESSAGES, SessionParticipant.RESPOND_ALWAYS);
        participant.setDisabledAt(disabledAt);
        sessionParticipantRepository.save(participant);
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

    /**
     * MockMvc is built without the security filter chain, so method security reads the context this
     * test writes — the Bearer header alone only drives {@code TenantContextInterceptor}. Same
     * arrangement as {@code WorkspaceIsolationTest#workspaceHeaderDrivesIsolationAndRoleMatrix}.
     */
    private void authenticate(String accessToken) {
        String userId = jwtTokenProvider.getUserIdFromToken(accessToken);
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken(userId, null,
                        List.of(new SimpleGrantedAuthority("ROLE_USER"))));
    }

    /** Performs the list call as the token's user and returns the session ids in response order. */
    private List<String> listIds(String accessToken, String workspaceHeader, String query) throws Exception {
        authenticate(accessToken);
        var request = get("/api/v1/sessions" + query).header("Authorization", "Bearer " + accessToken);
        if (workspaceHeader != null) {
            request = request.header("X-Workspace-Id", workspaceHeader);
        }
        String json = mockMvc.perform(request)
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();
        Map<?, ?> body = objectMapper.readValue(json, Map.class);
        List<?> sessions = (List<?>) body.get("sessions");
        List<String> ids = new ArrayList<>();
        for (Object item : sessions) {
            ids.add(String.valueOf(((Map<?, ?>) item).get("id")));
        }
        return ids;
    }
}
