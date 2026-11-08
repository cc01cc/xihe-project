package com.cc01cc.p.xihe.cp.skill;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0628 M2a (D28-35): the frozen listing document.
 *
 * <p>This test pins the three properties the design turns on: the document is a faithful copy of the
 * listing (structured items, no body), it is size-asserted rather than silently truncated, and every
 * failure mode stays a <b>record</b> — never an exception that could fail a Run.</p>
 */
class SkillCatalogSnapshotServiceTest {

    private static final UUID USER_ID = UUID.randomUUID();
    private static final UUID WORKSPACE_ID = UUID.randomUUID();
    private static final UUID PRINCIPAL_ID = UUID.randomUUID();
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final SkillCatalogSourceService catalog = mock(SkillCatalogSourceService.class);
    private final SkillCatalogSnapshotService service = new SkillCatalogSnapshotService(catalog, MAPPER);

    private static String templateWith(JsonNode... configs) {
        ObjectNode template = MAPPER.createObjectNode();
        ArrayNode components = template.putObject("template").putArray("components");
        for (JsonNode config : configs) {
            ObjectNode component = components.addObject();
            component.put("instanceId", UUID.randomUUID().toString());
            component.put("type", "skill_catalog");
            component.put("enabled", true);
            component.set("config", config);
        }
        return template.toString();
    }

    private static JsonNode config(int maxSkills) {
        return MAPPER.createObjectNode().put("maxSkills", maxSkills)
                .put("includeDescriptions", true).put("sort", "binding");
    }

    private static SkillCatalogSourceService.Item item(int index, String description) {
        return new SkillCatalogSourceService.Item(UUID.randomUUID(),
                "user:instance:instance:skill-" + index, "skill-" + index, description, 3,
                "a".repeat(64), index % 7 == 0, SkillBinding.SUBJECT_USER,
                SkillBinding.SCOPE_INSTANCE, Skill.DEFINITION_SCOPE_INSTANCE);
    }

    private static SkillCatalogSourceService.Listing listing(int count, String description,
                                                             String status, boolean truncated,
                                                             List<String> diagnostics) {
        List<SkillCatalogSourceService.Item> items = new ArrayList<>();
        for (int index = 0; index < count; index++) {
            items.add(item(index, description));
        }
        return new SkillCatalogSourceService.Listing(status, List.copyOf(items), truncated,
                diagnostics, 40, true, false);
    }

    private JsonNode capture(int count, String description, String status, boolean truncated,
                             List<String> diagnostics) throws Exception {
        when(catalog.resolveListing(any()))
                .thenReturn(listing(count, description, status, truncated, diagnostics));
        return service.capture(MAPPER.readTree(templateWith(config(40))), PRINCIPAL_ID, USER_ID,
                WORKSPACE_ID);
    }

    /**
     * skill-wiring ruling 2026-11-04: the template's {@code skill_catalog} component only tunes the
     * listing; the skill <b>set</b> always comes from {@code skill_bindings}. A template without the
     * component (the built-in api template is exactly that) must therefore still freeze what the model
     * will be shown — the previous "no component ⇒ capture nothing" behaviour made every bound skill
     * invisible in {@code skills_snapshot}.
     */
    @Test
    void aTemplateWithoutAListingComponentStillResolvesFromTheBindings() throws Exception {
        when(catalog.resolveListing(any()))
                .thenReturn(listing(1, "desc of alpha", "ready", false, List.of()));

        JsonNode document = service.capture(MAPPER.readTree("{\"bodySource\":\"{} template\"}"),
                PRINCIPAL_ID, USER_ID, WORKSPACE_ID);

        assertNotNull(document, "the bindings are the source, not the template");
        assertEquals(SkillCatalogSourceService.STATUS_READY, document.path("status").asText());
        assertEquals(1, document.path("items").size());
        assertEquals(SkillCatalogSourceService.DEFAULT_MAX_SKILLS, document.path("maxSkills").asInt(),
                "without a component the frozen defaults apply");
        assertEquals(SkillCatalogSourceService.SOURCE, document.path("source").asText());
        // The resolver really was asked, with the agent tier of the Session.
        ArgumentCaptor<SkillCatalogSourceService.Request> request =
                ArgumentCaptor.forClass(SkillCatalogSourceService.Request.class);
        verify(catalog).resolveListing(request.capture());
        assertEquals(PRINCIPAL_ID, request.getValue().agentPrincipalId());
        assertEquals(SkillCatalogSourceService.SORT_BINDING, request.getValue().sort());
    }

    @Test
    void noSubjectOrNoBindingKeepsTheColumnAbsent() throws Exception {
        // No subject at all: no binding could match, so nothing was listed.
        assertNull(service.capture(MAPPER.readTree("{}"), null, null, WORKSPACE_ID),
                "a Run without a subject has no listing to record");
        verify(catalog, never()).resolveListing(any());

        // A subject with no live binding: '{}' stays '{}' — never an invented "empty capture".
        when(catalog.resolveListing(any()))
                .thenReturn(listing(0, "", SkillCatalogSourceService.STATUS_EMPTY, false,
                        List.of(SkillCatalogSourceService.DIAG_EMPTY)));
        assertNull(service.capture(MAPPER.readTree("{}"), PRINCIPAL_ID, USER_ID, WORKSPACE_ID));
    }

    @Test
    void fortyItemsFitWellUnderTheSizeLimit() throws Exception {
        JsonNode document = capture(40, "does a thing worth listing for the model to discover", "ready",
                false, List.of());

        assertEquals(SkillCatalogSnapshotService.VERSION, document.path("version").asInt());
        assertEquals("ready", document.path("status").asText());
        assertEquals(SkillCatalogSourceService.SOURCE, document.path("source").asText());
        assertEquals(SkillCatalogSnapshotService.SNAPSHOT_SOURCE_FROZEN,
                document.path("snapshotSource").asText());
        assertTrue(document.path("capturedAt").isTextual());
        assertEquals(40, document.path("maxSkills").asInt());
        assertEquals(40, document.path("items").size());
        assertFalse(document.path("truncated").asBoolean());

        // D28-35's size assertion: the measured 40-entry document is ~6 KB, so 64 KB leaves ~10×.
        assertTrue(MAPPER.writeValueAsBytes(document).length <= SkillCatalogSnapshotService.MAX_SNAPSHOT_BYTES,
                "a full listing must stay well inside the assertion threshold");

        JsonNode first = document.path("items").get(0);
        assertTrue(first.hasNonNull("skillId"));
        assertEquals("user:instance:instance:skill-0", first.path("qualifiedName").asText());
        assertEquals("skill-0", first.path("name").asText());
        assertEquals(3, first.path("version").asInt());
        assertEquals(64, first.path("contentHash").asText().length());
        assertTrue(first.path("oversize").isBoolean());
        assertEquals("user", first.path("tier").path("subjectType").asText());
        assertEquals("instance", first.path("tier").path("scopeType").asText());
        assertEquals("instance", first.path("tier").path("definitionScopeType").asText());
        // D28-35: the body is the current fact skill_read will read; storing it would bloat the row.
        assertFalse(first.has("body"));
    }

    @Test
    void anOversizedDocumentIsRecordedAsFailedWithNoItems() throws Exception {
        // Only description bloat can cross the threshold: the entry count is already capped.
        String bloat = "x".repeat(4096);
        JsonNode document = capture(40, bloat, "ready", false, List.of());

        assertEquals(SkillCatalogSourceService.STATUS_FAILED, document.path("status").asText());
        assertEquals(List.of(SkillCatalogSnapshotService.DIAG_TOO_LARGE),
                MAPPER.convertValue(document.path("diagnostics"), List.class));
        assertEquals(0, document.path("items").size(),
                "an oversized snapshot must not keep a partial listing: that would no longer match "
                        + "what the model saw");
        assertTrue(MAPPER.writeValueAsBytes(document).length <= SkillCatalogSnapshotService.MAX_SNAPSHOT_BYTES);
    }

    @Test
    void aResolveFailureIsRecordedInsteadOfFailingTheRun() throws Exception {
        when(catalog.resolveListing(any())).thenThrow(new IllegalStateException("db down"));

        JsonNode document = service.capture(MAPPER.readTree(templateWith(config(40))), PRINCIPAL_ID,
                USER_ID, WORKSPACE_ID);

        assertEquals(SkillCatalogSourceService.STATUS_FAILED, document.path("status").asText());
        assertEquals(List.of(SkillCatalogSourceService.DIAG_RESOLVE_FAILED),
                MAPPER.convertValue(document.path("diagnostics"), List.class));
    }

    @Test
    void anUnsupportedSortIsRecordedToo() throws Exception {
        when(catalog.resolveListing(any())).thenThrow(new com.cc01cc.p.xihe.cp.config.CpApiException(
                org.springframework.http.HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "sort"));

        JsonNode document = service.capture(MAPPER.readTree(templateWith(config(40))), PRINCIPAL_ID,
                USER_ID, WORKSPACE_ID);

        assertEquals(SkillCatalogSourceService.STATUS_FAILED, document.path("status").asText());
    }

    @Test
    void twoListingComponentsAreReportedRatherThanGuessed() throws Exception {
        JsonNode document = service.capture(
                MAPPER.readTree(templateWith(config(40), config(10))), PRINCIPAL_ID, USER_ID, WORKSPACE_ID);

        assertEquals(SkillCatalogSourceService.STATUS_FAILED, document.path("status").asText());
        assertEquals(List.of(SkillCatalogSnapshotService.DIAG_MULTIPLE_COMPONENTS),
                MAPPER.convertValue(document.path("diagnostics"), List.class));
        verify(catalog, never()).resolveListing(any());
    }

    @Test
    void aTruncatedListingKeepsItsFlagAndDiagnostics() throws Exception {
        JsonNode document = capture(40, "d", "truncated", true,
                List.of(SkillCatalogSourceService.DIAG_MAX_SKILLS));

        assertEquals("truncated", document.path("status").asText());
        assertTrue(document.path("truncated").asBoolean());
        assertEquals(List.of(SkillCatalogSourceService.DIAG_MAX_SKILLS),
                MAPPER.convertValue(document.path("diagnostics"), List.class));
    }

    @Test
    void inheritanceIsVerbatimAndMarked() throws Exception {
        JsonNode parent = capture(40, "d", "ready", false, List.of());

        JsonNode child = SkillCatalogSnapshotService.inherited(parent);

        assertEquals(SkillCatalogSnapshotService.SNAPSHOT_SOURCE_INHERITED,
                child.path("snapshotSource").asText());
        assertEquals(parent.path("items"), child.path("items"));
        assertEquals(parent.path("capturedAt"), child.path("capturedAt"));
        assertEquals(SkillCatalogSnapshotService.SNAPSHOT_SOURCE_FROZEN,
                parent.path("snapshotSource").asText(), "the parent record must not be rewritten");
        ((ObjectNode) child).put("status", "tampered");
        assertFalse("tampered".equals(parent.path("status").asText()), "inheritance copies, never shares");
    }

    @Test
    void aParentWithoutASnapshotStaysWithoutOneSoTheChildFallbackIsVisible() {
        assertEquals("{}", SkillCatalogSnapshotService.inherited(null).toString());
        assertEquals("{}", SkillCatalogSnapshotService
                .inherited(MAPPER.createObjectNode()).toString());

        assertTrue(SkillCatalogSnapshotService.isAbsent(null));
        assertTrue(SkillCatalogSnapshotService.isAbsent(MAPPER.createObjectNode()));
        assertFalse(SkillCatalogSnapshotService.isAbsent(
                MAPPER.createObjectNode().put("status", "empty")));
    }

    @Test
    void renderingFromASnapshotUsesTheFrozenItemsAndCollisionFlag() throws Exception {
        ObjectNode snapshot = MAPPER.createObjectNode();
        snapshot.put("status", "ready");
        snapshot.put("maxSkills", 40);
        ArrayNode items = snapshot.putArray("items");
        items.addObject().put("qualifiedName", "user:instance:instance:writing").put("name", "writing")
                .put("description", "both scopes define it").put("version", 2)
                .put("contentHash", "b".repeat(64)).put("version", 2);
        ((ObjectNode) items.get(0)).putObject("tier").put("subjectType", "user")
                .put("scopeType", "instance").put("definitionScopeType", "instance");
        snapshot.put("truncated", false);
        snapshot.putArray("diagnostics").add(SkillCatalogSourceService.DIAG_COLLISION);

        SkillCatalogSourceService.ComponentView view = SkillCatalogSourceService.renderFromSnapshot(
                snapshot, SkillCatalogSourceService.Request.of(null, USER_ID, WORKSPACE_ID));

        // The collision diagnostic is what makes the line carry the qualified name — recovered from
        // the record instead of recomputed from live bindings.
        assertEquals(List.of("user:instance:instance:writing — both scopes define it"), view.items());
        assertEquals("ready", view.status());
        assertEquals(List.of(SkillCatalogSourceService.DIAG_COLLISION), view.diagnostics());
    }
}
