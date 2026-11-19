package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.service.SessionService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Policy administration API (PLAN-0328 M1): rules, tool faces and session mode.
 *
 * <p>Route: `/api/v1/policy/**`. All endpoints require USER or ADMIN; instance-layer writes and
 * `locked` flags additionally require ADMIN (decisions #53/#56/#58).</p>
 */
@RestController
@RequestMapping("/api/v1/policy")
public class PolicyController {

    private static final Logger log = LoggerFactory.getLogger(PolicyController.class);

    private final PolicyRuleService ruleService;
    private final ToolFaceService faceService;
    private final SessionPolicyState sessionState;
    private final SessionApprovalMode sessionApprovalMode;
    private final SessionService sessionService;
    private final RequesterAuthority requesterAuthority;
    private final SessionPermissionGuard permissionGuard;

    public PolicyController(PolicyRuleService ruleService, ToolFaceService faceService,
                            SessionPolicyState sessionState, SessionApprovalMode sessionApprovalMode,
                            SessionService sessionService, RequesterAuthority requesterAuthority,
                            SessionPermissionGuard permissionGuard) {
        this.ruleService = ruleService;
        this.faceService = faceService;
        this.sessionState = sessionState;
        this.sessionApprovalMode = sessionApprovalMode;
        this.sessionService = sessionService;
        this.requesterAuthority = requesterAuthority;
        this.permissionGuard = permissionGuard;
    }

    @PreAuthorize("isAuthenticated()")
    @GetMapping("/domains")
    public ResponseEntity<?> domains() {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        return ResponseEntity.ok(ruleService.domains(userId, workspaceId));
    }

    // PLAN-0407 T2.8 (design #18/#21): the /policy/rules CRUD routes are retired with the rule
    // adjudication engine — authorization is the grant lookup and the approval trigger is the
    // approval-policy ask list. The permission-rules UI page retires with PLAN-0374 T3.4.

    @PreAuthorize("isAuthenticated()")
    @GetMapping("/tool-faces")
    public ResponseEntity<?> listFaces(@RequestParam String scope) {
        try {
            return ResponseEntity.ok(faceService.list(scope, TenantContext.getUserId(),
                    TenantContext.getWorkspaceId(), isAdmin()));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @PreAuthorize("isAuthenticated()")
    @PostMapping("/tool-faces")
    public ResponseEntity<?> upsertFace(@RequestBody Map<String, Object> body) {
        String scope = body == null ? null : String.valueOf(body.get("scope"));
        try {
            return ResponseEntity.ok(faceService.upsert(scope, TenantContext.getUserId(),
                    TenantContext.getWorkspaceId(), isAdmin(),
                    new ToolFaceService.FaceInput(asString(body, "tool"), asString(body, "actionClass"),
                            asString(body, "shape"))));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @PreAuthorize("isAuthenticated()")
    @GetMapping("/mode")
    public ResponseEntity<?> getMode(@RequestParam String sessionId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.workspaceContextRequired();
        }
        try {
            // BL-299: GET /policy/mode is the UI's read of the session approval mode + rule
            // count — a session read face (owner or invited enabled HUMAN). The POST below keeps
            // requireCurrent (owner-only): a read widening must never widen this write face.
            sessionService.requireReadable(sessionId, userId, workspaceId);
        } catch (CpApiException e) {
            return problem(e);
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        SessionPolicyState.Entry snapshot = sessionState.snapshot(sessionId).orElse(null);
        payload.put("sessionId", sessionId);
        payload.put("mode", sessionApprovalMode.modeOf(sessionId)
                .orElse(LayeredPolicyResolver.MODE_MANUAL));
        // D-1908: the tier is the source of truth, so the UI cannot render "view" vs "workspace"
        // from the derived mode alone. A failed tier read must not break this existing read face.
        payload.put("tier", readTierQuietly(sessionId));
        payload.put("sessionRules", snapshot == null ? 0 : snapshot.rules().size());
        return ResponseEntity.ok(payload);
    }

    /** Reads the stored tier for a response, reporting {@code null} instead of failing the call. */
    private String readTierQuietly(String sessionId) {
        try {
            return sessionApprovalMode.tierOf(sessionId).orElse(null);
        } catch (RuntimeException e) {
            log.error("[POLICY] session tier read failed, reporting tier=null sessionId={}", sessionId, e);
            return null;
        }
    }

    /**
     * Session-scoped tier switch (D-1908 rev4). The tier is written as the source and the approval
     * mode is derived from it; a legacy {@code mode} body is translated into the tier whose derived
     * mode matches.
     *
     * <p>task-108: the write face no longer uses {@code requireCurrent} (owner-only, no atom). The
     * {@link SessionPermissionGuard} answers who may change it: widening needs
     * {@code session:permission:configure} <em>and</em> {@code sessions.user_id == actor};
     * tightening is open to any participant without the atom; and re-submitting the tier already
     * stored is a no-op that needs no atom either. A refusal is 403 with the guard's reason code
     * ({@code NO_CAPABILITY} / {@code NOT_SESSION_OWNER} / {@code TIER_UNREADABLE}) and one
     * {@code session.permission.escalated} audit row.</p>
     */
    @PreAuthorize("isAuthenticated()")
    @PostMapping("/mode")
    public ResponseEntity<?> setMode(@RequestBody Map<String, Object> body) {
        String sessionId = asString(body, "sessionId");
        String mode = asString(body, "mode");
        String tier = asString(body, "tier");
        if (sessionId == null || (mode == null && tier == null)) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "sessionId and mode are required");
        }
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || userId.isBlank() || workspaceId == null || workspaceId.isBlank()) {
            // BL-181: missing workspace context is a conflict with the account state (409).
            return problem(CpApiException.workspaceContextRequired());
        }
        SessionPermissionGuard.Decision decision;
        try {
            String targetTier = tier != null ? tier : SessionPermissionTier.tierForMode(mode);
            decision = permissionGuard.authorize(userId, workspaceId, sessionId, targetTier);
        } catch (CpApiException e) {
            return problem(e);
        } catch (IllegalArgumentException e) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    e.getMessage());
        }
        if (!decision.allowed()) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.FORBIDDEN, decision.reason(),
                    "session permission change refused: " + decision.reason());
        }
        // Authorization runs first so an unknown session keeps its 404 and a refused caller keeps
        // its 403; only an authorized caller with a bogus legacy mode sees 400.
        if (tier == null && !SessionPolicyState.MODES.contains(mode)) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "unsupported policy mode: " + mode);
        }
        try {
            // D-1908 rev4: tier is written as the source and the mode is derived from it; a legacy
            // "mode" body still works and is translated into the tier whose derived mode matches.
            if (tier != null) {
                sessionApprovalMode.setTier(sessionId, tier);
            } else {
                sessionApprovalMode.setMode(sessionId, mode);
            }
        } catch (IllegalArgumentException e) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    e.getMessage());
        } catch (IllegalStateException e) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND",
                    e.getMessage());
        }
        String effectiveTier = readTierQuietly(sessionId);
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("sessionId", sessionId);
        payload.put("mode", effectiveTier == null ? mode
                : SessionPermissionTier.modeForTier(effectiveTier));
        payload.put("tier", effectiveTier);
        payload.put("scope", "session");
        return ResponseEntity.ok(payload);
    }

    /**
     * PLAN-0651 M3 T3.3 (A13 → N9 {@code MANAGE_WORKSPACE_POLICY}) + D-165 (Lead ruling
     * 2026-11-05: reuse N9, no new atom, no migration).
     *
     * <p>N9 is the only existing atom whose contract text names the tool face
     * ({@code atom-contract.md}: "workspace 层策略规则 / 工具面"), and its {@code scope_class=both}
     * lets the same atom answer both faces at their own scope. A13 is the <b>instance</b> face, so
     * the evaluation is instance-scope ({@code workspaceId = null}): only ADMIN/SUPER_ADMIN's
     * instance N9 rows participate. A WS_OWNER's workspace-scoped N9 row is deliberately invisible
     * here — otherwise A14's workspace permission would leak into the instance face (pinned by
     * {@code ToolFaceAdminAtomScopeIntegrationTest}).</p>
     *
     * <p>Why not the role-administration atom (the original target): it is a shared atom that also gates
     * {@code /api/v1/roles} and {@code /api/v1/bindings}; granting it to ADMIN would hand role
     * administration to ADMIN, which the user ruling (D-161) did not approve (D-165 supersedes).
     * Refusal shape (403 {@code FORBIDDEN} from the service) is unchanged.</p>
     */
    private boolean isAdmin() {
        return requesterAuthority.holdsActionAtom(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY);
    }

    private static ResponseEntity<?> problem(CpApiException e) {
        return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
    }

    private static String asString(Map<String, Object> body, String key) {
        Object value = body == null ? null : body.get(key);
        return value == null ? null : String.valueOf(value);
    }
}


