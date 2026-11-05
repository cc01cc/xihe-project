package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.context.entity.ContextProjection;
import com.cc01cc.p.xihe.cp.context.repository.ContextProjectionRepository;
import com.cc01cc.p.xihe.cp.context.service.ContextProjectionService;
import com.cc01cc.p.xihe.cp.context.service.ContextProjectionService.IncrementalProjection;
import com.cc01cc.p.xihe.cp.context.service.ContextService;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * BL-305 (P1): the snapshot read path reuses the stored projection and replays only the event
 * suffix when that is provably equivalent to a full replay.
 *
 * <p>The contract under test has three states — projection missing (full build), projection behind
 * (incremental catch-up, byte-identical to full replay) and projection ahead (ignored + repaired) —
 * plus the safety gates: carrier-bearing payloads and history-rewriting suffix events must fall
 * back to the full replay instead of producing a drifted snapshot.</p>
 */
class ContextProjectionIncrementalTest extends AbstractH2Test {

    private static final String TEST_WS = "bbbbbbb1-0000-0000-0000-000000000000";
    private static final String TEST_USER = "bbbbbbb2-0000-0000-0000-000000000000";

    @Autowired
    private ContextService contextService;

    @Autowired
    private ContextProjectionService projectionService;

    @Autowired
    private ContextProjectionRepository projectionRepository;

    @Autowired
    private BranchPathService branchPathService;

    @Test
    void missingProjectionFallsBackToFullReplay() {
        String sessionId = newSessionId();
        seedTwoTurns(sessionId);
        String branchId = branchPathService.ensureRootBranchId(sessionId);

        Optional<IncrementalProjection> incremental = attempt(sessionId, branchId);
        assertThat(incremental).as("no stored projection = full build").isEmpty();

        ObjectNode saved = projectionService.projectAndSave(sessionId, TEST_WS, TEST_USER, 0L, branchId);
        assertThat(saved.toString()).isEqualTo(expected(sessionId, branchId));
    }

    @Test
    void upToDateSnapshotReusesStoredProjectionWithoutReplaying() {
        String sessionId = newSessionId();
        seedTwoTurns(sessionId);
        String branchId = branchPathService.ensureRootBranchId(sessionId);
        projectionService.projectAndSave(sessionId, TEST_WS, TEST_USER, 0L, branchId);

        Optional<IncrementalProjection> incremental = attempt(sessionId, branchId);
        assertThat(incremental).isPresent();
        assertThat(incremental.get().suffixEvents()).isZero();
        assertThat(incremental.get().context().toString()).isEqualTo(expected(sessionId, branchId));

        ObjectNode second = projectionService.projectAndSave(sessionId, TEST_WS, TEST_USER, 0L, branchId);
        assertThat(second.toString()).isEqualTo(expected(sessionId, branchId));
    }

    @Test
    void behindProjectionAppliesOnlyTheSuffixAndMatchesFullReplay() {
        String sessionId = newSessionId();
        seedTwoTurns(sessionId);
        String branchId = branchPathService.ensureRootBranchId(sessionId);
        projectionService.projectAndSave(sessionId, TEST_WS, TEST_USER, 0L, branchId);

        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted",
                Map.of("message", Map.of("role", "human", "content", "fourth turn")));
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "assistant.responded",
                Map.of("message", Map.of("role", "ai", "content", "fourth answer")));

        Optional<IncrementalProjection> incremental = attempt(sessionId, branchId);
        assertThat(incremental).isPresent();
        assertThat(incremental.get().suffixEvents()).isEqualTo(2);
        assertThat(incremental.get().context().toString())
                .as("incremental catch-up must be byte-identical to the full replay")
                .isEqualTo(expected(sessionId, branchId));

        ObjectNode saved = projectionService.projectAndSave(sessionId, TEST_WS, TEST_USER, 0L, branchId);
        assertThat(saved.toString()).isEqualTo(expected(sessionId, branchId));
        assertThat(saved.get("messages")).hasSize(4);
    }

    @Test
    void appendOnlySuffixWithToolEventsStaysIncrementalAndByteIdentical() {
        String sessionId = newSessionId();
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "session.created", Map.of(
                "workspace_id", TEST_WS, "user_id", TEST_USER,
                "epoch_id", "epoch-1", "baseline_hash", "hash-1",
                "system_messages", List.of("You are xihe")));
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted",
                Map.of("message", Map.of("role", "human", "content", "run the tool")));
        String branchId = branchPathService.ensureRootBranchId(sessionId);
        projectionService.projectAndSave(sessionId, TEST_WS, TEST_USER, 0L, branchId);

        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "tool.called",
                Map.of("toolCallId", "call-1", "toolName", "read", "arguments", Map.of("path", "a.txt")));
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "tool.result",
                Map.of("toolCallId", "call-1", "toolName", "read", "result", "bounded tool output"));
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "assistant.responded",
                Map.of("message", Map.of("role", "ai", "content", "tool answer")));

        Optional<IncrementalProjection> incremental = attempt(sessionId, branchId);
        assertThat(incremental).isPresent();
        assertThat(incremental.get().suffixEvents()).isEqualTo(3);
        assertThat(incremental.get().context().toString()).isEqualTo(expected(sessionId, branchId));
    }

    @Test
    void historyRewritingSuffixFallsBackToFullReplay() {
        String pruneSession = newSessionId();
        seedTwoTurns(pruneSession);
        String pruneBranch = branchPathService.ensureRootBranchId(pruneSession);
        projectionService.projectAndSave(pruneSession, TEST_WS, TEST_USER, 0L, pruneBranch);
        contextService.appendEvent(pruneSession, TEST_WS, TEST_USER, "context.prune",
                Map.of("tombstones", List.of(Map.of("sequence", 2L, "content_hash", "ignored"))));
        assertThat(attempt(pruneSession, pruneBranch))
                .as("prune rewrites earlier facts")
                .isEmpty();
        assertThat(projectionService.projectAndSave(pruneSession, TEST_WS, TEST_USER, 0L, pruneBranch).toString())
                .isEqualTo(expected(pruneSession, pruneBranch));

        String compactionSession = newSessionId();
        seedTwoTurns(compactionSession);
        String compactionBranch = branchPathService.ensureRootBranchId(compactionSession);
        projectionService.projectAndSave(compactionSession, TEST_WS, TEST_USER, 0L, compactionBranch);
        contextService.compact(compactionSession, TEST_WS, TEST_USER, null);
        assertThat(attempt(compactionSession, compactionBranch))
                .as("compaction truncates earlier messages")
                .isEmpty();
        assertThat(projectionService.projectAndSave(compactionSession, TEST_WS, TEST_USER, 0L, compactionBranch)
                .toString()).isEqualTo(expected(compactionSession, compactionBranch));
    }

    @Test
    void projectionAheadOfEventLogIsIgnoredAndRepaired() {
        String sessionId = newSessionId();
        seedTwoTurns(sessionId);
        String branchId = branchPathService.ensureRootBranchId(sessionId);
        ContextProjection ahead = new ContextProjection(sessionId, TEST_WS, TEST_USER, "{}");
        ahead.setBranchId(branchId);
        ahead.setLatestSequence(999L);
        projectionRepository.save(ahead);

        assertThat(attempt(sessionId, branchId)).as("stored sequence beyond the event log").isEmpty();

        ObjectNode repaired = projectionService.projectAndSave(sessionId, TEST_WS, TEST_USER, 0L, branchId);
        assertThat(repaired.toString()).isEqualTo(expected(sessionId, branchId));
        assertThat(repaired.get("latest_sequence").asLong()).isEqualTo(3L);
        assertThat(projectionRepository.findBySessionIdAndProjectionTypeAndBranchId(
                sessionId, "agent_context", branchId).orElseThrow().getLatestSequence()).isEqualTo(3L);
    }

    @Test
    void snapshotIsIdempotentAcrossRepeatedIncrementalReads() {
        String sessionId = newSessionId();
        seedTwoTurns(sessionId);
        String branchId = branchPathService.ensureRootBranchId(sessionId);
        String first = projectionService.projectAndSave(sessionId, TEST_WS, TEST_USER, 0L, branchId).toString();
        String second = projectionService.projectAndSave(sessionId, TEST_WS, TEST_USER, 0L, branchId).toString();
        String third = projectionService.projectAndSave(sessionId, TEST_WS, TEST_USER, 0L, branchId).toString();
        assertThat(second).isEqualTo(first);
        assertThat(third).isEqualTo(first);
        assertThat(first).isEqualTo(expected(sessionId, branchId));
    }

    @Test
    void snapshotJsonReturnsStoredPayloadWhenCurrentAndIncrementalBodyWhenBehind() {
        String sessionId = newSessionId();
        seedTwoTurns(sessionId);
        String branchId = branchPathService.ensureRootBranchId(sessionId);

        String built = contextService.getSnapshotJson(sessionId, TEST_WS, TEST_USER, 0L, branchId, null);
        assertThat(built).isEqualTo(expected(sessionId, branchId));

        String reused = contextService.getSnapshotJson(sessionId, TEST_WS, TEST_USER, 0L, branchId, null);
        assertThat(reused).as("at the event-log head the stored payload is the body").isEqualTo(built);

        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted",
                Map.of("message", Map.of("role", "human", "content", "third turn")));
        String behind = contextService.getSnapshotJson(sessionId, TEST_WS, TEST_USER, 0L, branchId, null);
        assertThat(behind).as("behind the head the incremental body equals full replay")
                .isEqualTo(expected(sessionId, branchId));
    }
    private Optional<IncrementalProjection> attempt(String sessionId, String branchId) {
        return projectionService.tryIncrementalProjection(sessionId, branchId,
                branchPathService.resolveVisibility(sessionId, branchId));
    }

    private ObjectNode fullReplay(String sessionId) {
        return projectionService.project(sessionId, 0L);
    }

    /**
     * Full replay as the HTTP/internal snapshot would serialize it: replay + resolved branch id,
     * then the BL-302 ② window (the stored/served snapshot is the windowed view, so the incremental
     * catch-up must equal the windowed full replay byte for byte).
     */
    private String expected(String sessionId, String branchId) {
        ObjectNode replay = projectionService.project(sessionId, 0L);
        replay.put("branch_id", branchId);
        ContextProjectionService.applyWindow(replay, new ObjectMapper(),
                ContextProjectionService.WINDOW_MAX_MESSAGES, ContextProjectionService.WINDOW_MAX_BYTES);
        return replay.toString();
    }

    private void seedTwoTurns(String sessionId) {
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "session.created", Map.of(
                "workspace_id", TEST_WS, "user_id", TEST_USER,
                "epoch_id", "epoch-1", "baseline_hash", "hash-1",
                "system_messages", List.of("You are xihe")));
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "prompt.admitted",
                Map.of("message", Map.of("role", "human", "content", "first question")));
        contextService.appendEvent(sessionId, TEST_WS, TEST_USER, "assistant.responded",
                Map.of("message", Map.of("role", "ai", "content", "first answer")));
    }


    private static String newSessionId() {
        return UUID.randomUUID().toString();
    }
}
