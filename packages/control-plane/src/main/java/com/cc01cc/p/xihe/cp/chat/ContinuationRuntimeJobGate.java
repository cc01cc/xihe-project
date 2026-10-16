package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.WorkspaceJob;
import com.cc01cc.p.xihe.cp.mcp.LineageInvocationService;
import com.cc01cc.p.xihe.cp.operation.JobStateService;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/** Fail-closed Runtime side-effect gate for ChatRun continuation admission. */
@Service
class ContinuationRuntimeJobGate {
    private final JobStateService jobStateService;

    ContinuationRuntimeJobGate(JobStateService jobStateService) {
        this.jobStateService = jobStateService;
    }

    void requireEligible(ChatRun sourceRun, List<String> lineageRunIds) {
        if (lineageRunIds == null || lineageRunIds.isEmpty()
                || lineageRunIds.size() > LineageInvocationService.MAX_COMPLETED_TOOL_CALL_IDS) {
            throw unresolved();
        }
        Set<UUID> uniqueRunIds = new HashSet<>();
        List<UUID> runIds = new ArrayList<>(lineageRunIds.size());
        for (String value : lineageRunIds) {
            if (value == null) {
                throw unresolved();
            }
            try {
                UUID runId = UUID.fromString(value);
                if (!runId.toString().equals(value) || !uniqueRunIds.add(runId)) {
                    throw unresolved();
                }
                runIds.add(runId);
            } catch (IllegalArgumentException e) {
                throw unresolved();
            }
        }
        if (!uniqueRunIds.contains(sourceRun.getId())) {
            throw unresolved();
        }

        for (UUID runId : runIds) {
            List<WorkspaceJob> jobs = jobStateService.listByRun(runId.toString());
            if (jobs == null) {
                throw unresolved();
            }
            for (WorkspaceJob job : jobs) {
                if (job == null || job.getRunId() == null || !runId.equals(job.getRunId())
                        || !sourceRun.getSessionId().equals(string(job.getSessionId()))
                        || !sourceRun.getUserId().equals(string(job.getUserId()))
                        || !sourceRun.getWorkspaceId().equals(string(job.getWorkspaceId()))
                        || !JobStateService.SCOPE_RUN.equals(job.getScope())) {
                    throw unresolved();
                }
                switch (job.getStatus() == null ? "" : job.getStatus()) {
                    case "succeeded", "cancelled", "timeout" -> {
                        // A known terminal Runtime outcome is only eligible for
                        // the Agent's exact-checkpoint safe ToolMessage preflight.
                        // CP never infers reusable output from the status itself.
                    }
                    case "pending", "running", "interrupted", "orphaned", "" -> throw unresolved();
                    default -> throw reconciliationRequired();
                }
            }
        }
        // A terminal row is only eligible for Agent-side preflight, which must
        // prove a matching safe typed ToolMessage exists in this exact checkpoint
        // before the graph or any tool adapter can run. CP cannot decode the
        // opaque checkpoint payload to make that assertion itself.
    }

    private static String string(java.util.UUID value) {
        return value == null ? null : value.toString();
    }

    private static CpApiException unresolved() {
        return new CpApiException(HttpStatus.CONFLICT, "CONTINUATION_SIDE_EFFECT_UNRESOLVED",
                "Runtime side effects cannot be proven safe from the selected checkpoint");
    }

    private static CpApiException reconciliationRequired() {
        return new CpApiException(HttpStatus.CONFLICT, "RECONCILIATION_REQUIRED",
                "Runtime job status is outside the known terminal outcome contract");
    }
}
