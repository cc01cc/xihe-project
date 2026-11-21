package com.cc01cc.p.xihe.cp.checkpoint;

import com.cc01cc.p.xihe.cp.checkpoint.AgentGraphCheckpointService.CheckpointBranch;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.context.service.ContextService;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.test.util.ReflectionTestUtils;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;

/**
 * task-142, defensive lane: the branches a real PostgreSQL refuses to reach, so they cannot be proven
 * in {@link AgentGraphCheckpointErrorBranchesPgTest}. That class also asserts an orphaned lineage is
 * <i>uninsertable</i>; what is left here is "the write reported a conflict yet the row reads back empty",
 * the unreadable just-inserted row, and the cursor states -- reachable only by racing another
 * transaction or by a producer that wrote a bad cursor.
 *
 * <p>Stubs are keyed on SQL text, never on call order: an order-based chain breaks silently the moment
 * the service reads one row more, and it would then answer a different query with the fixture row.
 * The doubles answer SQL; the code and {@code branch} under test come out of the service.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class AgentGraphCheckpointDefensiveBranchesTest {

    @Mock private JdbcTemplate jdbc;
    @Mock private SessionRepository sessions;
    @Mock private BranchPathService branchPathService;
    @Mock private ContextService contextService;

    private final UUID userId = UUID.randomUUID();
    private final UUID workspaceId = UUID.randomUUID();
    private final UUID sessionId = UUID.randomUUID();
    private final UUID branchId = UUID.randomUUID();
    private final UUID sourceRunId = UUID.randomUUID();
    private final UUID lineageId = UUID.randomUUID();
    private final UUID threadId = UUID.randomUUID();

    private AgentGraphCheckpointService service() {
        Session session = new Session(workspaceId.toString(), userId.toString(), "t142");
        session.setId(sessionId);
        when(sessions.findByIdAndUserIdAndWorkspaceIdAndArchivedFalse(
                any(), any(), any())).thenReturn(Optional.of(session));
        return new AgentGraphCheckpointService(
                jdbc, sessions, new ObjectMapper(), branchPathService, contextService);
    }

    /**
     * The probe-only {@code createLineage} shape needs the isolation flag: without it the request is
     * refused with 400 before the branch under test is reached, and the case would pass for the wrong
     * reason.
     */
    private AgentGraphCheckpointService serviceWithProbeEnabled() {
        AgentGraphCheckpointService service = service();
        ReflectionTestUtils.setField(service, "checkpointProbeFlag", "1");
        return service;
    }

    /** Lineage row for this thread/owner triple -- the scope check resolves. */
    private void scopeResolves() {
        when(jdbc.query(contains("WHERE thread_id = ? AND session_id = ? AND user_id = ?"),
                any(RowMapper.class), any(Object[].class)))
                .thenReturn(List.of(new AgentGraphCheckpointService.Scope(
                        lineageId, threadId, sessionId, userId, workspaceId, branchId,
                        null, null, 1, "2026-11-22T00:00:00Z", "0.1.0")));
    }

    /** The branch referenced by the lineage exists. */
    private void branchResolves() {
        when(jdbc.queryForObject(contains("FROM session_branches"), eq(Integer.class),
                any(Object[].class))).thenReturn(1);
    }

    private static void assertRejection(int status, String code, CheckpointBranch branch, Runnable action) {
        CpApiException failure = assertThrows(CpApiException.class, action::run);
        assertEquals(status, failure.getStatus().value(), "status for " + code + " / " + branch);
        assertEquals(code, failure.getCode(), "code for branch " + branch);
        assertEquals(branch.name(), failure.getExtra().get("branch"), "branch value");
    }

    private AgentGraphCheckpointService.PutWritesRequest writes() {
        return new AgentGraphCheckpointService.PutWritesRequest(
                sessionId.toString(), userId.toString(), workspaceId.toString(),
                "", "cp-1", "task-d2", "", List.of(
                        new AgentGraphCheckpointService.WriteValue("ch", "str", "aGk=", 0)));
    }

    private AgentGraphCheckpointService.PutCheckpointRequest checkpoint(String payloadBase64) {
        return new AgentGraphCheckpointService.PutCheckpointRequest(
                sessionId.toString(), userId.toString(), workspaceId.toString(),
                "", "cp-1", null, "str", payloadBase64, Map.of());
    }

    @Test
    void aLineageWhoseBranchRowIsGoneIsTargetNotFound() {
        scopeResolves();
        when(jdbc.queryForObject(contains("FROM session_branches"), eq(Integer.class),
                any(Object[].class))).thenReturn(0);
        assertRejection(404, "CHECKPOINT_TARGET_NOT_FOUND", CheckpointBranch.BRANCH_MISSING_FOR_SESSION,
                () -> service().putWrites(threadId.toString(),
                        new AgentGraphCheckpointService.PutWritesRequest(
                                sessionId.toString(), userId.toString(), workspaceId.toString(),
                                "", "cp-1", "task-d1", "", List.of())));
    }

    @Test
    void checkpointConflictWithNoReadableRowStaysInTheNotFoundFamilyForRetryReasons() {
        scopeResolves();
        branchResolves();
        when(jdbc.update(anyString(), any(Object[].class))).thenReturn(0);
        // The saver-key conflict re-read finds nothing.
        when(jdbc.query(contains("FROM agent_graph_checkpoints"), any(RowMapper.class),
                any(Object[].class))).thenReturn(List.of());
        assertRejection(404, "CHECKPOINT_TARGET_NOT_FOUND",
                CheckpointBranch.CONFLICTED_CHECKPOINT_ROW_MISSING,
                () -> service().putCheckpoint(threadId.toString(), checkpoint("aGk=")));
    }

    @Test
    void pendingWriteConflictWithNoReadableRowStaysInTheNotFoundFamilyForRetryReasons() {
        scopeResolves();
        branchResolves();
        // The checkpoint the write targets does exist here; only the conflicted re-read comes back empty.
        when(jdbc.query(contains("SELECT checkpoint_row_id FROM agent_graph_checkpoints"),
                any(RowMapper.class), any(Object[].class)))
                .thenReturn(List.of(UUID.randomUUID()));
        when(jdbc.query(contains("FROM agent_graph_checkpoint_writes"), any(RowMapper.class),
                any(Object[].class))).thenReturn(List.of());
        when(jdbc.queryForObject(anyString(), eq(Long.class), any(Object[].class))).thenReturn(0L);
        when(jdbc.update(anyString(), any(Object[].class))).thenReturn(0);
        assertRejection(404, "CHECKPOINT_TARGET_NOT_FOUND",
                CheckpointBranch.PENDING_WRITE_ROW_MISSING_AFTER_CONFLICT,
                () -> service().putWrites(threadId.toString(), writes()));
    }

    @Test
    void aJustInsertedLineageThatCannotBeReadBackIsLineageNotFound() {
        AgentGraphCheckpointService service = serviceWithProbeEnabled();
        when(branchPathService.ensureRootBranchId(sessionId.toString())).thenReturn(branchId.toString());
        when(jdbc.queryForObject(contains("FROM session_branches"), eq(Integer.class),
                any(Object[].class))).thenReturn(1);
        when(jdbc.update(anyString(), any(Object[].class))).thenReturn(1);
        when(jdbc.queryForObject(contains("SELECT created_at FROM agent_graph_checkpoint_lineages"),
                eq(OffsetDateTime.class), any(UUID.class))).thenReturn(null);
        assertRejection(404, "CHECKPOINT_LINEAGE_NOT_FOUND", CheckpointBranch.LINEAGE_ROW_UNREADABLE,
                () -> service.createLineage(new AgentGraphCheckpointService.LineageRequest(
                        sessionId.toString(), userId.toString(), workspaceId.toString(),
                        null, UUID.randomUUID().toString(), "0.1.0")));
    }

    @Test
    void aLineageKeyTakenByAnInvisibleRowIsAConflictWithItsOwnBranch() {
        AgentGraphCheckpointService service = serviceWithProbeEnabled();
        when(branchPathService.ensureRootBranchId(sessionId.toString())).thenReturn(branchId.toString());
        when(jdbc.queryForObject(contains("FROM session_branches"), eq(Integer.class),
                any(Object[].class))).thenReturn(1);
        when(jdbc.update(anyString(), any(Object[].class))).thenReturn(0);
        when(jdbc.query(contains("FROM agent_graph_checkpoint_lineages"), any(RowMapper.class),
                any(Object[].class))).thenReturn(List.of());
        assertRejection(409, "CHECKPOINT_KEY_CONFLICT", CheckpointBranch.LINEAGE_KEY_ALREADY_BOUND,
                () -> service.createLineage(new AgentGraphCheckpointService.LineageRequest(
                        sessionId.toString(), userId.toString(), workspaceId.toString(),
                        null, UUID.randomUUID().toString(), "0.1.0")));
    }

    @Test
    void twoLineagesClaimingOneIdentityAreAmbiguousNotSilentlyMerged() {
        AgentGraphCheckpointService service = serviceWithProbeEnabled();
        AgentGraphCheckpointService.LineageView row = new AgentGraphCheckpointService.LineageView(
                lineageId.toString(), threadId.toString(), sessionId.toString(), null,
                null, branchId.toString(), userId.toString(), workspaceId.toString(),
                1, "2026-11-22T00:00:00Z", "0.1.0");
        when(branchPathService.ensureRootBranchId(sessionId.toString())).thenReturn(branchId.toString());
        when(jdbc.queryForObject(contains("FROM session_branches"), eq(Integer.class),
                any(Object[].class))).thenReturn(1);
        when(jdbc.query(contains("FROM agent_graph_checkpoint_lineages"), any(RowMapper.class),
                any(Object[].class))).thenReturn(List.of(row, row));
        assertRejection(409, "CHECKPOINT_KEY_CONFLICT", CheckpointBranch.LINEAGE_IDENTITY_AMBIGUOUS,
                () -> service.createLineage(new AgentGraphCheckpointService.LineageRequest(
                        sessionId.toString(), userId.toString(), workspaceId.toString(),
                        null, UUID.randomUUID().toString(), "0.1.0")));
    }

    @Test
    void aStoredCheckpointWithoutADecidableCursorSaysSoInsteadOfClaimingAbsence() {
        // The lead's ruling #2: the row EXISTS here, only its cursor is unreadable -- the detail must
        // not read like "nothing is stored", or a caller will branch to a fresh run instead of repairing.
        stubContinuationRead("{\"step\": 3}");
        CpApiException failure = assertThrows(CpApiException.class,
                () -> service().findLatestSafeCheckpointForSourceRun(sourceRunId.toString(),
                        new AgentGraphCheckpointService.OwnerRequest(
                                sessionId.toString(), userId.toString(), workspaceId.toString())));
        assertEquals(404, failure.getStatus().value());
        assertEquals("CHECKPOINT_TARGET_NOT_FOUND", failure.getCode());
        assertEquals(CheckpointBranch.CHECKPOINT_CURSOR_UNDECIDABLE.name(),
                failure.getExtra().get("branch"));
        assertTrue(failure.getMessage().contains("exists"),
                "detail must distinguish an undecidable cursor from an absent row, got: "
                        + failure.getMessage());
        assertTrue(!failure.getMessage().toLowerCase().contains("unavailable"),
                "detail must not imply absence: " + failure.getMessage());
    }

    /** The continuation read path up to "the newest checkpoint row exists with this metadata". */
    private void stubContinuationRead(String metadataJson) {
        when(jdbc.query(contains("FROM chat_runs"), any(RowMapper.class), any(Object[].class)))
                .thenReturn(List.of(branchId));
        when(jdbc.query(contains("WHERE source_run_id = ?"), any(RowMapper.class),
                any(Object[].class)))
                .thenReturn(List.of(new AgentGraphCheckpointService.Scope(
                        lineageId, threadId, sessionId, userId, workspaceId, branchId,
                        sourceRunId, null, 1, "2026-11-22T00:00:00Z", "0.1.0")));
        when(jdbc.query(contains("FROM agent_graph_checkpoints"), any(RowMapper.class),
                any(Object[].class)))
                .thenReturn(List.of(new AgentGraphCheckpointService.CheckpointRow(
                        lineageId, threadId, "", "cp-1", null, "str", new byte[]{1},
                        metadataJson, "2026-11-22T00:00:01Z")));
        when(jdbc.queryForObject(contains("FROM session_branches"), eq(Integer.class),
                any(Object[].class))).thenReturn(1);
    }

    @Test
    void aCursorBeyondTheVisibleHeadKeepsTheConflictStatusAndGainsItsBranch() {
        stubContinuationRead("{\"eventSequence\": 9}");
        when(contextService.latestVisibleSequence(any(), any())).thenReturn(4L);
        assertRejection(409, "CHECKPOINT_KEY_CONFLICT", CheckpointBranch.CURSOR_BEYOND_VISIBLE_HEAD,
                () -> service().findLatestSafeCheckpointForSourceRun(sourceRunId.toString(),
                        new AgentGraphCheckpointService.OwnerRequest(
                                sessionId.toString(), userId.toString(), workspaceId.toString())));
    }

    @Test
    void anOwnersSessionRowThatIsAbsentIsAScopeMismatch() {
        // Build the service first (service() installs the "session is owned" stub), then remove the
        // Session -- stubbing before service() would be overwritten by it and the case would prove
        // nothing.
        AgentGraphCheckpointService service = service();
        when(sessions.findByIdAndUserIdAndWorkspaceIdAndArchivedFalse(
                any(), any(), any())).thenReturn(Optional.empty());
        assertRejection(404, "CHECKPOINT_SCOPE_MISMATCH",
                CheckpointBranch.SESSION_OWNER_TRIPLE_UNMATCHED,
                () -> service.putWrites(threadId.toString(), writes()));
    }

    @Test
    void aLookupNamingBothOrNeitherIdentityFieldsIsAScopeMismatch() {
        scopeResolves();
        branchResolves();
        assertRejection(404, "CHECKPOINT_SCOPE_MISMATCH", CheckpointBranch.LOOKUP_IDENTITY_SHAPE,
                () -> service().getLineage(threadId.toString(),
                        new AgentGraphCheckpointService.LineageLookupRequest(
                                sessionId.toString(), userId.toString(), workspaceId.toString(),
                                null, null)));
    }
}
