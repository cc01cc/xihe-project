package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.context.service.ContextProjectionService;
import com.cc01cc.p.xihe.cp.context.service.ContextService;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.List;
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
    void projectSessionForkedSeedRestoresChildMessagesAndSumWithoutSourceCursor() {
        String sessionId = "bbbbbbb1-0000-0000-0000-000000000000";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "session.created", Map.of(
                "workspace_id", TEST_WS,
                "user_id", TEST_USER,
                "epoch_id", "source-epoch",
                "system_messages", List.of("child base system")
        ));
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "context.source_changed", Map.of(
                "status", "created",
                "source_hash", "child-l1-hash",
                "rendered_text", "child L1",
                "sources", List.of(Map.of(
                        "key", "AGENTS.md",
                        "source_type", "agents_md",
                        "content", "child L1",
                        "content_hash", "child-l1-hash"))
        ));
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "session.forked", Map.of(
                "source_session_id", TEST_SESSION_A,
                "anchor_message_id", "anchor-1",
                "at_sequence", 999L,
                "summary_seed", Map.of(
                        "messages", List.of(
                                Map.of("role", "human", "content", "forked prompt"),
                                Map.of("role", "tool", "content", "forked tool result"),
                                Map.of("role", "ai", "content", "forked answer")),
                        "summary", "history summary",
                        "summaryHash", "child-summary-hash",
                        "contextEpoch", "child-epoch-1")
        ));

        ObjectNode context = projectionService.project(sessionId, 0L);

        assertThat(context.get("latest_sequence").asLong()).isEqualTo(3L);
        assertThat(context.get("messages")).hasSize(3);
        assertThat(context.get("messages").get(0).get("content").asText()).isEqualTo("forked prompt");
        assertThat(context.get("messages").get(1).get("role").asText()).isEqualTo("tool");
        assertThat(context.get("messages").get(2).get("content").asText()).isEqualTo("forked answer");

        var epoch = context.get("epoch");
        assertThat(epoch.get("epoch_id").asText()).isEqualTo("child-epoch-1");
        assertThat(epoch.get("summary_hash").asText()).isEqualTo("child-summary-hash");
        assertThat(epoch.get("system_messages").toString()).contains("history summary");
        assertThat(epoch.get("source_hash").asText()).isEqualTo("child-l1-hash");
        assertThat(epoch.get("l1_rendered").asText()).isEqualTo("child L1");

        var forkInfo = context.path("metadata").path("forked_from");
        assertThat(forkInfo.path("source_session_id").asText()).isEqualTo(TEST_SESSION_A);
        assertThat(forkInfo.path("anchor_message_id").asText()).isEqualTo("anchor-1");
        assertThat(forkInfo.has("at_sequence")).isFalse();
    }

    @Test
    void projectUncompressedForkSeedKeepsMessagesWithoutCreatingSummaryBaseline() {
        String sessionId = "bbbbbbb2-0000-0000-0000-000000000000";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "session.created", Map.of(
                "workspace_id", TEST_WS,
                "user_id", TEST_USER,
                "epoch_id", "child-bootstrap",
                "system_messages", List.of("child base system")
        ));
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "session.forked", Map.of(
                "source_session_id", TEST_SESSION_A,
                "anchor_message_id", "anchor-2",
                "summary_seed", Map.of(
                        "messages", List.of(Map.of("role", "human", "content", "uncompressed history")),
                        "contextEpoch", "child-epoch-2")
        ));

        ObjectNode context = projectionService.project(sessionId, 0L);

        assertThat(context.get("messages")).hasSize(1);
        assertThat(context.get("messages").get(0).get("content").asText()).isEqualTo("uncompressed history");
        assertThat(context.get("epoch").get("epoch_id").asText()).isEqualTo("child-epoch-2");
        assertThat(context.get("epoch").get("summary_hash").asText()).isEmpty();
        assertThat(context.get("epoch").get("system_messages").toString()).contains("child base system");
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

    // ------------------------------------------------------------------
    // PLAN-0381 M1 (contract: PLAN-0381/evidence/m1-contract.md): tool
    // history projection — assistant declarations pair by call id, shape-
    // based result reading (B1), dual-read legacy/v2 payloads, explicit
    // degradation, frozen argument bounds.
    // ------------------------------------------------------------------

    @Test
    void toolCalledProjectsAssistantDeclaration() {
        String sessionId = "aaaaab00-0000-0000-0000-000000000001";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "tool.called", Map.of(
                "schemaVersion", 2,
                "toolCallId", "c1",
                "toolName", "read_file",
                "arguments", Map.of("path", "a")
        ));

        ObjectNode ctx = projectionService.project(sessionId, 0L);
        var message = ctx.get("messages").get(0);
        assertThat(message.path("role").asText()).isEqualTo("ai");
        assertThat(message.path("content").asText()).isEmpty();
        assertThat(message.path("tool_calls").get(0).path("call_id").asText()).isEqualTo("c1");
        assertThat(message.path("tool_calls").get(0).path("tool_name").asText()).isEqualTo("read_file");
        assertThat(message.path("tool_calls").get(0).path("arguments").path("path").asText()).isEqualTo("a");
    }

    @Test
    void legacyToolCalledPayloadDualRead() {
        String sessionId = "aaaaab00-0000-0000-0000-000000000002";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "tool.called", Map.of(
                "call_id", "c9",
                "tool_name", "read_file",
                "tool_input", Map.of("path", "b")
        ));

        ObjectNode ctx = projectionService.project(sessionId, 0L);
        var message = ctx.get("messages").get(0);
        assertThat(message.path("tool_calls").get(0).path("call_id").asText()).isEqualTo("c9");
        assertThat(message.path("tool_calls").get(0).path("arguments").path("path").asText()).isEqualTo("b");
    }

    @Test
    void adjacentToolCalledMergeIntoSingleAssistantMessage() {
        String sessionId = "aaaaab00-0000-0000-0000-000000000003";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "tool.called", Map.of(
                "call_id", "c1", "tool_name", "t", "tool_input", Map.of()
        ));
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "tool.called", Map.of(
                "call_id", "c2", "tool_name", "t", "tool_input", Map.of()
        ));

        ObjectNode ctx = projectionService.project(sessionId, 0L);
        var messages = ctx.get("messages");
        assertThat(messages).hasSize(1);
        assertThat(messages.get(0).path("tool_calls")).hasSize(2);
        assertThat(messages.get(0).path("tool_calls").get(0).path("call_id").asText()).isEqualTo("c1");
        assertThat(messages.get(0).path("tool_calls").get(1).path("call_id").asText()).isEqualTo("c2");
    }

    @Test
    void toolCalledWithoutIdDegradesToTextFact() {
        String sessionId = "aaaaab00-0000-0000-0000-000000000004";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "tool.called", Map.of(
                "tool_name", "read_file",
                "tool_input", Map.of("path", "x")
        ));

        ObjectNode ctx = projectionService.project(sessionId, 0L);
        var message = ctx.get("messages").get(0);
        assertThat(message.path("role").asText()).isEqualTo("ai");
        assertThat(message.path("degraded").asBoolean(false)).isTrue();
        assertThat(message.path("tool_calls").isMissingNode()).isTrue();
        assertThat(message.path("content").asText()).startsWith("[unpaired tool call: read_file]");
    }

    @Test
    void toolResultObjectContentProjectsContent() {
        // PLAN-0381 B1 regression: object results used to collapse to "".
        String sessionId = "aaaaab00-0000-0000-0000-000000000005";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "tool.result", Map.of(
                "call_id", "c1",
                "tool_name", "read_file",
                "result", Map.of("content", "file content")
        ));

        ObjectNode ctx = projectionService.project(sessionId, 0L);
        var message = ctx.get("messages").get(0);
        assertThat(message.path("role").asText()).isEqualTo("tool");
        assertThat(message.path("content").asText()).isEqualTo("file content");
        assertThat(message.path("tool_call_id").asText()).isEqualTo("c1");
        assertThat(message.path("tool_name").asText()).isEqualTo("read_file");
        assertThat(message.path("status").asText()).isEqualTo("completed");
        assertThat(message.path("degraded").isMissingNode()).isTrue();
        assertThat(message.path("legacy_normalized").isMissingNode()).isTrue();
    }

    @Test
    void toolResultStringKeepsPlainContent() {
        String sessionId = "aaaaab00-0000-0000-0000-000000000006";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "tool.result", Map.of(
                "call_id", "c1",
                "tool_name", "read_file",
                "result", "plain output"
        ));

        ObjectNode ctx = projectionService.project(sessionId, 0L);
        var message = ctx.get("messages").get(0);
        assertThat(message.path("content").asText()).isEqualTo("plain output");
        assertThat(message.path("legacy_normalized").isMissingNode()).isTrue();
    }

    @Test
    void toolResultContentlessObjectNormalizesToJsonPreview() {
        String sessionId = "aaaaab00-0000-0000-0000-000000000007";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "tool.result", Map.of(
                "call_id", "c1",
                "tool_name", "t",
                "result", Map.of("foo", 1)
        ));

        ObjectNode ctx = projectionService.project(sessionId, 0L);
        var message = ctx.get("messages").get(0);
        assertThat(message.path("content").asText()).isEqualTo("{\"foo\":1}");
        assertThat(message.path("legacy_normalized").asBoolean(false)).isTrue();
    }

    @Test
    void toolResultArrayNormalizesToJsonPreview() {
        String sessionId = "aaaaab00-0000-0000-0000-000000000008";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "tool.result", Map.of(
                "call_id", "c1",
                "tool_name", "t",
                "result", List.of(1, 2)
        ));

        ObjectNode ctx = projectionService.project(sessionId, 0L);
        var message = ctx.get("messages").get(0);
        assertThat(message.path("content").asText()).isEqualTo("[1,2]");
        assertThat(message.path("legacy_normalized").asBoolean(false)).isTrue();
    }

    @Test
    void toolResultM2PreviewShapeCarriesWhitelistFields() {
        // reader-first: the M2 bounded-preview payload must be readable now.
        String sessionId = "aaaaab00-0000-0000-0000-000000000009";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "tool.result", Map.of(
                "toolCallId", "c1",
                "toolName", "read_file",
                "status", "failed",
                "result", Map.of(
                        "preview", "bounded",
                        "truncated", true,
                        "artifactRef", "art-1",
                        "sizeBytes", 9000,
                        "errorCode", "E1"
                )
        ));

        ObjectNode ctx = projectionService.project(sessionId, 0L);
        var message = ctx.get("messages").get(0);
        assertThat(message.path("content").asText()).isEqualTo("bounded");
        assertThat(message.path("tool_call_id").asText()).isEqualTo("c1");
        assertThat(message.path("status").asText()).isEqualTo("failed");
        assertThat(message.path("truncated").asBoolean(false)).isTrue();
        assertThat(message.path("artifact_ref").asText()).isEqualTo("art-1");
        assertThat(message.path("size_bytes").asInt()).isEqualTo(9000);
        assertThat(message.path("error_code").asText()).isEqualTo("E1");
    }

    @Test
    void toolResultMissingCallIdMarksDegraded() {
        String sessionId = "aaaaab00-0000-0000-0000-00000000000a";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "tool.result", Map.of(
                "tool_name", "t",
                "result", "legacy"
        ));

        ObjectNode ctx = projectionService.project(sessionId, 0L);
        var message = ctx.get("messages").get(0);
        assertThat(message.path("degraded").asBoolean(false)).isTrue();
        assertThat(message.path("tool_call_id").isMissingNode()).isTrue();
        assertThat(message.path("status").asText()).isEqualTo("completed");
        assertThat(message.path("content").asText()).isEqualTo("legacy");
    }

    @Test
    void pairingRoundTripThroughProjection() {
        String sessionId = "aaaaab00-0000-0000-0000-00000000000b";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "tool.called", Map.of(
                "call_id", "c1", "tool_name", "read_file", "tool_input", Map.of("path", "a")
        ));
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "tool.result", Map.of(
                "call_id", "c1", "tool_name", "read_file", "result", Map.of("content", "out")
        ));

        ObjectNode ctx = projectionService.project(sessionId, 0L);
        var messages = ctx.get("messages");
        assertThat(messages).hasSize(2);
        assertThat(messages.get(0).path("tool_calls").get(0).path("call_id").asText()).isEqualTo("c1");
        assertThat(messages.get(1).path("tool_call_id").asText()).isEqualTo("c1");
    }

    @Test
    void oversizedToolArgumentsBoundedWithMarker() {
        String sessionId = "aaaaab00-0000-0000-0000-00000000000c";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "tool.called", Map.of(
                "call_id", "c1",
                "tool_name", "write_file",
                "tool_input", Map.of("content", "x".repeat(5000))
        ));

        ObjectNode ctx = projectionService.project(sessionId, 0L);
        var arguments = ctx.get("messages").get(0).path("tool_calls").get(0).path("arguments");
        assertThat(arguments.path("__xihe_truncated__").asBoolean(false)).isTrue();
        assertThat(arguments.path("__chars__").asInt()).isGreaterThan(4096);
    }

    @Test
    void oversizedArgumentMarkerSurvivesEscapingInflation() {
        // review P1-1：prefix 作为 JSON 字符串值会二次转义放大（反斜杠 ×2），
        // 标记对象自身序列化后必须仍 ≤ ARG_LIMIT（与 Python _fit_marker_payload 同规则）。
        String sessionId = "aaaaab00-0000-0000-0000-00000000000d";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "tool.called", Map.of(
                "call_id", "c1",
                "tool_name", "write_file",
                "tool_input", Map.of("path", "\\".repeat(6000))
        ));

        ObjectNode ctx = projectionService.project(sessionId, 0L);
        JsonNode arguments = ctx.get("messages").get(0).path("tool_calls").get(0).path("arguments");
        assertThat(arguments.path("__xihe_truncated__").asBoolean(false)).isTrue();
        assertThat(arguments.toString().length())
                .as("marker must fit ARG_LIMIT after escape inflation")
                .isLessThanOrEqualTo(4096);
    }

    @Test
    void astralArgumentPrefixNeverSplitsSurrogatePairs() {
        // review P1-3 / contract §4：UTF-16 截断（含收缩切点）不得劈开代理对。
        String sessionId = "aaaaab00-0000-0000-0000-00000000000e";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "tool.called", Map.of(
                "call_id", "c1",
                "tool_name", "write_file",
                "tool_input", Map.of("content", "😀".repeat(3000))
        ));

        ObjectNode ctx = projectionService.project(sessionId, 0L);
        JsonNode arguments = ctx.get("messages").get(0).path("tool_calls").get(0).path("arguments");
        assertThat(arguments.path("__xihe_truncated__").asBoolean(false)).isTrue();
        String prefix = arguments.path("__prefix__").asText();
        assertThat(prefix).isNotEmpty();
        assertThat(Character.isHighSurrogate(prefix.charAt(prefix.length() - 1)))
                .as("prefix must never end with a lone high surrogate")
                .isFalse();
        assertThat(arguments.toString().length()).isLessThanOrEqualTo(4096);
    }
}
