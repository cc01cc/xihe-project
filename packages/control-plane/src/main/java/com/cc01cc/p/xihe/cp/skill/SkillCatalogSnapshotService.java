package com.cc01cc.p.xihe.cp.skill;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * PLAN-0628 M2a (D28-35…D28-40): freezes the skills listing a Run was admitted with.
 *
 * <p>The snapshot is a <b>record of what the model was shown</b>, not a second source of truth for
 * bindings (D28-37): {@code skill_bindings} stays authoritative, and this document is a projection of
 * it at one instant. Storing the listing (rather than a reference) is what makes a Run reproducible —
 * a reference would let a binding edit change the listing between two provider calls of the same Run,
 * which is exactly the drift the snapshot exists to remove.</p>
 *
 * <p><b>Recording layer, never a gate.</b> Every failure mode here — no listing component, several
 * listing components, a resolve failure, an oversized document — is written as a {@code failed}
 * document (or omitted entirely) and the Run continues. Losing the record reduces explainability;
 * blocking the Run would let a diagnostic concern stop the product (D27-22's fail-soft rule).</p>
 *
 * <p><b>Size assertion</b> (D28-35): {@code maxSkills} caps the entry count, so a document over
 * {@link #MAX_SNAPSHOT_BYTES} can only come from pathologically long descriptions. That is a signal
 * worth seeing, so it is reported instead of silently truncating — a truncated snapshot would stop
 * matching what the model actually saw, defeating its purpose.</p>
 */
@Service
public class SkillCatalogSnapshotService {

    /** Snapshot schema version; a future field addition bumps it so readers can tell. */
    public static final int VERSION = 1;

    /** ≈10× the measured 40-entry size (~6 KB): only description bloat can cross it. */
    public static final int MAX_SNAPSHOT_BYTES = 64 * 1024;

    /** Computed at this Run's admission. */
    public static final String SNAPSHOT_SOURCE_FROZEN = "frozen";

    /** Inherited verbatim from the continuation's parent Run (D28-39 ②). */
    public static final String SNAPSHOT_SOURCE_INHERITED = "inherited";

    public static final String DIAG_TOO_LARGE = "skill_snapshot_too_large";

    /** D28-40: the Run predates M2a, so nothing was captured — the read side must say so. */
    public static final String DIAG_ABSENT = "snapshot_absent";

    /** A template revision with two enabled listing components cannot be frozen faithfully. */
    public static final String DIAG_MULTIPLE_COMPONENTS = "skill_snapshot_multiple_components";

    private static final String COMPONENT_TYPE = "skill_catalog";

    private final SkillCatalogSourceService catalog;
    private final ObjectMapper json;

    public SkillCatalogSnapshotService(SkillCatalogSourceService catalog, ObjectMapper json) {
        this.catalog = catalog;
        this.json = json;
    }

    /**
     * Captures this Run's listing from its admission-frozen template snapshot.
     *
     * <p>Returns {@code null} when the template carries no enabled listing component — there is no
     * listing to record, and the column keeps its {@code {}} "not captured" default rather than
     * pretending a listing was captured.</p>
     *
     * @param templateSnapshot the very snapshot written to {@code chat_runs.context_template_snapshot}
     *     in the same transaction, so the frozen listing and the frozen template belong to one admission
     * @param agentPrincipalId the Session's Agent principal (the AGENT tier); may be null
     * @param userId the owning user (the USER tier)
     * @param workspaceId the Run's workspace scope
     */
    /**
     * Captures this Run's listing for the boundary it was admitted with.
     *
     * <p><b>Where the listing comes from</b> (skill-wiring ruling 2026-11-04): {@code skill_bindings} is
     * the authoritative source (D28-37), and it always has been — a template's {@code skill_catalog}
     * component only <i>tunes</i> the listing ({@code maxSkills}, {@code includeDescriptions},
     * {@code sort}); it never supplies the skill set. The previous implementation read the component and
     * returned {@code null} when the template had none, which is the production shape (the built-in
     * api-request template carries only {@code bodySource}) — so a bound skill froze as {@code {}} and
     * the model never saw it. This method therefore resolves from the bindings in <b>both</b> cases:
     * with the component's config when it exists, with the frozen defaults otherwise.</p>
     *
     * <p>Returns {@code null} — the column then keeps its {@code {}} "not captured" default — when
     * there is no subject to resolve for ({@code agentPrincipalId} and {@code userId} both absent) or
     * when the subject has no live binding. An empty listing is not frozen as {@code status: empty}:
     * the requirement is "no bindings ⇒ {@code {}}", and forging an "empty capture" for every Run would
     * blur the pre-M2a meaning of the column.</p>
     *
     * @param templateSnapshot the very snapshot written to {@code chat_runs.context_template_snapshot}
     *     in the same transaction, so the frozen listing and the frozen template belong to one admission
     * @param agentPrincipalId the Session's Agent principal (the AGENT tier); may be null
     * @param userId the owning user (the USER tier)
     * @param workspaceId the Run's workspace scope
     */
    public JsonNode capture(JsonNode templateSnapshot, UUID agentPrincipalId, UUID userId,
                            UUID workspaceId) {
        if (agentPrincipalId == null && userId == null) {
            // No subject means no binding could ever match: nothing was listed, so record nothing.
            return null;
        }
        JsonNode components = templateSnapshot == null ? null
                : templateSnapshot.path("template").path("components");
        List<JsonNode> configs = new ArrayList<>();
        if (components != null && components.isArray()) {
            for (JsonNode component : components) {
                if (COMPONENT_TYPE.equals(component.path("type").asText())
                        && component.path("enabled").asBoolean(false)) {
                    configs.add(component.path("config"));
                }
            }
        }
        if (configs.size() > 1) {
            // Two listing components would render two different listings from one frozen document;
            // say so instead of freezing one of them and silently mis-describing the other.
            return failedDocument(DIAG_MULTIPLE_COMPONENTS);
        }
        try {
            SkillCatalogSourceService.Request request = configs.isEmpty()
                    ? SkillCatalogSourceService.Request.of(agentPrincipalId, userId, workspaceId)
                    : SkillCatalogSourceService.requestFrom(configs.getFirst(), agentPrincipalId, userId,
                            workspaceId);
            SkillCatalogSourceService.Listing listing = catalog.resolveListing(request);
            if (listing.items().isEmpty()) {
                // No live binding for this subject/workspace: keep '{}' rather than inventing a
                // listing the model was never shown (the same rule as "no subject" above).
                return null;
            }
            return document(listing, Instant.now());
        } catch (RuntimeException resolveFailure) {
            // Includes the reserved/unknown sort values requestFrom can surface: the Run still runs.
            return failedDocument(SkillCatalogSourceService.DIAG_RESOLVE_FAILED);
        }
    }

    /**
     * D28-39 ②: a continuation inherits the parent listing <b>verbatim</b>.
     *
     * <p>Not re-resolved on purpose: a binding added while the parent ran must not appear in the
     * child, otherwise the continuation would see a different capability set than the Run it
     * continues (the inconsistency D28-35 exists to eliminate). A parent without a snapshot stays
     * without one: the child then falls back to live resolution <i>visibly</i> (D28-40), which is the
     * honest outcome — inventing an "empty capture" here would forge history.</p>
     */
    public static JsonNode inherited(JsonNode parent) {
        if (isAbsent(parent) || !parent.isObject()) {
            return JsonNodeFactory.instance.objectNode();
        }
        ObjectNode copy = (ObjectNode) parent.deepCopy();
        copy.put("snapshotSource", SNAPSHOT_SOURCE_INHERITED);
        return copy;
    }

    /**
     * D28-40: {@code {}} means "this Run never captured a snapshot" (it predates M2a), never "this Run
     * had no skills" — the latter is {@code {"status":"empty"}}.
     */
    public static boolean isAbsent(JsonNode snapshot) {
        return snapshot == null || !snapshot.isObject() || !snapshot.path("status").isTextual();
    }

    private JsonNode document(SkillCatalogSourceService.Listing listing, Instant capturedAt) {
        ObjectNode document = base(capturedAt, listing.status());
        document.put("maxSkills", listing.maxSkills());
        ArrayNode items = document.putArray("items");
        for (SkillCatalogSourceService.Item item : listing.items()) {
            ObjectNode entry = items.addObject();
            if (item.skillId() != null) {
                entry.put("skillId", item.skillId().toString());
            }
            entry.put("qualifiedName", item.qualifiedName());
            entry.put("name", item.name());
            entry.put("description", item.description());
            entry.put("version", item.version());
            entry.put("contentHash", item.contentHash());
            entry.put("oversize", item.oversize());
            ObjectNode tier = entry.putObject("tier");
            tier.put("subjectType", item.subjectType());
            tier.put("scopeType", item.scopeType());
            tier.put("definitionScopeType", item.definitionScopeType());
        }
        document.put("truncated", listing.truncated());
        ArrayNode diagnostics = document.putArray("diagnostics");
        listing.diagnostics().forEach(diagnostics::add);
        if (serializedSize(document) > MAX_SNAPSHOT_BYTES) {
            return failedDocument(DIAG_TOO_LARGE);
        }
        return document;
    }

    private JsonNode failedDocument(String diagnostic) {
        ObjectNode document = base(Instant.now(), SkillCatalogSourceService.STATUS_FAILED);
        document.put("maxSkills", SkillCatalogSourceService.DEFAULT_MAX_SKILLS);
        document.putArray("items");
        document.put("truncated", false);
        document.putArray("diagnostics").add(diagnostic);
        return document;
    }

    private ObjectNode base(Instant capturedAt, String status) {
        ObjectNode document = json.createObjectNode();
        document.put("version", VERSION);
        document.put("status", status);
        document.put("source", SkillCatalogSourceService.SOURCE);
        document.put("capturedAt", capturedAt.toString());
        document.put("snapshotSource", SNAPSHOT_SOURCE_FROZEN);
        return document;
    }

    /**
     * The document's size on the wire, in bytes. A document that cannot be serialized cannot be
     * asserted at all, so the failure is surfaced (and caught by {@link #capture} into a
     * {@code resolve_failed} record) instead of being reported as "too large".
     */
    private int serializedSize(ObjectNode document) {
        try {
            return json.writeValueAsBytes(document).length;
        } catch (JsonProcessingException serializationFailure) {
            throw new IllegalStateException("Unable to measure the skills snapshot", serializationFailure);
        }
    }
}
