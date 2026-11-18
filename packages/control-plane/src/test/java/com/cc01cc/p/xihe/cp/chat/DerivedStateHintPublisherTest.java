package com.cc01cc.p.xihe.cp.chat;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * task-21 / F1：spawn 时刻 refresh hint 的发送语义。
 *
 * <p>三条判据都来自真栈实测暴露过的风险：① hint 必须在 spawn 后**立即**能发（否则父页面要刷新
 * 才看到 running anchor，F1）；② 事务内必须**等提交**后才发（提示不能指向未提交事实）；
 * ③ 无活动事务时**不能静默不发**（{@link TransactionSynchronization} 只在事务内注册，直接跳过会让
 * 某些调用路径永久丢 hint —— 这比 bug 本身更难查）。
 */
class DerivedStateHintPublisherTest {

    private static final String PARENT = "11111111-1111-1111-1111-111111111111";
    private static final String CHILD_SESSION = "22222222-2222-2222-2222-222222222222";
    private static final String CHILD_RUN = "33333333-3333-3333-3333-333333333333";

    private final SseEmitterManager sseEmitters = mock(SseEmitterManager.class);

    @AfterEach
    void clearSynchronization() {
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.clearSynchronization();
        }
    }

    @Test
    @DisplayName("无活动事务时立即发送，payload 恰好四键")
    void sendsImmediatelyWhenNoTransaction() {
        when(sseEmitters.send(eq(PARENT), eq("derived_state_changed"), any())).thenReturn(true);
        new DerivedStateHintPublisher(sseEmitters)
                .publishSpawned(PARENT, CHILD_SESSION, CHILD_RUN);

        @SuppressWarnings("unchecked")
        org.mockito.ArgumentCaptor<Map<String, String>> payload =
                org.mockito.ArgumentCaptor.forClass(Map.class);
        verify(sseEmitters).send(eq(PARENT), eq("derived_state_changed"), payload.capture());
        assertThat(payload.getValue()).containsOnlyKeys("sessionId", "runId", "state", "at");
        assertThat(payload.getValue().get("sessionId")).isEqualTo(CHILD_SESSION);
        assertThat(payload.getValue().get("runId")).isEqualTo(CHILD_RUN);
        // derived-state 读面自己的语义值，不是新的 run 状态词。
        assertThat(payload.getValue().get("state")).isEqualTo("active");
        assertThat(payload.getValue().get("at")).isNotBlank();
    }

    @Test
    @DisplayName("事务内注册 afterCommit：提交前不发，提交后发一次")
    void defersUntilCommitInsideTransaction() {
        when(sseEmitters.send(eq(PARENT), eq("derived_state_changed"), any())).thenReturn(true);
        TransactionSynchronizationManager.initSynchronization();

        new DerivedStateHintPublisher(sseEmitters)
                .publishSpawned(PARENT, CHILD_SESSION, CHILD_RUN);

        verify(sseEmitters, never()).send(any(), any(), any());
        List<TransactionSynchronization> syncs = TransactionSynchronizationManager.getSynchronizations();
        assertThat(syncs).hasSize(1);
        syncs.forEach(TransactionSynchronization::afterCommit);
        verify(sseEmitters).send(eq(PARENT), eq("derived_state_changed"), any());
    }

    @Test
    @DisplayName("发送端抛错不影响 spawn：异常被吞掉只记日志")
    void sendFailureIsSwallowed() {
        when(sseEmitters.send(any(), any(), any())).thenThrow(new IllegalStateException("boom"));

        assertThatCode(() -> new DerivedStateHintPublisher(sseEmitters)
                .publishSpawned(PARENT, CHILD_SESSION, CHILD_RUN))
                .doesNotThrowAnyException();
    }
}
