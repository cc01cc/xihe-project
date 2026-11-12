package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.credentials.CredentialNotFoundException;
import com.cc01cc.p.xihe.cp.credentials.CredentialWireView;
import com.cc01cc.p.xihe.cp.entity.Credential;
import com.cc01cc.p.xihe.cp.policy.CredentialAdminService;
import com.cc01cc.p.xihe.cp.policy.CredentialRevealService;
import com.cc01cc.p.xihe.cp.policy.InstanceCredentialService;
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

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0771 M3 (contract {@code 37e7ddd8} / D-932 contract-first, D-1009): the instance credential
 * surface — {@code GET/POST /api/v1/instance/credentials},
 * {@code GET/DELETE /api/v1/instance/credentials/{id}},
 * {@code POST /api/v1/instance/credentials/{id}/reveal}.
 *
 * <p>The four contract constraints this class implements verbatim:</p>
 * <ol>
 *   <li>{@code cap:instance:admin} on every path (the atom layer underneath is unchanged:
 *       {@code credential_manage@credential:*} for register, {@code credential_manage@credential:<id>}
 *       for delete, {@code credential_reveal@credential:<id>} for reveal);</li>
 *   <li>a row that is not INSTANCE-owned is answered <b>404 {@code CREDENTIAL_NOT_FOUND}</b>, the
 *       identical answer a missing row gives (no cross-owner existence oracle);</li>
 *   <li>create rejects {@code ownerType}/{@code ownerId} with 400 {@code INVALID_REQUEST} — an
 *       instance row has no owner id to address;</li>
 *   <li>reveal has no owner intersection to apply, so its gate is the atom plus the instance-admin
 *       capability, with step-up / 5-failures-in-15-minutes / no-store / audit unchanged.</li>
 * </ol>
 *
 * <p>No REST surface for anything else lives here: there is deliberately no promote/import
 * operation (D-1009 2/3 — a user or workspace credential can never become an instance one).</p>
 */
@RestController
@RequestMapping("/api/v1/instance/credentials")
public class InstanceCredentialController {

    private final InstanceCredentialService instanceCredentials;

    public InstanceCredentialController(InstanceCredentialService instanceCredentials) {
        this.instanceCredentials = instanceCredentials;
    }

    /** Contract constraint 1 — list is gated by the capability atom only. */
    @PreAuthorize("@requesterAuthority.holdsCapabilityAtom('instance:admin')")
    @GetMapping
    public ResponseEntity<?> list() {
        String actorUserId = requireActor();
        if (actorUserId == null) {
            return unauthorized();
        }
        try {
            List<CredentialAdminService.CredentialSummary> credentials = instanceCredentials.list(actorUserId);
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("credentials", credentials);
            body.put("count", credentials.size());
            return noStore(ResponseEntity.ok(body));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    /** Contract constraints 1 + 3: cap + credential_manage@credential:*, and no owner coordinates. */
    @PreAuthorize("@requesterAuthority.holdsCapabilityAtom('instance:admin')")
    @PostMapping
    public ResponseEntity<?> create(@RequestBody InstanceCredentialService.CreateInstanceCredentialRequest request) {
        String actorUserId = requireActor();
        if (actorUserId == null) {
            return unauthorized();
        }
        try {
            Credential created = instanceCredentials.create(actorUserId, request);
            return noStore(ResponseEntity.status(HttpStatus.CREATED).body(CredentialWireView.toWire(created)));
        } catch (CpApiException e) {
            return problem(e);
        } catch (IllegalArgumentException e) {
            return badRequest(e);
        }
    }

    /** Contract constraints 1 + 2: cap only, and a non-INSTANCE row is indistinguishable from missing. */
    @PreAuthorize("@requesterAuthority.holdsCapabilityAtom('instance:admin')")
    @GetMapping("/{id}")
    public ResponseEntity<?> get(@PathVariable("id") String id) {
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
            Credential credential = instanceCredentials.requireInstanceRow(credentialId);
            return noStore(ResponseEntity.ok(CredentialWireView.toWire(credential)));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    /** Contract constraints 1 + 2: cap + credential_manage@credential:&lt;id&gt;, non-INSTANCE ⇒ 404. */
    @PreAuthorize("@requesterAuthority.holdsCapabilityAtom('instance:admin')")
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
            CredentialAdminService.DeleteReport report = instanceCredentials.delete(actorUserId, credentialId);
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("id", report.id());
            body.put("deleted", true);
            body.put("references", report.references());
            return noStore(ResponseEntity.ok(body));
        } catch (CpApiException e) {
            return problem(e);
        } catch (CredentialNotFoundException e) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.NOT_FOUND,
                    "CREDENTIAL_NOT_FOUND", e.getMessage());
        }
    }

    /**
     * Contract constraints 1 + 2 + 4: cap + credential_reveal@credential:&lt;id&gt; (instance scope) +
     * the unchanged step-up/throttle/audit shape; the plaintext is carried once and never cacheable.
     */
    @PreAuthorize("@requesterAuthority.holdsCapabilityAtom('instance:admin')")
    @PostMapping("/{id}/reveal")
    public ResponseEntity<?> reveal(@PathVariable("id") String id,
                                    @RequestBody(required = false) RevealRequest request) {
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
            CredentialRevealService.RevealedCredential revealed =
                    instanceCredentials.reveal(actorUserId, credentialId,
                            request == null ? null : request.password());
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("credentialId", revealed.credentialId());
            body.put("revision", revealed.revision());
            body.put("value", revealed.plaintext());
            return noStore(ResponseEntity.ok(body));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    private static String requireActor() {
        String actorUserId = TenantContext.getUserId();
        return actorUserId == null || actorUserId.isBlank() ? null : actorUserId;
    }

    /** Every successful credential response is non-cacheable (contract: reveal carries a plaintext). */
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

    private static ResponseEntity<?> badRequest(IllegalArgumentException e) {
        return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", e.getMessage());
    }

    public record RevealRequest(String password) {}
}
