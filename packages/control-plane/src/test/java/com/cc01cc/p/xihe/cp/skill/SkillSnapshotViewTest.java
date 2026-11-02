package com.cc01cc.p.xihe.cp.skill;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0628 M2a-③ (D28-42): the Run read face replays the frozen listing through an explicit typed
 * projection.
 *
 * <p>Two properties are asserted here, and they are different concerns:
 *
 * <ol>
 *   <li><b>fidelity</b> — the projection carries the fields the snapshot exists for (D28-35: the
 *       listing plus each entry's {@code contentHash}, the truncation flag and the diagnostics that
 *       explain the admission-time trade-off);</li>
 *   <li><b>C1</b> — the projection is not a Jackson-2 tree passed through. The stored document is a
 *       {@link JsonNode}, and a node placed in a response is introspected by Jackson 3 as a bean, so
 *       the wire would carry {@code nodeType}/{@code array}/… instead of the document (PLAN-0633
 *       D33-09). The last test walks the whole projected graph and fails if any node survives.</li>
 * </ol>
 *
 * <p>{@code {}} is the third property, and the one that must never be ambiguous: it means "this Run
 * captured no snapshot", so the read face answers {@code null} — an empty object would say "this Run
 * had no skills", which is a different (and false) statement.</p>
 */
class SkillSnapshotViewTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Test
    void projectsEveryReplayFieldOfAFrozenDocument() throws Exception {
        JsonNode document = MAPPER.readTree("""
                {"version":1,"status":"truncated","source":"skill_bindings",
                 "capturedAt":"2026-11-03T01:00:00Z","snapshotSource":"frozen","maxSkills":40,
                 "items":[{"skillId":"6f1d1f5e-2222-4222-8222-000000000002",
                           "qualifiedName":"user:workspace:instance:alpha",
                           "name":"alpha","description":"desc of alpha","version":3,
                           "contentHash":"%s","oversize":true,
                           "tier":{"subjectType":"user","scopeType":"workspace",
                                   "definitionScopeType":"instance"}}],
                 "truncated":true,"diagnostics":["skill_catalog_max_skills_reached"]}
                """.formatted("a".repeat(64)));

        SkillSnapshotView view = SkillSnapshotView.of(document);

        assertEquals(1, view.version());
        assertEquals(SkillCatalogSourceService.STATUS_TRUNCATED, view.status());
        assertEquals(SkillCatalogSourceService.SOURCE, view.source());
        assertEquals("2026-11-03T01:00:00Z", view.capturedAt());
        assertEquals(SkillCatalogSnapshotService.SNAPSHOT_SOURCE_FROZEN, view.snapshotSource());
        assertEquals(40, view.maxSkills());
        assertTrue(view.truncated());
        assertEquals(List.of(SkillCatalogSourceService.DIAG_MAX_SKILLS), view.diagnostics());

        assertEquals(1, view.items().size());
        SkillSnapshotView.Item item = view.items().getFirst();
        assertEquals("6f1d1f5e-2222-4222-8222-000000000002", item.skillId());
        assertEquals("user:workspace:instance:alpha", item.qualifiedName());
        assertEquals("alpha", item.name());
        assertEquals("desc of alpha", item.description());
        assertEquals(3, item.version());
        assertEquals("a".repeat(64), item.contentHash());
        assertTrue(item.oversize());
        assertEquals(new SkillSnapshotView.Tier("user", "workspace", "instance"), item.tier());
    }

    /** D28-39 ②: a continuation carries the parent's listing verbatim; the read face says so. */
    @Test
    void anInheritedDocumentKeepsItsProvenance() throws Exception {
        SkillSnapshotView view = SkillSnapshotView.of(MAPPER.readTree("""
                {"version":1,"status":"ready","source":"skill_bindings",
                 "capturedAt":"2026-11-03T01:00:00Z","snapshotSource":"inherited","maxSkills":40,
                 "items":[],"truncated":false,"diagnostics":[]}
                """));

        assertEquals(SkillCatalogSnapshotService.SNAPSHOT_SOURCE_INHERITED, view.snapshotSource());
    }

    /**
     * D28-40 / the contract decision: "not captured" is {@code null}, "captured and empty" is a
     * document with {@code status: empty}. The two must stay distinguishable on the wire.
     */
    @Test
    void absentSnapshotProjectsToNullWhileAnEmptyListingProjectsToADocument() throws Exception {
        assertNull(SkillSnapshotView.of(null), "an unsaved Run has no document at all");
        assertNull(SkillSnapshotView.of(JsonNodeFactory.instance.objectNode()),
                "{} is the column default and means 'not captured', never 'no skills'");
        assertNull(SkillSnapshotView.of(MAPPER.readTree("\"legacy\"")),
                "anything without a textual status is not a snapshot document");
        assertNull(SkillSnapshotView.of(MAPPER.readTree("{\"version\":1}")),
                "a status-less object is malformed, not an empty capture");

        SkillSnapshotView emptyListing = SkillSnapshotView.of(MAPPER.readTree("""
                {"version":1,"status":"empty","source":"skill_bindings",
                 "capturedAt":"2026-11-03T01:00:00Z","snapshotSource":"frozen","maxSkills":40,
                 "items":[],"truncated":false,"diagnostics":["skill_catalog_empty"]}
                """));
        assertEquals(SkillCatalogSourceService.STATUS_EMPTY, emptyListing.status());
        assertTrue(emptyListing.items().isEmpty());
    }

    /**
     * A snapshot written by a newer CP must be readable, not fatal: unknown fields are dropped and the
     * payload still carries {@code version} so a reader can tell it is looking at a partial replay.
     */
    @Test
    void aNewerDocumentIsProjectedWithoutItsUnknownFields() throws Exception {
        SkillSnapshotView view = SkillSnapshotView.of(MAPPER.readTree("""
                {"version":2,"status":"ready","source":"skill_bindings",
                 "capturedAt":"2026-11-03T01:00:00Z","snapshotSource":"frozen","maxSkills":40,
                 "items":[{"name":"alpha","futureField":{"nested":true}}],
                 "truncated":false,"diagnostics":[],"futureEnvelope":42}
                """));

        assertEquals(2, view.version(), "the reader can see it is not on the version it knows");
        assertEquals(1, view.items().size());
        assertEquals("alpha", view.items().getFirst().name());
        assertNull(view.items().getFirst().contentHash(), "absent fields are null, not invented");
    }

    /** A malformed document degrades field by field instead of throwing the read face away. */
    @Test
    void malformedSectionsDegradeToEmptyCollections() throws Exception {
        SkillSnapshotView view = SkillSnapshotView.of(MAPPER.readTree("""
                {"version":1,"status":"failed","source":"skill_bindings","maxSkills":40,
                 "items":"not-an-array","diagnostics":["skill_catalog_resolve_failed",42]}
                """));

        assertTrue(view.items().isEmpty());
        assertEquals(List.of(SkillCatalogSourceService.DIAG_RESOLVE_FAILED), view.diagnostics(),
                "non-textual diagnostic entries are skipped, not rendered as '42'");
        assertNull(view.capturedAt());
        assertFalse(view.truncated());
    }

    /**
     * C1 as a property: no Jackson-2 node may survive anywhere in the projected graph. A pass-through
     * of the stored node (or of one of its children) fails here before it can reach HTTP.
     */
    @Test
    void noJackson2NodeSurvivesInTheProjection() throws Exception {
        SkillSnapshotView view = SkillSnapshotView.of(MAPPER.readTree("""
                {"version":1,"status":"ready","source":"skill_bindings",
                 "capturedAt":"2026-11-03T01:00:00Z","snapshotSource":"frozen","maxSkills":40,
                 "items":[{"skillId":"6f1d1f5e-2222-4222-8222-000000000002",
                           "qualifiedName":"user:instance:instance:alpha","name":"alpha",
                           "description":"desc","version":1,"contentHash":"deadbeef","oversize":false,
                           "tier":{"subjectType":"user","scopeType":"instance",
                                   "definitionScopeType":"instance"}}],
                 "truncated":false,"diagnostics":["skill_catalog_name_collision"]}
                """));

        List<Object> offending = new ArrayList<>();
        collectNodes(view, offending);
        assertTrue(offending.isEmpty(), "Jackson-2 nodes must not reach the response: " + offending);
    }

    private static void collectNodes(Object value, List<Object> offending) {
        if (value == null) {
            return;
        }
        if (value instanceof JsonNode) {
            offending.add(value);
            return;
        }
        if (value instanceof List<?> list) {
            list.forEach(entry -> collectNodes(entry, offending));
            return;
        }
        if (value instanceof java.util.Map<?, ?> map) {
            map.keySet().forEach(entry -> collectNodes(entry, offending));
            map.values().forEach(entry -> collectNodes(entry, offending));
            return;
        }
        if (value.getClass().isRecord()) {
            for (java.lang.reflect.RecordComponent component : value.getClass().getRecordComponents()) {
                try {
                    collectNodes(component.getAccessor().invoke(value), offending);
                } catch (ReflectiveOperationException reflectionFailure) {
                    throw new IllegalStateException(
                            "Unable to walk the projection at " + component.getName(), reflectionFailure);
                }
            }
        }
    }
}
