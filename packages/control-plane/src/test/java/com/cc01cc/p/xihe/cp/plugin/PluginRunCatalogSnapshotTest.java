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

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T1.6b: the session plugin catalog frozen when a Run is admitted — freeze semantics and
 * the read seam T2.1's {@code /api/v1/mcp} {@code tools/list} filter will consume.
 *
 * <p><b>Three behaviours, stated apart so the evidence cannot be read as one:</b></p>
 * <ol>
 *   <li><b>catalogVersion</b> — the frozen document carries the same per-session high-water mark the
 *       attach/detach API reports ({@code max(revision)}), so a Run's catalog is comparable with the
 *       live one without a second counter.</li>
 *   <li><b>Freeze</b> — an attach or detach that lands while the Run is in flight does not move the
 *       document it was admitted with (D-62 "next turn, not this one").</li>
 *   <li><b>Next turn</b> — the Run admitted after the change sees the new set; the read API
 *       ({@code snapshotForRun} / {@code contains}) answers the frozen provenance triple T2.1 needs.</li>
 * </ol>
 *
 * <p><b>What this class is not evidence for.</b> It runs on the H2 lane, which builds the schema
 * from JPA entities and deliberately does not run Flyway ({@code application-h2.properties},
 * DEV-022): it proves the Java lifecycle (capture → column → parse), <b>not</b> the PostgreSQL column
 * or its migration. Those are asserted in {@code PluginRunSnapshotAdmissionTest} (Testcontainers PG)
 * where the real admission path also writes the column.</p>
 *
 * <p>Feature-off is the other half of the two-state pair: {@code PluginRunCatalogSnapshotFeatureOffTest}.</p>
 */
@TestPropertySource(properties = {
        "cp.plugin.enabled=true",
        "cp.plugin.advisory-lock=false"
})
class PluginRunCatalogSnapshotTest extends AbstractH2Test {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Autowired
    private PluginRepository plugins;

    @Autowired
    private PluginBindingRepository bindings;

    @Autowired
    private SessionPluginBindingRepository attachments;

    @Autowired
    private SessionRepository sessions;

    @Autowired
    private ChatRunRepository runs;

    @Autowired
    private PluginRunCatalogSnapshotService snapshots;

    @Test
    void captureReportsTheSameCatalogVersionTheAttachApiReports() {
        Fixture fixture = fixture();
        String bindingA = attach(fixture, fixture.pluginA(), 1);
        String bindingB = attach(fixture, fixture.pluginB(), 2);

        JsonNode admitted = snapshots.capture(fixture.sessionId());

        assertEquals(2, admitted.path("catalogVersion").asInt(),
                "capture must copy the session high-water mark the attach API reports (T1.6a made"
                        + " attach/detach the only writers of that sequence)");
        assertEquals(2, attachments.maxRevision(fixture.sessionId()),
                "and it must be the same number, not a re-derivation");
        assertEquals("admission", admitted.path("snapshotSource").asText(),
                "a root Run's document is captured at admission, not inherited");
        assertNotNull(admitted.path("capturedAt").asText(null), "the document is self-describing");
        assertEquals(2, admitted.path("items").size(), "both attached bindings are frozen");
        assertEquals(List.of(bindingA, bindingB),
                List.of(admitted.path("items").get(0).path("bindingId").asText(),
                        admitted.path("items").get(1).path("bindingId").asText()),
                "items follow the attachments' own order (attachedAt ascending)");
        assertEquals(List.of(1, 2),
                List.of(admitted.path("items").get(0).path("revision").asInt(),
                        admitted.path("items").get(1).path("revision").asInt()),
                "each item keeps the catalog sequence value it was admitted at");
    }

    @Test
    void anAttachDuringTheRunDoesNotMoveItsFrozenCatalogAndTheNextRunSeesIt() {
        Fixture fixture = fixture();
        attach(fixture, fixture.pluginA(), 1);
        attach(fixture, fixture.pluginB(), 2);
        ChatRun inFlight = admittedRun(fixture, snapshots.capture(fixture.sessionId()));

        String bindingC = attach(fixture, fixture.pluginC(), 3);

        ChatRun reread = runs.findById(inFlight.getId()).orElseThrow();
        assertEquals(2, reread.getPluginSnapshot().path("catalogVersion").asInt(),
                "an attach that lands while the Run is in flight must not move this Run's catalog");
        assertEquals(2, reread.getPluginSnapshot().path("items").size(),
                "nor add the newly attached binding to this Run's tool face");
        PluginRunCatalogSnapshotService.PluginRunSnapshot frozen =
                snapshots.snapshotForRun(inFlight.getId().toString()).orElseThrow();
        assertEquals(2, frozen.catalogVersion());
        assertEquals(List.of(1, 2), frozen.items().stream()
                .map(PluginRunCatalogSnapshotService.Item::revision).toList());
        assertFalse(frozen.contains(fixture.pluginC(), Fixture.VERSION, fixture.digest(fixture.pluginC())),
                "the binding attached after admission is not licensed for this Run (T2.1 reads this"
                        + " predicate when it filters tools/list)");

        JsonNode nextTurn = snapshots.capture(fixture.sessionId());
        ChatRun next = admittedRun(fixture, nextTurn);
        assertEquals(3, nextTurn.path("catalogVersion").asInt());
        PluginRunCatalogSnapshotService.PluginRunSnapshot nextFrozen =
                snapshots.snapshotForRun(next.getId().toString()).orElseThrow();
        assertEquals(3, nextFrozen.catalogVersion(), "the next Run is admitted with the new catalog");
        assertTrue(nextFrozen.contains(fixture.pluginC(), Fixture.VERSION,
                        fixture.digest(fixture.pluginC())),
                "and it does license the binding attached while the previous Run was in flight");
        assertEquals(bindingC, nextFrozen.items().get(2).bindingId().toString(),
                "the frozen binding id is the one T2.1 filters by");
    }

    @Test
    void aDetachDuringTheRunLeavesTheFrozenViewIntact() {
        Fixture fixture = fixture();
        String bindingA = attach(fixture, fixture.pluginA(), 1);
        attach(fixture, fixture.pluginB(), 2);
        ChatRun inFlight = admittedRun(fixture, snapshots.capture(fixture.sessionId()));

        SessionPluginBinding attachmentA = attachments
                .findBySessionIdAndBindingId(fixture.sessionId(), UUID.fromString(bindingA))
                .orElseThrow();
        attachmentA.detach(3);
        attachments.saveAndFlush(attachmentA);

        assertEquals(3, attachments.maxRevision(fixture.sessionId()),
                "a detach is a catalog change and spends a revision (T1.6a)");
        PluginRunCatalogSnapshotService.PluginRunSnapshot frozen =
                snapshots.snapshotForRun(inFlight.getId().toString()).orElseThrow();
        assertEquals(2, frozen.catalogVersion(), "the in-flight Run keeps its own catalog version");
        assertTrue(frozen.contains(fixture.pluginA(), Fixture.VERSION, fixture.digest(fixture.pluginA())),
                "the binding this Run was admitted with stays licensed even after it is detached");
        assertEquals(1, snapshots.capture(fixture.sessionId()).path("items").size(),
                "while the live catalog for the NEXT Run now holds only the remaining binding");
    }

    @Test
    void uncapturedIsNotAnEmptyCatalog() {
        Fixture fixture = fixture();
        ChatRun legacy = admittedRun(fixture, MAPPER.createObjectNode());
        assertTrue(snapshots.snapshotOf(legacy).isEmpty(),
                "{} means \"not captured\" (feature off / pre-T1.6b), never \"no plugins\"");

        ChatRun capturedEmpty = admittedRun(fixture, snapshots.capture(fixture.sessionId()));
        PluginRunCatalogSnapshotService.PluginRunSnapshot frozen =
                snapshots.snapshotOf(capturedEmpty).orElseThrow();
        assertEquals(0, frozen.catalogVersion());
        assertTrue(frozen.items().isEmpty(),
                "a captured Run with nothing attached is catalogVersion 0 / empty items —"
                        + " distinguishable from the not-captured document above");
    }

    @Test
    void malformedDocumentsFailClosedInsteadOfWideningTheToolFace() {
        Fixture fixture = fixture();
        ObjectNode itemsNotArray = MAPPER.createObjectNode();
        itemsNotArray.put("catalogVersion", 7);
        itemsNotArray.put("items", "not-an-array");
        assertTrue(snapshots.snapshotOf(admittedRun(fixture, itemsNotArray)).isEmpty(),
                "a document we cannot read is not captured, never an empty catalog");

        ObjectNode itemMissingProvenance = MAPPER.createObjectNode();
        itemMissingProvenance.put("catalogVersion", 7);
        ObjectNode item = itemMissingProvenance.putArray("items").addObject();
        item.put("bindingId", UUID.randomUUID().toString());
        item.put("pluginId", "official.demo");
        assertTrue(snapshots.snapshotOf(admittedRun(fixture, itemMissingProvenance)).isEmpty(),
                "an item without version/digest cannot license a tool, so the whole document"
                        + " degrades to not-captured (fail-closed)");
        assertTrue(snapshots.snapshotForRun("not-a-uuid").isEmpty(), "malformed run id is empty, not 500");
        assertTrue(snapshots.snapshotForRun(null).isEmpty());
    }

    @Test
    void continuationInheritsTheParentCatalogVerbatim() {
        Fixture fixture = fixture();
        attach(fixture, fixture.pluginA(), 1);
        JsonNode parent = snapshots.capture(fixture.sessionId());

        JsonNode child = PluginRunCatalogSnapshotService.inherited(parent);
        assertEquals(1, child.path("catalogVersion").asInt());
        assertEquals(1, child.path("items").size());
        assertEquals("inherited", child.path("snapshotSource").asText(),
                "the marker records that this child continued a Run instead of re-resolving the"
                        + " catalog (D28-39 ② analogue)");
        assertTrue(PluginRunCatalogSnapshotService.inherited(MAPPER.createObjectNode()).isEmpty(),
                "an uncaptured parent stays uncaptured — inheritance never invents a document");
    }

    // ------------------------------------------------------------------ fixtures

    private static final class Fixture {

        static final String VERSION = "1.0.0";

        private final UUID sessionId;
        private final UUID workspaceId;
        private final String userId;
        private final Map<String, Plugin> plugins;

        private Fixture(UUID sessionId, UUID workspaceId, String userId,
                Map<String, Plugin> plugins) {
            this.sessionId = sessionId;
            this.workspaceId = workspaceId;
            this.userId = userId;
            this.plugins = plugins;
        }

        Plugin plugin(String pluginId) {
            Plugin found = plugins.get(pluginId);
            if (found == null) {
                throw new AssertionError("seed plugin missing: " + pluginId);
            }
            return found;
        }

        UUID sessionId() {
            return sessionId;
        }

        UUID workspaceId() {
            return workspaceId;
        }

        String userId() {
            return userId;
        }

        String pluginA() {
            return "official.a-" + sessionId.toString().substring(0, 6);
        }

        String pluginB() {
            return "official.b-" + sessionId.toString().substring(0, 6);
        }

        String pluginC() {
            return "official.c-" + sessionId.toString().substring(0, 6);
        }

        String digest(String pluginId) {
            return "sha256:" + pluginId;
        }

        List<String> pluginIds() {
            return List.of(pluginA(), pluginB(), pluginC());
        }
    }

    private Fixture fixture() {
        UUID workspaceId = UUID.randomUUID();
        String userId = UUID.randomUUID().toString();
        Session session = new Session(workspaceId.toString(), userId, "plugin snapshot fixture");
        session.setId(UUID.randomUUID());
        sessions.saveAndFlush(session);
        Map<String, Plugin> seeded = new LinkedHashMap<>();
        Fixture fixture = new Fixture(session.getId(), workspaceId, userId, seeded);
        fixture.pluginIds().forEach(pluginId -> seeded.put(pluginId, seedPlugin(pluginId)));
        return fixture;
    }

    private Plugin seedPlugin(String pluginId) {
        ObjectNode manifest = MAPPER.createObjectNode();
        manifest.put("manifestVersion", "1");
        manifest.put("id", pluginId);
        manifest.put("version", Fixture.VERSION);
        manifest.put("digest", "sha256:" + pluginId);
        manifest.putArray("actions").addObject().put("name", "demo.echo").put("actionClass", "read");
        manifest.putArray("requestedAtoms").add("plugin:invoke");
        Plugin plugin = new Plugin(pluginId, "sha256:" + pluginId, Fixture.VERSION,
                Plugin.SOURCE_BUILTIN, manifest);
        plugin.setCurrent(true);
        plugin.setState(Plugin.STATE_ENABLED);
        return plugins.saveAndFlush(plugin);
    }

    private PluginBinding seedBinding(Fixture fixture, String pluginId) {
        PluginBinding binding = new PluginBinding(fixture.workspaceId(), fixture.plugin(pluginId),
                PluginBindingState.ENABLED, MAPPER.createArrayNode(),
                PluginBinding.GRANT_SOURCE_DEFAULT);
        return bindings.saveAndFlush(binding);
    }

    private String attach(Fixture fixture, String pluginId, int revision) {
        PluginBinding binding = seedBinding(fixture, pluginId);
        ObjectNode snapshot = MAPPER.createObjectNode();
        snapshot.put("bindingId", binding.getId().toString());
        snapshot.put("pluginId", pluginId);
        snapshot.put("version", Fixture.VERSION);
        snapshot.put("digest", "sha256:" + pluginId);
        snapshot.put("state", "enabled");
        SessionPluginBinding attachment = new SessionPluginBinding(fixture.sessionId(), binding.getId(),
                snapshot, revision);
        attachments.saveAndFlush(attachment);
        return binding.getId().toString();
    }

    private ChatRun admittedRun(Fixture fixture, JsonNode pluginSnapshot) {
        String runId = UUID.randomUUID().toString();
        ChatRun run = new ChatRun(runId, fixture.sessionId().toString(), fixture.userId(),
                fixture.workspaceId().toString(), "idem-" + runId, "request-hash", "provider", "model",
                "none", "accepted");
        run.setBranchId(UUID.randomUUID().toString());
        run.setPluginSnapshot(pluginSnapshot);
        return runs.saveAndFlush(run);
    }
}
