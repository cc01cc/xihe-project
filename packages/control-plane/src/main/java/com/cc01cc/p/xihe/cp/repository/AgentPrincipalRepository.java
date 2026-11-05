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

    /** Existing owner associations remain authoritative after removing principal tiers. */
    List<AgentPrincipal> findByOwnerUserId(UUID ownerUserId);
}
