package com.cc01cc.p.xihe.cp.mcp;

import com.cc01cc.p.xihe.cp.chat.ChatSubmissionService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-71: the bounded-preview rule has exactly one declared source per carrier, and the six call
 * sites cannot drift back to an inline literal.
 *
 * <p>The audit that produced task-71 recorded that the existing tests only pinned the <em>value</em>
 * ({@code <= 4096} asserted as a literal), so a regression to six hand-copied bounds would stay
 * green. The last test here is the missing half: it fails if any site keeps the inline truncation,
 * which is the shape the duplication came back through. Scanning sources is not a new idea in this
 * module — {@code Jackson2NodeWireScanTest} guards a property ArchUnit cannot see for the same
 * reason (values, not types).</p>
 */
class PreviewLimitsTest {

    /** The six write points of task-71 (three of them live in {@code McpProxyController}). */
    private static final List<String> PREVIEW_SITES = List.of(
            "src/main/java/com/cc01cc/p/xihe/cp/chat/ApprovalService.java",
            "src/main/java/com/cc01cc/p/xihe/cp/mcp/McpInvocationService.java",
            "src/main/java/com/cc01cc/p/xihe/cp/mcp/McpProxyController.java",
            "src/main/java/com/cc01cc/p/xihe/cp/mcp/McpRelayToolRecorder.java");

    /** The shape task-71 removed; reappearing means the bound drifted out of {@link PreviewLimits}. */
    private static final Pattern INLINE_PREVIEW_LITERAL = Pattern.compile("substring\\(0, 4096\\)|<= 4096");

    @Test
    void boundsStayPinnedToThePersistedContractValue() {
        assertEquals(4096, PreviewLimits.ARGUMENTS_PREVIEW_CHARS);
        assertEquals(4096, PreviewLimits.APPROVAL_HISTORY_PREVIEW_CHARS);
    }

    @Test
    void toolArgumentsPreview_keepsShortInputAndTruncatesAtTheSharedBound() {
        ObjectMapper mapper = new ObjectMapper();

        assertEquals("{\"prompt\":\"hi\"}",
                McpProxyController.toolArgumentsPreview(
                        "{\"params\":{\"arguments\":{\"prompt\":\"hi\"}}}", mapper));

        String oversizedArguments = "{\"params\":{\"arguments\":{\"prompt\":\""
                + "x".repeat(PreviewLimits.ARGUMENTS_PREVIEW_CHARS) + "\"}}}";
        assertEquals(PreviewLimits.ARGUMENTS_PREVIEW_CHARS,
                McpProxyController.toolArgumentsPreview(oversizedArguments, mapper).length());

        String unparseableBody = "x".repeat(PreviewLimits.ARGUMENTS_PREVIEW_CHARS + 10);
        assertEquals(PreviewLimits.ARGUMENTS_PREVIEW_CHARS,
                McpProxyController.toolArgumentsPreview(unparseableBody, mapper).length());
    }

    /**
     * The other half of the same contract: {@code ChatSubmissionService} refuses a spawn whose
     * {@code arguments_preview} sits at the bound (it can no longer prove the text is complete), so
     * its gate is the read side of {@link PreviewLimits#ARGUMENTS_PREVIEW_CHARS}. Read by reflection
     * because the field stays private on purpose — its name says "spawn gate", the value says
     * "preview bound", and this test is what keeps them the same number. A behavioural test would
     * have to instantiate the whole submission service (private, non-static {@code deriveSpawnContent}
     * plus its constructor graph) to assert the same property, which costs far more than it proves.
     */
    @Test
    void spawnGateMovesWithTheArgumentsPreviewBound() throws Exception {
        Field gate = ChatSubmissionService.class.getDeclaredField("MAX_SPAWN_ARGUMENTS_PREVIEW_LENGTH");
        gate.setAccessible(true);
        assertEquals(PreviewLimits.ARGUMENTS_PREVIEW_CHARS, gate.getInt(null),
                "ChatSubmissionService.MAX_SPAWN_ARGUMENTS_PREVIEW_LENGTH is the read side of the same"
                        + " contract as PreviewLimits.ARGUMENTS_PREVIEW_CHARS; the two must not diverge");
    }

    @Test
    void noPreviewSiteKeepsAnInlineBoundLiteral() throws IOException {
        for (String site : PREVIEW_SITES) {
            Path path = Path.of(site);
            assertTrue(Files.exists(path), "preview site moved; update task-71's site list: " + site);
            assertFalse(INLINE_PREVIEW_LITERAL.matcher(Files.readString(path)).find(),
                    site + " still carries the inline 4096 truncation; reference PreviewLimits instead");
        }
    }
}
