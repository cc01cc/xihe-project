package com.cc01cc.p.xihe.cp.skill;

import com.fasterxml.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * PLAN-0628 M1: the wire projection of a skill definition.
 *
 * <p><b>Wire-safe by construction</b> (PLAN-0633 C1): every component is a scalar, a {@link String},
 * a {@link UUID}, an {@link Instant} or a {@link SkillAttachmentView} list. The entity holds its
 * {@code attachments} as a Jackson-2 {@link JsonNode}; that node is converted here and never leaves
 * the process — sending it would reach the client as Jackson 3's bean introspection
 * ({@code {"array":false,…,"nodeType":"OBJECT"}}).</p>
 *
 * @param body the SKILL.md body, present only when the caller asked for it ({@code includeBody}) —
 *     it is the largest column of the definition, so it is not sent by default
 */
public record SkillView(UUID skillId, String name, DefinitionScopeView definitionScope,
                        String description, int bodyTokensEst, boolean oversize, boolean trusted,
                        String sourcePath, String contentHash, int version,
                        List<SkillAttachmentView> attachments, String body, Instant createdAt,
                        Instant updatedAt) {

    /** The {@code definition_scope_type} × {@code definition_scope_id} pair, as the wire sees it. */
    public record DefinitionScopeView(String type, UUID workspaceId) {}

    public static SkillView from(Skill skill, boolean includeBody) {
        return new SkillView(
                skill.getId(),
                skill.getName(),
                new DefinitionScopeView(skill.getDefinitionScopeType(), skill.getDefinitionScopeId()),
                skill.getDescription(),
                skill.getBodyTokensEst(),
                skill.isOversize(),
                skill.isTrusted(),
                skill.getSourcePath(),
                skill.getContentHash(),
                skill.getVersion(),
                attachments(skill.getAttachments()),
                includeBody ? skill.getBody() : null,
                skill.getCreatedAt(),
                skill.getUpdatedAt());
    }

    /**
     * The jsonb manifest → typed records. A row written before this projection existed (or by a
     * direct insert) may carry anything, so unknown members are skipped instead of failing a read.
     */
    static List<SkillAttachmentView> attachments(JsonNode node) {
        if (node == null || !node.isArray()) {
            return List.of();
        }
        List<SkillAttachmentView> views = new ArrayList<>();
        for (JsonNode entry : node) {
            if (!entry.isObject()) {
                continue;
            }
            String path = entry.path("path").asText(null);
            if (path == null) {
                continue;
            }
            views.add(new SkillAttachmentView(
                    path,
                    entry.path("sizeBytes").asLong(0),
                    entry.path("sha256").asText(""),
                    entry.path("kind").asText(SkillAttachmentView.KIND_REFERENCE)));
        }
        return List.copyOf(views);
    }
}
