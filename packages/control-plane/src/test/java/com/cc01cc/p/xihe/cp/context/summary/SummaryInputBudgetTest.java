package com.cc01cc.p.xihe.cp.context.summary;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * PLAN-0354 V2 spec §4: bounded summarizer input — per-message cap, prune-window
 * budget with an explicit omission marker, blank messages skipped.
 */
class SummaryInputBudgetTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void perMessageContentIsCappedWithMarker() {
        ObjectNode context = mapper.createObjectNode();
        var messages = context.putArray("messages");
        messages.addObject().put("role", "tool").put("content", "x".repeat(10_000));

        String input = newInput(context, 80_000);

        assertThat(input).contains("[truncated ");
        assertThat(input).endsWith("chars]");
        assertThat(input.length()).isLessThan(4_100);
    }

    @Test
    void budgetKeepsNewestMessagesAndMarksOmittedOldOnes() {
        ObjectNode context = mapper.createObjectNode();
        var messages = context.putArray("messages");
        for (int i = 0; i < 20; i++) {
            messages.addObject().put("role", "human").put("content", "m" + i + ":" + "y".repeat(50));
        }

        String input = newInput(context, 300);

        assertThat(input).startsWith("[... ");
        assertThat(input).contains("earlier messages omitted for summarization");
        // Newest message survived; the oldest did not.
        assertThat(input).contains("m19:");
        assertThat(input).doesNotContain("m0:");
        assertThat(input.length()).isLessThan(300 + 80);
    }

    @Test
    void blankMessagesAreSkipped() {
        ObjectNode context = mapper.createObjectNode();
        var messages = context.putArray("messages");
        messages.addObject().put("role", "human").put("content", "   ");
        messages.addObject().put("role", "human").put("content", "real content");

        String input = newInput(context, 80_000);

        assertThat(input).isEqualTo("human: real content");
    }

    private String newInput(ObjectNode context, int budget) {
        SummaryProvider.SummaryRequest request = new SummaryProvider.SummaryRequest(
                "11111111-1111-1111-1111-111111111111",
                "22222222-2222-2222-2222-222222222222",
                "33333333-3333-3333-3333-333333333333",
                context, null, 0L, "auto", null);
        // buildInput is deterministic and does not touch config/HTTP; a bare
        // provider instance with null collaborators keeps the test unit-level.
        LlmSummaryProvider provider = new LlmSummaryProvider(
                null, null, null, null, null, null, mapper);
        return provider.buildInput(request, budget);
    }
}
