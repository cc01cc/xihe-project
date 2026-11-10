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

    /**
     * PLAN-0750 M2 (G13=(a)): the personal view filters on the audit creator — user-level
     * principals carry no {@code owner_user_id} (G2=(b) keeps the column NULL on create), so
     * the creator's list visibility rides on {@code created_by_user_id}. The column is a
     * {@code uuid} behind {@code UuidStringConverter}, so plain equality (no {@code IgnoreCase}
     * — it would emit {@code lower(uuid)} and fail on Postgres) binds as a uuid and keeps the
     * V42 index usable. Visibility only — authorization is still atoms + bindings.
     */
    List<AgentPrincipal> findByCreatedByUserId(String createdByUserId);
}
