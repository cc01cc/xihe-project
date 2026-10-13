package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.context.entity.ContextEvent;
import com.cc01cc.p.xihe.cp.context.repository.ContextProjectionRepository;
import com.cc01cc.p.xihe.cp.context.repository.EventStoreRepository;
import com.cc01cc.p.xihe.cp.context.service.ContextProjectionService;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.provider.ApiInputTypeService;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.cc01cc.p.xihe.cp.service.SessionLockService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.verifyNoInteractions;

/** Pure replay tests use actual native records and the production projector. */
class NativeCarrierProjectionTest {
    private final ObjectMapper json = new ObjectMapper();
    private final EventStoreService events = mock(EventStoreService.class);
    private final ContextProjectionService projector = new ContextProjectionService(events,
            mock(ContextProjectionRepository.class), mock(BranchPathService.class), json);
    private long sequence;

    @Test
    void fullAndCursorReplayReplaceOnlyTheCorrelatedRunAndKeepEpoch() throws Exception {
        var input = new ArrayList<ContextEvent>();
        input.add(event("epoch.started", null, Map.of("epoch_id", "stable", "system_messages", List.of("base"))));
        input.addAll(runEvents());
        when(events.read("session", 0L, null)).thenReturn(input);
        ObjectNode full = projector.project("session", 0L, null);
        assertEquals(full, projector.project("session", 3L, null));
        assertEquals("stable", full.path("epoch").path("epoch_id").asText());
        assertEquals(4, full.path("messages").size());
        assertEquals("earlier answer", full.path("messages").get(1).path("content").asText());
        JsonNode carrier = full.path("messages").get(3);
        assertEquals("anthropic-messages", carrier.path("apiTypeId").asText());
        assertEquals("exact-signature", carrier.path("nativeRecords").get(0).path("content").get(0).path("signature").asText());
        assertFalse(carrier.has("tool_calls"));
        assertEquals(full, projector.project("session", 0L, null)); // restart-equivalent deterministic replay
    }

    @Test
    void lateOldToolTombstoneRemovesItsWholeCarrier() throws Exception {
        var input = runEvents();
        input.add(event("context.prune", null, Map.of("tombstones", List.of(Map.of("content_hash", hash("bounded tool output"))))));
        when(events.read("session", 0L, null)).thenReturn(input);
        JsonNode messages = projector.project("session", 0L, null).path("messages");
        assertEquals(3, messages.size());
        assertTrue(messages.toString().contains("current human"));
        assertFalse(messages.toString().contains("nativeRecords"));
        assertFalse(messages.toString().contains("bounded tool output"));
    }

    @Test
    void pruneBeforeFinalCarrierCannotResurrectNativeToolContent() throws Exception {
        var input = runEvents();
        ContextEvent finalCarrier = input.remove(input.size() - 1);
        input.add(event("context.prune", null, Map.of("tombstones", List.of(Map.of("content_hash", hash("bounded tool output"))))));
        input.add(finalCarrier);
        input.add(finalCarrier); // repeated final publication must remain blocked after prune
        input.add(event("tool.result", "current", Map.of("toolCallId", "call", "result", "bounded tool output")));
        when(events.read("session", 0L, null)).thenReturn(input);
        JsonNode messages = projector.project("session", 0L, null).path("messages");
        assertEquals(3, messages.size());
        assertFalse(messages.toString().contains("nativeRecords"));
    }

    @Test
    void forkPreservesCarrierAndCarrierHashPruneRemovesItAtomically() throws Exception {
        when(events.read("session", 0L, null)).thenReturn(runEvents());
        JsonNode original = projector.project("session", 0L, null).path("messages");
        var fork = new ArrayList<ContextEvent>();
        fork.add(event("session.forked", null, Map.of("source_session_id", "source", "anchor_message_id", "anchor",
                "summary_seed", Map.of("messages", original, "contextEpoch", "child-epoch"))));
        when(events.read("child", 0L, null)).thenReturn(fork);
        assertEquals(original, projector.project("child", 0L, null).path("messages"));
        fork.add(event("context.prune", null, Map.of("tombstones", List.of(Map.of("content_hash", hash("final answer"))))));
        assertEquals(3, projector.project("child", 0L, null).path("messages").size());
    }

    @Test
    void compactionDropsCarrierAsOneMessageWithoutRestoringItsTools() throws Exception {
        var input = runEvents();
        for (int i = 0; i < 12; i++) {
            input.add(event("prompt.admitted", "later-" + i, Map.of("content", "human " + i)));
        }
        input.add(event("compaction.applied", null, Map.of("summary", "summary", "summaryHash", "sum")));
        when(events.read("session", 0L, null)).thenReturn(input);
        ObjectNode result = projector.project("session", 0L, null);
        assertEquals(10, result.path("messages").size());
        assertFalse(result.path("messages").toString().contains("nativeRecords"));
        assertFalse(result.path("messages").toString().contains("bounded tool output"));
        assertEquals("sum", result.path("epoch").path("summary_hash").asText());
    }

    @Test
    void malformedOrUnregisteredCarrierFailsBeforeDurableStorage() {
        var repository = mock(EventStoreRepository.class);
        var store = new EventStoreService(repository, mock(SessionLockService.class), json,
                mock(DbLockTimeout.class), mock(BranchPathService.class));
        ReflectionTestUtils.setField(store, "apiTypes", new ApiInputTypeService(json));
        for (Map<String, Object> message : List.of(
                Map.<String, Object>of("apiTypeId", "anthropic-messages"),
                Map.<String, Object>of("apiTypeId", "unknown", "apiTypeVersion", 1, "nativeRecords", List.of(Map.of("role", "assistant"))),
                Map.<String, Object>of("apiTypeId", "anthropic-messages", "apiTypeVersion", 1, "nativeRecords", List.of("invalid")))) {
            CpApiException failure = assertThrows(CpApiException.class, () -> store.append("session", "ws", "user",
                    "assistant.responded", Map.of("message", message), "run"));
            assertEquals("INVALID_REQUEST", failure.getCode());
        }
        verifyNoInteractions(repository);
    }

    private ArrayList<ContextEvent> runEvents() throws Exception {
        var input = new ArrayList<ContextEvent>();
        input.add(event("prompt.admitted", "old", Map.of("content", "earlier human")));
        input.add(event("assistant.responded", "old", Map.of("content", "earlier answer")));
        input.add(event("prompt.admitted", "current", Map.of("content", "current human")));
        input.add(event("tool.called", "current", Map.of("toolCallId", "call", "toolName", "read", "arguments", Map.of("path", "file"))));
        input.add(event("tool.result", "current", Map.of("toolCallId", "call", "toolName", "read", "result", "bounded tool output")));
        input.add(event("assistant.responded", "current", Map.of("message", Map.of("role", "ai", "content", "final answer",
                "apiTypeId", "anthropic-messages", "apiTypeVersion", 1, "nativeRecords", List.of(
                        Map.of("role", "assistant", "content", List.of(Map.of("type", "thinking", "thinking", "reason", "signature", "exact-signature"))),
                        Map.of("role", "user", "content", List.of(Map.of("type", "tool_result", "tool_use_id", "call", "content", "bounded tool output"))),
                        Map.of("role", "assistant", "content", List.of(Map.of("type", "text", "text", "final answer"))))))));
        return input;
    }

    @Test
    void precisePruneAfterCarrierKeepsOccurrenceAndBlocksLateCarrierAcrossFullReplays() throws Exception {
        var input = runEvents();
        ContextEvent toolResult = input.get(4);
        ContextEvent carrier = input.get(5);
        when(events.read("session", 0L, null)).thenReturn(input);
        assertEquals(carrier.getSequence(), projector.project("session", 0L, null)
                .path("messages").get(3).path("sequence").asLong());
        input.add(event("context.prune", "current", Map.of("tombstones", List.of(Map.of(
                "sequence", toolResult.getSequence(), "tool_call_id", "call")))));
        ObjectNode pruned = projector.project("session", 0L, null);
        assertFalse(pruned.path("messages").toString().contains("nativeRecords"));
        assertEquals(3, pruned.path("messages").size());
        assertEquals(pruned, projector.project("session", carrier.getSequence(), null));
        input.add(event("assistant.responded", "current", json.readValue(carrier.getPayload(), Map.class)));
        ObjectNode restarted = projector.project("session", 0L, null);
        assertEquals(pruned.path("messages"), restarted.path("messages"));
        assertEquals(restarted, projector.project("session", toolResult.getSequence(), null));
        assertFalse(restarted.path("messages").toString().contains("bounded tool output"));
    }

    @Test
    void reusedCallIdInDifferentRunsKeepsDistinctOccurrencesAndOnlyPrunesNamedSequence() throws Exception {
        var input = new ArrayList<ContextEvent>();
        input.add(event("tool.called", "run-a", Map.of("toolCallId", "reused", "toolName", "read")));
        input.add(event("tool.called", "run-b", Map.of("toolCallId", "reused", "toolName", "read")));
        ContextEvent first = event("tool.result", "run-a", Map.of("toolCallId", "reused", "result", "same"));
        ContextEvent second = event("tool.result", "run-b", Map.of("toolCallId", "reused", "result", "same"));
        input.add(first);
        input.add(second);
        input.add(event("context.prune", "run-b", Map.of("tombstones", List.of(Map.of(
                "sequence", second.getSequence(), "tool_call_id", "reused")))));
        when(events.read("session", 0L, null)).thenReturn(input);
        JsonNode messages = projector.project("session", 0L, null).path("messages");
        assertEquals(4, messages.size());
        assertEquals("same", messages.get(2).path("content").asText());
        assertEquals(first.getSequence(), messages.get(2).path("sequence").asLong());
        assertFalse(messages.get(2).path("pruned").asBoolean());
        assertEquals("[old tool result cleared]", messages.get(3).path("content").asText());
    }

    @Test
    void multipleTombstonesKeepSequenceAndCallIdPairsInsteadOfCrossMatchingSets() throws Exception {
        var input = new ArrayList<ContextEvent>();
        ContextEvent a = event("tool.result", "run-a", Map.of("toolCallId", "a", "result", "one"));
        ContextEvent b = event("tool.result", "run-b", Map.of("toolCallId", "b", "result", "two"));
        input.add(a);
        input.add(b);
        input.add(event("context.prune", "run-b", Map.of("tombstones", List.of(
                Map.of("sequence", a.getSequence(), "tool_call_id", "b"),
                Map.of("sequence", b.getSequence(), "tool_call_id", "a")))));
        when(events.read("session", 0L, null)).thenReturn(input);
        JsonNode messages = projector.project("session", 0L, null).path("messages");
        assertEquals("one", messages.get(0).path("content").asText());
        assertEquals("two", messages.get(1).path("content").asText());
        assertFalse(messages.toString().contains("pruned"));
    }

    private ContextEvent event(String type, String run, Object payload) throws Exception {
        var event = new ContextEvent("session", "ws", "user", type, ++sequence, json.writeValueAsString(payload));
        event.setCorrelationId(run);
        return event;
    }

    private String hash(String value) throws Exception {
        return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
    }
}
