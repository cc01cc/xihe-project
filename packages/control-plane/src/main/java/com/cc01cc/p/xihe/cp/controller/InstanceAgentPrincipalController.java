package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.policy.InstanceAgentPrincipalService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0771 M3 (task-179, contract {@code d533613c}, D-932 contract-first): the instance platform
 * agent surface —
 * {@code GET/POST /api/v1/instance/agent-principals}, {@code PATCH/DELETE /api/v1/instance/agent-principals/{principalId}}.
 *
 * <p>Contract facts implemented verbatim:</p>
 * <ul>
 *   <li><b>read face</b> — any authenticated caller sees the same list an instance admin sees
 *       ({@code isAuthenticated()} only). This is <b>deliberately different</b> from the credential
 *       surface, which gates reads with {@code cap:instance:admin}: platform agents are ownerless and
 *       carry no secret material, credentials do;</li>
 *   <li><b>write face</b> — {@code cap:instance:admin} <b>and</b> the instance-tier
 *       {@code MANAGE_AGENT_PRINCIPALS} atom, both evaluated at the atom layer (never a role-name
 *       special case). Any other caller answers 403 {@code FORBIDDEN} before the body is read;</li>
 *   <li><b>{@code DELETE} = retire</b> — 204, {@code disabledAt} set, the row kept (never a hard
 *       delete, matching the existing disable invariant and FK {@code ON DELETE RESTRICT}); idempotent,
 *       so an already-retired row answers 204 again;</li>
 *   <li><b>no ownership field</b> — the request bodies are the existing
 *       {@code AgentPrincipalCreateRequest}/{@code AgentPrincipalUpdateRequest} unchanged, so no
 *       request shape can name an owner (D-1009 2/3: no promote/import, ever).</li>
 * </ul>
 *
 * <p>Body/response projections are shared with the non-instance surface
 * ({@link AgentPrincipalWireBody}, {@link AgentPrincipalWireView}) so the two faces cannot drift.</p>
 */
@RestController
@RequestMapping("/api/v1/instance/agent-principals")
public class InstanceAgentPrincipalController {

    /**
     * The write gate: capability atom (this surface exists at all) <b>and</b> the action atom (the
     * instance tier's own principal-management authority). Both are atom-layer checks; neither is a
     * role name.
     */
    private static final String INSTANCE_PRINCIPAL_WRITE_GATE =
            "@requesterAuthority.holdsCapabilityAtom('instance:admin')"
                    + " and @requesterAuthority.holdsActionAtom('MANAGE_AGENT_PRINCIPALS')";

    private final InstanceAgentPrincipalService instancePrincipals;
    private final ObjectMapper objectMapper;

    public InstanceAgentPrincipalController(InstanceAgentPrincipalService instancePrincipals,
            ObjectMapper objectMapper) {
        this.instancePrincipals = instancePrincipals;
        this.objectMapper = objectMapper;
    }

    /** Read face: every authenticated caller, same rows as an instance admin, no owner filter. */
    @GetMapping
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> list() {
        String actorUserId = requireActor();
        if (actorUserId == null) {
            return unauthorized();
        }
        try {
            List<Map<String, Object>> principals = instancePrincipals.list().stream()
                    .map(view -> AgentPrincipalWireView.principalView(view, objectMapper)).toList();
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("principals", principals);
            return noStore(ResponseEntity.ok(body));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    /** Create a NEW instance platform agent (no ownership member in the body: server-derived). */
    @PostMapping
    @PreAuthorize(INSTANCE_PRINCIPAL_WRITE_GATE)
    public ResponseEntity<?> create(@RequestBody(required = false) Map<String, Object> body) {
        String actorUserId = requireActor();
        if (actorUserId == null) {
            return unauthorized();
        }
        try {
            AgentPrincipalWireBody.CreateBody parsed = AgentPrincipalWireBody.parseCreate(body, objectMapper);
            AgentPrincipal created = instancePrincipals.create(actorUserId, parsed.name(),
                    parsed.templateId(), parsed.defaultModelProvider(), parsed.defaultModelName(),
                    parsed.allowedModels(), parsed.hooks(), parsed.roleIds());
            return noStore(ResponseEntity.status(HttpStatus.CREATED)
                    .body(AgentPrincipalWireView.createView(created, parsed.roleIds(), objectMapper)));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    /** Update the subject documents ({@code hooks}/{@code contextPolicy}/{@code delegationPolicy}). */
    @PatchMapping("/{principalId}")
    @PreAuthorize(INSTANCE_PRINCIPAL_WRITE_GATE)
    public ResponseEntity<?> updateDocuments(@PathVariable("principalId") String principalId,
                                             @RequestBody(required = false) Map<String, Object> body) {
        String actorUserId = requireActor();
        if (actorUserId == null) {
            return unauthorized();
        }
        try {
            UUID principalUuid = parseUuid(principalId);
            var patch = AgentPrincipalWireBody.parseDocuments(body, objectMapper);
            var stored = instancePrincipals.updateDocuments(actorUserId, principalUuid, patch);
            return noStore(ResponseEntity.ok(
                    AgentPrincipalWireView.documentsView(principalUuid, stored, objectMapper)));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    /** {@code DELETE} is the retire spelling: 204, row kept, {@code disabledAt} set, idempotent. */
    @DeleteMapping("/{principalId}")
    @PreAuthorize(INSTANCE_PRINCIPAL_WRITE_GATE)
    public ResponseEntity<?> retire(@PathVariable("principalId") String principalId) {
        String actorUserId = requireActor();
        if (actorUserId == null) {
            return unauthorized();
        }
        try {
            instancePrincipals.retire(actorUserId, parseUuid(principalId));
            return noStore(ResponseEntity.noContent().build());
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    private static UUID parseUuid(String value) {
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException | NullPointerException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "A valid UUID is required", e);
        }
    }

    private static String requireActor() {
        String actorUserId = TenantContext.getUserId();
        return actorUserId == null || actorUserId.isBlank() ? null : actorUserId;
    }

    /** Platform-agent views are identity/lifecycle metadata and are never cacheable. */
    private static <T> ResponseEntity<T> noStore(ResponseEntity<T> response) {
        return ResponseEntity.status(response.getStatusCode())
                .headers(response.getHeaders())
                .header("Cache-Control", "no-store")
                .body(response.getBody());
    }

    private static ResponseEntity<?> unauthorized() {
        return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED,
                "AUTHORIZATION_REQUIRED", "Authentication required");
    }

    private static ResponseEntity<?> problem(CpApiException e) {
        return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
    }
}
