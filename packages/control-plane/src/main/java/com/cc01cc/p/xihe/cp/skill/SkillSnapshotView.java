package com.cc01cc.p.xihe.cp.skill;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.List;

/**
 * PLAN-0628 M2a-③ (D28-42): the <b>read-only replay</b> projection of a Run's frozen skills listing.
 *
 * <p>The stored document ({@code chat_runs.skills_snapshot}) is a Jackson-2 {@link JsonNode}, and
 * PLAN-0633 C1 forbids that node from reaching HTTP (Jackson 3 would introspect it as a bean and the
 * wire would carry {@code nodeType}/{@code array}/… instead of the document). This record is the
 * explicit typed exit: every field below is projected through a scalar read
 * ({@code .path(...).asText()/asInt()/asBoolean()}), so no node is part of the response graph. The
 * two mechanical gates ({@code Jackson2NodeWireScanTest} statically, {@code Jackson2NodeWireInterceptor}
 * at runtime) therefore see a plain record.
 *
 * <p><b>Replay only, never a gate.</b> Nothing in this projection is consulted while a Run executes —
 * the listing the model sees is rendered from the same document at dispatch (D28-39); this view exists
 * so a reader can answer "what capability set did this Run start with, and at which version of each
 * skill" after the fact. The projection is deliberately closed: a snapshot written by a newer CP
 * ({@code version} &gt; {@link #VERSION}) loses the fields this code does not know, and the client can
 * tell because {@code version} is part of the payload.
 */
public record SkillSnapshotView(
        int version,
        String status,
        String source,
        String capturedAt,
        String snapshotSource,
        int maxSkills,
        boolean truncated,
        List<String> diagnostics,
        List<Item> items) {

    /** The snapshot schema version this projection understands. */
    public static final int VERSION = SkillCatalogSnapshotService.VERSION;

    /**
     * One listing entry: what the model was shown, plus the provenance the snapshot exists to keep
     * (D28-35: {@code contentHash} answers "which version was listed", {@code oversize} explains the
     * admission-time trade-off). The body is deliberately absent — it is read on demand, not frozen.
     */
    public record Item(String skillId, String qualifiedName, String name, String description,
                       int version, String contentHash, boolean oversize, Tier tier) {
    }

    /** D28-31's three-segment qualified name, split into its binding/definition axes. */
    public record Tier(String subjectType, String scopeType, String definitionScopeType) {
    }

    /**
     * Projects one stored snapshot, or {@code null} when the Run captured none.
     *
     * <p>{@code null} is the contract for "not captured" ({@code {}}, D28-40) and is deliberately not
     * an empty object: an empty listing is {@code status: empty}, and conflating the two would tell a
     * reader "this Run had no skills" when the truth is "this Run predates the snapshot" (its listing
     * is resolved live at dispatch, which this replay cannot represent).
     */
    public static SkillSnapshotView of(JsonNode snapshot) {
        if (SkillCatalogSnapshotService.isAbsent(snapshot)) {
            return null;
        }
        return new SkillSnapshotView(
                snapshot.path("version").asInt(VERSION),
                text(snapshot, "status"),
                text(snapshot, "source"),
                text(snapshot, "capturedAt"),
                text(snapshot, "snapshotSource"),
                snapshot.path("maxSkills").asInt(SkillCatalogSourceService.DEFAULT_MAX_SKILLS),
                snapshot.path("truncated").asBoolean(false),
                diagnosticsOf(snapshot.path("diagnostics")),
                itemsOf(snapshot.path("items")));
    }

    private static List<Item> itemsOf(JsonNode items) {
        if (!items.isArray()) {
            return List.of();
        }
        List<Item> projected = new ArrayList<>(items.size());
        for (JsonNode item : items) {
            projected.add(new Item(
                    text(item, "skillId"),
                    text(item, "qualifiedName"),
                    text(item, "name"),
                    text(item, "description"),
                    item.path("version").asInt(1),
                    text(item, "contentHash"),
                    item.path("oversize").asBoolean(false),
                    tierOf(item.path("tier"))));
        }
        return List.copyOf(projected);
    }

    private static Tier tierOf(JsonNode tier) {
        if (!tier.isObject()) {
            return null;
        }
        return new Tier(text(tier, "subjectType"), text(tier, "scopeType"),
                text(tier, "definitionScopeType"));
    }

    /**
     * Diagnostic codes stay free-form strings with a documented set: a new code must be readable by an
     * older reader (that is the point of a diagnostic), so a closed enum here would reject the very
     * messages this field exists to carry.
     */
    private static List<String> diagnosticsOf(JsonNode diagnostics) {
        if (!diagnostics.isArray()) {
            return List.of();
        }
        List<String> codes = new ArrayList<>(diagnostics.size());
        for (JsonNode diagnostic : diagnostics) {
            if (diagnostic.isTextual()) {
                codes.add(diagnostic.asText());
            }
        }
        return List.copyOf(codes);
    }

    /** A missing or non-textual field reads as {@code null} instead of fabricating a value. */
    private static String text(JsonNode node, String field) {
        JsonNode value = node.path(field);
        return value.isTextual() ? value.asText() : null;
    }
}
