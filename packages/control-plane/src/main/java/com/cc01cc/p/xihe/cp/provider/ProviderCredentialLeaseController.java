package com.cc01cc.p.xihe.cp.provider;

import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/internal/v1/provider-leases")
public class ProviderCredentialLeaseController {

    private static final Logger logger = LoggerFactory.getLogger(ProviderCredentialLeaseController.class);

    private final ProviderCredentialLeaseService leases;

    public ProviderCredentialLeaseController(ProviderCredentialLeaseService leases) {
        this.leases = leases;
    }

    @PostMapping("/redeem")
    public ResponseEntity<?> redeem(@RequestBody RedeemRequest request) {
        try {
            return ResponseEntity.ok(leases.redeem(new ProviderCredentialLeaseService.RedeemRequest(
                    request.lease(), request.runId(), request.providerConnectionId(),
                    request.providerId(), request.model(), request.connectionRevision())));
        } catch (IllegalArgumentException e) {
            logger.warn("Provider credential lease redeem rejected errorCode={}", e.getMessage());
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.CONFLICT, "PROVIDER_CREDENTIAL_LEASE_INVALID", e.getMessage());
        }
    }

    public record RedeemRequest(
            String lease,
            String runId,
            String providerConnectionId,
            String providerId,
            String model,
            long connectionRevision) {}
}
