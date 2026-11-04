package com.cc01cc.p.xihe.cp.skill;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.UUID;

/**
 * PLAN-0628 M1 (V101): skill bindings.
 *
 * <p>Hand-written queries for the same reason as {@link SkillRepository}: the instance tier's
 * {@code scope_id} is NULL, and {@code scope_id = null} never matches. The duplicate probe has to
 * answer "would {@code uq_skill_bindings NULLS NOT DISTINCT} collide?" without inserting.</p>
 */
@Repository
public interface SkillBindingRepository extends JpaRepository<SkillBinding, UUID> {

    /** Exact-binding probe: the pre-check that turns a unique-key 500 into a 409. */
    @Query("select count(b) from SkillBinding b where b.skillId = :skillId "
            + "and b.subjectType = :subjectType and b.subjectId = :subjectId "
            + "and b.scopeType = :scopeType "
            + "and ((:scopeId is null and b.scopeId is null) or b.scopeId = :scopeId)")
    long countExact(@Param("skillId") UUID skillId,
                    @Param("subjectType") String subjectType,
                    @Param("subjectId") UUID subjectId,
                    @Param("scopeType") String scopeType,
                    @Param("scopeId") UUID scopeId);

    List<SkillBinding> findBySkillIdOrderByCreatedAtAsc(UUID skillId);

    /** PLAN-0667 M2: the agent-principal binding list (nested surface), newest last. */
    List<SkillBinding> findBySubjectTypeAndSubjectIdOrderByCreatedAtAsc(String subjectType,
                                                                       UUID subjectId);

    /**
     * The resolution candidates for one subject (PLAN-0628 §6.2): both identity axes plus the two
     * scopes that can apply, with the cross-workspace definition-leak guard.
     *
     * <p>Ordering is the frozen priority: AGENT before USER, then the narrower (workspace) scope
     * before the instance tier, then name for determinism. Dedupe by {@code skill_id} and the
     * {@code maxSkills + 1} truncation probe happen in {@code SkillCatalogSourceService} (added in
     * the next commit of this wave).</p>
     */
    @Query("select b, s from SkillBinding b join Skill s on s.id = b.skillId "
            + "where ((b.subjectType = 'agent_principal' and b.subjectId = :principalId) "
            + "    or (b.subjectType = 'user' and b.subjectId = :userId)) "
            + "  and (b.scopeType = 'instance' or b.scopeId = :workspaceId) "
            + "  and (s.definitionScopeType = 'instance' or s.definitionScopeId = :workspaceId) "
            + "order by case b.subjectType when 'agent_principal' then 0 else 1 end, "
            + "         case b.scopeType when 'workspace' then 0 else 1 end, "
            + "         s.name, s.id")
    List<Object[]> findResolvable(@Param("principalId") UUID principalId,
                                  @Param("userId") UUID userId,
                                  @Param("workspaceId") UUID workspaceId);
}
