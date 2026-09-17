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
        // PLAN-0341 T1.4 (V4): summary is SUM-only. messages keeps recent turns
        // verbatim (old + new both inside K=10) with no summary system message.
        assertThat(messages).hasSize(2);
        assertThat(messages.get(0).get("content").asText()).isEqualTo("old turn");
        assertThat(messages.get(1).get("content").asText()).isEqualTo("new turn after compaction");
        // PLAN-294 M2 fix: the epoch must surface for the runner.
        assertThat(ctx.get("epoch").get("epoch_id").asText()).isNotBlank();
        assertThat(ctx.get("epoch").get("system_messages").toString()).contains("[Goal] old turn");
        assertThat(ctx.get("epoch").get("summary_hash").asText()).isNotBlank();
    }

    @Test
    void pruneTombstonesReplaceMatchingToolResults() {
        // PLAN-0341 T1.2 / I5: context.prune tombstones must replace the
        // matching tool result in-place so replay cannot resurrect content.
        String sessionId = "aaaaaaa9-0000-0000-0000-000000000000";
        String toolContent = "giant tool output that was pruned";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
                "message", Map.of("role", "human", "content", "run the tool")
        ));
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "tool.result", Map.of(
                "result", toolContent,
                "call_id", "call-1"
        ));
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
                "message", Map.of("role", "human", "content", "continue")
        ));

        // sha256 of toolContent (same algorithm as Agent/CP).
        String hash;
        try {
            java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
            byte[] h = digest.digest(toolContent.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            hash = java.util.HexFormat.of().formatHex(h);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }

        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "context.prune", Map.of(
                "tombstones", java.util.List.of(Map.of(
                        "tool_call_id", "call-1",
                        "content_hash", hash,
                        "size", toolContent.length(),
                        "head", toolContent.substring(0, Math.min(120, toolContent.length())),
                        "tail", "",
                        "pruned", true,
                        "reason", "oversized"
                )),
                "pruned_count", 1
        ));

        ObjectNode ctx = projectionService.project(sessionId, 0L);
        var messages = ctx.get("messages");
        boolean foundPlaceholder = false;
        for (var msg : messages) {
            if ("tool".equals(msg.path("role").asText())) {
                assertThat(msg.path("content").asText()).isEqualTo("[old tool result cleared]");
                assertThat(msg.path("pruned").asBoolean()).isTrue();
                foundPlaceholder = true;
            }
        }
        assertThat(foundPlaceholder).isTrue();
    }
}
