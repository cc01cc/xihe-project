package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.File;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionBranch;
import com.cc01cc.p.xihe.cp.entity.SessionForkRequest;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.files.ChatAttachmentService;
import com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.McpInvocationRepository;
import com.cc01cc.p.xihe.cp.repository.SessionBranchRepository;
import com.cc01cc.p.xihe.cp.repository.SessionForkRequestRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentMatchers;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.web.client.HttpServerErrorException;
import org.awaitility.Awaitility;

import java.io.IOException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Instant;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doCallRealMethod;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

class SessionForkIntegrationTest extends AbstractIntegrationTest {

    private static final Path ATTACHMENT_ROOT = Paths.get(
            System.getProperty("java.io.tmpdir"), "xihe-session-fork-it-" + UUID.randomUUID());

    @DynamicPropertySource
    static void registerAttachmentRoot(DynamicPropertyRegistry registry) {
        registry.add("cp.attachments-base-path", () -> ATTACHMENT_ROOT.toString());
    }

    @Autowired private ObjectMapper objectMapper;
    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceUserRepository workspaceUserRepository;
    @Autowired private AgentPrincipalRepository agentPrincipalRepository;
    @Autowired private AuthorizationGrantRepository authorizationGrantRepository;
    @Autowired private WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired private SessionRepository sessionRepository;
    @Autowired private SessionService sessionService;
    @Autowired private ChatRunRepository chatRunRepository;
    @Autowired private MessageRepository messageRepository;
    @Autowired private McpInvocationRepository mcpInvocationRepository;
    @Autowired private FileRepository fileRepository;
    @Autowired private SessionForkRequestRepository forkRequestRepository;
    @Autowired private SessionBranchRepository sessionBranchRepository;
    @Autowired private JdbcTemplate jdbcTemplate;
    @Autowired private SessionForkService sessionForkService;
    @Autowired private BranchPathService branchPathService;
    @Autowired private EventStoreService eventStoreService;
    @Autowired private GrantPrincipalPathResolver principalPathResolver;
    @MockitoSpyBean private ChatRunCancellationService cancellationSpy;
    @MockitoSpyBean
    private ChatAttachmentService attachmentSpy;

    private String userId;
    private String workspaceId;
    private String authToken;
    private UUID principalId;

    @BeforeEach
    void registerUserAndWorkspace() throws Exception {
        String email = "session-fork-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> registered = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                new RegisterRequest(email, com.cc01cc.p.xihe.cp.integration.TestDataFactory.PASSWORD,
                        "SessionForkTest"),
                AuthResponse.class);
        assertEquals(HttpStatus.CREATED, registered.getStatusCode());
        authToken = registered.getBody().getAccessToken();

        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        workspaceId = workspaceRepository.findActiveByMemberUserId(user.getId()).stream()
                .findFirst().orElseThrow().getId().toString();
        if (workspaceUserRepository.findByIdWorkspaceIdAndIdUserId(
                UUID.fromString(workspaceId), UUID.fromString(userId)).isEmpty()) {
            workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));
        }
        principalId = createBoundPrincipal();
    }

    @AfterAll
    static void cleanupTemporaryAttachmentRoot() throws IOException {
        if (!Files.exists(ATTACHMENT_ROOT)) {
            return;
        }
        Files.walkFileTree(ATTACHMENT_ROOT, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                Files.delete(file);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path directory, IOException error) throws IOException {
                if (error != null) {
                    throw error;
                }
                Files.delete(directory);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    @Test
    void forkEndpointCopiesIndependentRowsReplaysAndSurvivesParentDeletion() throws Exception {
        byte[] bytes = "fork attachment bytes".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        Source source = createSource(bytes, false);
        reduceWorkspaceCapToReadOnly();

        ResponseEntity<Map> created = postFork(source, "fork-key-success", source.anchorMessageId());
        assertEquals(HttpStatus.CREATED, created.getStatusCode());
        String childId = (String) created.getBody().get("id");
        assertNotNull(childId);
        assertTrue(created.getHeaders().getLocation().toString().endsWith("/api/v1/sessions/" + childId));
        assertEquals(Session.KIND_FORK, created.getBody().get("kind"));
        assertEquals(source.session().getId().toString(), created.getBody().get("spawnedFromSessionId"));
        assertEquals(source.runId(), created.getBody().get("spawnedFromRunId"));
        assertNotNull(created.getBody().get("spawnedAt"));

        Session child = sessionRepository.findById(UUID.fromString(childId)).orElseThrow();
        assertEquals(Session.KIND_FORK, child.getKind());
        assertEquals(principalId.toString(), child.getAgentPrincipalId());
        assertEquals(1, child.getAgentPermissionsSnapshot().size(),
                "fork takes the current Workspace cap, not the parent's old snapshot");
        assertEquals("read", child.getAgentPermissionsSnapshot().get(0).path("actionClass").asText());
        assertEquals(source.session().getId(), child.getSpawnedFromSessionId());
        assertEquals(UUID.fromString(source.runId()), child.getSpawnedFromRunId());

        List<Message> childMessages = messageRepository.findBySessionIdOrderByCreatedAtAsc(childId);
        assertEquals(2, childMessages.size());
        assertTrue(childMessages.stream().anyMatch(message -> "parent prompt".equals(message.getContent())));
        assertTrue(childMessages.stream().anyMatch(message -> "parent answer".equals(message.getContent())));
        assertTrue(childMessages.stream().allMatch(message -> childId.equals(message.getSessionId())));

        File childFile = fileRepository.findByMessageIdOrderByIdAsc(
                childMessages.stream().filter(message -> "parent prompt".equals(message.getContent()))
                        .findFirst().orElseThrow().getId().toString()).stream().findFirst().orElseThrow();
        assertNotEquals(source.file().getId(), childFile.getId());
        assertEquals(childId, childFile.getSessionId());
        assertArrayEquals(bytes, Files.readAllBytes(Paths.get(childFile.getStoragePath())));

        var forkEvent = eventStoreService.read(childId, 0L, branchPathService.rootVisibility(childId)).stream()
                .filter(event -> "session.forked".equals(event.getEventType())).findFirst().orElseThrow();
        assertNull(forkEvent.getBranchId());
        assertNull(forkEvent.getCorrelationId());
        JsonNode seed = objectMapper.readTree(forkEvent.getPayload()).path("summary_seed");
        assertEquals(2, seed.path("messages").size());
        assertEquals("human", seed.path("messages").get(0).path("role").asText());
        assertEquals("parent prompt", seed.path("messages").get(0).path("content").asText());
        assertEquals("ai", seed.path("messages").get(1).path("role").asText());
        assertEquals("parent answer", seed.path("messages").get(1).path("content").asText());
        assertFalse(seed.has("summary"));
        assertFalse(seed.has("summaryHash"));
        assertFalse(seed.path("contextEpoch").asText().isBlank());

        ResponseEntity<Map> replay = postFork(source, "fork-key-success", source.anchorMessageId());
        assertEquals(HttpStatus.OK, replay.getStatusCode());
        assertEquals(childId, replay.getBody().get("id"));
        assertEquals(created.getBody(), replay.getBody());
        assertEquals(created.getHeaders().getLocation(), replay.getHeaders().getLocation());
        assertEquals(UUID.fromString(childId), forkRequestRepository
                .findBySourceSessionIdAndIdempotencyKey(source.session().getId(), "fork-key-success")
                .orElseThrow().getChildSessionId());

        ResponseEntity<Map> conflict = postFork(source, "fork-key-success", UUID.randomUUID().toString());
        assertEquals(HttpStatus.CONFLICT, conflict.getStatusCode());
        assertEquals("IDEMPOTENCY_KEY_CONFLICT", conflict.getBody().get("code"));

        ResponseEntity<List<Map<String, Object>>> messages = getChildMessages(childId);
        assertEquals(2, messages.getBody().size());
        for (Map<String, Object> message : messages.getBody()) {
            assertFalse(message.containsKey("runId"));
            assertFalse(message.containsKey("runStatus"));
            assertFalse(message.containsKey("errorDetail"));
            assertFalse(message.containsKey("jobSummary"));
        }

        sessionService.delete(source.session().getId().toString(), userId, workspaceId);
        assertTrue(sessionRepository.findById(source.session().getId()).isEmpty());
        Session survivingChild = sessionRepository.findById(UUID.fromString(childId)).orElseThrow();
        assertEquals(Session.KIND_FORK, survivingChild.getKind());
        assertTrue(messageRepository.findBySessionIdOrderByCreatedAtAsc(childId).stream()
                .allMatch(message -> message.getRunId() == null));
        assertArrayEquals(bytes, Files.readAllBytes(Paths.get(childFile.getStoragePath())));
        assertEquals(List.of(UUID.fromString(childId)), sessionIds(
                principalPathResolver.resolveAgent(userId, workspaceId, childId)));

        ResponseEntity<Map> replayAfterParentDelete = postFork(
                source, "fork-key-success", source.anchorMessageId());
        assertEquals(HttpStatus.OK, replayAfterParentDelete.getStatusCode());
        assertEquals(childId, replayAfterParentDelete.getBody().get("id"));
        assertEquals(created.getBody(), replayAfterParentDelete.getBody());
        assertEquals(created.getHeaders().getLocation(), replayAfterParentDelete.getHeaders().getLocation());
        assertEquals(2, messageRepository.findBySessionIdOrderByCreatedAtAsc(childId).size());
        assertEquals(1, fileRepository.findBySessionIdOrderByIdAsc(childId).size());
    }

    @Test
    void forkRejectsMissingOrNullBranchAndAnchorFieldsAsInvalidRequest() {
        String sourceSessionId = UUID.randomUUID().toString();
        ResponseEntity<Map> missingBranch = postForkBody(sourceSessionId, "missing-branch",
                Map.of("anchorMessageId", UUID.randomUUID().toString()));
        assertEquals(HttpStatus.BAD_REQUEST, missingBranch.getStatusCode());
        assertEquals("INVALID_REQUEST", missingBranch.getBody().get("code"));

        Map<String, Object> nullAnchorBody = new java.util.HashMap<>();
        nullAnchorBody.put("sourceBranchId", UUID.randomUUID().toString());
        nullAnchorBody.put("anchorMessageId", null);
        ResponseEntity<Map> nullAnchor = postForkBody(sourceSessionId, "null-anchor", nullAnchorBody);
        assertEquals(HttpStatus.BAD_REQUEST, nullAnchor.getStatusCode());
        assertEquals("INVALID_REQUEST", nullAnchor.getBody().get("code"));
    }

    @Test
    void forkAcceptsVisibleAncestorAnchorOnSelectedDescendantPath() throws Exception {
        Source source = createSource("ancestor path bytes".getBytes(java.nio.charset.StandardCharsets.UTF_8), false);
        var anchor = branchPathService.resolveAnchor(
                source.session().getId().toString(), workspaceId, source.anchorMessageId());
        UUID descendantBranchId = UUID.randomUUID();
        SessionBranch descendant = new SessionBranch(descendantBranchId, source.session().getId().toString());
        descendant.setParentBranchId(source.branchId());
        descendant.setForkPointMessageId(source.anchorMessageId());
        descendant.setForkPointRunId(source.runId());
        descendant.setForkPointSequence(anchor.cursor());
        descendant.setIdempotencyKey("seed-descendant-branch");
        descendant.setRequestHash("a".repeat(64));
        sessionBranchRepository.saveAndFlush(descendant);

        ResponseEntity<Map> result = postForkBody(source.session().getId().toString(), "ancestor-anchor",
                Map.of("sourceBranchId", descendantBranchId.toString(),
                        "anchorMessageId", source.anchorMessageId()));
        assertEquals(HttpStatus.CREATED, result.getStatusCode());
        String childId = (String) result.getBody().get("id");
        assertEquals(2, messageRepository.findBySessionIdOrderByCreatedAtAsc(childId).size());
    }

    @Test
    void forkFromTerminalAnchorSucceedsWhileUnrelatedRunIsActiveAndExcludesLaterEvents() throws Exception {
        Source source = createSource("active run cutoff bytes".getBytes(java.nio.charset.StandardCharsets.UTF_8), false);
        ChatRun activeRun = new ChatRun(UUID.randomUUID().toString(), source.session().getId().toString(),
                userId, workspaceId, "active-after-anchor", "b".repeat(64), "openai", "gpt-test", "none", "running");
        activeRun.setBranchId(source.branchId());
        activeRun = chatRunRepository.saveAndFlush(activeRun);

        Message laterPrompt = new Message(source.session().getId().toString(), MessageRole.USER, "future active prompt");
        laterPrompt.setRunId(activeRun.getId().toString());
        laterPrompt.setBranchId(source.branchId());
        laterPrompt = messageRepository.saveAndFlush(laterPrompt);
        activeRun.setUserMessageId(laterPrompt.getId().toString());
        chatRunRepository.saveAndFlush(activeRun);
        eventStoreService.append(source.session().getId().toString(), workspaceId, userId,
                "prompt.admitted", Map.of("message", Map.of("role", "human", "content", "future active prompt")),
                activeRun.getId().toString(), source.branchId());

        ResponseEntity<Map> response = postFork(source, "fork-with-unrelated-active-run", source.anchorMessageId());
        assertEquals(HttpStatus.CREATED, response.getStatusCode());
        String childId = (String) response.getBody().get("id");
        assertEquals("running", chatRunRepository.findById(activeRun.getId()).orElseThrow().getStatus());
        assertFalse(chatRunRepository.existsBySessionId(childId), "fork must not copy ChatRun rows");

        List<Message> childMessages = messageRepository.findBySessionIdOrderByCreatedAtAsc(childId);
        assertEquals(2, childMessages.size());
        assertTrue(childMessages.stream().noneMatch(message -> "future active prompt".equals(message.getContent())));
        var seedEvent = eventStoreService.read(childId, 0L, branchPathService.rootVisibility(childId)).stream()
                .filter(event -> "session.forked".equals(event.getEventType())).findFirst().orElseThrow();
        JsonNode seedMessages = objectMapper.readTree(seedEvent.getPayload()).path("summary_seed").path("messages");
        assertEquals(2, seedMessages.size());
        assertTrue(seedMessages.findValuesAsText("content").stream()
                .noneMatch(content -> "future active prompt".equals(content)));
    }

    @Test
    void directAttachmentDeleteWaitsForForkCopyAndChildBytesRemainIndependent() throws Exception {
        byte[] bytes = "direct delete race bytes".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        Source source = createSource(bytes, false);
        CountDownLatch copyEntered = new CountDownLatch(1);
        CountDownLatch releaseCopy = new CountDownLatch(1);
        doAnswer(invocation -> {
            copyEntered.countDown();
            if (!releaseCopy.await(10, TimeUnit.SECONDS)) {
                throw new IOException("timed out waiting to release the attachment-copy test barrier");
            }
            return invocation.callRealMethod();
        }).when(attachmentSpy).copyForFork(ArgumentMatchers.any(UUID.class), ArgumentMatchers.anyString(),
                ArgumentMatchers.anyString(), ArgumentMatchers.anyString(), ArgumentMatchers.anyString(),
                ArgumentMatchers.anyString(), ArgumentMatchers.anyString());

        ExecutorService executor = Executors.newFixedThreadPool(2);
        Future<ResponseEntity<Map>> forkFuture = executor.submit(
                () -> postFork(source, "fork-before-direct-delete", source.anchorMessageId()));
        try {
            assertTrue(copyEntered.await(10, TimeUnit.SECONDS), "fork did not reach the attachment-copy barrier");
            Future<ResponseEntity<Map>> deleteFuture = executor.submit(() -> deleteAttachment(source));
            Awaitility.await().atMost(Duration.ofSeconds(5)).pollInterval(Duration.ofMillis(25))
                    .untilAsserted(() -> assertTrue(jdbcTemplate.queryForObject(
                                    "SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() "
                                            + "AND state = 'active' AND wait_event_type = 'Lock' "
                                            + "AND query ILIKE '%files%'", Integer.class) > 0,
                            "direct attachment delete must wait on the File row locked by fork"));

            releaseCopy.countDown();
            ResponseEntity<Map> forked = forkFuture.get(10, TimeUnit.SECONDS);
            ResponseEntity<Map> deleted = deleteFuture.get(10, TimeUnit.SECONDS);
            assertEquals(HttpStatus.CREATED, forked.getStatusCode());
            assertEquals(HttpStatus.OK, deleted.getStatusCode());

            String childId = (String) forked.getBody().get("id");
            assertTrue(fileRepository.findById(source.file().getId()).isEmpty());
            File childFile = fileRepository.findBySessionIdOrderByIdAsc(childId).stream().findFirst().orElseThrow();
            assertArrayEquals(bytes, Files.readAllBytes(Paths.get(childFile.getStoragePath())));
        } finally {
            releaseCopy.countDown();
            executor.shutdownNow();
        }
    }

    @Test
    void directAttachmentDeleteBeforeForkRejectsChangedSourceWithoutPublishingChild() throws Exception {
        Source source = createSource("delete-first bytes".getBytes(java.nio.charset.StandardCharsets.UTF_8), false);
        ResponseEntity<Map> deleted = deleteAttachment(source);
        assertEquals(HttpStatus.OK, deleted.getStatusCode());

        ResponseEntity<Map> fork = postFork(source, "fork-after-direct-delete", source.anchorMessageId());
        assertEquals(HttpStatus.CONFLICT, fork.getStatusCode());
        assertEquals("FORK_SOURCE_ATTACHMENT_CHANGED", fork.getBody().get("code"));
        SessionForkRequest request = forkRequestRepository
                .findBySourceSessionIdAndIdempotencyKey(source.session().getId(), "fork-after-direct-delete")
                .orElseThrow();
        assertEquals(SessionForkRequest.RETRYABLE, request.getState());
        assertTrue(sessionRepository.findById(request.getChildSessionId()).isEmpty());
        assertFalse(Files.exists(ATTACHMENT_ROOT.resolve(request.getChildSessionId().toString())));
    }

    @Test
    void branchRoutesListCreateReplayAndUseV43AnchorOwnerAsParent() throws Exception {
        Source source = createSource("branch route bytes".getBytes(java.nio.charset.StandardCharsets.UTF_8), false);
        ResponseEntity<Map> initial = getBranches(source.session().getId().toString());
        assertEquals(HttpStatus.OK, initial.getStatusCode());
        List<Map<String, Object>> initialItems = (List<Map<String, Object>>) initial.getBody().get("items");
        assertEquals(1, initialItems.size());
        assertEquals(source.branchId(), initialItems.get(0).get("branchId"));
        assertNull(initialItems.get(0).get("parentBranchId"));

        ResponseEntity<Map> created = postBranch(source, "branch-key-one",
                source.branchId(), source.anchorMessageId());
        assertEquals(HttpStatus.CREATED, created.getStatusCode());
        String firstBranchId = (String) created.getBody().get("branchId");
        assertEquals(source.branchId(), created.getBody().get("parentBranchId"));
        assertEquals(source.anchorMessageId(), created.getBody().get("forkPointMessageId"));

        ResponseEntity<Map> replay = postBranch(source, "branch-key-one",
                source.branchId(), source.anchorMessageId());
        assertEquals(HttpStatus.CREATED, replay.getStatusCode());
        assertEquals(created.getBody(), replay.getBody());

        ResponseEntity<Map> conflict = postBranch(source, "branch-key-one",
                source.branchId(), UUID.randomUUID().toString());
        assertEquals(HttpStatus.CONFLICT, conflict.getStatusCode());
        assertEquals("IDEMPOTENCY_KEY_CONFLICT", conflict.getBody().get("code"));

        ResponseEntity<Map> descendant = postBranch(source, "branch-key-two",
                firstBranchId, source.anchorMessageId());
        assertEquals(HttpStatus.CREATED, descendant.getStatusCode());
        assertEquals(source.branchId(), descendant.getBody().get("parentBranchId"),
                "V43 stores the branch that owns the visible anchor as the child parent");
        assertNotEquals(firstBranchId, descendant.getBody().get("parentBranchId"));

        ResponseEntity<Map> finalList = getBranches(source.session().getId().toString());
        List<Map<String, Object>> finalItems = (List<Map<String, Object>>) finalList.getBody().get("items");
        assertEquals(3, finalItems.size());
        assertTrue(finalItems.stream().anyMatch(item -> firstBranchId.equals(item.get("branchId"))));
        assertTrue(finalItems.stream().anyMatch(item -> descendant.getBody().get("branchId").equals(item.get("branchId"))));
    }

    @Test
    void branchScopedMessageReadUsesVisiblePathCutoff() throws Exception {
        Source source = createSource("branch messages bytes".getBytes(java.nio.charset.StandardCharsets.UTF_8), false);
        Message userMessage = messageRepository.findBySessionIdOrderByCreatedAtAsc(source.session().getId().toString())
                .stream().filter(message -> message.getRole() == MessageRole.USER).findFirst().orElseThrow();
        ResponseEntity<Map> branch = postBranch(source, "branch-cutoff", source.branchId(),
                userMessage.getId().toString());
        assertEquals(HttpStatus.CREATED, branch.getStatusCode());
        String branchId = (String) branch.getBody().get("branchId");

        ResponseEntity<List<Map<String, Object>>> visible = getMessages(
                source.session().getId().toString(), branchId);
        assertEquals(HttpStatus.OK, visible.getStatusCode());
        assertEquals(1, visible.getBody().size());
        assertEquals("parent prompt", visible.getBody().get(0).get("content"));

        ResponseEntity<Map> missingSelector = getMessagesWithoutBranch(source.session().getId().toString());
        assertEquals(HttpStatus.BAD_REQUEST, missingSelector.getStatusCode());
        assertEquals("INVALID_REQUEST", missingSelector.getBody().get("code"));
    }

    @Test
    void branchCreateReturnsBranchLockWhileSessionHasActiveRun() throws Exception {
        Source source = createSource("branch lock bytes".getBytes(java.nio.charset.StandardCharsets.UTF_8), false);
        ChatRun active = new ChatRun(UUID.randomUUID().toString(), source.session().getId().toString(),
                userId, workspaceId, "active-branch-lock", "a".repeat(64), "provider", "model", "none", "running");
        active.setBranchId(source.branchId());
        chatRunRepository.saveAndFlush(active);

        ResponseEntity<Map> response = postBranch(source, "branch-key-active",
                source.branchId(), source.anchorMessageId());
        assertEquals(HttpStatus.CONFLICT, response.getStatusCode());
        assertEquals("BRANCH_LOCK", response.getBody().get("code"));
        assertEquals(1, sessionBranchRepository.findBySessionIdOrderByCreatedAtAscIdAsc(
                source.session().getId().toString()).size());
    }

    @Test
    void publicCompactRequiresAndPersistsTheSelectedBranch() throws Exception {
        Source source = createSource("manual compact branch bytes".getBytes(java.nio.charset.StandardCharsets.UTF_8), false);
        ResponseEntity<Map> missingBranch = postCompact(source.session().getId().toString(), Map.of());
        assertEquals(HttpStatus.BAD_REQUEST, missingBranch.getStatusCode());
        assertEquals("INVALID_REQUEST", missingBranch.getBody().get("code"));

        ResponseEntity<Map> compacted = postCompact(source.session().getId().toString(),
                Map.of("branchId", source.branchId()));
        assertEquals(HttpStatus.OK, compacted.getStatusCode());
        assertEquals("compaction.manual_applied", compacted.getBody().get("eventType"));
        assertTrue(compacted.getBody().containsKey("createdAt"));
        assertFalse(compacted.getBody().containsKey("created_at"));

        var branchVisibility = branchPathService.resolveVisibility(
                source.session().getId().toString(), source.branchId());
        var manualEvent = eventStoreService.read(source.session().getId().toString(), 0L, branchVisibility).stream()
                .filter(event -> "compaction.manual_applied".equals(event.getEventType()))
                .findFirst().orElseThrow();
        assertEquals(source.branchId(), manualEvent.getBranchId());
        assertNull(manualEvent.getCorrelationId());
    }

    @Test
    void copyingRequestRejectsSameKeyReplayAndSessionDeleteBeforeSideEffects() throws Exception {
        Source source = createSource("copying gate bytes".getBytes(java.nio.charset.StandardCharsets.UTF_8), false);
        CountDownLatch copyEntered = new CountDownLatch(1);
        CountDownLatch releaseCopy = new CountDownLatch(1);
        doAnswer(invocation -> {
            copyEntered.countDown();
            if (!releaseCopy.await(10, TimeUnit.SECONDS)) {
                throw new IOException("timed out waiting to release the attachment-copy test barrier");
            }
            return invocation.callRealMethod();
        }).when(attachmentSpy).copyForFork(ArgumentMatchers.any(UUID.class), ArgumentMatchers.anyString(),
                ArgumentMatchers.anyString(), ArgumentMatchers.anyString(), ArgumentMatchers.anyString(),
                ArgumentMatchers.anyString(), ArgumentMatchers.anyString());

        ExecutorService executor = Executors.newSingleThreadExecutor();
        Future<ResponseEntity<Map>> forkFuture = executor.submit(
                () -> postFork(source, "fork-key-copying", source.anchorMessageId()));
        try {
            assertTrue(copyEntered.await(10, TimeUnit.SECONDS), "fork did not reach the copy barrier");

            ResponseEntity<Map> duplicate = postFork(source, "fork-key-copying", source.anchorMessageId());
            assertEquals(HttpStatus.CONFLICT, duplicate.getStatusCode());
            assertEquals("IDEMPOTENCY_REQUEST_IN_PROGRESS", duplicate.getBody().get("code"));

            ResponseEntity<Map> deletion = deleteSession(source.session().getId().toString());
            assertEquals(HttpStatus.CONFLICT, deletion.getStatusCode());
            assertEquals("FORK_REQUEST_IN_PROGRESS", deletion.getBody().get("code"));
            verify(cancellationSpy, never()).cancelInFlightForSession(
                    source.session().getId().toString(), userId, workspaceId, "session_deleted");

            releaseCopy.countDown();
            ResponseEntity<Map> completed = forkFuture.get(10, TimeUnit.SECONDS);
            assertEquals(HttpStatus.CREATED, completed.getStatusCode());
        } finally {
            releaseCopy.countDown();
            executor.shutdownNow();
        }
    }

    @Test
    void deleteIntentBarrierRejectsForkClaimAndResumedDeleteCompletes() throws Exception {
        Source source = createSource("delete intent bytes".getBytes(java.nio.charset.StandardCharsets.UTF_8), false);
        String sessionId = source.session().getId().toString();

        // First DELETE segment commits the durable intent inside the short lock
        // (SessionController calls beginDeleteIntent before lock-free side effects).
        sessionService.beginDeleteIntent(sessionId, userId, workspaceId);
        assertNotNull(sessionRepository.findById(source.session().getId()).orElseThrow().getDeleteRequestedAt());

        // A fork claim landing in the delete window is rejected before any claim row exists.
        ResponseEntity<Map> forked = postFork(source, "fork-key-deleting", source.anchorMessageId());
        assertEquals(HttpStatus.CONFLICT, forked.getStatusCode());
        assertEquals("SESSION_DELETING", forked.getBody().get("code"));
        assertTrue(forkRequestRepository
                .findBySourceSessionIdAndIdempotencyKey(source.session().getId(), "fork-key-deleting").isEmpty());

        // The mutation guard surfaces the same barrier (PLAN-0409 design #22).
        CpApiException mutation = assertThrows(CpApiException.class,
                () -> sessionService.lockCurrentForMutation(sessionId, userId, workspaceId));
        assertEquals("SESSION_DELETING", mutation.getCode());

        // A retried DELETE resumes from the recorded intent (re-entrant, no undo path)
        // and finishes; the marker disappears together with the row.
        ResponseEntity<Map> deletion = deleteSession(sessionId);
        assertEquals(HttpStatus.NO_CONTENT, deletion.getStatusCode());
        assertTrue(sessionRepository.findById(source.session().getId()).isEmpty());
        Integer sessions = jdbcTemplate.queryForObject(
                "select count(*) from sessions where id = ?", Integer.class, source.session().getId());
        assertEquals(0, sessions);
        Integer messages = jdbcTemplate.queryForObject(
                "select count(*) from messages where session_id = ?", Integer.class, source.session().getId());
        assertEquals(0, messages);
    }

    @Test
    void forkWithoutIdempotencyKeyIsRejected() throws Exception {
        Source source = createSource("missing idempotency key bytes"
                .getBytes(java.nio.charset.StandardCharsets.UTF_8), false);

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        Map<String, Object> body = Map.of(
                "sourceBranchId", source.branchId(),
                "anchorMessageId", source.anchorMessageId());
        ResponseEntity<Map> response = restTemplate.exchange(
                url("/api/v1/sessions/" + source.session().getId() + "/fork"),
                HttpMethod.POST, new HttpEntity<>(body, headers), Map.class);

        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
        assertEquals("IDEMPOTENCY_KEY_REQUIRED", response.getBody().get("code"));
        assertEquals(0, jdbcTemplate.queryForObject(
                "select count(*) from session_fork_requests where source_session_id = ?",
                Integer.class, source.session().getId()),
                "a rejected fork must not reserve a request row");
    }

    @Test
    void sameAnchorDifferentKeysCreateDistinctChildren() throws Exception {
        Source source = createSource("distinct idempotency keys bytes"
                .getBytes(java.nio.charset.StandardCharsets.UTF_8), false);

        ResponseEntity<Map> first = postFork(source, "fork-key-distinct-one", source.anchorMessageId());
        ResponseEntity<Map> second = postFork(source, "fork-key-distinct-two", source.anchorMessageId());
        assertEquals(HttpStatus.CREATED, first.getStatusCode());
        assertEquals(HttpStatus.CREATED, second.getStatusCode());

        String firstChild = (String) first.getBody().get("id");
        String secondChild = (String) second.getBody().get("id");
        assertNotNull(firstChild);
        assertNotNull(secondChild);
        assertNotEquals(firstChild, secondChild,
                "the same anchor under different Idempotency-Keys must publish distinct children");
        assertEquals(2, jdbcTemplate.queryForObject(
                "select count(*) from session_fork_requests where source_session_id = ?",
                Integer.class, source.session().getId()));
        assertEquals(2, jdbcTemplate.queryForObject(
                "select count(*) from sessions where kind = ? and spawned_from_session_id = ?",
                Integer.class, Session.KIND_FORK, source.session().getId()));
    }

    @Test
    void forkWithoutAgentPrincipalIsRejected() throws Exception {
        Session principalless = sessionService.createWithId(UUID.randomUUID().toString(), userId, workspaceId,
                "Principal-less fork source", "openai", "gpt-test");
        assertNull(principalless.getAgentPrincipalId());
        String sessionId = principalless.getId().toString();
        String branchId = branchPathService.ensureRootBranchId(sessionId);

        String runId = UUID.randomUUID().toString();
        ChatRun run = new ChatRun(runId, sessionId, userId, workspaceId,
                "no-principal-" + runId, "a".repeat(64), "openai", "gpt-test", "none", "succeeded");
        run.setBranchId(branchId);
        run.setTerminalAt(Instant.now());
        run.setTerminalOutcome("success");
        run = chatRunRepository.saveAndFlush(run);

        Message userMessage = new Message(sessionId, MessageRole.USER, "principal-less prompt");
        userMessage.setRunId(runId);
        userMessage.setBranchId(branchId);
        userMessage = messageRepository.saveAndFlush(userMessage);
        Message assistantMessage = new Message(sessionId, MessageRole.ASSISTANT, "principal-less answer");
        assistantMessage.setRunId(runId);
        assistantMessage.setBranchId(branchId);
        assistantMessage = messageRepository.saveAndFlush(assistantMessage);
        run.setUserMessageId(userMessage.getId().toString());
        run.setAssistantMessageId(assistantMessage.getId().toString());
        chatRunRepository.saveAndFlush(run);

        ResponseEntity<Map> response = postForkBody(sessionId, "fork-key-no-principal",
                Map.of("sourceBranchId", branchId,
                        "anchorMessageId", assistantMessage.getId().toString()));
        assertEquals(HttpStatus.CONFLICT, response.getStatusCode());
        assertEquals("SESSION_PRINCIPAL_REQUIRED", response.getBody().get("code"));
        assertTrue(forkRequestRepository
                .findBySourceSessionIdAndIdempotencyKey(principalless.getId(), "fork-key-no-principal").isEmpty());
    }

    @Test
    void forkByNonOwnerReturnsNotFound() throws Exception {
        Source source = createSource("non-owner fork bytes"
                .getBytes(java.nio.charset.StandardCharsets.UTF_8), false);

        String otherEmail = "session-fork-other-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> registered = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                new RegisterRequest(otherEmail, com.cc01cc.p.xihe.cp.integration.TestDataFactory.PASSWORD,
                        "SessionForkOtherUser"),
                AuthResponse.class);
        assertEquals(HttpStatus.CREATED, registered.getStatusCode());
        String otherToken = registered.getBody().getAccessToken();

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(otherToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("Idempotency-Key", "fork-key-non-owner");
        Map<String, Object> body = Map.of(
                "sourceBranchId", source.branchId(),
                "anchorMessageId", source.anchorMessageId());
        ResponseEntity<Map> response = restTemplate.exchange(
                url("/api/v1/sessions/" + source.session().getId() + "/fork"),
                HttpMethod.POST, new HttpEntity<>(body, headers), Map.class);

        assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode());
        assertEquals("SESSION_NOT_FOUND", response.getBody().get("code"));
        assertEquals(0, jdbcTemplate.queryForObject(
                "select count(*) from session_fork_requests where source_session_id = ?",
                Integer.class, source.session().getId()));
    }

    @Test
    void siblingPathAnchorIsRejected() throws Exception {
        Source source = createSource("sibling path anchor bytes"
                .getBytes(java.nio.charset.StandardCharsets.UTF_8), false);
        String sessionId = source.session().getId().toString();

        ResponseEntity<Map> branch = postBranch(source, "branch-sibling-anchor",
                source.branchId(), source.anchorMessageId());
        assertEquals(HttpStatus.CREATED, branch.getStatusCode());
        String branchId = (String) branch.getBody().get("branchId");

        String branchRunId = UUID.randomUUID().toString();
        ChatRun branchRun = new ChatRun(branchRunId, sessionId, userId, workspaceId,
                "sibling-anchor-" + branchRunId, "c".repeat(64), "openai", "gpt-test", "none", "succeeded");
        branchRun.setBranchId(branchId);
        branchRun.setTerminalAt(Instant.now());
        branchRun.setTerminalOutcome("success");
        branchRun = chatRunRepository.saveAndFlush(branchRun);
        Message siblingMessage = new Message(sessionId, MessageRole.USER, "branch-only prompt");
        siblingMessage.setRunId(branchRunId);
        siblingMessage.setBranchId(branchId);
        siblingMessage = messageRepository.saveAndFlush(siblingMessage);
        branchRun.setUserMessageId(siblingMessage.getId().toString());
        chatRunRepository.saveAndFlush(branchRun);
        eventStoreService.append(sessionId, workspaceId, userId, "prompt.admitted",
                Map.of("message", Map.of("role", "human", "content", "branch-only prompt")),
                branchRunId, branchId);

        ResponseEntity<Map> response = postFork(source, "fork-key-sibling-anchor",
                siblingMessage.getId().toString());
        assertEquals(HttpStatus.CONFLICT, response.getStatusCode());
        assertEquals("BRANCH_ANCHOR_INVALID", response.getBody().get("code"),
                "the anchor resolves, but is not visible on the root path");
        assertEquals(0, jdbcTemplate.queryForObject(
                "select count(*) from session_fork_requests where source_session_id = ?",
                Integer.class, source.session().getId()));
    }

    @Test
    void sessionWideDeleteBeforeForkFailsWithoutChild() throws Exception {
        Source source = createSource("session wide delete bytes"
                .getBytes(java.nio.charset.StandardCharsets.UTF_8), false);
        UUID sourceId = source.session().getId();

        ResponseEntity<Map> deletion = deleteSession(sourceId.toString());
        assertEquals(HttpStatus.NO_CONTENT, deletion.getStatusCode());
        assertTrue(sessionRepository.findById(sourceId).isEmpty());

        ResponseEntity<Map> fork = postFork(source, "fork-after-session-delete", source.anchorMessageId());
        assertEquals(HttpStatus.NOT_FOUND, fork.getStatusCode());
        assertEquals("SESSION_NOT_FOUND", fork.getBody().get("code"));
        assertEquals(0, jdbcTemplate.queryForObject(
                "select count(*) from session_fork_requests where source_session_id = ?",
                Integer.class, sourceId));
        assertEquals(0, jdbcTemplate.queryForObject(
                "select count(*) from sessions where kind = ? and spawned_from_session_id = ?",
                Integer.class, Session.KIND_FORK, sourceId),
                "a fully deleted source must not publish any fork child");
    }

    @Test
    void branchCreationAndMessageDoNotRewriteRootPathRows() throws Exception {
        Source source = createSource("root path immutability bytes"
                .getBytes(java.nio.charset.StandardCharsets.UTF_8), false);
        String sessionId = source.session().getId().toString();
        List<Map<String, Object>> before = rootPathSnapshot(sessionId, source.branchId());
        assertEquals(2, before.size());

        ResponseEntity<Map> branch = postBranch(source, "branch-root-immutability",
                source.branchId(), source.anchorMessageId());
        assertEquals(HttpStatus.CREATED, branch.getStatusCode());
        String branchId = (String) branch.getBody().get("branchId");

        Message branchOnly = new Message(sessionId, MessageRole.USER, "branch-only message");
        branchOnly.setBranchId(branchId);
        messageRepository.saveAndFlush(branchOnly);

        List<Map<String, Object>> after = rootPathSnapshot(sessionId, source.branchId());
        assertEquals(before, after,
                "branch creation and a branch-scoped Message must not rewrite root path rows");

        ResponseEntity<List<Map<String, Object>>> rootMessages = getMessages(sessionId, source.branchId());
        assertEquals(HttpStatus.OK, rootMessages.getStatusCode());
        assertEquals(2, rootMessages.getBody().size());
        assertTrue(rootMessages.getBody().stream()
                .noneMatch(message -> "branch-only message".equals(message.get("content"))));

        ResponseEntity<List<Map<String, Object>>> branchMessages = getMessages(sessionId, branchId);
        assertEquals(HttpStatus.OK, branchMessages.getStatusCode());
        assertEquals(3, branchMessages.getBody().size());
        assertTrue(branchMessages.getBody().stream()
                .anyMatch(message -> "branch-only message".equals(message.get("content"))));
    }

    @Test
    void forkKeepsSourceRowCountsUnchanged() throws Exception {
        Source source = createSource("row count bytes"
                .getBytes(java.nio.charset.StandardCharsets.UTF_8), false);
        UUID sourceId = source.session().getId();
        String toolCallId = UUID.randomUUID().toString();
        SpawnTestSupport.seedAgentInvocation(mcpInvocationRepository, sourceId.toString(), source.runId(),
                workspaceId, userId, toolCallId, "read_file", "{}");

        int sourceMessages = countRows("select count(*) from messages where session_id = ?", sourceId);
        int sourceRuns = countRows("select count(*) from chat_runs where session_id = ?", sourceId);
        int sourceInvocations = countRows("select count(*) from mcp_invocations where session_id = ?", sourceId);
        assertEquals(2, sourceMessages);
        assertEquals(1, sourceRuns);

        ResponseEntity<Map> forked = postFork(source, "fork-key-row-counts", source.anchorMessageId());
        assertEquals(HttpStatus.CREATED, forked.getStatusCode());
        UUID childId = UUID.fromString((String) forked.getBody().get("id"));

        assertEquals(sourceMessages, countRows("select count(*) from messages where session_id = ?", sourceId));
        assertEquals(sourceRuns, countRows("select count(*) from chat_runs where session_id = ?", sourceId));
        assertEquals(sourceInvocations, countRows("select count(*) from mcp_invocations where session_id = ?", sourceId));

        assertEquals(0, countRows("select count(*) from chat_runs where session_id = ?", childId));
        assertEquals(0, countRows("select count(*) from mcp_invocations where session_id = ?", childId),
                "the fork child inherits no MCP invocation history");
    }

    @Test
    void failedCleanupStaysHiddenAndSameKeyRetryReusesReservedChildId() throws Exception {
        byte[] bytes = "retry attachment bytes".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        Source source = createSource(bytes, true);
        String key = "fork-key-retry";

        doThrow(new IOException("injected cleanup failure"))
                .when(attachmentSpy).deleteForkNamespaceStrict(ArgumentMatchers.anyString());
        HttpServerErrorException.ServiceUnavailable pending = assertThrows(
                HttpServerErrorException.ServiceUnavailable.class,
                () -> postFork(source, key, source.anchorMessageId()));
        JsonNode problem = objectMapper.readTree(pending.getResponseBodyAsString());
        assertEquals("FORK_CLEANUP_PENDING", problem.path("code").asText());
        assertFalse(problem.has("childSessionId"));

        SessionForkRequest request = forkRequestRepository
                .findBySourceSessionIdAndIdempotencyKey(source.session().getId(), key).orElseThrow();
        UUID reservedChildId = request.getChildSessionId();
        assertEquals(SessionForkRequest.CLEANUP_PENDING, request.getState());
        assertTrue(sessionRepository.findById(reservedChildId).isEmpty());
        assertTrue(Files.exists(ATTACHMENT_ROOT.resolve(reservedChildId.toString())),
                "the injected failure leaves copied bytes for the recovery retry");

        doCallRealMethod().when(attachmentSpy).deleteForkNamespaceStrict(ArgumentMatchers.anyString());
        File corruptedSource = fileRepository.findById(source.file().getId()).orElseThrow();
        corruptedSource.setSizeBytes(bytes.length);
        fileRepository.saveAndFlush(corruptedSource);

        ResponseEntity<Map> retried = postFork(source, key, source.anchorMessageId());
        assertEquals(HttpStatus.CREATED, retried.getStatusCode());
        assertEquals(reservedChildId.toString(), retried.getBody().get("id"));
        assertEquals(SessionForkRequest.COMPLETED,
                forkRequestRepository.findById(reservedChildId).orElseThrow().getState());
        assertTrue(Files.exists(ATTACHMENT_ROOT.resolve(reservedChildId.toString())));
    }

    private Source createSource(byte[] bytes, boolean corruptFileSize) throws Exception {
        Session source = sessionService.createAgentSession(
                userId, workspaceId, "Fork source", "openai", "gpt-test", null, principalId.toString());
        String branchId = branchPathService.ensureRootBranchId(source.getId().toString());
        String runId = UUID.randomUUID().toString();
        ChatRun run = new ChatRun(runId, source.getId().toString(), userId, workspaceId,
                "fork-source-" + runId, "a".repeat(64), "openai", "gpt-test", "none", "succeeded");
        run.setBranchId(branchId);
        run.setTerminalAt(Instant.now());
        run.setTerminalOutcome("success");
        run = chatRunRepository.saveAndFlush(run);

        Message userMessage = new Message(source.getId().toString(), MessageRole.USER, "parent prompt");
        userMessage.setRunId(runId);
        userMessage.setBranchId(branchId);
        userMessage = messageRepository.saveAndFlush(userMessage);
        Message assistantMessage = new Message(source.getId().toString(), MessageRole.ASSISTANT, "parent answer");
        assistantMessage.setRunId(runId);
        assistantMessage.setBranchId(branchId);
        assistantMessage = messageRepository.saveAndFlush(assistantMessage);
        run.setUserMessageId(userMessage.getId().toString());
        run.setAssistantMessageId(assistantMessage.getId().toString());
        chatRunRepository.saveAndFlush(run);

        eventStoreService.append(source.getId().toString(), workspaceId, userId,
                "prompt.admitted", Map.of("message", Map.of("role", "human", "content", "parent prompt")),
                runId, branchId);
        eventStoreService.append(source.getId().toString(), workspaceId, userId,
                "assistant.responded", Map.of("message", Map.of("role", "ai", "content", "parent answer")),
                runId, branchId);
        File sourceFile = createSourceFile(source, userMessage, bytes, corruptFileSize);
        return new Source(source, branchId, runId, assistantMessage.getId().toString(), sourceFile, bytes);
    }

    private UUID createBoundPrincipal() throws Exception {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("Session fork principal");
        principal.setCreatedByUserId(userId);
        var snapshot = objectMapper.createObjectNode();
        snapshot.set("permissions", objectMapper.createArrayNode());
        principal.setTemplateSnapshot(snapshot);
        principal = agentPrincipalRepository.saveAndFlush(principal);

        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setGranterType("user");
        grant.setGranterId(UUID.fromString(userId));
        grant.setSubjectType("agent_principal");
        grant.setSubjectId(principal.getId());
        grant.setSource("template");
        grant.setReadState("read");
        grant.setPermissions(objectMapper.readTree("[{\"actionClass\":\"read\"},{\"actionClass\":\"write\"}]"));
        authorizationGrantRepository.saveAndFlush(grant);
        var cap = objectMapper.readTree("[{\"actionClass\":\"read\"},{\"actionClass\":\"write\"}]");
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principal.getId().toString(), workspaceId, cap));
        return principal.getId();
    }

    private File createSourceFile(Session session, Message message, byte[] bytes, boolean corruptSize)
            throws IOException {
        Path directory = ATTACHMENT_ROOT.resolve(session.getId().toString());
        Files.createDirectories(directory);
        File source = new File();
        source.setUserId(userId);
        source.setWorkspaceId(workspaceId);
        source.setSessionId(session.getId().toString());
        source.setMessageId(message.getId().toString());
        source.setFilename("source.txt");
        source.setMimeType("text/plain");
        source.setSizeBytes(corruptSize ? bytes.length + 1L : bytes.length);
        source.setStoragePath(directory.resolve("pending").toString());
        source = fileRepository.saveAndFlush(source);
        Path filePath = directory.resolve(source.getId().toString());
        Files.write(filePath, bytes);
        source.setStoragePath(filePath.toString());
        source = fileRepository.saveAndFlush(source);
        message.setAttachments(objectMapper.writeValueAsString(List.of(new AttachmentInfo(
                source.getId().toString(), source.getFilename(), source.getMimeType(),
                source.getSizeBytes(), "/api/v1/files/" + source.getId()))));
        messageRepository.saveAndFlush(message);
        return source;
    }

    private ResponseEntity<Map> postFork(Source source, String idempotencyKey, String anchorMessageId) {
        return postForkBody(source.session().getId().toString(), idempotencyKey,
                Map.of("sourceBranchId", source.branchId(), "anchorMessageId", anchorMessageId));
    }

    private ResponseEntity<Map> postForkBody(String sessionId, String idempotencyKey, Object body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("Idempotency-Key", idempotencyKey);
        return restTemplate.exchange(url("/api/v1/sessions/" + sessionId + "/fork"),
                HttpMethod.POST, new HttpEntity<>(body, headers), Map.class);
    }

    private ResponseEntity<Map> getBranches(String sessionId) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        return restTemplate.exchange(url("/api/v1/sessions/" + sessionId + "/branches"),
                HttpMethod.GET, new HttpEntity<>(headers), Map.class);
    }

    private ResponseEntity<Map> postBranch(Source source, String key, String sourceBranchId,
                                           String anchorMessageId) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("Idempotency-Key", key);
        Map<String, Object> body = Map.of(
                "sourceBranchId", sourceBranchId,
                "anchorMessageId", anchorMessageId);
        return restTemplate.exchange(url("/api/v1/sessions/" + source.session().getId() + "/branches"),
                HttpMethod.POST, new HttpEntity<>(body, headers), Map.class);
    }

    private ResponseEntity<Map> postCompact(String sessionId, Map<String, Object> body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return restTemplate.exchange(url("/api/v1/sessions/" + sessionId + "/compact"),
                HttpMethod.POST, new HttpEntity<>(body, headers), Map.class);
    }

    private ResponseEntity<List<Map<String, Object>>> getChildMessages(String childSessionId) {
        return getMessages(childSessionId, branchPathService.ensureRootBranchId(childSessionId));
    }

    private ResponseEntity<List<Map<String, Object>>> getMessages(String sessionId, String branchId) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        return restTemplate.exchange(url("/api/v1/sessions/" + sessionId + "/messages?branchId=" + branchId),
                HttpMethod.GET, new HttpEntity<>(headers), new ParameterizedTypeReference<>() { });
    }

    private ResponseEntity<Map> getMessagesWithoutBranch(String sessionId) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        return restTemplate.exchange(url("/api/v1/sessions/" + sessionId + "/messages"),
                HttpMethod.GET, new HttpEntity<>(headers), Map.class);
    }

    private ResponseEntity<Map> deleteSession(String sessionId) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        return restTemplate.exchange(url("/api/v1/sessions/" + sessionId), HttpMethod.DELETE,
                new HttpEntity<>(headers), Map.class);
    }

    private ResponseEntity<Map> deleteAttachment(Source source) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        return restTemplate.exchange(url("/api/v1/sessions/" + source.session().getId()
                        + "/attachments/" + source.file().getId()),
                HttpMethod.DELETE, new HttpEntity<>(headers), Map.class);
    }

    private int countRows(String sql, Object sessionId) {
        return jdbcTemplate.queryForObject(sql, Integer.class, sessionId);
    }

    /** messages has no {@code sequence} column (V1/V43): order the snapshot by created_at + id. */
    private List<Map<String, Object>> rootPathSnapshot(String sessionId, String branchId) {
        return jdbcTemplate.queryForList(
                "select id, content, created_at, run_id, role, branch_id from messages "
                        + "where session_id = ? and branch_id = ? order by created_at, id",
                UUID.fromString(sessionId), UUID.fromString(branchId));
    }

    private void reduceWorkspaceCapToReadOnly() throws Exception {
        var readOnly = objectMapper.readTree("[{\"actionClass\":\"read\"}]");
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principalId.toString(), workspaceId, readOnly));
    }

    private static List<UUID> sessionIds(GrantPrincipalPathResolver.AgentPath path) {
        return path.sessionPath().stream().map(Session::getId).toList();
    }

    private record Source(Session session, String branchId, String runId, String anchorMessageId,
                         File file, byte[] bytes) { }
}
