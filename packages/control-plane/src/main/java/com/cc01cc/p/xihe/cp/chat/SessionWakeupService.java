package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionFollowUpItemRepository;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.cc01cc.p.xihe.cp.service.SessionService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.UUID;

/**
 * PLAN-0489 T1.3（contract: PLAN-0486 spec/scheduled-task.md v3.3 §4 session_wakeup）：
 * 定时任务的会话唤醒分派适配——复用既有 chat 域服务，不绕过任何授权门。
 *
 * <p>四语义落点：① target_gone（session 404/归档/外属归并）→ {@link TargetGoneException}；
 * ② busy（在途 Run 或未清空 follow-up 队列，镜像 {@code ChatSubmissionService}
 * 两个 admission 门的只读预检）→ 复用 {@link FollowUpQueueService#enqueue} 既有
 * 公共入队路径顺延，不计 missed；③ 空闲会话的「以 prompt 启动 ChatRun」执行
 * handoff（{@code ChatController.execAsync}）目前是 controller 私有路径且
 * {@code POST /api/v1/chat} 有 SSE 订阅门——本波次无法在不破坏边界的情况下内部
 * 复用，抛 {@link WakeupStartUnavailableException} 由分派器按
 * missed(dispatch_failed) 可见收口（PLAN-0489 实施报告：待决策，建议抽
 * ChatRunDispatchService）；④ 其余内部错误原样抛出（CpApiException/RuntimeException）
 * 由分派器转 missed(dispatch_failed)。</p>
 */
@Service
public class SessionWakeupService {

    private static final Logger logger = LoggerFactory.getLogger(SessionWakeupService.class);

    private final SessionService sessionService;
    private final ChatRunRepository chatRunRepository;
    private final SessionFollowUpItemRepository followUpItemRepository;
    private final FollowUpQueueService followUpQueueService;
    private final BranchPathService branchPathService;

    public SessionWakeupService(SessionService sessionService,
                                ChatRunRepository chatRunRepository,
                                SessionFollowUpItemRepository followUpItemRepository,
                                FollowUpQueueService followUpQueueService,
                                BranchPathService branchPathService) {
        this.sessionService = sessionService;
        this.chatRunRepository = chatRunRepository;
        this.followUpItemRepository = followUpItemRepository;
        this.followUpQueueService = followUpQueueService;
        this.branchPathService = branchPathService;
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

    /** 空闲会话的启动 handoff 待决策（见类注释③）——fail-closed，不制造僵尸 Run。 */
    public static class WakeupStartUnavailableException extends RuntimeException {
        public WakeupStartUnavailableException(String detail) {
            super(detail);
        }
    }

    public WakeupResult wakeup(String sessionId, String userId, String workspaceId,
                               String prompt, String idempotencyKey) {
        try {
            sessionService.requireCurrent(sessionId, userId, workspaceId);
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
            throw new WakeupStartUnavailableException(
                    "Scheduled session_wakeup start path is pending decision (PLAN-0489 report): "
                            + "the ChatRun execution handoff is ChatController-private and the HTTP "
                            + "chat entry requires a live SSE subscription; no internal start path "
                            + "can be reused without extracting an internal dispatch service");
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
}
