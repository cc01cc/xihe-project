package com.cc01cc.p.xihe.cp.skill;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0628 M3-①: the <b>cross-language pin</b> for the skills listing.
 *
 * <p>Until now CP's {@link SkillCatalogSourceService} renderer and the Agent's
 * {@code context/skill_catalog.py} were only <i>individually</i> green: whether the lines CP hands
 * over are the lines the model actually reads was a matter of reading both files carefully. This
 * test removes that assumption. Both suites read the <b>same</b> fixture —
 * {@code spec/fixtures/skill-catalog-render.json}:</p>
 * <ul>
 *   <li>this class feeds each case's {@code listing} into {@code view(Listing)} and requires the
 *       result to be <b>byte-identical</b> to the fixture's {@code componentView};</li>
 *   <li>{@code packages/agent/tests/unit/test_skill_catalog_render_contract.py} feeds that same
 *       {@code componentView} into {@code render_from_component_sources} and requires the model
 *       visible text to be exactly {@code agent.expectedContent}.</li>
 * </ul>
 *
 * <p>The two halves are joined by the fixture, so a drift on either side turns that side red. The
 * join is also asserted from here: every line the Agent renders (below the header, above the
 * truncation sentence) must be <b>the same bytes</b> as a line this renderer produced — the Agent
 * may drop a tail, never re-word a line.</p>
 *
 * <p>D28-41 wording ownership: the truncation sentence and the header belong to the final renderer
 * (the Agent). CP must not embed them into an item, not even to be helpful — a second copy of the
 * wording would be the drift this fixture exists to catch. {@link #cpNeverOwnsTheFraming()} pins
 * that.</p>
 *
 * <p>Snapshot path (D28-35/D28-39): the fixture's {@code listing.items} are already in the frozen
 * snapshot shape, so {@link #theSnapshotPathRendersTheSameLinesAsTheLivePath()} proves the live
 * renderer and {@code renderFromSnapshot} cannot disagree about the same listing.</p>
 *
 * <p><b>Dirty data (PLAN-0628 M3b-②):</b> the {@code dirty-description-*} cases store values the
 * previous import path could persist — surrounding whitespace, an empty description, and an
 * embedded line break — and pin what {@code view(Listing)} must turn them into. Their
 * {@code descriptionRendered} fields are written by hand (never generated from the renderer, which
 * would make the contract a tautology), and {@link #everyRenderedItemIsOneLineWithoutEdgeWhitespace()}
 * asserts the properties the Agent depends on rather than only the expected text.</p>
 */
class SkillCatalogRenderFixtureTest {

    /** Maven runs with the module as working directory (packages/control-plane). */
    private static final Path FIXTURE = Path.of("..", "..", "spec", "fixtures",
            "skill-catalog-render.json");

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static JsonNode fixture() throws IOException {
        assertTrue(Files.isRegularFile(FIXTURE),
                "shared fixture is missing: " + FIXTURE.toAbsolutePath());
        return MAPPER.readTree(Files.readString(FIXTURE));
    }

    private static JsonNode cases(JsonNode root) {
        JsonNode cases = root.path("cases");
        assertTrue(cases.isArray() && !cases.isEmpty(),
                "the shared contract needs at least one case");
        return cases;
    }

    @Test
    void cpRendersExactlyTheComponentViewTheAgentFixtureWasFrozenFrom() throws IOException {
        JsonNode root = fixture();

        for (JsonNode testCase : cases(root)) {
            SkillCatalogSourceService.ComponentView actual =
                    SkillCatalogSourceService.view(listingOf(testCase.path("listing")));
            JsonNode expected = testCase.path("componentView");

            assertEquals(expected.path("source").asText(), actual.source(),
                    testCase.path("name").asText() + ": source drifted");
            assertEquals(toJson(actual), expected,
                    testCase.path("name").asText() + ": the CP renderer drifted from the shared"
                            + " contract in spec/fixtures/skill-catalog-render.json");
            assertEquals(expected.path("items").size(), actual.items().size(),
                    testCase.path("name").asText() + ": item count drifted");
            assertEquals(expected.path("status").asText(), actual.status(),
                    testCase.path("name").asText() + ": status drifted");
            assertEquals(expected.path("truncated").asBoolean(), actual.truncated(),
                    testCase.path("name").asText() + ": truncated flag drifted");
            assertEquals(texts(expected.path("diagnostics")), actual.diagnostics(),
                    testCase.path("name").asText() + ": diagnostics drifted");

            // The Agent must receive exactly these items — no extra wrapper, no count surprise.
            assertEquals(expected.path("items").size(),
                    testCase.path("agent").path("items").asInt(),
                    testCase.path("name").asText() + ": the Agent fixture expects a different"
                            + " number of items than CP renders");
        }
    }

    @Test
    void cpNeverOwnsTheFraming() throws IOException {
        JsonNode root = fixture();
        String header = root.path("header").asText();
        String note = root.path("truncationNote").asText();
        String separator = root.path("separator").asText();

        assertFalse(header.isEmpty(), "the fixture must pin the header wording");
        assertFalse(note.isEmpty(), "the fixture must pin the truncation wording");
        assertFalse(separator.isEmpty(), "the fixture must pin the name/description separator");

        for (JsonNode testCase : cases(root)) {
            String name = testCase.path("name").asText();
            SkillCatalogSourceService.ComponentView view =
                    SkillCatalogSourceService.view(listingOf(testCase.path("listing")));

            for (String item : view.items()) {
                // D28-41: the truncation sentence is the final renderer's, not CP's. CP reports
                // `truncated=true` + a diagnostic; it must not also write the sentence itself.
                assertFalse(item.contains(note),
                        name + ": CP embedded the Agent's truncation sentence into a listing line"
                                + " (D28-41 says that wording belongs to the final renderer)");
                assertFalse(item.startsWith(header),
                        name + ": CP added the Agent's framing header to a listing line");
            }

            // A rendered description must be joined by the pinned separator, never by an ad-hoc
            // dash: the Agent splits each line on exactly this string to build its ledger keys.
            // `descriptionRendered` (PLAN-0628 M3b-②) lets a case state what a DIRTY stored
            // description must render as — the expectation is written by hand in the fixture, so
            // this check restates the contract instead of re-deriving it from the renderer.
            List<String> items = view.items();
            boolean includeDescriptions =
                    testCase.path("listing").path("includeDescriptions").asBoolean(true);
            for (int index = 0; index < items.size(); index++) {
                String description = expectedRenderedDescription(
                        testCase.path("listing").path("items").path(index), includeDescriptions);
                if (description == null) {
                    assertFalse(items.get(index).contains(separator), name
                            + ": an item without a description must render the display name alone"
                            + " (a dangling separator reads as a description that is missing)");
                } else {
                    assertTrue(items.get(index).endsWith(separator + description), name
                            + ": item " + index + " is not `display + separator + description`");
                }
            }
        }
    }

    /**
     * PLAN-0628 M3b-② (裁定 A/B/C) — the <b>negative</b> half of the pin: whatever the stored
     * description looked like, a rendered item is one line, carries no leading/trailing whitespace,
     * and never ends with a dangling separator.
     *
     * <p>This is exactly what the Agent depends on. It {@code strip()}s every CP line before
     * joining, so an item with edge whitespace is two different byte sequences on the two sides;
     * and an item with an embedded line break is read by the model as <b>two</b> skills. Neither is
     * a formatting preference, which is why both are asserted here rather than only implied by the
     * fixture's expected text.</p>
     */
    @Test
    void everyRenderedItemIsOneLineWithoutEdgeWhitespace() throws IOException {
        JsonNode root = fixture();
        String separator = root.path("separator").asText();

        for (JsonNode testCase : cases(root)) {
            String name = testCase.path("name").asText();
            SkillCatalogSourceService.ComponentView view =
                    SkillCatalogSourceService.view(listingOf(testCase.path("listing")));

            for (String item : view.items()) {
                assertEquals(item.strip(), item, name + ": item carries leading/trailing whitespace"
                        + " — the Agent strips each line, so the two languages would disagree on"
                        + " the same skill");
                assertFalse(item.indexOf('\n') >= 0 || item.indexOf('\r') >= 0, name + ": item spans"
                        + " more than one line — the model would read one skill as two");
                assertFalse(item.endsWith(separator), name + ": item ends with a dangling"
                        + " separator (a description that is absent must remove the separator too)");
            }
        }
    }

    @Test
    void everyLineTheAgentKeepsIsAByteIdenticalCpRenderedLine() throws IOException {
        JsonNode root = fixture();
        String header = root.path("header").asText();
        String note = root.path("truncationNote").asText();

        for (JsonNode testCase : cases(root)) {
            String name = testCase.path("name").asText();
            SkillCatalogSourceService.ComponentView view =
                    SkillCatalogSourceService.view(listingOf(testCase.path("listing")));
            String content = testCase.path("agent").path("expectedContent").asText();
            boolean expectedTruncated = testCase.path("agent").path("expectedTruncated")
                    .asBoolean();

            if (content.isEmpty()) {
                assertTrue(view.items().isEmpty(), name
                        + ": an empty slot is only legal for an empty listing");
                continue;
            }

            String[] lines = content.split("\n", -1);
            assertEquals(header, lines[0], name + ": the Agent's first line must be the header");

            int last = lines.length;
            if (last > 1 && note.equals(lines[last - 1])) {
                last--;
            }
            assertEquals(expectedTruncated, content.endsWith(note), name
                    + ": the truncation sentence must appear exactly when the listing is"
                    + " incomplete (D28-31)");
            assertEquals(expectedTruncated, lines.length > last, name
                    + ": the truncation sentence is present but the case is not truncated");

            int rendered = last - 1;
            assertTrue(rendered <= view.items().size(), name
                    + ": the Agent rendered more lines than CP produced");
            for (int index = 0; index < rendered; index++) {
                assertEquals(view.items().get(index), lines[index + 1], name
                        + ": line " + index + " was re-worded between CP and the Agent; the Agent"
                        + " may drop a tail but must not rewrite a line");
            }
        }
    }

    @Test
    void theSnapshotPathRendersTheSameLinesAsTheLivePath() throws IOException {
        JsonNode root = fixture();

        for (JsonNode testCase : cases(root)) {
            String name = testCase.path("name").asText();
            SkillCatalogSourceService.Listing listing = listingOf(testCase.path("listing"));
            ObjectNode snapshot = MAPPER.createObjectNode();
            snapshot.put("status", listing.status());
            snapshot.put("truncated", listing.truncated());
            snapshot.put("maxSkills", listing.maxSkills());
            snapshot.set("diagnostics", MAPPER.valueToTree(listing.diagnostics()));
            snapshot.set("items", MAPPER.valueToTree(snapshotItems(testCase.path("listing"))));

            SkillCatalogSourceService.Request request = new SkillCatalogSourceService.Request(
                    null, null, null, listing.maxSkills(), listing.includeDescriptions(),
                    SkillCatalogSourceService.SORT_BINDING);

            assertEquals(SkillCatalogSourceService.view(listing).items(),
                    SkillCatalogSourceService.renderFromSnapshot(snapshot, request).items(),
                    name + ": the frozen-snapshot renderer drifted from the live renderer"
                            + " (D28-39 says they are the same lines)");
        }
    }

    @Test
    void theFixtureKeepsCoveringTheScenariosTheContractNeeds() throws IOException {
        JsonNode root = fixture();
        Set<String> statuses = new LinkedHashSet<>();
        Set<String> diagnostics = new LinkedHashSet<>();
        Set<String> names = new LinkedHashSet<>();
        boolean collision = false;
        boolean withoutDescriptions = false;
        boolean truncated = false;

        for (JsonNode testCase : cases(root)) {
            JsonNode listing = testCase.path("listing");
            names.add(testCase.path("name").asText());
            statuses.add(listing.path("status").asText());
            diagnostics.addAll(texts(listing.path("diagnostics")));
            collision |= listing.path("collision").asBoolean(false);
            withoutDescriptions |= !listing.path("includeDescriptions").asBoolean(true);
            truncated |= listing.path("truncated").asBoolean(false);
        }

        assertTrue(statuses.contains(SkillCatalogSourceService.STATUS_READY), "ready case missing");
        assertTrue(statuses.contains(SkillCatalogSourceService.STATUS_TRUNCATED),
                "truncated case missing");
        assertTrue(statuses.contains(SkillCatalogSourceService.STATUS_EMPTY), "empty case missing");
        assertTrue(statuses.contains(SkillCatalogSourceService.STATUS_FAILED), "failed case missing");
        assertTrue(truncated, "no case exercises the CP-side maxSkills cut");
        assertTrue(collision, "no case exercises the qualified (three-segment) name");
        assertTrue(withoutDescriptions, "no case exercises includeDescriptions=false");
        assertTrue(diagnostics.contains(SkillCatalogSourceService.DIAG_MAX_SKILLS),
                "no case reports the maxSkills diagnostic");
        assertTrue(diagnostics.contains(SkillCatalogSourceService.DIAG_COLLISION),
                "no case reports the name-collision diagnostic");
        assertTrue(diagnostics.contains(SkillCatalogSourceService.DIAG_EMPTY),
                "no case reports the empty-listing diagnostic");
        assertTrue(diagnostics.contains(SkillCatalogSourceService.DIAG_RESOLVE_FAILED),
                "no case reports the resolve-failure diagnostic");
        // PLAN-0628 M3b-②: the three dirty-description shapes are the cross-language pin for
        // rulings A/B/C. Dropping one re-opens the drift that produced them.
        assertTrue(names.containsAll(Set.of("dirty-description-whitespace",
                        "dirty-description-blank", "dirty-description-multiline")),
                "the dirty-description cases (whitespace / blank / multiline) are missing: " + names);
    }

    // --- fixture mapping ----------------------------------------------------

    /**
     * Builds the {@code Listing} the renderer consumes from the fixture. Only the fields the
     * renderers read are carried by the fixture; the rest are the values a resolved row would have
     * and cannot influence a rendered line.
     */
    private static SkillCatalogSourceService.Listing listingOf(JsonNode listing) {
        List<SkillCatalogSourceService.Item> items = new ArrayList<>();
        for (JsonNode entry : listing.path("items")) {
            JsonNode tier = entry.path("tier");
            JsonNode description = entry.path("description");
            items.add(new SkillCatalogSourceService.Item(
                    UUID.fromString(entry.path("skillId").asText()),
                    entry.path("qualifiedName").asText(""),
                    entry.path("name").asText(""),
                    description.isNull() ? null : description.asText(""),
                    1,
                    "",
                    false,
                    tier.path("subjectType").asText(""),
                    tier.path("scopeType").asText(""),
                    tier.path("definitionScopeType").asText("")));
        }
        return new SkillCatalogSourceService.Listing(
                listing.path("status").asText(""),
                List.copyOf(items),
                listing.path("truncated").asBoolean(false),
                List.copyOf(texts(listing.path("diagnostics"))),
                listing.path("maxSkills").asInt(SkillCatalogSourceService.DEFAULT_MAX_SKILLS),
                listing.path("includeDescriptions").asBoolean(true),
                listing.path("collision").asBoolean(false));
    }

    /** The snapshot records entries as data; the fixture's items already have exactly that shape. */
    private static ArrayNode snapshotItems(JsonNode listing) {
        ArrayNode items = MAPPER.createArrayNode();
        for (JsonNode entry : listing.path("items")) {
            ObjectNode item = items.addObject();
            item.put("skillId", entry.path("skillId").asText());
            item.put("qualifiedName", entry.path("qualifiedName").asText());
            item.put("name", entry.path("name").asText());
            item.set("description", entry.path("description"));
            item.put("version", 1);
            item.put("contentHash", "");
            item.put("oversize", false);
            item.set("tier", entry.path("tier"));
        }
        return items;
    }

    /**
     * The tail the fixture expects after the separator, read from the case's own stored
     * description. {@code descriptionRendered} is the hand-written expectation for a <b>dirty</b>
     * stored value (PLAN-0628 M3b-②); when absent the stored description is rendered verbatim, and
     * when explicitly {@code null} the item must carry no separator at all.
     */
    private static String expectedRenderedDescription(JsonNode entry, boolean includeDescriptions) {
        if (!includeDescriptions) {
            return null;
        }
        if (entry.has("descriptionRendered")) {
            JsonNode rendered = entry.path("descriptionRendered");
            return rendered.isNull() ? null : rendered.asText();
        }
        JsonNode description = entry.path("description");
        return description.isNull() ? null : description.asText();
    }

    private static List<String> texts(JsonNode array) {
        List<String> values = new ArrayList<>();
        for (JsonNode node : array) {
            values.add(node.asText());
        }
        return List.copyOf(values);
    }

    private static JsonNode toJson(SkillCatalogSourceService.ComponentView view) {
        ObjectNode node = MAPPER.createObjectNode();
        node.put("status", view.status());
        node.put("source", view.source());
        node.set("items", MAPPER.valueToTree(view.items()));
        node.put("truncated", view.truncated());
        node.set("diagnostics", MAPPER.valueToTree(view.diagnostics()));
        return node;
    }
}
