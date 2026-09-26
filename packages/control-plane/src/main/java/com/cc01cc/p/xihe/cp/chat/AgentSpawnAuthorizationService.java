package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.operation.OperationPolicySummary;
import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.policy.PolicyEffect;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.policy.PolicyVerdict;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry.Face;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.Map;

/** Applies the normal CP grant and approval gate to the non-MCP spawn route. */
@Service
public class AgentSpawnAuthorizationService {
    public static final String APPROVAL_GRANT_HEADER = "X-Xihe-Approval-Request-Id";

    private static final Logger logger = LoggerFactory.getLogger(AgentSpawnAuthorizationService.class);
    private final PolicyEngine policy;
    private final ApprovalService approvals;
    private final SseEmitterManager sseManager;
    private final AuditLogger audit;

    public AgentSpawnAuthorizationService(PolicyEngine policy, ApprovalService approvals,
                                          SseEmitterManager sseManager, AuditLogger audit) {
        this.policy = policy;
        this.approvals = approvals;
        this.sseManager = sseManager;
        this.audit = audit;
    }

    public GateResult authorize(ChatSubmissionService.SpawnInvocation invocation, String approvalRequestId) {
        String tool = ChatSubmissionService.SPAWN_TOOL_NAME;
        PolicyContext context = policy.loadContext(
                invocation.userId(), invocation.workspaceId(), invocation.parentSessionId());
        if (!policy.allowsByGrant(context, tool, invocation.authorizationBody(), invocation.parentSessionId(),
                invocation.userId(), invocation.workspaceId(), false)) {
            audit.record(invocation.parentSessionId(), tool, "authorization_denied", "actionClass=SPAWN_AGENT");
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "An explicit SPAWN_AGENT grant is required");
        }

        PolicyVerdict verdict = policy.evaluateVerdict(context, tool, invocation.authorizationBody(),
                invocation.parentSessionId(), null, invocation.userId(), invocation.workspaceId());
        if (verdict.effect() == PolicyEffect.DENY) {
            audit.record(invocation.parentSessionId(), tool, "authorization_denied", "policy=deny");
            throw new CpApiException(HttpStatus.FORBIDDEN, "SPAWN_AGENT_POLICY_DENIED",
                    "Spawn is denied by the current policy");
        }

        boolean reusedSessionGrant = false;
        String consumeApprovalId = null;
        if (verdict.effect() == PolicyEffect.ASK) {
            if (approvalRequestId != null && !approvalRequestId.isBlank()) {
                consumeApprovalId = approvalRequestId;
            } else if (approvals.tryReuseSessionGrant(invocation.parentSessionId(), invocation.workspaceId(),
                    tool, invocation.authorizationBody())) {
                reusedSessionGrant = true;
            } else {
                return createPendingApproval(invocation);
            }
        }

        Face face = policy.faceOf(context, tool);
        String policySummary = OperationPolicySummary.buildSnapshot(
                verdict, face, context, reusedSessionGrant ? Boolean.TRUE : null).orElse(null);
        return GateResult.allowed(new ChatSubmissionService.SpawnAuthorization(
                invocation.authorizationBody(), consumeApprovalId, policySummary));
    }

    private GateResult createPendingApproval(ChatSubmissionService.SpawnInvocation invocation) {
        String tool = ChatSubmissionService.SPAWN_TOOL_NAME;
        ApprovalService.GateApprovalOutcome outcome;
        try {
            outcome = approvals.recordGatePending(invocation.parentSessionId(), invocation.parentRunId(),
                    invocation.userId(), invocation.workspaceId(), tool, invocation.authorizationBody(),
                    Instant.now().plusSeconds(ApprovalService.DEFAULT_GATE_TTL_SECONDS))
                    .orElse(null);
        } catch (RuntimeException e) {
            logger.warn("[LIFECYCLE] service=cp event=spawn_approval_persist_failed parentRunId={} itemId={} failureType={}",
                    invocation.parentRunId(), invocation.operationItemId(), e.getClass().getSimpleName(), e);
            throw new CpApiException(HttpStatus.SERVICE_UNAVAILABLE, "APPROVAL_UNAVAILABLE",
                    "Unable to persist spawn approval request");
        }
        if (outcome == null) {
            throw new CpApiException(HttpStatus.SERVICE_UNAVAILABLE, "APPROVAL_UNAVAILABLE",
                    "Unable to persist spawn approval request");
        }
        if (!outcome.parked()) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "APPROVAL_REJECTED",
                    "Spawn approval is already rejected");
        }

        ChatApproval approval = outcome.row();
        String approvalId = approval.getRequestId().toString();
        try {
            sseManager.send(invocation.parentSessionId(), "tool_exec_approval_required", Map.of(
                    "tool", tool,
                    "approvalRequestId", approvalId,
                    "expiresAt", approval.getExpiresAt().toString()));
            sseManager.send(invocation.parentSessionId(), "approval_request", approvals.livePayload(approval));
        } catch (RuntimeException e) {
            logger.warn("[LIFECYCLE] service=cp event=spawn_approval_sse_failed parentRunId={} approvalRequestId={} failureType={}",
                    invocation.parentRunId(), approvalId, e.getClass().getSimpleName(), e);
        }
        return GateResult.pending(approvalId, approval.getExpiresAt());
    }

    public record GateResult(boolean allowed, ChatSubmissionService.SpawnAuthorization authorization,
                             String approvalRequestId, Instant expiresAt) {
        static GateResult allowed(ChatSubmissionService.SpawnAuthorization authorization) {
            return new GateResult(true, authorization, null, null);
        }

        static GateResult pending(String requestId, Instant expiresAt) {
            return new GateResult(false, null, requestId, expiresAt);
        }
    }
}
