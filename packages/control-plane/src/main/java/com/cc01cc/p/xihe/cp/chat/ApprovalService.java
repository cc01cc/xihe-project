package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.policy.LayeredPolicyResolver;
import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.policy.PolicyRevision;
import com.cc01cc.p.xihe.cp.policy.ReusePolicy;
import com.cc01cc.p.xihe.cp.policy.SessionApprovalMode;
import com.cc01cc.p.xihe.cp.policy.SessionPolicyState;
import com.cc01cc.p.xihe.cp.logging.LogRedactor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import java.time.temporal.ChronoUnit;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

@Service
public class ApprovalService {

    private static final Logger logger = LoggerFactory.getLogger(ApprovalService.class);
    private static final List<String> REPLAYABLE_STATES = List.of("pending", "dispatching", "dispatch_unknown");
    private static final List<String> ACTIONABLE_SUMMARY_STATES = List.of("pending", "dispatch_unknown");
    private static final int MAX_ACTION_LENGTH = 512;
    private static final int MAX_DETAILS_LENGTH = 512;
    private static final int MAX_ARGUMENTS_HASH_LENGTH = 96;
    /** One decision may release/reject at most this many session peers (serial Agent HTTP bound). */
    private static final int MAX_PROPAGATION_PER_DECISION = 20;
    // PLAN-292 M1: canonical form must byte-match the Agent's
    // json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")).
    private static final String HASH_ALGORITHM = "SHA-256";

    private final ChatApprovalRepository approvalRepository;
    private final ChatRunRepository chatRunRepository;
    private final ApprovalAgentClient agentClient;
    private final ObjectMapper objectMapper;
    private final ObjectMapper canonicalMapper;
    private final OperationService operationService;
    private final ApprovalGrantWriter grantWriter;
    private final AuditLogger audit;
    private final ApprovalPolicySummary policySummary;
    private final ApprovalPendingStore pendingStore;
    private final SessionPolicyState sessionPolicyState;
    private final SessionApprovalMode sessionApprovalMode;
    private final PolicyRevision policyRevision;
    private final WorkspaceRepository workspaceRepository;
    private final AnswererChain answererChain;

    public ApprovalService(ChatApprovalRepository approvalRepository,
                           ChatRunRepository chatRunRepository,
                           ApprovalAgentClient agentClient,
                           ObjectMapper objectMapper,
                           OperationService operationService,
                           ApprovalGrantWriter grantWriter,
                           AuditLogger audit,
                           ApprovalPolicySummary policySummary,
                           ApprovalPendingStore pendingStore,
                           SessionPolicyState sessionPolicyState,
                           SessionApprovalMode sessionApprovalMode,
                           PolicyRevision policyRevision,
                           WorkspaceRepository workspaceRepository,
                           AnswererChain answererChain) {
        this.approvalRepository = approvalRepository;
        this.chatRunRepository = chatRunRepository;
        this.agentClient = agentClient;
        this.objectMapper = objectMapper;
        this.canonicalMapper = objectMapper.copy()
                .configure(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS, true);
        this.operationService = operationService;
        this.grantWriter = grantWriter;
        this.audit = audit;
        this.policySummary = policySummary;
        this.pendingStore = pendingStore;
        this.sessionPolicyState = sessionPolicyState;
        this.sessionApprovalMode = sessionApprovalMode;
        this.policyRevision = policyRevision;
        this.workspaceRepository = workspaceRepository;
        this.answererChain = answererChain;
    }

    @Transactional
    public ChatApproval recordPending(Map<?, ?> payload, String expectedSessionId, String expectedRunId,
                                      String userId, String workspaceId) {
        String requestId = required(payload, "requestId");
        String runId = optional(payload, "runId", expectedRunId);
        String sessionId = optional(payload, "sessionId", expectedSessionId);
        if (!expectedRunId.equals(runId) || !expectedSessionId.equals(sessionId)) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_EVENT_ID_MISMATCH",
                    "Agent approval event does not match the active chat run");
        }
        ChatRun run = chatRunRepository.findById(UUID.fromString(runId)).orElseThrow(() -> new CpApiException(
                HttpStatus.BAD_GATEWAY, "AGENT_EVENT_ID_MISMATCH", "Approval event references an unknown chat run"));
        if (!userId.equals(run.getUserId()) || !workspaceId.equals(run.getWorkspaceId())
                || !sessionId.equals(run.getSessionId())) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_EVENT_ID_MISMATCH",
                    "Agent approval event ownership does not match the active chat run");
        }
        String action = required(payload, "action");
        String details = optional(payload, "details", "");
        String argumentsHash = optional(payload, "argumentsHash", null);
        if (action.length() > MAX_ACTION_LENGTH || details.length() > MAX_DETAILS_LENGTH
                || (argumentsHash != null && argumentsHash.length() > MAX_ARGUMENTS_HASH_LENGTH)) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_EVENT_INVALID",
                    "Approval request payload exceeds the size limit");
        }
        Instant expiresAt = parseExpiresAt(payload.get("expiresAt"));
        String snapshotId = optional(payload, "snapshotId", null);
        String policyClass = optional(payload, "policyClass", "unknown");
        ChatApproval existing = approvalRepository.findById(UUID.fromString(requestId)).orElse(null);
        if (existing != null) {
            if (!runId.equals(existing.getRunId()) || !sessionId.equals(existing.getSessionId())
                    || !userId.equals(existing.getUserId()) || !workspaceId.equals(existing.getWorkspaceId())) {
                throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_EVENT_ID_MISMATCH",
                        "Approval request identity changed for an existing requestId");
            }
            recordLedgerApprovalItem(payload, runId, requestId);
            return existing;
        }
        String tool = optional(payload, "tool", "request_approval");
        ChatApproval approval = new ChatApproval(
                requestId,
                runId,
                sessionId,
                userId,
                workspaceId,
                tool,
                action,
                details,
                "pending",
                expiresAt,
                snapshotId,
                policyClass,
                argumentsHash);
        return applyAnswererChain(approval, payload, runId, requestId);
    }

    /**
     * T1.9 answerer seam (spec §3 ⑦/⑧, §12): every newly created ask goes through the chain
     * before it can become a durable row. {@code DEFER} keeps the human path — a pending row the
     * user can answer. Every other resolution (an all-UNAVAILABLE chain, an answerer DENY, or an
     * ALLOW this batch cannot dispatch) is recorded as an immediate fail-closed reject instead of
     * parking a pending row nobody can answer (decision #18).
     *
     * <p>Both creation paths converge here: the Agent-relay {@code recordPending} and the
     * gate-created {@code recordGatePending} (which delegates to it). Row identity, decision state
     * machine and audit semantics stay untouched; the chain only chooses between the existing
     * pending state and the existing rejected terminal state.</p>
     */
    private ChatApproval applyAnswererChain(ChatApproval approval, Map<?, ?> payload, String runId,
                                            String requestId) {
        AnswererChain.Resolution resolution = answererChain.resolve(new ApprovalAnswerer.Ask(
                approval.getSessionId(), approval.getTool(), approval.getAction(), approval.getDetails()));
        if (resolution.outcome() == ApprovalAnswerer.Outcome.DEFER) {
            return storePending(approval, payload, runId, requestId, resolution);
        }
        return storeAnswererRejected(approval, payload, runId, requestId, resolution);
    }

    private ChatApproval storePending(ChatApproval approval, Map<?, ?> payload, String runId,
                                      String requestId, AnswererChain.Resolution resolution) {
        ChatApproval saved = pendingStore.save(approval);
        String storedPolicy = null;
        try {
            storedPolicy = pendingStore.capturePolicySummary(
                    approval.getRequestId(), approval.getTool(), approval.getSessionId(),
                    approval.getUserId(), approval.getWorkspaceId());
        } catch (RuntimeException e) {
            logger.warn("[POLICY] approval_summary_failed failureType={}", e.getClass().getName());
        }
        approval.setPolicySummary(storedPolicy);
        if (saved != null) {
            saved.setPolicySummary(storedPolicy);
        }
        recordLedgerApprovalItem(payload, runId, requestId);
        recordAnswererAudit(approval, resolution, null);
        logger.info("[LIFECYCLE] service=cp event=chat_approval_pending requestId={} sessionId={} runId={} answerer={}",
                requestId, approval.getSessionId(), runId, resolution.answerer());
        return saved == null ? approval : saved;
    }

    /**
     * Immediate fail-closed reject of a chain resolution that cannot keep waiting. The row is
     * terminal from creation ({@code rejected} + {@code decisionKind=reject}) so no replay,
     * summary or decision path can ever surface it as actionable, and the operation ledger item
     * is resolved as rejected instead of dangling.
     *
     * <p>An {@code ALLOW} is intentionally not honoured yet: auto-allow needs its Agent dispatch
     * wiring, which is not part of this seam. Until that exists it fails closed loudly rather
     * than parking the request.</p>
     */
    private ChatApproval storeAnswererRejected(ChatApproval approval, Map<?, ?> payload, String runId,
                                               String requestId, AnswererChain.Resolution resolution) {
        approval.setState("rejected");
        approval.setApproved(false);
        approval.setDecisionKind(ApprovalDecision.Kind.REJECT.wireName());
        approval.setDecidedAt(Instant.now());
        ChatApproval saved = pendingStore.save(approval);
        recordLedgerApprovalItem(payload, runId, requestId);
        operationService.resolveApprovalItem(requestId, false);
        recordAnswererAudit(approval, resolution, "reject");
        notifyAnswererRejection(requestId, runId, resolution);
        if (resolution.outcome() == ApprovalAnswerer.Outcome.ALLOW) {
            logger.error("[LIFECYCLE] service=cp event=approval_answerer_allow_unwired requestId={}"
                            + " sessionId={} runId={} answerer={}",
                    requestId, approval.getSessionId(), runId, resolution.answerer());
        }
        logger.info("[LIFECYCLE] service=cp event=chat_approval_answerer_rejected requestId={}"
                        + " sessionId={} runId={} answerer={} outcome={}",
                requestId, approval.getSessionId(), runId, resolution.answerer(),
                resolution.outcome().name().toLowerCase(Locale.ROOT));
        return saved == null ? approval : saved;
    }

    /** Audit trail of the ask resolution: {@code answerer=user|auto_review|none} (spec §15). */
    private void recordAnswererAudit(ChatApproval approval, AnswererChain.Resolution resolution,
                                     String decision) {
        String detail = "answerer=" + resolution.answerer()
                + " outcome=" + resolution.outcome().name().toLowerCase(Locale.ROOT);
        if (decision != null) {
            detail = detail + " decision=" + decision;
        }
        audit.record(approval.getSessionId(), approval.getTool(), "approval_answerer", detail);
    }

    /**
     * Best-effort push of an immediate answerer rejection to a blocked Agent waiter. The relay
     * path registers its waiter keyed by this requestId, so without the notification the Agent
     * would block until TTL and report "expired". A failed notification must never corrupt the
     * terminal row: the rejection stays durable and only the lifecycle log records the failure.
     */
    private void notifyAnswererRejection(String requestId, String runId,
                                         AnswererChain.Resolution resolution) {
        try {
            agentClient.respond(requestId, false, ApprovalDecision.Kind.REJECT.wireName(),
                    resolution.reason());
        } catch (RuntimeException e) {
            logger.warn("[LIFECYCLE] service=cp event=approval_answerer_respond_failed requestId={}"
                            + " runId={} answerer={} failureType={}",
                    requestId, runId, resolution.answerer(), e.getClass().getName(), e);
        }
    }

    @Transactional(readOnly = true)
    public List<Map<String, Object>> replayPending(String sessionId, String userId, String workspaceId) {
        return approvalRepository
                .findBySessionIdAndUserIdAndWorkspaceIdAndStateInOrderByCreatedAtAsc(sessionId, userId, workspaceId, REPLAYABLE_STATES)
                .stream()
                .filter(approval -> approval.getExpiresAt().isAfter(Instant.now()))
                .map(approval -> payloadFor(approval, true))
                .toList();
    }

    // PLAN-292 M3 (C2): run-scoped recovery view for GET /chat/runs/{runId} —
    // lets a refreshed or reconnected client re-render the pending approval
    // even when the SSE replay path is unavailable. Same fail-closed shape as
    // replayPending: expired rows are dropped, decisions are never fabricated.
    @Transactional(readOnly = true)
    public List<Map<String, Object>> findActiveForRun(String runId, String userId, String workspaceId) {
        return approvalRepository
                .findByRunIdAndStateIn(runId, REPLAYABLE_STATES)
                .stream()
                .filter(approval -> approval.getUserId().equals(userId)
                        && approval.getWorkspaceId().equals(workspaceId)
                        && approval.getExpiresAt().isAfter(Instant.now()))
                .map(approval -> payloadFor(approval, true))
                .toList();
    }

    /**
     * PLAN-0328 M1 (spec §14, decision #23/#25): one decision entry point for the three grant tiers,
     * rejection with feedback, and the session propagation semantics.
     *
     * <p>Order of operations: validate/derive the grant → claim the row → materialize the rule
     * (session L4 or persistent L2/L3) → notify the Agent → mark decided → propagate
     * (allow → re-solve pending; reject → same-session reject). A rule-write failure leaves the row
     * in {@code dispatch_unknown} so an explicit retry can complete it — no silent half-grants.</p>
     */
    public Map<String, Object> decide(String requestId, String userId, String workspaceId, ApprovalDecision decision) {
        if (decision == null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "decision is required");
        }
        ChatApproval approval = approvalRepository.findById(parseRequestId(requestId))
                .filter(row -> userId.equals(row.getUserId()) && workspaceId.equals(row.getWorkspaceId()))
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "APPROVAL_NOT_FOUND", "Approval request not found"));
        boolean approved = decision.kind().isApproved();
        Instant now = Instant.now();
        if (approval.getExpiresAt().isBefore(now) && !isTerminal(approval.getState())) {
            int marked = approvalRepository.markExpired(approval.getRequestId(), now);
            if (marked == 0) {
                throw new CpApiException(HttpStatus.CONFLICT, "APPROVAL_DECISION_IN_PROGRESS",
                        "Approval decision is already being dispatched");
            }
            throw new CpApiException(HttpStatus.GONE, "APPROVAL_EXPIRED", "Approval request expired");
        }
        if (isTerminal(approval.getState())) {
            return idempotentTerminal(approval, decision, approved);
        }
        // PLAN-290 M0.4 dispatch_unknown reconciliation: a lost dispatch outcome is
        // retryable by an explicit user decision (no automatic replay). Re-entering
        // dispatching from dispatch_unknown is an atomic conditional update.
        if (!"pending".equals(approval.getState()) && !"dispatch_unknown".equals(approval.getState())) {
            throw new CpApiException(HttpStatus.CONFLICT, "APPROVAL_DECISION_IN_PROGRESS",
                    "Approval decision is already being dispatched");
        }
        // Derive and validate the grant before claiming the row: an invalid decision
        // (unclassified tool, bad layer) must leave the request pending and retryable.
        ApprovalGrantWriter.RulePlan plan = decision.kind().grantsRule()
                ? grantWriter.prepare(decision, approval.getTool(), userId, workspaceId)
                : null;
        String modeAtGrant = effectiveModeAtGrant(approval);
        long policyRevisionAtGrant = policyRevision.current();
        Integer sandboxGeneration = currentSandboxGeneration(workspaceId);
        String reuseScope = reuseScopeOf(decision);
        int claimed = approvalRepository.markDispatching(
                approval.getRequestId(), approved, modeAtGrant, reuseScope,
                policyRevisionAtGrant, sandboxGeneration, now);
        if (claimed == 0) {
            throw new CpApiException(HttpStatus.CONFLICT, "APPROVAL_DECISION_IN_PROGRESS",
                    "Approval decision is already being dispatched");
        }
        approval.setModeAtGrant(modeAtGrant);
        approval.setReuseScope(reuseScope);
        approval.setPolicyRevision(policyRevisionAtGrant);
        approval.setSandboxGeneration(sandboxGeneration);
        try {
            if (plan != null) {
                grantWriter.commit(plan, approval.getSessionId(), userId, workspaceId,
                        new ApprovalGrantWriter.GrantContext(approval.getTool(), approval.getArgumentsHash(),
                                modeAtGrant, policyRevisionAtGrant, sandboxGeneration));
            }
        } catch (CpApiException e) {
            // 领域错误（如 workspace OWNER 校验 403）不是写入故障：行标记 dispatch_unknown 可重试，
            // 但客户端必须看到原始状态码而不是被包装成 500。
            approvalRepository.markDispatchUnknown(approval.getRequestId(), e.getCode(), Instant.now());
            logger.error("[LIFECYCLE] service=cp event=approval_rule_write_denied requestId={} code={}",
                    requestId, e.getCode(), e);
            throw e;
        } catch (RuntimeException e) {
            int unknown = approvalRepository.markDispatchUnknown(approval.getRequestId(),
                    "POLICY_RULE_WRITE_FAILED", Instant.now());
            logger.error("[LIFECYCLE] service=cp event=approval_rule_write_failed requestId={} marked={}",
                    requestId, unknown, e);
            throw new CpApiException(HttpStatus.INTERNAL_SERVER_ERROR, "POLICY_RULE_WRITE_FAILED",
                    "Approval grant could not be materialized as a policy rule", e);
        }
        try {
            agentClient.respond(requestId, approved, decision.kind().wireName(), decision.feedback());
        } catch (CpApiException e) {
            int marked = approvalRepository.markDispatchUnknown(approval.getRequestId(), e.getCode(), Instant.now());
            if (marked == 0) {
                logger.warn("[LIFECYCLE] service=cp event=chat_approval_dispatch_unknown_skipped requestId={} state was no longer dispatching", requestId);
            }
            throw e;
        }
        int decided = approvalRepository.markDecided(approval.getRequestId(),
                approved ? "approved" : "rejected", decision.kind().wireName(), Instant.now());
        if (decided == 0) {
            logger.error("[LIFECYCLE] service=cp event=chat_approval_decide_transition_lost requestId={} expected dispatching state", requestId);
        }
        operationService.resolveApprovalItem(requestId, approved);
        audit.record(approval.getSessionId(), approval.getTool(), "approval_decision",
                decision.kind().wireName() + (decision.feedback() == null ? "" : " feedback=" + safeFeedback(decision.feedback())));
        int propagated = propagate(approval, decision);
        return decisionResponse(requestId, "accepted", approved, decision.kind().wireName(), propagated,
                plan, modeAtGrant);
    }

    /**
     * Terminal rows are idempotent only for the exact recorded decision kind (V16). Legacy rows
     * without a recorded kind keep the boolean comparison; anything else fails closed with 409.
     */
    private Map<String, Object> idempotentTerminal(ChatApproval approval, ApprovalDecision decision,
                                                   boolean approved) {
        String requestId = approval.getRequestId().toString();
        String recordedKind = approval.getDecisionKind();
        if (recordedKind != null) {
            if (!recordedKind.equals(decision.kind().wireName())) {
                throw new CpApiException(HttpStatus.CONFLICT, "APPROVAL_DECISION_CONFLICT",
                        "Approval request already decided with a different decision kind");
            }
            return decisionResponse(requestId, "accepted", approved, recordedKind, 0, null,
                    approval.getModeAtGrant());
        }
        if (approval.getApproved() != null && approval.getApproved() == approved) {
            return decisionResponse(requestId, "accepted", approved, decision.kind().wireName(), 0, null,
                    approval.getModeAtGrant());
        }
        throw new CpApiException(HttpStatus.CONFLICT, "APPROVAL_DECISION_CONFLICT",
                "Approval request already has a different decision");
    }

    /**
     * Session propagation (decision #23): an allow that materialized a rule re-solves the other
     * pending requests of the session and releases the ones the new ruleset now allows; a reject
     * fails the remaining pending requests of the session (同会话连坐). Best-effort per row with
     * explicit logging — the primary decision above already succeeded.
     */
    private int propagate(ChatApproval decided, ApprovalDecision decision) {
        boolean approved = decision.kind().isApproved();
        if (approved && !decision.kind().grantsRule()) {
            // `once` grants one invocation only: it must not release anything else.
            return 0;
        }
        List<ChatApproval> pending = approvalRepository
                .findBySessionIdAndUserIdAndWorkspaceIdAndStateInOrderByCreatedAtAsc(
                        decided.getSessionId(), decided.getUserId(), decided.getWorkspaceId(), List.of("pending"));
        // One context load for the whole sweep instead of one per pending row (V16 review fix).
        PolicyContext context = approved
                ? grantWriter.loadContext(decided.getUserId(), decided.getWorkspaceId(), decided.getSessionId())
                : null;
        int affected = 0;
        int attempted = 0;
        int skipped = 0;
        for (ChatApproval row : pending) {
            if (row.getExpiresAt().isBefore(Instant.now())) {
                continue;
            }
            if (approved && !grantWriter.wouldAllow(row.getTool(), context, row.getSessionId())) {
                continue;
            }
            if (attempted >= MAX_PROPAGATION_PER_DECISION) {
                skipped++;
                continue;
            }
            attempted++;
            if (dispatchPropagated(row, approved)) {
                affected++;
            }
        }
        if (skipped > 0) {
            logger.warn("[LIFECYCLE] service=cp event=approval_propagation_capped sessionId={} skipped={} limit={}",
                    decided.getSessionId(), skipped, MAX_PROPAGATION_PER_DECISION);
        }
        return affected;
    }

    private boolean dispatchPropagated(ChatApproval row, boolean approved) {
        String requestId = row.getRequestId().toString();
        String kind = approved ? "propagated_allow" : "propagated_reject";
        String modeAtGrant = effectiveModeAtGrant(row);
        // A propagated release is still a one-shot grant: it must be consumable exactly once.
        int claimed = approvalRepository.markDispatching(
                row.getRequestId(), approved, modeAtGrant, approved ? "once" : null,
                policyRevision.current(), currentSandboxGeneration(row.getWorkspaceId()), Instant.now());
        if (claimed == 0) {
            return false;
        }
        row.setModeAtGrant(modeAtGrant);
        try {
            agentClient.respond(requestId, approved, kind, null);
        } catch (CpApiException e) {
            approvalRepository.markDispatchUnknown(row.getRequestId(), e.getCode(), Instant.now());
            logger.warn("[LIFECYCLE] service=cp event=approval_propagation_dispatch_unknown requestId={} code={}",
                    requestId, e.getCode());
            return false;
        }
        approvalRepository.markDecided(row.getRequestId(), approved ? "approved" : "rejected", kind, Instant.now());
        operationService.resolveApprovalItem(requestId, approved);
        audit.record(row.getSessionId(), row.getTool(),
                approved ? "approval_propagated_allow" : "approval_propagated_reject", requestId);
        logger.info("[LIFECYCLE] service=cp event=approval_propagated requestId={} approved={} sessionId={}",
                requestId, approved, row.getSessionId());
        return true;
    }

    /** Cross-session indicator: counts live actionable approval/retry states only. */
    @Transactional(readOnly = true)
    public List<Map<String, Object>> pendingSummaries(String userId, String workspaceId) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        Map<String, Instant> oldest = new LinkedHashMap<>();
        Instant now = Instant.now();
        for (ChatApproval row
                : approvalRepository.findByUserIdAndWorkspaceIdAndStateInAndExpiresAtAfterOrderByCreatedAtAsc(
                        userId, workspaceId, ACTIONABLE_SUMMARY_STATES, now)) {
            if (row.getExpiresAt().isBefore(now)) {
                continue;
            }
            counts.merge(row.getSessionId(), 1, Integer::sum);
            oldest.merge(row.getSessionId(), row.getCreatedAt(),
                    (left, right) -> left.isBefore(right) ? left : right);
        }
        List<Map<String, Object>> summaries = new java.util.ArrayList<>();
        for (Map.Entry<String, Integer> entry : counts.entrySet()) {
            Map<String, Object> summary = new LinkedHashMap<>();
            summary.put("sessionId", entry.getKey());
            summary.put("workspaceId", workspaceId);
            summary.put("count", entry.getValue());
            summary.put("oldestRequestedAt", oldest.get(entry.getKey()));
            summaries.add(summary);
        }
        return summaries;
    }

    /** Feedback is user-authored text: keep it bounded and redacted in the audit trail. */
    private static String safeFeedback(String feedback) {
        String redacted = LogRedactor.redact(feedback);
        return redacted.length() <= 200 ? redacted : redacted.substring(0, 200) + "…";
    }

    private void recordLedgerApprovalItem(Map<?, ?> payload, String runId, String requestId) {
        UUID operationId = operationService.findOperationIdByRunId(runId);
        if (operationId == null) {
            return;
        }
        operationService.appendApprovalItem(
                operationId,
                requestId,
                optional(payload, "tool", "request_approval"),
                safeLedgerPreview(payload));
    }

    private String safeLedgerPreview(Map<?, ?> payload) {
        try {
            String redacted = LogRedactor.redact(objectMapper.writeValueAsString(payload));
            return redacted.length() <= 4096 ? redacted : redacted.substring(0, 4096);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=approval_ledger_preview_failed");
            return "{\"redacted\":true}";
        }
    }

    /**
     * Atomically consumes a policy approval for one exact MCP tool invocation.
     * The approval row remains terminally approved; grant_consumed_at records
     * whether this particular downstream dispatch already used it.
     *
     * <p>T1.7 consume checks are all fail-closed: expiry, mode rank (a grant issued under a
     * stricter mode never survives a looser-to-stricter switch), durable policy revision and
     * sandbox generation. Legacy rows without the V20 columns are rejected. The audit record
     * shares the consume success boundary (R7).</p>
     */
    @Transactional
    public boolean consumeApprovedGrant(String requestId, String userId, String workspaceId,
                                        String sessionId, String tool, String mcpBody) {
        UUID requestUuid;
        try {
            requestUuid = UUID.fromString(requestId);
        } catch (IllegalArgumentException e) {
            return false;
        }
        ChatApproval approval = approvalRepository.findById(requestUuid)
                .filter(row -> userId.equals(row.getUserId())
                        && workspaceId.equals(row.getWorkspaceId())
                        && sessionId.equals(row.getSessionId())
                        && tool.equals(row.getTool())
                        && "approved".equals(row.getState())
                        && row.getGrantConsumedAt() == null)
                .orElse(null);
        if (approval == null || !matchesInvocation(approval, tool, mcpBody)) {
            return false;
        }
        if (!consumeStillValid(approval, sessionId, workspaceId)) {
            return false;
        }
        int consumed = approvalRepository.consumeApprovedGrant(
                requestUuid, userId, workspaceId, sessionId, tool, Instant.now());
        if (consumed == 1) {
            audit.record(sessionId, tool, "approval_grant_consumed", requestId);
            logger.info("[LIFECYCLE] service=cp event=approval_grant_consumed requestId={} sessionId={} tool={}",
                    requestId, sessionId, tool);
            return true;
        }
        logger.info("[LIFECYCLE] service=cp event=approval_grant_replay_rejected requestId={} sessionId={} tool={}",
                requestId, sessionId, tool);
        return false;
    }

    /** All T1.7 consume-time invalidations; a single failure rejects the grant. */
    private boolean consumeStillValid(ChatApproval approval, String sessionId, String workspaceId) {
        Instant now = Instant.now();
        if (approval.getExpiresAt() == null || !approval.getExpiresAt().isAfter(now)) {
            return rejectGrant(approval, "expired");
        }
        Long rowRevision = approval.getPolicyRevision();
        if (rowRevision == null || rowRevision != policyRevision.current()) {
            return rejectGrant(approval, "policy_revision");
        }
        Integer rowGeneration = approval.getSandboxGeneration();
        Integer currentGeneration = currentSandboxGeneration(workspaceId);
        if (rowGeneration == null || currentGeneration == null || !rowGeneration.equals(currentGeneration)) {
            return rejectGrant(approval, "sandbox_generation");
        }
        if (ReusePolicy.modeRank(approval.getModeAtGrant())
                < ReusePolicy.modeRank(currentSessionMode(sessionId))) {
            return rejectGrant(approval, "mode_rank");
        }
        return true;
    }

    private boolean rejectGrant(ChatApproval approval, String reason) {
        logger.info("[LIFECYCLE] service=cp event=approval_grant_rejected requestId={} reason={}",
                approval.getRequestId(), reason);
        return false;
    }

    /**
     * T1.7 session-tier reuse: an exact (sessionId, tool, canonical arguments hash) grant whose
     * mode rank, policy revision and sandbox generation still hold dispatches without a pending
     * approval. A hit is audited ({@code grant_reused scope=session}); every miss stays fail-closed.
     */
    @Transactional(readOnly = true)
    public boolean tryReuseSessionGrant(String sessionId, String workspaceId, String tool, String mcpBody) {
        String argumentsHash = canonicalInvocationHash(tool, mcpBody);
        if (argumentsHash == null) {
            return false;
        }
        SessionPolicyState.Grant grant = sessionPolicyState.grantOf(sessionId, tool, argumentsHash)
                .orElse(null);
        if (grant == null) {
            return false;
        }
        if (grant.policyRevision() != policyRevision.current()) {
            return rejectGrant(grant, "policy_revision");
        }
        Integer currentGeneration = currentSandboxGeneration(workspaceId);
        if (currentGeneration == null || grant.sandboxGeneration() != currentGeneration) {
            return rejectGrant(grant, "sandbox_generation");
        }
        if (ReusePolicy.modeRank(grant.modeAtGrant()) < ReusePolicy.modeRank(currentSessionMode(sessionId))) {
            return rejectGrant(grant, "mode_rank");
        }
        audit.record(sessionId, tool, "grant_reused", "scope=session");
        logger.info("[LIFECYCLE] service=cp event=grant_reused scope=session sessionId={} tool={}",
                sessionId, tool);
        return true;
    }

    private boolean rejectGrant(SessionPolicyState.Grant grant, String reason) {
        logger.info("[LIFECYCLE] service=cp event=grant_reuse_rejected tool={} reason={}", grant.tool(), reason);
        return false;
    }

    /**
     * T1.7 gate-side idempotency: the live non-terminal row for one exact invocation, if any.
     * The gate must reuse this row instead of archiving a duplicate approval request.
     */
    @Transactional(readOnly = true)
    public Optional<ChatApproval> findLivePendingForInvocation(String sessionId, String tool,
                                                               String argumentsHash) {
        String normalized = ReusePolicy.normalizeArgumentsHash(argumentsHash);
        if (sessionId == null || sessionId.isBlank() || tool == null || tool.isBlank() || normalized == null) {
            return Optional.empty();
        }
        Instant now = Instant.now();
        return approvalRepository
                .findBySessionIdAndToolAndArgumentsHashAndStateInOrderByCreatedAtAsc(
                        sessionId, tool, normalized, REPLAYABLE_STATES)
                .stream()
                .filter(row -> row.getExpiresAt() != null && row.getExpiresAt().isAfter(now))
                .findFirst();
    }

    /**
     * Gate-side creation outcome (T1.9): {@link #parked()} marks a live row that is waiting for an
     * external answer (push a card / register the Agent waiter); a non-parked outcome is a
     * terminal answerer rejection — the gate must answer with a normal fail-closed denial instead
     * of an approval signal, because no card/waiter can ever resolve it.
     */
    public record GateApprovalOutcome(ChatApproval row, boolean parked) {

        public static GateApprovalOutcome parked(ChatApproval row) {
            return new GateApprovalOutcome(row, true);
        }

        public static GateApprovalOutcome rejected(ChatApproval row) {
            return new GateApprovalOutcome(row, false);
        }
    }

    /** True when the row is live and waiting for an answer (never for a terminal answerer reject). */
    public boolean isAwaitingAnswer(ChatApproval approval) {
        return approval != null && REPLAYABLE_STATES.contains(approval.getState());
    }

    /**
     * Post-gate approval creation (T1.7/T1.9): reuse the live row for the same exact invocation or
     * persist a new pending request owned by the authenticated run. The canonical hash and the
     * bounded redacted preview are derived from the same MCP body the gate evaluated. The run is
     * moved to {@code awaiting_approval} exactly like the Agent-relay path. Empty means the caller
     * must fall back to the legacy fail-closed 409 (missing or foreign run context).
     */
    @Transactional
    public Optional<GateApprovalOutcome> recordGatePending(String sessionId, String runId, String userId,
                                                           String workspaceId, String tool, String mcpBody,
                                                           Instant expiresAt) {
        if (runId == null || runId.isBlank() || sessionId == null || sessionId.isBlank()
                || tool == null || tool.isBlank() || mcpBody == null || mcpBody.isBlank()
                || expiresAt == null) {
            return Optional.empty();
        }
        String argumentsHash = canonicalInvocationHash(tool, mcpBody);
        Optional<ChatApproval> existing = findLivePendingForInvocation(sessionId, tool, argumentsHash);
        boolean reused = existing.isPresent();
        if (!reused) {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("requestId", UUID.randomUUID().toString());
            payload.put("runId", runId);
            payload.put("sessionId", sessionId);
            payload.put("tool", tool);
            payload.put("action", "Execute " + tool);
            payload.put("details", gateDetailsPreview(tool, mcpBody));
            payload.put("argumentsHash", argumentsHash);
            payload.put("expiresAt", expiresAt.toString());
            existing = Optional.of(recordPending(payload, sessionId, runId, userId, workspaceId));
        }
        ChatApproval row = existing.get();
        // T1.9: an answerer-rejected row is terminal from creation; parking the run on
        // awaiting_approval would make it wait for an answer that can never come.
        if (isAwaitingAnswer(row)) {
            chatRunRepository.transition(UUID.fromString(runId), List.of("running", "streaming"),
                    "awaiting_approval", null, null, null, 0, 0);
            operationService.transitionOperationForRun(runId, "waiting_for_approval", null, null);
            logger.info("[LIFECYCLE] service=cp event=chat_approval_gate_pending requestId={}"
                            + " sessionId={} runId={} reused={}",
                    row.getRequestId(), sessionId, runId, reused);
            return Optional.of(GateApprovalOutcome.parked(row));
        }
        logger.info("[LIFECYCLE] service=cp event=chat_approval_gate_answerer_rejected requestId={}"
                        + " sessionId={} runId={} state={}",
                row.getRequestId(), sessionId, runId, row.getState());
        return Optional.of(GateApprovalOutcome.rejected(row));
    }

    /** Bounded, redacted preview for a gate-created approval; raw arguments never persist. */
    private String gateDetailsPreview(String tool, String mcpBody) {
        try {
            JsonNode arguments = objectMapper.readTree(mcpBody).path("params").path("arguments");
            Map<String, Object> wrapper = new LinkedHashMap<>();
            wrapper.put("tool", tool);
            wrapper.put("arguments", arguments.isMissingNode()
                    ? Map.of() : objectMapper.convertValue(arguments, Object.class));
            String redacted = LogRedactor.redact(objectMapper.writeValueAsString(wrapper));
            return redacted.length() <= MAX_DETAILS_LENGTH
                    ? redacted : redacted.substring(0, MAX_DETAILS_LENGTH);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=gate_approval_preview_failed tool={}", tool);
            return "{\"tool\":\"" + tool + "\",\"arguments\":\"[REDACTED]\"}";
        }
    }

    /** Canonical live payload for the SSE approval card (same shape as replay, replayed=false). */
    public Map<String, Object> livePayload(ChatApproval approval) {
        return payloadFor(approval, false);
    }

    /** Safe display-only policy summary of one durable row (used by the gate 409 extension). */
    public Optional<Map<String, Object>> displayPolicy(ChatApproval approval) {
        return policySummary.readStored(approval.getPolicySummary());
    }

    /**
     * Session mode at decision time (PLAN-0337): the persisted session override, else the builtin
     * manual. The workspace default is intentionally not folded in here — a grant stores the mode
     * that was actually in force for the session tier.
     */
    private String currentSessionMode(String sessionId) {
        return sessionApprovalMode.modeOf(sessionId)
                .filter(mode -> mode != null && !mode.isBlank())
                .orElse(LayeredPolicyResolver.MODE_MANUAL);
    }

    /** Workspace sandbox generation; null when the workspace cannot be read (fail-closed). */
    private Integer currentSandboxGeneration(String workspaceId) {
        if (workspaceId == null || workspaceId.isBlank()) {
            return null;
        }
        try {
            return workspaceRepository.findById(UUID.fromString(workspaceId))
                    .map(Workspace::getGeneration)
                    .map(generation -> generation == null ? 0 : generation)
                    .orElse(null);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /** Reuse tier recorded on the row; rejected decisions have no reusable scope. */
    private static String reuseScopeOf(ApprovalDecision decision) {
        return decision.kind().isApproved() ? decision.kind().wireName() : null;
    }

    // PLAN-292 M1 (H1): match by canonical arguments hash first so a truncated
    // preview cannot fail an approved large write (409 after approval). Rows
    // without a stored hash (pre-V9) keep the legacy whole-JSON comparison.
    // Every miss stays fail-closed: the caller maps false to 409/404 upstream.
    private boolean matchesInvocation(ChatApproval approval, String tool, String mcpBody) {
        String storedHash = approval.getArgumentsHash();
        if (storedHash != null && !storedHash.isBlank()) {
            return matchesArgumentsHash(storedHash, tool, mcpBody);
        }
        return matchesMcpInvocation(approval.getDetails(), tool, mcpBody);
    }

    // Canonical form is the Agent's approval details payload:
    // {"tool": <tool>, "arguments": <mcp params.arguments>} serialized with
    // sorted keys, compact separators and raw UTF-8 (Python json.dumps
    // ensure_ascii=False, sort_keys=True, separators=(",", ":")).
    private boolean matchesArgumentsHash(String storedHash, String tool, String mcpBody) {
        String computed = canonicalInvocationHash(tool, mcpBody);
        if (computed == null || !computed.equals(ReusePolicy.normalizeArgumentsHash(storedHash))) {
            logger.info("[LIFECYCLE] service=cp event=approval_grant_hash_mismatch tool={}", tool);
            return false;
        }
        return true;
    }

    /** Canonical invocation hash ({@code sha256:...}) or null when the body cannot be matched. */
    private String canonicalInvocationHash(String tool, String mcpBody) {
        if (tool == null || tool.isBlank() || mcpBody == null || mcpBody.isBlank()) {
            return null;
        }
        try {
            JsonNode arguments = objectMapper.readTree(mcpBody).path("params").path("arguments");
            if (arguments.isMissingNode()) {
                logger.warn("[LIFECYCLE] service=cp event=approval_grant_hash_mismatch tool={} reason=missing_arguments", tool);
                return null;
            }
            Map<String, Object> invocation = new LinkedHashMap<>();
            invocation.put("tool", tool);
            invocation.put("arguments", objectMapper.convertValue(arguments, Object.class));
            return "sha256:" + hexSha256(canonicalMapper.writeValueAsString(invocation));
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=approval_grant_payload_invalid tool={} reason={}",
                    tool, e.getMessage());
            return null;
        }
    }

    private static String hexSha256(String canonical) {
        try {
            byte[] digest = MessageDigest.getInstance(HASH_ALGORITHM)
                    .digest(canonical.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                hex.append(Character.forDigit((b >> 4) & 0xF, 16))
                        .append(Character.forDigit(b & 0xF, 16));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 message digest unavailable", e);
        }
    }

    private boolean matchesMcpInvocation(String details, String tool, String mcpBody) {
        try {
            JsonNode approved = objectMapper.readTree(details);
            JsonNode current = objectMapper.readTree(mcpBody);
            return tool.equals(approved.path("tool").asText())
                    && approved.path("arguments").equals(current.path("params").path("arguments"));
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=approval_grant_payload_invalid tool={} reason={}",
                    tool, e.getMessage());
            return false;
        }
    }

    Map<String, Object> payloadFor(ChatApproval approval, boolean replayed) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("requestId", approval.getRequestId().toString());
        payload.put("runId", approval.getRunId());
        payload.put("sessionId", approval.getSessionId());
        payload.put("workspaceId", approval.getWorkspaceId());
        payload.put("tool", approval.getTool());
        payload.put("action", approval.getAction());
        payload.put("details", approval.getDetails());
        payload.put("snapshotId", approval.getSnapshotId());
        payload.put("policyClass", approval.getPolicyClass());
        payload.put("argumentsHash", approval.getArgumentsHash());
        payload.put("expiresAt", approval.getExpiresAt());
        payload.put("state", approval.getState());
        payload.put("replayed", replayed);
        policySummary.readStored(approval.getPolicySummary()).ifPresent(policy -> {
            if (approval.getModeAtGrant() != null && !approval.getModeAtGrant().isBlank()) {
                Map<String, Object> enriched = new LinkedHashMap<>(policy);
                enriched.put("modeAtGrant", approval.getModeAtGrant());
                payload.put("policy", enriched);
            } else {
                payload.put("policy", policy);
            }
        });
        if (!payload.containsKey("policy")
                && approval.getModeAtGrant() != null && !approval.getModeAtGrant().isBlank()) {
            payload.put("modeAtGrant", approval.getModeAtGrant());
        }
        return payload;
    }

    private String effectiveModeAtGrant(ChatApproval approval) {
        String storedMode = approval.getModeAtGrant();
        if (storedMode != null && !storedMode.isBlank()) {
            return storedMode;
        }
        return currentSessionMode(approval.getSessionId());
    }

    private Map<String, Object> decisionResponse(String requestId, String status, boolean approved,
                                                 String decisionKind, int propagated,
                                                 ApprovalGrantWriter.RulePlan plan,
                                                 String modeAtGrant) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("status", status);
        response.put("requestId", requestId);
        response.put("approved", approved);
        response.put("decision", decisionKind);
        response.put("propagated", propagated);
        response.put("modeAtGrant", modeAtGrant);
        if (plan != null) {
            Map<String, Object> rule = new LinkedHashMap<>();
            rule.put("layer", plan.layer());
            rule.put("actionClass", plan.actionClass());
            rule.put("resource", plan.resource());
            rule.put("effect", plan.effect().name().toLowerCase());
            response.put("rule", rule);
        }
        return response;
    }

    private boolean isTerminal(String state) {
        return "approved".equals(state) || "rejected".equals(state) || "expired".equals(state);
    }

    /** Malformed ids must surface as 400 INVALID_REQUEST, never a raw 500 (PLAN-290 M0.4). */
    private UUID parseRequestId(String requestId) {
        try {
            return UUID.fromString(requestId);
        } catch (Exception e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "requestId is invalid", e);
        }
    }

    private String required(Map<?, ?> payload, String key) {
        String value = optional(payload, key, "");
        if (value.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_EVENT_INVALID", key + " is required");
        }
        return value;
    }

    private String optional(Map<?, ?> payload, String key, String fallback) {
        Object value = payload.get(key);
        return value == null ? fallback : String.valueOf(value);
    }

    private Instant parseExpiresAt(Object raw) {
        if (raw == null) return Instant.now().plus(5, ChronoUnit.MINUTES);
        try {
            return Instant.parse(String.valueOf(raw));
        } catch (Exception e) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_EVENT_INVALID", "expiresAt is invalid", e);
        }
    }
}
