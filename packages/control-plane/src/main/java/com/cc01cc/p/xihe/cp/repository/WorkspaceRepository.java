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

    @Query("select w from Workspace w join WorkspaceUser wu on wu.id.workspaceId = w.id "
            + "where wu.id.userId = :userId and w.deletedAt is null order by w.createdAt asc")
    List<Workspace> findActiveByMemberUserId(@Param("userId") UUID userId);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select w from Workspace w where w.id = :id and w.deletedAt is null")
    Optional<Workspace> findByIdForUpdate(@Param("id") UUID id);
}
