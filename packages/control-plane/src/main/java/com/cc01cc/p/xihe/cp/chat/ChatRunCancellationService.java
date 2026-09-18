package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.OperationAttempt;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.runtime.RuntimeExecutionClient;
import com.cc01cc.p.xihe.cp.service.RunCheckpointService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * PLAN-0352 T1.2：run 取消编排的共享入口。
 *
 * <p>从 {@code ChatController.cancelRun} 抽取（Agent cancel 转发 +
 * {@code settleRunCancellation} 收口），由取消端点与会话删除路径共用（决策 #3）。
 * 删除路径额外提供“取消在飞 run + 有界等待终态投递”（决策 #1/#2）。
 */
@Service
public class ChatRunCancellationService {

    private static final Logger logger = LoggerFactory.getLogger(ChatRunCancellationService.class);

    /** 非终态 run 状态（含 cancelling：已在取消中，等待 release 即可）。 */
    static final List<String> NON_TERMINAL_STATUSES = List.of(
            "accepted", "queued", "running", "streaming", "awaiting_approval", "dispatching", "cancelling");

    private static final Duration CANCEL_TIMEOUT = Duration.ofSeconds(5);

    private final HttpClient agentHttpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
    private final ObjectMapper objectMapper;
    private final ChatRunRepository chatRunRepository;
    private final OperationService operationService;
    private final RuntimeExecutionClient runtimeExecutionClient;
    private final RunCheckpointService runCheckpointService;
    /** runId → 等待 releaseRun 信号的 latch（删除路径注册，release 时唤醒；有界等待后清除）。 */
    private final Map<String, CountDownLatch> releaseWaiters = new ConcurrentHashMap<>();

    @Value("${cp.agent-url:http://localhost:12632/chat}")
    private String agentUrl;

    @Value("${cp.agent-api-token:dev-token-not-secure}")
    private String agentApiToken;

    public ChatRunCancellationService(
            ObjectMapper objectMapper,
            ChatRunRepository chatRunRepository,
            OperationService operationService,
            RuntimeExecutionClient runtimeExecutionClient,
            RunCheckpointService runCheckpointService) {
        this.objectMapper = objectMapper;
        this.chatRunRepository = chatRunRepository;
        this.operationService = operationService;
        this.runtimeExecutionClient = runtimeExecutionClient;
        this.runCheckpointService = runCheckpointService;
    }

    /**
     * Agent 取消转发的目标 URL。2026-09-13 E2E 实测：旧的
     * {@code agentUrl.replace("/chat", "")} 会产出
     * {@code .../internal/v1/agent/internal/v1/agent/runs/...} 双前缀导致 404，
     * Agent 侧从未收到取消信号；改为 URI.resolve 以 origin 为基准。
     */
    String buildAgentCancelUrl(String runId) {
        return URI.create(agentUrl).resolve("/internal/v1/agent/runs/" + runId + "/cancel").toString();
    }

    /**
     * 取消端点编排（状态置 cancelling 由调用方完成）：Agent 转发 + CP 自主收敛。
     * 与 {@code ChatController.cancelRun} 同一语义（PLAN-0317 T2.4/T2.5/T2.6）。
     */
    public void cancel(String runId, String workspaceId, String reason) {
        forwardCancelToAgent(runId, workspaceId, reason);
        logger.info("[LIFECYCLE] service=cp event=run_cancel_requested runId={} reason={}", runId, reason);
        try {
            settleCancellation(runId, workspaceId);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=run_cancel_settle_failed runId={} error={}",
                    runId, e.getMessage(), e);
        }
    }

    /**
     * 会话删除路径：取消该会话全部非终态 run。
     *
     * <p>先为每个 run 注册 release 等待位（避免取消期间 release 早于等待注册），
     * 再逐个走 {@link #cancel}；`cancelling` 状态的 run 不重复转发，仅纳入等待。
     *
     * @return 纳入等待的 runId（可能为空 = 无在飞 run）
     */
    public List<String> cancelInFlightForSession(String sessionId, String workspaceId, String reason) {
        List<ChatRun> runs = chatRunRepository.findBySessionIdAndStatusIn(sessionId, NON_TERMINAL_STATUSES);
        if (runs.isEmpty()) {
            return List.of();
        }
        List<String> runIds = new ArrayList<>(runs.size());
        for (ChatRun run : runs) {
            String runId = run.getId().toString();
            runIds.add(runId);
            releaseWaiters.computeIfAbsent(runId, ignored -> new CountDownLatch(1));
        }
        for (ChatRun run : runs) {
            if ("cancelling".equals(run.getStatus())) {
                logger.info("[LIFECYCLE] service=cp event=session_delete_run_already_cancelling sessionId={} runId={}",
                        sessionId, run.getId());
                continue;
            }
            String runId = run.getId().toString();
            run.setStatus("cancelling");
            chatRunRepository.save(run);
            cancel(runId, workspaceId, reason);
        }
        return runIds;
    }

    /**
     * 有界等待终态事件投递（决策 #2）：等待对象 = 在飞 run 的 relay 终结
     * （{@code releaseRun}，等价可见信号 {@code chat_runs.lease_owner} 置空），
     * relay 终结发生在终态事件投递之后。超时返回 false 并记
     * {@code session_delete_sse_wait_timeout}（含 sessionId/runId/N）。
     */
    public boolean awaitTerminalDelivery(String sessionId, List<String> runIds, Duration timeout) {
        if (runIds == null || runIds.isEmpty()) {
            return true;
        }
        long deadline = System.nanoTime() + timeout.toNanos();
        List<String> pending = new ArrayList<>();
        try {
            for (String runId : runIds) {
                boolean released = leaseReleased(runId);
                if (!released) {
                    long remaining = deadline - System.nanoTime();
                    CountDownLatch latch = releaseWaiters.get(runId);
                    if (latch != null && remaining > 0) {
                        try {
                            released = latch.await(remaining, TimeUnit.NANOSECONDS);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                    }
                    if (!released) {
                        // release 可能在超时边界与本次判定之间落地。
                        released = releaseWaiters.get(runId) == null;
                    }
                }
                if (!released) {
                    pending.add(runId);
                }
            }
        } finally {
            runIds.forEach(releaseWaiters::remove);
        }
        if (!pending.isEmpty()) {
            logger.warn("[LIFECYCLE] service=cp event=session_delete_sse_wait_timeout sessionId={} runId={} runCount={} waitTimeoutMs={}",
                    sessionId, pending, pending.size(), timeout.toMillis());
            return false;
        }
        return true;
    }

    /** {@code ChatController.releaseRun} 的 release 通知（内存任一路径均会显式调用）。 */
    void onRunReleased(String runId) {
        CountDownLatch latch = releaseWaiters.get(runId);
        if (latch != null && releaseWaiters.remove(runId, latch)) {
            latch.countDown();
        }
    }

    private boolean leaseReleased(String runId) {
        return chatRunRepository.findById(UUID.fromString(runId))
                .map(run -> run.getLeaseOwner() == null || run.getLeaseOwner().isBlank())
                .orElse(true);
    }

    private void forwardCancelToAgent(String runId, String workspaceId, String reason) {
        try {
            String cancelUrl = buildAgentCancelUrl(runId);
            var agentRequest = HttpRequest.newBuilder()
                    .uri(URI.create(cancelUrl))
                    .header("Authorization", "Bearer " + agentApiToken)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(
                            objectMapper.writeValueAsString(Map.of("reason", reason, "workspaceId", workspaceId))))
                    .timeout(CANCEL_TIMEOUT)
                    .build();
            agentHttpClient.send(agentRequest, HttpResponse.BodyHandlers.ofString());
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=cancel_forward_failed runId={} error={}", runId, e.getMessage());
        }
    }

    /**
     * 取消的 CP 侧收口（原 {@code ChatController.settleRunCancellation}，PLAN-0317 T2.4/T2.5/T2.6）。
     *
     * <p>对每个仍在途的 CP→Runtime 转发：按规范化 operationItemId 调 Runtime
     * 取消端点；确认终止 → item {@code cancelled}，未确认/不可达 → {@code aborted}
     * （对齐 spec S4 三分映射）；执行已自然结束（未命中）→ 不改 item。
     * 最后把 run 与 operation 收敛为 {@code cancelled}——成功/失败路径的转换
     * 期望集不含 {@code cancelling}，因此不会被回音路径覆盖。
     */
    private void settleCancellation(String runId, String workspaceId) {
        UUID operationId = operationService.findOperationIdByRunId(runId);
        if (operationId != null) {
            for (OperationAttempt attempt : operationService.findStartedForwards(operationId)) {
                OperationItem item = operationService.findItem(attempt.getItemId());
                if (item == null || item.getToolCallId() == null || item.getToolCallId().isBlank()) {
                    continue;
                }
                RuntimeExecutionClient.CancelOutcome outcome =
                        runtimeExecutionClient.cancel(workspaceId, item.getToolCallId());
                if (outcome.found() && "already_finished".equals(outcome.status())) {
                    logger.info("[LIFECYCLE] service=cp event=runtime_cancel_already_finished runId={} itemId={}",
                            runId, item.getId());
                    continue;
                }
                boolean cancelled = outcome.found() && "cancelled".equals(outcome.status());
                String itemStatus = cancelled ? "cancelled" : "aborted";
                String errorCode = cancelled ? null : "CANCEL_UNCONFIRMED";
                operationService.settleCancellation(item.getId(), attempt.getId(), itemStatus, errorCode);
                logger.info("[LIFECYCLE] service=cp event=runtime_cancel_settled runId={} itemId={} status={} confirmed={} unreachable={}",
                        runId, item.getId(), itemStatus, outcome.confirmed(), outcome.unreachable());
            }
            // 决策 #8 补充（2026-09-13 E2E）：在途 forward 结算后收口其余非终态
            // item/attempt（中继重复建项、审批遗留），保证四层终态一次落定。
            operationService.settleRemainingOpenItems(operationId);
        }
        int runUpdated = chatRunRepository.transition(UUID.fromString(runId), List.of("cancelling"),
                "cancelled", "cancelled", null, null, 0, 0);
        if (runUpdated == 0) {
            logger.warn("[LIFECYCLE] service=cp event=run_cancel_transition_ignored runId={}", runId);
        }
        operationService.transitionOperationForRun(runId, "cancelled", null, null);
        // PLAN-0338: cancellation bypasses transitionRun; capture the slice explicitly.
        runCheckpointService.requestCapture(runId);
        logger.info("[LIFECYCLE] service=cp event=run_cancelled runId={}", runId);
    }
}
