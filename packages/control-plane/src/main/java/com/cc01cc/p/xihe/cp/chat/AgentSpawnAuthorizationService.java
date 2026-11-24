package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.policy.SafePolicySummary;
import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.policy.PolicyEffect;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.policy.PolicyVerdict;
import com.cc01cc.p.xihe.cp.policy.ResourceNamespaces;
import com.cc01cc.p.xihe.cp.policy.RequesterAuthority;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry.Face;
import com.cc01cc.p.xihe.cp.repository.OrgUnitMemberRepository;
import com.cc01cc.p.xihe.cp.repository.OrgUnitReadRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.core.JsonProcessingException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.Optional;

/**
 * Applies the normal CP grant and approval gate to spawn.
 *
 * <p>Two entry points share one {@link #gate}: the agent channel ({@link #authorize}, MCP
 * {@code spawn_agent}) evaluates the calling AGENT principal's grant path; the human delegation
 * channel ({@link #authorizeUserSpawn}, PLAN-0655) evaluates the CALLER's user grant path.</p>
 */
@Service
public class AgentSpawnAuthorizationService {
    public static final String APPROVAL_GRANT_HEADER = "X-Xihe-Approval-Request-Id";

    private static final Logger logger = LoggerFactory.getLogger(AgentSpawnAuthorizationService.class);
    /** Policy-side only: projects the target subtree onto the extractor's `target` resource key. */
    private static final ObjectMapper POLICY_BODY_MAPPER = new ObjectMapper();
    private final PolicyEngine policy;
    private final ApprovalService approvals;
    private final SseEmitterManager sseManager;
    private final AuditLogger audit;
    private final DelegationBudgetService delegationBudget;
    /** PLAN-0651 T1.5 (proposal B): emits the canonical {@code action_atom_denied} deny stream. */
    private final RequesterAuthority requesterAuthority;
    private final OrgUnitMemberRepository orgUnitMembers;
    private final OrgUnitReadRepository orgUnits;

    public AgentSpawnAuthorizationService(PolicyEngine policy, ApprovalService approvals,
                                          SseEmitterManager sseManager, AuditLogger audit,
                                          DelegationBudgetService delegationBudget,
                                          RequesterAuthority requesterAuthority) {
        this(policy, approvals, sseManager, audit, delegationBudget, requesterAuthority, null, null);
    }

    @Autowired
    public AgentSpawnAuthorizationService(PolicyEngine policy, ApprovalService approvals,
                                          SseEmitterManager sseManager, AuditLogger audit,
                                          DelegationBudgetService delegationBudget,
                                          RequesterAuthority requesterAuthority,
                                          OrgUnitMemberRepository orgUnitMembers,
                                          OrgUnitReadRepository orgUnits) {
        this.policy = policy;
        this.approvals = approvals;
        this.sseManager = sseManager;
        this.audit = audit;
        this.delegationBudget = delegationBudget;
        this.requesterAuthority = requesterAuthority;
        this.orgUnitMembers = orgUnitMembers;
        this.orgUnits = orgUnits;
    }

    /**
     * Agent-channel spawn (MCP {@code spawn_agent}): the capability check walks the AGENT
     * principal's grant path — the calling agent itself must hold SPAWN_AGENT.
     */
    public GateResult authorize(ChatSubmissionService.SpawnInvocation invocation, String approvalRequestId) {
        return gate(invocation, approvalRequestId, false);
    }

    /**
     * PLAN-0655: the HUMAN delegation gate. Same verdict/ask machinery as {@link #authorize}, but
     * the capability check evaluates the CALLER'S user grant path (workspace role-binding atoms
     * such as AGENT_DELEGATOR's SPAWN_AGENT) — the chosen child principal's cap is intentionally
     * NOT consulted: being delegated TO is not the same as holding the spawn capability.
     */
    public GateResult authorizeUserSpawn(ChatSubmissionService.SpawnInvocation invocation, String approvalRequestId) {
        return gate(invocation, approvalRequestId, true);
    }

    private GateResult gate(ChatSubmissionService.SpawnInvocation invocation, String approvalRequestId,
                            boolean userOnly) {
        String tool = ChatSubmissionService.SPAWN_TOOL_NAME;
        PolicyContext context = policy.loadContext(
                invocation.userId(), invocation.workspaceId(), invocation.parentSessionId());
        List<String> hierarchy = spawnHierarchyResources(invocation);
        String policyBody = spawnPolicyBody(invocation, hierarchy);
        // task-935 / task-961: an explicit target is a delegation to that principal, so only the
        // spawn face is evaluated. No target keeps the old self-spawn meaning (分身) and AND-s
        // `action:clone`. The human delegation arm never asks for clone: human presets do not
        // carry it, and its target is always explicit.
        List<String> extraActionClasses = !userOnly && invocation.targetAgentPrincipalId() == null
                ? List.of(ToolFaceRegistry.ACTION_CLONE)
                : List.of();
        boolean allowed = policy.allowsByGrant(context, tool, policyBody,
                invocation.parentSessionId(), invocation.userId(), invocation.workspaceId(),
                userOnly, hierarchy, extraActionClasses);
        if (!allowed) {
            // PLAN-0651 T1.5 (proposal B): the spawn-face denial joins the canonical
            // action_atom_denied stream. The evaluated subject is the caller's user on the human
            // delegation channel and the calling agent principal on the MCP channel; a path
            // denied here by definition holds SPAWN_AGENT from no evaluation source (B4: atom
            // layer only, never audit_logs).
            requesterAuthority.logActionAtomDenied(ToolFaceRegistry.ACTION_SPAWN_AGENT,
                    uuidOrNull(userOnly ? invocation.userId() : invocation.principalId()),
                    uuidOrNull(invocation.workspaceId()));
            audit.record(invocation.parentSessionId(), tool, "authorization_denied", "actionClass=SPAWN_AGENT");
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "An explicit SPAWN_AGENT grant is required");
        }

        PolicyVerdict verdict = policy.evaluateVerdict(context, tool, policyBody,
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
        String policySummary = SafePolicySummary.buildSnapshot(
                verdict, face, context, reusedSessionGrant ? Boolean.TRUE : null).orElse(null);
        return GateResult.allowed(new ChatSubmissionService.SpawnAuthorization(
                invocation.authorizationBody(), consumeApprovalId, policySummary));
    }

    /**
     * task-935 / D-1935: the spawn hierarchy is a resource on the normal grant axis, never a
     * separate descendant check. The appended resource is the caller agent's own unit subtree
     * ({@code agent-unit:<ltree>}); {@link ResourceNamespaces.Matcher#TREE} then decides coverage
     * exactly like {@code mcp:} does for the gateway channel. Notification tools (TO/CC,
     * {@code team_task_*}) never enter this gate at all.
     *
     * <p>When the call names an explicit target, that target's unit subtree is the resource;
     * otherwise the calling agent's own subtree is. An agent/target with no unit row gets no
     * hierarchy resource (the existing grant path still applies).</p>
     */
    private List<String> spawnHierarchyResources(ChatSubmissionService.SpawnInvocation invocation) {
        if (orgUnitMembers == null || orgUnits == null) {
            return List.of();
        }
        String subject = invocation.targetAgentPrincipalId() != null
                ? invocation.targetAgentPrincipalId()
                : invocation.principalId();
        if (subject == null || subject.isBlank()) {
            return List.of();
        }
        UUID principalId;
        try {
            principalId = UUID.fromString(subject.trim());
        } catch (IllegalArgumentException notUuid) {
            return List.of();
        }
        Optional<UUID> unitId = orgUnitMembers.findUnitOf("agent_principal", principalId);
        if (unitId.isEmpty()) {
            return List.of();
        }
        String path = orgUnits.findUnit(unitId.get())
                .map(OrgUnitReadRepository.UnitRow::path)
                .orElse(null);
        String resource = ResourceNamespaces.agentUnitResource(path);
        return resource == null ? List.of() : List.of(resource);
    }

    /**
     * task-961: when an explicit target is present, tell the policy extractor which object the
     * spawn targets. {@code PolicyResourceExtractor} recognizes the {@code target} key, so the
     * request carries {@code agent-unit:<target subtree>} instead of its resource-less {@code *}
     * fallback. The durable authorization body is untouched (approval fingerprints keep their
     * existing shape); only the evaluation copy is annotated.
     */
    private static String spawnPolicyBody(ChatSubmissionService.SpawnInvocation invocation,
                                          List<String> hierarchy) {
        if (invocation.targetAgentPrincipalId() == null || hierarchy.isEmpty()) {
            return invocation.authorizationBody();
        }
        try {
            com.fasterxml.jackson.databind.node.ObjectNode body =
                    (com.fasterxml.jackson.databind.node.ObjectNode) POLICY_BODY_MAPPER
                            .readTree(invocation.authorizationBody());
            com.fasterxml.jackson.databind.node.ObjectNode arguments =
                    (com.fasterxml.jackson.databind.node.ObjectNode) body.path("params").path("arguments");
            if (arguments == null || arguments.isMissingNode()) {
                return invocation.authorizationBody();
            }
            arguments.put("target", hierarchy.get(0));
            return body.toString();
        } catch (JsonProcessingException | ClassCastException notJson) {
            return invocation.authorizationBody();
        }
    }

    private GateResult createPendingApproval(ChatSubmissionService.SpawnInvocation invocation) {
        String tool = ChatSubmissionService.SPAWN_TOOL_NAME;
        // PLAN-0663 M1: a budget check is a "can this happen" fact, an approval is a "may this
        // happen" decision. Evaluate the budget BEFORE parking an approval request, so a human is
        // never asked to approve a spawn the current snapshot already forbids (and so no modal is
        // left on screen for a spawn that cannot run). This is a read-only precheck — the
        // authoritative, locked check still runs in createSpawnFromParent (TOCTOU).
        try {
            delegationBudget.precheckBeforeApproval(invocation.parentSessionId(), invocation.parentRunId(),
                    invocation.toolCallId());
        } catch (DelegationRefusedException refused) {
            // The refusal never enters createSpawnFromParent's transaction, so this is its single
            // durable home (INV-7). Detail carries phase=precheck and no prompt/arguments.
            audit.recordDurableChange(invocation.userId(), invocation.workspaceId(), "agent_spawn_refused",
                    "chat_session", invocation.parentSessionId(), refused.auditDetail());
            audit.record(invocation.parentSessionId(), tool, "tool_error", refused.getCode());
            throw refused;
        }
        ApprovalService.GateApprovalOutcome outcome;
        try {
            outcome = approvals.recordGatePending(invocation.parentSessionId(), invocation.parentRunId(),
                    invocation.userId(), invocation.workspaceId(), tool, invocation.authorizationBody(),
                    Instant.now().plusSeconds(ApprovalService.DEFAULT_GATE_TTL_SECONDS))
                    .orElse(null);
        } catch (RuntimeException e) {
            logger.warn("[LIFECYCLE] service=cp event=spawn_approval_persist_failed parentRunId={} invocationId={} failureType={}",
                    invocation.parentRunId(), invocation.mcpInvocationId(), e.getClass().getSimpleName(), e);
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

    /** uuid or {@code null} (logged as {@code -} in the deny stream); never throws. */
    private static java.util.UUID uuidOrNull(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return java.util.UUID.fromString(value.trim());
        } catch (IllegalArgumentException e) {
            return null;
        }
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
