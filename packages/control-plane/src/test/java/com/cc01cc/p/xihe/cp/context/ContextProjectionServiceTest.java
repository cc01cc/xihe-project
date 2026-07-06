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

    @Autowired
    private ContextService contextService;

    @Autowired
    private EventStoreService eventStoreService;

    @Autowired
    private ContextProjectionService projectionService;

    @Test
    void project_emptySession_returnsEmptyContext() {
        ObjectNode ctx = projectionService.project("session-1", 0L);
        assertThat(ctx.get("aggregate_id").asText()).isEqualTo("session-1");
        assertThat(ctx.get("latest_sequence").asLong()).isEqualTo(0L);
    }

    @Test
    void project_withEvents_buildsMessages() {
        String sessionId = "session-2";
        contextService.appendEvent(sessionId, "ws-1", "user-1", "session.created", Map.of(
            "workspace_id", "ws-1",
            "user_id", "user-1",
            "epoch_id", "epoch-1",
            "baseline_hash", "hash-1",
            "system_messages", java.util.List.of("You are xihe")
        ));
        contextService.appendEvent(sessionId, "ws-1", "user-1", "prompt.admitted", Map.of(
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
    void project_afterSequence_excludesEarlierEvents() {
        String sessionId = "session-3";
        contextService.appendEvent(sessionId, "ws-1", "user-1", "session.created", Map.of(
            "workspace_id", "ws-1",
            "user_id", "user-1",
            "epoch_id", "epoch-1",
            "baseline_hash", "hash-1",
            "system_messages", java.util.List.of("You are xihe")
        ));
        contextService.appendEvent(sessionId, "ws-1", "user-1", "prompt.admitted", Map.of(
            "message", Map.of("role", "human", "content", "first")
        ));
        contextService.appendEvent(sessionId, "ws-1", "user-1", "prompt.admitted", Map.of(
            "message", Map.of("role", "human", "content", "second")
        ));

        ObjectNode ctx = projectionService.project(sessionId, 2L);

        assertThat(ctx.get("latest_sequence").asLong()).isEqualTo(3L);
        var messages = ctx.get("messages");
        assertThat(messages).hasSize(1);
        assertThat(messages.get(0).get("content").asText()).isEqualTo("second");
    }
}
