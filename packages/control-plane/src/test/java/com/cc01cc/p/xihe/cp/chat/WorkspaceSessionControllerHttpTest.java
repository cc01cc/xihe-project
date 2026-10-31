package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.AccessTokenAuthenticator;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.config.TenantContextInterceptor;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.Optional;
import java.util.UUID;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * PLAN-0608 C′ (M1, review P1): HTTP-level role matrix for the path-addressed
 * session route.
 *
 * <p>Both pure-unit classes (resolver, interceptor) missed this bug because
 * neither assembles interceptor + controller + service into one request. The two
 * role mismatches this test pins:
 *
 * <ul>
 *   <li>VIEWER in the fallback workspace but EDITOR in the path workspace must
 *       <b>succeed</b> — the context role must not veto the path workspace;</li>
 *   <li>EDITOR in the fallback workspace but VIEWER in the path workspace must be
 *       <b>rejected</b> — a read-only workspace must never gain a session.</li>
 * </ul>
 */
class WorkspaceSessionControllerHttpTest {

    private static final String TOKEN = "access-token";
    private static final String USER_ID = "11111111-1111-4111-8111-111111111111";
    private static final String FALLBACK_WS = "22222222-2222-4222-8222-222222222222";
    private static final String TARGET_WS = "33333333-3333-4333-8333-333333333333";
    private static final String PRINCIPAL_ID = "44444444-4444-4444-8444-444444444444";
    private static final String BODY = "{\"agentPrincipalId\":\"" + PRINCIPAL_ID + "\"}";

    private WorkspaceService workspaceService;
    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        JwtTokenProvider jwt = mock(JwtTokenProvider.class);
        when(jwt.validateToken(TOKEN)).thenReturn(true);
        when(jwt.getUserIdFromToken(TOKEN)).thenReturn(USER_ID);
        when(jwt.getRoleFromToken(TOKEN)).thenReturn("USER");
        when(jwt.getWorkspaceIdFromToken(TOKEN)).thenReturn(null);
        // PLAN-0580 decision #21: the interceptor takes userId/role from the shared
        // epoch-checking authenticator, so the test stubs that boundary instead.
        AccessTokenAuthenticator authenticator = mock(AccessTokenAuthenticator.class);
        when(authenticator.authenticate(TOKEN)).thenReturn(Optional.of(
                new AccessTokenAuthenticator.AuthenticatedUser(USER_ID, "USER", 1)));

        workspaceService = mock(WorkspaceService.class);
        when(workspaceService.isWorkspaceMember(anyString(), eq(USER_ID))).thenReturn(true);
        when(workspaceService.requireContextWorkspace(anyString(), eq(USER_ID)))
                .thenAnswer(invocation -> invocation.getArgument(0));
        Workspace fallback = mock(Workspace.class);
        when(fallback.getId()).thenReturn(UUID.fromString(FALLBACK_WS));
        when(workspaceService.findCurrentWorkspace(USER_ID)).thenReturn(Optional.of(fallback));

        SessionService sessionService = mock(SessionService.class);
        when(sessionService.createAgentSession(any(), any(), any(), any(), any(), any(), any(), any()))
                .thenAnswer(invocation -> {
                    Session session = new Session(invocation.getArgument(1), invocation.getArgument(0), "t");
                    session.setId(UUID.randomUUID());
                    session.setAgentPrincipalId(invocation.getArgument(6));
                    return session;
                });

        SessionCreationService creationService = new SessionCreationService(sessionService, workspaceService);
        TenantContextInterceptor interceptor =
                new TenantContextInterceptor(jwt, authenticator, workspaceService, new ObjectMapper());
        mockMvc = MockMvcBuilders.standaloneSetup(new WorkspaceSessionController(creationService))
                .addInterceptors(interceptor)
                .build();
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    @Test
    void viewerInFallbackButEditorInPathWorkspaceCanCreate() throws Exception {
        when(workspaceService.resolveWorkspaceRole(FALLBACK_WS, USER_ID)).thenReturn("VIEWER");
        when(workspaceService.resolveWorkspaceRole(TARGET_WS, USER_ID)).thenReturn("EDITOR");

        // Before the fix the context (fallback) role vetoed this with 403 WORKSPACE_READ_ONLY.
        perform(TARGET_WS, null)
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.workspaceId").value(TARGET_WS));
    }

    @Test
    void editorInFallbackButViewerInPathWorkspaceCannotCreate() throws Exception {
        when(workspaceService.resolveWorkspaceRole(FALLBACK_WS, USER_ID)).thenReturn("EDITOR");
        when(workspaceService.resolveWorkspaceRole(TARGET_WS, USER_ID)).thenReturn("VIEWER");

        // Before the fix the context (fallback) role let this write into a read-only workspace.
        perform(TARGET_WS, null)
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("WORKSPACE_READ_ONLY"));
    }

    @Test
    void viewerInTargetWorkspaceCannotCreateEvenWhenHeaderMatches() throws Exception {
        when(workspaceService.resolveWorkspaceRole(FALLBACK_WS, USER_ID)).thenReturn("EDITOR");
        when(workspaceService.resolveWorkspaceRole(TARGET_WS, USER_ID)).thenReturn("VIEWER");

        perform(TARGET_WS, TARGET_WS)
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("WORKSPACE_READ_ONLY"));
    }

    @Test
    void editorInTargetWorkspaceCanCreateWhenHeaderMatches() throws Exception {
        when(workspaceService.resolveWorkspaceRole(FALLBACK_WS, USER_ID)).thenReturn("VIEWER");
        when(workspaceService.resolveWorkspaceRole(TARGET_WS, USER_ID)).thenReturn("EDITOR");

        perform(TARGET_WS, TARGET_WS)
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.workspaceId").value(TARGET_WS));
    }

    private ResultActions perform(String pathWorkspaceId, String headerWorkspaceId) throws Exception {
        MockHttpServletRequestBuilder request = post("/api/v1/workspaces/{workspaceId}/sessions", pathWorkspaceId)
                .header("Authorization", "Bearer " + TOKEN)
                .contentType(MediaType.APPLICATION_JSON)
                .content(BODY);
        if (headerWorkspaceId != null) {
            request.header("X-Workspace-Id", headerWorkspaceId);
        }
        return mockMvc.perform(request);
    }
}

