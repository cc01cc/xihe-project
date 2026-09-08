package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.WorkspaceSnapshot;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.UUID;

public interface WorkspaceSnapshotRepository extends JpaRepository<WorkspaceSnapshot, UUID> {

    List<WorkspaceSnapshot> findByWorkspaceIdAndState(UUID workspaceId, String state);

    List<WorkspaceSnapshot> findByOperationId(UUID operationId);

    @Modifying
    @Transactional
    @Query("update WorkspaceSnapshot s set s.state = :newState "
            + "where s.id = :id and s.state in :expectedStates")
    int transitionState(@Param("id") UUID id,
            @Param("expectedStates") Collection<String> expectedStates,
            @Param("newState") String newState);
}
