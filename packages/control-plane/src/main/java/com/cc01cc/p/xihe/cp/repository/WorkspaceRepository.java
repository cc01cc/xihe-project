package com.cc01cc.p.xihe.cp.repository;

import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import com.cc01cc.p.xihe.cp.entity.Workspace;

import java.util.List;
import java.util.Optional;

public interface WorkspaceRepository extends JpaRepository<Workspace, UUID> {
    List<Workspace> findByOwnerIdAndDeletedAtIsNullOrderByCreatedAtAsc(String ownerId);

    Optional<Workspace> findByIdAndDeletedAtIsNull(UUID id);

    Optional<Workspace> findByOwnerIdAndCreateIdempotencyKeyAndDeletedAtIsNull(
            String ownerId, String createIdempotencyKey);

    /**
     * PLAN-0610 W3-3: the membership fact is the workspace-scope role binding now, so the
     * "workspaces I belong to" list reads {@code role_bindings} instead of the legacy
     * {@code workspace_users} join. A membership granted through {@code PUT /api/v1/bindings}
     * therefore shows up immediately; through the old join it would only appear after the
     * transitional mirror ran (and {@code workspace_users} is dropped in V89).
     */
    @Query("select w from Workspace w where w.deletedAt is null and exists ("
            + "select 1 from AccessRoleBinding b where b.subjectType = 'user'"
            + " and b.subjectId = :userId and b.scopeType = 'workspace' and b.scopeId = w.id)"
            + " order by w.createdAt asc")
    List<Workspace> findActiveByMemberBinding(@Param("userId") UUID userId);

    /** Legacy {@code workspace_users} join; kept only for the transition window (V89 drops it). */
    @Query("select w from Workspace w join WorkspaceUser wu on wu.id.workspaceId = w.id "
            + "where wu.id.userId = :userId and w.deletedAt is null order by w.createdAt asc")
    List<Workspace> findActiveByMemberUserId(@Param("userId") UUID userId);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select w from Workspace w where w.id = :id and w.deletedAt is null")
    Optional<Workspace> findByIdForUpdate(@Param("id") UUID id);
}
