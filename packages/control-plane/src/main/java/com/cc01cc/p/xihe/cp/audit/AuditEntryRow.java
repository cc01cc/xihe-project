package com.cc01cc.p.xihe.cp.audit;

import java.time.Instant;
import java.util.UUID;

/**
 * PLAN-0466 T1.1: one row of the {@code v_audit_entries} read view.
 *
 * <p>The record carries both projection tiers (user + internal extension); which keys
 * reach the wire is decided exclusively by {@link AuditViews} whitelist methods, never
 * by callers picking fields. Correlation columns ({@code idempotencyKey},
 * {@code requestId}) and the runtime handle are internal-tier only.</p>
 *
 * @param type          chat_run | workspace_job | mcp_invocation | approval
 * @param entryId       domain primary key (chat_runs.id / workspace_jobs.id /
 *                      mcp_invocations.id / approval_requests.request_id)
 * @param userId        owning user (filter column; internal tier only on the wire)
 * @param sessionId     scope column, nullable (session-less workspace jobs)
 * @param workspaceId   scope column
 * @param runId         scope column, nullable (session-less workspace jobs)
 * @param status        native domain status/state vocabulary
 * @param summary       non-sensitive list title (model / tool name / null)
 * @param source        native domain provenance (origin/source column)
 * @param errorCode     native domain error code
 * @param createdAt     entry creation time
 * @param startedAt     nullable (chat_run and approval rows have no start column)
 * @param finishedAt    terminal_at / ended_at / finished_at / decided_at
 * @param terminalOutcome chat_run terminal outcome (success/partial/error/...)
 * @param scope         workspace_job scope (run/session/workspace)
 * @param cancelReason  workspace_job cancel reason
 * @param toolCallId    workspace_job / mcp_invocation tool call correlation id
 * @param approvalRequestId mcp_invocation → approval request link
 * @param idempotencyKey    caller idempotency key (internal tier)
 * @param requestId     mcp correlation requestId (internal tier)
 * @param runtimeJobId  Runtime job handle (internal tier)
 */
public record AuditEntryRow(
        String type,
        UUID entryId,
        UUID userId,
        UUID sessionId,
        UUID workspaceId,
        UUID runId,
        String status,
        String summary,
        String source,
        String errorCode,
        Instant createdAt,
        Instant startedAt,
        Instant finishedAt,
        String terminalOutcome,
        String scope,
        String cancelReason,
        UUID toolCallId,
        UUID approvalRequestId,
        String idempotencyKey,
        UUID requestId,
        String runtimeJobId) {}
