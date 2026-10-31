package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class TenantContextInterceptorTest {

    private static final String TOKEN = "access-token";
    private static final String USER_ID = "user-1";
    private static final String WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
    private static final String OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

    private JwtTokenProvider jwtTokenProvider;
    private WorkspaceService workspaceService;
    private TenantContextInterceptor interceptor;

    @BeforeEach
    void setUp() {
        jwtTokenProvider = mock(JwtTokenProvider.class);
        workspaceService = mock(WorkspaceService.class);
        interceptor = new TenantContextInterceptor(jwtTokenProvider, workspaceService, new ObjectMapper());

        when(jwtTokenProvider.validateToken(TOKEN)).thenReturn(true);
        when(jwtTokenProvider.getUserIdFromToken(TOKEN)).thenReturn(USER_ID);
        when(jwtTokenProvider.getRoleFromToken(TOKEN)).thenReturn("USER");
        when(workspaceService.isWorkspaceMember(anyString(), eq(USER_ID))).thenReturn(true);
        when(workspaceService.resolveWorkspaceRole(anyString(), eq(USER_ID))).thenReturn("EDITOR");
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    @Test
    void headerWinsOverLegacyClaim() throws Exception {
        when(jwtTokenProvider.getWorkspaceIdFromToken(TOKEN)).thenReturn(OTHER_WORKSPACE_ID);
        MockHttpServletRequest request = request("POST", "/api/v1/chat", WORKSPACE_ID);

        assertTrue(interceptor.preHandle(request, new MockHttpServletResponse(), new Object()));
        assertEquals(WORKSPACE_ID, TenantContext.getWorkspaceId());
        assertEquals("EDITOR", TenantContext.getWorkspaceRole());
    }

    @Test
    void nonMemberHeaderIsForbidden() throws Exception {
        when(workspaceService.isWorkspaceMember(WORKSPACE_ID, USER_ID)).thenReturn(false);
        MockHttpServletResponse response = new MockHttpServletResponse();

        assertFalse(interceptor.preHandle(request("GET", "/api/v1/sessions", WORKSPACE_ID), response, new Object()));
        assertEquals(403, response.getStatus());
        assertTrue(response.getContentAsString().contains("WORKSPACE_FORBIDDEN"));
    }

    @Test
    void viewerCannotWrite() throws Exception {
        when(workspaceService.resolveWorkspaceRole(anyString(), eq(USER_ID))).thenReturn("VIEWER");
        MockHttpServletResponse response = new MockHttpServletResponse();

        assertFalse(interceptor.preHandle(request("POST", "/api/v1/chat", WORKSPACE_ID), response, new Object()));
        assertEquals(403, response.getStatus());
        assertTrue(response.getContentAsString().contains("WORKSPACE_READ_ONLY"));
    }

    @Test
    void editorCannotManageWorkspaceLifecycle() throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();

        assertFalse(interceptor.preHandle(request("PATCH", "/api/v1/workspaces/" + WORKSPACE_ID, WORKSPACE_ID),
                response, new Object()));
        assertEquals(403, response.getStatus());
        assertTrue(response.getContentAsString().contains("WORKSPACE_FORBIDDEN"));
    }

    @Test
    void legacyClaimIsUsedWithoutHeader() throws Exception {
        when(jwtTokenProvider.getWorkspaceIdFromToken(TOKEN)).thenReturn(OTHER_WORKSPACE_ID);
        MockHttpServletRequest request = request("GET", "/api/v1/sessions", null);

        assertTrue(interceptor.preHandle(request, new MockHttpServletResponse(), new Object()));
        assertEquals(OTHER_WORKSPACE_ID, TenantContext.getWorkspaceId());
    }

    @Test
    void malformedHeaderIs400() throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();

        assertFalse(interceptor.preHandle(request("GET", "/api/v1/sessions", "not-a-uuid"), response, new Object()));
        assertEquals(400, response.getStatus());
        assertTrue(response.getContentAsString().contains("INVALID_WORKSPACE_ID"));
    }

    @Test
    void fallsBackToDefaultWorkspaceWithoutHeaderOrClaim() throws Exception {
        Workspace workspace = mock(Workspace.class);
        when(workspace.getId()).thenReturn(UUID.fromString(WORKSPACE_ID));
        when(workspaceService.findCurrentWorkspace(USER_ID)).thenReturn(Optional.of(workspace));

        assertTrue(interceptor.preHandle(request("GET", "/api/v1/sessions", null),
                new MockHttpServletResponse(), new Object()));
        assertEquals(WORKSPACE_ID, TenantContext.getWorkspaceId());
    }

    // ── PLAN-0608 T1.6 / review P1-5: the resolution source must be observable ──
    @Test
    void headerSourceIsRecorded() throws Exception {
        assertTrue(interceptor.preHandle(request("POST", "/api/v1/sessions", WORKSPACE_ID),
                new MockHttpServletResponse(), new Object()));

        assertEquals("header", TenantContext.getWorkspaceSource());
    }

    @Test
    void claimSourceIsRecorded() throws Exception {
        when(jwtTokenProvider.getWorkspaceIdFromToken(TOKEN)).thenReturn(OTHER_WORKSPACE_ID);

        assertTrue(interceptor.preHandle(request("GET", "/api/v1/sessions", null),
                new MockHttpServletResponse(), new Object()));

        assertEquals("claim", TenantContext.getWorkspaceSource());
    }

    @Test
    void defaultSourceIsRecordedForFallback() throws Exception {
        Workspace workspace = mock(Workspace.class);
        when(workspace.getId()).thenReturn(UUID.fromString(WORKSPACE_ID));
        when(workspaceService.findCurrentWorkspace(USER_ID)).thenReturn(Optional.of(workspace));

        assertTrue(interceptor.preHandle(request("POST", "/api/v1/sessions", null),
                new MockHttpServletResponse(), new Object()));

        assertEquals("default", TenantContext.getWorkspaceSource());
    }

    @Test
    void clearResetsTheRecordedSource() throws Exception {
        assertTrue(interceptor.preHandle(request("POST", "/api/v1/sessions", WORKSPACE_ID),
                new MockHttpServletResponse(), new Object()));

        TenantContext.clear();

        assertEquals(null, TenantContext.getWorkspaceSource());
    }

    private MockHttpServletRequest request(String method, String uri, String workspaceHeader) {
        MockHttpServletRequest request = new MockHttpServletRequest(method, uri);
        request.addHeader("Authorization", "Bearer " + TOKEN);
        if (workspaceHeader != null) {
            request.addHeader("X-Workspace-Id", workspaceHeader);
        }
        return request;
    }
}
