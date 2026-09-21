package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.runtime.RuntimeJobClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * PLAN-0344 T1.2 来源③：周期对账档案中 status=running 的 job——
 * 逐个走 Runtime {@code get_background_process}（只查档案内 jobId，不扫全容器），
 * 把 Agent 永远不会再查询的终态回填进档案；job 在容器里消失（容器重建/TTL异常）
 * 且不可达判空失败时收敛为 orphaned，不留悬空 running。
 */
@Component
public class JobReconciliationService {

    private static final Logger logger = LoggerFactory.getLogger(JobReconciliationService.class);

    private final JobStateService jobStateService;
    private final RuntimeJobClient runtimeJobClient;
    private final Duration window;

    public JobReconciliationService(
            JobStateService jobStateService,
            RuntimeJobClient runtimeJobClient,
            @Value("${cp.job.reconcile-window-hours:168}") long windowHours) {
        this.jobStateService = jobStateService;
        this.runtimeJobClient = runtimeJobClient;
        this.window = Duration.ofHours(windowHours);
    }

    @Scheduled(fixedDelayString = "${cp.job.reconcile-interval-ms:300000}",
            initialDelayString = "${cp.job.reconcile-initial-delay-ms:120000}")
    public void reconcileRunningJobs() {
        List<JobStateService.JobStateRef> candidates =
                jobStateService.findRunningSince(Instant.now().minus(window));
        if (candidates.isEmpty()) {
            return;
        }
        // PLAN-0390 T2.3（决策 #11）：Runtime 重启判据 = bootId 变化。
        // 进程重启后旧 handle 一律失效：记录过旧 bootId 的 active Job 落
        // interrupted（cancelReason=runtime_restart），不自动重放。
        int interrupted = 0;
        String currentBootId = runtimeJobClient.runtimeBootId();
        if (currentBootId != null) {
            List<String> workspaces = candidates.stream()
                    .map(JobStateService.JobStateRef::workspaceId)
                    .filter(java.util.Objects::nonNull)
                    .distinct()
                    .toList();
            for (String workspaceId : workspaces) {
                interrupted += jobStateService.markInterruptedForRuntimeRestart(workspaceId, currentBootId);
            }
        }
        int synced = 0;
        int orphaned = 0;
        int unreachable = 0;
        for (JobStateService.JobStateRef ref : candidates) {
            if (ref.itemId() == null || ref.jobId() == null) {
                continue;
            }
            RuntimeJobClient.JobStatusResult result =
                    runtimeJobClient.jobStatus(ref.workspaceId(), ref.jobId());
            if (result.unreachable()) {
                unreachable++;
                continue;
            }
            if (!result.found()) {
                Map<String, Object> incoming = new LinkedHashMap<>();
                incoming.put("status", "orphaned");
                incoming.put("cancelReason", "destroy_orphan");
                jobStateService.upsert(ref.itemId(), incoming);
                orphaned++;
                continue;
            }
            jobStateService.syncJobInfo(ref.itemId(), ref.workspaceId(), result.job());
            synced++;
        }
        logger.info("[LIFECYCLE] service=cp event=job_reconcile_completed candidates={} synced={} orphaned={} unreachable={} interrupted={}",
                candidates.size(), synced, orphaned, unreachable, interrupted);
    }
}
