package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.WorkspaceJob;
import com.cc01cc.p.xihe.cp.operation.JobStateService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ContinuationRuntimeJobGateTest {
    @Mock private JobStateService jobStateService;

    private final String sessionId = UUID.randomUUID().toString();
    private final String userId = UUID.randomUUID().toString();
    private final String workspaceId = UUID.randomUUID().toString();
    private final ChatRun source = new ChatRun(UUID.randomUUID().toString(), sessionId, userId, workspaceId,
            "source-key", "source-hash", "provider", "model", "workspace", "ambiguous");
    private ContinuationRuntimeJobGate gate;

    @BeforeEach
    void setUp() {
        gate = new ContinuationRuntimeJobGate(jobStateService);
    }

    @Test
    void knownTerminalOutcomesDeferResultSafetyToAgentCheckpointPreflight() {
        when(jobStateService.listByRun(source.getId().toString())).thenReturn(List.of(
                job("succeeded"), job("timeout"), job("cancelled")));

        gate.requireEligible(source, List.of(source.getId().toString()));
    }

    @Test
    void activeAndUnresolvedTerminalStatesBlockAdmission() {
        for (String status : List.of("pending", "running", "interrupted", "orphaned")) {
            when(jobStateService.listByRun(source.getId().toString())).thenReturn(List.of(job(status)));
            CpApiException error = assertThrows(CpApiException.class,
                    () -> gate.requireEligible(source, List.of(source.getId().toString())));
            assertEquals("CONTINUATION_SIDE_EFFECT_UNRESOLVED", error.getCode(), status);
        }
    }

    @Test
    void unknownStatusFailsClosedForReconciliation() {
        when(jobStateService.listByRun(source.getId().toString())).thenReturn(List.of(job("future-state")));

        CpApiException error = assertThrows(CpApiException.class,
                () -> gate.requireEligible(source, List.of(source.getId().toString())));

        assertEquals("RECONCILIATION_REQUIRED", error.getCode());
    }

    @Test
    void unresolvedJobFromAnEarlierLineageRunBlocksContinuation() {
        String earlierRunId = UUID.randomUUID().toString();
        when(jobStateService.listByRun(earlierRunId)).thenReturn(List.of(job(earlierRunId, "running")));

        CpApiException error = assertThrows(CpApiException.class, () -> gate.requireEligible(
                source, List.of(earlierRunId, source.getId().toString())));

        assertEquals("CONTINUATION_SIDE_EFFECT_UNRESOLVED", error.getCode());
    }

    private WorkspaceJob job(String status) {
        return job(source.getId().toString(), status);
    }

    private WorkspaceJob job(String runId, String status) {
        WorkspaceJob job = new WorkspaceJob();
        job.setRunId(UUID.fromString(runId));
        job.setSessionId(UUID.fromString(sessionId));
        job.setUserId(UUID.fromString(userId));
        job.setWorkspaceId(UUID.fromString(workspaceId));
        job.setScope(JobStateService.SCOPE_RUN);
        job.setStatus(status);
        return job;
    }
}
