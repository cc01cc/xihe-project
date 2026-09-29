package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionForkRequest;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
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
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.client.HttpServerErrorException;

import java.io.IOException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SessionForkFailureInjectionIntegrationTest extends AbstractIntegrationTest {

    private static final Path ATTACHMENT_ROOT = Paths.get(
            System.getProperty("java.io.tmpdir"), "xihe-session-fork-failure-it-" + UUID.randomUUID());

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
    @Autowired private SessionForkRequestRepository forkRequestRepository;
    @Autowired private JdbcTemplate jdbcTemplate;
    @Autowired private BranchPathService branchPathService;
    @Autowired private EventStoreService eventStoreService;

    private String userId;
    private String workspaceId;
    private String authToken;
    private UUID principalId;

    @BeforeEach
    void registerUserAndWorkspace() throws Exception {
        String email = "session-fork-fail-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> registered = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                new RegisterRequest(email, com.cc01cc.p.xihe.cp.integration.TestDataFactory.PASSWORD,
                        "SessionForkFailureTest"),
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
    void requestRowInsertFailureLeavesNoReservationAndRetryAfterDropSucceeds() throws Exception {
        Source source = createSource("request row insert failure prompt");
        String key = "fork-fail-request-row-" + UUID.randomUUID();
        String trigger = "xihe_t_fork_fail_request_row";
        String table = "session_fork_requests";
        try {
            installTrigger(trigger, table, "NEW.idempotency_key = '" + key + "'");

            HttpServerErrorException.InternalServerError failure = assertThrows(
                    HttpServerErrorException.InternalServerError.class,
                    () -> postFork(source, key, source.anchorMessageId()));
            assertProblemCode(failure, "INTERNAL_ERROR");

            assertFalse(forkRequestRepository.findBySourceSessionIdAndIdempotencyKey(
                            source.session().getId(), key).isPresent(),
                    "a rejected request-row insert must roll back its reservation");
            assertEquals(0, jdbcTemplate.queryForObject(
                            "select count(*) from session_fork_requests where source_session_id = ?",
                            Integer.class, source.session().getId()));
            assertEquals(0, forkChildCount(source));
        } finally {
            dropTrigger(trigger, table);
        }

        ResponseEntity<Map> retried = postFork(source, key, source.anchorMessageId());
        assertEquals(HttpStatus.CREATED, retried.getStatusCode());
        assertNotNull(retried.getBody().get("id"));
        SessionForkRequest request = forkRequestRepository
                .findBySourceSessionIdAndIdempotencyKey(source.session().getId(), key).orElseThrow();
        assertEquals(SessionForkRequest.COMPLETED, request.getState());
        assertEquals(1, forkChildCount(source));
    }

    @Test
    void childSessionInsertFailureHidesChildAndSameKeyRetryReusesReservedId() throws Exception {
        Source source = createSource("child session insert failure prompt");
        String key = "fork-fail-session-row-" + UUID.randomUUID();
        String trigger = "xihe_t_fork_fail_session_row";
        String table = "sessions";
        UUID reservedChildId;
        try {
            installTrigger(trigger, table, "NEW.kind = 'fork' "
                    + "AND NEW.spawned_from_session_id = '" + source.session().getId() + "'");

            HttpServerErrorException.InternalServerError failure = assertThrows(
                    HttpServerErrorException.InternalServerError.class,
                    () -> postFork(source, key, source.anchorMessageId()));
            assertProblemCode(failure, "INTERNAL_ERROR");

            SessionForkRequest request = forkRequestRepository
                    .findBySourceSessionIdAndIdempotencyKey(source.session().getId(), key).orElseThrow();
            reservedChildId = request.getChildSessionId();
            assertEquals(SessionForkRequest.RETRYABLE, request.getState(),
                    "cleanup succeeded, so the reservation stays reusable");
            assertNull(request.getLastErrorCode());
            assertTrue(sessionRepository.findById(reservedChildId).isEmpty(),
                    "the child Session must stay invisible until the final commit");
            assertEquals(0, forkChildCount(source));
            assertFalse(Files.exists(ATTACHMENT_ROOT.resolve(reservedChildId.toString())));
        } finally {
            dropTrigger(trigger, table);
        }

        ResponseEntity<Map> retried = postFork(source, key, source.anchorMessageId());
        assertEquals(HttpStatus.CREATED, retried.getStatusCode());
        assertEquals(reservedChildId.toString(), retried.getBody().get("id"),
                "the same key/hash retry must reuse the reserved child Session id");
        assertEquals(SessionForkRequest.COMPLETED,
                forkRequestRepository.findById(reservedChildId).orElseThrow().getState());
        assertEquals(1, forkChildCount(source));
    }

    @Test
    void grantTripwireDoesNotFireBecauseForkPublishesNoAgentGrantRow() throws Exception {
        Source source = createSource("grant tripwire prompt");
        String key = "fork-fail-grant-row-" + UUID.randomUUID();
        String trigger = "xihe_t_fork_fail_grant_row";
        String table = "grants";
        try {
            installTrigger(trigger, table, "NEW.subject_type = 'agent'");

            ResponseEntity<Map> response = postFork(source, key, source.anchorMessageId());
            assertEquals(HttpStatus.CREATED, response.getStatusCode());
            String childId = (String) response.getBody().get("id");
            assertNotNull(childId);
            SessionForkRequest request = forkRequestRepository
                    .findBySourceSessionIdAndIdempotencyKey(source.session().getId(), key).orElseThrow();
            assertEquals(SessionForkRequest.COMPLETED, request.getState());
            assertEquals(childId, request.getChildSessionId().toString());
            assertEquals(1, forkChildCount(source));
            assertEquals(0, jdbcTemplate.queryForObject(
                            "select count(*) from grants "
                                    + "where subject_type = 'agent' and subject_id = ?",
                            Integer.class, UUID.fromString(childId)),
                    "fork must not materialize an agent grant row for its child");
        } finally {
            dropTrigger(trigger, table);
        }
    }

    @Test
    void childMessageInsertFailureRollsBackPublishAndLeavesRetryableRequest() throws Exception {
        String marker = "fork-fail-message-" + UUID.randomUUID();
        Source source = createSource(marker);
        String key = "fork-fail-message-row-" + UUID.randomUUID();
        String trigger = "xihe_t_fork_fail_message_row";
        String table = "messages";
        try {
            installTrigger(trigger, table, "NEW.content = '" + marker + "'");

            HttpServerErrorException.InternalServerError failure = assertThrows(
                    HttpServerErrorException.InternalServerError.class,
                    () -> postFork(source, key, source.anchorMessageId()));
            assertProblemCode(failure, "INTERNAL_ERROR");

            SessionForkRequest request = forkRequestRepository
                    .findBySourceSessionIdAndIdempotencyKey(source.session().getId(), key).orElseThrow();
            assertEquals(SessionForkRequest.RETRYABLE, request.getState());
            assertNull(request.getLastErrorCode());
            assertTrue(sessionRepository.findById(request.getChildSessionId()).isEmpty());
            assertEquals(0, forkChildCount(source));
            assertFalse(Files.exists(ATTACHMENT_ROOT.resolve(request.getChildSessionId().toString())));
        } finally {
            dropTrigger(trigger, table);
        }
    }

    @Test
    void seedEventInsertFailureRollsBackPublishAndLeavesRetryableRequest() throws Exception {
        Source source = createSource("seed event insert failure prompt");
        String key = "fork-fail-seed-event-" + UUID.randomUUID();
        String trigger = "xihe_t_fork_fail_seed_event";
        String table = "context_events";
        try {
            installTrigger(trigger, table, "NEW.event_type = 'session.forked'");

            HttpServerErrorException.InternalServerError failure = assertThrows(
                    HttpServerErrorException.InternalServerError.class,
                    () -> postFork(source, key, source.anchorMessageId()));
            assertProblemCode(failure, "INTERNAL_ERROR");

            SessionForkRequest request = forkRequestRepository
                    .findBySourceSessionIdAndIdempotencyKey(source.session().getId(), key).orElseThrow();
            assertEquals(SessionForkRequest.RETRYABLE, request.getState());
            assertNull(request.getLastErrorCode());
            assertTrue(sessionRepository.findById(request.getChildSessionId()).isEmpty());
            assertEquals(0, forkChildCount(source));
            assertFalse(Files.exists(ATTACHMENT_ROOT.resolve(request.getChildSessionId().toString())));
        } finally {
            dropTrigger(trigger, table);
        }
    }

    private void installTrigger(String triggerName, String table, String whenClause) {
        jdbcTemplate.execute("CREATE OR REPLACE FUNCTION " + triggerName + "() RETURNS trigger "
                + "LANGUAGE plpgsql AS $$ BEGIN "
                + "RAISE EXCEPTION 'injected session fork failure %', TG_TABLE_NAME; END $$");
        jdbcTemplate.execute("DROP TRIGGER IF EXISTS " + triggerName + " ON " + table);
        jdbcTemplate.execute("CREATE TRIGGER " + triggerName + " BEFORE INSERT ON " + table
                + " FOR EACH ROW WHEN (" + whenClause + ") EXECUTE FUNCTION " + triggerName + "()");
    }

    private void dropTrigger(String triggerName, String table) {
        try {
            jdbcTemplate.execute("DROP TRIGGER IF EXISTS " + triggerName + " ON " + table);
            jdbcTemplate.execute("DROP FUNCTION IF EXISTS " + triggerName + "()");
        } catch (RuntimeException e) {
            LoggerFactory.getLogger(SessionForkFailureInjectionIntegrationTest.class)
                    .warn("session fork failure trigger cleanup failed: {}", e.getMessage(), e);
        }
    }

    private void assertProblemCode(HttpServerErrorException failure, String expectedCode) throws IOException {
        JsonNode problem = objectMapper.readTree(failure.getResponseBodyAsString());
        assertEquals(expectedCode, problem.path("code").asText());
        assertFalse(problem.has("childSessionId"),
                "a rejected fork must not disclose its reserved child Session id");
    }

    private int forkChildCount(Source source) {
        return jdbcTemplate.queryForObject(
                "select count(*) from sessions where kind = ? and spawned_from_session_id = ?",
                Integer.class, Session.KIND_FORK, source.session().getId());
    }

    private Source createSource(String promptContent) throws Exception {
        Session source = sessionService.createAgentSession(
                userId, workspaceId, "Fork failure source", "openai", "gpt-test", null, principalId.toString());
        String branchId = branchPathService.ensureRootBranchId(source.getId().toString());
        String runId = UUID.randomUUID().toString();
        ChatRun run = new ChatRun(runId, source.getId().toString(), userId, workspaceId,
                "fork-failure-source-" + runId, "a".repeat(64), "openai", "gpt-test", "none", "succeeded");
        run.setBranchId(branchId);
        run.setTerminalAt(Instant.now());
        run.setTerminalOutcome("success");
        run = chatRunRepository.saveAndFlush(run);

        Message userMessage = new Message(source.getId().toString(), MessageRole.USER, promptContent);
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
                "prompt.admitted", Map.of("message", Map.of("role", "human", "content", promptContent)),
                runId, branchId);
        eventStoreService.append(source.getId().toString(), workspaceId, userId,
                "assistant.responded", Map.of("message", Map.of("role", "ai", "content", "parent answer")),
                runId, branchId);
        return new Source(source, branchId, assistantMessage.getId().toString());
    }

    private UUID createBoundPrincipal() throws Exception {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("Session fork failure principal");
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

    private ResponseEntity<Map> postFork(Source source, String idempotencyKey, String anchorMessageId) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("Idempotency-Key", idempotencyKey);
        Map<String, Object> body = Map.of(
                "sourceBranchId", source.branchId(),
                "anchorMessageId", anchorMessageId);
        return restTemplate.exchange(url("/api/v1/sessions/" + source.session().getId() + "/fork"),
                HttpMethod.POST, new HttpEntity<>(body, headers), Map.class);
    }

    private record Source(Session session, String branchId, String anchorMessageId) { }
}
