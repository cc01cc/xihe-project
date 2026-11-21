package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

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
 *
 * <p><b>Wire binding (task-200).</b> The body is bound as a plain {@code Map<String, Object>}, not as
 * a node: Boot 4 hands request bodies to the Jackson-3 mapper, which cannot construct a Jackson-2
 * {@code com.fasterxml.jackson.databind.JsonNode}, so the original binding answered 500 before this
 * handler ever ran. The map is the wire shape only; the {@code atoms} array is tree-ified inside the
 * handler (Jackson 2, the CP's policy tree) and {@code ttlSeconds} is validated here, so every rule
 * downstream — including "unknown atom field" and "absent resource means wildcard" — stays exactly
 * where it was. This is the same split {@code AgentPrincipalWireBody.parseCreate} uses for the
 * principal face; {@code architecture.Jackson2NodeInboundScanTest} guards it.</p>
 */
@RestController
@RequestMapping("/api/v1/sessions/{sessionId}/temporary-grants")
public class SessionTemporaryGrantController {

    private final SessionTemporaryGrantService service;
    /** Jackson 2: the CP policy tree. Used <em>inside</em> the handler, never as a binding type. */
    private final ObjectMapper objectMapper;

    public SessionTemporaryGrantController(SessionTemporaryGrantService service,
                                           ObjectMapper objectMapper) {
        this.service = service;
        this.objectMapper = objectMapper;
    }

    @PreAuthorize("isAuthenticated()")
    @PostMapping
    public ResponseEntity<?> issue(@PathVariable String sessionId,
                                   @RequestBody(required = false) Map<String, Object> body) {
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
            row = service.issue(userId, workspaceId, sessionId, atomsTree(body), ttl);
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

    /**
     * The {@code atoms} array as the service's Jackson-2 tree. The map is only the wire shape: the
     * tree is built here so the service keeps its single write-side shape gate (unknown field,
     * non-object atom, absent-vs-null {@code resource} all still answer from {@code parseAtoms}).
     */
    private JsonNode atomsTree(Map<String, Object> body) {
        Object atoms = body == null ? null : body.get("atoms");
        return atoms == null ? null : objectMapper.valueToTree(atoms);
    }

    /** {@code ttlSeconds} is optional (the service defaults it) but must be an integral number if present. */
    private static Integer ttlSeconds(Map<String, Object> body) {
        Object value = body == null ? null : body.get("ttlSeconds");
        if (value == null) {
            return null;
        }
        if (value instanceof Integer integer) {
            return integer;
        }
        if (value instanceof Long longValue
                && longValue >= Integer.MIN_VALUE && longValue <= Integer.MAX_VALUE) {
            return longValue.intValue();
        }
        // JSON has one number type; the mapper picks Integer/Long/BigInteger/Double. Anything that is
        // not an integral value in int range is refused with the same message as before task-200.
        throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                "ttlSeconds must be an integer number of seconds");
    }

    private static ResponseEntity<?> problem(CpApiException e) {
        return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
    }
}
