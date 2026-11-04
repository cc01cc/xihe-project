package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.service.SessionService;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0655 human delegation surface. Phase 1 ships the read view; the spawn route
 * (POST …/delegation-spawn, contract `8a546e3f`) lands in the same controller once the
 * approval replay is wired.
 */
@RestController
@RequestMapping("/api/v1/sessions/{sessionId}")
public class DelegationController {

    private final SessionService sessionService;
    private final DelegationBudgetService delegationBudgetService;
    private final ChatSubmissionService chatSubmissionService;
    private final AgentSpawnAuthorizationService spawnAuthorization;
    private final ChatRunRepository chatRunRepository;
    private final ApplicationEventPublisher eventPublisher;

    public DelegationController(SessionService sessionService,
                                DelegationBudgetService delegationBudgetService,
                                ChatSubmissionService chatSubmissionService,
                                AgentSpawnAuthorizationService spawnAuthorization,
                                ChatRunRepository chatRunRepository,
                                ApplicationEventPublisher eventPublisher) {
        this.sessionService = sessionService;
        this.delegationBudgetService = delegationBudgetService;
        this.chatSubmissionService = chatSubmissionService;
        this.spawnAuthorization = spawnAuthorization;
        this.chatRunRepository = chatRunRepository;
        this.eventPublisher = eventPublisher;
    }

    /**
     * Read-only delegation budget view. Resolved at the same evaluation point as the budget
     * gate ({@link DelegationBudgetService#usageFor}); an unreadable stored policy fails
     * closed with the gate's own 409 DELEGATION_POLICY_INVALID.
     */
    @PreAuthorize("isAuthenticated()")
    @GetMapping("/delegation-usage")
    public ResponseEntity<?> usage(@PathVariable String sessionId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.workspaceContextRequired();
        }
        UUID sessionUuid;
        try {
            sessionUuid = UUID.fromString(sessionId);
        } catch (IllegalArgumentException invalid) {
            return ProblemDetailsHandler.problemResponse(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "INVALID_REQUEST", "sessionId must be a UUID");
        }
        Session session;
        try {
            session = sessionService.requireCurrent(sessionUuid.toString(), userId, workspaceId);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
        DelegationBudgetService.DelegationUsage usage;
        try {
            usage = delegationBudgetService.usageFor(session);
        } catch (DelegationRefusedException refused) {
            return ProblemDetailsHandler.problemResponse(refused.getStatus(), refused.getCode(),
                    refused.getMessage());
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("rootSessionId", usage.rootSessionId());
        body.put("usedSessions", usage.usedSessions());
        body.put("maxCount", usage.maxCount());
        body.put("currentDepth", usage.currentDepth());
        body.put("maxDepth", usage.maxDepth());
        body.put("principalId", usage.principalId());
        body.put("principalName", usage.principalName());
        body.put("policySource", usage.policySource());
        body.put("disabled", usage.disabled());
        return ResponseEntity.ok(body);
    }
    /**
     * Human delegation (PLAN-0655, contract 8a546e3f). Capability first (SPAWN_AGENT evaluated as
     * capability atoms through the existing spawn grant/policy gate — no role-name checks anywhere),
     * then the budget gate inside the parent Session+Run locks, then creation. The ask answer travels
     * as 202 + approvalRequestId; the client re-POSTs with the same Idempotency-Key after grant.
     */
    @PreAuthorize("isAuthenticated()")
    @PostMapping("/delegation-spawn")
    public ResponseEntity<?> spawn(@PathVariable String sessionId,
                                   @RequestBody Map<String, Object> body,
                                   @RequestHeader(value = "Idempotency-Key", required = false)
                                   String idempotencyKey,
                                   @RequestHeader(value = AgentSpawnAuthorizationService.APPROVAL_GRANT_HEADER,
                                           required = false) String approvalRequestId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.workspaceContextRequired();
        }
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            return invalidRequest("Idempotency-Key header is required");
        }
        if (body == null || !java.util.Set.of("agentPrincipalId", "task").equals(body.keySet())) {
            return invalidRequest("Body must contain exactly agentPrincipalId and task");
        }
        String principalIdText = text(body.get("agentPrincipalId"), "agentPrincipalId");
        String task = text(body.get("task"), "task");
        java.util.UUID principalId;
        try {
            principalId = java.util.UUID.fromString(principalIdText);
        } catch (IllegalArgumentException invalid) {
            return invalidRequest("agentPrincipalId must be a UUID");
        }
        if (task.length() > 4000) {
            return invalidRequest("task must be at most 4000 characters");
        }

        Session session;
        try {
            session = sessionService.requireCurrent(sessionId, userId, workspaceId);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
        ChatRun parentRun = chatRunRepository
                .findFirstBySessionIdOrderByCreatedAtDescIdDesc(session.getId().toString()).orElse(null);
        if (parentRun == null) {
            return invalidRequest("The parent session has no run to delegate from");
        }

        String authorizationBody = chatSubmissionService.delegationAuthorizationBody(task);
        ChatSubmissionService.SpawnInvocation invocation = new ChatSubmissionService.SpawnInvocation(
                parentRun.getId().toString(), idempotencyKey, session.getId().toString(), null,
                userId, workspaceId, principalId.toString(), authorizationBody);
        AgentSpawnAuthorizationService.GateResult gate;
        try {
            gate = spawnAuthorization.authorizeUserSpawn(invocation, approvalRequestId);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
        if (!gate.allowed()) {
            Map<String, Object> pendingBody = new LinkedHashMap<>();
            pendingBody.put("approvalRequestId", gate.approvalRequestId());
            pendingBody.put("statusUrl", "/api/v1/approvals/" + gate.approvalRequestId());
            pendingBody.put("retryHeader", AgentSpawnAuthorizationService.APPROVAL_GRANT_HEADER);
            return ResponseEntity.status(HttpStatus.ACCEPTED).body(pendingBody);
        }

        ChatSubmissionService.SpawnResult result;
        try {
            result = chatSubmissionService.createDelegation(parentRun.getId().toString(),
                    principalId.toString(), task, idempotencyKey, gate.authorization());
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
        try {
            eventPublisher.publishEvent(new SpawnRunDispatchRequestedEvent(
                    parentRun.getId().toString(), result.runId()));
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=delegation_dispatch_failed parentRunId={} "
                    + "childRunId={} failureType={}", parentRun.getId(), result.runId(),
                    e.getClass().getSimpleName(), e);
        }

        Session childSession = sessionService.requireCurrent(result.sessionId(), userId, workspaceId);
        DelegationBudgetService.DelegationUsage usage = delegationBudgetService.usageFor(childSession);
        Map<String, Object> created = new LinkedHashMap<>();
        created.put("childSessionId", result.sessionId());
        created.put("childRunId", result.runId());
        created.put("rootSessionId", usage.rootSessionId());
        created.put("chainDepth", usage.currentDepth());
        created.put("budget", toBudgetBody(usage));
        return ResponseEntity.status(HttpStatus.CREATED).header("Location",
                "/api/v1/sessions/" + result.sessionId()).body(created);
    }

    private Map<String, Object> toBudgetBody(DelegationBudgetService.DelegationUsage usage) {
        Map<String, Object> budget = new LinkedHashMap<>();
        budget.put("rootSessionId", usage.rootSessionId());
        budget.put("usedSessions", usage.usedSessions());
        budget.put("maxCount", usage.maxCount());
        budget.put("currentDepth", usage.currentDepth());
        budget.put("maxDepth", usage.maxDepth());
        budget.put("principalId", usage.principalId());
        budget.put("principalName", usage.principalName());
        budget.put("policySource", usage.policySource());
        budget.put("disabled", usage.disabled());
        return budget;
    }

    private static String text(Object value, String field) {
        if (!(value instanceof String text) || text.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", field + " is required");
        }
        return text;
    }

    private static ResponseEntity<?> invalidRequest(String detail) {
        return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", detail);
    }

    private static final org.slf4j.Logger logger =
            org.slf4j.LoggerFactory.getLogger(DelegationController.class);
}
