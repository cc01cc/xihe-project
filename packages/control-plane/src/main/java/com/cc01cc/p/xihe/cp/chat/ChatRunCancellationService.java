package com.cc01cc.p.xihe.cp.chat;

import jakarta.persistence.EntityManager;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.McpInvocation;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.McpInvocationRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.runtime.RuntimeExecutionClient;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
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
    public static final List<String> NON_TERMINAL_STATUSES = List.of(
            "accepted", "queued", "running", "streaming", "awaiting_approval", "dispatching", "cancelling");

    private static final Duration CANCEL_TIMEOUT = Duration.ofSeconds(5);

    /**
     * PLAN-0407 T2.5：cancel 对 spawn 后代的有界等待上界。对齐会话删除路径的
     * 2s 终态投递口径；超时只记日志（{@link #awaitTerminalDelivery}），不阻断端点返回。
     */
    private static final Duration SPAWN_DESCENDANT_WAIT = Duration.ofSeconds(2);

    private final HttpClient agentHttpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
    private final ObjectMapper objectMapper;
    private final EntityManager entityManager;
    private final ChatRunRepository chatRunRepository;
    private final SessionRepository sessionRepository;
    private final McpInvocationRepository mcpInvocationRepository;
    private final RuntimeExecutionClient runtimeExecutionClient;
    private final ChatRunTerminalService terminalService;
    private final DbLockTimeout dbLockTimeout;
    /**
     * 认领用编程式事务：{@link #claimCancellation} 由本类其他方法自调用（自调用不经过
     * 代理，{@code @Transactional} 不生效），TransactionTemplate 在任意调用点都保证
     * SET LOCAL lock_timeout 与条件更新处于同一事务。
     */
    private final TransactionTemplate transactionTemplate;
    /** runId → 等待 releaseRun 信号的 latch（删除路径注册，release 时唤醒；有界等待后清除）。 */
    private final Map<String, CountDownLatch> releaseWaiters = new ConcurrentHashMap<>();

    @Value("${cp.agent-url:http://localhost:12632/chat}")
    private String agentUrl;

    @Value("${cp.agent-api-token:dev-token-not-secure}")
    private String agentApiToken;

    public ChatRunCancellationService(
            ObjectMapper objectMapper,
            EntityManager entityManager,
            ChatRunRepository chatRunRepository,
            SessionRepository sessionRepository,
            McpInvocationRepository mcpInvocationRepository,
            RuntimeExecutionClient runtimeExecutionClient,
            ChatRunTerminalService terminalService,
            DbLockTimeout dbLockTimeout,
            PlatformTransactionManager transactionManager) {
        this.objectMapper = objectMapper;
        this.entityManager = entityManager;
        this.chatRunRepository = chatRunRepository;
        this.sessionRepository = sessionRepository;
        this.mcpInvocationRepository = mcpInvocationRepository;
        this.runtimeExecutionClient = runtimeExecutionClient;
        this.terminalService = terminalService;
        this.dbLockTimeout = dbLockTimeout;
        this.transactionTemplate = new TransactionTemplate(transactionManager);
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
     * 取消端点编排（状态置 cancelling 由 {@link #cancelSerialized} 经条件更新认领）：
     * Agent 转发 + CP 自主收敛。与 {@code ChatController.cancelRun} 同一语义
     * （PLAN-0317 T2.4/T2.5/T2.6）。
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

    /** PLAN-0407 T2.5：cancel 认领结果。durable 行状态是唯一事实源，live 事件只做通知。 */
    public enum CancelOutcome {
        /** 条件更新获胜：本次调用负责根 run 收口与停止传播。 */
        CLAIMED,
        /** 已有 cancel 认领在途：不重复转发/结算（0352 端点语义），只补停止传播。 */
        ALREADY_CANCELLING,
        /** run 已落定终态：不认领、不传播（409 RUN_NOT_CANCELLABLE）。 */
        NOT_CANCELLABLE,
        /** 认领与复查之间 run 被删除（并发会话删除）。 */
        NOT_FOUND
    }

    public record CancelClaim(CancelOutcome outcome, String status) {}

    public CancelClaim cancelForCurrentOwner(String runId, String userId, String workspaceId, String reason) {
        ChatRun run = chatRunRepository.findById(UUID.fromString(runId)).orElse(null);
        if (run == null) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "RUN_NOT_FOUND", "Chat run not found");
        }
        if (!userId.equals(run.getUserId()) || !workspaceId.equals(run.getWorkspaceId())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "Chat run does not belong to current user/workspace");
        }
        return cancelSerialized(runId, run.getSessionId(), userId, workspaceId, reason);
    }

    /**
     * PLAN-0407 T2.5b：所有 cancellation caller 先锁 Session，再锁并刷新 Run；
     * 再以条件更新认领，输家按当前 durable 状态分类。缺失关联 fail-closed。
     */
    public CancelClaim claimCancellation(String runId,
                                         String expectedSessionId,
                                         String expectedUserId,
                                         String expectedWorkspaceId) {
        UUID id = UUID.fromString(runId);
        return transactionTemplate.execute(status -> {
            dbLockTimeout.apply();

            ChatRun locator = chatRunRepository.findById(id).orElse(null);
            if (locator == null) {
                return new CancelClaim(CancelOutcome.NOT_FOUND, null);
            }

            UUID sessionId = UUID.fromString(locator.getSessionId());
            Session session = sessionRepository.findByIdForUpdate(sessionId).orElse(null);
            if (session == null) {
                return new CancelClaim(CancelOutcome.NOT_FOUND, null);
            }
            entityManager.refresh(session);

            ChatRun current = chatRunRepository.findByIdForUpdate(id).orElse(null);
            if (current == null) {
                return new CancelClaim(CancelOutcome.NOT_FOUND, null);
            }
            entityManager.refresh(current);
            if (!sessionId.equals(UUID.fromString(current.getSessionId()))
                    || (expectedSessionId != null && !expectedSessionId.equals(sessionId.toString()))
                    || !session.getUserId().equals(current.getUserId())
                    || !session.getWorkspaceId().equals(current.getWorkspaceId())
                    || (expectedUserId != null && !expectedUserId.equals(session.getUserId()))
                    || (expectedWorkspaceId != null && !expectedWorkspaceId.equals(session.getWorkspaceId()))) {
                return new CancelClaim(CancelOutcome.NOT_FOUND, null);
            }

            int updated = chatRunRepository.markCancelling(id, ChatRunRepository.ACTIVE_LEASE_STATUSES);
            if (updated == 1) {
                return new CancelClaim(CancelOutcome.CLAIMED, "cancelling");
            }
            if ("cancelling".equals(current.getStatus())) {
                return new CancelClaim(CancelOutcome.ALREADY_CANCELLING, "cancelling");
            }
            return new CancelClaim(CancelOutcome.NOT_CANCELLABLE, current.getStatus());
        });
    }

    /**
     * PLAN-0407 T2.5：取消端点的序列化编排（design #38、spec §2/§4）。
     *
     * <p>认领获胜 → 根 run 走既有 forward+settle 收口；随后沿 {@code kind=spawn}
     * 做停止传播并有界等待（认领已提交，之后的新 spawn 都被准入门拒绝；认领前
     * 已提交的 child 由传播看到——两个胜序都由 durable 行决定）。认领失败但状态为
     * cancelling 时属重复请求：跳过重复收口，只补幂等的停止传播。
     */
    public CancelClaim cancelSerialized(String runId,
                                        String expectedSessionId,
                                        String expectedUserId,
                                        String workspaceId,
                                        String reason) {
        CancelClaim claim = claimCancellation(runId, expectedSessionId, expectedUserId, workspaceId);
        if (claim.outcome() == CancelOutcome.NOT_CANCELLABLE
                || claim.outcome() == CancelOutcome.NOT_FOUND) {
            return claim;
        }
        if (claim.outcome() == CancelOutcome.CLAIMED) {
            cancel(runId, workspaceId, reason);
        }
        try {
            List<String> descendantRunIds = cancelSpawnDescendants(
                    runId, expectedUserId, workspaceId, reason);
            if (!descendantRunIds.isEmpty()) {
                String rootSessionId = chatRunRepository.findById(UUID.fromString(runId))
                        .map(ChatRun::getSessionId)
                        .orElse(null);
                awaitTerminalDelivery(rootSessionId, descendantRunIds, SPAWN_DESCENDANT_WAIT);
            }
        } catch (RuntimeException e) {
            // 根 run 已认领并收口；传播失败不回滚 durable 状态，记录后由重试/对账补齐。
            logger.warn("[LIFECYCLE] service=cp event=spawn_cancel_propagation_failed rootRunId={} reason={} error={}",
                    runId, reason, e.getMessage(), e);
        }
        return claim;
    }

    /**
     * PLAN-0407 T2.5：停止传播只沿 {@code kind=spawn}（design #5/#14，spec §4）。
     *
     * <p>入口 = root run 直接派生的 child Session；展开用 session 派生边。每层先
     * 认领（条件更新）该 Session 的在飞 run，再列下一层——认领把行锁入账后，在飞
     * spawn 的准入门即拒绝新 child，因此单遍展开不会漏掉与 cancel 竞争的 spawn。
     * fork Session 不在查询面内，不被祖先 cancel 带走。
     *
     * @return 纳入取消的后代 runId（可能为空 = 无 spawn 后代）
     */
    public List<String> cancelSpawnDescendants(String rootRunId,
                                               String expectedUserId,
                                               String workspaceId,
                                               String reason) {
        List<String> cancelledRunIds = new ArrayList<>();
        Deque<Session> pending = new ArrayDeque<>(sessionRepository
                .findBySpawnedFromRunIdAndKind(UUID.fromString(rootRunId), Session.KIND_SPAWN));
        Set<UUID> visited = new HashSet<>();
        while (!pending.isEmpty()) {
            Session child = pending.poll();
            if (!visited.add(child.getId())) {
                continue;
            }
            cancelledRunIds.addAll(cancelInFlightForSession(
                    child.getId().toString(), expectedUserId, workspaceId, reason));
            pending.addAll(sessionRepository.findBySpawnedFromSessionIdAndKind(child.getId(), Session.KIND_SPAWN));
        }
        if (!cancelledRunIds.isEmpty()) {
            logger.info("[LIFECYCLE] service=cp event=spawn_cancel_propagation rootRunId={} sessions={} runs={} reason={}",
                    rootRunId, visited.size(), cancelledRunIds.size(), reason);
        }
        return cancelledRunIds;
    }

    /**
     * 会话删除路径：取消该会话全部非终态 run。
     *
     * <p>先为每个 run 注册 release 等待位（避免取消期间 release 早于等待注册），
     * 再逐个经 {@link #claimCancellation} 条件认领——认领获胜才走 {@link #cancel}，
     * 已 cancelling 不重复转发，与终态并发落地的 run 不被改写；`cancelling` 状态的
     * run 不重复转发，仅纳入等待。
     *
     * @return 纳入等待的 runId（可能为空 = 无在飞 run）
     */
    public List<String> cancelInFlightForSession(String sessionId,
                                                 String expectedUserId,
                                                 String workspaceId,
                                                 String reason) {
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
            String runId = run.getId().toString();
            CancelClaim claim = claimCancellation(runId, sessionId, expectedUserId, workspaceId);
            if (claim.outcome() == CancelOutcome.CLAIMED) {
                cancel(runId, workspaceId, reason);
            } else if (claim.outcome() == CancelOutcome.ALREADY_CANCELLING) {
                logger.info("[LIFECYCLE] service=cp event=session_delete_run_already_cancelling sessionId={} runId={}",
                        sessionId, runId);
            } else {
                logger.info("[LIFECYCLE] service=cp event=session_delete_run_claim_skipped sessionId={} runId={} outcome={} status={}",
                        sessionId, runId, claim.outcome(), claim.status());
            }
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
     * <p>对每个仍在途的 CP→Runtime 转发：按 execution-domain 的 {@code toolCallId}
     * 调 Runtime 取消端点（PLAN-0464 后关联源是 {@code mcp_invocations}，不再读
     * Ledger item/attempt）。最后把 run 收敛为 {@code cancelled}——成功/失败路径的
     * 转换期望集不含 {@code cancelling}，因此不会被回音路径覆盖；run 终态事务负责
     * history、waiting link 与仍滞留 {@code active} 的 invocation 对账。</p>
     */
    private void settleCancellation(String runId, String workspaceId) {
        ChatRun run = chatRunRepository.findById(UUID.fromString(runId)).orElse(null);
        if (run == null) {
            logger.warn("[LIFECYCLE] service=cp event=run_cancel_settle_missing runId={}", runId);
            return;
        }
        for (McpInvocation invocation : mcpInvocationRepository.findByRunIdAndStatus(
                runId, McpInvocation.STATUS_ACTIVE)) {
            RuntimeExecutionClient.CancelOutcome outcome =
                    runtimeExecutionClient.cancel(workspaceId, invocation.getToolCallId());
            if (outcome.found() && "already_finished".equals(outcome.status())) {
                logger.info("[LIFECYCLE] service=cp event=runtime_cancel_already_finished runId={} invocationId={}",
                        runId, invocation.getId());
                continue;
            }
            logger.info("[LIFECYCLE] service=cp event=runtime_cancel_requested runId={} invocationId={} confirmed={} unreachable={}",
                    runId, invocation.getId(), outcome.confirmed(), outcome.unreachable());
        }
        ChatRunTerminalService.TerminalResult result = terminalService.terminalize(
                new ChatRunTerminalService.TerminalRequest(runId, List.of("cancelling"),
                        "cancelled", "cancelled", null, null, run.getTokenCount(), run.getAssistantChars(),
                        ChatRunTerminalService.TerminalSource.CANCELLATION, null));
        if (!result.committed()) {
            logger.warn("[LIFECYCLE] service=cp event=run_cancel_transition_ignored runId={} outcome={} status={}",
                    runId, result.outcome(), result.currentStatus());
            return;
        }
        logger.info("[LIFECYCLE] service=cp event=run_cancelled runId={}", runId);
    }
}
