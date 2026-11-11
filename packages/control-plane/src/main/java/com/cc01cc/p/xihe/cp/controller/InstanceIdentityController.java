package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.service.InstanceIdentityService;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * PLAN-0767 M1-2 contract, M1-3 implementation: {@code GET /api/v1/instance/identity}.
 *
 * <p>The admin identity card is exactly {@code {instanceId, createdAt, schemaVersion}}; module
 * versions stay on {@code GET /api/v1/version}, {@code ownerPrincipalId} and the boot-time env
 * override are deliberately absent (spec §5 / §8.3). {@code schemaVersion} is always null in M1
 * (the read DTO does not produce it until M2). The route is gated by the instance-scope
 * {@code READ_INSTANCE_CONTENT} action atom; a missing/invalid credential is answered by the JWT
 * filter (401) before this method runs.
 */
@RestController
@RequestMapping("/api/v1/instance")
public class InstanceIdentityController {

    public record InstanceIdentityView(String instanceId, String createdAt, String schemaVersion) {}

    private final InstanceIdentityService identity;

    public InstanceIdentityController(InstanceIdentityService identity) {
        this.identity = identity;
    }

    @PreAuthorize("@requesterAuthority.holdsActionAtom('READ_INSTANCE_CONTENT')")
    @GetMapping("/identity")
    public ResponseEntity<InstanceIdentityView> get() {
        return ResponseEntity.ok(new InstanceIdentityView(
                identity.instanceId().toString(),
                identity.createdAt().toString(),
                InstanceIdentityService.SCHEMA_VERSION));
    }
}
