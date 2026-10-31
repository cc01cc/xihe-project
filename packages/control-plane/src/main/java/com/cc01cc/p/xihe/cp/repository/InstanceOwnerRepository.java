package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.InstanceOwner;
import jakarta.persistence.LockModeType;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;

/**
 * PLAN-0580: the instance-level mutex.
 *
 * <p>{@link #lockSingleton()} takes {@code SELECT … FOR UPDATE} on the single
 * row, which is the fixed first lock of every instance-level write
 * (spec §8 锁序: {@code instance_owner} → target {@code users} row). The
 * caller must have applied {@code DbLockTimeout.apply()} first so the wait is
 * bounded and surfaces as 503 {@code OPERATION_LOCK_TIMEOUT}.
 */
public interface InstanceOwnerRepository extends JpaRepository<InstanceOwner, Short> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select o from InstanceOwner o where o.id = 1")
    Optional<InstanceOwner> lockSingleton();
}
