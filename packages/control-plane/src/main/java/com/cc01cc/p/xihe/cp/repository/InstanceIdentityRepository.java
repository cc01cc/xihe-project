package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.InstanceIdentity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/**
 * D-935 / PLAN-0767 M1: the singleton row. There is deliberately no delete/save API: the row is
 * immutable after the first boot (V154 + {@code InstanceIdentityService.ensureSeeded}).
 */
public interface InstanceIdentityRepository extends JpaRepository<InstanceIdentity, Short> {

    /**
     * Idempotent first-row insert. {@code INSERT ... WHERE NOT EXISTS} keeps a restart a no-op;
     * under a concurrent double start the second writer loses on {@code pk_instance_identity} and
     * the caller re-reads the winner instead of assuming it inserted the row.
     */
    @Modifying
    @Query(value = "INSERT INTO instance_identity (id, instance_id, created_at, updated_at) "
            + "SELECT 1, CAST(:instanceId AS UUID), NOW(), NOW() "
            + "WHERE NOT EXISTS (SELECT 1 FROM instance_identity WHERE id = 1)",
            nativeQuery = true)
    int insertIfAbsent(@Param("instanceId") String instanceId);

    /**
     * Backfill for the pre-M1 sentinel rows: INSTANCE connections used to carry
     * {@code owner_id = 'instance'}; they must point at the deployment identity instead. Idempotent
     * and safe on every boot (only sentinel rows are touched).
     */
    @Modifying
    @Query(value = "UPDATE provider_connections SET owner_id = :ownerId "
            + "WHERE owner_type = 'INSTANCE' AND owner_id = 'instance'", nativeQuery = true)
    int backfillInstanceConnectionOwner(@Param("ownerId") String ownerId);

    @Query(value = "SELECT COUNT(*) FROM provider_connections "
            + "WHERE owner_type = 'INSTANCE' AND owner_id = 'instance'", nativeQuery = true)
    long countSentinelInstanceConnections();
}
