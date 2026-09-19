package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.context.service.ContextProjectionService;
import com.cc01cc.p.xihe.cp.context.service.ContextService;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class ContextServiceTest extends AbstractH2Test {

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

    @Autowired
    private com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository approvalRepository;

    @Test
    void forkCreatesNewSessionWithForkedEvent() {
        String sourceSessionId = "aaaaaaa7-0000-0000-0000-000000000000";
        String newSessionId = "aaaaaaa8-0000-0000-0000-000000000000";

        contextService.appendEvent(sourceSessionId, TEST_WS, TEST_USER, "session.created", Map.of(
                "workspace_id", TEST_WS,
                "user_id", TEST_USER,
                "epoch_id", "epoch-1",
                "baseline_hash", "hash-1",
                "system_messages", List.of("You are xihe")
        ));
        contextService.appendEvent(sourceSessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
                "message", Map.of("role", "human", "content", "hello")
        ));

        Long latestSequence = contextService.fork(sourceSessionId, 2L, newSessionId, TEST_WS, TEST_USER);

        assertThat(latestSequence).isEqualTo(3L);
        List<com.cc01cc.p.xihe.cp.context.entity.ContextEvent> newEvents = eventStoreService.read(newSessionId, 0L);
        assertThat(newEvents).hasSize(3);
        assertThat(newEvents.get(0).getEventType()).isEqualTo("session.created");
        assertThat(newEvents.get(1).getEventType()).isEqualTo("prompt.admitted");
        assertThat(newEvents.get(2).getEventType()).isEqualTo("session.forked");
        assertThat(newEvents.get(2).getSequence()).isEqualTo(3L);
    }

    @Test
    void replayReturnsSnapshotAndEvents() {
        String sessionId = "aaaaaaa6-0000-0000-0000-000000000000";

        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "session.created", Map.of(
                "workspace_id", TEST_WS,
                "user_id", TEST_USER,
                "epoch_id", "epoch-1",
                "baseline_hash", "hash-1",
                "system_messages", List.of("You are xihe")
        ));
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
                "message", Map.of("role", "human", "content", "hello")
        ));

        Map<String, Object> result = contextService.replay(sessionId, TEST_WS, TEST_USER, 0L);

        assertThat(result).containsKey("snapshot");
        assertThat(result).containsKey("events");
        @SuppressWarnings("unchecked")
        List<com.cc01cc.p.xihe.cp.context.entity.ContextEvent> events = (List<com.cc01cc.p.xihe.cp.context.entity.ContextEvent>) result.get("events");
        assertThat(events).hasSize(2);
    }

    @Test
    void compactAppendsCompactionEventAndClearsMessages() {
        String sessionId = "aaaaaaac-0000-0000-0000-000000000000";

        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "session.created", Map.of(
                "workspace_id", TEST_WS,
                "user_id", TEST_USER,
                "epoch_id", "epoch-1",
                "baseline_hash", "hash-1",
                "system_messages", List.of("You are xihe")
        ));
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
                "message", Map.of("role", "human", "content", "hello")
        ));
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
                "message", Map.of("role", "human", "content", "world")
        ));

        com.cc01cc.p.xihe.cp.context.entity.ContextEvent event = contextService.compact(sessionId, TEST_WS, TEST_USER, 3L);

        assertThat(event.getEventType()).isEqualTo("compaction.applied");
        assertThat(event.getSequence()).isEqualTo(4L);

        var snapshot = projectionService.project(sessionId, 0L);
        assertThat(snapshot.get("latest_sequence").asLong()).isEqualTo(4L);
        var messages = snapshot.get("messages");
        // PLAN-0341 T1.4 (V4): summary lives only in SUM (epoch.system_messages).
        // messages is keep-recent only — no summary system message.
        assertThat(messages).hasSize(2);
        assertThat(messages.get(0).get("content").asText()).isEqualTo("hello");
        assertThat(messages.get(1).get("content").asText()).isEqualTo("world");
        var epoch = snapshot.get("epoch");
        assertThat(epoch.get("system_messages").toString()).contains("[Goal]");
        assertThat(epoch.get("summary_hash").asText()).isNotBlank();
    }

    @Test
    void autoCompactGate_respectsCooldownWindow() {
        // PLAN-294 decision #18: a compaction must be followed by at least
        // COMPACTION_COOLDOWN_EVENTS new events before the gate re-arms.
        String sessionId = "aaaaaaad-0000-0000-0000-000000000000";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "session.created", Map.of(
                "workspace_id", TEST_WS, "user_id", TEST_USER,
                "epoch_id", "e1", "baseline_hash", "h1",
                "system_messages", List.of("sys")));
        for (int i = 0; i < 60; i++) {
            contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
                    "message", Map.of("role", "human", "content", "m" + i)));
        }
        contextService.compact(sessionId, TEST_WS, TEST_USER, null);

        // Only 3 new events since the cursor — cooldown blocks the gate.
        for (int i = 0; i < 3; i++) {
            contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
                    "message", Map.of("role", "human", "content", "n" + i)));
        }
        assertThat(contextService.shouldAutoCompact(sessionId)).isFalse();
    }

    @Test
    void autoCompactGate_messageVolumeTriggers() {
        // 60 messages, no prior compaction: the message-count fallback fires
        // (deterministic trigger; the token signal needs usage events).
        String sessionId = "aaaaaaae-0000-0000-0000-000000000000";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "session.created", Map.of(
                "workspace_id", TEST_WS, "user_id", TEST_USER,
                "epoch_id", "e1", "baseline_hash", "h1",
                "system_messages", List.of("sys")));
        for (int i = 0; i < 60; i++) {
            contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
                    "message", Map.of("role", "human", "content", "m" + i)));
        }
        assertThat(contextService.shouldAutoCompact(sessionId)).isTrue();
    }

    @Test
    void overflowCompaction_clearsCooldownGate() {
        // PLAN-0341 decision #3: overflow-forced compaction tags trigger=overflow
        // and the next shouldAutoCompact must not be blocked by cooldown.
        String sessionId = "aaaaaaaf-0000-0000-0000-000000000000";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "session.created", Map.of(
                "workspace_id", TEST_WS, "user_id", TEST_USER,
                "epoch_id", "e1", "baseline_hash", "h1",
                "system_messages", List.of("sys")));
        for (int i = 0; i < 60; i++) {
            contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
                    "message", Map.of("role", "human", "content", "m" + i)));
        }
        com.cc01cc.p.xihe.cp.context.entity.ContextEvent overflowEvent =
                contextService.compactForOverflow(sessionId, TEST_WS, TEST_USER);
        assertThat(overflowEvent.getEventType()).isEqualTo("compaction.applied");

        // Stay inside the 10-event cooldown window, then raise the token signal
        // so the gate would fire if (and only if) cooldown is cleared.
        for (int i = 0; i < 3; i++) {
            contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
                    "message", Map.of("role", "human", "content", "n" + i)));
        }
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "llm.usage", Map.of(
                "usage", Map.of("inputTokens", 100_000L, "windowTokens", 128_000L)));
        assertThat(contextService.shouldAutoCompact(sessionId)).isTrue();
    }

    @Test
    void normalCompaction_cooldownStillBlocks() {
        // Control for overflowCompaction_clearsCooldownGate: a normal compact
        // keeps the cooldown gate armed.
        String sessionId = "aaaaaabc-0000-0000-0000-000000000000";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "session.created", Map.of(
                "workspace_id", TEST_WS, "user_id", TEST_USER,
                "epoch_id", "e1", "baseline_hash", "h1",
                "system_messages", List.of("sys")));
        for (int i = 0; i < 60; i++) {
            contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
                    "message", Map.of("role", "human", "content", "m" + i)));
        }
        contextService.compact(sessionId, TEST_WS, TEST_USER, null);
        for (int i = 0; i < 3; i++) {
            contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
                    "message", Map.of("role", "human", "content", "n" + i)));
        }
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "llm.usage", Map.of(
                "usage", Map.of("inputTokens", 100_000L, "windowTokens", 128_000L)));
        assertThat(contextService.shouldAutoCompact(sessionId)).isFalse();
    }

    @Test
    void preflightRetryAfterOverflow_usesConfiguredWindow() {
        // PLAN-0341 T1.1: preflight must respect configured maxInputTokens.
        // Tiny window → estimate still over the limit → do not retry.
        String sessionId = "aaaaaabb-0000-0000-0000-000000000000";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "session.created", Map.of(
                "workspace_id", TEST_WS, "user_id", TEST_USER,
                "epoch_id", "e1", "baseline_hash", "h1",
                "system_messages", List.of("sys")));
        // Large content so the chars/4 estimate is meaningful.
        StringBuilder big = new StringBuilder();
        for (int i = 0; i < 200; i++) {
            big.append("x".repeat(200));
        }
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
                "message", Map.of("role", "human", "content", big.toString())));
        contextService.compactForOverflow(sessionId, TEST_WS, TEST_USER);

        // 8K window: estimate (~200*200/4 = 10_000 tokens) exceeds 8K*0.7*1.1.
        assertThat(contextService.preflightRetryAfterOverflow(sessionId, 8_000L)).isFalse();
        // 1M window: estimate fits comfortably.
        assertThat(contextService.preflightRetryAfterOverflow(sessionId, 1_000_000L)).isTrue();
    }

    // ------------------------------------------------------------------
    // PLAN-0341 T1.3: carry-forward, shrink validation, recovery band
    // ------------------------------------------------------------------

    @Test
    void summaryCarryForward_dedupsFilesAndKeepsGoal() {
        String sessionId = "aaaaaacc-0000-0000-0000-000000000000";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "session.created", Map.of(
                "workspace_id", TEST_WS, "user_id", TEST_USER,
                "epoch_id", "e1", "baseline_hash", "h1",
                "system_messages", List.of("sys")));
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
                "message", Map.of("role", "human", "content", "fix src/App.vue please")));
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "assistant.responded", Map.of(
                "message", Map.of("role", "ai", "content", "editing src/App.vue and src/main.ts")));
        contextService.compact(sessionId, TEST_WS, TEST_USER, null);
        var first = contextService.readEvents(sessionId, 0L).stream()
                .filter(e -> "compaction.applied".equals(e.getEventType()))
                .findFirst().orElseThrow();
        String firstSummary;
        try {
            firstSummary = new com.fasterxml.jackson.databind.ObjectMapper()
                    .readTree(first.getPayload()).path("summary").asText();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
        assertThat(firstSummary).contains("[Goal]");
        assertThat(firstSummary).contains("src/App.vue");
        assertThat(firstSummary).doesNotContain("[Decisions]");

        // Second compact: files must still appear exactly once in [Files&Artifacts].
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
                "message", Map.of("role", "human", "content", "now touch src/App.vue again")));
        contextService.compact(sessionId, TEST_WS, TEST_USER, null);
        var second = contextService.readEvents(sessionId, 0L).stream()
                .filter(e -> "compaction.applied".equals(e.getEventType()))
                .reduce((a, b) -> b).orElseThrow();
        String secondSummary;
        try {
            secondSummary = new com.fasterxml.jackson.databind.ObjectMapper()
                    .readTree(second.getPayload()).path("summary").asText();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
        // Carry-forward / truncation both keep the file reference.
        assertThat(secondSummary).contains("src/App.vue");
    }

    @Test
    void shrinkValidation_alwaysLeavesAppliedEvent() {
        String sessionId = "aaaaaadd-0000-0000-0000-000000000000";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "session.created", Map.of(
                "workspace_id", TEST_WS, "user_id", TEST_USER,
                "epoch_id", "e1", "baseline_hash", "h1",
                "system_messages", List.of("sys")));
        for (int i = 0; i < 15; i++) {
            contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
                    "message", Map.of("role", "human", "content", "turn " + i + " " + "y".repeat(200))));
        }
        contextService.compact(sessionId, TEST_WS, TEST_USER, null);
        for (int i = 0; i < 15; i++) {
            contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
                    "message", Map.of("role", "human", "content", "more " + i)));
        }
        contextService.compact(sessionId, TEST_WS, TEST_USER, null);

        var events = contextService.readEvents(sessionId, 0L);
        assertThat(events.stream()
                .anyMatch(e -> "compaction.applied".equals(e.getEventType()))).isTrue();
    }

    @org.junit.jupiter.api.Test
    void shrinkFailed_truncationKeepsConstraints() {
        // PLAN-0367 F1 (0354 I3): when shrink validation fails, the truncation
        // degradation must still carry [Constraints]. The constraint message is
        // outside the keep-recent tail after the first compaction, so the phrase
        // can only survive through prior carry-forward.
        String sessionId = "aaaaaab1-0000-0000-0000-000000000000";
        String constraint = "Do not touch the production config, ask first";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "session.created", Map.of(
                "workspace_id", TEST_WS, "user_id", TEST_USER,
                "epoch_id", "e1", "baseline_hash", "h1",
                "system_messages", List.of("sys")));
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
                "message", Map.of("role", "human", "content", constraint)));
        for (int i = 0; i < 14; i++) {
            contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
                    "message", Map.of("role", "human", "content", "s" + i)));
        }
        contextService.compact(sessionId, TEST_WS, TEST_USER, null);

        // Short non-recent messages + a long keep-recent tail: the next rule
        // summary (prior carry + keep-recent tail) cannot shrink below the
        // reclaimed source, so the shrink validation must fail.
        for (int i = 0; i < 5; i++) {
            contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
                    "message", Map.of("role", "human", "content", "n" + i)));
        }
        for (int i = 0; i < 10; i++) {
            contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
                    "message", Map.of("role", "human", "content", "L".repeat(4000))));
        }
        contextService.compact(sessionId, TEST_WS, TEST_USER, null);

        var applied = contextService.readEvents(sessionId, 0L).stream()
                .filter(e -> "compaction.applied".equals(e.getEventType()))
                .reduce((a, b) -> b).orElseThrow();
        com.fasterxml.jackson.databind.JsonNode payload;
        try {
            payload = new com.fasterxml.jackson.databind.ObjectMapper().readTree(applied.getPayload());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
        assertThat(payload.path("fallbackReason").asText()).isEqualTo("shrink_failed");
        String summary = payload.path("summary").asText();
        assertThat(summary).contains("[Constraints]");
        assertThat(summary).contains("Do not touch the production config");
    }

    @org.junit.jupiter.api.Test
    void constraints_extractedVerbatimFromUserMessagesAndApprovals() {
        // PLAN-0341 T1.5 (I6): explicit user constraints + decided approvals
        // land in [Constraints] verbatim; hardcoded [Decisions] is gone.
        String sessionId = "aaaaaaff-0000-0000-0000-000000000000";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "session.created", Map.of(
                "workspace_id", TEST_WS, "user_id", TEST_USER,
                "epoch_id", "e1", "baseline_hash", "h1",
                "system_messages", List.of("sys")));
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
                "message", Map.of("role", "human",
                        "content", "请修改代码。不要动 production 配置，必须先确认再提交。")));
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "assistant.responded", Map.of(
                "message", Map.of("role", "ai", "content", "ok, only touching src/")));

        // Decided approval row.
        var approval = new com.cc01cc.p.xihe.cp.entity.ChatApproval(
                java.util.UUID.randomUUID().toString(),
                "aaaaa000-0000-0000-0000-000000000001", sessionId, TEST_USER, TEST_WS,
                "write_file", "src/App.vue", "{}", "approved",
                java.time.Instant.now().plusSeconds(3600));
        approval.setApproved(true);
        approvalRepository.save(approval);

        contextService.compact(sessionId, TEST_WS, TEST_USER, null);
        var event = contextService.readEvents(sessionId, 0L).stream()
                .filter(e -> "compaction.applied".equals(e.getEventType()))
                .findFirst().orElseThrow();
        String summary;
        try {
            summary = new com.fasterxml.jackson.databind.ObjectMapper()
                    .readTree(event.getPayload()).path("summary").asText();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
        assertThat(summary).doesNotContain("[Decisions]");
        assertThat(summary).contains("[Constraints]");
        assertThat(summary).contains("不要动 production 配置");
        assertThat(summary).contains("[approved] write_file");
    }

    @Test
    void recoveryBand_opensCircuitWhenResidualStaysHigh() {
        // PLAN-0341 T1.3 I3: when keep-recent itself is huge, residual stays
        // above recoveryBand × soft threshold → circuit opens and auto is paused.
        String sessionId = "aaaaaaee-0000-0000-0000-000000000000";
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "session.created", Map.of(
                "workspace_id", TEST_WS, "user_id", TEST_USER,
                "epoch_id", "e1", "baseline_hash", "h1",
                "system_messages", List.of("sys")));
        // Window 60K tokens → bandLimit = 60K * 0.7 * 0.8 = 33600 tokens ≈ 134400 chars.
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "llm.usage", Map.of(
                "usage", Map.of("inputTokens", 50_000L, "windowTokens", 60_000L)));
        // Fill volume so the gate would otherwise fire, with a giant keep-recent tail.
        for (int i = 0; i < 55; i++) {
            contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
                    "message", Map.of("role", "human", "content", "m" + i)));
        }
        // Last messages sit inside KEEP_RECENT_MESSAGES and stay verbatim after
        // compaction — residual therefore remains above the recovery band.
        for (int i = 0; i < 8; i++) {
            contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
                    "message", Map.of("role", "human", "content", "G".repeat(20_000))));
        }

        contextService.compactForOverflow(sessionId, TEST_WS, TEST_USER);

        var events = contextService.readEvents(sessionId, 0L);
        boolean circuitOpen = events.stream().anyMatch(e ->
                "context.compaction_circuit".equals(e.getEventType())
                        && e.getPayload().contains("open"));
        assertThat(circuitOpen).isTrue();
        assertThat(contextService.shouldAutoCompact(sessionId)).isFalse();

        // Growth past the residual recorded at open (×1.15) closes the circuit.
        // Push more verbatim keep-recent content so the estimate grows.
        for (int i = 0; i < 6; i++) {
            contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted", Map.of(
                    "message", Map.of("role", "human", "content", "H".repeat(20_000))));
        }
        assertThat(contextService.shouldAutoCompact(sessionId)).isTrue();
    }
}
