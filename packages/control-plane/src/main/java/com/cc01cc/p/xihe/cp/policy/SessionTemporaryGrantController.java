package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.fasterxml.jackson.databind.JsonNode;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * task-124 / DSD-1509: the session temporary grant face — {@code POST}/{@code GET}
 * {@code /api/v1/sessions/{sessionId}/temporary-grants} and {@code DELETE}
 * {@code .../temporary-grants/{grantId}}.
 *
 * <p>The controller is a thin adapter on purpose: every rule lives in
 * {@link SessionTemporaryGrantService} (gates, bounds, leaf principal) and in
 * {@link GrantAuthorizationService} (how a live token participates in a decision). This class only
 * maps HTTP to those calls and keeps the tier face's error shape ({@code ProblemDetails} with a
 * machine code) so a client that already handles {@code /tier} handles this the same way.</p>
 *
 * <p><b>Status codes</b>: 201 + the created row; 200 + the live rows; 200 + {@code {grantId,
 * revoked: true}}; 400 {@code INVALID_REQUEST} for a malformed body/TTL/capability atom; 403
 * {@code FORBIDDEN} (not the creator, missing {@code session:permission:configure}) or
 * {@code PRIVILEGE_ESCALATION} (atom outside the caller's own holdings); 404
 * {@code SESSION_NOT_FOUND} / {@code TEMPORARY_GRANT_NOT_FOUND} (revocation never distinguishes
 * "absent" from "another session's").</p>
 */
@RestController
@RequestMapping("/api/v1/sessions/{sessionId}/temporary-grants")
public class SessionTemporaryGrantController {

    private final SessionTemporaryGrantService service;

    public SessionTemporaryGrantController(SessionTemporaryGrantService service) {
        this.service = service;
    }

    @PreAuthorize("isAuthenticated()")
    @PostMapping
    public ResponseEntity<?> issue(@PathVariable String sessionId,
                                   @RequestBody(required = false) JsonNode body) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || userId.isBlank() || workspaceId == null || workspaceId.isBlank()) {
            return problem(CpApiException.workspaceContextRequired());
        }
        SessionTemporaryGrant row;
        try {
            // ttlSeconds() validates and can reject the body, so it belongs inside the mapping — a
            // thrown CpApiException outside would surface as a 500 instead of a 400.
            Integer ttl = ttlSeconds(body);
            row = service.issue(userId, workspaceId, sessionId,
                    body == null ? null : body.get("atoms"), ttl);
        } catch (CpApiException e) {
            return problem(e);
        }
        return ResponseEntity.status(HttpStatus.CREATED).body(view(row));
    }

    @PreAuthorize("isAuthenticated()")
    @GetMapping
    public ResponseEntity<?> list(@PathVariable String sessionId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || userId.isBlank()) {
            return problem(CpApiException.workspaceContextRequired());
        }
        List<Map<String, Object>> views = new ArrayList<>();
        try {
            for (SessionTemporaryGrant row : service.list(userId, workspaceId, sessionId)) {
                views.add(view(row));
            }
        } catch (CpApiException e) {
            return problem(e);
        }
        return ResponseEntity.ok(views);
    }

    @PreAuthorize("isAuthenticated()")
    @DeleteMapping("/{grantId}")
    public ResponseEntity<?> revoke(@PathVariable String sessionId, @PathVariable String grantId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || userId.isBlank()) {
            return problem(CpApiException.workspaceContextRequired());
        }
        try {
            service.revoke(userId, workspaceId, sessionId, grantId);
        } catch (CpApiException e) {
            return problem(e);
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("grantId", grantId);
        payload.put("revoked", true);
        return ResponseEntity.ok(payload);
    }

    private static Map<String, Object> view(SessionTemporaryGrant row) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("id", row.id());
        payload.put("sessionId", row.sessionId());
        payload.put("principalId", row.principalId());
        payload.put("atoms", SessionTemporaryGrantService.atomViews(row));
        payload.put("grantedBy", row.grantedByUserId());
        payload.put("grantedAt", row.grantedAt() == null ? null : row.grantedAt().toString());
        payload.put("expiresAt", row.expiresAt() == null ? null : row.expiresAt().toString());
        payload.put("revokedAt", row.revokedAt() == null ? null : row.revokedAt().toString());
        return payload;
    }

    /** {@code ttlSeconds} is optional (the service defaults it) but must be an integral number if present. */
    private static Integer ttlSeconds(JsonNode body) {
        JsonNode value = body == null ? null : body.get("ttlSeconds");
        if (value == null || value.isNull()) {
            return null;
        }
        if (!value.isIntegralNumber() || !value.canConvertToInt()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "ttlSeconds must be an integer number of seconds");
        }
        return value.intValue();
    }

    private static ResponseEntity<?> problem(CpApiException e) {
        return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
    }
}
