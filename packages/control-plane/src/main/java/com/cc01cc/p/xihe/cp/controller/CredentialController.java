package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.credentials.CredentialConcurrentModificationException;
import com.cc01cc.p.xihe.cp.credentials.CredentialNotFoundException;
import com.cc01cc.p.xihe.cp.credentials.CredentialService;
import com.cc01cc.p.xihe.cp.entity.Credential;
import com.cc01cc.p.xihe.cp.policy.CredentialAdminService;
import com.cc01cc.p.xihe.cp.policy.CredentialBindingService;
import com.cc01cc.p.xihe.cp.policy.CredentialRevealService;
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
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0496 M3 (T3.1; contract: 0496 §方案 6): the credential management API —
 * list / create / replace / delete (reference report) / precheck / bindings /
 * references. Writes are gated by credential_manage atoms (registering requires
 * the wildcard ceiling, operating on one credential requires the concrete id);
 * responses never carry ciphertext or suffixes.
 */
@RestController
@RequestMapping("/api/v1/credentials")
@PreAuthorize("hasAnyRole('USER', 'ADMIN')")
public class CredentialController {

    private final CredentialAdminService adminService;
    private final CredentialBindingService bindingService;
    private final CredentialRevealService revealService;
    private final ObjectMapper objectMapper;

    public CredentialController(CredentialAdminService adminService,
            CredentialBindingService bindingService,
            CredentialRevealService revealService,
            ObjectMapper objectMapper) {
        this.adminService = adminService;
        this.bindingService = bindingService;
        this.revealService = revealService;
        this.objectMapper = objectMapper;
    }

    @GetMapping
    public ResponseEntity<?> list(@RequestParam(value = "ownerType", required = false) String ownerType,
                                  @RequestParam(value = "ownerId", required = false) String ownerId) {
        String actorUserId = requireActor();
        if (actorUserId == null) {
            return unauthorized();
        }
        try {
            List<CredentialAdminService.CredentialSummary> credentials =
                    adminService.list(actorUserId, ownerType, ownerId);
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("credentials", credentials);
            body.put("count", credentials.size());
            return noStore(ResponseEntity.ok(body));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @PostMapping
    public ResponseEntity<?> create(@RequestBody CreateCredentialRequest request) {
        String actorUserId = requireActor();
        if (actorUserId == null) {
            return unauthorized();
        }
        try {
            Credential created = adminService.create(actorUserId, request.ownerType(), request.ownerId(),
                    request.label(), request.kind(), request.deliveryTier(), request.toPayload());
            return noStore(ResponseEntity.status(HttpStatus.CREATED).body(credentialView(created)));
        } catch (CpApiException e) {
            return problem(e);
        } catch (IllegalArgumentException e) {
            return badRequest(e);
        }
    }

    @PostMapping("/{id}/replace")
    public ResponseEntity<?> replace(@PathVariable("id") String id,
                                     @RequestBody ReplaceSecretRequest request) {
        String actorUserId = requireActor();
        if (actorUserId == null) {
            return unauthorized();
        }
        UUID credentialId;
        try {
            credentialId = UUID.fromString(id);
        } catch (IllegalArgumentException e) {
            return badRequest(e);
        }
        try {
            Credential replaced = adminService.replace(actorUserId, credentialId, request.toPayload());
            return noStore(ResponseEntity.ok(credentialView(replaced)));
        } catch (CpApiException e) {
            return problem(e);
        } catch (CredentialNotFoundException e) {
            return notFound(e);
        } catch (CredentialConcurrentModificationException e) {
            return conflict(e);
        } catch (IllegalArgumentException e) {
            return badRequest(e);
        }
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<?> delete(@PathVariable("id") String id) {
        String actorUserId = requireActor();
        if (actorUserId == null) {
            return unauthorized();
        }
        UUID credentialId;
        try {
            credentialId = UUID.fromString(id);
        } catch (IllegalArgumentException e) {
            return badRequest(e);
        }
        try {
            CredentialAdminService.DeleteReport report = adminService.delete(actorUserId, credentialId);
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("id", report.id());
            body.put("deleted", true);
            body.put("references", report.references());
            return noStore(ResponseEntity.ok(body));
        } catch (CpApiException e) {
            return problem(e);
        } catch (CredentialNotFoundException e) {
            return notFound(e);
        }
    }

    @GetMapping("/{id}/references")
    public ResponseEntity<?> references(@PathVariable("id") String id) {
        String actorUserId = requireActor();
        if (actorUserId == null) {
            return unauthorized();
        }
        UUID credentialId;
        try {
            credentialId = UUID.fromString(id);
        } catch (IllegalArgumentException e) {
            return badRequest(e);
        }
        try {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("references", adminService.referencesForActor(actorUserId, credentialId));
            return noStore(ResponseEntity.ok(body));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    /**
     * PLAN-0497 T3.1 (0497 design §方案 3): the human reveal — user-only
     * credential_reveal intersection + step-up + failure throttle; the response
     * carries the plaintext once and is never cacheable (no-store).
     */
    @PostMapping("/{id}/reveal")
    public ResponseEntity<?> reveal(@PathVariable("id") String id,
                                    @RequestBody RevealRequest request) {
        String actorUserId = requireActor();
        if (actorUserId == null) {
            return unauthorized();
        }
        UUID credentialId;
        try {
            credentialId = UUID.fromString(id);
        } catch (IllegalArgumentException e) {
            return badRequest(e);
        }
        try {
            CredentialRevealService.RevealedCredential revealed = revealService.reveal(actorUserId,
                    credentialId, TenantContext.getWorkspaceId(),
                    request.password());
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("credentialId", revealed.credentialId());
            body.put("revision", revealed.revision());
            body.put("value", revealed.plaintext());
            return noStore(ResponseEntity.ok(body));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    /**
     * PLAN-0497 T3.2 (0497 design §方案 6, decision #9): the credentials audit
     * trail read surface consumed by 0498 — owner-visible events, never a value.
     */
    @GetMapping("/{id}/events")
    public ResponseEntity<?> events(@PathVariable("id") String id,
            @RequestParam(value = "limit", required = false, defaultValue = "200") int limit) {
        String actorUserId = requireActor();
        if (actorUserId == null) {
            return unauthorized();
        }
        UUID credentialId;
        try {
            credentialId = UUID.fromString(id);
        } catch (IllegalArgumentException e) {
            return badRequest(e);
        }
        try {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("events", adminService.eventsForActor(actorUserId, credentialId, limit));
            return noStore(ResponseEntity.ok(body));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @PostMapping("/precheck")
    public ResponseEntity<?> precheck(@RequestBody(required = false) Map<String, Object> request) {
        String actorUserId = requireActor();
        if (actorUserId == null) {
            return unauthorized();
        }
        Object permissions = request == null ? null : request.get("permissions");
        if (permissions == null) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "permissions is required");
        }
        try {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("uncovered", adminService.precheck(actorUserId, objectMapper.valueToTree(permissions)));
            return noStore(ResponseEntity.ok(body));
        } catch (CpApiException e) {
            return problem(e);
        } catch (IllegalArgumentException e) {
            return badRequest(e);
        }
    }

    @PostMapping("/{id}/bindings")
    public ResponseEntity<?> bind(@PathVariable("id") String id, @RequestBody BindRequest request) {
        return bindOrUnbind(id, request, true);
    }

    @DeleteMapping("/{id}/bindings")
    public ResponseEntity<?> unbind(@PathVariable("id") String id, @RequestBody BindRequest request) {
        return bindOrUnbind(id, request, false);
    }

    private ResponseEntity<?> bindOrUnbind(String id, BindRequest request, boolean bind) {
        String actorUserId = requireActor();
        if (actorUserId == null) {
            return unauthorized();
        }
        UUID credentialId;
        UUID workspaceId;
        List<UUID> principalIds;
        try {
            credentialId = UUID.fromString(id);
            workspaceId = UUID.fromString(request.workspaceId());
            principalIds = request.agentPrincipalIds().stream().map(UUID::fromString).toList();
        } catch (IllegalArgumentException | NullPointerException e) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "credential id, workspaceId and agentPrincipalIds must be valid UUIDs");
        }
        String resource = "credential:" + credentialId;
        try {
            if (bind) {
                bindingService.bindToPrincipals(actorUserId, workspaceId, principalIds, List.of(resource));
            } else {
                bindingService.unbindFromPrincipals(actorUserId, workspaceId, principalIds, List.of(resource));
            }
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("credentialId", credentialId.toString());
            body.put("agentPrincipalIds", principalIds.stream().map(UUID::toString).toList());
            body.put("bound", bind);
            return noStore(ResponseEntity.ok(body));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    private String requireActor() {
        String actorUserId = TenantContext.getUserId();
        return actorUserId == null || actorUserId.isBlank() ? null : actorUserId;
    }

    /**
     * Round-4: every successful credential response is non-cacheable
     * (0496 design §方案 6 — no-store).
     */
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

    private static ResponseEntity<?> notFound(RuntimeException e) {
        return ProblemDetailsHandler.problemResponse(HttpStatus.NOT_FOUND, "CREDENTIAL_NOT_FOUND", e.getMessage());
    }

    private static ResponseEntity<?> conflict(RuntimeException e) {
        return ProblemDetailsHandler.problemResponse(HttpStatus.CONFLICT, "CREDENTIAL_CONFLICT", e.getMessage());
    }

    private static ResponseEntity<?> badRequest(IllegalArgumentException e) {
        return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", e.getMessage());
    }

    private static Map<String, Object> credentialView(Credential credential) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("id", credential.getId().toString());
        body.put("label", credential.getLabel());
        body.put("kind", credential.getKind());
        body.put("deliveryTier", credential.getDeliveryTier());
        body.put("ownerType", credential.getOwnerType());
        body.put("ownerId", credential.getOwnerId());
        body.put("status", credential.getStatus());
        body.put("fingerprint", credential.getFingerprint());
        body.put("revision", credential.getRevision());
        body.put("createdAt", credential.getCreatedAt() == null ? null : credential.getCreatedAt().toString());
        body.put("replacedAt", credential.getReplacedAt() == null ? null : credential.getReplacedAt().toString());
        return body;
    }

    public record CreateCredentialRequest(String ownerType, String ownerId, String label, String kind,
            String deliveryTier, String token, String accessKey, String secretKey) {
        CredentialService.SecretPayload toPayload() {
            if (token != null && !token.isBlank()) {
                return CredentialService.SecretPayload.ofToken(token);
            }
            return CredentialService.SecretPayload.ofKeyPair(accessKey, secretKey);
        }
    }

    public record ReplaceSecretRequest(String token, String accessKey, String secretKey) {
        CredentialService.SecretPayload toPayload() {
            if (token != null && !token.isBlank()) {
                return CredentialService.SecretPayload.ofToken(token);
            }
            return CredentialService.SecretPayload.ofKeyPair(accessKey, secretKey);
        }
    }

    public record BindRequest(String workspaceId, List<String> agentPrincipalIds) {}

    public record RevealRequest(String password) {}
}
