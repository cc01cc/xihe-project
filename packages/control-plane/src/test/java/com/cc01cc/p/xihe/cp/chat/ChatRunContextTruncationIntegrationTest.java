package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0670 M2c / BL-293: the Agent's inbound truncation marker is persisted on the ChatRun terminal
 * write as {@code chat_runs.context_truncation} (jsonb), the exact same object the UI receives on
 * {@code done.agentContextTruncation}. Real PostgreSQL (Testcontainers), not H2.
 *
 * <p>Two states are mandatory: truncation present ⇒ JSON round-trip equals the object; no truncation ⇒
 * {@code NULL} (never {@code {}} or all-zero stats). The migration test additionally proves V124 can be
 * applied and that a row written without the marker stays null in an already-migrated database.
 */
class ChatRunContextTruncationIntegrationTest extends AbstractIntegrationTest {

    private static final String TRUNCATION_JSON = """
            {"droppedMessages":500,"keptMessages":2000,"keptBytes":1030000,"droppedBytes":9270000,
             "limitMessages":2000,"limitBytes":8388608,"strategy":"newestKeep"}
            """;

    @Autowired
    private WorkspaceFixture workspaceFixture;

    @Autowired
    private ChatRunTerminalService terminalService;

    @Autowired
    private ChatRunRepository runs;

    @Autowired
    private SessionRepository sessions;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private ObjectMapper objectMapper;

    private String userId;
    private String workspaceId;
    private String sessionId;

    @BeforeEach
    void setUp() {
        String email = "truncation-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> reg = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "Truncation Probe"),
                AuthResponse.class);
        assertTrue(reg.getStatusCode().is2xxSuccessful());

        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        workspaceId = workspaceFixture.ensureOwnedWorkspace(UUID.fromString(userId)).getId().toString();

        Session session = new Session(workspaceId, userId, "Truncation Probe Session");
        session.setId(UUID.randomUUID());
        sessionId = sessions.save(session).getId().toString();
    }

    private String createRun() {
        ChatRun run = new ChatRun(UUID.randomUUID().toString(), sessionId, userId, workspaceId,
                "truncation-key-" + UUID.randomUUID(), "hash", "provider", "model", "workspace", "running");
        return runs.save(run).getId().toString();
    }

    private ChatRunTerminalService.TerminalResult terminalize(String runId, JsonNode truncation) {
        return terminalService.terminalize(new ChatRunTerminalService.TerminalRequest(
                runId, List.of("running"), "succeeded", "success", null, null,
                7, 42, ChatRunTerminalService.TerminalSource.STREAM, null, null, truncation));
    }

    @Test
    void terminalWritePersistsTheExactJsonbObjectAndKeepsTheExistingTerminalColumns() throws Exception {
        String runId = createRun();
        JsonNode expected = objectMapper.readTree(TRUNCATION_JSON);

        assertTrue(terminalize(runId, expected).committed());

        ChatRun run = runs.findById(UUID.fromString(runId)).orElseThrow();
        assertEquals(expected, run.getContextTruncation(), "entity round-trip must equal the Agent object");
        assertEquals("succeeded", run.getStatus());
        assertEquals("success", run.getTerminalOutcome());
        assertEquals(7, run.getTokenCount());
        assertEquals(42, run.getAssistantChars());
        assertNull(run.getErrorCode(), "no error code was supplied; existing terminal columns untouched");

        String stored = jdbcTemplate.queryForObject(
                "select context_truncation::text from chat_runs where id = ?", String.class,
                UUID.fromString(runId));
        assertEquals(expected, objectMapper.readTree(stored),
                "jsonb round-trip must equal the object the UI receives on done.agentContextTruncation");

        String terminalOutcome = jdbcTemplate.queryForObject(
                "select terminal_outcome from chat_runs where id = ?", String.class, UUID.fromString(runId));
        assertEquals("success", terminalOutcome, "BL-293 must not disturb the existing terminal columns");
    }

    @Test
    void noTruncationLeavesTheColumnNullNotAnEmptyObject() {
        String runId = createRun();

        assertTrue(terminalize(runId, null).committed());

        ChatRun run = runs.findById(UUID.fromString(runId)).orElseThrow();
        assertNull(run.getContextTruncation(), "no marker -> entity stays null");
        List<Object> stored = jdbcTemplate.queryForList(
                "select context_truncation from chat_runs where id = ?", Object.class, UUID.fromString(runId));
        assertEquals(1, stored.size());
        assertNull(stored.getFirst(), "no marker -> SQL NULL (never {} or all-zero stats)");
    }

    @Test
    void migrationV124IsAppliedAndColumnIsNullableJsonb() {
        Integer applied = jdbcTemplate.queryForObject(
                "select count(*) from flyway_schema_history where version = '124' and success",
                Integer.class);
        assertEquals(1, applied, "V124 must be present and successful in a migrated database");

        Map<String, Object> column = jdbcTemplate.queryForMap(
                "select data_type, is_nullable from information_schema.columns "
                        + "where table_name = 'chat_runs' and column_name = 'context_truncation'");
        assertEquals("jsonb", column.get("data_type"));
        assertEquals("YES", column.get("is_nullable"),
                "pre-V124 rows / runs without truncation must be allowed to stay NULL");
    }
}
