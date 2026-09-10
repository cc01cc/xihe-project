package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.context.service.ContextProjectionService;
import com.cc01cc.p.xihe.cp.context.service.ContextService;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class ContextProjectionServiceTest extends AbstractH2Test {

    private static final String TEST_SESSION_A = "aaaaaaa1-0000-0000-0000-000000000000";
    private static final String TEST_SESSION_B = "aaaaaaa2-0000-0000-0000-000000000000";
    private static final String TEST_WS = "aaaaaaa3-0000-0000-0000-000000000000";
    private static final String TEST_USER = "aaaaaaa4-0000-0000-0000-000000000000";

    @Autowired
    private ContextService contextService;

    @Autowired
    private EventStoreService eventStoreService;

    @Autowired
    private ContextProjectionService projectionService;

    @Test
    void projectEmptySessionReturnsEmptyContext() {
        ObjectNode ctx = projectionService.project(TEST_SESSION_A, 0L);
        assertThat(ctx.get("aggregate_id").asText()).isEqualTo(TEST_SESSION_A);
        assertThat(ctx.get("latest_sequence").asLong()).isEqualTo(0L);
    }

    @Test
    void projectWithEventsBuildsMessages() {
        String sessionId = TEST_SESSION_B;
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "session.created", Map.of(
            "workspace_id", TEST_WS,
            "user_id", TEST_USER,
            "epoch_id", "epoch-1",
            "baseline_hash", "hash-1",
            "system_messages", java.util.List.of("You are xihe")
        ));
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
            "message", Map.of("role", "human", "content", "hello")
        ));

        ObjectNode ctx = projectionService.project(sessionId, 0L);

        assertThat(ctx.get("latest_sequence").asLong()).isEqualTo(2L);
        var messages = ctx.get("messages");
        assertThat(messages).hasSize(1);
        assertThat(messages.get(0).get("role").asText()).isEqualTo("human");
        assertThat(messages.get(0).get("content").asText()).isEqualTo("hello");
    }

    @Test
    void projectAfterSequenceExcludesEarlierEvents() {
        String sessionId = "aaaaaaa5-0000-0000-0000-000000000000";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "session.created", Map.of(
            "workspace_id", TEST_WS,
            "user_id", TEST_USER,
            "epoch_id", "epoch-1",
            "baseline_hash", "hash-1",
            "system_messages", java.util.List.of("You are xihe")
        ));
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
            "message", Map.of("role", "human", "content", "first")
        ));
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
            "message", Map.of("role", "human", "content", "second")
        ));

        ObjectNode ctx = projectionService.project(sessionId, 2L);

        assertThat(ctx.get("latest_sequence").asLong()).isEqualTo(3L);
        var messages = ctx.get("messages");
        assertThat(messages).hasSize(1);
        assertThat(messages.get(0).get("content").asText()).isEqualTo("second");
    }

    @Test
    void projectAssistantRespondedCarriesAiMessage() {
        // PLAN-294 M1 (decisions #2/#6): assistant.responded must land in the
        // projection as an ai-role message — the durable history half that
        // was missing before M1.
        String sessionId = "aaaaaaa6-0000-0000-0000-000000000000";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
            "message", Map.of("role", "human", "content", "hi there")
        ));
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "assistant.responded", Map.of(
            "message", Map.of("role", "ai", "content", "hello human"),
            "runId", "run-1"
        ));

        ObjectNode ctx = projectionService.project(sessionId, 0L);

        var messages = ctx.get("messages");
        assertThat(messages).hasSize(2);
        assertThat(messages.get(1).get("role").asText()).isEqualTo("ai");
        assertThat(messages.get(1).get("content").asText()).isEqualTo("hello human");
    }

    @Test
    void compactionThenNewMessagesKeepsSummaryAndNewTurns() {
        // PLAN-294 appendix D.4-1: compaction replaces pre-cursor history;
        // messages arriving after the compaction event must survive replay.
        String sessionId = "aaaaaaa7-0000-0000-0000-000000000000";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
            "message", Map.of("role", "human", "content", "old turn")
        ));
        contextService.compact(sessionId, TEST_WS, TEST_USER, null);
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
            "message", Map.of("role", "human", "content", "new turn after compaction")
        ));

        ObjectNode ctx = projectionService.project(sessionId, 0L);

        var messages = ctx.get("messages");
        // PLAN-294 decision #7: summary + keep-recent tail. "old turn" sits
        // inside the K=10 window, so the projection is summary + old + new.
        assertThat(messages).hasSize(3);
        assertThat(messages.get(0).get("role").asText()).isEqualTo("system");
        assertThat(messages.get(0).get("content").asText()).contains("[Goal] old turn");
        assertThat(messages.get(1).get("content").asText()).isEqualTo("old turn");
        assertThat(messages.get(2).get("content").asText()).isEqualTo("new turn after compaction");
        // PLAN-294 M2 fix: the epoch must surface for the runner.
        assertThat(ctx.get("epoch").get("epoch_id").asText()).isNotBlank();
        assertThat(ctx.get("epoch").get("system_messages").toString()).contains("[Goal] old turn");
    }
}
