package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import org.springframework.context.annotation.Profile;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0536: control surface for {@link E2eGuidanceBarrier}.
 *
 * <p>Registered only under the {@code e2e} profile, so the routes do not exist
 * for {@code dev} or {@code prod}. Sitting under {@code /internal/v1/**} means
 * {@code SecurityConfig} already restricts every call to
 * {@code ROLE_INTERNAL_SERVICE}, which only the runner-issued service token can
 * obtain — a normal user JWT is rejected by the security chain before reaching
 * this class.
 *
 * <p>Frozen contract:
 * {@code plans/archive/PLAN-0536-xh-guidance-race-error-e2e/spec/e2e-guidance-barrier.md}.
 */
@RestController
@Profile("e2e")
@RequestMapping("/internal/v1/e2e/guidance-barrier")
public class E2eGuidanceBarrierController {

    private final E2eGuidanceBarrier barrier;

    public E2eGuidanceBarrierController(E2eGuidanceBarrier barrier) {
        this.barrier = barrier;
    }

    public record ArmRequest(String e2eRunId, Long holdMs) {
    }

    @PostMapping("/{runId}/arm")
    public ResponseEntity<?> arm(@PathVariable String runId, @RequestBody(required = false) ArmRequest request) {
        try {
            if (request == null) {
                throw new CpApiException(HttpStatus.BAD_REQUEST,
                        "E2E_BARRIER_RUN_ID_REQUIRED", "e2eRunId is required");
            }
            UUID run = parseRunId(runId);
            barrier.arm(run, request.e2eRunId(), request.holdMs() == null ? 30_000 : request.holdMs());
            return ResponseEntity.ok(Map.of("runId", run.toString(), "e2eRunId", request.e2eRunId(),
                    "state", "armed"));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @GetMapping("/{runId}")
    public ResponseEntity<?> status(@PathVariable String runId,
                                    @RequestParam(value = "e2eRunId", required = false) String e2eRunId) {
        try {
            return ResponseEntity.ok(barrier.status(parseRunId(runId), e2eRunId));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @PostMapping("/{runId}/release")
    public ResponseEntity<?> release(@PathVariable String runId,
                                     @RequestParam(value = "e2eRunId", required = false) String e2eRunId) {
        try {
            UUID run = parseRunId(runId);
            if (!barrier.release(run, e2eRunId)) {
                return ProblemDetailsHandler.problemResponse(HttpStatus.NOT_FOUND,
                        "E2E_BARRIER_NOT_FOUND", "No guidance barrier is armed for this run");
            }
            return ResponseEntity.ok(Map.of("runId", run.toString(), "state", "released"));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    private static UUID parseRunId(String value) {
        try {
            return UUID.fromString(value);
        } catch (RuntimeException invalid) {
            throw new CpApiException(HttpStatus.BAD_REQUEST,
                    "E2E_BARRIER_RUN_ID_INVALID", "runId must be a UUID");
        }
    }
}
