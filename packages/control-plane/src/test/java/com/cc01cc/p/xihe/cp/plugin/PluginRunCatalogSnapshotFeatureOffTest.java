package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.TestPropertySource;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T1.6b / D-66: with the shipped default {@code cp.plugin.enabled=false}, admission must
 * capture nothing — the document stays {@code {}} ("not captured"), not
 * {@code {"catalogVersion":0,"items":[]}}.
 *
 * <p>The "on" half of the two-state pair lives in {@code PluginRunCatalogSnapshotTest} (which asserts
 * a captured {@code catalogVersion} / items document). This class seeds attachment rows on purpose:
 * the point is that the <b>flag</b> gates the capture, not the absence of data — a run admitted while
 * the feature is off must never carry a plugin catalog that the (then 404) plugin routes could not
 * have produced.</p>
 *
 * <p>H2 lane note: this proves the Java branch only, not PostgreSQL schema (see
 * {@code PluginRunSnapshotAdmissionTest} for the PG column assertion).</p>
 */
@TestPropertySource(properties = {
        "cp.plugin.enabled=false",
        "cp.plugin.advisory-lock=false"
})
class PluginRunCatalogSnapshotFeatureOffTest extends AbstractH2Test {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Autowired
    private SessionPluginBindingRepository attachments;

    @Autowired
    private SessionRepository sessions;

    @Autowired
    private ChatRunRepository runs;

    @Autowired
    private PluginRunCatalogSnapshotService snapshots;

    @Test
    void captureAnswersNotCapturedWhileTheFeatureIsOff() {
        UUID workspaceId = UUID.randomUUID();
        Session session = new Session(workspaceId.toString(), UUID.randomUUID().toString(),
                "feature off fixture");
        session.setId(UUID.randomUUID());
        sessions.saveAndFlush(session);

        // Data that a previously-enabled deployment could have left behind: the rows exist, the
        // feature is off, and capture must still answer "not captured".
        ObjectNode snapshot = MAPPER.createObjectNode();
        String pluginId = "official.leftover";
        snapshot.put("bindingId", UUID.randomUUID().toString());
        snapshot.put("pluginId", pluginId);
        snapshot.put("version", "1.0.0");
        snapshot.put("digest", "sha256:" + pluginId);
        snapshot.put("state", "enabled");
        attachments.saveAndFlush(new SessionPluginBinding(session.getId(), UUID.randomUUID(),
                snapshot, 4));
        assertEquals(4, attachments.maxRevision(session.getId()),
                "the fixture does carry attachment rows, so the empty answer below is the flag's");

        JsonNode captured = snapshots.capture(session.getId());
        assertTrue(captured.isEmpty(),
                "D-66: feature off means the Run is admitted with {} (not captured), not a frozen"
                        + " catalog of rows the feature-off routes could not have produced");
        assertTrue(snapshots.capture(null).isEmpty(), "no session means nothing to capture");
    }

    @Test
    void aFeatureOffRunIsParsedAsNotCaptured() {
        String runId = UUID.randomUUID().toString();
        ChatRun run = new ChatRun(runId, UUID.randomUUID().toString(), UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), "idem-" + runId, "request-hash", "provider", "model",
                "none", "accepted");
        run.setBranchId(UUID.randomUUID().toString());
        runs.saveAndFlush(run);

        assertTrue(run.getPluginSnapshot().isEmpty(),
                "the entity default is {} so legacy/feature-off rows need no backfill");
        assertTrue(snapshots.snapshotForRun(runId).isEmpty(),
                "and the read side answers empty instead of a zero-item snapshot");
    }
}
