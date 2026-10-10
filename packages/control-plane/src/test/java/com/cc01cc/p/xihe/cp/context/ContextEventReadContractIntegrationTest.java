package com.cc01cc.p.xihe.cp.context;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.context.service.ContextProjectionService;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/** Real CP/PG wire and the unmodified Python EventStore consumer. */
class ContextEventReadContractIntegrationTest extends AbstractIntegrationTest {

    private static final String SERVICE_TOKEN = UUID.randomUUID() + "-" + UUID.randomUUID();
    private static final String MARKER = "syntheticSensitiveMarker0470";
    private static final Set<String> EVENT_KEYS = Set.of("aggregate_id", "sequence", "type",
            "payload", "created_at", "correlation_id", "causation_id");

    @Autowired
    private SessionRepository sessionRepository;
    @Autowired
    private UserRepository userRepository;
    @Autowired
    private WorkspaceRepository workspaceRepository;
    @Autowired
    private EventStoreService eventStoreService;
    @Autowired
    private ContextProjectionService projectionService;
    @Autowired
    private JdbcTemplate jdbcTemplate;
    @Autowired
    private ObjectMapper objectMapper;
    @Autowired
    private tools.jackson.databind.ObjectMapper runtimeObjectMapper;
    @TempDir
    private Path tempDir;

    private String userId;
    private String workspaceId;
    private String sessionId;
    private String userToken;

    @DynamicPropertySource
    static void serviceToken(DynamicPropertyRegistry registry) {
        registry.add("cp.agent-api-token", () -> SERVICE_TOKEN);
    }

    @BeforeEach
    void registerAndCreateSession() throws Exception {
        assertThat(request("GET", "/api/v1/health", null, null).statusCode()).isEqualTo(200);
        String email = "context-read-" + UUID.randomUUID() + "@test.com";
        var registration = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new RegisterRequest(email, TestDataFactory.PASSWORD, "ContextReadContract"), AuthResponse.class);
        assertTrue(registration.getStatusCode().is2xxSuccessful(), "test registration failed");
        assertThat(registration.getBody()).isNotNull();
        userToken = registration.getBody().getAccessToken();
        userId = userRepository.findByEmail(email).orElseThrow().getId().toString();
        workspaceId = workspaceRepository.findActiveByMemberUserId(UUID.fromString(userId))
                .getFirst().getId().toString();
        var session = new Session(workspaceId, userId, "Context read contract");
        session.setId(UUID.randomUUID());
        sessionId = sessionRepository.save(session).getId().toString();
    }

    @Test
    void actualPythonAppendAndReadMatchesPersistedFields() throws Exception {
        assertThat(json(request("GET", eventsPath(), SERVICE_TOKEN, null)).isEmpty()).isTrue();
        var summary = probe("success", SERVICE_TOKEN, 200);
        assertThat(summary.path("sequence").asLong()).isEqualTo(1L);
        var wire = json(request("GET", eventsPath(), SERVICE_TOKEN, null));
        assertEvent(wire.get(0), 1L);
        assertThat(wire.get(0).path("payload").path("nested").path("items").get(0).isNull()).isTrue();
        assertThat(wire.get(0).path("payload").path("large").asText())
                .isEqualTo("123456789012345678901234567890");
    }

    @Test
    void readOrderFilterAndReplayPreserveSnapshotWire() throws Exception {
        var emptyReplay = json(request("POST", replayPath(), SERVICE_TOKEN, "{}"));
        assertThat(emptyReplay.path("events").isEmpty()).isTrue();
        eventStoreService.append(sessionId, workspaceId, userId, "epoch.started", Map.of("epoch_id", "one"));
        eventStoreService.append(sessionId, workspaceId, userId, "epoch.replaced", Map.of("epoch_id", "two"));
        var all = json(request("GET", eventsPath(), SERVICE_TOKEN, null));
        assertThat(all.size()).isEqualTo(2);
        assertEvent(all.get(0), 1L);
        assertEvent(all.get(1), 2L);
        var filtered = json(request("GET", eventsPath() + "?afterSequence=1", SERVICE_TOKEN, null));
        assertThat(filtered.size()).isEqualTo(1);
        assertEvent(filtered.get(0), 2L);
        var expectedSnapshot = projectionService.projectAndSave(sessionId, workspaceId, userId, 0L);
        // Existing replay snapshot uses the Boot 4 legacy-tree bean shape; do not fix it here.
        var snapshotWire = objectMapper.readTree(runtimeObjectMapper.writeValueAsString(expectedSnapshot));
        var replay = json(request("POST", replayPath(), SERVICE_TOKEN, "{}"));
        assertThat(replay.path("events")).isEqualTo(all);
        assertThat(replay.path("snapshot")).isEqualTo(snapshotWire);
        assertThat(keys(replay)).containsExactlyInAnyOrder("snapshot", "events");
    }

    @Test
    void nonObjectFailsWholeResponseAfterReplayProjectionCommits() throws Exception {
        eventStoreService.append(sessionId, workspaceId, userId, "epoch.started", Map.of("epoch_id", "committed"));
        assertThat(request("POST", replayPath(), SERVICE_TOKEN, "{}").statusCode()).isEqualTo(200);
        var before = projectionRow();
        assertThat(((Number) before.get("latest_sequence")).longValue()).isEqualTo(1L);
        eventStoreService.append(sessionId, workspaceId, userId, "llm.usage", List.of(MARKER));
        var loggers = List.of((Logger) LoggerFactory.getLogger(ContextEventResponseMapper.class),
                (Logger) LoggerFactory.getLogger(ProblemDetailsHandler.class),
                (Logger) LoggerFactory.getLogger(ContextProjectionService.class));
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        loggers.forEach(logger -> logger.addAppender(appender));
        try {
            assertProblem(request("GET", eventsPath(), SERVICE_TOKEN, null), 500, "INTERNAL_ERROR");
            probe("expected500", SERVICE_TOKEN, 500);
            assertProblem(request("POST", replayPath(), SERVICE_TOKEN, "{}"), 500, "INTERNAL_ERROR");
            var after = projectionRow();
            assertThat(after.get("id")).isEqualTo(before.get("id"));
            assertThat(((Number) after.get("latest_sequence")).longValue()).isEqualTo(2L);
            var payload = objectMapper.readTree((String) after.get("payload"));
            assertThat(payload.path("latest_sequence").asLong()).isEqualTo(2L);
            assertThat(payload.path("epoch").path("epoch_id").asText()).isEqualTo("committed");
            assertThat(jdbcTemplate.queryForObject(
                    "select count(*) from context_projections where session_id = ?::uuid",
                    Integer.class, sessionId)).isEqualTo(1);
            assertThat(jdbcTemplate.queryForObject(
                    "select jsonb_typeof(payload) from context_events where session_id = ?::uuid and sequence = 2",
                    String.class, sessionId)).isEqualTo("array");
            assertThat(appender.list).isNotEmpty().allSatisfy(event -> {
                assertThat(event.getFormattedMessage().contains(MARKER)).isFalse();
                assertThat(event.getFormattedMessage().contains(SERVICE_TOKEN)).isFalse();
                if (event.getThrowableProxy() != null) {
                    String throwable = ch.qos.logback.classic.spi.ThrowableProxyUtil.asString(event.getThrowableProxy());
                    assertThat(throwable.contains(MARKER) || throwable.contains(SERVICE_TOKEN)).isFalse();
                }
            });
        } finally {
            loggers.forEach(logger -> logger.detachAppender(appender));
            appender.stop();
        }
    }

    @Test
    void originalProjectionFailureKeepsExistingCommittedRow() throws Exception {
        eventStoreService.append(sessionId, workspaceId, userId, "epoch.started", Map.of("epoch_id", "baseline"));
        assertThat(request("POST", replayPath(), SERVICE_TOKEN, "{}").statusCode()).isEqualTo(200);
        var before = projectionRow();
        // Object JSON passes the response mapper, but the existing projector rejects this fork seed.
        eventStoreService.append(sessionId, workspaceId, userId, "session.forked", Map.of("summary_seed", Map.of()));
        assertThat(request("GET", eventsPath(), SERVICE_TOKEN, null).statusCode()).isEqualTo(200);
        assertProblem(request("POST", replayPath(), SERVICE_TOKEN, "{}"), 400, "INVALID_REQUEST");
        assertThat(projectionRow()).isEqualTo(before);
    }

    @Test
    void authenticationAndUnknownSessionKeepExistingFilterBoundary() throws Exception {
        assertProblem(request("GET", eventsPath(), null, null), 401, "AUTHORIZATION_REQUIRED");
        String wrongToken = UUID.randomUUID().toString();
        assertProblem(request("GET", eventsPath(), wrongToken, null), 401, "AUTHORIZATION_REQUIRED");
        probe("expectedautherror", wrongToken, 401);
        assertProblem(request("GET", eventsPath(), userToken, null), 403, "FORBIDDEN");
        var other = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new RegisterRequest("other-" + UUID.randomUUID() + "@test.com", TestDataFactory.PASSWORD, "Other"),
                AuthResponse.class);
        assertTrue(other.getStatusCode().is2xxSuccessful(), "second registration failed");
        assertThat(other.getBody()).isNotNull();
        assertProblem(request("GET", eventsPath(), other.getBody().getAccessToken(), null), 403, "FORBIDDEN");
        assertProblem(request("GET", "/internal/v1/context/" + UUID.randomUUID() + "/events",
                SERVICE_TOKEN, null), 403, "FORBIDDEN");
    }

    private void assertEvent(JsonNode event, long sequence) throws Exception {
        assertThat(keys(event)).containsExactlyInAnyOrderElementsOf(EVENT_KEYS);
        assertThat(event.path("aggregate_id").asText()).isEqualTo(sessionId);
        assertThat(event.path("sequence").asLong()).isEqualTo(sequence);
        assertThat(event.path("payload").isObject()).isTrue();
        assertThat(event.get("correlation_id").isNull()).isTrue();
        assertThat(event.get("causation_id").isNull()).isTrue();
        var stored = eventStoreService.read(sessionId, sequence - 1).getFirst();
        assertThat(event.path("type").asText()).isEqualTo(stored.getEventType());
        assertThat(Instant.parse(event.path("created_at").asText())).isEqualTo(stored.getCreatedAt());
        assertThat(event.path("payload")).isEqualTo(objectMapper.readTree(stored.getPayload()));
    }

    private List<String> keys(JsonNode node) {
        List<String> result = new ArrayList<>();
        node.fieldNames().forEachRemaining(result::add);
        return result;
    }

    private Map<String, Object> projectionRow() {
        return jdbcTemplate.queryForMap("select id, latest_sequence, payload::text as payload "
                + "from context_projections where session_id = ?::uuid", sessionId);
    }

    private void assertProblem(HttpResponse<String> response, int status, String code) throws Exception {
        assertThat(response.statusCode()).isEqualTo(status);
        assertThat(response.headers().firstValue("Content-Type").orElse("")).startsWith("application/problem+json");
        var problem = json(response);
        assertThat(problem.path("code").asText()).isEqualTo(code);
        assertThat(problem.path("status").asInt()).isEqualTo(status);
        assertThat(problem.path("requestId").asText()).isNotBlank()
                .isEqualTo(response.headers().firstValue("X-Request-Id").orElseThrow());
        assertThat(response.body().contains(MARKER) || response.body().contains(SERVICE_TOKEN)).isFalse();
        if (status == 500) {
            assertThat(problem.path("detail").asText()).isEqualTo("Context event response could not be constructed");
        }
    }

    private JsonNode json(HttpResponse<String> response) throws Exception {
        return objectMapper.readTree(response.body());
    }

    private HttpResponse<String> request(String method, String path, String token, String body) throws Exception {
        var builder = HttpRequest.newBuilder(URI.create(url(path))).timeout(Duration.ofSeconds(20))
                .header("Accept", "application/json");
        if (token != null) {
            builder.header("Authorization", "Bearer " + token);
        }
        builder.method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(body));
        if (body != null) {
            builder.header("Content-Type", "application/json");
        }
        try (var client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()) {
            return client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
        }
    }

    private JsonNode probe(String mode, String token, int expectedStatus) throws Exception {
        Path agentRoot = Path.of("..").resolve("agent").toAbsolutePath().normalize();
        String python = System.getProperty("xihe.context.python");
        if (python == null || python.isBlank()) {
            python = System.getenv("PLAN0470_AGENT_PYTHON");
        }
        if (python == null || python.isBlank()) {
            python = agentRoot.resolve(System.getProperty("os.name").startsWith("Windows")
                    ? ".venv/Scripts/python.exe" : ".venv/bin/python").toString();
        }
        assertTrue(Files.isRegularFile(Path.of(python)), "configured Python interpreter is required");
        Path stdout = tempDir.resolve(mode + "-" + UUID.randomUUID() + ".stdout");
        Path stderr = tempDir.resolve(mode + "-" + UUID.randomUUID() + ".stderr");
        var builder = new ProcessBuilder(python, "-B", "tests/integration/context_event_read_probe.py")
                .directory(agentRoot.toFile()).redirectOutput(stdout.toFile()).redirectError(stderr.toFile());
        var environment = builder.environment();
        environment.put("PYTHONDONTWRITEBYTECODE", "1");
        environment.put("NO_PROXY", "localhost,127.0.0.1,::1");
        environment.put("PLAN0470_CP_URL", baseUrl);
        environment.put("PLAN0470_SESSION_ID", sessionId);
        environment.put("PLAN0470_TOKEN", token);
        environment.put("PLAN0470_PROBE_MODE", mode);
        environment.put("PLAN0470_EXPECTED_STATUS", Integer.toString(expectedStatus));
        environment.put("PLAN0470_SENSITIVE_MARKER", MARKER);
        Process child = builder.start();
        List<ProcessHandle> descendants = new ArrayList<>();
        try {
            child.descendants().forEach(descendants::add);
            assertTrue(child.waitFor(60, TimeUnit.SECONDS), "Python context probe timed out");
            assertThat(child.exitValue()).as("Python context probe exit code; raw output withheld").isZero();
            String output = Files.readString(stdout);
            assertTrue(!output.contains(token) && !output.contains(MARKER), "unsafe Python probe output");
            assertTrue(Files.size(stderr) == 0, "Python stderr must be empty; raw output withheld");
            var summary = objectMapper.readTree(output);
            assertThat(summary.path("ok").asBoolean()).isTrue();
            assertThat(summary.path("mode").asText()).isEqualTo(mode);
            return summary;
        } finally {
            child.descendants().forEach(descendants::add);
            descendants.forEach(handle -> {
                if (handle.isAlive()) {
                    handle.destroyForcibly();
                }
            });
            if (child.isAlive()) {
                child.destroyForcibly();
            }
            assertTrue(child.waitFor(10, TimeUnit.SECONDS), "Python child cleanup failed");
            for (ProcessHandle handle : descendants) {
                handle.onExit().get(10, TimeUnit.SECONDS);
                assertTrue(!handle.isAlive(), "Python descendant cleanup failed");
            }
        }
    }

    private String eventsPath() {
        return "/internal/v1/context/" + sessionId + "/events";
    }

    private String replayPath() {
        return "/internal/v1/context/" + sessionId + "/replay";
    }
}
