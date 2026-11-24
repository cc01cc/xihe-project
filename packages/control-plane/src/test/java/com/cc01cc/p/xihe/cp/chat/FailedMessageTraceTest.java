package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.cc01cc.p.xihe.cp.service.SessionParticipantService;
import com.cc01cc.p.xihe.cp.support.TestAgentPrincipals;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-931 (D-1934 / R65): a failed send must leave a trace instead of disappearing.
 *
 * <p>The user Message commits in its own transaction before admission; a downstream
 * {@code LLM_NOT_CONFIGURED} then becomes a terminal failed Run linked to that Message. The
 * public read path must still return the Message (and its failure code), while an internal wake
 * instruction stays hidden. A retry of the same turn reuses the Message row — it never inserts a
 * second copy.</p>
 */
class FailedMessageTraceTest extends AbstractIntegrationTest {

    @Autowired
    private ChatSubmissionService submissionService;
    @Autowired
    private MessageRepository messageRepository;
    @Autowired
    private ChatRunRepository chatRunRepository;
    @Autowired
    private MessageReadService messageReadService;
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
                           ProviderConnection connection, Session session, String branchId) {}

    private Fixture fixture(String prefix) {
        User user = userRepository.save(new User(prefix + "-" + UUID.randomUUID() + "@test.com",
                "hash", prefix));
        Workspace workspace = workspaceFixture.createOwnedWorkspace(prefix + " Workspace",
                user.getId().toString());
        ProviderConnection connection = ChatBindingTestSupport.ensureChatConnection(
                providerConnectionRepository, "USER", user.getId().toString(),
                "trace-" + UUID.randomUUID());
        AgentPrincipal principal = TestAgentPrincipals.newUserAgentPrincipal();
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

        Session session = new Session(workspace.getId().toString(), user.getId().toString(), "trace");
        session.setId(UUID.randomUUID());
        session.setAgentPermissionsSnapshot(objectMapper.createArrayNode());
        Session saved = sessionRepository.saveAndFlush(session);
        sessionParticipantService.ensurePrimaryParticipant(saved.getId(),
                principal.getId().toString());
        ChatBindingTestSupport.bind(saved, connection, apiRequestTemplates);
        saved.setModelProvider(null);
        saved.setModelName(null);
        saved.setProviderConnectionId(null);
        saved.setConnectionRevision(null);
        saved = sessionRepository.saveAndFlush(saved);
        String branchId = branchPathService.ensureRootBranchId(saved.getId().toString());
        return new Fixture(user, workspace, principal, connection, saved, branchId);
    }

    private ChatSubmissionService.Submission submit(Fixture fixture, String content) {
        String runId = UUID.randomUUID().toString();
        return submissionService.create(runId, fixture.session().getId().toString(),
                fixture.user().getId().toString(), fixture.workspace().getId().toString(),
                fixture.branchId(), "idem-" + runId, "request-hash", null, null, "none", null, null,
                "lease-owner", UUID.randomUUID().toString(), content, "[]", List.of());
    }

    private List<Map<String, Object>> listMessages(Fixture fixture) {
        BranchPathService.BranchVisibility visibility = branchPathService.resolveVisibility(
                fixture.session().getId().toString(), fixture.branchId());
        String rootBranchId = branchPathService.resolvePath(
                fixture.session().getId().toString(), fixture.branchId());
        return messageReadService.listVisibleMessages(fixture.session().getId().toString(),
                fixture.workspace().getId().toString(), rootBranchId, visibility);
    }

    @Test
    void failedSendKeepsTheUserMessageAndExposesTheFailureAfterReload() {
        Fixture fixture = fixture("trace-fail");
        // An unbound Session with no resolvable model: admission fails *after* the user Message
        // committed, with the same code the live incident produced.
        fixture.principal().setDefaultModelProvider(null);
        fixture.principal().setDefaultModelName(null);
        agentPrincipalRepository.saveAndFlush(fixture.principal());

        String runId = UUID.randomUUID().toString();
        CpApiException refused = assertThrows(CpApiException.class, () -> {
            submissionService.create(runId, fixture.session().getId().toString(),
                    fixture.user().getId().toString(), fixture.workspace().getId().toString(),
                    fixture.branchId(), "idem-fail-" + runId, "request-hash", null, null, "none",
                    null, null, "lease-owner", UUID.randomUUID().toString(), "hello trace", "[]",
                    List.of());
        });
        assertEquals("LLM_NOT_CONFIGURED", refused.getCode());

        List<Message> stored = messageRepository.findBySessionIdOrderByCreatedAtAsc(
                fixture.session().getId().toString());
        assertEquals(1, stored.size(), "the user input must survive the failed admission");
        assertEquals("hello trace", stored.get(0).getContent());
        assertEquals(Message.VISIBILITY_USER, stored.get(0).getVisibility());

        ChatRun failedRun = chatRunRepository.findById(UUID.fromString(runId)).orElseThrow();
        assertEquals("failed", failedRun.getStatus());
        assertEquals("LLM_NOT_CONFIGURED", failedRun.getErrorCode());
        assertEquals("error", failedRun.getTerminalOutcome());
        assertNotNull(failedRun.getErrorDetail());
        assertEquals(stored.get(0).getId().toString(), failedRun.getUserMessageId());
        assertEquals(runId, stored.get(0).getRunId());

        List<Map<String, Object>> listed = listMessages(fixture);
        assertEquals(1, listed.size(), "reload must still show exactly the user's message");
        Map<String, Object> row = listed.get(0);
        assertEquals("hello trace", row.get("content"));
        assertEquals("failed", row.get("runStatus"));
        assertEquals("LLM_NOT_CONFIGURED", row.get("errorCode"));
        assertNotNull(row.get("errorDetail"));

        // The visibility filter must not start leaking internal wake instructions just because
        // failure traces are now durable.
        Message wake = new Message(fixture.session().getId().toString(), MessageRole.USER,
                "[mention wake] respond to the conversation.");
        wake.setVisibility(Message.VISIBILITY_INTERNAL);
        wake.setBranchId(fixture.branchId());
        wake.setRunId(runId);
        messageRepository.saveAndFlush(wake);

        List<Map<String, Object>> afterWake = listMessages(fixture);
        assertEquals(1, afterWake.size());
        assertTrue(afterWake.stream().noneMatch(message ->
                String.valueOf(message.get("content")).contains("mention wake")));
    }

    @Test
    void retryReusesTheFailedMessageInsteadOfInsertingASecondCopy() {
        Fixture fixture = fixture("trace-retry");
        fixture.principal().setDefaultModelProvider(null);
        fixture.principal().setDefaultModelName(null);
        agentPrincipalRepository.saveAndFlush(fixture.principal());

        String failedRunId = UUID.randomUUID().toString();
        assertThrows(CpApiException.class, () -> {
            submissionService.create(failedRunId, fixture.session().getId().toString(),
                    fixture.user().getId().toString(), fixture.workspace().getId().toString(),
                    fixture.branchId(), "idem-first-" + failedRunId, "request-hash", null, null,
                    "none", null, null, "lease-owner", UUID.randomUUID().toString(), "retry me",
                    "[]", List.of());
        });
        Message failedMessage = messageRepository.findBySessionIdOrderByCreatedAtAsc(
                fixture.session().getId().toString()).get(0);
        assertEquals(failedRunId, failedMessage.getRunId());

        fixture.principal().setDefaultModelProvider(fixture.connection().getProviderId());
        fixture.principal().setDefaultModelName("wire-model");
        agentPrincipalRepository.saveAndFlush(fixture.principal());

        String retryRunId = UUID.randomUUID().toString();
        ChatSubmissionService.Submission retried = submissionService.create(retryRunId,
                fixture.session().getId().toString(), fixture.user().getId().toString(),
                fixture.workspace().getId().toString(), fixture.branchId(),
                "idem-retry-" + retryRunId, "request-hash", null, null, "none", null, null,
                "lease-owner", UUID.randomUUID().toString(), "retry me", "[]", List.of());

        assertEquals(failedMessage.getId(), retried.userMessage().getId(),
                "retry must rebind the existing Message, not insert a duplicate");
        assertEquals(retryRunId, retried.userMessage().getRunId());
        assertEquals(1, messageRepository.findBySessionIdOrderByCreatedAtAsc(
                fixture.session().getId().toString()).size(),
                "the conversation still has exactly one copy of the user's words");
        assertEquals("accepted", retried.run().getStatus());
    }
}
