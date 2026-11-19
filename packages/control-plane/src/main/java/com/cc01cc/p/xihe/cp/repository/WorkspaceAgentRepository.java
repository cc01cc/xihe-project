package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface WorkspaceAgentRepository extends JpaRepository<WorkspaceAgent, WorkspaceAgentId> {
    List<WorkspaceAgent> findByIdWorkspaceId(UUID workspaceId);

    List<WorkspaceAgent> findByIdPrincipalId(UUID principalId);

    /**
     * task-106: the workspace-scoped default agent of new sessions, if one is configured. The
     * partial unique index {@code ux_workspace_agents_default} (V177) makes at most one row true.
     */
    Optional<WorkspaceAgent> findByIdWorkspaceIdAndIsDefaultTrue(UUID workspaceId);

    /**
     * task-106: row lock for the default-flag writers, so a concurrent {@code PUT /default} and
     * {@code DELETE /default} serialize on the same binding (the partial unique index would
     * otherwise surface as a raw constraint violation instead of a deterministic outcome).
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select b from WorkspaceAgent b where b.id = :id")
    Optional<WorkspaceAgent> findByIdForUpdate(@Param("id") WorkspaceAgentId id);

    /**
     * task-106: switch the current default off <b>before</b> the next one on. Two entity updates
     * cannot be ordered inside one flush, and {@code ux_workspace_agents_default} rejects any
     * intermediate state that holds two true rows — so the switch runs as these two statements.
     * {@code clearAutomatically} is needed because the caller may hold the binding as a managed
     * entity whose {@code isDefault} flag the bulk update bypasses.
     */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("update WorkspaceAgent b set b.isDefault = false "
            + "where b.id.workspaceId = :workspaceId and b.isDefault = true")
    int clearDefault(@Param("workspaceId") UUID workspaceId);

    /** task-106: promote one binding to the workspace default (always after {@link #clearDefault}). */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("update WorkspaceAgent b set b.isDefault = true "
            + "where b.id.workspaceId = :workspaceId and b.id.principalId = :principalId")
    int markDefault(@Param("workspaceId") UUID workspaceId, @Param("principalId") UUID principalId);
}
