package com.cc01cc.p.xihe.cp.skill;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.policy.CapabilityAuthorities;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.util.UUID;

/**
 * PLAN-0628 M1: the one place that answers "who is calling and what may they touch".
 *
 * <p>Why this exists as a service rather than inline in the controllers (beyond
 * {@code CpArchitectureTest.controllersDoNotDependOnRepositories}): <b>a controller must never
 * assert a right it has not resolved.</b> The first draft of {@code SkillBindingController.delete}
 * passed a blanket "manages every workspace" flag to save one query, which would have let any
 * authenticated caller delete any workspace-scoped binding. Centralising the resolution means the
 * controllers can only pass answers, never assumptions.</p>
 */
@Service
public class SkillAccessGuard {

    private final WorkspaceService workspaceService;

    public SkillAccessGuard(WorkspaceService workspaceService) {
        this.workspaceService = workspaceService;
    }

    /** The authenticated actor id, or 401 when the request carries none. */
    public String requireActor() {
        String actor = TenantContext.getUserId();
        if (actor == null || actor.isBlank()) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED",
                    "Authentication required");
        }
        return actor;
    }

    public boolean isInstanceAdmin() {
        return TenantContext.hasCapability(CapabilityAuthorities.CAP_INSTANCE_ADMIN);
    }

    /** Any membership of the workspace is enough to see its private definitions. */
    public boolean canSeeWorkspace(UUID workspaceId) {
        return workspaceId != null
                && workspaceService.resolveWorkspaceRole(workspaceId.toString(), requireActor()) != null;
    }

    public boolean canManageWorkspace(UUID workspaceId) {
        return workspaceId != null && com.cc01cc.p.xihe.cp.entity.WorkspaceRole.canManage(
                workspaceService.resolveWorkspaceRole(workspaceId.toString(), requireActor()));
    }

    /** Write rights for one definition scope: instance library ⇒ admin, workspace library ⇒ manage. */
    public boolean canWriteDefinitionScope(String definitionScopeType, UUID definitionScopeId) {
        return Skill.DEFINITION_SCOPE_INSTANCE.equals(definitionScopeType)
                ? isInstanceAdmin()
                : isInstanceAdmin() || canManageWorkspace(definitionScopeId);
    }
}
