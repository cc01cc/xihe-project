package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.GrantPresetBinding;
import com.cc01cc.p.xihe.cp.entity.UserStatus;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Collection;
import java.util.List;
import java.util.UUID;

public interface GrantPresetBindingRepository extends JpaRepository<GrantPresetBinding, UUID> {

    List<GrantPresetBinding> findBySubjectTypeAndSubjectId(String subjectType, UUID subjectId);

    List<GrantPresetBinding> findBySubjectTypeAndSubjectIdAndScopeType(String subjectType, UUID subjectId,
                                                                     String scopeType);

    /** PLAN-0610 W3-2a: the instance-scope binding set of the admin API. */
    List<GrantPresetBinding> findBySubjectTypeAndScopeType(String subjectType, String scopeType);

    /** PLAN-0610 W3-2a: the workspace-scope binding set of one workspace. */
    List<GrantPresetBinding> findBySubjectTypeAndScopeTypeAndScopeId(String subjectType,
                                                                   String scopeType, UUID scopeId);

    /**
     * task-58: single-row existence probe of one subject's binding inside one scope.
     *
     * <p>Replaces the "load every binding of this workspace, then {@code contains(principalId)}"
     * pattern at the workspace-reach gate: that form materialised every
     * {@code agent_principal} binding of the workspace (O(all bindings of the instance)) to answer
     * a yes/no question, and the table has no index leading with {@code scope_type/scope_id}, so
     * the planner could only use {@code idx_grant_preset_bindings_subject(subject_type, subject_id)} as an
     * equality prefix and discard the rest with a filter (measured: {@code rows=80},
     * {@code Rows Removed by Filter: 79}). The exists form is answered by the same index with a
     * 1-row table lookup and no collection allocation.
     */
    boolean existsBySubjectTypeAndSubjectIdAndScopeTypeAndScopeId(String subjectType, UUID subjectId,
                                                                 String scopeType, UUID scopeId);

    List<GrantPresetBinding> findByRoleId(UUID roleId);

    long countByRoleId(UUID roleId);

    List<GrantPresetBinding> findByRoleIdIn(Collection<UUID> roleIds);

    /**
     * PLAN-0610 W1c (round-3 P1-3): how many <b>usable</b> user subjects hold this role at instance
     * scope.
     *
     * <p>The bootstrap seeder may only mint a {@code SUPER_ADMIN} binding while this count is zero.
     * Otherwise a restart after an operator moved the account to a lower tier resurrects the
     * privilege, and a transferred owner keeps a permanent second super administrator. DISABLED and
     * soft-deleted rows are excluded: such an account can never log in, so counting it would claim
     * "someone usable is still super admin" for an unusable row.</p>
     */
    @Query("select count(b) from GrantPresetBinding b join User u on u.id = b.subjectId "
            + "where b.roleId = :roleId and b.scopeType = 'instance' "
            + "and b.subjectType = 'user' and u.status = :status and u.deletedAt is null")
    long countActiveUserBindingsForRole(@Param("roleId") UUID roleId,
                                        @Param("status") UserStatus status);

    /**
     * PLAN-0610 W4a: how many usable accounts hold one of these instance roles. Replaces the
     * {@code users.role} counter the last-admin guard used before the column stopped being mapped.
     */
    @Query("select count(distinct b.subjectId) from GrantPresetBinding b join User u "
            + "on u.id = b.subjectId where b.subjectType = 'user' and b.scopeType = 'instance' "
            + "and b.roleId in :roleIds and u.status = :status and u.deletedAt is null")
    long countActiveUsersWithInstanceRoles(@Param("roleIds") java.util.Collection<UUID> roleIds,
                                           @Param("status") UserStatus status);

    /**
     * PLAN-0610 W3-3: how many usable user subjects hold this role in <b>one workspace</b>. The
     * workspace-scope full-set replacement uses it for the {@code 409 LAST_OWNER} guard, so the
     * binding API cannot leave a workspace without an owner (the member API already refuses to
     * remove or downgrade the last owner through {@code WorkspaceMemberService}).
     */
    @Query("select count(b) from GrantPresetBinding b join User u on u.id = b.subjectId "
            + "where b.roleId = :roleId and b.scopeType = 'workspace' and b.scopeId = :scopeId "
            + "and b.subjectType = 'user' and u.status = :status and u.deletedAt is null")
    long countActiveUserBindingsForRoleInWorkspace(@Param("roleId") UUID roleId,
                                                   @Param("scopeId") UUID scopeId,
                                                   @Param("status") UserStatus status);

    @Modifying
    @Query("delete from GrantPresetBinding b where b.subjectType = :subjectType and b.subjectId = :subjectId")
    void deleteBySubject(@Param("subjectType") String subjectType, @Param("subjectId") UUID subjectId);

    @Modifying
    @Query("delete from GrantPresetBinding b where b.roleId = :roleId")
    void deleteByRoleId(@Param("roleId") UUID roleId);
}
