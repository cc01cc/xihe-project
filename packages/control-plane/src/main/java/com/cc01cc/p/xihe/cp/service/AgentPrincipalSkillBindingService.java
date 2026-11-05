package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
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
 * <p>v1 contract (D3(a)): a principal-level skill binding is always <b>instance scope</b>
 * ({@code scope_type='instance'}, {@code scope_id=null}); the caller cannot choose a workspace scope
 * through this endpoint, so an agent cannot be handed a skillset that only makes sense inside one
 * workspace through a path that forgot to check that workspace. A workspace-private skill definition
 * is therefore not bindable here: visible ones answer {@code 400 SKILL_DEFINITION_OUT_OF_SCOPE},
 * invisible ones answer the same {@code 404 SKILL_NOT_FOUND} as a missing skill (no existence leak).</p>
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
     * Bind one skill definition to one agent principal (instance scope, server-decided).
     *
     * @param canSeeWorkspace visibility probe for a workspace-private definition; the caller resolves
     *                        it from the same request authority it used for the surface gate.
     */
    @Transactional
    public AgentSkillBindingView bind(UUID principalId, UUID skillId, UUID actorUserId,
                                      String auditWorkspaceId, Predicate<UUID> canSeeWorkspace) {
        requirePrincipal(principalId);
        Skill skill = skills.findById(skillId).orElseThrow(
                AgentPrincipalSkillBindingService::skillNotFound);
        if (skill.getDefinitionScopeId() != null) {
            if (!canSeeWorkspace.test(skill.getDefinitionScopeId())) {
                throw skillNotFound();
            }
            throw new CpApiException(HttpStatus.BAD_REQUEST, "SKILL_DEFINITION_OUT_OF_SCOPE",
                    "an agent principal skill binding is instance-scope; "
                            + "a workspace-private skill definition cannot be bound to a principal");
        }
        if (bindings.countExact(skillId, SkillBinding.SUBJECT_AGENT_PRINCIPAL, principalId,
                SkillBinding.SCOPE_INSTANCE, null) > 0) {
            throw new CpApiException(HttpStatus.CONFLICT, "SKILL_BINDING_EXISTS",
                    "this agent principal already has that skill binding");
        }
        SkillBinding row = new SkillBinding();
        row.setSkillId(skillId);
        row.setSubjectType(SkillBinding.SUBJECT_AGENT_PRINCIPAL);
        row.setSubjectId(principalId);
        row.setScopeType(SkillBinding.SCOPE_INSTANCE);
        row.setScopeId(null);
        row.setCreatedByUserId(actorUserId);
        SkillBinding saved = bindings.saveAndFlush(row);
        audit.recordDurableChange(actorUserId.toString(), auditWorkspaceId, AUDIT_BIND, RESOURCE_TYPE,
                saved.getId().toString(),
                auditDetail(skillId, saved.getId(), principalId, "bound"));
        logger.info("[POLICY] event=agent_principal_skill_bind principalId={} skillId={} actor={}",
                principalId, skillId, actorUserId);
        return viewOf(saved, skill);
    }

    @Transactional
    public void unbind(UUID principalId, UUID bindingId, UUID actorUserId, String auditWorkspaceId) {
        SkillBinding row = bindings.findById(bindingId)
                .filter(candidate -> SkillBinding.SUBJECT_AGENT_PRINCIPAL.equals(
                        candidate.getSubjectType()))
                .filter(candidate -> principalId.equals(candidate.getSubjectId()))
                .filter(candidate -> SkillBinding.SCOPE_INSTANCE.equals(candidate.getScopeType()))
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "SKILL_BINDING_NOT_FOUND",
                        "Skill binding not found"));
        bindings.delete(row);
        bindings.flush();
        audit.recordDurableChange(actorUserId.toString(), auditWorkspaceId, AUDIT_UNBIND, RESOURCE_TYPE,
                bindingId.toString(),
                auditDetail(row.getSkillId(), bindingId, principalId, "unbound"));
        logger.info("[POLICY] event=agent_principal_skill_unbind principalId={} bindingId={} actor={}",
                principalId, bindingId, actorUserId);
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
        return new AgentSkillBindingView(row.getId(), row.getSubjectId(), skill.getId(), skill.getName(),
                skill.getDescription(), workspaceDefinition ? "workspace" : "personal", sourceName,
                skill.getBodyTokensEst(), row.getCreatedByUserId(), row.getCreatedAt());
    }

    private static CpApiException skillNotFound() {
        return new CpApiException(HttpStatus.NOT_FOUND, "SKILL_NOT_FOUND", "Skill not found");
    }

    private static CpApiException principalNotFound() {
        return new CpApiException(HttpStatus.NOT_FOUND, "AGENT_PRINCIPAL_NOT_FOUND",
                "Agent principal not found");
    }

    private static String auditDetail(UUID skillId, UUID bindingId, UUID principalId, String result) {
        return "{\"skillId\":\"" + skillId + "\",\"bindingId\":\"" + bindingId
                + "\",\"principalId\":\"" + principalId + "\",\"result\":\"" + result + "\"}";
    }
}