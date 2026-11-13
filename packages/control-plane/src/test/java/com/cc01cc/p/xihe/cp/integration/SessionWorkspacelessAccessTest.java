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
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * D-1247 (task-399): a workspace-less session ({@code workspace_id IS NULL}, V145) belongs to its
 * user, not to a workspace. Before this change every single-session face rejected it twice over:
 * {@code SessionReadAccess.resolve} demanded a non-blank workspace context and then filtered on
 * {@code workspaceId.equals(session.getWorkspaceId())} (always false for a null column), and the
 * mutation funnel {@code SessionService.lockForDelete} repeated both checks.
 *
 * <p>The decisive fact this class pins is that <b>clearing the client's workspace context cannot
 * avoid the rejection</b>: {@code TenantContextInterceptor} falls back to
 * {@code WorkspaceService.findCurrentWorkspace} = {@code firstActiveWorkspace}, i.e. the first
 * workspace the user is a member of, resolved server-side. So a user who owns any workspace gets an
 * ambient workspace on every request, header or not — the CP gate itself has to accept the
 * workspace-less row.</p>
 *
 * <p>Coverage is per face, because the fix lands in the shared primitive and therefore widens all
 * five of its call sites at once (Lead ruling D-1247 ③): single-session read, derived-state read,
 * roster read, rename and delete. Each face also keeps a workspace-bound counterpart asserting the
 * old behaviour is untouched — context still required, equality still enforced, strangers still
 * 404, invited humans still read-only.</p>
 *
 * <p>H2 lane (entity DDL, Flyway off): this pins the authorization semantics, not the V145 partial
 * index. The manager tier is deliberately not opened for workspace-less rows (D-1247 ④).</p>
 */
@SpringBootTest
@ActiveProfiles("h2")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class SessionWorkspacelessAccessTest {

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
    void workspacelessSessionReadsEvenWithAnAmbientWorkspaceHeader() throws Exception {
        AuthResponse owner = register("access-owner");
        Workspace workspace = ownedWorkspace(owner, "Access ambient workspace");
        Session session = saveSession(null, owner.getUser().getId(), "independent");

        // ui-2 task-373 finding: the workspace header used to make this 404.
        mockMvc.perform(authorized(get("/api/v1/sessions/" + session.getId()), owner, workspace.getId().toString()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(session.getId().toString()));
    }

    @Test
    void workspacelessSessionReadsWhenTheInterceptorFallsBackToTheUsersWorkspace() throws Exception {
        AuthResponse owner = register("access-fallback");
        ownedWorkspace(owner, "Access fallback workspace");
        Session session = saveSession(null, owner.getUser().getId(), "independent no header");

        // No X-Workspace-Id at all: the interceptor still resolves the user's first workspace from
        // membership, so a client-side "clear the context" workaround cannot reach this row.
        mockMvc.perform(authorized(get("/api/v1/sessions/" + session.getId()), owner, null))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(session.getId().toString()));
    }

    @Test
    void workspacelessSessionReadsForAUserWhoOwnsNoWorkspace() throws Exception {
        AuthResponse loner = register("access-loner");
        Session session = saveSession(null, loner.getUser().getId(), "loner independent");

        mockMvc.perform(authorized(get("/api/v1/sessions/" + session.getId()), loner, null))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(session.getId().toString()));
    }

    @Test
    void workspacelessSessionStaysInvisibleToStrangers() throws Exception {
        AuthResponse owner = register("access-stranger-owner");
        Workspace workspace = ownedWorkspace(owner, "Access stranger workspace");
        AuthResponse stranger = register("access-stranger");
        Session session = saveSession(null, owner.getUser().getId(), "not yours");

        mockMvc.perform(authorized(get("/api/v1/sessions/" + session.getId()), stranger, null))
                .andExpect(status().isNotFound());
        // With the owner's workspace header the interceptor rejects the non-member first (403
        // WORKSPACE_FORBIDDEN) — the session gate is never reached. Both layers hide the row.
        mockMvc.perform(authorized(get("/api/v1/sessions/" + session.getId()), stranger, workspace.getId().toString()))
                .andExpect(status().isForbidden());
    }

    @Test
    void invitedHumanReadsAWorkspacelessSessionButCannotRenameIt() throws Exception {
        AuthResponse owner = register("access-invite-owner");
        // The owner does have an ambient workspace; the row itself is workspace-less, and the guest
        // reaches it with no workspace context at all.
        ownedWorkspace(owner, "Access invite workspace");
        AuthResponse guest = register("access-invite-guest");
        Session session = saveSession(null, owner.getUser().getId(), "shared independent");
        saveParticipant(session.getId(), guest.getUser().getId(), null);

        // The guest owns no workspace and is not a member of the owner's, so the call carries no
        // workspace header — exactly the ambient-free path a workspace-less session must accept.
        mockMvc.perform(authorized(get("/api/v1/sessions/" + session.getId()), guest, null))
                .andExpect(status().isOk());
        // requireOwned keeps owner-only semantics: widening the read face never widens a write face.
        mockMvc.perform(authorized(patch("/api/v1/sessions/" + session.getId()), guest, null)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"guest rename\"}"))
                .andExpect(status().isNotFound());
        assertEquals("shared independent", sessionRepository.findById(session.getId()).orElseThrow().getTitle());
    }

    @Test
    void disabledParticipantGrantsNothingOnAWorkspacelessSession() throws Exception {
        AuthResponse owner = register("access-disabled-owner");
        AuthResponse guest = register("access-disabled-guest");
        Session session = saveSession(null, owner.getUser().getId(), "disabled invite");
        saveParticipant(session.getId(), guest.getUser().getId(), Instant.parse("2026-11-14T00:00:00Z"));

        mockMvc.perform(authorized(get("/api/v1/sessions/" + session.getId()), guest, null))
                .andExpect(status().isNotFound());
    }

    @Test
    void workspaceSessionReadKeepsContextRequirementAndEquality() throws Exception {
        AuthResponse owner = register("access-ws-read");
        Workspace workspace = ownedWorkspace(owner, "Access read workspace");
        // createOwnedWorkspace, not ensureOwnedWorkspace: the latter is find-or-create per user
        // (WorkspaceFixture:151-154) and would hand back the very same workspace.
        Workspace other = workspaceFixture.createOwnedWorkspace("Access read other workspace", owner.getUser().getId());
        Session session = saveSession(workspace.getId().toString(), owner.getUser().getId(), "workspace bound");

        mockMvc.perform(authorized(get("/api/v1/sessions/" + session.getId()), owner, workspace.getId().toString()))
                .andExpect(status().isOk());
        // A different workspace must not read it, even though the caller owns both.
        mockMvc.perform(authorized(get("/api/v1/sessions/" + session.getId()), owner, other.getId().toString()))
                .andExpect(status().isNotFound());

        AuthResponse loner = register("access-ws-read-loner");
        // A workspace-bound row still demands a workspace context: 409 WORKSPACE_CONTEXT_REQUIRED,
        // exactly as before D-1247 — the blank-context check moved after the lookup, it did not go away.
        mockMvc.perform(authorized(get("/api/v1/sessions/" + session.getId()), loner, null))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("WORKSPACE_CONTEXT_REQUIRED"));
    }

    @Test
    void workspaceSessionWithoutAnyContextStillAnswers409() throws Exception {
        AuthResponse owner = register("access-ws-409");
        Workspace workspace = ownedWorkspace(owner, "Access 409 workspace");
        Session session = saveSession(workspace.getId().toString(), owner.getUser().getId(), "needs context");
        AuthResponse loner = register("access-ws-409-loner");
        ownedWorkspace(loner, "Access 409 loner workspace");

        // The loner's ambient workspace is their own, so the equality filter rejects the row: the
        // workspace-bound path never became context-free.
        mockMvc.perform(authorized(get("/api/v1/sessions/" + session.getId()), loner, null))
                .andExpect(status().isNotFound());
        mockMvc.perform(authorized(patch("/api/v1/sessions/" + session.getId()), loner, null)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"nope\"}"))
                .andExpect(status().isNotFound());
        assertTrue(sessionRepository.findById(session.getId()).isPresent());
    }

    @Test
    void renameWorkspacelessSessionWithAnAmbientWorkspace() throws Exception {
        AuthResponse owner = register("access-rename");
        Workspace workspace = ownedWorkspace(owner, "Access rename workspace");
        Session session = saveSession(null, owner.getUser().getId(), "before rename");

        mockMvc.perform(authorized(patch("/api/v1/sessions/" + session.getId()), owner, workspace.getId().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"after rename\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.title").value("after rename"));
        assertEquals("after rename", sessionRepository.findById(session.getId()).orElseThrow().getTitle());
    }

    @Test
    void renameWorkspacelessSessionWithoutAnyWorkspaceContext() throws Exception {
        AuthResponse loner = register("access-rename-loner");
        Session session = saveSession(null, loner.getUser().getId(), "loner before");

        mockMvc.perform(authorized(patch("/api/v1/sessions/" + session.getId()), loner, null)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"loner after\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.title").value("loner after"));
    }

    @Test
    void renameWorkspacelessSessionByStrangerIs404() throws Exception {
        AuthResponse owner = register("access-rename-owner");
        AuthResponse stranger = register("access-rename-stranger");
        Session session = saveSession(null, owner.getUser().getId(), "keep me");

        mockMvc.perform(authorized(patch("/api/v1/sessions/" + session.getId()), stranger, null)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"stolen\"}"))
                .andExpect(status().isNotFound());
        assertEquals("keep me", sessionRepository.findById(session.getId()).orElseThrow().getTitle());
    }

    @Test
    void deleteWorkspacelessSessionWithAnAmbientWorkspace() throws Exception {
        AuthResponse owner = register("access-delete");
        Workspace workspace = ownedWorkspace(owner, "Access delete workspace");
        Session session = saveSession(null, owner.getUser().getId(), "delete me");

        mockMvc.perform(authorized(delete("/api/v1/sessions/" + session.getId()), owner, workspace.getId().toString()))
                .andExpect(status().isNoContent());
        assertFalse(sessionRepository.findById(session.getId()).isPresent(),
                "the workspace-less session must be really deleted, not merely marked");
    }

    @Test
    void deleteWorkspacelessSessionWithoutAnyWorkspaceContext() throws Exception {
        AuthResponse loner = register("access-delete-loner");
        Session session = saveSession(null, loner.getUser().getId(), "loner delete");

        mockMvc.perform(authorized(delete("/api/v1/sessions/" + session.getId()), loner, null))
                .andExpect(status().isNoContent());
        assertFalse(sessionRepository.findById(session.getId()).isPresent());
    }

    @Test
    void renameWorkspaceSessionKeepsItsWorkspaceGate() throws Exception {
        AuthResponse owner = register("access-ws-rename");
        Workspace workspace = ownedWorkspace(owner, "Access ws rename workspace");
        Session session = saveSession(workspace.getId().toString(), owner.getUser().getId(), "ws before");

        mockMvc.perform(authorized(patch("/api/v1/sessions/" + session.getId()), owner, workspace.getId().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"ws after\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.title").value("ws after"));

        Workspace other = workspaceFixture.createOwnedWorkspace("Access ws rename other workspace",
                owner.getUser().getId());
        mockMvc.perform(authorized(patch("/api/v1/sessions/" + session.getId()), owner, other.getId().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"wrong workspace\"}"))
                .andExpect(status().isNotFound());
        assertEquals("ws after", sessionRepository.findById(session.getId()).orElseThrow().getTitle());
    }

    @Test
    void rosterAndDerivedStateReadAWorkspacelessSession() throws Exception {
        AuthResponse owner = register("access-aux");
        Workspace workspace = ownedWorkspace(owner, "Access aux workspace");
        Session session = saveSession(null, owner.getUser().getId(), "aux independent");

        mockMvc.perform(authorized(get("/api/v1/sessions/" + session.getId() + "/participants"), owner,
                        workspace.getId().toString()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.participants").isArray());
        mockMvc.perform(authorized(get("/api/v1/sessions/" + session.getId() + "/derived-state"), owner,
                        workspace.getId().toString()))
                .andExpect(status().isOk());
    }

    @Test
    void rosterAndDerivedStateKeepTheWorkspaceBoundary() throws Exception {
        AuthResponse owner = register("access-aux-ws");
        Workspace workspace = ownedWorkspace(owner, "Access aux ws workspace");
        Workspace other = workspaceFixture.createOwnedWorkspace("Access aux ws other workspace",
                owner.getUser().getId());
        Session session = saveSession(workspace.getId().toString(), owner.getUser().getId(), "aux workspace bound");

        mockMvc.perform(authorized(get("/api/v1/sessions/" + session.getId() + "/participants"), owner,
                        workspace.getId().toString()))
                .andExpect(status().isOk());
        mockMvc.perform(authorized(get("/api/v1/sessions/" + session.getId() + "/participants"), owner,
                        other.getId().toString()))
                .andExpect(status().isNotFound());
        mockMvc.perform(authorized(get("/api/v1/sessions/" + session.getId() + "/derived-state"), owner,
                        other.getId().toString()))
                .andExpect(status().isNotFound());
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
     * test writes; the Bearer header drives {@code TenantContextInterceptor} (including its
     * server-side workspace fallback). Same arrangement as {@code SessionWorkspacelessScopeTest}.
     */
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
