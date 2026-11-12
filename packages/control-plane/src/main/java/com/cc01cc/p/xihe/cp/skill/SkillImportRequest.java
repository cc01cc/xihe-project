package com.cc01cc.p.xihe.cp.skill;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.springframework.http.HttpStatus;

import java.util.List;
import java.util.UUID;

/**
 * PLAN-0628 M1: the body of {@code POST /api/v1/skills/import}.
 *
 * <p>Deliberately carries no bookkeeping fields — {@code contentHash}, {@code bodyTokensEst},
 * {@code oversize} and {@code version} are computed by {@link SkillImportService}, so a client
 * cannot supply (or forge) them.</p>
 *
 * <p>The wire shape mirrors {@code openapi.yaml} {@code SkillDefinitionScope}: {@code type} is the
 * only required member, {@code workspaceId} is <b>required iff</b> {@code type=workspace} and must
 * be absent otherwise, and the schema deliberately has no {@code userId} member — the owner of a
 * personal definition is the authenticated caller (V156 / D-1019; shape enforcement lives in
 * {@link SkillController}, which deserializes this body strictly).</p>
 */
public record SkillImportRequest(DefinitionScope definitionScope, List<SkillImportItem> skills) {

    /** {@code {type: instance}} / {@code {type: workspace, workspaceId: …}} / {@code {type: user}}. */
    public record DefinitionScope(String type, UUID workspaceId) {}

    /**
     * Maps the wire scope onto the service scope (I-1). <b>Every unlisted type is rejected</b>: the
     * previous version mapped "anything that is not <i>workspace</i>" to {@code instance}, which
     * silently wrote a {@code {type:'user'}} request into the shared instance library. The owner of
     * a personal scope is {@code callerUserId} — never a body member.
     *
     * @param callerUserId the authenticated actor; its id becomes the personal row's owner
     */
    public SkillImportService.DefinitionScope toServiceScope(UUID callerUserId) {
        if (definitionScope == null || definitionScope.type() == null) {
            return null;
        }
        String type = definitionScope.type();
        UUID workspaceId = definitionScope.workspaceId();
        if (Skill.DEFINITION_SCOPE_INSTANCE.equals(type)) {
            requireAbsentWorkspaceId(type, workspaceId);
            return SkillImportService.DefinitionScope.instance();
        }
        if (Skill.DEFINITION_SCOPE_WORKSPACE.equals(type)) {
            if (workspaceId == null) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "definitionScope.workspaceId is required when type is workspace");
            }
            return SkillImportService.DefinitionScope.workspace(workspaceId);
        }
        if (Skill.DEFINITION_SCOPE_USER.equals(type)) {
            requireAbsentWorkspaceId(type, workspaceId);
            if (callerUserId == null) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "the personal layer needs an authenticated caller");
            }
            return SkillImportService.DefinitionScope.user(callerUserId);
        }
        throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                "definitionScope.type must be instance, workspace or user");
    }

    /** `openapi.yaml`: workspaceId "must be absent when type=instance or type=user". */
    private static void requireAbsentWorkspaceId(String type, UUID workspaceId) {
        if (workspaceId != null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "definitionScope.workspaceId must be absent when type is " + type);
        }
    }
}
