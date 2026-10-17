package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.WorkspaceLifecycleOperation;
import com.cc01cc.p.xihe.cp.operation.JobStateService;
import com.cc01cc.p.xihe.cp.repository.WorkspaceLifecycleOperationRepository;
import com.cc01cc.p.xihe.cp.runtime.RuntimeWorkspaceClient;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.context.ApplicationContext;

import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0391 (decisions #27/#30): release orchestration contract —
 * idempotent replay → active-Job / in-flight gate → durable accepted →
 * Runtime dispatch → settle.
 *
 * <p>Authorization is done by the controller entry (PLAN-0470 style); this unit
 * test passes a resolved userId directly.</p>
 */
class WorkspaceRuntimeReleaseServiceTest {

    private static final String WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
    private static final String USER_ID = "33333333-3333-3333-3333-333333333333";

    private WorkspaceLifecycleOperationRepository operations;
    private JobStateService jobStateService;
    private RuntimeWorkspaceClient runtimeWorkspaceClient;
    private ApplicationContext applicationContext;
    private WorkspaceRuntimeReleaseService service;
    private WorkspaceLifecycleOperation saved;

    @BeforeEach
    void setUp() {
        operations = Mockito.mock(WorkspaceLifecycleOperationRepository.class);
        jobStateService = Mockito.mock(JobStateService.class);
        runtimeWorkspaceClient = Mockito.mock(RuntimeWorkspaceClient.class);
        applicationContext = Mockito.mock(ApplicationContext.class);
        service = new WorkspaceRuntimeReleaseService(operations, jobStateService,
                runtimeWorkspaceClient, applicationContext);
        when(applicationContext.getBean(WorkspaceRuntimeReleaseService.class)).thenReturn(service);

        when(operations.findByUserIdAndWorkspaceIdAndIdempotencyKey(any(), any(), any()))
                .thenReturn(Optional.empty());
        when(operations.findFirstByWorkspaceIdAndStatusIn(any(), any())).thenReturn(Optional.empty());
        when(jobStateService.hasRunningForWorkspace(any())).thenReturn(false);
        when(operations.save(any())).thenAnswer(invocation -> {
            saved = invocation.getArgument(0);
            return saved;
        });
        when(operations.findByIdForUpdate(any())).thenAnswer(invocation -> Optional.of(saved));
        when(operations.findById(any())).thenAnswer(invocation -> Optional.of(saved));
    }

    @Test
    void rejectsMissingIdempotencyKey() {
        CpApiException error = assertThrows(CpApiException.class,
                () -> service.release(WORKSPACE_ID, USER_ID, "  "));
        assertEquals("IDEMPOTENCY_KEY_REQUIRED", error.getCode());
        assertEquals(400, error.getStatus().value());
    }

    @Test
    void rejectsOverlongIdempotencyKey() {
        CpApiException error = assertThrows(CpApiException.class,
                () -> service.release(WORKSPACE_ID, USER_ID, "k".repeat(129)));
        assertEquals("INVALID_REQUEST", error.getCode());
    }

    @Test
    void idempotentReplayReturnsExistingWithoutDispatch() {
        WorkspaceLifecycleOperation existing = new WorkspaceLifecycleOperation();
        existing.setId(UUID.randomUUID());
        existing.setWorkspaceId(UUID.fromString(WORKSPACE_ID));
        existing.setStatus(WorkspaceLifecycleOperation.STATUS_COMPLETED);
        existing.setReason("USER_RELEASED");
        when(operations.findByUserIdAndWorkspaceIdAndIdempotencyKey(
                UUID.fromString(USER_ID), UUID.fromString(WORKSPACE_ID), "k1"))
                .thenReturn(Optional.of(existing));

        WorkspaceRuntimeReleaseService.ReleaseOutcome outcome =
                service.release(WORKSPACE_ID, USER_ID, "k1");

        assertTrue(outcome.replayed());
        assertEquals(existing.getId().toString(), outcome.operation().get("releaseOperationId"));
        verify(runtimeWorkspaceClient, never()).release(any(), any());
    }

    @Test
    void activeJobBlocksRelease() {
        when(jobStateService.hasRunningForWorkspace(WORKSPACE_ID)).thenReturn(true);
        CpApiException error = assertThrows(CpApiException.class,
                () -> service.release(WORKSPACE_ID, USER_ID, "k1"));
        assertEquals("WORKSPACE_BUSY", error.getCode());
        assertEquals(409, error.getStatus().value());
        verify(runtimeWorkspaceClient, never()).release(any(), any());
    }

    @Test
    void inFlightReleaseBlocksSecondRequest() {
        when(operations.findFirstByWorkspaceIdAndStatusIn(any(), any()))
                .thenReturn(Optional.of(new WorkspaceLifecycleOperation()));
        CpApiException error = assertThrows(CpApiException.class,
                () -> service.release(WORKSPACE_ID, USER_ID, "k1"));
        assertEquals("WORKSPACE_BUSY", error.getCode());
        verify(runtimeWorkspaceClient, never()).release(any(), any());
    }

    @Test
    void successfulReleaseMarksCompletedAndDispatchesOperationId() {
        when(runtimeWorkspaceClient.release(eq(WORKSPACE_ID), anyString()))
                .thenReturn(new RuntimeWorkspaceClient.ReleaseResult(200,
                        Map.of("released", true, "cleaned", true, "cleanupFailed", false),
                        null, null, false));

        WorkspaceRuntimeReleaseService.ReleaseOutcome outcome =
                service.release(WORKSPACE_ID, USER_ID, "k1");

        assertFalse(outcome.replayed());
        assertEquals(WorkspaceLifecycleOperation.STATUS_COMPLETED, saved.getStatus());
        assertEquals("USER_RELEASED", saved.getReason());
        assertEquals(null, saved.getErrorCode());
        verify(runtimeWorkspaceClient).release(eq(WORKSPACE_ID), eq(saved.getId().toString()));
    }

    @Test
    void cleanupFailedMarksFailed() {
        when(runtimeWorkspaceClient.release(eq(WORKSPACE_ID), anyString()))
                .thenReturn(new RuntimeWorkspaceClient.ReleaseResult(200,
                        Map.of("released", true, "cleaned", false, "cleanupFailed", true),
                        null, null, false));

        service.release(WORKSPACE_ID, USER_ID, "k1");

        assertEquals(WorkspaceLifecycleOperation.STATUS_FAILED, saved.getStatus());
        assertEquals("CLEANUP_FAILED", saved.getErrorCode());
    }

    @Test
    void unreachableRuntimeMarksFailedAndReturns502() {
        when(runtimeWorkspaceClient.release(eq(WORKSPACE_ID), anyString()))
                .thenReturn(new RuntimeWorkspaceClient.ReleaseResult(null, null, null, null, true));

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.release(WORKSPACE_ID, USER_ID, "k1"));

        assertEquals("RUNTIME_UNAVAILABLE", error.getCode());
        assertEquals(502, error.getStatus().value());
        assertEquals(WorkspaceLifecycleOperation.STATUS_FAILED, saved.getStatus());
        assertEquals("RUNTIME_UNAVAILABLE", saved.getErrorCode());
    }

    @Test
    void retryableRuntimeConflictDiscardsOperationWithoutConsumingKey() {
        when(runtimeWorkspaceClient.release(eq(WORKSPACE_ID), anyString()))
                .thenReturn(new RuntimeWorkspaceClient.ReleaseResult(409, null,
                        "WORKSPACE_BUSY", "active job", false));

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.release(WORKSPACE_ID, USER_ID, "k1"));

        assertEquals("WORKSPACE_BUSY", error.getCode());
        assertEquals(409, error.getStatus().value());
        // The accepted row is discarded so a same-key retry can dispatch again.
        verify(operations).deleteById(saved.getId());
    }

    @Test
    void nonRetryableRuntimeProblemSettlesFailed() {
        when(runtimeWorkspaceClient.release(eq(WORKSPACE_ID), anyString()))
                .thenReturn(new RuntimeWorkspaceClient.ReleaseResult(502, null,
                        "SANDBOX_NOT_FOUND", "gone", false));

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.release(WORKSPACE_ID, USER_ID, "k1"));

        assertEquals("SANDBOX_NOT_FOUND", error.getCode());
        assertEquals(WorkspaceLifecycleOperation.STATUS_FAILED, saved.getStatus());
        verify(operations, never()).deleteById(any());
    }
}
