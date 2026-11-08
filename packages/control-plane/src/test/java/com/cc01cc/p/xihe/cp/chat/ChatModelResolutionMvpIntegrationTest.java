package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.cc01cc.p.xihe.cp.service.SessionParticipantService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * PLAN-0642 MVP V1/V2 (delta 档，L0): an unbound Session resolves its model at run time and writes
 * the resolution to {@code chat_runs} only (Session columns stay NULL); a bound Session keeps the
 * revision fail-closed gate.
 *
 * <p>Scope note (B-3 pending): the public {@code ChatRequest.provider/model} legacy hint is not
 * implemented, so the conservative default is "ignored" and no wire semantics change.</p>
 */
class ChatModelResolutionMvpIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private ChatSubmissionService submissionService;
    @Autowired
    private SessionRepository sessionRepository;
    @Autowired
    private ProviderConnectionRepository providerConnectionRepository;
    @Autowired
    private AgentPrincipalRepository agentPrincipalRepository;
    @Autowired
    private WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired
    private UserRepository userRepository;
    @Autowired
    private WorkspaceFixture workspaceFixture;
    @Autowired
    private ApiRequestTemplateService apiRequestTemplates;
    @Autowired
    private SessionParticipantService sessionParticipantService;
    @Autowired
    private BranchPathService branchPathService;
    @Autowired
    private ObjectMapper objectMapper;

    private record Fixture(User user, Workspace workspace, AgentPrincipal principal,
                           ProviderConnection connection) {}

    private Fixture fixture(String prefix) {
        User user = userRepository.save(new User(prefix + "-" + UUID.randomUUID() + "@test.com",
                "hash", prefix));
        Workspace workspace = workspaceFixture.createOwnedWorkspace(prefix + " Workspace",
                user.getId().toString());
        ProviderConnection connection = ChatBindingTestSupport.ensureChatConnection(
                providerConnectionRepository, "USER", user.getId().toString(),
                "mvp-" + UUID.randomUUID());
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName(prefix + " principal");
        principal.setCreatedByUserId(user.getId().toString());
        var snapshot = objectMapper.createObjectNode();
        snapshot.set("permissions", objectMapper.createArrayNode());
        principal.setTemplateSnapshot(snapshot);
        principal.setDefaultModelProvider(connection.getProviderId());
        principal.setDefaultModelName("wire-model");
        principal = agentPrincipalRepository.saveAndFlush(principal);
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principal.getId().toString(),
                workspace.getId().toString(), objectMapper.createArrayNode()));
        return new Fixture(user, workspace, principal, connection);
    }

    /** Creates a Session whose context-template triple is pinned but whose model four columns are NULL. */
    private Session unboundSession(Fixture fixture) {
        Session session = new Session(fixture.workspace().getId().toString(),
                fixture.user().getId().toString(), "unbound");
        session.setId(UUID.randomUUID());
        session.setAgentPermissionsSnapshot(objectMapper.createArrayNode());
        Session saved = sessionRepository.saveAndFlush(session);
        sessionParticipantService.ensurePrimaryParticipant(saved.getId(),
                fixture.principal().getId().toString());
        ChatBindingTestSupport.bind(saved, fixture.connection(), apiRequestTemplates);
        saved.setModelProvider(null);
        saved.setModelName(null);
        saved.setProviderConnectionId(null);
        saved.setConnectionRevision(null);
        return sessionRepository.saveAndFlush(saved);
    }

    private Session boundSession(Fixture fixture) {
        Session session = new Session(fixture.workspace().getId().toString(),
                fixture.user().getId().toString(), "bound");
        session.setId(UUID.randomUUID());
        session.setAgentPermissionsSnapshot(objectMapper.createArrayNode());
        Session saved = sessionRepository.saveAndFlush(session);
        sessionParticipantService.ensurePrimaryParticipant(saved.getId(),
                fixture.principal().getId().toString());
        ChatBindingTestSupport.bind(saved, fixture.connection(), apiRequestTemplates);
        return sessionRepository.saveAndFlush(saved);
    }

    private ChatSubmissionService.Submission submit(Fixture fixture, Session session, String content) {
        String runId = UUID.randomUUID().toString();
        String branchId = branchPathService.ensureRootBranchId(session.getId().toString());
        return submissionService.create(runId, session.getId().toString(),
                fixture.user().getId().toString(), fixture.workspace().getId().toString(), branchId,
                "idem-" + runId, "request-hash", null, null, "none", null, null,
                "lease-owner", UUID.randomUUID().toString(), content, "[]", List.of());
    }

    @Test
    void unboundSessionResolvesFromThePrimaryIntentAndWritesOnlyTheRun() {
        Fixture fixture = fixture("mvp-v1");
        Session session = unboundSession(fixture);
        com.cc01cc.p.xihe.cp.entity.ChatRun run = submit(fixture, session, "hello").run();
        assertEquals(fixture.connection().getProviderId(), run.getProvider());
        assertEquals("wire-model", run.getModel());
        assertEquals(fixture.connection().getId().toString(), run.getProviderConnectionId());
        assertEquals(fixture.connection().getRevision(), run.getConnectionRevision());

        Session reloaded = sessionRepository.findById(session.getId()).orElseThrow();
        assertNull(reloaded.getModelProvider(), "resolution is never written back to the Session");
        assertNull(reloaded.getModelName());
        assertNull(reloaded.getProviderConnectionId());
        assertNull(reloaded.getConnectionRevision());
    }

    @Test
    void unboundSessionWithoutAnyResolvableModelFailsClosedWithTheReusedCode() {
        Fixture fixture = fixture("mvp-v1-negative");
        Session session = unboundSession(fixture);
        fixture.principal().setDefaultModelProvider(null);
        fixture.principal().setDefaultModelName(null);
        agentPrincipalRepository.saveAndFlush(fixture.principal());
        CpApiException refused = assertThrows(CpApiException.class,
                () -> submit(fixture, session, "hello"));
        assertEquals("LLM_NOT_CONFIGURED", refused.getCode());
        assertNotNull(refused.getMessage());
    }

    @Test
    void boundSessionKeepsTheRevisionFailClosedGateAndUnboundIgnoresIt() {
        Fixture fixture = fixture("mvp-v2");
        Session bound = boundSession(fixture);
        submit(fixture, bound, "first");
        fixture.connection().setRevision(2L);
        providerConnectionRepository.saveAndFlush(fixture.connection());
        CpApiException refused = assertThrows(CpApiException.class,
                () -> submit(fixture, bound, "after revision drift"));
        assertEquals("API_TYPE_REBIND_REQUIRED", refused.getCode());
        assertEquals("connection_revision_changed", refused.getExtra().get("reason"));

        Session unbound = unboundSession(fixture);
        com.cc01cc.p.xihe.cp.entity.ChatRun run = submit(fixture, unbound, "unbound after drift").run();
        assertEquals(2L, run.getConnectionRevision(),
                "an unbound Session resolves the current revision at run time");
    }
}
