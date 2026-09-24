package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.File;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ChatSpawnSubmissionIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private ChatSubmissionService submissionService;

    @Autowired
    private OperationService operationService;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private FileRepository fileRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private AgentPrincipalRepository agentPrincipalRepository;

    @Autowired
    private WorkspaceAgentRepository workspaceAgentRepository;

    @Autowired
    private ObjectMapper objectMapper;

    private String userId;
    private String workspaceId;
    private UUID principalId;
    private final List<UUID> sessionIds = new ArrayList<>();
    private final List<UUID> fileIds = new ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        sessionIds.forEach(sessionRepository::deleteById);
        fileRepository.deleteAllById(fileIds);
        if (principalId != null && workspaceId != null) {
            workspaceAgentRepository.deleteById(new WorkspaceAgentId(principalId, UUID.fromString(workspaceId)));
            agentPrincipalRepository.deleteById(principalId);
        }
        if (workspaceId != null) {
            workspaceRepository.deleteById(UUID.fromString(workspaceId));
        }
        if (userId != null) {
            userRepository.deleteById(UUID.fromString(userId));
        }
    }

    @Test
    void spawnCreationBypassesSseGateAndSerializesDuplicateEvents() throws Exception {
        User user = userRepository.save(new User("spawn-" + UUID.randomUUID() + "@test.com",
                "hash", UserRole.USER, "Spawn test"));
        userId = user.getId().toString();
        Workspace workspace = workspaceRepository.save(new Workspace("Spawn test", userId));
        workspaceId = workspace.getId().toString();
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("Spawn test principal");
        principal.setCreatedByUserId(userId);
        var snapshot = objectMapper.createObjectNode();
        snapshot.set("permissions", objectMapper.createArrayNode());
        principal.setTemplateSnapshot(snapshot);
        principal = agentPrincipalRepository.saveAndFlush(principal);
        principalId = principal.getId();
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principalId.toString(), workspaceId,
                objectMapper.createArrayNode()));

        Session parentSession = saveSession(workspaceId, userId, "Parent");
        String parentRunId = UUID.randomUUID().toString();
        ChatRun parentRun = chatRunRepository.saveAndFlush(new ChatRun(
                parentRunId, parentSession.getId().toString(), userId, workspaceId,
                "parent-submit", "parent-hash", "provider", "model", "workspace", "running"));
        OperationService.OperationStartResult parentOperation = operationService.startOperation(
                userId, parentSession.getId().toString(), workspaceId, parentRunId, UUID.randomUUID().toString(),
                "chat", "ui", "user", userId, "parent-submit", "Parent chat");
        OperationItem spawnEvent = operationService.appendItem(parentOperation.operationId(),
                UUID.randomUUID().toString(), null, "tool_call", "spawn_agent", "agent", "{}", null, null);

        Session childSession = saveChildSession(workspaceId, userId, parentSession, parentRun);
        File parentAttachment = new File(userId, "parent.txt", "unused-test-path");
        parentAttachment.setWorkspaceId(workspaceId);
        parentAttachment.setSessionId(parentSession.getId().toString());
        parentAttachment.setMimeType("text/plain");
        parentAttachment.setSizeBytes(1L);
        File savedAttachment = fileRepository.save(parentAttachment);
        fileIds.add(savedAttachment.getId());
        CpApiException attachmentError = assertThrows(CpApiException.class, () -> submissionService.createSpawn(
                spawnRequest(childSession, parentSession, parentRun, spawnEvent,
                        "child instruction", List.of(savedAttachment.getId().toString()))));
        assertEquals("FORBIDDEN", attachmentError.getCode());

        ChatSubmissionService.SpawnSubmission firstRequest = spawnRequest(
                childSession, parentSession, parentRun, spawnEvent);

        Session competingChildSession = saveChildSession(workspaceId, userId, parentSession, parentRun);
        ChatSubmissionService.SpawnSubmission secondRequest = spawnRequest(
                competingChildSession, parentSession, parentRun, spawnEvent);

        ExecutorService executor = Executors.newFixedThreadPool(2);
        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch start = new CountDownLatch(1);
        Future<ChatSubmissionService.Submission> firstFuture = executor.submit(() -> {
            ready.countDown();
            if (!start.await(5, TimeUnit.SECONDS)) {
                throw new IllegalStateException("concurrent spawn test did not release start barrier");
            }
            return submissionService.createSpawn(firstRequest);
        });
        Future<ChatSubmissionService.Submission> secondFuture = executor.submit(() -> {
            ready.countDown();
            if (!start.await(5, TimeUnit.SECONDS)) {
                throw new IllegalStateException("concurrent spawn test did not release start barrier");
            }
            return submissionService.createSpawn(secondRequest);
        });
        assertTrue(ready.await(5, TimeUnit.SECONDS), "both duplicate requests must reach the start barrier");
        start.countDown();
        ChatSubmissionService.Submission first;
        ChatSubmissionService.Submission second;
        try {
            first = firstFuture.get(15, TimeUnit.SECONDS);
            second = secondFuture.get(15, TimeUnit.SECONDS);
        } finally {
            executor.shutdownNow();
        }

        assertEquals(first.run().getId(), second.run().getId());
        assertEquals(first.operation().operationId(), second.operation().operationId());
        assertTrue(first.operation().alreadyRecorded() ^ second.operation().alreadyRecorded());
        ChatSubmissionService.Submission created = first.operation().alreadyRecorded() ? second : first;
        assertEquals(ChatRun.ORIGIN_SPAWN, created.run().getOrigin());
        assertEquals(spawnEvent.getId().toString(), created.run().getIdempotencyKey());
        assertTrue(List.of(childSession.getId().toString(), competingChildSession.getId().toString())
                .contains(created.run().getSessionId()));
        assertEquals("child instruction", created.userMessage().getContent());
        assertFalse(created.operation().alreadyRecorded());

        assertThrows(CpApiException.class, () -> submissionService.createSpawn(
                spawnRequest(childSession, parentSession, parentRun, spawnEvent, "different child instruction")));

        Session mismatchedChild = saveChildSession(workspaceId, userId, parentSession, parentRun);
        mismatchedChild.setSpawnedFromRunId(UUID.randomUUID());
        sessionRepository.save(mismatchedChild);
        assertThrows(CpApiException.class, () -> submissionService.createSpawn(
                spawnRequest(mismatchedChild, parentSession, parentRun, spawnEvent)));

        OperationItem unrelatedToolCall = operationService.appendItem(parentOperation.operationId(),
                UUID.randomUUID().toString(), null, "tool_call", "read_file", "agent", "{}", null, null);
        Session unrelatedChild = saveChildSession(workspaceId, userId, parentSession, parentRun);
        assertThrows(CpApiException.class, () -> submissionService.createSpawn(
                spawnRequest(unrelatedChild, parentSession, parentRun, unrelatedToolCall)));

        OperationItem attachedSpawnEvent = operationService.appendItem(parentOperation.operationId(),
                UUID.randomUUID().toString(), null, "tool_call", "spawn_agent", "agent", "{}", null, null);
        Session attachmentChild = saveChildSession(workspaceId, userId, parentSession, parentRun);
        File childAttachment = new File(userId, "child.txt", "unused-test-path");
        childAttachment.setWorkspaceId(workspaceId);
        childAttachment.setSessionId(attachmentChild.getId().toString());
        childAttachment.setMimeType("text/plain");
        childAttachment.setSizeBytes(12L);
        File savedChildAttachment = fileRepository.save(childAttachment);
        fileIds.add(savedChildAttachment.getId());
        ChatSubmissionService.Submission withAttachment = submissionService.createSpawn(
                spawnRequest(attachmentChild, parentSession, parentRun, attachedSpawnEvent,
                        "child with attachment", List.of(savedChildAttachment.getId().toString())));
        assertTrue(withAttachment.userMessage().getAttachments().contains(savedChildAttachment.getId().toString()));
        assertTrue(withAttachment.userMessage().getAttachments().contains("child.txt"));
        assertTrue(withAttachment.userMessage().getAttachments().contains("text/plain"));
        assertEquals(parentSession.getId(),
                sessionRepository.findById(UUID.fromString(childSession.getId().toString()))
                        .orElseThrow().getSpawnedFromSessionId());

        Session unboundChild = saveChildSession(workspaceId, userId, parentSession, parentRun);
        unboundChild.setAgentPrincipalId(null);
        sessionRepository.saveAndFlush(unboundChild);
        OperationItem missingPrincipalEvent = operationService.appendItem(parentOperation.operationId(),
                UUID.randomUUID().toString(), null, "tool_call", "spawn_agent", "agent", "{}", null, null);
        ChatSubmissionService.SpawnSubmission unboundRequest = spawnRequest(
                unboundChild, parentSession, parentRun, missingPrincipalEvent);
        CpApiException admissionError = assertThrows(CpApiException.class,
                () -> submissionService.createSpawn(unboundRequest));
        assertEquals("FORBIDDEN", admissionError.getCode());
        assertTrue(chatRunRepository.findById(UUID.fromString(unboundRequest.runId())).isEmpty());
    }

    private Session saveSession(String wsId, String ownerId, String title) {
        Session session = new Session(wsId, ownerId, title);
        session.setId(UUID.randomUUID());
        session.setAgentPrincipalId(principalId.toString());
        session.setAgentPermissionsSnapshot(objectMapper.createArrayNode());
        Session saved = sessionRepository.save(session);
        sessionIds.add(saved.getId());
        return saved;
    }

    private Session saveChildSession(String wsId, String ownerId, Session parentSession, ChatRun parentRun) {
        Session child = new Session(wsId, ownerId, "Spawn child");
        child.setId(UUID.randomUUID());
        child.setSpawnedFromSessionId(parentSession.getId());
        child.setSpawnedFromRunId(parentRun.getId());
        child.setSpawnedAt(Instant.now());
        child.setKind(Session.KIND_SPAWN);
        child.setAgentPrincipalId(principalId.toString());
        child.setAgentPermissionsSnapshot(objectMapper.createArrayNode());
        Session saved = sessionRepository.save(child);
        sessionIds.add(saved.getId());
        return saved;
    }

    private ChatSubmissionService.SpawnSubmission spawnRequest(
            Session child, Session parentSession, ChatRun parentRun, OperationItem event) {
        return spawnRequest(child, parentSession, parentRun, event, "child instruction", List.of());
    }

    private ChatSubmissionService.SpawnSubmission spawnRequest(
            Session child, Session parentSession, ChatRun parentRun, OperationItem event, String content) {
        return spawnRequest(child, parentSession, parentRun, event, content, List.of());
    }

    private ChatSubmissionService.SpawnSubmission spawnRequest(
            Session child, Session parentSession, ChatRun parentRun, OperationItem event,
            String content, List<String> attachmentIds) {
        return new ChatSubmissionService.SpawnSubmission(
                UUID.randomUUID().toString(), child.getId().toString(), userId, workspaceId,
                parentSession.getId().toString(), parentRun.getId().toString(), event.getId(),
                "provider", "model", "workspace", null, null, "spawn-test", UUID.randomUUID().toString(),
                content, attachmentIds);
    }
}
