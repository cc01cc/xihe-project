package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.ChatRunProviderRequest;
import com.cc01cc.p.xihe.cp.repository.ChatRunProviderRequestRepository;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.cc01cc.p.xihe.cp.util.JacksonNodeExit;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

/**
 * PLAN-0679 T2.3: read-only provider-request fingerprint + two-run diff (design D6).
 *
 * <p>Sits next to the run read surfaces ({@code /api/v1/chat/runs/{runId}/context-fingerprint},
 * PLAN-0666) — one route carries both behaviours: without {@code against} the run's fingerprint
 * envelope, with {@code against} the per-layer diff of the two requests. Authorization reuses the
 * exact run-trace gate (run identity + {@code SessionService.requireCurrent}); no new permission
 * atom is introduced (design D6).</p>
 *
 * <p>The read path is intentionally thin: run identity and ownership resolve through the same
 * service as every other run read, so the workspace/ownership check cannot drift from RunTrace.
 * Jackson-2 nodes leave the control plane only through {@link JacksonNodeExit#toDocument(ObjectNode)}
 * (PLAN-0633 C1).</p>
 */
@RestController
public class RunProviderRequestFingerprintController {

    private final ChatRunReadService chatRunReadService;
    private final ChatRunProviderRequestRepository providerRequestRepository;
    private final SessionService sessionService;

    public RunProviderRequestFingerprintController(ChatRunReadService chatRunReadService,
                                                   ChatRunProviderRequestRepository providerRequestRepository,
                                                   SessionService sessionService) {
        this.chatRunReadService = chatRunReadService;
        this.providerRequestRepository = providerRequestRepository;
        this.sessionService = sessionService;
    }

    @PreAuthorize("isAuthenticated()")
    @GetMapping("/api/v1/chat/runs/{runId}/provider-request-fingerprint")
    public ResponseEntity<?> getFingerprint(@PathVariable String runId,
                                            @RequestParam(required = false) String against) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.workspaceContextRequired();
        }
        try {
            ChatRun run = requireRun(runId, userId, workspaceId);
            ProviderRequestFingerprintReadService.View current = viewOf(run);
            if (against == null || against.isBlank()) {
                return ResponseEntity.ok(
                        JacksonNodeExit.toDocument(ProviderRequestFingerprintReadService.envelope(current)));
            }
            ChatRun baseline = requireRun(against, userId, workspaceId);
            ProviderRequestFingerprintReadService.View baselineView = viewOf(baseline);
            if (!baseline.getSessionId().equals(run.getSessionId())) {
                throw new CpApiException(HttpStatus.CONFLICT, "DIFF_SESSION_MISMATCH",
                        "Provider-request fingerprints from different sessions are not comparable");
            }
            ObjectNode diff = ProviderRequestFingerprintReadService.diff(baselineView, current);
            return ResponseEntity.ok(JacksonNodeExit.toDocument(diff));
        } catch (CpApiException exception) {
            return ProblemDetailsHandler.problemResponse(
                    exception.getStatus(), exception.getCode(), exception.getMessage());
        }
    }

    private ChatRun requireRun(String runId, String userId, String workspaceId) {
        UUID runUuid;
        try {
            runUuid = UUID.fromString(runId);
        } catch (IllegalArgumentException exception) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "RUN_NOT_FOUND", "Chat run not found");
        }
        // 404-vs-403 order stays inside the service (unknown ⇒ 404 before owner ⇒ 403); the
        // session-level gate stays here because it must run *after* the owner gate, exactly as before.
        ChatRun found = chatRunReadService.requireOwnedRun(runUuid, userId, workspaceId);
        sessionService.requireCurrent(found.getSessionId(), userId, workspaceId);
        return found;
    }

    /**
     * Row presence is the only truth. There is no "submitted but not yet captured" state to name:
     * the diagnostics event travels with the dispatch, so between capture and absence the run is
     * simply not captured yet (envelope reason {@code not_captured}, two-level model).
     */
    private ProviderRequestFingerprintReadService.View viewOf(ChatRun run) {
        return providerRequestRepository.findById(run.getId())
                .map(row -> ProviderRequestFingerprintReadService.captured(
                        run.getId().toString(),
                        run.getSessionId(),
                        row.getFingerprint(),
                        metadataOf(row)))
                .orElseGet(() -> ProviderRequestFingerprintReadService.absent(
                        run.getId().toString(), run.getSessionId()));
    }

    private static ProviderRequestFingerprintReadService.Metadata metadataOf(ChatRunProviderRequest row) {
        return new ProviderRequestFingerprintReadService.Metadata(
                row.getApiTypeId(),
                row.getApiTypeVersion(),
                row.getModel(),
                row.getMessageCount(),
                row.getToolCount(),
                row.getBytesTotal(),
                row.getRoleHistogram(),
                row.getSystemSources(),
                row.getDispatchAttempt(),
                row.getProviderStep());
    }
}
