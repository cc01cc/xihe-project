package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.service.SessionService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Policy administration API (PLAN-0328 M1): rules, tool faces and session mode.
 *
 * <p>Route: `/api/v1/policy/**`. All endpoints require USER or ADMIN; instance-layer writes and
 * `locked` flags additionally require ADMIN (decisions #53/#56/#58).</p>
 */
@RestController
@RequestMapping("/api/v1/policy")
public class PolicyController {

    private final PolicyRuleService ruleService;
    private final ToolFaceService faceService;
    private final SessionPolicyState sessionState;
    private final SessionService sessionService;

    public PolicyController(PolicyRuleService ruleService, ToolFaceService faceService,
                            SessionPolicyState sessionState, SessionService sessionService) {
        this.ruleService = ruleService;
        this.faceService = faceService;
        this.sessionState = sessionState;
        this.sessionService = sessionService;
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/domains")
    public ResponseEntity<?> domains() {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        return ResponseEntity.ok(ruleService.domains(userId, workspaceId));
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/rules")
    public ResponseEntity<?> listRules(@RequestParam String layer) {
        try {
            return ResponseEntity.ok(ruleService.list(layer, TenantContext.getUserId(),
                    TenantContext.getWorkspaceId(), isAdmin()));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/rules")
    public ResponseEntity<?> createRule(@RequestBody Map<String, Object> body) {
        String layer = body == null ? null : String.valueOf(body.get("layer"));
        try {
            PolicyRuleService.RuleInput input = new PolicyRuleService.RuleInput(
                    asString(body, "actionClass"),
                    asString(body, "resource"),
                    asString(body, "effect"),
                    asInt(body, "priority"),
                    asBoolean(body, "locked"));
            return ResponseEntity.ok(ruleService.create(layer, TenantContext.getUserId(),
                    TenantContext.getWorkspaceId(), isAdmin(), input));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @DeleteMapping("/rules/{id}")
    public ResponseEntity<?> deleteRule(@PathVariable String id, @RequestParam String layer) {
        UUID ruleId;
        try {
            ruleId = UUID.fromString(id);
        } catch (IllegalArgumentException e) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "id must be a UUID");
        }
        try {
            ruleService.delete(ruleId, layer, TenantContext.getUserId(),
                    TenantContext.getWorkspaceId(), isAdmin());
            return ResponseEntity.noContent().build();
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/rules/conflicts")
    public ResponseEntity<?> conflicts(@RequestParam String layer) {
        try {
            return ResponseEntity.ok(ruleService.conflicts(layer, TenantContext.getUserId(),
                    TenantContext.getWorkspaceId(), isAdmin()));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/tool-faces")
    public ResponseEntity<?> listFaces(@RequestParam String scope) {
        try {
            return ResponseEntity.ok(faceService.list(scope, TenantContext.getUserId(),
                    TenantContext.getWorkspaceId(), isAdmin()));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
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

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/mode")
    public ResponseEntity<?> getMode(@RequestParam String sessionId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED,
                    "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }
        try {
            sessionService.requireCurrent(sessionId, userId, workspaceId);
        } catch (CpApiException e) {
            return problem(e);
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        SessionPolicyState.Entry snapshot = sessionState.snapshot(sessionId).orElse(null);
        payload.put("sessionId", sessionId);
        payload.put("mode", snapshot == null || snapshot.mode() == null
                ? LayeredPolicyResolver.MODE_MANUAL : snapshot.mode());
        payload.put("sessionRules", snapshot == null ? 0 : snapshot.rules().size());
        return ResponseEntity.ok(payload);
    }

    /**
     * Session-scoped mode switch. Switching here never changes another session and
     * never changes another session.
     */
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/mode")
    public ResponseEntity<?> setMode(@RequestBody Map<String, Object> body) {
        String sessionId = asString(body, "sessionId");
        String mode = asString(body, "mode");
        if (sessionId == null || mode == null) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "sessionId and mode are required");
        }
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED,
                    "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }
        try {
            sessionService.requireCurrent(sessionId, userId, workspaceId);
        } catch (CpApiException e) {
            return problem(e);
        }
        try {
            sessionState.setMode(sessionId, mode);
        } catch (IllegalArgumentException e) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    e.getMessage());
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("sessionId", sessionId);
        payload.put("mode", mode);
        payload.put("scope", "session");
        return ResponseEntity.ok(payload);
    }

    private static boolean isAdmin() {
        return "ADMIN".equalsIgnoreCase(Optional.ofNullable(TenantContext.getUserRole()).orElse(""));
    }

    private static ResponseEntity<?> problem(CpApiException e) {
        return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
    }

    private static String asString(Map<String, Object> body, String key) {
        Object value = body == null ? null : body.get(key);
        return value == null ? null : String.valueOf(value);
    }

    private static Integer asInt(Map<String, Object> body, String key) {
        Object value = body == null ? null : body.get(key);
        return value instanceof Number number ? number.intValue() : null;
    }

    private static Boolean asBoolean(Map<String, Object> body, String key) {
        Object value = body == null ? null : body.get(key);
        return value instanceof Boolean bool ? bool : null;
    }
}
