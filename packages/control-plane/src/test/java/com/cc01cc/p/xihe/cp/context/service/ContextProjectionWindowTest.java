package com.cc01cc.p.xihe.cp.context.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * BL-302 ② (D-163): build-side conversation window.
 *
 * <p>The window must be the largest whole-turn suffix within budget, must never split a tool pair,
 * and its kept rows must be byte-identical to the same suffix of the full (unwindowed) projection.
 * Nothing here touches the database: the window only decides what is materialized.</p>
 */
class ContextProjectionWindowTest {

    private final ObjectMapper json = new ObjectMapper();

    private static long sequenceOf(JsonNode node) {
        return node.path("sequence").asLong();
    }

    /** {@code turns} complete turns, 3 messages each: human, ai with tool call, tool result. */
    private List<ObjectNode> messages(int turns, long firstSequence) {
        List<ObjectNode> messages = new ArrayList<>();
        long sequence = firstSequence;
        for (int i = 0; i < turns; i++) {
            String callId = "call-" + sequence;

            ObjectNode human = json.createObjectNode();
            human.put("role", "human");
            human.put("content", "question " + sequence);
            human.put("sequence", sequence++);
            messages.add(human);

            ObjectNode ai = json.createObjectNode();
            ai.put("role", "ai");
            ai.put("content", "answer " + sequence);
            ai.put("sequence", sequence++);
            ObjectNode call = json.createObjectNode();
            call.put("call_id", callId);
            call.put("tool_name", "read_file");
            ArrayNode toolCalls = json.createArrayNode();
            toolCalls.add(call);
            ai.set("tool_calls", toolCalls);
            messages.add(ai);

            ObjectNode tool = json.createObjectNode();
            tool.put("role", "tool");
            tool.put("content", "result " + sequence);
            tool.put("sequence", sequence++);
            tool.put("tool_call_id", callId);
            messages.add(tool);
        }
        return messages;
    }

    private ObjectNode context(List<ObjectNode> messages) {
        ObjectNode context = json.createObjectNode();
        context.put("aggregate_id", "session-window-test");
        context.put("latest_sequence", messages.isEmpty() ? 0L : sequenceOf(messages.get(messages.size() - 1)));
        ArrayNode array = json.createArrayNode();
        messages.forEach(array::add);
        context.set("messages", array);
        return context;
    }

    private ArrayNode messagesOf(ObjectNode context) {
        return (ArrayNode) context.get("messages");
    }

    private ObjectNode windowOf(ObjectNode context) {
        return (ObjectNode) context.get("window");
    }

    @Test
    void keepsLargestWholeTurnSuffixWithinMessageCap() {
        ObjectNode context = context(messages(10, 1));
        ContextProjectionService.applyWindow(context, json, 7, Long.MAX_VALUE);

        ArrayNode kept = messagesOf(context);
        // 10 turns = 30 messages; the largest whole-turn suffix <= 7 messages is 2 turns = 6.
        assertThat(kept.size()).isEqualTo(6);
        assertThat(kept.get(0).path("role").asText()).isEqualTo("human");
        assertThat(kept.get(0).path("content").asText()).isEqualTo("question 25");

        ObjectNode window = windowOf(context);
        assertThat(window.path("version").asInt()).isEqualTo(ContextProjectionService.WINDOW_VERSION);
        assertThat(window.path("keptMessages").asInt()).isEqualTo(6);
        assertThat(window.path("droppedMessages").asLong()).isEqualTo(24);
        assertThat(window.path("keptMessages").asLong() + window.path("droppedMessages").asLong())
                .isEqualTo(30);
        assertThat(window.path("firstKeptSequence").asLong()).isEqualTo(sequenceOf(kept.get(0)));
        assertThat(window.path("droppedRange").path("fromSequence").asLong()).isEqualTo(1);
        assertThat(window.path("droppedRange").path("toSequence").asLong()).isEqualTo(24);
    }

    @Test
    void neverSplitsAToolPair() {
        ObjectNode context = context(messages(10, 1));
        ContextProjectionService.applyWindow(context, json, 3, Long.MAX_VALUE);

        ArrayNode kept = messagesOf(context);
        assertThat(kept.size()).isEqualTo(3);
        assertThat(kept.get(0).path("role").asText()).isEqualTo("human");
        assertThat(kept.get(1).path("role").asText()).isEqualTo("ai");
        assertThat(kept.get(2).path("role").asText()).isEqualTo("tool");
        String callId = kept.get(2).path("tool_call_id").asText();
        boolean declarationPresent = false;
        for (JsonNode message : kept) {
            for (JsonNode call : message.path("tool_calls")) {
                declarationPresent |= callId.equals(call.path("call_id").asText());
            }
        }
        assertThat(declarationPresent).isTrue();
    }

    @Test
    void keptRowsAreByteIdenticalToTheFullProjectionSuffix() {
        List<ObjectNode> fullMessages = messages(10, 1);
        ObjectNode full = context(fullMessages);
        ObjectNode windowed = context(fullMessages);
        ContextProjectionService.applyWindow(windowed, json, 6, Long.MAX_VALUE);

        ArrayNode kept = messagesOf(windowed);
        int start = fullMessages.size() - kept.size();
        ArrayNode expectedSuffix = json.createArrayNode();
        for (int i = start; i < fullMessages.size(); i++) {
            expectedSuffix.add(fullMessages.get(i));
        }
        // The window only drops the leading part: same nodes, same serialized bytes.
        assertThat(kept.toString()).isEqualTo(expectedSuffix.toString());
        for (int i = 0; i < kept.size(); i++) {
            assertThat(kept.get(i).toString()).isEqualTo(fullMessages.get(start + i).toString());
        }
        // And the kept suffix is exactly the tail of the full replay (same serialization).
        assertThat(kept.toString())
                .isEqualTo("[" + join(fullMessages.subList(start, fullMessages.size())) + "]");
    }

    private String join(List<ObjectNode> nodes) {
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < nodes.size(); i++) {
            if (i > 0) {
                builder.append(',');
            }
            builder.append(nodes.get(i).toString());
        }
        return builder.toString();
    }

    @Test
    void windowHashAndPayloadAreDeterministic() {
        ObjectNode first = context(messages(10, 1));
        ObjectNode second = context(messages(10, 1));
        ContextProjectionService.applyWindow(first, json, 6, Long.MAX_VALUE);
        ContextProjectionService.applyWindow(second, json, 6, Long.MAX_VALUE);

        assertThat(windowOf(first).path("windowHash").asText())
                .isEqualTo(windowOf(second).path("windowHash").asText());
        assertThat(first.toString()).isEqualTo(second.toString());
    }

    @Test
    void incrementalWindowAccumulatesDroppedBookkeeping() {
        ObjectNode context = context(messages(10, 1));
        ContextProjectionService.applyWindow(context, json, 6, Long.MAX_VALUE);
        ObjectNode firstWindow = windowOf(context).deepCopy();

        // The incremental fast path applies suffix events, then re-windows (2 more turns = 6 msgs).
        messagesOf(context).addAll(messages(2, 31));
        ContextProjectionService.applyWindow(context, json, 6, Long.MAX_VALUE);

        ObjectNode secondWindow = windowOf(context);
        assertThat(secondWindow.path("keptMessages").asInt()).isEqualTo(6);
        assertThat(secondWindow.path("droppedMessages").asLong()).isEqualTo(30);
        assertThat(secondWindow.path("droppedMessages").asLong())
                .isEqualTo(firstWindow.path("droppedMessages").asLong() + 6);
        assertThat(secondWindow.path("droppedRange").path("fromSequence").asLong())
                .isEqualTo(firstWindow.path("droppedRange").path("fromSequence").asLong());
        assertThat(secondWindow.path("droppedRange").path("toSequence").asLong())
                .isGreaterThan(firstWindow.path("droppedRange").path("toSequence").asLong());
    }

    @Test
    void byteBudgetIsThePrimaryBudget() {
        ObjectNode context = context(messages(10, 1));
        // Each message is ~60-90 bytes; 500 bytes fits only the last turn or two.
        ContextProjectionService.applyWindow(context, json, 1000, 500L);

        ArrayNode kept = messagesOf(context);
        ObjectNode window = windowOf(context);
        assertThat(window.path("keptBytes").asLong()).isLessThanOrEqualTo(500L);
        assertThat(kept.size()).isLessThan(30);
        assertThat(kept.get(0).path("role").asText()).isEqualTo("human");
    }

    @Test
    void aSingleTurnLargerThanTheBudgetIsKeptWhole() {
        ObjectNode context = context(messages(1, 1));
        ContextProjectionService.applyWindow(context, json, 1, 1L);

        ArrayNode kept = messagesOf(context);
        // The turn cannot be split, so it stays even though it exceeds both budgets.
        assertThat(kept.size()).isEqualTo(3);
        assertThat(windowOf(context).path("droppedMessages").asLong()).isZero();
    }

    @Test
    void contextWithoutHumanBoundariesKeepsEverything() {
        ObjectNode context = json.createObjectNode();
        ArrayNode array = json.createArrayNode();
        ObjectNode ai = json.createObjectNode();
        ai.put("role", "ai");
        ai.put("content", "no turn boundary here");
        ai.put("sequence", 1);
        array.add(ai);
        context.set("messages", array);

        ContextProjectionService.applyWindow(context, json, 0, 1L);
        assertThat(messagesOf(context).size()).isEqualTo(1);
        assertThat(windowOf(context).path("droppedMessages").asLong()).isZero();
    }
}
