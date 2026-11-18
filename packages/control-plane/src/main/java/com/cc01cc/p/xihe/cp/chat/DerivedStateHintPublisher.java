package com.cc01cc.p.xihe.cp.chat;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * task-21 / F1：spawn **创建** 时的 refresh hint 发送端。
 *
 * <p>为什么需要它：终态那条 hint（ChatRunTerminalService#publishDerivedStateAfterCommit）只覆盖
 * 「子 run 结束」，而 anchor 在 spawn 那一刻就该出现在父会话时间线上。没有这条 hint，父页面只能
 * 等下一次重读（刷新 / 切会话）才看到 running 的 anchor —— 2026-11-18 真栈实测：spawn 后 20s 内
 * 0 次 derived-state 重读，anchor 不出现（F1）。
 *
 * <p>口径与终态那条 **完全一致**，不新增协议：
 * <ul>
 *   <li>payload 恰好 {sessionId,runId,state,at}，见 spec/protocol/event-stream.md；</li>
 *   <li>state 用 derived-state 读面自己的 activeChildren 语义值 active，**不引入新的 run 状态词**
 *       （spec/session/derived-state-anchor.md「不做的事」）；</li>
 *   <li>SSE 只是 best-effort 提示（spec 原文：不承诺必达、replay 或与 DB 原子），所以发送失败
 *       只记日志，绝不影响 durable 的 spawn 事务；</li>
 *   <li>有活动事务 ⇒ 注册 afterCommit（提示必须指向已提交的事实）；无活动事务 ⇒ **立即发送**，
 *       不静默丢弃（否则「没有事务的调用路径」会永久不发，比 bug 本身更难查）。</li>
 * </ul>
 */
@Component
public class DerivedStateHintPublisher {

    private static final Logger logger = LoggerFactory.getLogger(DerivedStateHintPublisher.class);

    private final SseEmitterManager sseEmitters;

    @Autowired
    public DerivedStateHintPublisher(SseEmitterManager sseEmitters) {
        this.sseEmitters = sseEmitters;
    }

    /** 子 run 创建（spawn / delegation）后向父 Session 发一条 derived_state_changed。 */
    public void publishSpawned(String parentSessionId, String childSessionId, String childRunId) {
        Map<String, String> payload = new LinkedHashMap<>();
        payload.put("sessionId", childSessionId);
        payload.put("runId", childRunId);
        payload.put("state", "active");
        payload.put("at", Instant.now().toString());
        sendAfterCommit(parentSessionId, "derived_state_spawn_hint", childRunId, payload);
    }

    /**
     * 事务内注册 afterCommit，事务外立即发送。抽成通用形态是为了终态那条将来也能走同一路径
     * （本次不改它，避免把 task-21 的面扩到终态服务的既有测试）。
     */
    void sendAfterCommit(String parentSessionId, String event, String childRunId,
                         Map<String, String> payload) {
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            send(parentSessionId, event, childRunId, payload);
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                send(parentSessionId, event, childRunId, payload);
            }
        });
    }

    private void send(String parentSessionId, String event, String childRunId,
                      Map<String, String> payload) {
        try {
            boolean delivered = sseEmitters.send(parentSessionId, "derived_state_changed", payload);
            // 「发出→收到→处理」三段可对账的发送日志（task-21 验收要求，与终态那条同格式）。
            logger.info("[LIFECYCLE] service=cp event={} parentSessionId={} childRunId={} delivered={}",
                    event, parentSessionId, childRunId, delivered);
        } catch (RuntimeException error) {
            logger.warn("[LIFECYCLE] service=cp event={}_failed parentSessionId={} childRunId={} error={}",
                    event, parentSessionId, childRunId, error.getMessage());
        }
    }
}
