package com.cc01cc.p.xihe.cp.credentials;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * PLAN-0495 M3: operations surface for credential key rotation
 * ({@code /internal/v1/**} → role INTERNAL_SERVICE, service Bearer). Consumed
 * by the {@code xihe-cli} {@code credential rotate} sub-command; never exposed
 * on the user API plane.
 */
@RestController
@RequestMapping("/internal/v1/credentials/rotation")
public class CredentialRotationController {

    private final CredentialRotationService rotation;

    public CredentialRotationController(CredentialRotationService rotation) {
        this.rotation = rotation;
    }

    @GetMapping("/status")
    public CredentialRotationService.RotationStatus status() {
        return rotation.status();
    }

    @PostMapping("/runs")
    public CredentialRotationService.BatchResult runBatch(
            @Valid @RequestBody(required = false) BatchRunRequest request) {
        int batchSize = request == null || request.batchSize() == null
                ? CredentialRotationService.DEFAULT_BATCH_SIZE
                : request.batchSize();
        return rotation.rotateBatch(batchSize);
    }

    /** Round-4: out-of-range values fail with 400 instead of a silent clamp. */
    public record BatchRunRequest(@Min(1) @Max(500) Integer batchSize) {}
}
