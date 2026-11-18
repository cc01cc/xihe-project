package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.UserQuestion;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.UserQuestionRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

/**
 * G3-a C2: startup replay of dispatch-parked runs that carry a durable answer.
 *
 * <p>The dispatch queue ({@link RunDispatchQueue}) is an in-memory deque with no startup
 * rebuild — after a CP restart a run parked as {@code queued} with an already-answered
 * question would wait for a {@code ChatRunTerminalizedEvent} that may never come. This
 * listener rebuilds the memory entries from the durable facts (precedent:
 * {@code FollowUpQueueService.recoverQueueOnStartup} rescans the follow-up table on
 * {@code ApplicationReadyEvent}) and then drives one drain per affected session.</p>
 *
 * <p>Scope discipline:</p>
 * <ul>
 *   <li>Only {@code queued} runs with an {@code answered} question row are rebuilt — the
 *       replay payload (the answer body) is fully durable, so a replay is lossless.</li>
 *   <li>Approvals are deliberately NOT replayed here: a dispatching approval's decision
 *       body (reject feedback, rule overrides) is not fully durable, so {@code ChatRunRecoveryService}
 *       settles those to {@code dispatch_unknown} for an explicit user retry instead (G3-a C5).</li>
 *   <li>Queued runs without a durable answer keep the pre-existing fate (lease expiry →
 *       periodic reconciliation sweep).</li>
 * </ul>
 *
 * <p>Ordering contract: runs at {@code Ordered.LOWEST_PRECEDENCE}, after
 * {@code ChatRunRecoveryService} (HIGHEST) which must skip — not terminalize — these runs
 * ({@code hasReplayableParkedAnswer}). A rebuilt entry whose respond fails (agent still
 * down) is reparked by the drain and retried via the drain's scheduled retry; the parked
 * lease renewed here keeps the periodic reconciliation away in the meantime.</p>
 */
@Component
public class ChatRunDispatchRecoveryService {

    private static final Logger logger = LoggerFactory.getLogger(ChatRunDispatchRecoveryService.class);

    private final ChatRunRepository runs;
    private final UserQuestionRepository questions;
    private final RunDispatchQueue queue;
    private final ChatRunDispatchQueueService dispatchQueueService;
    private final ChatRunDispatchDrainService drainService;

    public ChatRunDispatchRecoveryService(ChatRunRepository runs,
                                          UserQuestionRepository questions,
                                          RunDispatchQueue queue,
                                          ChatRunDispatchQueueService dispatchQueueService,
                                          ChatRunDispatchDrainService drainService) {
        this.runs = runs;
        this.questions = questions;
        this.queue = queue;
        this.dispatchQueueService = dispatchQueueService;
        this.drainService = drainService;
    }

    @Order(Ordered.LOWEST_PRECEDENCE)
    @EventListener(ApplicationReadyEvent.class)
    public void replayParkedAnswersOnStartup() {
        List<ChatRun> queued = runs.findByStatus("queued");
        if (queued.isEmpty()) {
            return;
        }
        Set<String> sessions = new LinkedHashSet<>();
        int rebuilt = 0;
        for (ChatRun run : queued) {
            try {
                Optional<UserQuestion> answered = questions
                        .findFirstByRunIdAndStateOrderByCreatedAtDescIdDesc(
                                run.getId(), UserQuestion.STATE_ANSWERED);
                if (answered.isEmpty()) {
                    // transport-queued 或死项：维持既有清扫路径，本类不扩权。
                    continue;
                }
                if (!dispatchQueueService.renewParkedLease(run.getId().toString())) {
                    logger.info("[LIFECYCLE] service=cp event=chat_run_dispatch_rebuild_skipped "
                                    + "runId={} reason=not_queued_anymore", run.getId());
                    continue;
                }
                UserQuestion row = answered.get();
                queue.park(new RunDispatchQueue.Entry(run.getId().toString(), run.getSessionId(),
                        Instant.now(), new RunDispatchQueue.QuestionResume(
                                run.getId().toString(), run.getSessionId(),
                                row.getId().toString(), row.getAnswer())));
                sessions.add(run.getSessionId());
                rebuilt++;
                logger.info("[LIFECYCLE] service=cp event=chat_run_dispatch_queue_rebuilt "
                                + "sessionId={} runId={} questionId={}",
                        run.getSessionId(), run.getId(), row.getId());
            } catch (Exception e) {
                logger.error("[LIFECYCLE] service=cp event=chat_run_dispatch_rebuild_failed "
                        + "runId={} sessionId={}", run.getId(), run.getSessionId(), e);
            }
        }
        for (String sessionId : sessions) {
            try {
                drainService.drain(sessionId);
            } catch (Exception e) {
                // 单次会话排水失败不阻塞其余会话；失败项仍在队列里，由定时重试/对账兜底。
                logger.error("[LIFECYCLE] service=cp event=chat_run_dispatch_replay_drain_failed sessionId={}",
                        sessionId, e);
            }
        }
        logger.info("[LIFECYCLE] service=cp event=chat_run_dispatch_replay_completed rebuilt={} sessions={}",
                rebuilt, sessions.size());
    }
}
