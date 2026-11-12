package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.skill.Skill;
import com.cc01cc.p.xihe.cp.skill.SkillBinding;
import com.cc01cc.p.xihe.cp.skill.SkillBindingRepository;
import com.cc01cc.p.xihe.cp.skill.SkillRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Predicate;

/**
 * PLAN-0667 M2: the agent-principal <b>skill binding</b> surface.
 *
 * <p>It reuses the PLAN-0628 skill tables (there is exactly one binding store: {@code skill_bindings}
 * with {@code subject_type='agent_principal'}), but not {@code SkillBindingService}, because that
 * service authorizes through capability atoms ({@code instance:admin}/{@code workspace:admin}) while
 * this surface is gated by {@code MANAGE_AGENT_PRINCIPALS}/{@code MANAGE_WORKSPACE_AGENTS} (the N1
 * decision). Sharing the table while keeping the authorization doors separate is the point.</p>
 *
 * <p>PLAN-0680: the binding is dual-axis. The scope is still <b>server-derived</b>, never accepted
 * from the caller: a workspace authorization context writes {@code workspace(caller.workspaceId)},
 * while its absence writes {@code instance}. A workspace-private definition is bindable only inside
 * its own workspace; any other workspace's private definition is indistinguishable from a missing
 * skill ({@code 404 SKILL_NOT_FOUND}, no existence leak). The former
 * {@code 400 SKILL_DEFINITION_OUT_OF_SCOPE} is retired on this surface only — the user-facing
 * {@code /api/v1/skill-bindings} surface still returns it.</p>
 */
@Service
public class AgentPrincipalSkillBindingService {

    private static final Logger logger = LoggerFactory.getLogger(AgentPrincipalSkillBindingService.class);

    static final String RESOURCE_TYPE = "skill_binding";
    static final String AUDIT_BIND = "agent_principal_skill_bind";
    static final String AUDIT_UNBIND = "agent_principal_skill_unbind";

    private final SkillBindingRepository bindings;
    private final SkillRepository skills;
    private final AgentPrincipalRepository principals;
    private final WorkspaceRepository workspaces;
    private final AuditLogger audit;

    public AgentPrincipalSkillBindingService(SkillBindingRepository bindings, SkillRepository skills,
                                             AgentPrincipalRepository principals,
                                             WorkspaceRepository workspaces, AuditLogger audit) {
        this.bindings = bindings;
        this.skills = skills;
        this.principals = principals;
        this.workspaces = workspaces;
        this.audit = audit;
    }

    /** One binding as the API shows it (UI needs source + size, never the skill body). */
    public record AgentSkillBindingView(UUID bindingId, UUID principalId, UUID skillId, String name,
                                        String description, String sourceType, String sourceName,
                                        String scopeType, UUID scopeId, String scopeName,
                                        int tokenEstimate, UUID createdByUserId, Instant createdAt) {
    }

    @Transactional(readOnly = true)
    public List<AgentSkillBindingView> list(UUID principalId) {
        List<SkillBinding> rows = bindings.findBySubjectTypeAndSubjectIdOrderByCreatedAtAsc(
                SkillBinding.SUBJECT_AGENT_PRINCIPAL, principalId);
        if (rows.isEmpty()) {
            return List.of();
        }
        Map<UUID, Skill> byId = new LinkedHashMap<>();
        for (Skill skill : skills.findAllById(rows.stream().map(SkillBinding::getSkillId).toList())) {
            byId.put(skill.getId(), skill);
        }
        List<AgentSkillBindingView> views = new ArrayList<>(rows.size());
        for (SkillBinding row : rows) {
            Skill skill = byId.get(row.getSkillId());
            if (skill != null) {
                views.add(viewOf(row, skill));
            }
        }
        return views;
    }

    /**
     * Bind one skill definition to one agent principal at the server-derived scope.
     *
     * @param authWorkspaceId   the authorizing workspace context, or {@code null} for instance scope
     * @param instanceTier      whether the caller holds the instance-tier management atom
     * @param canManageWorkspace re-check of the workspace atom, so a direct service caller cannot
     *                           write a workspace row by passing an arbitrary workspace id
     */
    @Transactional
    public AgentSkillBindingView bind(UUID principalId, UUID skillId, UUID actorUserId,
                                      UUID authWorkspaceId, boolean instanceTier,
                                      Predicate<UUID> canManageWorkspace) {
        requirePrincipal(principalId);
        AccessScope scope = deriveScope(authWorkspaceId, instanceTier, canManageWorkspace);
        Skill skill = skills.findById(skillId).orElseThrow(
                AgentPrincipalSkillBindingService::skillNotFound);
        // I-6 (task-222): the personal layer is never bindable here, on either axis, and the answer
        // is the same 404 as a missing id (openapi.yaml:726-728). Explicit because A2/D-1019 stores
        // the owner in definition_scope_user_id and leaves definition_scope_id NULL: the workspace
        // arm below is a "id != null && id != scope" test, so a user row would have slipped through
        // it and been bound at instance scope (the fork with /api/v1/skill-bindings, which I-4
        // already closed).
        if (Skill.DEFINITION_SCOPE_USER.equals(skill.getDefinitionScopeType())) {
            throw skillNotFound();
        }
        // Fixed-order visibility + atom-source restriction: a private definition participates only
        // in its own workspace. Anything else — including a workspace context absent — is a 404 so
        // the caller cannot probe another workspace's skill library (the old visible/400,
        // invisible/404 split leaked existence).
        if (skill.getDefinitionScopeId() != null
                && !skill.getDefinitionScopeId().equals(scope.id())) {
            throw skillNotFound();
        }
        if (bindings.countExact(skillId, SkillBinding.SUBJECT_AGENT_PRINCIPAL, principalId,
                scope.type(), scope.id()) > 0) {
            throw new CpApiException(HttpStatus.CONFLICT, "SKILL_BINDING_EXISTS",
                    "this agent principal already has that skill binding in that scope");
        }
        SkillBinding row = new SkillBinding();
        row.setSkillId(skillId);
        row.setSubjectType(SkillBinding.SUBJECT_AGENT_PRINCIPAL);
        row.setSubjectId(principalId);
        row.setScopeType(scope.type());
        row.setScopeId(scope.id());
        row.setCreatedByUserId(actorUserId);
        SkillBinding saved = bindings.saveAndFlush(row);
        audit.recordDurableChange(actorUserId.toString(), auditWorkspaceId(scope), AUDIT_BIND,
                RESOURCE_TYPE, saved.getId().toString(),
                auditDetail(skillId, saved.getId(), principalId, scope.type(), scope.id(), "bound"));
        logger.info("[POLICY] event=agent_principal_skill_bind principalId={} skillId={} "
                        + "scopeType={} scopeId={} actor={}",
                principalId, skillId, scope.type(), scope.id(), actorUserId);
        return viewOf(saved, skill);
    }

    @Transactional
    public void unbind(UUID principalId, UUID bindingId, UUID actorUserId,
                       UUID authWorkspaceId, boolean instanceTier) {
        SkillBinding row = bindings.findById(bindingId)
                .filter(candidate -> SkillBinding.SUBJECT_AGENT_PRINCIPAL.equals(
                        candidate.getSubjectType()))
                .filter(candidate -> principalId.equals(candidate.getSubjectId()))
                .filter(candidate -> mayDeleteAtRowScope(candidate, authWorkspaceId, instanceTier))
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "SKILL_BINDING_NOT_FOUND",
                        "Skill binding not found"));
        bindings.delete(row);
        bindings.flush();
        audit.recordDurableChange(actorUserId.toString(),
                authWorkspaceId == null ? null : authWorkspaceId.toString(),
                AUDIT_UNBIND, RESOURCE_TYPE, bindingId.toString(),
                auditDetail(row.getSkillId(), bindingId, principalId, row.getScopeType(),
                        row.getScopeId(), "unbound"));
        logger.info("[POLICY] event=agent_principal_skill_unbind principalId={} bindingId={} "
                        + "scopeType={} scopeId={} actor={}",
                principalId, bindingId, row.getScopeType(), row.getScopeId(), actorUserId);
    }

    /**
     * Instance tier may delete any row. A workspace-tier caller may delete only a workspace row in
     * the exact authorizing workspace; an instance row and another workspace's row are invisible.
     */
    private static boolean mayDeleteAtRowScope(SkillBinding row, UUID authWorkspaceId,
                                               boolean instanceTier) {
        if (instanceTier) {
            return true;
        }
        // 404 防存在性泄露；角色面 403 的差异见 design.md:171（R-10 只本面 retired）
        return SkillBinding.SCOPE_WORKSPACE.equals(row.getScopeType())
                && row.getScopeId() != null
                && row.getScopeId().equals(authWorkspaceId);
    }

    /**
     * The same gap-2 decision as the role surface: a workspace context means workspace scope,
     * otherwise instance scope. The client never supplies a scope, so it cannot move a binding into
     * a workspace it cannot manage.
     */
    private AccessScope deriveScope(UUID authWorkspaceId, boolean instanceTier,
                                    Predicate<UUID> canManageWorkspace) {
        if (authWorkspaceId == null) {
            if (!instanceTier) {
                throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                        "binding at the instance scope requires MANAGE_AGENT_PRINCIPALS");
            }
            return AccessScope.instance();
        }
        if (!instanceTier && !canManageWorkspace.test(authWorkspaceId)) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "MANAGE_WORKSPACE_AGENTS in the authorizing workspace is required");
        }
        return AccessScope.workspace(authWorkspaceId);
    }

    private static String auditWorkspaceId(AccessScope scope) {
        return scope.id() == null ? null : scope.id().toString();
    }

    private void requirePrincipal(UUID principalId) {
        AgentPrincipal principal = principals.findById(principalId)
                .orElseThrow(AgentPrincipalSkillBindingService::principalNotFound);
        if (principal.getDisabledAt() != null) {
            throw principalNotFound();
        }
    }

    private AgentSkillBindingView viewOf(SkillBinding row, Skill skill) {
        boolean workspaceDefinition = skill.getDefinitionScopeId() != null;
        String sourceName = workspaceDefinition
                ? workspaces.findById(skill.getDefinitionScopeId()).map(w -> w.getName()).orElse(null)
                : null;
        String scopeName = SkillBinding.SCOPE_WORKSPACE.equals(row.getScopeType())
                && row.getScopeId() != null
                ? workspaces.findById(row.getScopeId()).map(w -> w.getName()).orElse(null)
                : null;
        // The literal "personal" is the CONTRACT's word for "not a workspace-private definition"
        // (openapi.yaml AgentPrincipalSkillBindingView.sourceType enum [workspace, personal]); it
        // means "the instance library" here and must NOT be read as the new type=user personal
        // layer (V156) — a user row never reaches this method because bind() refuses it above.
        // Renaming the enum member would be a contract change, so it is left as-is and flagged.
        return new AgentSkillBindingView(row.getId(), row.getSubjectId(), skill.getId(), skill.getName(),
                skill.getDescription(), workspaceDefinition ? "workspace" : "personal", sourceName,
                row.getScopeType(), row.getScopeId(), scopeName,
                skill.getBodyTokensEst(), row.getCreatedByUserId(), row.getCreatedAt());
    }

    private static CpApiException skillNotFound() {
        // The detail string is shared with /api/v1/skill-bindings on purpose (I-6): both faces must
        // answer a personal definition, and a missing id, with the exact same body.
        return new CpApiException(HttpStatus.NOT_FOUND, "SKILL_NOT_FOUND",
                com.cc01cc.p.xihe.cp.skill.SkillBindingService.SKILL_NOT_FOUND_DETAIL);
    }

    private static CpApiException principalNotFound() {
        return new CpApiException(HttpStatus.NOT_FOUND, "AGENT_PRINCIPAL_NOT_FOUND",
                "Agent principal not found");
    }

    private static String auditDetail(UUID skillId, UUID bindingId, UUID principalId,
                                      String scopeType, UUID scopeId, String result) {
        return "{\"skillId\":\"" + skillId + "\",\"bindingId\":\"" + bindingId
                + "\",\"principalId\":\"" + principalId + "\",\"scopeType\":\"" + scopeType
                + "\",\"scopeId\":" + (scopeId == null ? "null" : "\"" + scopeId + "\"")
                + ",\"result\":\"" + result + "\"}";
    }
}