package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.runtime.RuntimeJobClient;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/** Owns Runtime cancellation decisions and their canonical durable Job transition. */
@Service
public class WorkspaceJobCancellationService {

    private final JobStateService jobStateService;
    private final RuntimeJobClient runtimeJobClient;

    public WorkspaceJobCancellationService(JobStateService jobStateService, RuntimeJobClient runtimeJobClient) {
        this.jobStateService = jobStateService;
        this.runtimeJobClient = runtimeJobClient;
    }

    public CancelOutcome cancel(UUID domainJobId, String workspaceId) {
        JobStateService.JobArchive archive = jobStateService.findOwned(domainJobId, workspaceId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "JOB_ARCHIVE_NOT_FOUND",
                        "No job archive for this job"));
        if (archive.terminal()) {
            return new CancelOutcome(archive.status(), false);
        }

        RuntimeJobClient.JobCancelResult result = runtimeJobClient.cancelJob(
                archive.workspaceId(), archive.jobId());
        if (!result.reachable()) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "RUNTIME_UNAVAILABLE", "Runtime job cancel failed");
        }
        if (result.errorCode() != null && result.statusCode() != 404) {
            HttpStatus status = HttpStatus.resolve(result.statusCode());
            if (status == null || status.is2xxSuccessful()) {
                status = HttpStatus.BAD_GATEWAY;
            }
            throw new CpApiException(status, result.errorCode(),
                    result.reason() == null || result.reason().isBlank()
                            ? "Runtime job request failed" : result.reason(),
                    result.requestId());
        }
        if (!result.found()) {
            Map<String, Object> incoming = new LinkedHashMap<>();
            incoming.put("status", "orphaned");
            incoming.put("cancelReason", JobStateService.REASON_JOB_MISSING);
            jobStateService.upsertByIdOrThrow(domainJobId, incoming);
            return new CancelOutcome("orphaned", true);
        }
        if ("failed".equals(result.status())) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "JOB_CANCEL_UNCONFIRMED",
                    "Job termination was not confirmed");
        }
        Map<String, Object> incoming = new LinkedHashMap<>();
        incoming.put("status", "cancelled");
        incoming.put("cancelReason", JobStateService.REASON_USER_CANCEL);
        jobStateService.upsertByIdOrThrow(domainJobId, incoming);
        return new CancelOutcome("cancelled", true);
    }

    public record CancelOutcome(String status, boolean changed) {
    }
}
