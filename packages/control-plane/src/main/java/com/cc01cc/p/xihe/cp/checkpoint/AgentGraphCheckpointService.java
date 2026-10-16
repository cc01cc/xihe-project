package com.cc01cc.p.xihe.cp.checkpoint;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.context.service.ContextService;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** CP-owned persistence surface for the Agent's LangGraph BaseCheckpointSaver adapter. */
@Service
public class AgentGraphCheckpointService {

    private static final int MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;
    private static final int MAX_WRITE_BYTES = 1024 * 1024;
    private static final int MAX_PENDING_WRITES_BYTES = 1024 * 1024;
    private static final int MAX_PENDING_WRITES_COUNT = 256;
    private static final int MAX_LIST_LIMIT = 2;
    private static final int MAX_LIST_RESPONSE_BYTES = 16 * 1024 * 1024;
    private static final Set<String> SAFE_METADATA_SOURCES = Set.of("input", "loop", "update", "fork");
    private static final TypeReference<Map<String, Object>> METADATA_TYPE = new TypeReference<>() {};

    private final JdbcTemplate jdbc;
    private final SessionRepository sessions;
    private final ObjectMapper objectMapper;
    private final BranchPathService branchPathService;
    private final ContextService contextService;

    @Value("${XIHE_E2E_CHECKPOINT_PROBE:0}")
    private String checkpointProbeFlag = "0";

    public AgentGraphCheckpointService(
            JdbcTemplate jdbc,
            SessionRepository sessions,
            ObjectMapper objectMapper,
            BranchPathService branchPathService,
            ContextService contextService) {
        this.jdbc = jdbc;
        this.sessions = sessions;
        this.objectMapper = objectMapper;
        this.branchPathService = branchPathService;
        this.contextService = contextService;
    }

    @Transactional
    public LineageView createLineage(LineageRequest request) {
        UUID sessionId = uuid(request.sessionId(), "sessionId");
        UUID userId = uuid(request.userId(), "userId");
        UUID workspaceId = uuid(request.workspaceId(), "workspaceId");
        Session session = requireSession(sessionId, userId, workspaceId);
        UUID sourceRunId = optionalUuid(request.sourceRunId(), "sourceRunId");
        UUID probeId = optionalUuid(request.probeId(), "probeId");
        if ((sourceRunId == null) == (probeId == null)) {
            throw invalid("exactly one of sourceRunId or probeId is required");
        }
        if (probeId != null) requireCheckpointProbeEnabled();
        UUID branchId;
        if (sourceRunId != null) {
            List<UUID> runBranches = jdbc.query(
                    "SELECT branch_id FROM chat_runs WHERE id = ? AND session_id = ? AND user_id = ? AND workspace_id = ?",
                    (rs, rowNum) -> rs.getObject("branch_id", UUID.class),
                    sourceRunId, sessionId, userId, workspaceId);
            if (runBranches.size() != 1 || runBranches.getFirst() == null) {
                throw notFound();
            }
            branchId = runBranches.getFirst();
        } else {
            branchId = uuid(branchPathService.ensureRootBranchId(sessionId.toString()), "branchId");
        }
        requireBranch(sessionId, branchId);
        String producerVersion = identifier(request.producerVersion(), "producerVersion", 64);

        LineageView existing = findLineage(sessionId, userId, workspaceId, branchId, sourceRunId, probeId);
        if (existing != null) return existing;

        UUID lineageId = UUID.randomUUID();
        UUID threadId = UUID.randomUUID();
        int inserted = jdbc.update("""
                INSERT INTO agent_graph_checkpoint_lineages
                    (lineage_id, thread_id, session_id, user_id, workspace_id, branch_id,
                     source_run_id, probe_id, producer_version, schema_version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                ON CONFLICT DO NOTHING
                """, lineageId, threadId, sessionId, userId, workspaceId, branchId,
                sourceRunId, probeId, producerVersion);
        if (inserted == 0) {
            existing = findLineage(sessionId, userId, workspaceId, branchId, sourceRunId, probeId);
            if (existing == null) throw conflict("Checkpoint lineage key is already bound");
            return existing;
        }
        OffsetDateTime createdAt = jdbc.queryForObject(
                "SELECT created_at FROM agent_graph_checkpoint_lineages WHERE lineage_id = ?",
                OffsetDateTime.class, lineageId);
        if (createdAt == null) throw notFound();
        // The source Run is a logical reference: lineage retention follows Session retention,
        // so deleting one Run must not delete graph state still owned by the Session.
        return new LineageView(
                lineageId.toString(), threadId.toString(), session.getId().toString(),
                sourceRunId == null ? null : sourceRunId.toString(),
                probeId == null ? null : probeId.toString(), branchId.toString(),
                userId.toString(), workspaceId.toString(), 1, createdAt.toString(), producerVersion);
    }

    private LineageView findLineage(
            UUID sessionId, UUID userId, UUID workspaceId, UUID branchId, UUID sourceRunId, UUID probeId) {
        String identityPredicate = sourceRunId != null ? "source_run_id = ?" : "probe_id = ?";
        List<Object> args = new ArrayList<>(List.of(sessionId, userId, workspaceId));
        args.add(sourceRunId != null ? sourceRunId : probeId);
        args.add(branchId);
        List<LineageView> lineages = jdbc.query("""
                SELECT lineage_id, thread_id, session_id, source_run_id, probe_id, branch_id,
                       user_id, workspace_id, schema_version, created_at, producer_version
                  FROM agent_graph_checkpoint_lineages
                 WHERE session_id = ? AND user_id = ? AND workspace_id = ? AND %s AND branch_id = ?
                """.formatted(identityPredicate),
                (rs, rowNum) -> {
                    UUID foundSourceRunId = rs.getObject("source_run_id", UUID.class);
                    UUID foundProbeId = rs.getObject("probe_id", UUID.class);
                    return new LineageView(
                            rs.getObject("lineage_id", UUID.class).toString(),
                            rs.getObject("thread_id", UUID.class).toString(),
                            rs.getObject("session_id", UUID.class).toString(),
                            foundSourceRunId == null ? null : foundSourceRunId.toString(),
                            foundProbeId == null ? null : foundProbeId.toString(),
                            rs.getObject("branch_id", UUID.class).toString(),
                            rs.getObject("user_id", UUID.class).toString(),
                            rs.getObject("workspace_id", UUID.class).toString(),
                            rs.getInt("schema_version"),
                            rs.getObject("created_at", OffsetDateTime.class).toString(),
                            rs.getString("producer_version"));
                }, args.toArray());
        if (lineages.size() > 1) throw conflict("Checkpoint lineage identity is ambiguous");
        return lineages.isEmpty() ? null : lineages.getFirst();
    }

    @Transactional(readOnly = true)
    public LineageView getLineage(String threadIdValue, LineageLookupRequest request) {
        Scope scope = requireScope(
                threadIdValue, request.sessionId(), request.userId(), request.workspaceId());
        UUID expectedSourceRunId = optionalUuid(request.sourceRunId(), "sourceRunId");
        UUID expectedProbeId = optionalUuid(request.probeId(), "probeId");
        if ((expectedSourceRunId == null) == (expectedProbeId == null)) {
            throw notFound();
        }
        UUID expectedBranchId;
        if (expectedSourceRunId == null) {
            requireCheckpointProbeEnabled();
            expectedBranchId = uuid(
                    branchPathService.ensureRootBranchId(scope.sessionId().toString()), "branchId");
        } else {
            List<UUID> runBranches = jdbc.query(
                    "SELECT branch_id FROM chat_runs WHERE id = ? AND session_id = ? AND user_id = ? AND workspace_id = ?",
                    (rs, rowNum) -> rs.getObject("branch_id", UUID.class),
                    expectedSourceRunId, scope.sessionId(), scope.userId(), scope.workspaceId());
            if (runBranches.size() != 1 || runBranches.getFirst() == null) throw notFound();
            expectedBranchId = runBranches.getFirst();
        }
        if (!java.util.Objects.equals(scope.sourceRunId(), expectedSourceRunId)
                || !java.util.Objects.equals(scope.probeId(), expectedProbeId)
                || !scope.branchId().equals(expectedBranchId)) {
            throw notFound();
        }
        return new LineageView(
                scope.lineageId().toString(), scope.threadId().toString(), scope.sessionId().toString(),
                scope.sourceRunId() == null ? null : scope.sourceRunId().toString(),
                scope.probeId() == null ? null : scope.probeId().toString(), scope.branchId().toString(),
                scope.userId().toString(), scope.workspaceId().toString(), scope.schemaVersion(),
                scope.createdAt(), scope.producerVersion());
    }

    /**
     * Return only the CP-verified latest graph checkpoint metadata for a source
     * Run. The caller must hold its Session/ChatRun lock and compare the returned
     * cursor with {@code currentVisibleBranchHead} before accepting continuation.
     */
    @Transactional(readOnly = true)
    public ContinuationCheckpointView findLatestSafeCheckpointForSourceRun(
            String sourceRunIdValue, OwnerRequest owner) {
        UUID sourceRunId = uuid(sourceRunIdValue, "sourceRunId");
        UUID sessionId = uuid(owner.sessionId(), "sessionId");
        UUID userId = uuid(owner.userId(), "userId");
        UUID workspaceId = uuid(owner.workspaceId(), "workspaceId");
        requireSession(sessionId, userId, workspaceId);

        List<UUID> runBranches = jdbc.query(
                "SELECT branch_id FROM chat_runs WHERE id = ? AND session_id = ? AND user_id = ? AND workspace_id = ?",
                (rs, rowNum) -> rs.getObject("branch_id", UUID.class),
                sourceRunId, sessionId, userId, workspaceId);
        if (runBranches.size() != 1 || runBranches.getFirst() == null) throw notFound();
        UUID expectedBranchId = runBranches.getFirst();

        List<Scope> lineages = jdbc.query("""
                SELECT lineage_id, thread_id, session_id, user_id, workspace_id, branch_id, source_run_id,
                       probe_id, schema_version, created_at, producer_version
                  FROM agent_graph_checkpoint_lineages
                 WHERE source_run_id = ? AND session_id = ? AND user_id = ? AND workspace_id = ?
                """, (rs, rowNum) -> new Scope(
                rs.getObject("lineage_id", UUID.class), rs.getObject("thread_id", UUID.class),
                rs.getObject("session_id", UUID.class), rs.getObject("user_id", UUID.class),
                rs.getObject("workspace_id", UUID.class), rs.getObject("branch_id", UUID.class),
                rs.getObject("source_run_id", UUID.class), rs.getObject("probe_id", UUID.class),
                rs.getInt("schema_version"), rs.getObject("created_at", OffsetDateTime.class).toString(),
                rs.getString("producer_version")), sourceRunId, sessionId, userId, workspaceId);
        if (lineages.size() != 1) throw notFound();
        Scope scope = lineages.getFirst();
        if (!expectedBranchId.equals(scope.branchId()) || scope.probeId() != null) throw notFound();
        requireBranch(sessionId, scope.branchId());

        List<CheckpointRow> rows = jdbc.query("""
                SELECT c.lineage_id, c.thread_id, c.checkpoint_ns, c.checkpoint_id,
                       c.parent_checkpoint_id, c.payload_type, c.checkpoint_blob,
                       c.metadata::text AS metadata_json, c.created_at
                  FROM agent_graph_checkpoints c
                 WHERE c.lineage_id = ? AND c.thread_id = ? AND c.checkpoint_ns = ''
                    AND jsonb_exists(c.metadata, 'eventSequence')
                 ORDER BY c.created_at DESC, c.checkpoint_id DESC
                 LIMIT 1
                """, CHECKPOINT_ROW, scope.lineageId(), scope.threadId());
        if (rows.isEmpty()) return null;
        CheckpointRow checkpoint = rows.getFirst();
        Map<String, Object> metadata = parseMetadata(checkpoint.metadataJson());
        Long eventSequence = exactLong(metadata.get("eventSequence"));
        if (eventSequence == null || eventSequence < 0) throw notFound();
        long currentVisibleBranchHead = contextService.latestVisibleSequence(
                sessionId.toString(), scope.branchId().toString());
        if (eventSequence > currentVisibleBranchHead) {
            throw conflict("Checkpoint cursor is beyond the visible branch head");
        }
        return new ContinuationCheckpointView(
                scope.lineageId().toString(), scope.threadId().toString(), checkpoint.checkpointId(),
                eventSequence, scope.sessionId().toString(), scope.userId().toString(),
                scope.workspaceId().toString(), scope.branchId().toString(), scope.schemaVersion(),
                scope.producerVersion(), currentVisibleBranchHead);
    }

    @Transactional
    public void putCheckpoint(String threadIdValue, PutCheckpointRequest request) {
        Scope scope = requireScope(threadIdValue, request.sessionId(), request.userId(), request.workspaceId());
        String checkpointNs = checkpointNamespace(request.checkpointNs());
        String checkpointId = identifier(request.checkpointId(), "checkpointId", 128);
        String parentCheckpointId = optionalIdentifier(request.parentCheckpointId(), "parentCheckpointId", 128);
        if (parentCheckpointId != null) {
            Integer parentExists = jdbc.queryForObject("""
                    SELECT count(*) FROM agent_graph_checkpoints
                     WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
                    """, Integer.class, scope.threadId(), checkpointNs, parentCheckpointId);
            if (parentExists == null || parentExists != 1) {
                throw invalid("parent checkpoint is unavailable");
            }
        }
        String payloadType = identifier(request.payloadType(), "payloadType", 64);
        byte[] blob = decodePayload(request.payloadBase64(), MAX_CHECKPOINT_BYTES);
        Map<String, Object> normalizedMetadata = normalizeMetadata(request.metadata());
        Long eventSequence = exactLong(normalizedMetadata.get("eventSequence"));
        if (scope.sourceRunId() != null && eventSequence == null) {
            throw invalid("eventSequence is required for source Run checkpoints");
        }
        if (eventSequence != null) {
            long visibleBranchHead = contextService.latestVisibleSequence(
                    scope.sessionId().toString(), scope.branchId().toString());
            if (eventSequence < 0 || eventSequence > visibleBranchHead) {
                throw conflict("Checkpoint cursor is outside the visible branch history");
            }
            if (parentCheckpointId != null) {
                List<String> parentMetadata = jdbc.query(
                        "SELECT metadata::text FROM agent_graph_checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?",
                        (rs, rowNum) -> rs.getString(1), scope.threadId(), checkpointNs, parentCheckpointId);
                if (parentMetadata.size() == 1) {
                    Long parentSequence = exactLong(parseMetadata(parentMetadata.getFirst()).get("eventSequence"));
                    if (parentSequence != null && eventSequence < parentSequence) {
                        throw conflict("Checkpoint cursor cannot move backward");
                    }
                }
            }
        }
        String metadataJson = json(normalizedMetadata);
        int inserted = jdbc.update("""
                INSERT INTO agent_graph_checkpoints
                    (lineage_id, thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
                     payload_type, checkpoint_blob, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS jsonb))
                ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id) DO NOTHING
                """, scope.lineageId(), scope.threadId(), checkpointNs, checkpointId,
                parentCheckpointId, payloadType, blob, metadataJson);
        if (inserted == 0) {
            List<CheckpointRow> existing = jdbc.query("""
                    SELECT lineage_id, thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
                           payload_type, checkpoint_blob, metadata::text AS metadata_json, created_at
                      FROM agent_graph_checkpoints
                     WHERE lineage_id = ? AND thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
                    """, CHECKPOINT_ROW, scope.lineageId(), scope.threadId(), checkpointNs, checkpointId);
            if (existing.isEmpty()) throw notFound();
            CheckpointRow row = existing.getFirst();
            boolean same = row.payloadType().equals(payloadType)
                    && Arrays.equals(row.blob(), blob)
                    && java.util.Objects.equals(row.parentCheckpointId(), parentCheckpointId)
                    && parseMetadata(row.metadataJson()).equals(normalizedMetadata);
            if (!same) throw conflict("Checkpoint key is already bound to different data");
        }
    }

    @Transactional(readOnly = true)
    public CheckpointView getCheckpoint(
            String threadIdValue,
            OwnerRequest owner,
            String checkpointNsValue,
            String checkpointIdValue) {
        Scope scope = requireScope(threadIdValue, owner.sessionId(), owner.userId(), owner.workspaceId());
        String checkpointNs = checkpointNamespace(checkpointNsValue);
        String checkpointId = identifier(checkpointIdValue, "checkpointId", 128);
        List<CheckpointRow> rows = jdbc.query("""
                SELECT lineage_id, thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
                       payload_type, checkpoint_blob, metadata::text AS metadata_json, created_at
                  FROM agent_graph_checkpoints
                 WHERE lineage_id = ? AND thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
                """, CHECKPOINT_ROW, scope.lineageId(), scope.threadId(), checkpointNs, checkpointId);
        return rows.isEmpty() ? null : view(rows.getFirst(), scope);
    }

    @Transactional(readOnly = true)
    public List<CheckpointView> listCheckpoints(
            String threadIdValue,
            OwnerRequest owner,
            String checkpointNsValue,
            String beforeCheckpointIdValue,
            Integer requestedLimit,
            String filterSource,
            Integer filterStep) {
        Scope scope = requireScope(threadIdValue, owner.sessionId(), owner.userId(), owner.workspaceId());
        String checkpointNs = checkpointNamespace(checkpointNsValue);
        int limit = requestedLimit == null ? MAX_LIST_LIMIT : requestedLimit;
        if (limit < 1 || limit > MAX_LIST_LIMIT) throw invalid("limit is out of range");
        if (filterSource != null && !SAFE_METADATA_SOURCES.contains(filterSource)) {
            throw invalid("filterSource is invalid");
        }
        if (filterStep != null && (filterStep < -1 || filterStep > 1_000_000_000)) {
            throw invalid("filterStep is invalid");
        }
        String beforeCheckpointId = beforeCheckpointIdValue == null || beforeCheckpointIdValue.isBlank()
                ? null : identifier(beforeCheckpointIdValue, "beforeCheckpointId", 128);
        List<CheckpointRow> rows = listRows(
                scope, checkpointNs, beforeCheckpointId, limit, filterSource, filterStep);
        List<CheckpointView> result = new ArrayList<>(rows.size());
        for (CheckpointRow row : rows) {
            result.add(view(row, scope));
            if (serializedSize(result) > MAX_LIST_RESPONSE_BYTES) {
                throw invalid("checkpoint page exceeds the response budget");
            }
        }
        return result;
    }

    @Transactional
    public void putWrites(String threadIdValue, PutWritesRequest request) {
        Scope scope = requireScope(threadIdValue, request.sessionId(), request.userId(), request.workspaceId());
        String checkpointNs = checkpointNamespace(request.checkpointNs());
        String checkpointId = identifier(request.checkpointId(), "checkpointId", 128);
        String taskId = identifier(request.taskId(), "taskId", 256);
        String taskPath = request.taskPath() == null ? "" : request.taskPath();
        if (taskPath.length() > 1024 || taskPath.indexOf('\0') >= 0) throw invalid("taskPath is invalid");
        if (request.writes() == null || request.writes().size() > 256) throw invalid("writes are invalid");
        List<UUID> checkpointRows = jdbc.query("""
                SELECT checkpoint_row_id FROM agent_graph_checkpoints
                 WHERE lineage_id = ? AND thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
                 FOR UPDATE
                """, (rs, rowNum) -> rs.getObject("checkpoint_row_id", UUID.class),
                scope.lineageId(), scope.threadId(), checkpointNs, checkpointId);
        if (checkpointRows.size() != 1) throw notFound();
        Long writeCount = jdbc.queryForObject("""
                SELECT count(*) FROM agent_graph_checkpoint_writes
                 WHERE lineage_id = ? AND thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
                """, Long.class, scope.lineageId(), scope.threadId(), checkpointNs, checkpointId);
        Long writeBytes = jdbc.queryForObject("""
                SELECT COALESCE(sum(octet_length(value_blob)), 0) FROM agent_graph_checkpoint_writes
                 WHERE lineage_id = ? AND thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
                """, Long.class, scope.lineageId(), scope.threadId(), checkpointNs, checkpointId);
        long admittedCount = writeCount == null ? 0 : writeCount;
        long admittedBytes = writeBytes == null ? 0 : writeBytes;
        for (int index = 0; index < request.writes().size(); index++) {
            WriteValue write = request.writes().get(index);
            if (write == null) throw invalid("write is invalid");
            String channel = identifier(write.channel(), "channel", 256);
            String payloadType = identifier(write.payloadType(), "payloadType", 64);
            byte[] blob = decodePayload(write.payloadBase64(), MAX_WRITE_BYTES);
            int writeIndex = write.writeIndex() == null ? index : write.writeIndex();
            List<ExistingWrite> existingRows = jdbc.query("""
                    SELECT task_path, channel, payload_type, value_blob
                      FROM agent_graph_checkpoint_writes
                     WHERE lineage_id = ? AND thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
                       AND task_id = ? AND write_index = ?
                    """, (rs, rowNum) -> new ExistingWrite(
                    rs.getString("task_path"), rs.getString("channel"),
                    rs.getString("payload_type"), rs.getBytes("value_blob")),
                    scope.lineageId(), scope.threadId(), checkpointNs, checkpointId, taskId, writeIndex);
            if (!existingRows.isEmpty()) {
                ExistingWrite row = existingRows.getFirst();
                if (!row.taskPath().equals(taskPath) || !row.channel().equals(channel)
                        || !row.payloadType().equals(payloadType) || !Arrays.equals(row.blob(), blob)) {
                    throw conflict("Pending write key is already bound to different data");
                }
                continue;
            }
            if (admittedCount >= MAX_PENDING_WRITES_COUNT
                    || admittedBytes + blob.length > MAX_PENDING_WRITES_BYTES) {
                throw invalid("pending writes exceed the per-checkpoint budget");
            }
            int inserted = jdbc.update("""
                    INSERT INTO agent_graph_checkpoint_writes
                        (lineage_id, thread_id, checkpoint_ns, checkpoint_id, task_id, task_path,
                         write_index, channel, payload_type, value_blob)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id, task_id, write_index) DO NOTHING
                    """, scope.lineageId(), scope.threadId(), checkpointNs, checkpointId, taskId,
                    taskPath, writeIndex, channel, payloadType, blob);
            if (inserted == 0) {
                List<ExistingWrite> conflictedRows = jdbc.query("""
                        SELECT task_path, channel, payload_type, value_blob
                          FROM agent_graph_checkpoint_writes
                         WHERE lineage_id = ? AND thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
                           AND task_id = ? AND write_index = ?
                        """, (rs, rowNum) -> new ExistingWrite(
                        rs.getString("task_path"), rs.getString("channel"),
                        rs.getString("payload_type"), rs.getBytes("value_blob")),
                        scope.lineageId(), scope.threadId(), checkpointNs, checkpointId, taskId, writeIndex);
                if (conflictedRows.isEmpty()) throw notFound();
                ExistingWrite row = conflictedRows.getFirst();
                if (!row.taskPath().equals(taskPath) || !row.channel().equals(channel)
                        || !row.payloadType().equals(payloadType) || !Arrays.equals(row.blob(), blob)) {
                    throw conflict("Pending write key is already bound to different data");
                }
            } else {
                admittedCount++;
                admittedBytes += blob.length;
            }
        }
    }

    @Transactional
    public void deleteThread(String threadIdValue, OwnerRequest owner) {
        Scope scope = requireScope(threadIdValue, owner.sessionId(), owner.userId(), owner.workspaceId());
        jdbc.update("DELETE FROM agent_graph_checkpoint_lineages WHERE lineage_id = ? AND thread_id = ?",
                scope.lineageId(), scope.threadId());
    }

    private CheckpointView view(CheckpointRow row, Scope scope) {
        List<WriteView> writes = jdbc.query("""
                SELECT task_id, channel, payload_type, value_blob, write_index
                  FROM agent_graph_checkpoint_writes
                 WHERE lineage_id = ? AND thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
                 ORDER BY task_id, write_index
                """, (rs, index) -> new WriteView(
                rs.getString("task_id"), rs.getString("channel"), rs.getString("payload_type"),
                Base64.getEncoder().encodeToString(rs.getBytes("value_blob")), rs.getInt("write_index")),
                scope.lineageId(), scope.threadId(), row.checkpointNs(), row.checkpointId());
        return new CheckpointView(
                row.threadId().toString(), row.checkpointNs(), row.checkpointId(), row.parentCheckpointId(),
                row.payloadType(), Base64.getEncoder().encodeToString(row.blob()),
                scope.lineageId().toString(), scope.sourceRunId() == null ? null : scope.sourceRunId().toString(),
                scope.sessionId().toString(), scope.branchId().toString(), scope.userId().toString(),
                scope.workspaceId().toString(), scope.schemaVersion(), row.createdAt(), scope.producerVersion(),
                parseMetadata(row.metadataJson()), writes);
    }

    private int serializedSize(Object value) {
        try {
            return objectMapper.writeValueAsBytes(value).length;
        } catch (JsonProcessingException e) {
            throw new CpApiException(HttpStatus.INTERNAL_SERVER_ERROR,
                    "CHECKPOINT_STORAGE_UNAVAILABLE", "Checkpoint response is unavailable");
        }
    }

    List<CheckpointRow> listRows(
            Scope scope, String checkpointNs, String beforeCheckpointId, int limit,
            String filterSource, Integer filterStep) {
        StringBuilder sql = new StringBuilder("""
                SELECT c.lineage_id, c.thread_id, c.checkpoint_ns, c.checkpoint_id,
                       c.parent_checkpoint_id, c.payload_type, c.checkpoint_blob,
                       c.metadata::text AS metadata_json, c.created_at
                  FROM agent_graph_checkpoints c
                 WHERE c.lineage_id = ? AND c.thread_id = ? AND c.checkpoint_ns = ?
                """);
        List<Object> args = new ArrayList<>(List.of(scope.lineageId(), scope.threadId(), checkpointNs));
        if (beforeCheckpointId != null) {
            // Checkpoint ids are opaque saver keys. Resolve the cursor row and
            // page by the persisted chronological order instead of assuming
            // that the id's lexical order is time order.
            sql.append("""
                     AND (c.created_at, c.checkpoint_id) < (
                         SELECT cursor.created_at, cursor.checkpoint_id
                           FROM agent_graph_checkpoints cursor
                          WHERE cursor.lineage_id = c.lineage_id
                            AND cursor.thread_id = c.thread_id
                            AND cursor.checkpoint_ns = c.checkpoint_ns
                            AND cursor.checkpoint_id = ?
                     )
                    """);
            args.add(beforeCheckpointId);
        }
        if (filterSource != null) {
            sql.append(" AND c.metadata->>'source' = ?");
            args.add(filterSource);
        }
        if (filterStep != null) {
            sql.append(" AND (c.metadata->>'step')::bigint = ?");
            args.add(filterStep);
        }
        sql.append(" ORDER BY c.created_at DESC, c.checkpoint_id DESC LIMIT ?");
        args.add(limit);
        return jdbc.query(sql.toString(), CHECKPOINT_ROW, args.toArray());
    }

    private Scope requireScope(String threadValue, String sessionValue, String userValue, String workspaceValue) {
        UUID threadId = uuid(threadValue, "threadId");
        UUID sessionId = uuid(sessionValue, "sessionId");
        UUID userId = uuid(userValue, "userId");
        UUID workspaceId = uuid(workspaceValue, "workspaceId");
        requireSession(sessionId, userId, workspaceId);
        List<Scope> scopes = jdbc.query("""
                SELECT lineage_id, thread_id, session_id, user_id, workspace_id, branch_id, source_run_id,
                       probe_id,
                       schema_version, created_at, producer_version
                  FROM agent_graph_checkpoint_lineages
                 WHERE thread_id = ? AND session_id = ? AND user_id = ? AND workspace_id = ?
                """, (rs, rowNum) -> new Scope(
                rs.getObject("lineage_id", UUID.class), rs.getObject("thread_id", UUID.class),
                rs.getObject("session_id", UUID.class), rs.getObject("user_id", UUID.class),
                rs.getObject("workspace_id", UUID.class), rs.getObject("branch_id", UUID.class),
                rs.getObject("source_run_id", UUID.class), rs.getObject("probe_id", UUID.class),
                rs.getInt("schema_version"),
                rs.getObject("created_at", OffsetDateTime.class).toString(), rs.getString("producer_version")),
                threadId, sessionId, userId, workspaceId);
        if (scopes.size() != 1) throw notFound();
        Scope scope = scopes.getFirst();
        requireBranch(sessionId, scope.branchId());
        return scope;
    }

    private void requireBranch(UUID sessionId, UUID branchId) {
        Integer matchingBranches = jdbc.queryForObject(
                "SELECT count(*) FROM session_branches WHERE session_id = ? AND id = ?",
                Integer.class, sessionId, branchId);
        if (matchingBranches == null || matchingBranches != 1) throw notFound();
    }

    private void requireCheckpointProbeEnabled() {
        String flag = checkpointProbeFlag == null ? "" : checkpointProbeFlag.trim();
        if (!"1".equals(flag) && !"true".equalsIgnoreCase(flag)) {
            throw invalid("probeId is only accepted by the isolated checkpoint probe");
        }
    }

    private Session requireSession(UUID sessionId, UUID userId, UUID workspaceId) {
        return sessions.findByIdAndUserIdAndWorkspaceIdAndArchivedFalse(
                        sessionId, userId.toString(), workspaceId.toString())
                .orElseThrow(AgentGraphCheckpointService::notFound);
    }

    static Map<String, Object> normalizeMetadata(Map<String, Object> input) {
        if (input == null || input.isEmpty()) return Map.of();
        Map<String, Object> safe = new LinkedHashMap<>();
        Object source = input.get("source");
        if (source instanceof String value && SAFE_METADATA_SOURCES.contains(value)) safe.put("source", value);
        Object step = input.get("step");
        if (step instanceof Number number) {
            long value = number.longValue();
            if (value >= -1 && value <= 1_000_000_000L && number.doubleValue() == value) safe.put("step", value);
        }
        Object eventSequence = input.get("eventSequence");
        if (eventSequence instanceof Number number) {
            long value = number.longValue();
            if (value >= 0 && number.doubleValue() == value) safe.put("eventSequence", value);
        }
        return safe;
    }

    private static Long exactLong(Object value) {
        if (!(value instanceof Number number)) return null;
        long converted = number.longValue();
        return number.doubleValue() == converted ? converted : null;
    }

    private Map<String, Object> parseMetadata(String json) {
        try {
            return normalizeMetadata(objectMapper.readValue(json, METADATA_TYPE));
        } catch (JsonProcessingException e) {
            throw new CpApiException(HttpStatus.INTERNAL_SERVER_ERROR,
                    "CHECKPOINT_STORAGE_UNAVAILABLE", "Checkpoint metadata is unavailable");
        }
    }

    private String json(Map<String, Object> value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw invalid("metadata is invalid");
        }
    }

    private static byte[] decodePayload(String value, int maximumBytes) {
        if (value == null || value.length() > ((maximumBytes + 2L) / 3L) * 4L) {
            throw invalid("checkpoint payload is invalid");
        }
        try {
            byte[] decoded = Base64.getDecoder().decode(value);
            if (decoded.length == 0 || decoded.length > maximumBytes) throw invalid("checkpoint payload is invalid");
            return decoded;
        } catch (IllegalArgumentException e) {
            throw invalid("checkpoint payload is invalid");
        }
    }

    static String checkpointNamespace(String value) {
        if (value == null || value.isEmpty()) return "";
        return identifier(value, "checkpointNs", 256);
    }

    private static String identifier(String value, String field, int maxLength) {
        if (value == null || value.isBlank() || value.length() > maxLength || value.indexOf('\0') >= 0) {
            throw invalid(field + " is invalid");
        }
        return value;
    }

    private static String optionalIdentifier(String value, String field, int maxLength) {
        return value == null || value.isBlank() ? null : identifier(value, field, maxLength);
    }

    private static UUID uuid(String value, String field) {
        try {
            return UUID.fromString(identifier(value, field, 36));
        } catch (IllegalArgumentException e) {
            throw invalid(field + " must be a UUID");
        }
    }

    private static UUID optionalUuid(String value, String field) {
        return value == null || value.isBlank() ? null : uuid(value, field);
    }

    private static CpApiException invalid(String detail) {
        return new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_CHECKPOINT_REQUEST", detail);
    }

    private static CpApiException notFound() {
        return new CpApiException(HttpStatus.NOT_FOUND, "CHECKPOINT_LINEAGE_NOT_FOUND",
                "Checkpoint lineage is unavailable");
    }

    private static CpApiException conflict(String detail) {
        return new CpApiException(HttpStatus.CONFLICT, "CHECKPOINT_KEY_CONFLICT", detail);
    }

    private static final RowMapper<CheckpointRow> CHECKPOINT_ROW = AgentGraphCheckpointService::mapCheckpoint;

    private static CheckpointRow mapCheckpoint(ResultSet rs, int rowNum) throws SQLException {
        return new CheckpointRow(
                rs.getObject("lineage_id", UUID.class), rs.getObject("thread_id", UUID.class),
                rs.getString("checkpoint_ns"), rs.getString("checkpoint_id"),
                rs.getString("parent_checkpoint_id"), rs.getString("payload_type"),
                rs.getBytes("checkpoint_blob"), rs.getString("metadata_json"),
                rs.getObject("created_at", OffsetDateTime.class).toString());
    }

    public record OwnerRequest(String sessionId, String userId, String workspaceId) {}

    public record LineageLookupRequest(
            String sessionId, String userId, String workspaceId, String sourceRunId, String probeId) {}

    public record LineageRequest(
            String sessionId, String userId, String workspaceId, String sourceRunId,
            String probeId, String producerVersion) {}

    public record LineageView(
            String lineageId, String threadId, String sessionId, String sourceRunId, String probeId, String branchId,
            String userId, String workspaceId, int schemaVersion, String createdAt, String producerVersion) {}

    public record ContinuationCheckpointView(
            String lineageId, String threadId, String checkpointId, long eventSequence,
            String sessionId, String userId, String workspaceId, String branchId,
            int schemaVersion, String producerVersion, long currentVisibleBranchHead) {}

    public record PutCheckpointRequest(
            String sessionId, String userId, String workspaceId, String checkpointNs,
            String checkpointId, String parentCheckpointId, String payloadType,
            String payloadBase64, Map<String, Object> metadata) {}

    public record PutWritesRequest(
            String sessionId, String userId, String workspaceId, String checkpointNs,
            String checkpointId, String taskId, String taskPath, List<WriteValue> writes) {}

    public record WriteValue(String channel, String payloadType, String payloadBase64, Integer writeIndex) {}

    public record WriteView(String taskId, String channel, String payloadType, String payloadBase64, int writeIndex) {}

    public record CheckpointView(
            String threadId, String checkpointNs, String checkpointId, String parentCheckpointId,
            String payloadType, String payloadBase64, String lineageId, String sourceRunId,
            String sessionId, String branchId, String userId, String workspaceId, int schemaVersion,
            String createdAt, String producerVersion, Map<String, Object> metadata,
            List<WriteView> pendingWrites) {}

    record Scope(
            UUID lineageId, UUID threadId, UUID sessionId, UUID userId, UUID workspaceId,
            UUID branchId, UUID sourceRunId, UUID probeId,
            int schemaVersion, String createdAt, String producerVersion) {}

    record CheckpointRow(
            UUID lineageId, UUID threadId, String checkpointNs, String checkpointId,
            String parentCheckpointId, String payloadType, byte[] blob, String metadataJson, String createdAt) {}

    private record ExistingWrite(String taskPath, String channel, String payloadType, byte[] blob) {}
}
