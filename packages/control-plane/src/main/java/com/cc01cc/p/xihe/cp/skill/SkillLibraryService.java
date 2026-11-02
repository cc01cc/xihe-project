package com.cc01cc.p.xihe.cp.skill;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

/**
 * PLAN-0628 M1: the read/delete side of the definition library.
 *
 * <p>Exists so the controllers hold no repository (an architecture rule, and a good one: a
 * controller that queries the database grows its own authorization logic). Visibility lives here:</p>
 *
 * <ul>
 *   <li>an instance-scope definition is visible to every authenticated caller;</li>
 *   <li>a workspace-scope definition is answered <b>404 SKILL_NOT_FOUND</b> — never 403 — to a caller
 *       who cannot see that workspace, because the difference between the two codes is itself an
 *       existence oracle. Read surfaces say "does not exist" rather than "not allowed";</li>
 *   <li>listing a workspace library the caller is not a member of returns an <b>empty set</b> for
 *       the same reason.</li>
 * </ul>
 */
@Service
public class SkillLibraryService {

    public static final String SKILL_NOT_FOUND = "SKILL_NOT_FOUND";
    public static final String SKILL_IMPORT_FORBIDDEN = "SKILL_IMPORT_FORBIDDEN";

    private final SkillRepository skillRepository;
    private final SkillBindingService bindingService;
    private final SkillAccessGuard guard;

    public SkillLibraryService(SkillRepository skillRepository, SkillBindingService bindingService,
                               SkillAccessGuard guard) {
        this.skillRepository = skillRepository;
        this.bindingService = bindingService;
        this.guard = guard;
    }

    /** Lists one definition scope. A workspace the caller cannot see yields an empty list. */
    public List<Skill> list(String definitionScopeType, UUID workspaceId) {
        guard.requireActor();
        if (Skill.DEFINITION_SCOPE_INSTANCE.equals(definitionScopeType)) {
            return skillRepository.findByDefinitionScope(Skill.DEFINITION_SCOPE_INSTANCE, null);
        }
        if (!Skill.DEFINITION_SCOPE_WORKSPACE.equals(definitionScopeType)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "definitionScope must be instance or workspace");
        }
        if (workspaceId == null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "workspaceId is required for a workspace listing");
        }
        return guard.canSeeWorkspace(workspaceId)
                ? skillRepository.findByDefinitionScope(Skill.DEFINITION_SCOPE_WORKSPACE, workspaceId)
                : List.of();
    }

    /** Reads one definition, or refuses with 404 without revealing that an invisible one exists. */
    public Skill require(UUID skillId) {
        guard.requireActor();
        Skill skill = skillRepository.findById(skillId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, SKILL_NOT_FOUND,
                        "skill not found"));
        boolean visible = Skill.DEFINITION_SCOPE_INSTANCE.equals(skill.getDefinitionScopeType())
                || guard.canSeeWorkspace(skill.getDefinitionScopeId());
        if (!visible) {
            throw new CpApiException(HttpStatus.NOT_FOUND, SKILL_NOT_FOUND, "skill not found");
        }
        return skill;
    }

    /** The bindings of one definition (caller must be able to see the definition itself). */
    public List<SkillBinding> bindingsOf(UUID skillId) {
        return bindingService.listForSkill(require(skillId).getId());
    }

    /**
     * Deletes a definition; its bindings cascade (V101 {@code ON DELETE CASCADE}) — being bound is
     * not an obstacle, the bindings are the subject of the change.
     */
    @Transactional
    public void delete(UUID skillId) {
        Skill skill = require(skillId);
        if (!guard.canWriteDefinitionScope(skill.getDefinitionScopeType(),
                skill.getDefinitionScopeId())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, SKILL_IMPORT_FORBIDDEN,
                    "you may not delete from this skill library");
        }
        skillRepository.delete(skill);
    }
}
