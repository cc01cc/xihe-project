package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface AgentPrincipalRepository extends JpaRepository<AgentPrincipal, UUID> {

    /** Existing owner associations remain authoritative after removing principal tiers. */
    List<AgentPrincipal> findByOwnerUserId(UUID ownerUserId);
}