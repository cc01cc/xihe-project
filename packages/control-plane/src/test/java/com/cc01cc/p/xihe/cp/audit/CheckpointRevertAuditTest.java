package com.cc01cc.p.xihe.cp.audit;

import org.junit.jupiter.api.Test;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.TransactionStatus;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.function.Consumer;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

/** task-548：回滚进 audit_logs —— 能回答谁/哪个 checkpoint/结果，且写失败不阻断回滚。 */
class CheckpointRevertAuditTest {

    private static final String CHECKPOINT_ID = "33333333-3333-3333-3333-333333333333";

    private static TransactionTemplate passThrough() {
        TransactionTemplate template = mock(TransactionTemplate.class);
        doAnswer(invocation -> {
            Consumer<TransactionStatus> body = invocation.getArgument(0);
            body.accept(null);
            return null;
        }).when(template).executeWithoutResult(any());
        return template;
    }

    @Test
    void recordsWhoWhichCheckpointAndResult() {
        AuditLogger audit = mock(AuditLogger.class);
        new CheckpointRevertAudit(audit, passThrough()).reverted("actor-1", "ws-1", CHECKPOINT_ID,
                "rolled_back", "slice-7", 3, 1, 0, 2);

        verify(audit, times(1)).recordDurableChange(eq("actor-1"), eq("ws-1"),
                eq(CheckpointRevertAudit.ACTION), eq(CheckpointRevertAudit.RESOURCE_TYPE),
                eq(CHECKPOINT_ID),
                argThat(detail -> detail.contains("result=rolled_back") && detail.contains("sliceRef=slice-7")
                        && detail.contains("restored=3") && detail.contains("deleted=1")
                        && detail.contains("failed=0") && detail.contains("attempt=2")));
    }

    @Test
    void auditWriteAlwaysRunsInItsOwnTransaction() {
        TransactionTemplate template = passThrough();
        AuditLogger audit = mock(AuditLogger.class);
        new CheckpointRevertAudit(audit, template).reverted("actor-1", "ws-1", CHECKPOINT_ID,
                "partial", "slice-7", 1, 0, 1, 1);

        verify(template, times(1)).executeWithoutResult(any());
        assertEquals(TransactionDefinition.PROPAGATION_REQUIRES_NEW,
                SessionSnapshotAudit.independentTransaction(mock(PlatformTransactionManager.class))
                        .getPropagationBehavior());
    }

    /** 判据③：回滚效果已经在 Runtime 发生，审计写失败不得把它报成失败；但必须计数。 */
    @Test
    void auditFailureNeverBreaksTheRevertButIsCounted() {
        AuditLogger audit = mock(AuditLogger.class);
        doThrow(new IllegalStateException("db down")).when(audit)
                .recordDurableChange(any(), any(), any(), any(), any(), any());
        CheckpointRevertAudit subject = new CheckpointRevertAudit(audit, passThrough());

        assertDoesNotThrow(() -> subject.reverted("actor-1", "ws-1", CHECKPOINT_ID, "rolled_back",
                "slice-7", 1, 0, 0, 1));
        assertEquals(1, subject.failureCount(), "失败必须计数，否则就是静默丢记录");
    }

    /** 判据：三态结果可按值筛 —— details 以 result= 开头，可 LIKE 'result=skipped%'。 */
    @Test
    void resultValueIsPrefixFilterableForAllThreeStates() {
        for (String result : new String[] {"rolled_back", "partial", "skipped", "failed"}) {
            AuditLogger audit = mock(AuditLogger.class);
            new CheckpointRevertAudit(audit, passThrough()).reverted("actor-1", "ws-1", CHECKPOINT_ID,
                    result, "slice-7", 0, 0, 0, 1);
            verify(audit, times(1)).recordDurableChange(any(), any(), any(), any(), any(),
                    argThat(detail -> detail.startsWith("result=" + result)));
        }
    }

    @Test
    void blankCheckpointIdIsNotAudited() {
        AuditLogger audit = mock(AuditLogger.class);
        TransactionTemplate template = passThrough();
        new CheckpointRevertAudit(audit, template).reverted("actor-1", "ws-1", " ", "rolled_back",
                "slice-7", 0, 0, 0, 1);
        verify(audit, times(0)).recordDurableChange(any(), any(), any(), any(), any(), any());
    }
}
