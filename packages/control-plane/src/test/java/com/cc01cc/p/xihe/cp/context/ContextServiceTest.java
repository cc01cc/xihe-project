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
        assertThat(messages).hasSize(1);
        assertThat(messages.get(0).get("role").asText()).isEqualTo("system");
        assertThat(messages.get(0).get("content").asText()).contains("Compacted conversation summary");
    }
}
