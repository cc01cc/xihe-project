package com.cc01cc.p.xihe.cp.audit;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.concurrent.atomic.AtomicLong;

/**
 * task-548：可逆操作（工作区回滚）进 {@code audit_logs}。
 *
 * <p><b>失败语义 = fail-open + WARN + 计数，但理由与 task-542 不同</b>：回滚的写效果在 Runtime
 * <b>已经发生且不可撤销</b>（{@code RunCheckpointService} 全文无 {@code @Transactional}，文件和
 * 沙箱状态都在外部），因此<b>不存在 both-or-neither 这个选项</b>。审计写失败时若把回滚报成失败，
 * 就是「假失败 + 真无审计」；若报成功又不写记录，就是静默丢记录。两者只能取其一 —— 取「回滚成功
 * + 留痕」，并让缺口可观测（WARN + {@link #failureCount()}）。542 是「不该让会话启动变成故障」，
 * 这里是「效果已经发生，记录是唯一证据」。</p>
 *
 * <p>写入时机在 <b>记账成功之后</b>（{@code updated > 0}）：状态被并发改过而记账跳过的那些回滚
 * <b>不写</b>这条审计 —— 不能为没生效的回滚造假记录。</p>
 *
 * <p>审计行可按可逆操作类型筛：{@link #ACTION}。</p>
 */
@Component
public class CheckpointRevertAudit {

    public static final String ACTION = "run_checkpoint.reverted";
    public static final String RESOURCE_TYPE = "run_checkpoint";

    /**
     * 三态结果，{@code details} 以 {@code result=} 开头 ⇒ 可按值筛（{@code details LIKE 'result=skipped%'}）。
     *
     * <p>{@code rolled_back} = 效果发生且记账成功；{@code partial} = 效果部分发生且记账成功；
     * {@code skipped} = 记账被跳过（状态已被并发改过，本次没有生效状态）；{@code failed} = 效果已发生
     * 但记账抛错。<b>审计记的是「谁尝试做了什么」</b>，所以被跳过的尝试也要有行 —— 它指向「有人在动
     * 同一个 checkpoint」；把结果标成 skipped 是准确记录，不是造假（造假是标 rolled_back 而实际没回滚）。</p>
     */
    public static final String RESULT_SKIPPED = "skipped";
    public static final String RESULT_FAILED = "failed";

    private static final Logger logger = LoggerFactory.getLogger(CheckpointRevertAudit.class);

    private final AuditLogger audit;
    private final TransactionTemplate auditTransaction;
    private final AtomicLong failures = new AtomicLong();

    @org.springframework.beans.factory.annotation.Autowired
    public CheckpointRevertAudit(AuditLogger audit, PlatformTransactionManager transactions) {
        this(audit, SessionSnapshotAudit.independentTransaction(transactions));
    }

    CheckpointRevertAudit(AuditLogger audit, TransactionTemplate auditTransaction) {
        this.audit = audit;
        this.auditTransaction = auditTransaction;
    }

    /**
     * 回滚记账成功后记一条：谁 / 哪个 checkpoint / 结果（rolled_back|partial）+ 计数。
     * 时间由 {@code audit_logs.created_at} 给出。
     */
    public void reverted(String actorUserId, String workspaceId, String checkpointId, String result,
            String sliceRef, int restored, int deleted, int failed, int attempt) {
        if (checkpointId == null || checkpointId.isBlank()) {
            return;
        }
        String detail = "result=" + result
                + "; sliceRef=" + (sliceRef == null || sliceRef.isBlank() ? "none" : sliceRef)
                + "; restored=" + restored
                + "; deleted=" + deleted
                + "; failed=" + failed
                + "; attempt=" + attempt;
        try {
            auditTransaction.executeWithoutResult(status -> audit.recordDurableChange(
                    actorUserId, workspaceId, ACTION, RESOURCE_TYPE, checkpointId, detail));
        } catch (RuntimeException failure) {
            long count = failures.incrementAndGet();
            logger.warn("[AUDIT] revert audit failed (fail-open, revert already applied) checkpoint={} "
                    + "action={} failures={} cause={}", checkpointId, ACTION, count, failure.toString());
        }
    }

    /** 失败计数（非 0 说明审计在被吞掉，需要人看）。 */
    public long failureCount() {
        return failures.get();
    }
}
