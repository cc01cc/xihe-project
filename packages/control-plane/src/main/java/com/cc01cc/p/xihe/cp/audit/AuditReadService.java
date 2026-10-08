package com.cc01cc.p.xihe.cp.audit;

import com.cc01cc.p.xihe.cp.chat.ApprovalPolicySummary;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.McpInvocation;
import com.cc01cc.p.xihe.cp.policy.SafePolicySummary;
import com.cc01cc.p.xihe.cp.repository.ApprovalHistoryRepository;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunHistoryRepository;
import com.cc01cc.p.xihe.cp.repository.McpAttemptRepository;
import com.cc01cc.p.xihe.cp.repository.McpDispatchHistoryRepository;
import com.cc01cc.p.xihe.cp.repository.McpInvocationRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceJobHistoryRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0466 T1.1/T1.2: read model for the audit query surface.
 *
 * <p>The list is a single paged SELECT against the {@code v_audit_entries} view (one
 * SQL page, no application-side merge — design 关键设计 #1/#3); the detail is the VIEW
 * row for the entry (same ACL predicate as the list, so a foreign or missing id is
 * indistinguishable) plus that domain's append-only history timeline (decision #8).</p>
 *
 * <p>ACL: the caller's user id is part of the WHERE clause — never a post-filter — so
 * a wrong-owner id returns the same 404 as an unknown id (no existence leak).</p>
 */
@Service
public class AuditReadService {

    static final Set<String> TYPES = Set.of(
            "chat_run", "workspace_job", "mcp_invocation", "approval");

    static final String TYPE_HINT = "chat_run|workspace_job|mcp_invocation|approval";

    private static final Logger logger = LoggerFactory.getLogger(AuditReadService.class);

    private static final String COLUMNS = "type, entry_id, user_id, session_id, workspace_id, "
            + "run_id, status, summary, source, error_code, created_at, started_at, finished_at, "
            + "terminal_outcome, scope, cancel_reason, tool_call_id, approval_request_id, "
            + "idempotency_key, request_id, runtime_job_id";

    private final JdbcTemplate jdbcTemplate;
    private final ChatRunHistoryRepository chatRunHistoryRepository;
    private final WorkspaceJobHistoryRepository workspaceJobHistoryRepository;
    private final McpDispatchHistoryRepository mcpDispatchHistoryRepository;
    private final ApprovalHistoryRepository approvalHistoryRepository;
    private final McpInvocationRepository mcpInvocationRepository;
    private final ChatApprovalRepository chatApprovalRepository;
    private final McpAttemptRepository mcpAttemptRepository;
    private final ApprovalPolicySummary approvalPolicySummary;

    public AuditReadService(JdbcTemplate jdbcTemplate,
                            ChatRunHistoryRepository chatRunHistoryRepository,
                            WorkspaceJobHistoryRepository workspaceJobHistoryRepository,
                            McpDispatchHistoryRepository mcpDispatchHistoryRepository,
                            ApprovalHistoryRepository approvalHistoryRepository,
                            McpInvocationRepository mcpInvocationRepository,
                            ChatApprovalRepository chatApprovalRepository,
                            McpAttemptRepository mcpAttemptRepository,
                            ApprovalPolicySummary approvalPolicySummary) {
        this.jdbcTemplate = jdbcTemplate;
        this.chatRunHistoryRepository = chatRunHistoryRepository;
        this.workspaceJobHistoryRepository = workspaceJobHistoryRepository;
        this.mcpDispatchHistoryRepository = mcpDispatchHistoryRepository;
        this.approvalHistoryRepository = approvalHistoryRepository;
        this.mcpInvocationRepository = mcpInvocationRepository;
        this.chatApprovalRepository = chatApprovalRepository;
        this.mcpAttemptRepository = mcpAttemptRepository;
        this.approvalPolicySummary = approvalPolicySummary;
    }

    /** One paged result of the VIEW; {@code totalPages} is 0 for an empty set. */
    public record AuditPage(List<AuditEntryRow> entries, int page, int size,
                            long totalElements, int totalPages) {}

    /** Detail envelope: whitelisted entry + that domain's history timeline + attempts. */
    public record AuditDetail(Map<String, Object> entry,
                              List<Map<String, Object>> timeline,
                              List<Map<String, Object>> attempts) {}

    /**
     * Owner-scoped list. {@code workspaceId} / {@code sessionId} are optional scope
     * filters; {@code type} must be a known type tag and {@code status} is a free
     * native-domain value (an unknown status simply yields an empty set).
     *
     * @param userId non-null owner id (user view only; the internal surface has no list)
     */
    @Transactional(readOnly = true)
    public AuditPage list(String userId, String sessionId, UUID workspaceId,
                          String type, String status, int page, int size) {
        if (type != null && !TYPES.contains(type)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "type must be one of " + TYPE_HINT);
        }
        List<String> clauses = new ArrayList<>();
        List<Object> params = new ArrayList<>();
        clauses.add("user_id = ?");
        params.add(UUID.fromString(userId));
        if (sessionId != null) {
            clauses.add("session_id = ?");
            params.add(UUID.fromString(sessionId));
        }
        if (workspaceId != null) {
            clauses.add("workspace_id = ?");
            params.add(workspaceId);
        }
        if (type != null) {
            clauses.add("type = ?");
            params.add(type);
        }
        if (status != null) {
            clauses.add("status = ?");
            params.add(status);
        }
        String where = " WHERE " + String.join(" AND ", clauses);

        Long total = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM v_audit_entries" + where, Long.class, params.toArray());
        long totalElements = total == null ? 0L : total;

        List<Object> pageParams = new ArrayList<>(params);
        pageParams.add(size);
        pageParams.add((long) page * size);
        List<AuditEntryRow> entries = jdbcTemplate.query(
                "SELECT " + COLUMNS + " FROM v_audit_entries" + where
                        + " ORDER BY created_at DESC, entry_id DESC LIMIT ? OFFSET ?",
                AuditReadService::mapRow, pageParams.toArray());

        int totalPages = totalElements == 0L ? 0
                : (int) Math.ceil((double) totalElements / (double) size);
        return new AuditPage(entries, page, size, totalElements, totalPages);
    }

    /**
     * One entry + its history timeline. {@code userId == null} selects the internal
     * (service Bearer) projection; otherwise the row must belong to the caller or the
     * call fails with the same 404 as an unknown id.
     */
    @Transactional(readOnly = true)
    public AuditDetail detail(String type, UUID id, String userId) {
        requireType(type);
        StringBuilder sql = new StringBuilder("SELECT " + COLUMNS
                + " FROM v_audit_entries WHERE type = ? AND entry_id = ?");
        List<Object> params = new ArrayList<>();
        params.add(type);
        params.add(id);
        if (userId != null) {
            sql.append(" AND user_id = ?");
            params.add(UUID.fromString(userId));
        }
        List<AuditEntryRow> rows = jdbcTemplate.query(sql.toString(),
                AuditReadService::mapRow, params.toArray());
        if (rows.isEmpty()) {
            throw notFound();
        }
        boolean internal = userId == null;
        Map<String, Object> entry = internal
                ? AuditViews.toInternalEntry(rows.get(0))
                : AuditViews.toUserEntry(rows.get(0));
        List<Map<String, Object>> timeline = new ArrayList<>();
        List<Map<String, Object>> attempts = new ArrayList<>();
        switch (type) {
            case "chat_run" -> chatRunHistoryRepository.findByRunIdOrderBySequenceAsc(id)
                    .forEach(history -> timeline.add(AuditViews.toTimeline(history)));
            case "workspace_job" -> workspaceJobHistoryRepository
                    .findByJobIdOrderBySequenceAsc(id)
                    .forEach(history -> timeline.add(AuditViews.toTimeline(history)));
            case "mcp_invocation" -> {
                mcpDispatchHistoryRepository.findByInvocationIdOrderBySequenceAsc(id)
                        .forEach(history -> timeline.add(AuditViews.toTimeline(history)));
                mcpInvocationRepository.findById(id).ifPresent(invocation ->
                        attachMcpPolicy(entry, invocation));
                mcpAttemptRepository.findByInvocationIdOrderByStartedAtAsc(id)
                        .forEach(attempt -> attempts.add(internal
                                ? AuditViews.toInternalAttempt(attempt)
                                : AuditViews.toUserAttempt(attempt)));
            }
            case "approval" -> {
                approvalHistoryRepository.findByRequestIdOrderBySequenceAsc(id)
                        .forEach(history -> timeline.add(AuditViews.toTimeline(history)));
                chatApprovalRepository.findById(id).ifPresent(approval -> {
                    attachApprovalPolicy(entry, approval);
                    entry.put("approved", approval.getApproved());
                    entry.put("decisionKind", approval.getDecisionKind());
                });
            }
            default -> throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "type must be one of " + TYPE_HINT);
        }
        return new AuditDetail(entry, timeline, attempts);
    }

    /** Type tag validation shared by the detail routes. */
    public static void requireType(String type) {
        if (type == null || !TYPES.contains(type)) {
            logger.warn("Audit detail rejected: unknown type tag");
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "type must be one of " + TYPE_HINT);
        }
    }

    private static CpApiException notFound() {
        // Same code and message for "does not exist" and "not yours": a wrong-owner id
        // must not confirm existence (PLAN-0466 T1.2 / spec/security/audit.md §2).
        return new CpApiException(HttpStatus.NOT_FOUND, "AUDIT_ENTRY_NOT_FOUND",
                "Audit entry not found");
    }

    private void attachMcpPolicy(Map<String, Object> entry, McpInvocation invocation) {
        // Only the parsed safe snapshot is projected; the raw policy_summary TEXT and
        // arguments_preview columns never leave this process (T2.2).
        SafePolicySummary.parse(invocation.getPolicySummary())
                .ifPresent(policy -> entry.put("policy", policy));
    }

    private void attachApprovalPolicy(Map<String, Object> entry, ChatApproval approval) {
        approvalPolicySummary.parse(approval.getPolicySummary()).ifPresent(policy -> {
            // Approval snapshots are taken at creation (effect=ask) and carry neither an
            // automatic-allow marker nor the reuse annotation: both keys project as
            // null — "not applicable", exactly what the safe policy summary schema
            // documents for legacy-shaped snapshots. Never a guessed value.
            policy.putIfAbsent("allowedBy", null);
            policy.putIfAbsent("reused", null);
            entry.put("policy", policy);
        });
    }

    private static AuditEntryRow mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new AuditEntryRow(
                rs.getString("type"),
                rs.getObject("entry_id", UUID.class),
                rs.getObject("user_id", UUID.class),
                rs.getObject("session_id", UUID.class),
                rs.getObject("workspace_id", UUID.class),
                rs.getObject("run_id", UUID.class),
                rs.getString("status"),
                rs.getString("summary"),
                rs.getString("source"),
                rs.getString("error_code"),
                instant(rs, "created_at"),
                instant(rs, "started_at"),
                instant(rs, "finished_at"),
                rs.getString("terminal_outcome"),
                rs.getString("scope"),
                rs.getString("cancel_reason"),
                rs.getObject("tool_call_id", UUID.class),
                rs.getObject("approval_request_id", UUID.class),
                rs.getString("idempotency_key"),
                rs.getObject("request_id", UUID.class),
                rs.getString("runtime_job_id"));
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        Timestamp value = rs.getTimestamp(column);
        return value == null ? null : value.toInstant();
    }
}
