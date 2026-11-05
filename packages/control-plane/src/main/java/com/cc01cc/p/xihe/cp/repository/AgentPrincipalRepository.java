package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import jakarta.persistence.LockModeType;

import java.util.List;
import java.util.UUID;

public interface AgentPrincipalRepository extends JpaRepository<AgentPrincipal, UUID> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @org.springframework.data.jpa.repository.Query("select p from AgentPrincipal p where p.id = :id")
    java.util.Optional<AgentPrincipal> findByIdForUpdate(
            @org.springframework.data.repository.query.Param("id") UUID id);

    /** PLAN-0622 M1.2: PERSONAL principals are only ever listed for their owner (O5). */
    List<AgentPrincipal> findByScopeAndOwnerUserId(String scope, UUID ownerUserId);

    /** PLAN-0622 M1.2: INSTANCE principals are visible instance-wide. */
    List<AgentPrincipal> findByScope(String scope);
}
