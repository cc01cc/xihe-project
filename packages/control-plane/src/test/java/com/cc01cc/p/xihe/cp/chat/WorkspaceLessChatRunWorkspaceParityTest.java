package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.SessionBranchRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;

/**
 * PLAN-0647 V8 (D-678): run/session workspace parity INCLUDING null. There is no "one null, one
 * non-null" pair: a pure-chat Run carries the Session's NULL, a workspace Run carries the same
 * non-null workspace. The scan also covers every pre-existing row in the class database.
 */
class WorkspaceLessChatRunWorkspaceParityTest extends AbstractIntegrationTest {

    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private SessionRepository sessions;
    @Autowired private SessionBranchRepository branches;
    @Autowired private ChatRunRepository chatRuns;
    @Autowired private ChatSubmissionService chatSubmissionService;
    @Autowired private ProviderConnectionRepository providerConnections;
    @Autowired private AgentPrincipalRepository principals;
    @Autowired private WorkspaceAgentRepository workspaceAgents;
    @Autowired private com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService apiRequestTemplates;

    private String userId;
    private String workspaceId;
    private String principalId;
    private String connectionId;

    @BeforeEach
    void fixture() {
        AuthResponse owner = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new RegisterRequest("parity-" + UUID.randomUUID() + "@test.com",
                        TestDataFactory.PASSWORD, "parity"), AuthResponse.class).getBody();
        assertNotNull(owner);
        userId = owner.getUser().getId();
        workspaceId = workspaceFixture.createOwnedWorkspace("parity ws", userId).getId().toString();
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("ParityAgent");
        principal.setCreatedByUserId(userId);
        principal.setOwnerUserId(UUID.fromString(userId));
        principalId = principals.save(principal).getId().toString();
        workspaceAgents.saveAndFlush(new com.cc01cc.p.xihe.cp.entity.WorkspaceAgent(
                principalId, workspaceId, com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.arrayNode()));
        ProviderConnection connection = ChatBindingTestSupport.ensureChatConnection(
                providerConnections, "USER", userId, "parity-" + UUID.randomUUID());
        connectionId = connection.getId().toString();
    }

    @Test
    void workspaceLessRunAndSessionAreBothNull() {
        Session session = new Session(null, userId, "pure chat parity");
        session.setId(UUID.randomUUID());
        ChatBindingTestSupport.bindNewChatConnection(session, providerConnections, apiRequestTemplates, userId);
        sessions.saveAndFlush(session);
        sessionParticipantService.ensurePrimaryParticipant(session.getId(), principalId);
        ProviderConnection connection = providerConnections.findById(
                UUID.fromString(session.getProviderConnectionId())).orElseThrow();
        String runId = UUID.randomUUID().toString();
        chatSubmissionService.create(runId, session.getId().toString(), userId, null,
                branches.findBySessionIdAndParentBranchIdIsNull(session.getId().toString()).orElseThrow()
                        .getId().toString(), UUID.randomUUID().toString(), "a".repeat(64),
                connection.getProviderId(), "gpt-test", "none", session.getProviderConnectionId(),
                connection.getRevision(), null, "req-parity-null", "hi", null, List.of(), null, null);
        assertNullPair(session.getId().toString(), runId);
    }

    @Test
    void workspaceRunAndSessionCarryTheSameNonNullWorkspace() {
        Session session = new Session(workspaceId, userId, "ws parity");
        session.setId(UUID.randomUUID());
        session.setAgentPermissionsSnapshot(com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.arrayNode());
        ChatBindingTestSupport.bindNewChatConnection(session, providerConnections, apiRequestTemplates, userId);
        sessions.saveAndFlush(session);
        sessionParticipantService.ensurePrimaryParticipant(session.getId(), principalId);
        ProviderConnection connection = providerConnections.findById(UUID.fromString(
                session.getProviderConnectionId())).orElseThrow();
        String runId = UUID.randomUUID().toString();
        chatSubmissionService.create(runId, session.getId().toString(), userId, workspaceId,
                branches.findBySessionIdAndParentBranchIdIsNull(session.getId().toString()).orElseThrow()
                        .getId().toString(), UUID.randomUUID().toString(), "b".repeat(64),
                connection.getProviderId(), "gpt-test", "none",
                session.getProviderConnectionId(), connection.getRevision(), null,
                "req-parity-ws", "hi", null, List.of(), null, null);
        Session reloaded = sessions.findById(session.getId()).orElseThrow();
        var run = chatRuns.findById(UUID.fromString(runId)).orElseThrow();
        assertNotNull(reloaded.getWorkspaceId());
        assertEquals(reloaded.getWorkspaceId(), run.getWorkspaceId(),
                "V8: a workspace run carries the session's non-null workspace");
    }

    @Test
    void noRowInTheDatabaseHasAMismatchedWorkspacePair() {
        for (var run : chatRuns.findAll()) {
            var session = sessions.findById(UUID.fromString(run.getSessionId())).orElse(null);
            if (session == null) {
                continue;
            }
            assertEquals(java.util.Objects.toString(session.getWorkspaceId(), null),
                    java.util.Objects.toString(run.getWorkspaceId(), null),
                    "V8: run/session workspace must be identical (null included) for run " + run.getId());
        }
    }

    private void assertNullPair(String sessionId, String runId) {
        Session session = sessions.findById(UUID.fromString(sessionId)).orElseThrow();
        var run = chatRuns.findById(UUID.fromString(runId)).orElseThrow();
        assertEquals(null, session.getWorkspaceId(), "pure-chat session workspace is null");
        assertEquals(null, run.getWorkspaceId(), "V8: pure-chat run workspace is null (no fallback)");
        assertFalse(chatRuns.findBySessionIdOrderByCreatedAtDescIdDesc(sessionId,
                org.springframework.data.domain.Pageable.ofSize(10)).isEmpty());
    }
}
