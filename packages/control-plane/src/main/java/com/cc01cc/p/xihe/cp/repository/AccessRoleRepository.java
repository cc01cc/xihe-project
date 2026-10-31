package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.AccessRole;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface AccessRoleRepository extends JpaRepository<AccessRole, UUID> {

    Optional<AccessRole> findByName(String name);

    List<AccessRole> findByNameIn(Collection<String> names);

    boolean existsByName(String name);

    /**
     * PLAN-0610 W3-2a: serializes two edits of the same role definition. Follows the instance
     * mutex lock ({@code instance_owner}) in the role write path, and precedes the materializer's
     * {@code users} row locks.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select r from AccessRole r where r.id = :roleId")
    Optional<AccessRole> findByIdForUpdate(@Param("roleId") UUID roleId);
}
