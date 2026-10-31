package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.auth.ClientIpResolver;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.service.InstanceOwnershipService;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Instant;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * PLAN-0580: the instance-ownership surface
 * (spec {@code api-instance-ownership-contract.md} §3/§4).
 *
 * <pre>
 * GET /api/v1/instance/owner   authenticated: who owns the instance, and am I it
 * PUT /api/v1/instance/owner   current owner + password: hand the pointer over
 * </pre>
 *
 * <p>The GET response deliberately carries <b>no</b> account identifiers
 * ({@code username}/{@code email}/{@code name}): {@code /api/v1/users*} is
 * ADMIN-only in PLAN-0581, so exposing the owner's handle to every authenticated
 * USER would be an account-enumeration side channel (decision #22 / round-1 F9).
 * {@code isCurrentUser} is the only thing the non-admin UI needs.
 */
@RestController
@RequestMapping("/api/v1/instance")
public class InstanceOwnerController {

    /** Wire view; {@code null} fields mean "the instance has no owner yet". */
    public record OwnerView(String ownerUserId, String assignedAt, boolean isCurrentUser) {}

    /** Transfer body: target account plus the caller's password (re-authentication). */
    public record TransferRequest(String targetUserId, String password) {}

    private final InstanceOwnershipService ownership;
    private final ClientIpResolver clientIpResolver;

    public InstanceOwnerController(InstanceOwnershipService ownership,
                                   ClientIpResolver clientIpResolver) {
        this.ownership = ownership;
        this.clientIpResolver = clientIpResolver;
    }

    @GetMapping("/owner")
    public ResponseEntity<OwnerView> get() {
        return ResponseEntity.ok(view(ownership.current(), callerId()));
    }

    @PutMapping("/owner")
    public ResponseEntity<OwnerView> transfer(@RequestBody(required = false) TransferRequest request,
                                              HttpServletRequest httpRequest) {
        if (request == null || isBlank(request.targetUserId()) || isBlank(request.password())) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "targetUserId and password are required");
        }
        UUID targetUserId;
        try {
            targetUserId = UUID.fromString(request.targetUserId().trim());
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "targetUserId must be a UUID", e);
        }
        InstanceOwnershipService.OwnerState state = ownership.transfer(
                callerId(), targetUserId, request.password(), clientIpResolver.resolve(httpRequest));
        return ResponseEntity.ok(view(state, callerId()));
    }

    private static OwnerView view(InstanceOwnershipService.OwnerState state, String callerId) {
        return new OwnerView(
                state.ownerUserId() == null ? null : state.ownerUserId().toString(),
                state.assignedAt() == null ? null : state.assignedAt().toString(),
                state.belongsTo(callerId));
    }

    /** The JWT filter already authenticated this request; TenantContext carries the user id. */
    static String callerId() {
        String userId = TenantContext.getUserId();
        if (userId == null || userId.isBlank()) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED",
                    "Authorization required");
        }
        return userId;
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    /** Exposed for the contract test: {@code assignedAt} is ISO-8601 text on the wire. */
    static String isoOrNull(Instant instant) {
        return instant == null ? null : instant.toString();
    }
}
