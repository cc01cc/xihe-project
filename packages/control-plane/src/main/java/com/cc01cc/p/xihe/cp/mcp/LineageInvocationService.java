package com.cc01cc.p.xihe.cp.mcp;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.AgentLineageInvocation;
import com.cc01cc.p.xihe.cp.entity.McpAttempt;
import com.cc01cc.p.xihe.cp.entity.McpInvocation;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.repository.AgentLineageInvocationRepository;
import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;

/**
 * Cross-Run mutation identity and replay barrier for checkpoint lineages.
 *
 * <p>The CP reserves before dispatch and commits that reservation independently
 * of the external call. A repeated call can therefore never infer "not run"
 * from a missing Workspace Job projection or from a restarted Agent. This ledger
 * contains no raw MCP arguments or result bodies.</p>
 */
@Service
public class LineageInvocationService {

    public static final int MAX_ORIGINATING_TOOL_CALL_ID_LENGTH = 128;
    public static final int MAX_COMPLETED_TOOL_CALL_IDS = 8_192;
    public static final int MAX_LINEAGE_RUN_IDS = 8_192;
    private static final int MAX_CONTINUATION_ADMISSION_BYTES = 1_048_576;
    private static final String RECONCILIATION_REQUIRED = "RECONCILIATION_REQUIRED";
    private static final ObjectMapper STRICT_JSON = new ObjectMapper(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .build());

    private final AgentLineageInvocationRepository invocations;
    private final JdbcTemplate jdbc;
    private final ObjectMapper objectMapper;
    private final DbLockTimeout dbLockTimeout;
    private final ToolFaceRegistry toolFaces;

    public LineageInvocationService(AgentLineageInvocationRepository invocations,
                                    JdbcTemplate jdbc,
                                    ObjectMapper objectMapper,
                                    DbLockTimeout dbLockTimeout,
                                    ToolFaceRegistry toolFaces) {
        this.invocations = invocations;
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
        this.dbLockTimeout = dbLockTimeout;
        this.toolFaces = toolFaces;
    }

    public enum DecisionKind { NOT_LINEAGED, RESERVED, REPLAY_BLOCKED, IDENTITY_CONFLICT }

    public record Reservation(UUID id, UUID lineageId, String originatingToolCallId,
                              UUID mcpInvocationId, UUID runLocalToolCallId) {}

    /** A blocked/conflict decision is returned so the transaction can commit its audit counter first. */
    public record ReservationDecision(DecisionKind kind, Reservation reservation) {}

    /** Minimal projection consumed by Agent checkpoint preflight. */
    public record ContinuationAdmission(List<String> completedToolCallIds, List<String> lineageRunIds) {
        public ContinuationAdmission {
            completedToolCallIds = List.copyOf(completedToolCallIds);
            lineageRunIds = List.copyOf(lineageRunIds);
        }
    }

    /**
     * Atomically reserve one mutation identity before its external dispatch.
     * The originating ID is a provider/LangGraph opaque ID, distinct from the
     * CP/Runtime UUID correlation ID.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public ReservationDecision reserve(String runId, String runLocalToolCallId,
                                       UUID mcpInvocationId, String originatingToolCallId,
                                       String toolName, String requestBody) {
        dbLockTimeout.apply();
        RunLineage run = findRunLineage(runId);
        if (run == null) {
            return new ReservationDecision(DecisionKind.NOT_LINEAGED, null);
        }

        String originId = validateOriginatingToolCallId(originatingToolCallId);
        UUID runUuid = parseUuid(runId);
        UUID runLocalId = parseUuid(runLocalToolCallId);
        if (runLocalId == null || mcpInvocationId == null) {
            throw reconciliation("Mutation invocation identity is unavailable");
        }
        if (toolName == null || toolName.isBlank() || toolName.length() > 128) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Tool name is invalid");
        }
        McpReservationBinding mcpBinding = findMcpReservationBinding(mcpInvocationId);
        if (mcpBinding == null
                || !McpInvocation.SOURCE_AGENT.equals(mcpBinding.source())
                || !runUuid.equals(mcpBinding.runId())
                || !runLocalId.equals(mcpBinding.toolCallId())
                || !toolName.equals(mcpBinding.toolName())) {
            throw reconciliation("Mutation invocation does not match its CP identity");
        }
        String argumentsHash = canonicalArgumentsHash(requestBody, toolName);

        AgentLineageInvocation existing = invocations
                .findByIdentityForUpdate(run.lineageId(), originId).orElse(null);
        if (existing != null) {
            if (!existing.getToolName().equals(toolName)
                    || !existing.getArgumentsHash().equals(argumentsHash)) {
                existing.setConflictCount(existing.getConflictCount() + 1);
                existing.setLastConflictCode("identity_mismatch");
                existing.setLastConflictAt(Instant.now());
                invocations.saveAndFlush(existing);
                return new ReservationDecision(DecisionKind.IDENTITY_CONFLICT, null);
            }
            // Even a completed dispatch has no reusable result body in this ledger.
            // Agent may reuse only a matching schema-safe ToolMessage from the
            // checkpoint; if it re-enters this dispatch path, reconciliation is required.
            return new ReservationDecision(DecisionKind.REPLAY_BLOCKED, null);
        }
        Integer priorBindings;
        try {
            priorBindings = jdbc.queryForObject("""
                    SELECT count(*) FROM agent_lineage_invocations WHERE mcp_invocation_id = ?
                    """, Integer.class, mcpInvocationId);
        } catch (DataAccessException e) {
            throw reconciliation("Mutation MCP invocation binding is unavailable", e);
        }
        if (priorBindings == null || priorBindings != 0) {
            throw reconciliation("MCP invocation is already bound to another lineage mutation");
        }
        if (!McpInvocation.STATUS_ACTIVE.equals(mcpBinding.status())) {
            throw reconciliation("Mutation MCP invocation is not active");
        }

        UUID reservationId = UUID.randomUUID();
        int inserted;
        try {
            inserted = jdbc.update("""
                    INSERT INTO agent_lineage_invocations
                        (id, lineage_id, originating_tool_call_id, first_run_id,
                         first_tool_call_id, mcp_invocation_id, tool_name, arguments_hash, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
                    ON CONFLICT (lineage_id, originating_tool_call_id) DO NOTHING
                    """, reservationId, run.lineageId(), originId, runUuid, runLocalId,
                    mcpInvocationId, toolName, argumentsHash);
        } catch (DataAccessException e) {
            // An unavailable reservation store must never degrade to dispatch.
            throw reconciliation("Mutation reservation is unavailable", e);
        }
        if (inserted != 1) {
            // A concurrent transaction reserved the key after our initial lookup.
            // Do not wait-and-reuse its result: it may still be in flight.
            AgentLineageInvocation winner = invocations
                    .findByIdentityForUpdate(run.lineageId(), originId).orElse(null);
            if (winner != null && (!winner.getToolName().equals(toolName)
                    || !winner.getArgumentsHash().equals(argumentsHash))) {
                winner.setConflictCount(winner.getConflictCount() + 1);
                winner.setLastConflictCode("identity_mismatch");
                winner.setLastConflictAt(Instant.now());
                invocations.saveAndFlush(winner);
                return new ReservationDecision(DecisionKind.IDENTITY_CONFLICT, null);
            }
            return new ReservationDecision(DecisionKind.REPLAY_BLOCKED, null);
        }
        return new ReservationDecision(DecisionKind.RESERVED,
                new Reservation(reservationId, run.lineageId(), originId, mcpInvocationId, runLocalId));
    }

    /**
     * Settle only the reservation that this CP request created. A lost result
     * leaves the durable row pending, which prevents any automatic replay.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void settle(Reservation reservation, String status) {
        if (reservation == null) {
            return;
        }
        if (!List.of(AgentLineageInvocation.STATUS_COMPLETED,
                AgentLineageInvocation.STATUS_AMBIGUOUS,
                AgentLineageInvocation.STATUS_UNKNOWN,
                AgentLineageInvocation.STATUS_FAILED).contains(status)) {
            throw new IllegalArgumentException("Invalid lineage invocation settlement status");
        }
        dbLockTimeout.apply();
        AgentLineageInvocation row = invocations
                .findByIdentityForUpdate(reservation.lineageId(), reservation.originatingToolCallId())
                .orElse(null);
        if (row == null || !row.getId().equals(reservation.id())
                || !AgentLineageInvocation.STATUS_PENDING.equals(row.getStatus())) {
            return;
        }
        row.setStatus(status);
        invocations.saveAndFlush(row);
    }

    /**
     * Authoritative CP-side side-effect admission check for a source Run.
     * Returns completed originating IDs only; the Agent must still verify a
     * matching schema-safe ToolMessage in the selected graph checkpoint.
     */
    @Transactional(readOnly = true)
    public ContinuationAdmission requireContinuationEligible(String sourceRunId, String lineageIdValue) {
        UUID sourceRun = parseUuid(sourceRunId);
        UUID lineageId = parseUuid(lineageIdValue);
        if (sourceRun == null || lineageId == null || !runBelongsToLineage(sourceRun, lineageId)) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "CONTINUATION_SOURCE_NOT_FOUND",
                    "Checkpoint continuation source is unavailable");
        }
        List<AgentLineageInvocation> rows = invocations.findByLineageIdOrderByOriginatingToolCallIdAsc(
                lineageId, org.springframework.data.domain.PageRequest.of(0, MAX_COMPLETED_TOOL_CALL_IDS + 1));
        if (rows.size() > MAX_COMPLETED_TOOL_CALL_IDS) {
            throw reconciliation("Lineage mutation history exceeds the continuation limit");
        }
        List<ContinuationRunBinding> runBindings = jdbc.query("""
                SELECT cr.id, cr.session_id AS run_session_id, cr.user_id AS run_user_id,
                       cr.workspace_id AS run_workspace_id, cr.branch_id AS run_branch_id,
                       l.session_id AS lineage_session_id, l.user_id AS lineage_user_id,
                       l.workspace_id AS lineage_workspace_id, l.branch_id AS lineage_branch_id
                  FROM chat_runs cr
                  JOIN agent_graph_checkpoint_lineages l ON l.lineage_id = ?
                 WHERE cr.id = l.source_run_id OR cr.continuation_lineage_id = l.lineage_id
                 ORDER BY cr.id
                 LIMIT ?
                """, (rs, rowNum) -> new ContinuationRunBinding(
                rs.getObject("id", UUID.class),
                rs.getObject("run_session_id", UUID.class), rs.getObject("run_user_id", UUID.class),
                rs.getObject("run_workspace_id", UUID.class), rs.getObject("run_branch_id", UUID.class),
                rs.getObject("lineage_session_id", UUID.class), rs.getObject("lineage_user_id", UUID.class),
                rs.getObject("lineage_workspace_id", UUID.class), rs.getObject("lineage_branch_id", UUID.class)),
                lineageId, MAX_LINEAGE_RUN_IDS + 1);
        if (runBindings.size() > MAX_LINEAGE_RUN_IDS) {
            throw reconciliation("Lineage Run history exceeds the continuation limit");
        }
        if (runBindings.stream().noneMatch(binding -> sourceRun.equals(binding.runId()))) {
            throw reconciliation("Continuation source is missing from its lineage");
        }
        for (ContinuationRunBinding binding : runBindings) {
            if (!ownerTupleMatches(binding)) {
                throw reconciliation("Continuation Run ownership does not match its lineage");
            }
        }
        List<String> lineageRunIds = runBindings.stream()
                .map(binding -> binding.runId().toString()).toList();
        List<String> completed = new ArrayList<>(rows.size());
        Map<UUID, AgentLineageInvocation> byMcpInvocation = new java.util.HashMap<>();
        for (AgentLineageInvocation row : rows) {
            if (!AgentLineageInvocation.STATUS_COMPLETED.equals(row.getStatus())) {
                throw reconciliation("Lineage contains an unresolved mutation");
            }
            if (row.getMcpInvocationId() == null) {
                throw reconciliation("Completed mutation has no CP invocation provenance");
            }
            if (byMcpInvocation.putIfAbsent(row.getMcpInvocationId(), row) != null) {
                throw reconciliation("Multiple lineage mutations reference the same MCP invocation");
            }
            completed.add(row.getOriginatingToolCallId());
        }
        List<McpInvocationProjection> mcpRows = jdbc.query("""
                SELECT mi.id, mi.run_id, mi.tool_call_id, mi.tool_name, mi.source, mi.status,
                       EXISTS (SELECT 1 FROM mcp_attempts ma
                                WHERE ma.invocation_id = mi.id AND ma.stage = ?) AS dispatched
                  FROM mcp_invocations mi
                  JOIN chat_runs cr ON cr.id = mi.run_id
                 WHERE mi.source = 'agent'
                   AND (cr.continuation_lineage_id = ? OR cr.id IN (
                       SELECT source_run_id FROM agent_graph_checkpoint_lineages WHERE lineage_id = ?))
                """, (rs, rowNum) -> new McpInvocationProjection(
                rs.getObject("id", UUID.class), rs.getObject("run_id", UUID.class),
                rs.getObject("tool_call_id", UUID.class), rs.getString("tool_name"),
                rs.getString("source"), rs.getString("status"), rs.getBoolean("dispatched")),
                McpAttempt.STAGE_CP_FORWARD, lineageId, lineageId);
        java.util.Set<UUID> matchedLedgerIds = new java.util.HashSet<>();
        for (McpInvocationProjection mcp : mcpRows) {
            // PLAN-0510（2026-10-16 用户裁定）：SSE relay 记账半会为"计划中"的 tool call 先建
            // source=agent invocation（PLAN-0464 T2.2），此时 MCP gate 尚未运行。未进入 CP 派发
            // 尝试（无 cp_forward attempt）的行没有产生任何外部副作用——无论其状态是 active /
            // unknown / failed，都不得按"未决 lineage mutation"阻塞续跑。
            if (!mcp.dispatched()) {
                continue;
            }
            if ("active".equals(mcp.status()) || "unknown".equals(mcp.status())) {
                throw reconciliation("Lineage contains an unresolved MCP invocation");
            }
            boolean mutation = !ToolFaceRegistry.ACTION_READ.equals(toolFaces.faceOf(mcp.toolName()).actionClass());
            AgentLineageInvocation ledgerRow = byMcpInvocation.get(mcp.id());
            if (mutation && ledgerRow == null) {
                throw reconciliation("Mutation invocation is missing lineage provenance");
            }
            if (ledgerRow != null && (!AgentLineageInvocation.STATUS_COMPLETED.equals(ledgerRow.getStatus())
                    || !McpInvocation.SOURCE_AGENT.equals(mcp.source())
                    || !mcp.runId().equals(ledgerRow.getFirstRunId())
                    || !mcp.toolCallId().equals(ledgerRow.getFirstToolCallId())
                    || !mcp.toolName().equals(ledgerRow.getToolName())
                    || !"completed".equals(mcp.status()))) {
                throw reconciliation("Lineage MCP invocation does not match its mutation ledger");
            }
            if (ledgerRow != null && !matchedLedgerIds.add(ledgerRow.getId())) {
                throw reconciliation("Lineage mutation matched more than one MCP invocation");
            }
        }
        if (matchedLedgerIds.size() != rows.size()) {
            throw reconciliation("Completed lineage mutation is missing its MCP invocation");
        }
        try {
            ContinuationAdmission admission = new ContinuationAdmission(completed, lineageRunIds);
            if (objectMapper.writeValueAsBytes(admission).length > MAX_CONTINUATION_ADMISSION_BYTES) {
                throw reconciliation("Lineage mutation history exceeds the continuation limit");
            }
        } catch (JsonProcessingException e) {
            throw reconciliation("Lineage mutation history is unavailable", e);
        }
        return new ContinuationAdmission(completed, lineageRunIds);
    }

    private RunLineage findRunLineage(String runId) {
        UUID runUuid = parseUuid(runId);
        if (runUuid == null) {
            return null;
        }
        List<RunLineage> rows = jdbc.query("""
                SELECT cr.session_id, cr.user_id, cr.workspace_id, cr.branch_id,
                       cr.continuation_lineage_id, cr.continuation_source_run_id,
                       source_lineage.lineage_id AS source_lineage_id
                  FROM chat_runs cr
                  LEFT JOIN agent_graph_checkpoint_lineages source_lineage
                    ON source_lineage.source_run_id = cr.id
                 WHERE cr.id = ?
                """, (rs, rowNum) -> new RunLineage(
                rs.getObject("session_id", UUID.class), rs.getObject("user_id", UUID.class),
                rs.getObject("workspace_id", UUID.class), rs.getObject("branch_id", UUID.class),
                rs.getObject("continuation_lineage_id", UUID.class),
                rs.getObject("continuation_source_run_id", UUID.class),
                rs.getObject("source_lineage_id", UUID.class)), runUuid);
        if (rows.size() != 1) {
            return null;
        }
        RunLineage run = rows.getFirst();
        UUID lineageId = run.continuationLineageId() != null
                ? run.continuationLineageId() : run.sourceLineageId();
        if (lineageId == null) {
            if (run.continuationSourceRunId() != null) {
                throw reconciliation("Continuation lineage is unavailable");
            }
            return null;
        }
        if (run.continuationLineageId() != null && run.sourceLineageId() != null
                && !run.continuationLineageId().equals(run.sourceLineageId())) {
            throw reconciliation("Continuation lineage is inconsistent");
        }
        Integer owners = jdbc.queryForObject("""
                SELECT count(*) FROM agent_graph_checkpoint_lineages
                 WHERE lineage_id = ? AND session_id = ? AND user_id = ?
                   AND workspace_id = ? AND branch_id = ?
                """, Integer.class, lineageId, run.sessionId(), run.userId(),
                run.workspaceId(), run.branchId());
        if (owners == null || owners != 1) {
            throw reconciliation("Checkpoint lineage ownership is unavailable");
        }
        return run.withLineageId(lineageId);
    }

    private boolean runBelongsToLineage(UUID sourceRun, UUID lineageId) {
        Integer matches = jdbc.queryForObject("""
                SELECT count(*) FROM chat_runs cr
                 WHERE cr.id = ?
                   AND (cr.continuation_lineage_id = ? OR EXISTS (
                       SELECT 1 FROM agent_graph_checkpoint_lineages l
                        WHERE l.lineage_id = ? AND l.source_run_id = cr.id))
                """, Integer.class, sourceRun, lineageId, lineageId);
        return matches != null && matches == 1;
    }

    private McpReservationBinding findMcpReservationBinding(UUID invocationId) {
        try {
            List<McpReservationBinding> rows = jdbc.query("""
                    SELECT run_id, tool_call_id, tool_name, source, status
                      FROM mcp_invocations
                     WHERE id = ?
                     FOR UPDATE
                    """, (rs, rowNum) -> new McpReservationBinding(
                    rs.getObject("run_id", UUID.class), rs.getObject("tool_call_id", UUID.class),
                    rs.getString("tool_name"), rs.getString("source"), rs.getString("status")), invocationId);
            return rows.size() == 1 ? rows.getFirst() : null;
        } catch (DataAccessException e) {
            throw reconciliation("Mutation MCP invocation binding is unavailable", e);
        }
    }

    static String validateOriginatingToolCallId(String value) {
        if (value == null || value.isBlank() || value.length() > MAX_ORIGINATING_TOOL_CALL_ID_LENGTH
                || value.indexOf('\0') >= 0 || value.chars().anyMatch(Character::isISOControl)) {
            throw reconciliation("Originating tool-call identity is unavailable");
        }
        return value;
    }

    static String canonicalArgumentsHash(String requestBody, String expectedToolName) {
        try {
            JsonNode root = STRICT_JSON.readTree(requestBody);
            if (root == null || !"tools/call".equals(root.path("method").asText())
                    || !expectedToolName.equals(root.path("params").path("name").asText())) {
                throw new IllegalArgumentException("MCP tool call body is invalid");
            }
            JsonNode arguments = root.path("params").get("arguments");
            if (arguments == null) {
                arguments = STRICT_JSON.createObjectNode();
            }
            if (!arguments.isObject()) {
                throw new IllegalArgumentException("MCP tool arguments are invalid");
            }
            byte[] canonical = canonicalJson(arguments).getBytes(StandardCharsets.UTF_8);
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(canonical));
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "MCP tool call arguments are invalid", e);
        } catch (JsonProcessingException | NoSuchAlgorithmException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "MCP tool call arguments are invalid", e);
        }
    }

    private static String canonicalJson(JsonNode value) throws JsonProcessingException {
        if (value.isObject()) {
            Map<String, JsonNode> sorted = new TreeMap<>();
            value.fields().forEachRemaining(entry -> sorted.put(entry.getKey(), entry.getValue()));
            List<String> members = new ArrayList<>(sorted.size());
            for (Map.Entry<String, JsonNode> entry : sorted.entrySet()) {
                members.add(STRICT_JSON.writeValueAsString(entry.getKey()) + ":" + canonicalJson(entry.getValue()));
            }
            return "{" + String.join(",", members) + "}";
        }
        if (value.isArray()) {
            List<String> items = new ArrayList<>(value.size());
            for (JsonNode item : value) {
                items.add(canonicalJson(item));
            }
            return "[" + String.join(",", items) + "]";
        }
        if (value.isTextual()) {
            return STRICT_JSON.writeValueAsString(value.textValue());
        }
        if (value.isNumber()) {
            BigDecimal number = value.decimalValue().stripTrailingZeros();
            return number.signum() == 0 ? "0" : number.toPlainString();
        }
        if (value.isBoolean()) {
            return value.booleanValue() ? "true" : "false";
        }
        if (value.isNull()) {
            return "null";
        }
        throw new IllegalArgumentException("MCP tool arguments are invalid");
    }

    private static UUID parseUuid(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value.trim());
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static CpApiException reconciliation(String detail) {
        return new CpApiException(HttpStatus.CONFLICT, RECONCILIATION_REQUIRED, detail);
    }

    private static CpApiException reconciliation(String detail, Throwable cause) {
        return new CpApiException(HttpStatus.CONFLICT, RECONCILIATION_REQUIRED, detail, cause);
    }

    private record RunLineage(UUID sessionId, UUID userId, UUID workspaceId, UUID branchId,
                              UUID continuationLineageId, UUID continuationSourceRunId,
                              UUID sourceLineageId, UUID lineageId) {
        private RunLineage(UUID sessionId, UUID userId, UUID workspaceId, UUID branchId,
                           UUID continuationLineageId, UUID continuationSourceRunId,
                           UUID sourceLineageId) {
            this(sessionId, userId, workspaceId, branchId, continuationLineageId,
                    continuationSourceRunId, sourceLineageId, null);
        }

        private RunLineage withLineageId(UUID resolvedLineageId) {
            return new RunLineage(sessionId, userId, workspaceId, branchId,
                    continuationLineageId, continuationSourceRunId, sourceLineageId,
                    resolvedLineageId);
        }
    }

    private record McpReservationBinding(UUID runId, UUID toolCallId, String toolName,
                                         String source, String status) {}

    private record McpInvocationProjection(UUID id, UUID runId, UUID toolCallId, String toolName,
                                           String source, String status, boolean dispatched) {}

    static boolean ownerTupleMatches(ContinuationRunBinding binding) {
        return binding != null
                && binding.runSessionId() != null && binding.lineageSessionId() != null
                && binding.runUserId() != null && binding.lineageUserId() != null
                && binding.runWorkspaceId() != null && binding.lineageWorkspaceId() != null
                && binding.runBranchId() != null && binding.lineageBranchId() != null
                && binding.runSessionId().equals(binding.lineageSessionId())
                && binding.runUserId().equals(binding.lineageUserId())
                && binding.runWorkspaceId().equals(binding.lineageWorkspaceId())
                && binding.runBranchId().equals(binding.lineageBranchId());
    }

    record ContinuationRunBinding(
            UUID runId, UUID runSessionId, UUID runUserId, UUID runWorkspaceId, UUID runBranchId,
            UUID lineageSessionId, UUID lineageUserId, UUID lineageWorkspaceId, UUID lineageBranchId) {}
}
