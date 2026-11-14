package com.cc01cc.p.xihe.cp.audit;

import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRootRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Q-h 档 2 + Q-i 冻（task-542）：<b>决策快照冻结那一刻</b>记一条会话级授权审计，一次会话一条。
 *
 * <p><b>范围摘要只给元数据</b>：授权根数量 + 主体 + {@code enforcement=none} + {@code executionMode}。
 * <b>路径级范围摘要待路径资源进入授权面后才有内容</b> —— 今天 {@code grants} 是 {@code *} 横配一切，
 * 路径资源为 0 条，摘要里给不出路径样本。看到范围摘要为空是<b>正常</b>，不是坏了。</p>
 *
 * <p><b>为什么 fail-open（写失败不阻断会话）</b>：①runtime-1 实测 {@code git grep authoriz
 * packages/runtime/src} 命中 23 处、逐类归因后<b>无一处消费授权结果</b> ⇒ 本条记录是<b>纯记录</b>，
 * 不参与任何安全决策；②{@code AuditLogger.recordDurableChange} 是同步 INSERT 且跑在业务事务内、
 * 无 try-catch ⇒ 照那个形状挂在会话启动路径上，一次 DB 抖动就变成「起不了会话」；③先例
 * {@code AuditLogger.recordAuthEvent} 的注释「Auth audit must never turn a login attempt into an
 * outage」——本条同族：快照审计不能把一次会话启动变成故障。所以：<b>不在业务事务内</b>
 * （有活跃事务时挂 afterCommit）、<b>失败不抛</b>、<b>WARN + 失败计数</b>留痕（否则就是静默丢记录）。</p>
 */
@Component
public class SessionSnapshotAudit {

    public static final String ACTION = "session.permissions_snapshot.frozen";
    public static final String ENFORCEMENT_NONE = "enforcement=none";
    /** 摘要缺口声明：写进记录本身，免得三个月后有人以为字段坏了。 */
    public static final String SCOPE_GAP_NOTE = "路径级范围摘要待路径资源进入授权面后才有内容";

    private static final Logger logger = LoggerFactory.getLogger(SessionSnapshotAudit.class);

    private final AuditLogger audit;
    private final WorkspaceRepository workspaces;
    private final WorkspaceRootRepository roots;
    private final TransactionTemplate auditTransaction;
    private final AtomicLong failures = new AtomicLong();

    @org.springframework.beans.factory.annotation.Autowired
    public SessionSnapshotAudit(AuditLogger audit, WorkspaceRepository workspaces,
            WorkspaceRootRepository roots, PlatformTransactionManager transactions) {
        this(audit, workspaces, roots, independentTransaction(transactions));
    }

    SessionSnapshotAudit(AuditLogger audit, WorkspaceRepository workspaces,
            WorkspaceRootRepository roots, TransactionTemplate auditTransaction) {
        this.audit = audit;
        this.workspaces = workspaces;
        this.roots = roots;
        this.auditTransaction = auditTransaction;
    }

    /**
     * 审计写<b>独立事务</b>：{@code REQUIRES_NEW} 挂起调用方事务。
     *
     * <p>这是判据「证明自己不参与外层事务」的落点：不是靠静态读「调用链没有 @Transactional」，
     * 而是让写入<b>必然</b>跑在另一个事务里 —— 外层有没有、叫什么、是不是跨 bean 调用，都不改变
     * 这一点。同时它避开了 {@code afterCommit} 那个坑：Spring 的 afterCommit 回调里做 DB 写仍绑在
     * <b>已提交</b>的旧事务上，行可能静默丢失。</p>
     */
    static TransactionTemplate independentTransaction(PlatformTransactionManager transactions) {
        TransactionTemplate template = new TransactionTemplate(transactions);
        template.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        return template;
    }

    /** 供判据断言：写入所用的传播行为。 */
    public int auditPropagation() {
        return auditTransaction.getPropagationBehavior();
    }

    /** 冻结完成后调用；有活跃事务时挂到 afterCommit，绝不在业务事务内写。 */
    public void frozen(Session session) {
        if (session == null || session.getId() == null) {
            return;
        }
        writeQuietly(session);
    }

    /**
     * 纯函数：元数据摘要（不含任何路径样本、不含文件内容、不含凭据）。
     *
     * <p>{@code subject} 取会话所属用户：Session 自 V133/A7 起不再有 agent principal 列，
     * 主体维度只能给到人 + 工作区，这一点也写进记录，不假装有更细的主体。</p>
     */
    public static String summary(String executionMode, int rootCount, String principalId) {
        return ENFORCEMENT_NONE
                + "; executionMode=" + (executionMode == null || executionMode.isBlank()
                        ? "unknown" : executionMode)
                + "; roots=" + rootCount
                + "; subject=" + (principalId == null || principalId.isBlank() ? "none" : principalId)
                + "; scope=none-path-level-pending"
                + "; note=" + SCOPE_GAP_NOTE;
    }

    /** 失败计数（可观测面；非 0 说明审计在被吞掉，需要人看）。 */
    public long failureCount() {
        return failures.get();
    }

    private void writeQuietly(Session session) {
        try {
            String executionMode = "unknown";
            int rootCount = 0;
            String workspaceId = session.getWorkspaceId();
            if (workspaceId != null && !workspaceId.isBlank()) {
                Optional<Workspace> workspace = findWorkspace(workspaceId);
                if (workspace.isPresent()) {
                    executionMode = workspace.get().getExecutionMode();
                    rootCount = roots.findByWorkspaceIdAndDeletedAtIsNullOrderByPositionAsc(
                            workspace.get().getId()).size();
                }
            }
            String detail = summary(executionMode, rootCount, session.getUserId());
            String actor = session.getUserId();
            String sid = session.getId().toString();
            String wsId = workspaceId;
            auditTransaction.executeWithoutResult(status ->
                    audit.recordDurableChange(actor, wsId, ACTION, "session", sid, detail));
        } catch (RuntimeException failure) {
            recordFailure(failure, session);
        }
    }

    private Optional<Workspace> findWorkspace(String workspaceId) {
        try {
            return workspaces.findById(UUID.fromString(workspaceId));
        } catch (IllegalArgumentException notAUuid) {
            return Optional.empty();
        }
    }

    private void recordFailure(RuntimeException failure, Session session) {
        long count = failures.incrementAndGet();
        logger.warn("[AUDIT] snapshot audit failed (fail-open, session continues) session={} "
                + "action={} failures={} cause={}", session.getId(), ACTION, count, failure.toString());
    }
}
