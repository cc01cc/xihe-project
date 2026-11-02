package com.cc01cc.p.xihe.cp.skill;

import java.util.List;
import java.util.UUID;

/**
 * PLAN-0628 M1: the body of {@code POST /api/v1/skills/import}.
 *
 * <p>Deliberately carries no bookkeeping fields — {@code contentHash}, {@code bodyTokensEst},
 * {@code oversize} and {@code version} are computed by {@link SkillImportService}, so a client
 * cannot supply (or forge) them.</p>
 */
public record SkillImportRequest(DefinitionScope definitionScope, List<SkillImportItem> skills) {

    /** {@code {type: instance}} or {@code {type: workspace, workspaceId: …}}. */
    public record DefinitionScope(String type, UUID workspaceId) {}

    public SkillImportService.DefinitionScope toServiceScope() {
        if (definitionScope == null || definitionScope.type() == null) {
            return null;
        }
        return Skill.DEFINITION_SCOPE_WORKSPACE.equals(definitionScope.type())
                ? SkillImportService.DefinitionScope.workspace(definitionScope.workspaceId())
                : SkillImportService.DefinitionScope.instance();
    }
}
