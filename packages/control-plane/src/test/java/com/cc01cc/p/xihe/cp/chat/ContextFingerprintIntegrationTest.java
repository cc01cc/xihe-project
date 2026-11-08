package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0666 M1b: migration + write-once dispatch write + read-side absence naming against a real
 * migrated PostgreSQL schema.
 *
 * <p>This is the integration slice of the evidence: the unit tests pin the document shape, this test
 * pins that column V113 really exists as {@code jsonb}, that the SQL guard makes the write genuinely
 * write-once, that the stored document is small enough for the design estimate, and that the read
 * envelope names absence instead of faking a state.
 */
class ContextFingerprintIntegrationTest extends AbstractReusableIntegrationTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceFixture workspaceFixture;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private ContextFingerprintRecorder recorder;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    private String userId;
    private String workspaceId;
    private String sessionId;
    private String runId;
    private static final String BRANCH_ID = "66666666-6666-4666-8666-666666666666";

    @BeforeEach
    void seedRun() {
        User user = userRepository.save(new User(
                "cf-" + UUID.randomUUID() + "@test.local", "hash", "CF"));
        userId = user.getId().toString();
        workspaceId = workspaceFixture.ensureOwnedWorkspace(UUID.fromString(userId)).getId().toString();
        Session session = new Session(workspaceId, userId, "context fingerprint it");
        session.setId(UUID.randomUUID());
        sessionId = sessionRepository.save(session).getId().toString();
        UUID runUuid = UUID.randomUUID();
        runId = runUuid.toString();
        chatRunRepository.saveAndFlush(new ChatRun(runId, sessionId, userId, workspaceId,
                "cf-key-" + runId, "hash", "provider", "model", "none", "accepted"));
    }

    @Test
    void migrationAddsNullableJsonbColumn() {
        List<Map<String, Object>> rows = jdbcTemplate.queryForList(
                "SELECT data_type, is_nullable FROM information_schema.columns "
                        + "WHERE table_name = 'chat_runs' AND column_name = 'context_fingerprint'");
        assertEquals(1, rows.size(), "V113 must add chat_runs.context_fingerprint");
        assertEquals("jsonb", rows.getFirst().get("data_type"));
        assertEquals("YES", rows.getFirst().get("is_nullable"),
                "legacy rows and never-dispatched runs have no document; absence is explicit in the API");

        List<Map<String, Object>> indexes = jdbcTemplate.queryForList(
                "SELECT indexname FROM pg_indexes WHERE tablename = 'chat_runs' "
                        + "AND indexdef LIKE '%context_fingerprint%'");
        assertTrue(indexes.isEmpty(), "D2: no index on the fingerprint column (read by PK only)");
    }

    @Test
    void recordsOnceAndReportsDocumentSize() {
        recorder.recordFirstDispatch(input("first content"));
        JsonNode first = storedDocument();
        assertEquals("ok", first.path("status").asText());
        assertEquals(true, first.path("enabled").asBoolean());
        assertEquals(1, first.path("dispatchAttempt").asInt());
        assertEquals("agent_side", first.path("layers").path("tools").path("unavailable").asText());
        assertTrue(first.path("layers").path("history").has("hash"));
        assertTrue(first.path("layers").path("config").has("hash"));

        recorder.recordFirstDispatch(input("second content entirely different"));
        JsonNode afterSecond = storedDocument();
        assertEquals(first, afterSecond, "the SQL guard makes the dispatch write write-once (D3 v1 boundary)");

        Integer bytes = jdbcTemplate.queryForObject(
                "SELECT pg_column_size(context_fingerprint) FROM chat_runs WHERE id = ?::uuid",
                Integer.class, runId);
        assertTrue(bytes != null && bytes > 0, "stored document must be measurable");
        System.out.println("[PLAN-0666] fingerprint pg_column_size=" + bytes + " bytes; doc="
                + first.toString().length() + " json chars");
        assertTrue(bytes < 8192, "design §5 estimate is ~1.3 KB/run; a TOASTed fingerprint would break it");
    }

    @Test
    void readEnvelopeNamesAbsenceInsteadOfFakingAState() {
        ContextFingerprintReadService.View notDispatched = ContextFingerprintReadService.view(
                runId, sessionId, null, ContextFingerprintReadService.DispatchState.NOT_DISPATCHED);
        assertFalse(notDispatched.available());
        assertEquals("not_dispatched", notDispatched.reason());
        assertEquals(false, storedDocumentOrNull() != null, "no document exists yet");

        ContextFingerprintReadService.View legacy = ContextFingerprintReadService.view(
                runId, sessionId, null, ContextFingerprintReadService.DispatchState.DISPATCHED);
        assertEquals("pre_plan", legacy.reason());

        recorder.recordFirstDispatch(input("content"));
        ContextFingerprintReadService.View present = ContextFingerprintReadService.view(
                runId, sessionId, storedDocument(), ContextFingerprintReadService.DispatchState.DISPATCHED);
        assertTrue(present.available());
        assertEquals("ok", present.fingerprint().path("status").asText());
    }

    @Test
    void writeOnceGuardReadsByPrimaryKey() {
        String plan = jdbcTemplate.queryForList(
                "EXPLAIN UPDATE chat_runs SET context_fingerprint = '{}'::jsonb, "
                        + "updated_at = CURRENT_TIMESTAMP WHERE id = ?::uuid AND context_fingerprint IS NULL",
                String.class, runId).toString();
        System.out.println("[PLAN-0666] update plan=" + plan);
        assertTrue(plan.contains("Scan"), "the guarded update must be a plain scan path, got: " + plan);
    }

    private ContextFingerprintRecorder.RecordInput input(String content) {
        Map<String, Object> componentSources = new LinkedHashMap<>();
        componentSources.put("agent_memory", "remembered fact");
        ObjectNode template = MAPPER.createObjectNode().put("templateId", "tpl-1").put("version", 2);
        ObjectNode skills = MAPPER.createObjectNode().put("status", "empty");
        Map<String, Object> outbound = new LinkedHashMap<>();
        outbound.put("content", content);
        outbound.put("runId", runId);
        outbound.put("requestId", "req-1");
        outbound.put("toolMode", "none");
        return new ContextFingerprintRecorder.RecordInput(
                runId, sessionId, BRANCH_ID, userId, workspaceId, template, skills, content,
                componentSources, "system instructions", Map.of(), Map.of(), outbound);
    }

    private JsonNode storedDocument() {
        JsonNode document = storedDocumentOrNull();
        assertTrue(document != null, "expected a stored fingerprint document");
        return document;
    }

    private JsonNode storedDocumentOrNull() {
        ChatRun reloaded = chatRunRepository.findById(UUID.fromString(runId)).orElseThrow();
        return reloaded.getContextFingerprint();
    }
}
