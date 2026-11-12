package com.cc01cc.p.xihe.cp.skill;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0628 M1 (V101): skill definitions.
 *
 * <p><b>Why every scope-bearing finder is hand-written:</b> the instance tier stores
 * {@code definition_scope_id = NULL}, and a Spring Data derived query renders that as
 * {@code scope_id = null}, which matches nothing in SQL. The null-safe form below is the only
 * correct spelling of "the instance row with this name".</p>
 */
@Repository
public interface SkillRepository extends JpaRepository<Skill, UUID> {

    /** The qualified identity of a definition: (name, scope type, scope id|null). */
    @Query("select s from Skill s where s.name = :name and s.definitionScopeType = :scopeType "
            + "and ((:scopeId is null and s.definitionScopeId is null) "
            + "or s.definitionScopeId = :scopeId)")
    Optional<Skill> findQualified(@Param("name") String name,
                                  @Param("scopeType") String scopeType,
                                  @Param("scopeId") UUID scopeId);

    /**
     * The qualified identity of a <b>personal</b> definition (V156): its owner is stored in the
     * separate {@code definition_scope_user_id} column, so it is a different query rather than a
     * bigger one — {@code definition_scope_id} keeps its foreign key to {@code workspaces} and must
     * stay NULL here.
     */
    @Query("select s from Skill s where s.name = :name "
            + "and s.definitionScopeType = 'user' and s.definitionScopeUserId = :ownerUserId")
    Optional<Skill> findQualifiedPersonal(@Param("name") String name,
                                          @Param("ownerUserId") UUID ownerUserId);

    /** Library listing (D28-17 v1 import is manual; the CLI lists what was imported). */
    @Query("select s from Skill s where s.definitionScopeType = :scopeType "
            + "and ((:scopeId is null and s.definitionScopeId is null) "
            + "or s.definitionScopeId = :scopeId) order by s.name, s.id")
    List<Skill> findByDefinitionScope(@Param("scopeType") String scopeType,
                                      @Param("scopeId") UUID scopeId);

    /** The caller's own personal library (never another owner's rows). */
    @Query("select s from Skill s where s.definitionScopeType = 'user' "
            + "and s.definitionScopeUserId = :ownerUserId order by s.name, s.id")
    List<Skill> findByPersonalScope(@Param("ownerUserId") UUID ownerUserId);
}
