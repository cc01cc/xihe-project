package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.AgentLineageInvocation;
import jakarta.persistence.LockModeType;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface AgentLineageInvocationRepository extends JpaRepository<AgentLineageInvocation, UUID> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select i from AgentLineageInvocation i "
            + "where i.lineageId = :lineageId and i.originatingToolCallId = :originatingToolCallId")
    Optional<AgentLineageInvocation> findByIdentityForUpdate(
            @Param("lineageId") UUID lineageId,
            @Param("originatingToolCallId") String originatingToolCallId);

    List<AgentLineageInvocation> findByLineageIdOrderByOriginatingToolCallIdAsc(
            UUID lineageId, Pageable pageable);
}
