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

    /** 空 checkpointId 不写，但必须计数 —— 否则「没发生」与「没记录」无法区分。 */
    @Test
    void blankCheckpointIdIsNotAuditedButIsCounted() {
        AuditLogger audit = mock(AuditLogger.class);
        CheckpointRevertAudit subject = new CheckpointRevertAudit(audit, passThrough());
        subject.reverted("actor-1", "ws-1", " ", "rolled_back", "slice-7", 0, 0, 0, 1);
        verify(audit, times(0)).recordDurableChange(any(), any(), any(), any(), any(), any());
        assertEquals(1, subject.failureCount(), "跳过的写也必须计数");
    }

    /**
     * sliceRef 是外部串：含 ';' / '=' 时不得伪造出第二个字段（否则 LIKE '%result=skipped%' 会命中
     * 一条 rolled_back 行 —— 外部输入篡改筛选语义）。
     */
    @Test
    void sliceRefCannotForgeAnotherField() {
        AuditLogger audit = mock(AuditLogger.class);
        new CheckpointRevertAudit(audit, passThrough()).reverted("actor-1", "ws-1", CHECKPOINT_ID,
                "rolled_back", "a;result=skipped;failed=9", 0, 0, 0, 1);
        verify(audit, times(1)).recordDurableChange(any(), any(), any(), any(), any(),
                argThat(detail -> detail.startsWith("result=rolled_back;")
                        && !detail.contains(";result=skipped")
                        && detail.contains("result%3Dskipped")));
    }

    /** 零效果是合法形态：运行时什么都没做也落 rolled_back，区分靠计数不靠加态。 */
    @Test
    void zeroEffectRevertIsLegitimateRolledBackShape() {
        AuditLogger audit = mock(AuditLogger.class);
        new CheckpointRevertAudit(audit, passThrough()).reverted("actor-1", "ws-1", CHECKPOINT_ID,
                "rolled_back", "slice-7", 0, 0, 0, 1);
        verify(audit, times(1)).recordDurableChange(any(), any(), any(), any(), any(),
                argThat(detail -> detail.startsWith("result=rolled_back;")
                        && detail.contains("restored=0") && detail.contains("deleted=0")
                        && detail.contains("failed=0")));
    }
}
