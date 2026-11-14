package com.cc01cc.p.xihe.cp.audit;

import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRootRepository;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

/** task-542：冻结那一刻恰好一条、纯记录、独立事务、失败不阻断会话。 */
class SessionSnapshotAuditTest {

    private static Session session() {
        Session session = new Session("ws-1", "user-1", "t");
        session.setId(UUID.randomUUID());
        session.setAgentPermissionsSnapshot(null);
        return session;
    }

    /** 直通模板：把回调当场执行（真实模板在独立事务里执行同一回调）。 */
    private static TransactionTemplate passThrough() {
        TransactionTemplate template = mock(TransactionTemplate.class);
        doAnswer(invocation -> {
            java.util.function.Consumer<org.springframework.transaction.TransactionStatus> body =
                    invocation.getArgument(0);
            body.accept(null);
            return null;
        }).when(template).executeWithoutResult(any());
        return template;
    }

    private static SessionSnapshotAudit subject(AuditLogger audit, TransactionTemplate template) {
        return new SessionSnapshotAudit(audit, mock(WorkspaceRepository.class),
                mock(WorkspaceRootRepository.class), template);
    }

    @Test
    void writesExactlyOneMetadataOnlyRecordPerFreeze() {
        AuditLogger audit = mock(AuditLogger.class);
        Session session = session();
        subject(audit, passThrough()).frozen(session);

        verify(audit, times(1)).recordDurableChange(eq("user-1"), eq("ws-1"),
                eq(SessionSnapshotAudit.ACTION), eq("session"), eq(session.getId().toString()),
                argThat(detail -> detail.contains("enforcement=none") && detail.contains("roots=")
                        && detail.contains(SessionSnapshotAudit.SCOPE_GAP_NOTE)));
    }

    /** 判据：写入必然走独立事务（REQUIRES_NEW），不是「调用链看起来没有 @Transactional」。 */
    @Test
    void auditWriteAlwaysRunsInItsOwnTransaction() {
        TransactionTemplate template = passThrough();
        AuditLogger audit = mock(AuditLogger.class);
        subject(audit, template).frozen(session());

        verify(template, times(1)).executeWithoutResult(any());
        assertEquals(TransactionDefinition.PROPAGATION_REQUIRES_NEW,
                SessionSnapshotAudit.independentTransaction(mock(PlatformTransactionManager.class))
                        .getPropagationBehavior());
    }

    @Test
    void auditFailureNeverBreaksTheSessionStart() {
        AuditLogger audit = mock(AuditLogger.class);
        doThrow(new IllegalStateException("db down")).when(audit)
                .recordDurableChange(any(), any(), any(), any(), any(), any());
        SessionSnapshotAudit subject = subject(audit, passThrough());

        assertDoesNotThrow(() -> subject.frozen(session()), "审计写失败不得阻断会话启动");
        assertEquals(1, subject.failureCount(), "失败必须计数，否则就是静默丢记录");
    }

    @Test
    void summaryCarriesMetadataOnlyAndDeclaresThePathLevelGap() {
        String summary = SessionSnapshotAudit.summary("windows-host", 2, "agent-1");
        assertTrue(summary.contains("executionMode=windows-host"));
        assertTrue(summary.contains("roots=2"));
        assertTrue(summary.contains("subject=agent-1"));
        assertTrue(summary.contains(SessionSnapshotAudit.SCOPE_GAP_NOTE), "缺口声明必须写进记录本身");
        assertFalse(summary.matches(".*[A-Za-z]:[\\\\/].*"), "摘要不得出现路径样本");
    }

    @Test
    void nullSessionIsIgnored() {
        AuditLogger audit = mock(AuditLogger.class);
        TransactionTemplate template = passThrough();
        subject(audit, template).frozen(null);
        verify(audit, times(0)).recordDurableChange(any(), any(), any(), any(), any(), any());
        verify(template, times(0)).executeWithoutResult(any());
    }
}
