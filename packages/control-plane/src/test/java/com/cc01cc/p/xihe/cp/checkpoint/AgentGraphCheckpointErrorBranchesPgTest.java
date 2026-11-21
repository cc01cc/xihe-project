package com.cc01cc.p.xihe.cp.checkpoint;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.context.service.ContextService;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * task-142: each rejection branch of the CP checkpoint face, asserted as (status, code, {@code branch})
 * against a real PostgreSQL carrying the real V72 constraints and the real V43 branch/Run schema.
 *
 * <p>Why this lane instead of H2 or a mocked JdbcTemplate: the branches being separated here are
 * decided by three database facts -- {@code uq_agent_graph_checkpoint_writes_saver_key},
 * {@code fk_agent_graph_checkpoint_write_checkpoint}, and
 * {@code uq_agent_graph_checkpoints_saver_key}. Under H2 (Flyway off) none of them exist, so a stub
 * would be inventing the conflict rather than the schema producing it. The three constraints are
 * counted before any case runs, so an unmigrated or empty schema fails closed instead of reading green.
 *
 * <p>Scope of the doubles: only the three non-storage collaborators (Session lookup, branch path,
 * visible-sequence read) are mocked. Every SQL the service runs goes to PostgreSQL.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class AgentGraphCheckpointErrorBranchesPgTest {

    private final UUID userId = UUID.randomUUID();
    private final UUID workspaceId = UUID.randomUUID();
    private final UUID sessionId = UUID.randomUUID();
    private final UUID rootBranchId = UUID.randomUUID();
    private final UUID forkBranchId = UUID.randomUUID();
    private final UUID runA = UUID.randomUUID();
    private final UUID runB = UUID.randomUUID();
    private final UUID forkMessageId = UUID.randomUUID();
    private final UUID lineageId = UUID.randomUUID();
    private final UUID threadId = UUID.randomUUID();

    private JdbcTemplate jdbc;
    private SessionRepository sessions;
    private AgentGraphCheckpointService service;

    @BeforeAll
    void migrateSeedAndProveConstraints() {
        TestDatabaseProvider.DatabaseRef database =
                TestDatabaseProvider.migratedDatabase("t142cperrorbranch");
        DriverManagerDataSource dataSource = new DriverManagerDataSource();
        dataSource.setDriverClassName(TestDatabaseProvider.driverClassName());
        dataSource.setUrl(database.jdbcUrl());
        dataSource.setUsername(database.username());
        dataSource.setPassword(database.password());
        jdbc = new JdbcTemplate(dataSource);

        jdbc.update("INSERT INTO users (id, email, password_hash, username) "
                        + "VALUES (?::uuid, ?, 'x', 't142-cp-error')",
                userId.toString(), "t142-" + userId + "@test.local");
        // V89 dropped workspaces.owner_id (the owner fact moved to the WS_OWNER binding); at head the
        // only NOT NULL column without a default is `name`.
        jdbc.update("INSERT INTO workspaces (id, name) VALUES (?::uuid, 't142-ws')",
                workspaceId.toString());
        jdbc.update("INSERT INTO sessions (id, workspace_id, user_id, title) "
                        + "VALUES (?::uuid, ?::uuid, ?::uuid, 't142-session')",
                sessionId.toString(), workspaceId.toString(), userId.toString());
        // V43 keeps exactly one ROOT branch per Session (uq_session_branches_root), so the second
        // branch used by the scope test must be a child with a complete anchor (ck_session_branches_child_fields).
        jdbc.update("INSERT INTO session_branches (id, session_id, created_at) VALUES (?::uuid, ?::uuid, NOW())",
                rootBranchId.toString(), sessionId.toString());
        insertRun(runA, rootBranchId, "t142-run-a");
        jdbc.update("INSERT INTO messages (id, session_id, run_id, role, content, branch_id) "
                        + "VALUES (?::uuid, ?::uuid, ?::uuid, 'USER', 'anchor', ?::uuid)",
                forkMessageId.toString(), sessionId.toString(), runA.toString(), rootBranchId.toString());
        jdbc.update("INSERT INTO session_branches (id, session_id, parent_branch_id, "
                        + "fork_point_message_id, fork_point_run_id, fork_point_sequence, "
                        + "idempotency_key, request_hash, created_at) "
                        + "VALUES (?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid, 1, 't142-fork', ?, NOW())",
                forkBranchId.toString(), sessionId.toString(), rootBranchId.toString(),
                forkMessageId.toString(), runA.toString(), "b".repeat(64));
        insertRun(runB, forkBranchId, "t142-run-b");
        jdbc.update("""
                INSERT INTO agent_graph_checkpoint_lineages
                    (lineage_id, thread_id, session_id, user_id, workspace_id, branch_id,
                     source_run_id, probe_id, producer_version, schema_version)
                VALUES (?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid, NULL, '0.1.0', 1)
                """, lineageId.toString(), threadId.toString(), sessionId.toString(),
                userId.toString(), workspaceId.toString(), rootBranchId.toString(), runA.toString());

        assertEquals(1, countConstraint("uq_agent_graph_checkpoint_writes_saver_key"),
                "the V72 pending-write saver key must exist in this test database");
        assertEquals(1, countConstraint("fk_agent_graph_checkpoint_write_checkpoint"),
                "the V72 writes -> checkpoint FK must exist in this test database");
        assertEquals(1, countConstraint("uq_agent_graph_checkpoints_saver_key"),
                "the V72 checkpoint saver key must exist in this test database");

        sessions = mock(SessionRepository.class);
        stubOwnedSession();
        ContextService contextService = mock(ContextService.class);
        when(contextService.latestVisibleSequence(any(), any())).thenReturn(1_000L);
        service = new AgentGraphCheckpointService(
                jdbc, sessions, new ObjectMapper(), mock(BranchPathService.class), contextService);
    }

    private void stubOwnedSession() {
        Session session = new Session(workspaceId.toString(), userId.toString(), "t142");
        session.setId(sessionId);
        when(sessions.findByIdAndUserIdAndWorkspaceIdAndArchivedFalse(
                any(), any(), any())).thenReturn(Optional.of(session));
    }

    private void insertRun(UUID id, UUID branchId, String idempotencyKey) {
        jdbc.update("INSERT INTO chat_runs (id, session_id, user_id, workspace_id, idempotency_key, "
                        + "request_hash, status, origin, branch_id) "
                        + "VALUES (?::uuid, ?::uuid, ?::uuid, ?::uuid, ?, ?, 'succeeded', "
                        + "'user_submission', ?::uuid)",
                id.toString(), sessionId.toString(), userId.toString(), workspaceId.toString(),
                idempotencyKey, "a".repeat(64), branchId.toString());
    }

    private int countConstraint(String name) {
        Integer value = jdbc.queryForObject(
                "SELECT count(*) FROM pg_constraint WHERE conname = ?", Integer.class, name);
        return value == null ? 0 : value;
    }

    /** The card's assertion target: status, code and the structured branch, together. */
    private static void assertRejection(int status, String code,
            AgentGraphCheckpointService.CheckpointBranch branch, Runnable action) {
        CpApiException failure = assertThrows(CpApiException.class, action::run);
        assertEquals(status, failure.getStatus().value(), "status for " + code + " / " + branch);
        assertEquals(code, failure.getCode(), "code for branch " + branch);
        assertNotNull(failure.getExtra().get("branch"), "branch must be published for " + code);
        assertEquals(branch.name(), failure.getExtra().get("branch"), "branch value");
    }

    private AgentGraphCheckpointService.PutWritesRequest writes(
            String checkpointId, String taskId, int writeIndex, String channel, String text) {
        return new AgentGraphCheckpointService.PutWritesRequest(
                sessionId.toString(), userId.toString(), workspaceId.toString(),
                "", checkpointId, taskId, "", List.of(new AgentGraphCheckpointService.WriteValue(
                        channel, "str", Base64.getEncoder().encodeToString(text.getBytes()), writeIndex)));
    }

    private void storeCheckpoint(String checkpointId, String text) {
        service.putCheckpoint(threadId.toString(), new AgentGraphCheckpointService.PutCheckpointRequest(
                sessionId.toString(), userId.toString(), workspaceId.toString(),
                "", checkpointId, null, "str",
                Base64.getEncoder().encodeToString(text.getBytes()), Map.of("eventSequence", 0)));
    }

    @Test
    void noLineageForThisOwnerThreadIsALineageNotFound() {
        // 404 family, "genuinely absent": nothing matches the thread + owner triple.
        assertRejection(404, "CHECKPOINT_LINEAGE_NOT_FOUND",
                AgentGraphCheckpointService.CheckpointBranch.THREAD_NOT_BOUND_TO_OWNER,
                () -> service.putWrites(UUID.randomUUID().toString(),
                        writes("0001", "task-none", 0, "ch", "hi")));
    }

    @Test
    void aLineageBoundToAnotherBranchIsAScopeMismatchNotAMissingLineage() {
        // The window-2 ambiguity, resolved: the row EXISTS; the caller's identity claim does not match
        // it. runB lives on the fork branch while the lineage is bound to runA/root.
        assertRejection(404, "CHECKPOINT_SCOPE_MISMATCH",
                AgentGraphCheckpointService.CheckpointBranch.BOUND_IDENTITY_DIFFERS,
                () -> service.getLineage(threadId.toString(),
                        new AgentGraphCheckpointService.LineageLookupRequest(
                                sessionId.toString(), userId.toString(), workspaceId.toString(),
                                runB.toString(), null)));
    }

    @Test
    void writesForACheckpointThatNeverLandedAreTargetNotFoundNotScopeMismatch() {
        // The branch that produced the window-2 404. CP rejects on the FOR UPDATE read, before the
        // V72 writes FK would fire.
        assertRejection(404, "CHECKPOINT_TARGET_NOT_FOUND",
                AgentGraphCheckpointService.CheckpointBranch.CHECKPOINT_ROW_MISSING,
                () -> service.putWrites(threadId.toString(),
                        writes("never-stored", "task-gone", 0, "ch", "hi")));
        assertEquals(0, writeCount("never-stored", "task-gone"), "a rejected write stores nothing");
    }

    @Test
    void sameSaverKeyWithDifferentChannelIsAWriteConflictAndDoesNotOverwrite() {
        // Contract claim at openapi.yaml `POST /writes`: `channel` is compared, not part of the key,
        // so a different channel on the same key conflicts instead of replacing.
        String checkpointId = "cp-write-conflict";
        storeCheckpoint(checkpointId, "cp");
        service.putWrites(threadId.toString(), writes(checkpointId, "task-1", 0, "channel-one", "hi"));
        assertRejection(409, "CHECKPOINT_WRITE_CONFLICT",
                AgentGraphCheckpointService.CheckpointBranch.PENDING_WRITE_KEY_BOUND_TO_OTHER_DATA,
                () -> service.putWrites(threadId.toString(),
                        writes(checkpointId, "task-1", 0, "channel-two", "bye")));
        assertEquals(1, writeCount(checkpointId, "task-1"), "a rejected write must not append");
        assertEquals("channel-one", jdbc.queryForObject(
                "SELECT channel FROM agent_graph_checkpoint_writes "
                        + "WHERE thread_id = ?::uuid AND checkpoint_id = ? AND task_id = ? AND write_index = 0",
                String.class, threadId.toString(), checkpointId, "task-1"),
                "a rejected write must not overwrite the stored channel");
    }

    @Test
    void replayOfAnIdenticalWriteIsStillIdempotentAfterTheSplit() {
        // Reverse probe 1: the legal path must not be judged red by the new codes.
        String checkpointId = "cp-write-replay";
        storeCheckpoint(checkpointId, "cp");
        service.putWrites(threadId.toString(), writes(checkpointId, "task-r", 0, "ch", "hi"));
        service.putWrites(threadId.toString(), writes(checkpointId, "task-r", 0, "ch", "hi"));
        assertEquals(1, writeCount(checkpointId, "task-r"));
    }

    @Test
    void replayOfAnIdenticalCheckpointIsStillIdempotent() {
        // Reverse probe 2: the same-bytes branch of the upsert stays a no-op 204.
        String checkpointId = "cp-cp-replay";
        storeCheckpoint(checkpointId, "same");
        storeCheckpoint(checkpointId, "same");
        assertEquals(1, jdbc.queryForObject(
                "SELECT count(*) FROM agent_graph_checkpoints WHERE thread_id = ?::uuid AND checkpoint_id = ?",
                Integer.class, threadId.toString(), checkpointId));
    }

    @Test
    void differentBytesOnTheCheckpointSaverKeyIsStillAConflict() {
        // Reverse probe 3: the illegal write is still refused, now with its own branch.
        String checkpointId = "cp-cp-conflict";
        storeCheckpoint(checkpointId, "one");
        assertRejection(409, "CHECKPOINT_KEY_CONFLICT",
                AgentGraphCheckpointService.CheckpointBranch.CHECKPOINT_KEY_BOUND_TO_OTHER_DATA,
                () -> storeCheckpoint(checkpointId, "two"));
    }

    @Test
    void anOwnerTripleWithoutASessionIsAScopeMismatch() {
        when(sessions.findByIdAndUserIdAndWorkspaceIdAndArchivedFalse(
                any(), any(), any())).thenReturn(Optional.empty());
        try {
            assertRejection(404, "CHECKPOINT_SCOPE_MISMATCH",
                    AgentGraphCheckpointService.CheckpointBranch.SESSION_OWNER_TRIPLE_UNMATCHED,
                    () -> service.putWrites(threadId.toString(),
                            writes("0001", "task-nosession", 0, "ch", "hi")));
        } finally {
            stubOwnedSession();
        }
    }

    @Test
    void aSourceRunWithNoLineageIsALineageNotFoundNotAScopeMismatch() {
        assertRejection(404, "CHECKPOINT_LINEAGE_NOT_FOUND",
                AgentGraphCheckpointService.CheckpointBranch.SOURCE_RUN_HAS_NO_LINEAGE,
                () -> service.findLatestSafeCheckpointForSourceRun(runB.toString(),
                        new AgentGraphCheckpointService.OwnerRequest(
                                sessionId.toString(), userId.toString(), workspaceId.toString())));
    }

    @Test
    void aSourceRunOutsideTheScopeIsATargetNotFound() {
        UUID foreignRun = UUID.randomUUID();
        assertRejection(404, "CHECKPOINT_TARGET_NOT_FOUND",
                AgentGraphCheckpointService.CheckpointBranch.SOURCE_RUN_UNAVAILABLE,
                () -> service.findLatestSafeCheckpointForSourceRun(foreignRun.toString(),
                        new AgentGraphCheckpointService.OwnerRequest(
                                sessionId.toString(), userId.toString(), workspaceId.toString())));
    }

    @Test
    void aLookupWithoutExactlyOneIdentityIsAScopeMismatch() {
        // `sourceRunId` and `probeId` must be supplied exactly one at a time; both-or-neither is a
        // malformed scope claim, not "the lineage is absent".
        assertRejection(404, "CHECKPOINT_SCOPE_MISMATCH",
                AgentGraphCheckpointService.CheckpointBranch.LOOKUP_IDENTITY_SHAPE,
                () -> service.getLineage(threadId.toString(),
                        new AgentGraphCheckpointService.LineageLookupRequest(
                                sessionId.toString(), userId.toString(), workspaceId.toString(),
                                null, null)));
    }

    @Test
    void theBranchAndCursorDefensiveStatesAreUnreachableThroughThisSchema() {
        // task-142 evidence for the lead's ruling #1 and #3. `BRANCH_MISSING_FOR_SESSION` and the two
        // "conflict but the row read back empty" branches need a lineage whose branch row is gone, or a
        // saver-key conflict with no visible row. V72 forbids exactly those states:
        // fk_agent_graph_checkpoint_lineage_branch and the writes/checkpoint FKs are enforced (deferred
        // to commit, still enforced), so an orphan cannot be persisted -- asserted here rather than
        // claimed. Those branches therefore stay defensive and are pinned in the unit lane.
        UUID orphanThread = UUID.randomUUID();
        UUID orphanRun = UUID.randomUUID();
        insertRun(orphanRun, rootBranchId, "t142-run-orphan");
        Exception failure = assertThrows(Exception.class, () -> jdbc.update("""
                INSERT INTO agent_graph_checkpoint_lineages
                    (lineage_id, thread_id, session_id, user_id, workspace_id, branch_id,
                     source_run_id, probe_id, producer_version, schema_version)
                VALUES (?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid, NULL, '0.1.0', 1)
                """, UUID.randomUUID().toString(), orphanThread.toString(), sessionId.toString(),
                userId.toString(), workspaceId.toString(), UUID.randomUUID().toString(),
                orphanRun.toString()));
        // Assert the PostgreSQL SQLState, not a Spring exception class: 23503 is
        // foreign_key_violation. A fresh Run and a fresh thread mean the lineage -> branch FK is the
        // only constraint this INSERT can violate; if a unique violation (23505) ever showed up here,
        // the case would be proving the wrong constraint.
        assertEquals("23503", sqlState(failure),
                "an orphaned lineage must be refused by the V72 branch FK, got: " + failure);
    }

    /** Walk the cause chain until a SQLException SQLState is found (Spring wraps the PG exception). */
    private static String sqlState(Throwable failure) {
        for (Throwable current = failure; current != null; current = current.getCause()) {
            if (current instanceof java.sql.SQLException sql) {
                return sql.getSQLState();
            }
        }
        return "(none)";
    }

    private int writeCount(String checkpointId, String taskId) {
        Integer value = jdbc.queryForObject(
                "SELECT count(*) FROM agent_graph_checkpoint_writes "
                        + "WHERE thread_id = ?::uuid AND checkpoint_id = ? AND task_id = ?",
                Integer.class, threadId.toString(), checkpointId, taskId);
        return value == null ? 0 : value;
    }
}
