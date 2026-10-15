package com.cc01cc.p.xihe.cp.repository;

import jakarta.persistence.EntityManager;
import jakarta.persistence.Query;
import org.springframework.stereotype.Repository;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Bounded, allowlist-only reads for the Run Trace projection. */
@Repository
public class RunTraceSourceRepository {

    private static final String CONTEXT_EVENT_SOURCE = "context_event";
    private static final String PROVIDER_ATTEMPT_SOURCE = "provider_attempt";
    private static final String MCP_INVOCATION_SOURCE = "mcp_invocation";
    private static final String RUNTIME_JOB_SOURCE = "runtime_job";
    private static final String RUNTIME_JOB_SNAPSHOT_TIME = "(CASE "
            + "WHEN j.status IN ('succeeded', 'completed', 'failed', 'timeout', 'cancelled', 'orphaned', 'interrupted') "
            + "AND j.ended_at IS NOT NULL AND j.ended_at <= :asOf THEN j.ended_at "
            + "WHEN j.updated_at > :asOf THEN CASE WHEN j.started_at IS NOT NULL "
            + "AND j.started_at <= :asOf THEN j.started_at ELSE j.created_at END "
            + "WHEN j.status = 'running' AND j.started_at IS NOT NULL AND j.started_at <= :asOf "
            + "THEN j.started_at WHEN j.status IN ('pending', 'queued') THEN j.created_at "
            + "ELSE j.updated_at END)";

    private static final String CONTEXT_EVENT_SQL = "SELECT e.id::text, e.event_type, e.created_at, "
            + "CASE WHEN e.event_type IN ('tool.called', 'tool.result') "
            + "THEN COALESCE(e.payload #>> '{toolCallId}', e.payload #>> '{call_id}') END, "
            + "CASE WHEN e.event_type IN ('tool.called', 'tool.result') "
            + "THEN COALESCE(e.payload #>> '{toolName}', e.payload #>> '{tool_name}') END, "
            + "CASE WHEN e.event_type = 'tool.called' THEN 'started' "
            + "WHEN e.event_type = 'tool.result' THEN "
            + "COALESCE(e.payload #>> '{status}', 'completed') END, "
            + "CASE WHEN e.event_type = 'tool.result' AND "
            + "(SELECT COUNT(*) FROM context_events p WHERE p.correlation_id = e.correlation_id "
            + "AND p.event_type = 'tool.called' AND COALESCE(p.payload #>> '{toolCallId}', "
            + "p.payload #>> '{call_id}') = COALESCE(e.payload #>> '{toolCallId}', "
            + "e.payload #>> '{call_id}') AND p.created_at <= :asOf) = 1 AND "
            + "(SELECT COUNT(*) FROM context_events p WHERE p.correlation_id = e.correlation_id "
            + "AND p.event_type = 'tool.result' AND COALESCE(p.payload #>> '{toolCallId}', "
            + "p.payload #>> '{call_id}') = COALESCE(e.payload #>> '{toolCallId}', "
            + "e.payload #>> '{call_id}') AND p.created_at <= :asOf) = 1 THEN (SELECT "
            + "GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (e.created_at - MIN(c.created_at))) * 1000))::bigint "
            + "FROM context_events c WHERE c.correlation_id = e.correlation_id "
            + "AND c.event_type = 'tool.called' AND COALESCE(c.payload #>> '{toolCallId}', "
            + "c.payload #>> '{call_id}') = COALESCE(e.payload #>> '{toolCallId}', "
            + "e.payload #>> '{call_id}') AND c.created_at <= e.created_at "
            + "AND c.created_at <= :asOf) END, "
            + "CASE WHEN e.event_type = 'llm.usage' "
            + "AND jsonb_typeof(e.payload #> '{usage,inputTokens}') = 'number' "
            + "THEN e.payload #>> '{usage,inputTokens}' END, "
            + "CASE WHEN e.event_type = 'llm.usage' "
            + "AND jsonb_typeof(e.payload #> '{usage,outputTokens}') = 'number' "
            + "THEN e.payload #>> '{usage,outputTokens}' END, "
            + "CASE WHEN e.event_type = 'llm.usage' "
            + "AND jsonb_typeof(e.payload #> '{usage,totalTokens}') = 'number' "
            + "THEN e.payload #>> '{usage,totalTokens}' END, "
            + "CASE WHEN e.event_type = 'prompt.admitted' THEN TRUE "
            + "WHEN e.event_type = 'llm.usage' THEN "
            + "jsonb_typeof(e.payload #> '{usage,inputTokens}') = 'number' "
            + "OR jsonb_typeof(e.payload #> '{usage,outputTokens}') = 'number' "
            + "OR jsonb_typeof(e.payload #> '{usage,totalTokens}') = 'number' "
            + "WHEN e.event_type IN ('tool.called', 'tool.result') THEN "
            + "COALESCE(e.payload #>> '{toolCallId}', e.payload #>> '{call_id}') IS NOT NULL "
            + "AND COALESCE(e.payload #>> '{toolName}', e.payload #>> '{tool_name}') IS NOT NULL "
            + "AND (e.event_type = 'tool.called' OR COALESCE(e.payload #>> '{status}', 'completed') "
            + "IN ('completed', 'failed')) END, "
            + "CASE WHEN e.event_type IN ('tool.called', 'tool.result') THEN "
            + "(SELECT COUNT(*) FROM context_events p WHERE p.correlation_id = e.correlation_id "
            + "AND p.event_type = 'tool.called' AND COALESCE(p.payload #>> '{toolCallId}', "
            + "p.payload #>> '{call_id}') = COALESCE(e.payload #>> '{toolCallId}', "
            + "e.payload #>> '{call_id}') AND p.created_at <= :asOf) = 1 "
            + "AND (SELECT COUNT(*) FROM context_events p WHERE p.correlation_id = e.correlation_id "
            + "AND p.event_type = 'tool.result' AND COALESCE(p.payload #>> '{toolCallId}', "
            + "p.payload #>> '{call_id}') = COALESCE(e.payload #>> '{toolCallId}', "
            + "e.payload #>> '{call_id}') AND p.created_at <= :asOf) = 1 ELSE TRUE END "
            + "FROM context_events e WHERE e.correlation_id = :runId "
            + "AND e.created_at <= :asOf "
            + "AND (e.event_type NOT IN ('tool.called', 'tool.result') OR NOT EXISTS ("
            + "SELECT 1 FROM mcp_invocations i WHERE i.run_id = CAST(:runId AS uuid) "
            + "AND i.created_at <= :asOf AND i.started_at <= :asOf "
            + "AND i.tool_call_id::text = COALESCE(e.payload #>> '{toolCallId}', "
            + "e.payload #>> '{call_id}')))";

    private static final String PROVIDER_ATTEMPT_TIME = "CASE WHEN a.ended_at IS NOT NULL "
            + "AND a.ended_at <= :asOf THEN a.ended_at ELSE a.started_at END";

    private static final String MCP_INVOCATION_TIME = "CASE WHEN i.finished_at IS NOT NULL "
            + "AND i.finished_at <= :asOf THEN i.finished_at ELSE i.started_at END";

    private final EntityManager entityManager;

    public RunTraceSourceRepository(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    /** Read only identity fields needed to authorize the Run before other sources. */
    public Optional<RunIdentity> readRunIdentity(UUID runId) {
        String sql = "SELECT r.id::text, r.session_id::text, r.user_id::text, r.workspace_id::text "
                + "FROM chat_runs r WHERE r.id = CAST(:runId AS uuid)";
        List<?> rows = entityManager.createNativeQuery(sql)
                .setParameter("runId", runId)
                .setMaxResults(1)
                .getResultList();
        if (rows.isEmpty()) {
            return Optional.empty();
        }
        Object[] row = (Object[]) rows.getFirst();
        return Optional.of(new RunIdentity(UUID.fromString(string(row[0])), string(row[1]),
                string(row[2]), string(row[3])));
    }

    /**
     * Read only the ChatRun columns required by Trace and allowlisted scalar
     * configuration provenance. The JSONB snapshot itself is never selected.
     */
    public Optional<RunMetadata> readRunMetadata(UUID runId) {
        String sql = "SELECT r.id::text, r.session_id::text, r.user_id::text, r.workspace_id::text, "
                + "r.provider, r.model, r.status, r.terminal_at, r.terminal_outcome, r.error_code, "
                + "r.created_at, r.provider_connection_id::text, r.connection_revision, "
                + "CASE WHEN jsonb_typeof(r.context_template_snapshot #> '{layer}') = 'string' "
                + "THEN r.context_template_snapshot #>> '{layer}' END, "
                + "CASE WHEN jsonb_typeof(r.context_template_snapshot #> '{templateId}') = 'string' "
                + "THEN r.context_template_snapshot #>> '{templateId}' END, "
                + "CASE WHEN jsonb_typeof(r.context_template_snapshot #> '{version}') = 'number' "
                + "THEN r.context_template_snapshot #>> '{version}' END, "
                + "CASE WHEN jsonb_typeof(r.context_template_snapshot #> '{apiTypeId}') = 'string' "
                + "THEN r.context_template_snapshot #>> '{apiTypeId}' END, "
                + "CASE WHEN jsonb_typeof(r.context_template_snapshot #> '{apiTypeVersion}') = 'number' "
                + "THEN r.context_template_snapshot #>> '{apiTypeVersion}' END "
                + "FROM chat_runs r WHERE r.id = CAST(:runId AS uuid)";
        List<?> rows = entityManager.createNativeQuery(sql)
                .setParameter("runId", runId)
                .setMaxResults(1)
                .getResultList();
        if (rows.isEmpty()) {
            return Optional.empty();
        }
        Object[] row = (Object[]) rows.getFirst();
        return Optional.of(new RunMetadata(
                UUID.fromString(string(row[0])), string(row[1]), string(row[2]), string(row[3]),
                string(row[4]), string(row[5]), string(row[6]), nullableInstant(row[7]),
                string(row[8]), string(row[9]), instant(row[10]), string(row[11]),
                number(row[12]), string(row[13]), string(row[14]), string(row[15]),
                string(row[16]), string(row[17])));
    }

    /**
     * Read the trace-safe context facts. JSONB is queried only through explicit
     * scalar paths; the raw payload column is never selected into application memory.
     */
    public List<SourceRecord> readContextEvents(UUID runId, Instant asOf,
                                                Cursor cursor, int maxRows) {
        String sql = CONTEXT_EVENT_SQL + afterCursor(CONTEXT_EVENT_SOURCE,
                "e.created_at", "e.id::text", cursor)
                + " ORDER BY e.created_at ASC, e.id::text COLLATE \"C\" ASC";
        Query query = entityManager.createNativeQuery(sql)
                .setParameter("runId", runId.toString())
                .setParameter("asOf", asOf)
                .setMaxResults(maxRows);
        bindCursor(query, cursor);
        List<SourceRecord> result = new ArrayList<>();
        for (Object[] row : rows(query)) {
            String eventType = string(row[1]);
            String toolCallId = safeToolCallId(string(row[3]));
            String toolName = safeToolName(string(row[4]));
            String statusValue = string(row[5]);
            String kind;
            String status;
            boolean mappingKnown = true;
            Long durationMs = number(row[6]);
            Long inputTokens = nonNegativeLong(row[7]);
            Long outputTokens = nonNegativeLong(row[8]);
            Long totalTokens = nonNegativeLong(row[9]);
            boolean sourceMappingKnown = Boolean.TRUE.equals(row[10]);
            boolean pairingComplete = Boolean.TRUE.equals(row[11]);
            switch (eventType) {
                case "prompt.admitted" -> {
                    kind = "input.admitted";
                    status = "admitted";
                }
                case "llm.usage" -> {
                    kind = "usage.recorded";
                    mappingKnown = inputTokens != null || outputTokens != null || totalTokens != null;
                    status = mappingKnown ? "recorded" : "unknown";
                }
                case "tool.called" -> {
                    kind = "agent.tool";
                    status = "started";
                    mappingKnown = sourceMappingKnown && toolCallId != null && toolName != null;
                }
                case "tool.result" -> {
                    kind = "agent.tool";
                    status = !pairingComplete ? "unknown"
                            : switch (statusValue == null ? "completed" : statusValue) {
                                case "completed" -> "succeeded";
                                case "failed" -> "failed";
                                default -> "unknown";
                            };
                    mappingKnown = sourceMappingKnown && toolCallId != null && toolName != null
                            && (statusValue == null || "completed".equals(statusValue)
                            || "failed".equals(statusValue));
                }
                default -> {
                    kind = "run.lifecycle";
                    status = "unknown";
                    mappingKnown = false;
                }
            }
            result.add(new SourceRecord(CONTEXT_EVENT_SOURCE, string(row[0]), instant(row[2]),
                    kind, status, nonNegative(durationMs), null, null, null,
                    inputTokens, outputTokens, totalTokens,
                    toolCallId, toolName, null, mappingKnown, pairingComplete));
        }
        return result;
    }

    public List<SourceRecord> readProviderAttempts(UUID runId, Instant asOf,
                                                   Cursor cursor, int maxRows) {
        String sql = "SELECT a.attempt_id::text, " + PROVIDER_ATTEMPT_TIME + ", "
                + "CASE WHEN a.ended_at IS NOT NULL AND a.ended_at <= :asOf "
                + "THEN 'terminal' ELSE 'running' END, "
                + "CASE WHEN a.ended_at IS NOT NULL AND a.ended_at <= :asOf "
                + "THEN a.outcome ELSE NULL END, "
                + "CASE WHEN a.ended_at IS NOT NULL AND a.ended_at <= :asOf "
                + "THEN a.duration_ms ELSE NULL END, "
                + "CASE WHEN a.ended_at IS NOT NULL AND a.ended_at <= :asOf "
                + "THEN COALESCE(a.error_code, a.provider_http_status::text) END "
                + "FROM chat_run_transport_attempts a WHERE a.run_id = CAST(:runId AS uuid) "
                + "AND a.started_at <= :asOf"
                + afterCursor(PROVIDER_ATTEMPT_SOURCE, PROVIDER_ATTEMPT_TIME, "a.attempt_id::text", cursor)
                + " ORDER BY " + PROVIDER_ATTEMPT_TIME + " ASC, a.attempt_id::text COLLATE \"C\" ASC";
        Query query = entityManager.createNativeQuery(sql)
                .setParameter("runId", runId)
                .setParameter("asOf", asOf)
                .setMaxResults(maxRows);
        bindCursor(query, cursor);
        List<SourceRecord> result = new ArrayList<>();
        for (Object[] row : rows(query)) {
            String rowStatus = string(row[2]);
            String outcome = string(row[3]);
            String status = "running".equals(rowStatus) ? "started"
                    : switch (outcome == null ? "" : outcome) {
                        case "success" -> "succeeded";
                        case "error", "timeout" -> "failed";
                        default -> "unknown";
                    };
            boolean mappingKnown = !"unknown".equals(status);
            result.add(new SourceRecord(PROVIDER_ATTEMPT_SOURCE, string(row[0]), instant(row[1]),
                    "provider.attempt", status, nonNegative(number(row[4])), safeErrorCode(string(row[5])),
                    null, null, null, null, null, null, null, null, mappingKnown, true));
        }
        return result;
    }

    public List<SourceRecord> readMcpInvocations(UUID runId, Instant asOf,
                                                 Cursor cursor, int maxRows) {
        String sql = "SELECT i.id::text, i.tool_call_id::text, i.tool_name, "
                + "CASE WHEN i.finished_at IS NOT NULL AND i.finished_at <= :asOf "
                + "THEN i.status ELSE 'active' END, "
                + MCP_INVOCATION_TIME + ", "
                + "CASE WHEN i.finished_at IS NOT NULL AND i.finished_at <= :asOf "
                + "THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (i.finished_at - i.started_at)) * 1000))::bigint END, "
                + "CASE WHEN i.finished_at IS NOT NULL AND i.finished_at <= :asOf "
                + "THEN i.error_code END "
                + "FROM mcp_invocations i WHERE i.run_id = CAST(:runId AS uuid) "
                + "AND i.created_at <= :asOf AND i.started_at <= :asOf"
                + afterCursor(MCP_INVOCATION_SOURCE, MCP_INVOCATION_TIME, "i.id::text", cursor)
                + " ORDER BY " + MCP_INVOCATION_TIME + " ASC, i.id::text COLLATE \"C\" ASC";
        Query query = entityManager.createNativeQuery(sql)
                .setParameter("runId", runId)
                .setParameter("asOf", asOf)
                .setMaxResults(maxRows);
        bindCursor(query, cursor);
        List<SourceRecord> result = new ArrayList<>();
        for (Object[] row : rows(query)) {
            String invocationStatus = string(row[3]);
            String status = switch (invocationStatus == null ? "" : invocationStatus) {
                case "active" -> "pending";
                case "completed" -> "succeeded";
                case "failed" -> "failed";
                default -> "unknown";
            };
            String toolName = safeToolName(string(row[2]));
            boolean mappingKnown = !"unknown".equals(status) && toolName != null;
            result.add(new SourceRecord(MCP_INVOCATION_SOURCE, string(row[0]), instant(row[4]),
                    "mcp.invocation", status, nonNegative(number(row[5])), safeErrorCode(string(row[6])),
                    null, null, null, null, null, string(row[1]), toolName, null, mappingKnown, true));
        }
        return result;
    }

    public List<SourceRecord> readRuntimeJobs(UUID runId, Instant asOf,
                                              Cursor cursor, int maxRows) {
        List<SourceRecord> result = new ArrayList<>(readRuntimeJobHistory(runId, asOf, cursor, maxRows));
        result.addAll(readRuntimeJobsWithoutHistory(runId, asOf, cursor, maxRows));
        result.sort(java.util.Comparator.comparing(SourceRecord::occurredAt)
                .thenComparing(SourceRecord::sourceRecordId));
        if (result.size() > maxRows) {
            return List.copyOf(result.subList(0, maxRows));
        }
        return result;
    }

    /**
     * Detects possible same-Session jobs with no Run link without projecting them as
     * Run events. Only immutable creation time and the nullable correlation are read.
     */
    public boolean hasUnlinkedRuntimeJobCandidate(UUID sessionId, Instant runCreatedAt,
                                                  Instant runWindowEnd, Instant asOf) {
        String sql = "SELECT EXISTS (SELECT 1 FROM workspace_jobs j "
                + "WHERE j.session_id = CAST(:sessionId AS uuid) AND j.run_id IS NULL "
                + "AND j.created_at >= :runCreatedAt AND j.created_at <= :runWindowEnd "
                + "AND j.created_at <= :asOf)";
        Object result = entityManager.createNativeQuery(sql)
                .setParameter("sessionId", sessionId)
                .setParameter("runCreatedAt", runCreatedAt)
                .setParameter("runWindowEnd", runWindowEnd)
                .setParameter("asOf", asOf)
                .getSingleResult();
        if (result instanceof Boolean candidate) {
            return candidate;
        }
        throw new IllegalStateException("Run Trace coverage query returned an invalid result");
    }

    private List<SourceRecord> readRuntimeJobHistory(UUID runId, Instant asOf,
                                                     Cursor cursor, int maxRows) {
        String sql = "SELECT h.id::text, j.id::text, h.to_status, h.created_at, h.error_code, "
                + "CASE WHEN h.to_status IN ('succeeded', 'completed', 'failed', 'timeout', "
                + "'cancelled', 'orphaned', 'interrupted') AND j.started_at IS NOT NULL "
                + "THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (h.created_at - j.started_at)) * 1000))::bigint END "
                + "FROM workspace_job_history h JOIN workspace_jobs j ON j.id = h.job_id "
                + "WHERE j.run_id = CAST(:runId AS uuid) AND h.created_at <= :asOf"
                + afterCursor(RUNTIME_JOB_SOURCE, "h.created_at", "h.id::text", cursor)
                + " ORDER BY h.created_at ASC, h.id::text COLLATE \"C\" ASC";
        Query query = entityManager.createNativeQuery(sql)
                .setParameter("runId", runId)
                .setParameter("asOf", asOf)
                .setMaxResults(maxRows);
        bindCursor(query, cursor);
        List<SourceRecord> result = new ArrayList<>();
        for (Object[] row : rows(query)) {
            String status = runtimeStatus(string(row[2]));
            result.add(new SourceRecord(RUNTIME_JOB_SOURCE, string(row[0]), instant(row[3]),
                    "runtime.job", status, number(row[5]), safeErrorCode(string(row[4])),
                    null, null, null, null, null, null, null, string(row[1]),
                    !"unknown".equals(status), true));
        }
        return result;
    }

    private List<SourceRecord> readRuntimeJobsWithoutHistory(UUID runId, Instant asOf,
                                                             Cursor cursor, int maxRows) {
        if (maxRows <= 0) {
            return List.of();
        }
        String sql = "SELECT j.id::text, j.status, j.created_at, j.started_at, j.ended_at, "
                + "CASE WHEN j.updated_at <= :asOf THEN j.error_code END, "
                + "CASE WHEN j.ended_at IS NOT NULL AND j.ended_at <= :asOf AND j.started_at IS NOT NULL "
                + "THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (j.ended_at - j.started_at)) * 1000))::bigint END, "
                + "j.updated_at, " + RUNTIME_JOB_SNAPSHOT_TIME + " "
                + "FROM workspace_jobs j WHERE j.run_id = CAST(:runId AS uuid) "
                + "AND j.created_at <= :asOf AND NOT EXISTS (SELECT 1 FROM workspace_job_history h "
                + "WHERE h.job_id = j.id AND h.created_at <= :asOf)"
                + afterCursor(RUNTIME_JOB_SOURCE, RUNTIME_JOB_SNAPSHOT_TIME, "j.id::text", cursor)
                + " ORDER BY " + RUNTIME_JOB_SNAPSHOT_TIME + " ASC, j.id::text COLLATE \"C\" ASC";
        Query query = entityManager.createNativeQuery(sql)
                .setParameter("runId", runId)
                .setParameter("asOf", asOf)
                .setMaxResults(maxRows);
        bindCursor(query, cursor);
        List<SourceRecord> result = new ArrayList<>();
        for (Object[] row : rows(query)) {
            String currentStatus = string(row[1]);
            Instant updatedAt = instant(row[7]);
            Instant endedAt = nullableInstant(row[4]);
            boolean terminalVisibleAtWatermark = endedAt != null
                    && !endedAt.isAfter(asOf)
                    && isTerminalRuntimeJobStatus(currentStatus);
            if (updatedAt.isAfter(asOf) && !terminalVisibleAtWatermark) {
                currentStatus = row[3] != null && !instant(row[3]).isAfter(asOf) ? "running" : "pending";
            }
            String status = runtimeStatus(currentStatus);
            Instant occurredAt = instant(row[8]);
            result.add(new SourceRecord(RUNTIME_JOB_SOURCE, string(row[0]), occurredAt,
                    "runtime.job", status, number(row[6]), safeErrorCode(string(row[5])),
                    null, null, null, null, null, null, null, string(row[0]),
                    !"unknown".equals(status), true));
        }
        return result;
    }

    private static String runtimeStatus(String status) {
        if (status == null) {
            return "unknown";
        }
        return switch (status) {
            case "pending", "queued" -> "queued";
            case "running" -> "running";
            case "succeeded", "completed" -> "completed";
            case "failed", "timeout", "orphaned", "interrupted" -> "failed";
            case "cancelled" -> "cancelled";
            default -> "unknown";
        };
    }

    private static boolean isTerminalRuntimeJobStatus(String status) {
        return switch (status) {
            case "succeeded", "completed", "failed", "timeout", "cancelled", "orphaned", "interrupted" -> true;
            default -> false;
        };
    }

    private static String afterCursor(String source, String timeExpression,
                                      String idExpression, Cursor cursor) {
        if (cursor == null) {
            return "";
        }
        String sourceLiteral = "'" + source + "' COLLATE \"C\"";
        String cursorSource = "CAST(:cursorSource AS text) COLLATE \"C\"";
        String sourceId = "(" + idExpression + " COLLATE \"C\")";
        String cursorId = "(CAST(:cursorId AS text) COLLATE \"C\")";
        return " AND (" + timeExpression + " > :cursorAt OR (" + timeExpression
                + " = :cursorAt AND (" + sourceLiteral + " > " + cursorSource + " OR ("
                + sourceLiteral + " = " + cursorSource + " AND " + sourceId + " > "
                + cursorId + "))))";
    }

    private static void bindCursor(Query query, Cursor cursor) {
        if (cursor != null) {
            query.setParameter("cursorAt", cursor.occurredAt())
                    .setParameter("cursorSource", cursor.source())
                    .setParameter("cursorId", cursor.sourceRecordId());
        }
    }

    private static List<Object[]> rows(Query query) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = query.getResultList();
        return rows;
    }

    private static String safeToolName(String toolName) {
        if (toolName == null || toolName.isBlank() || toolName.length() > 128
                || !toolName.matches("[A-Za-z0-9_.:-]+")) {
            return null;
        }
        return toolName;
    }

    private static String safeToolCallId(String toolCallId) {
        if (toolCallId == null || toolCallId.isBlank() || toolCallId.length() > 128
                || !toolCallId.matches("[A-Za-z0-9_.:-]+")) {
            return null;
        }
        return toolCallId;
    }

    public static String safeErrorCode(String errorCode) {
        if (errorCode == null || errorCode.isBlank() || errorCode.length() > 64
                || !errorCode.matches("[A-Za-z0-9_.:-]+")) {
            return null;
        }
        return errorCode;
    }

    private static String string(Object value) {
        return value == null ? null : value.toString();
    }

    private static Instant instant(Object value) {
        if (value instanceof Instant instant) {
            return instant;
        }
        if (value instanceof OffsetDateTime offsetDateTime) {
            return offsetDateTime.toInstant();
        }
        if (value instanceof Timestamp timestamp) {
            return timestamp.toInstant();
        }
        throw new IllegalStateException("Run Trace source returned an invalid timestamp");
    }

    private static Instant nullableInstant(Object value) {
        return value == null ? null : instant(value);
    }

    private static Long number(Object value) {
        if (value instanceof Number number) {
            return number.longValue();
        }
        return null;
    }

    private static Long nonNegative(Long value) {
        return value != null && value >= 0 ? value : null;
    }

    private static Long nonNegativeLong(Object value) {
        if (value == null) {
            return null;
        }
        try {
            BigInteger parsed = new BigDecimal(value.toString()).toBigIntegerExact();
            if (parsed.signum() < 0 || parsed.compareTo(BigInteger.valueOf(Long.MAX_VALUE)) > 0) {
                return null;
            }
            return parsed.longValueExact();
        } catch (ArithmeticException | NumberFormatException e) {
            return null;
        }
    }

    /** Safe normalized fields only; no payload, preview, result, or runtime state. */
    public record RunMetadata(UUID id, String sessionId, String userId, String workspaceId,
                              String provider, String model, String status, Instant terminalAt,
                              String terminalOutcome, String errorCode, Instant createdAt,
                              String providerConnectionId, Long connectionRevision,
                              String contextTemplateLayer, String contextTemplateId,
                              String contextTemplateVersion, String apiTypeId,
                              String apiTypeVersion) {
    }

    public record RunIdentity(UUID id, String sessionId, String userId, String workspaceId) {
    }

    public record SourceRecord(String source, String sourceRecordId, Instant occurredAt,
                               String kind, String status, Long durationMs, String errorCode,
                               String providerId, String modelId, Long inputTokens,
                               Long outputTokens, Long totalTokens, String toolCallId,
                               String toolName, String runtimeJobId, boolean mappingKnown,
                               boolean pairingComplete) {
    }

    public record Cursor(Instant occurredAt, String source, String sourceRecordId) {
    }
}
