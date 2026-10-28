package com.cc01cc.p.xihe.cp.repository;

import org.springframework.data.jpa.repository.JpaRepository;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUserId;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.UUID;
import java.util.Optional;

public interface WorkspaceUserRepository extends JpaRepository<WorkspaceUser, WorkspaceUserId> {
    List<WorkspaceUser> findByIdWorkspaceId(UUID workspaceId);
    List<WorkspaceUser> findByIdUserId(UUID userId);
    Optional<WorkspaceUser> findByIdWorkspaceIdAndIdUserId(UUID workspaceId, UUID userId);
    long countByIdWorkspaceIdAndRole(UUID workspaceId, WorkspaceRole role);

    /** PLAN-0565: member rows joined with user identity for the member list view. */
    @Query("select wu.id.userId, u.username, u.email, u.name, wu.role, wu.createdAt "
            + "from WorkspaceUser wu join User u on u.id = wu.id.userId "
            + "where wu.id.workspaceId = :workspaceId "
            + "order by wu.createdAt asc, u.username asc")
    List<Object[]> findMemberRows(@Param("workspaceId") UUID workspaceId);
}
