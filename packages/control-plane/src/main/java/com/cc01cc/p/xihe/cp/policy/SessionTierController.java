package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.service.SessionService;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Session permission tier read/write face (task-83 / D-1488): {@code GET} and {@code PATCH}
 * {@code /api/v1/sessions/{sessionId}/tier}.
 *
 * <p>The UI has been calling this route since task-107 ({@code packages/ui/src/composables/api.ts}
 * {@code getSessionTier} / {@code setSessionTier}) and the control-plane never served it, so every
 * read 404'd and the tier badge could only ever fall back to its default. This controller adds no
 * new authorization logic of its own:</p>
 *
 * <ul>
 *   <li>read face — {@link SessionService#requireReadable}: owner or invited enabled HUMAN, 404
 *       otherwise (the same rule {@code GET /api/v1/policy/mode} uses for its tier field);</li>
 *   <li>write face — {@link SessionPermissionGuard#authorize}: widening needs the
 *       {@code session:permission:configure} atom <em>and</em> the session creator, tightening and
 *       no-op rewrites are open to any participant (D-1908 rev3);</li>
 *   <li>the effective tier itself comes from {@link PolicyContextProvider}, i.e. the same
 *       strictest-wins resolution the approval engine uses, so the badge cannot disagree with the
 *       verdict (D-1908 rev4).</li>
 * </ul>
 *
 * <p><b>Response shape</b> is the six-key {@code SessionTierState} the UI normalizer
 * ({@code normalizeSessionTierState}) validates, and only those six keys: {@code tier} /
 * {@code source} / {@code workspaceTier} / {@code canConfigure} / {@code denyReason} /
 * {@code available}. {@code tier} is never null (the UI rejects null), so an unreadable or absent
 * stored tier reports the fail-closed {@code view} instead of a blank.</p>
 *
 * <p><b>{@code workspaceTier} is null on purpose</b>: the control-plane has no workspace-layer tier
 * value yet (the workspace layer still speaks {@code approval-policy.mode}; turning it into
 * view/workspace/full is task-107b, per {@link SessionPermissionTier}'s class note). The UI accepts
 * null there. {@code available} is therefore the full {@code view/workspace/full} set — there is no
 * ceiling to intersect with until task-107b lands.</p>
 */
@RestController
@RequestMapping("/api/v1/sessions/{sessionId}/tier")
public class SessionTierController {

    /** Effective tier when neither the session row nor the workspace layer supplies one. */
    static final String SOURCE_SESSION = "session";
    static final String SOURCE_WORKSPACE = "workspace";
    static final String SOURCE_NONE = "none";

    /** UI deny-reason vocabulary ({@code sessionTierDenyReasons}); never the guard's raw codes. */
    static final String DENY_VIEWER = "viewer";
    static final String DENY_NOT_OWNER = "not-owner";
    static final String DENY_NO_ATOM = "no-atom";

    private static final List<String> AVAILABLE_TIERS = List.of(
            SessionPermissionTier.VIEW, SessionPermissionTier.WORKSPACE, SessionPermissionTier.FULL);

    private final SessionService sessionService;
    private final SessionApprovalMode sessionApprovalMode;
    private final SessionPermissionGuard permissionGuard;
    private final PolicyContextProvider policyContextProvider;

    public SessionTierController(SessionService sessionService, SessionApprovalMode sessionApprovalMode,
                                 SessionPermissionGuard permissionGuard,
                                 PolicyContextProvider policyContextProvider) {
        this.sessionService = sessionService;
        this.sessionApprovalMode = sessionApprovalMode;
        this.permissionGuard = permissionGuard;
        this.policyContextProvider = policyContextProvider;
    }

    /** BL-299 read shape: owner or invited enabled HUMAN; the guard's widening probe only informs. */
    @PreAuthorize("isAuthenticated()")
    @GetMapping
    public ResponseEntity<?> getTier(@PathVariable String sessionId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || userId.isBlank()) {
            return ProblemDetailsHandler.workspaceContextRequired();
        }
        try {
            sessionService.requireReadable(sessionId, userId, workspaceId);
        } catch (CpApiException e) {
            return problem(e);
        }
        return ResponseEntity.ok(state(userId, workspaceId, sessionId));
    }

    /**
     * Writes the tier; the approval mode is derived from it inside {@link SessionApprovalMode}
     * (view/workspace {@code ->} manual, full {@code ->} auto), never the other way round.
     */
    @PreAuthorize("isAuthenticated()")
    @PatchMapping
    public ResponseEntity<?> setTier(@PathVariable String sessionId,
                                     @RequestBody(required = false) Map<String, Object> body) {
        String tier = asString(body, "tier");
        if (tier == null || tier.isBlank()) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "tier is required");
        }
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || userId.isBlank() || workspaceId == null || workspaceId.isBlank()) {
            // BL-181: a missing workspace context is a conflict with the account state (409) and is
            // checked before the guard, exactly as POST /api/v1/policy/mode does.
            return problem(CpApiException.workspaceContextRequired());
        }
        SessionPermissionGuard.Decision decision;
        try {
            decision = permissionGuard.authorize(userId, workspaceId, sessionId, tier);
        } catch (CpApiException e) {
            return problem(e);
        } catch (IllegalArgumentException e) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    e.getMessage());
        }
        if (!decision.allowed()) {
            // The guard's code stays the contract code; denyReason is the UI's own vocabulary so a
            // 403 renders "no permission: <reason>" instead of an untranslated enum.
            return ProblemDetailsHandler.problemResponse(HttpStatus.FORBIDDEN, decision.reason(),
                    "session tier change refused: " + decision.reason(),
                    Map.of("denyReason", denyReasonOf(decision)));
        }
        try {
            sessionApprovalMode.setTier(sessionId, tier);
        } catch (IllegalArgumentException e) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    e.getMessage());
        } catch (IllegalStateException e) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND",
                    e.getMessage());
        }
        return ResponseEntity.ok(state(userId, workspaceId, sessionId));
    }

    /** The six-key {@code SessionTierState}; key order follows the UI type definition. */
    private Map<String, Object> state(String userId, String workspaceId, String sessionId) {
        PolicyContext context = policyContextProvider.load(userId, workspaceId, sessionId);
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("tier", effectiveTier(context));
        payload.put("source", sourceOf(context));
        // task-107b owns the workspace-layer tier; until it lands there is nothing to inherit here.
        payload.put("workspaceTier", null);
        SessionPermissionGuard.Decision probe = probeWidening(userId, workspaceId, sessionId);
        payload.put("canConfigure", probe != null && probe.allowed());
        payload.put("denyReason", probe == null ? DENY_VIEWER : denyReasonOf(probe));
        payload.put("available", AVAILABLE_TIERS);
        return payload;
    }

    /**
     * {@code tier} must never be null: the UI rejects it, and no stored tier means the strictest
     * tier is the one in force (fail-closed, {@code SessionPermissionTier.FAIL_CLOSED_TIER}).
     */
    private static String effectiveTier(PolicyContext context) {
        String tier = context.tier();
        return tier == null ? SessionPermissionTier.FAIL_CLOSED_TIER : tier;
    }

    /**
     * Where the effective tier came from: the session row, the inherited workspace layer, or
     * nowhere. A fail-closed read is "nowhere" — the forced {@code view} was not supplied by any
     * layer, and reporting it as {@code workspace} would attribute a degradation to the workspace.
     */
    private static String sourceOf(PolicyContext context) {
        if (context.tierFallback() != null || context.tier() == null) {
            return SOURCE_NONE;
        }
        if (context.tierSourceLayer() == PolicyLayer.SESSION) {
            return SOURCE_SESSION;
        }
        if (context.tierSourceLayer() == null) {
            return SOURCE_NONE;
        }
        return SOURCE_WORKSPACE;
    }

    /**
     * Can this caller pick a tier? The question is the widening one — the loosest tier is the target
     * — because widening is the only write that needs the atom <em>and</em> the session creator;
     * tightening is every participant's right, so it cannot be what "canConfigure" means.
     * {@link SessionPermissionGuard#preview} answers with the guard's own rules and writes no audit
     * row (a read face must not append {@code session.permission.escalated} on every GET).
     */
    private SessionPermissionGuard.Decision probeWidening(String userId, String workspaceId,
                                                          String sessionId) {
        try {
            return permissionGuard.preview(userId, workspaceId, sessionId, SessionPermissionTier.FULL);
        } catch (RuntimeException e) {
            // The probe only annotates this read face; the read itself already passed requireReadable.
            return null;
        }
    }

    /** Guard refusal code to the UI's three-value deny vocabulary; unknown codes fail closed. */
    static String denyReasonOf(SessionPermissionGuard.Decision decision) {
        if (decision.allowed()) {
            return null;
        }
        String reason = decision.reason();
        if (SessionPermissionGuard.REASON_NO_CAPABILITY.equals(reason)) {
            return DENY_NO_ATOM;
        }
        if (SessionPermissionGuard.REASON_NOT_SESSION_OWNER.equals(reason)) {
            return DENY_NOT_OWNER;
        }
        // TIER_UNREADABLE and anything the guard adds later: the UI must not offer the control.
        return DENY_VIEWER;
    }

    private static ResponseEntity<?> problem(CpApiException e) {
        return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
    }

    private static String asString(Map<String, Object> body, String key) {
        if (body == null) {
            return null;
        }
        Object value = body.get(key);
        return value == null ? null : String.valueOf(value);
    }
}
