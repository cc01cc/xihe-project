package com.cc01cc.p.xihe.cp.repository;

import java.util.Optional;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.UUID;

import jakarta.persistence.LockModeType;

import com.cc01cc.p.xihe.cp.entity.OAuthCredential;

public interface OAuthCredentialRepository extends JpaRepository<OAuthCredential, UUID> {

    Optional<OAuthCredential> findByUserIdAndWorkspaceIdAndServerId(
            String userId, String workspaceId, String serverId);

    /**
     * PLAN-0349 decision #7: row lock for refresh rotation and revocation so
     * that concurrent refreshes serialize on the credential row instead of
     * consuming the same refresh token twice (RMO-1). Callers must run inside
     * a transaction that applied {@code DbLockTimeout} first.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select c from OAuthCredential c where c.userId = :userId "
            + "and c.workspaceId = :workspaceId and c.serverId = :serverId")
    Optional<OAuthCredential> findForUpdate(@Param("userId") String userId,
                                            @Param("workspaceId") String workspaceId,
                                            @Param("serverId") String serverId);
}
