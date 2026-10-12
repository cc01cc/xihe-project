package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionFollowUpItemRepository;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0489 T1.3（contract: PLAN-0486 spec/scheduled-task.md v3.3 §4 session_wakeup）：
 * 定时任务的会话唤醒分派适配——复用既有 chat 域服务，不绕过任何授权门。
 *
 * <p>四语义落点：① target_gone（session 404/归档/外属归并）→ {@link TargetGoneException}；
 * ② busy（在途 Run 或未清空 follow-up 队列，镜像 {@code ChatSubmissionService}
 * 两个 admission 门的只读预检）→ 复用 {@link FollowUpQueueService#enqueue} 既有
 * 公共入队路径顺延，不计 missed；③ 空闲会话（PLAN-0489 决策 #7）→ 经
 * {@link ChatSubmissionService#createScheduled} 落 origin=scheduled 的 ChatRun +
 * user Message 载体，再以 {@link ScheduledRunDispatchRequestedEvent} 同步事件交给
 * {@code ChatController.dispatchScheduledRun} 走 headless lease/registry/execAsync
 * 执行链（与 spawn 分派同构，不经过 POST /api/v1/chat 的 SSE 订阅门）；
 * ④ 其余内部错误原样抛出（CpApiException/RuntimeException）由分派器转
 * missed(dispatch_failed)。</p>
 */
@Service
public class SessionWakeupService {

    private static final Logger logger = LoggerFactory.getLogger(SessionWakeupService.class);

    /** Scheduled wakeups mirror the follow-up idle path: no tool surface unless the run expands it. */
    private static final String SCHEDULED_TOOL_MODE = "none";

    private final SessionService sessionService;
    private final ChatRunRepository chatRunRepository;
    private final SessionFollowUpItemRepository followUpItemRepository;
    private final FollowUpQueueService followUpQueueService;
    private final BranchPathService branchPathService;
    private final ChatSubmissionService chatSubmissionService;
    private final ApplicationEventPublisher eventPublisher;
    private final ObjectMapper objectMapper;

    public SessionWakeupService(SessionService sessionService,
                                ChatRunRepository chatRunRepository,
                                SessionFollowUpItemRepository followUpItemRepository,
                                FollowUpQueueService followUpQueueService,
                                BranchPathService branchPathService,
                                ChatSubmissionService chatSubmissionService,
                                ApplicationEventPublisher eventPublisher,
                                ObjectMapper objectMapper) {
        this.sessionService = sessionService;
        this.chatRunRepository = chatRunRepository;
        this.followUpItemRepository = followUpItemRepository;
        this.followUpQueueService = followUpQueueService;
        this.branchPathService = branchPathService;
        this.chatSubmissionService = chatSubmissionService;
        this.eventPublisher = eventPublisher;
        this.objectMapper = objectMapper;
    }

    /** started = 已创建 ChatRun 载体；deferred = busy 顺延入 follow-up 队列（不计 missed）。 */
    public record WakeupResult(boolean started, UUID runId) {
        public static WakeupResult started(UUID runId) {
            return new WakeupResult(true, runId);
        }

        public static WakeupResult deferred() {
            return new WakeupResult(false, null);
        }
    }

    /** 目标会话消失（硬删除置 NULL 由分派器前置拦截；此处覆盖 404/归档/外属归并）。 */
    public static class TargetGoneException extends RuntimeException {
        public TargetGoneException(String detail, Throwable cause) {
            super(detail, cause);
        }
    }

    public WakeupResult wakeup(String sessionId, String userId, String workspaceId,
                               String prompt, String idempotencyKey) {
        Session session;
        try {
            session = sessionService.requireCurrent(sessionId, userId, workspaceId);
        } catch (CpApiException e) {
            if (HttpStatus.NOT_FOUND.equals(e.getStatus())) {
                throw new TargetGoneException("Scheduled session_wakeup target session is gone: " + sessionId, e);
            }
            throw e;
        }

        // busy 预检 = ChatSubmissionService 两个 admission 门的只读镜像
        // （CHAT_IN_PROGRESS：非终态 Run；FOLLOW_UP_QUEUE_NOT_EMPTY：未清空队列）。
        boolean activeRun = chatRunRepository.existsBySessionIdAndStatusIn(
                sessionId, ChatRunRepository.ACTIVE_LEASE_STATUSES);
        boolean queueOutstanding = followUpItemRepository.countBySessionIdAndStatusIn(
                sessionId, SessionFollowUpItemRepository.OUTSTANDING_STATUSES) > 0;
        if (!activeRun && !queueOutstanding) {
            return startScheduledRun(session, sessionId, userId, workspaceId, prompt, idempotencyKey);
        }

        String branchId = branchPathService.ensureRootBranchId(sessionId);
        // FollowUpQueueService.enqueue 要求调用方租户上下文与传入 userId/workspaceId 一致
        // （requireTenant）；调度线程无 HTTP 上下文，这里以任务行上持久化的创建者身份
        // （user_id/workspace_id，创建时经真实鉴权落库）建立与 TenantContextInterceptor
        // 等价的租户上下文，enqueue 内部仍校验其与 Session 的归属一致性。
        TenantContext.setUserId(userId);
        TenantContext.setWorkspaceId(workspaceId);
        try {
            followUpQueueService.enqueue(sessionId, userId, workspaceId, idempotencyKey,
                    new FollowUpCreateRequest(prompt, List.of(), branchId, "none", null, null, null));
        } catch (CpApiException e) {
            logger.warn("[LIFECYCLE] service=cp event=session_wakeup_follow_up_enqueue_failed "
                    + "sessionId={} code={}", sessionId, e.getCode());
            throw e;
        } finally {
            TenantContext.clear();
        }
        logger.info("[LIFECYCLE] service=cp event=session_wakeup_deferred sessionId={} reason=busy",
                sessionId);
        return WakeupResult.deferred();
    }

    /**
     * PLAN-0489 决策 #7: idle path — persist the scheduled ChatRun carrier through
     * the existing submission state machine, then hand off to the headless
     * dispatch chain via the same synchronous event pattern as spawn Runs
     * (no ChatController injection → no dependency cycle).
     */
    private WakeupResult startScheduledRun(Session session, String sessionId, String userId,
                                           String workspaceId, String prompt, String idempotencyKey) {
        String branchId = branchPathService.ensureRootBranchId(sessionId);
        // 镜像 follow-up dispatch 的连接权威规则：Session 绑定了 Provider Connection
        // 则 provider/model 由 Session 行决定；未绑定则不带提示（Agent 侧走默认）。
        String provider = session.getProviderConnectionId() == null ? null : session.getModelProvider();
        String model = session.getProviderConnectionId() == null ? null : session.getModelName();
        String principalId = session.getAgentPrincipalId();
        String runId = UUID.randomUUID().toString();
        String requestHash = ChatRequestHash.calculate(objectMapper, prompt, provider, model,
                SCHEDULED_TOOL_MODE, List.of(), Map.of(), principalId, branchId);
        ChatSubmissionService.Submission created;
        try {
            created = chatSubmissionService.createScheduled(runId, sessionId, userId, workspaceId, branchId,
                    idempotencyKey, requestHash, provider, model, SCHEDULED_TOOL_MODE,
                    session.getProviderConnectionId(), session.getConnectionRevision(), null,
                    UUID.randomUUID().toString(), prompt, "[]", List.of(), principalId);
        } catch (CpApiException e) {
            logger.warn("[LIFECYCLE] service=cp event=session_wakeup_start_rejected sessionId={} code={}",
                    sessionId, e.getCode());
            throw e;
        }
        try {
            eventPublisher.publishEvent(new ScheduledRunDispatchRequestedEvent(sessionId,
                    created.run().getId().toString()));
        } catch (RuntimeException e) {
            // 与 spawn 分派（AgentSpawnExecutionService.execute）同语义：发布失败只留痕，
            // 已提交的 accepted Run 由后续 reconciliation/终态路径收口。
            logger.error("[LIFECYCLE] service=cp event=session_wakeup_dispatch_failed sessionId={} "
                    + "runId={} failureType={}", sessionId, created.run().getId(),
                    e.getClass().getSimpleName(), e);
        }
        logger.info("[LIFECYCLE] service=cp event=session_wakeup_started sessionId={} runId={}",
                sessionId, created.run().getId());
        return WakeupResult.started(created.run().getId());
    }
}
