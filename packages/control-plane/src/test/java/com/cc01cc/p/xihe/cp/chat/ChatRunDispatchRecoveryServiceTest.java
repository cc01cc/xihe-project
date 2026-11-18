package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.UserQuestion;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.UserQuestionRepository;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * G3-a C2: startup rebuild of the dispatch queue from durable facts.
 *
 * <p>钉三件事：queued + answered 的 run 被重建进内存队列并触发排水；lease 被换发（重启前
 * 可能早已过期，不续期会被周期对账当 stale 清掉）；没有 durable 答案的 queued run 维持
 * 既有清扫路径（本类不扩权）。</p>
 */
class ChatRunDispatchRecoveryServiceTest {

    private static final String SESSION = "11111111-1111-1111-1111-111111111111";
    private static final String RUN_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    private static final String QUESTION_ID = "22222222-2222-2222-2222-222222222222";

    private final ChatRunRepository runs = Mockito.mock(ChatRunRepository.class);
    private final UserQuestionRepository questions = Mockito.mock(UserQuestionRepository.class);
    private final RunDispatchQueue queue = new RunDispatchQueue();
    private final ChatRunDispatchQueueService dispatchQueueService =
            Mockito.mock(ChatRunDispatchQueueService.class);
    private final ChatRunDispatchDrainService drainService =
            Mockito.mock(ChatRunDispatchDrainService.class);

    private ChatRunDispatchRecoveryService service() {
        return new ChatRunDispatchRecoveryService(runs, questions, queue,
                dispatchQueueService, drainService);
    }

    private ChatRun queuedRun() {
        return new ChatRun(RUN_ID, SESSION, "user-1", "ws-1", "idem-1", "hash",
                "openai", "model", "workspace", "queued");
    }

    private UserQuestion answeredRow() {
        UserQuestion row = new UserQuestion(UUID.fromString(SESSION), UUID.fromString(RUN_ID),
                null, UUID.fromString("33333333-3333-3333-3333-333333333333"),
                "which branch?", null);
        row.setId(UUID.fromString(QUESTION_ID));
        row.setState(UserQuestion.STATE_ANSWERED);
        row.setAnswer("rebase onto develop");
        return row;
    }

    @Test
    void queuedRunWithAnsweredQuestionIsRebuiltAndDrained() {
        when(runs.findByStatus("queued")).thenReturn(List.of(queuedRun()));
        when(questions.findFirstByRunIdAndStateOrderByCreatedAtDescIdDesc(
                any(UUID.class), eq(UserQuestion.STATE_ANSWERED)))
                .thenReturn(Optional.of(answeredRow()));
        when(dispatchQueueService.renewParkedLease(RUN_ID)).thenReturn(true);

        service().replayParkedAnswersOnStartup();

        assertTrue(queue.isParked(SESSION, RUN_ID), "内存队列按 durable 事实重建");
        verify(dispatchQueueService).renewParkedLease(RUN_ID);
        verify(drainService).drain(SESSION);
    }

    @Test
    void queuedRunWithoutAnswerKeepsTheExistingSweepFate() {
        // 负例：没有 durable 答案的 queued run（transport 语义/死项）不重建、不排水。
        when(runs.findByStatus("queued")).thenReturn(List.of(queuedRun()));
        when(questions.findFirstByRunIdAndStateOrderByCreatedAtDescIdDesc(
                any(UUID.class), eq(UserQuestion.STATE_ANSWERED)))
                .thenReturn(Optional.empty());

        service().replayParkedAnswersOnStartup();

        assertFalse(queue.isParked(SESSION, RUN_ID));
        verify(dispatchQueueService, never()).renewParkedLease(anyString());
        verify(drainService, never()).drain(anyString());
    }

    @Test
    void runThatLeftQueuedIsSkippedWithoutAnEntry() {
        // 负例：重建前 run 已不在 queued（并发终态化/取消）—— CAS 落空 ⇒ 不留死队列项。
        when(runs.findByStatus("queued")).thenReturn(List.of(queuedRun()));
        when(questions.findFirstByRunIdAndStateOrderByCreatedAtDescIdDesc(
                any(UUID.class), eq(UserQuestion.STATE_ANSWERED)))
                .thenReturn(Optional.of(answeredRow()));
        when(dispatchQueueService.renewParkedLease(RUN_ID)).thenReturn(false);

        service().replayParkedAnswersOnStartup();

        assertFalse(queue.isParked(SESSION, RUN_ID));
        verify(drainService, never()).drain(anyString());
    }

    @Test
    void aFailingDrainForOneSessionDoesNotBlockTheOthers() {
        String otherSession = "99999999-9999-9999-9999-999999999999";
        String otherRun = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
        ChatRun other = new ChatRun(otherRun, otherSession, "user-1", "ws-1", "idem-2", "hash",
                "openai", "model", "workspace", "queued");
        UserQuestion otherRow = answeredRow();
        otherRow.setRunId(UUID.fromString(otherRun));
        otherRow.setSessionId(UUID.fromString(otherSession));

        when(runs.findByStatus("queued")).thenReturn(List.of(queuedRun(), other));
        when(questions.findFirstByRunIdAndStateOrderByCreatedAtDescIdDesc(
                any(UUID.class), eq(UserQuestion.STATE_ANSWERED)))
                .thenAnswer(invocation -> {
                    UUID runId = invocation.getArgument(0);
                    return runId.toString().equals(RUN_ID) || runId.toString().equals(otherRun)
                            ? Optional.of(otherRow) : Optional.empty();
                });
        when(dispatchQueueService.renewParkedLease(anyString())).thenReturn(true);
        org.mockito.Mockito.doThrow(new IllegalStateException("agent down"))
                .when(drainService).drain(SESSION);

        service().replayParkedAnswersOnStartup();

        verify(drainService).drain(SESSION);
        verify(drainService).drain(otherSession);
        assertEquals(2, queue.parkedCount(SESSION) + queue.parkedCount(otherSession));
    }
}
