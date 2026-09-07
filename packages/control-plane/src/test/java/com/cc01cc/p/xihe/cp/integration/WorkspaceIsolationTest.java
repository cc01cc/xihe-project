package com.cc01cc.p.xihe.cp.integration;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest
@ActiveProfiles("h2")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class WorkspaceIsolationTest {

    @Autowired
    private WebApplicationContext webApplicationContext;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private WorkspaceService workspaceService;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private UserRepository userRepository;

    private MockMvc mockMvc;
    private User userA;
    private User userB;
    private Workspace ws1;
    private Workspace ws2;

    @BeforeEach
    void setUp() throws Exception {
        mockMvc = MockMvcBuilders.webAppContextSetup(webApplicationContext).build();

        String suffix = UUID.randomUUID().toString().substring(0, 8);
        String emailA = "user-a-" + suffix + "@test.com";
        String emailB = "user-b-" + suffix + "@test.com";
        String password = TestDataFactory.PASSWORD;

        registerUser(emailA, password, "User A");
        userA = userRepository.findByEmail(emailA).orElseThrow();
        registerUser(emailB, password, "User B");
        userB = userRepository.findByEmail(emailB).orElseThrow();

        // Registration provisions one default workspace per user; reuse those
        // instead of creating extra workspaces (single-active-workspace policy).
        // User A is then added to user B's workspace as MEMBER to exercise isolation.
        ws1 = workspaceService.findCurrentWorkspace(userA.getId().toString()).orElseThrow();
        ws2 = workspaceService.findCurrentWorkspace(userB.getId().toString()).orElseThrow();
        workspaceUserRepository.save(new WorkspaceUser(ws2.getId().toString(), userA.getId().toString(), WorkspaceRole.MEMBER));
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    @Test
    void sessionWorkspaceIsolation() {
        Session sessionInWs1 = new Session(ws1.getId().toString(), userA.getId().toString(), "Session in WS-1");
        sessionInWs1.setId(UUID.randomUUID());
        sessionRepository.save(sessionInWs1);

        Session sessionInWs2 = new Session(ws2.getId().toString(), userB.getId().toString(), "Session in WS-2");
        sessionInWs2.setId(UUID.randomUUID());
        sessionRepository.save(sessionInWs2);

        List<Session> ws1Sessions = sessionRepository
                .findByWorkspaceIdAndArchivedFalseOrderByCreatedAtDesc(ws1.getId().toString());
        assertEquals(1, ws1Sessions.size());
        assertEquals(sessionInWs1.getTitle(), ws1Sessions.get(0).getTitle());

        List<Session> ws2Sessions = sessionRepository
                .findByWorkspaceIdAndArchivedFalseOrderByCreatedAtDesc(ws2.getId().toString());
        assertEquals(1, ws2Sessions.size());
        assertEquals(sessionInWs2.getTitle(), ws2Sessions.get(0).getTitle());

        assertTrue(ws2Sessions.stream().noneMatch(s -> s.getId().equals(sessionInWs1.getId())));
        assertTrue(ws1Sessions.stream().noneMatch(s -> s.getId().equals(sessionInWs2.getId())));
    }

    @Test
    void tenantContextWorkspaceSwitch() {
        TenantContext.setWorkspaceId(ws1.getId().toString());
        TenantContext.setWorkspaceRole(WorkspaceRole.OWNER.name());

        assertAll("ws-1 context",
            () -> assertEquals(ws1.getId().toString(), TenantContext.getWorkspaceId()),
            () -> assertEquals(WorkspaceRole.OWNER.name(), TenantContext.getWorkspaceRole())
        );

        TenantContext.clear();
        assertNull(TenantContext.getWorkspaceId());
        assertNull(TenantContext.getWorkspaceRole());

        TenantContext.setWorkspaceId(ws2.getId().toString());
        TenantContext.setWorkspaceRole(WorkspaceRole.MEMBER.name());

        assertAll("ws-2 context",
            () -> assertEquals(ws2.getId().toString(), TenantContext.getWorkspaceId()),
            () -> assertEquals(WorkspaceRole.MEMBER.name(), TenantContext.getWorkspaceRole())
        );

        TenantContext.clear();
    }

    @Test
    void workspaceRoleResolution() {
        String roleA = workspaceService.resolveWorkspaceRole(ws1.getId().toString(), userA.getId().toString());
        assertEquals(WorkspaceRole.OWNER.name(), roleA);

        String roleB = workspaceService.resolveWorkspaceRole(ws2.getId().toString(), userB.getId().toString());
        assertEquals(WorkspaceRole.OWNER.name(), roleB);

        // user-a is a member of ws-2 (added in setUp) but not the owner.
        String roleAInWs2 = workspaceService.resolveWorkspaceRole(ws2.getId().toString(), userA.getId().toString());
        assertEquals(WorkspaceRole.MEMBER.name(), roleAInWs2);

        // user-b is not a member of ws-1.
        assertNull(workspaceService.resolveWorkspaceRole(ws1.getId().toString(), userB.getId().toString()));
    }

    @Test
    void memberCannotAccessOwnerWorkspace() {
        String roleB = workspaceService.resolveWorkspaceRole(ws1.getId().toString(), userB.getId().toString());
        assertNull(roleB, "user-b should have no role in ws-1");
    }

    @Test
    void jwtTokenWithWorkspaceContextIsValid() {
        String token = TestDataFactory.createWorkspaceToken(
                userA.getId().toString(), "user-a@test.com", "USER", ws1.getId().toString());
        assertNotNull(token);
        assertTrue(TestDataFactory.tokenProvider().validateToken(token));
        assertEquals(userA.getId().toString(), TestDataFactory.tokenProvider().getUserIdFromToken(token));
        assertEquals(ws1.getId().toString(), TestDataFactory.tokenProvider().getWorkspaceIdFromToken(token));
    }

    @Test
    void registeredUserTokenHasDefaultWorkspace() throws Exception {
        String suffix = UUID.randomUUID().toString().substring(0, 8);
        String email = "token-null-ws-" + suffix + "@test.com";
        String token = registerAndExtractToken(email, TestDataFactory.PASSWORD, "Token Test");
        assertNotNull(token);
        assertTrue(TestDataFactory.tokenProvider().validateToken(token));
        assertNotNull(TestDataFactory.tokenProvider().getWorkspaceIdFromToken(token));
    }

    @Test
    void crossWorkspaceSessionQueryReturnsEmpty() {
        Session sessionInWs1 = new Session(ws1.getId().toString(), userA.getId().toString(), "WS-1 exclusive");
        sessionInWs1.setId(UUID.randomUUID());
        sessionRepository.save(sessionInWs1);

        List<Session> ws2Sessions = sessionRepository
                .findByWorkspaceIdAndArchivedFalseOrderByCreatedAtDesc(ws2.getId().toString());
        Optional<String> matched = ws2Sessions.stream()
                .map(s -> s.getId().toString())
                .filter(id -> id.equals(sessionInWs1.getId().toString()))
                .findAny();
        assertTrue(matched.isEmpty(), "ws-2 query must not return sessions from ws-1");
    }

    private void registerUser(String email, String password, String name) throws Exception {
        RegisterRequest request = new RegisterRequest(email, password, name);
        mockMvc.perform(post("/api/v1/auth/register")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(request)))
                .andExpect(status().isCreated());
    }

    private String registerAndExtractToken(String email, String password, String name) throws Exception {
        RegisterRequest request = new RegisterRequest(email, password, name);
        String json = mockMvc.perform(post("/api/v1/auth/register")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(request)))
                .andExpect(status().isCreated())
                .andReturn()
                .getResponse()
                .getContentAsString();
        return objectMapper.readValue(json, AuthResponse.class).getAccessToken();
    }
}
