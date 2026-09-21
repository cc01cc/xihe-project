package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.runtime.RuntimeJobClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * PLAN-0390 T1.3：Job scope 收口。
 *
 * <p>scope 是 Job 的存活边界（spec/execution-job-contract.md §Scope 收口）：
 * <ul>
 *   <li>{@code run}：run 进入终态 → {@code scope_run_end}</li>
 *   <li>{@code session}：session 硬删 → {@code scope_session_stop}</li>
 *   <li>{@code workspace}：Workspace 逻辑删除 → {@code workspace_destroy}
 *       （由 {@link JobStateService#markOrphanedForWorkspace} 在 Runtime destroying
 *       窗口后统一收口，因其天然覆盖该 Workspace 全部 scope）</li>
 * </ul>
 *
 * <p>收口一律 best-effort 调 Runtime cancel：确认终止才落终态；Runtime 不可达或
 * 终止未确认时**保留 active**并记日志，交给 {@link JobReconciliationService} 兜底，
 * 不静默成功、不跨 scope 越界。
 */
@Service
public class JobScopeClosureService {

    private static final Logger logger = LoggerFactory.getLogger(JobScopeClosureService.class);

    private final JobStateService jobStateService;
    private final RuntimeJobClient runtimeJobClient;

    public JobScopeClosureService(JobStateService jobStateService, RuntimeJobClient runtimeJobClient) {
        this.jobStateService = jobStateService;
        this.runtimeJobClient = runtimeJobClient;
    }

    /** run 终态收口：只关闭 {@code scope=run} 且 runId 匹配的 active Job。 */
    public int closeRunScope(String runId) {
        return close(jobStateService.findActiveForScope(JobStateService.SCOPE_RUN, runId),
                JobStateService.REASON_SCOPE_RUN_END, JobStateService.SCOPE_RUN, runId);
    }

    /** session 硬删收口：只关闭 {@code scope=session} 且 sessionId 匹配的 active Job。 */
    public int closeSessionScope(String sessionId) {
        return close(jobStateService.findActiveForScope(JobStateService.SCOPE_SESSION, sessionId),
                JobStateService.REASON_SCOPE_SESSION_STOP, JobStateService.SCOPE_SESSION, sessionId);
    }

    private int close(List<JobStateService.ActiveJob> actives, String reason,
                      String scope, String boundaryKey) {
        if (actives == null || actives.isEmpty()) {
            return 0;
        }
        int closed = 0;
        int unconfirmed = 0;
        for (JobStateService.ActiveJob job : actives) {
            String jobId = job.archive().jobId();
            if (jobId != null && !jobId.isBlank()) {
                RuntimeJobClient.JobCancelResult result =
                        runtimeJobClient.cancelJob(job.archive().workspaceId(), jobId);
                if (!result.reachable()) {
                    unconfirmed++;
                    continue;
                }
                if (!result.found()) {
                    // Runtime 已无该 job：fail-closed 落 orphaned，不臆造已取消。
                    Map<String, Object> orphaned = new LinkedHashMap<>();
                    orphaned.put("status", "orphaned");
                    orphaned.put("cancelReason", JobStateService.REASON_JOB_MISSING);
                    jobStateService.upsert(job.itemId(), orphaned);
                    closed++;
                    continue;
                }
                if (!"cancelled".equals(result.status())) {
                    // 四阶段后进程仍存活：终止未确认，保留 active 交给对账。
                    unconfirmed++;
                    continue;
                }
            }
            Map<String, Object> incoming = new LinkedHashMap<>();
            incoming.put("status", "cancelled");
            incoming.put("cancelReason", reason);
            incoming.put("cleanupStatus", "completed");
            jobStateService.upsert(job.itemId(), incoming);
            closed++;
        }
        logger.info("[LIFECYCLE] service=cp event=job_scope_closed scope={} boundaryKey={} closed={} unconfirmed={}",
                scope, boundaryKey, closed, unconfirmed);
        return closed;
    }
}
