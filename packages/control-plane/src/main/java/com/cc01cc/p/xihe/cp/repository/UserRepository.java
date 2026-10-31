package com.cc01cc.p.xihe.cp.repository;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;

import java.util.UUID;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import jakarta.persistence.LockModeType;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.UserStatus;

import java.util.Optional;

/**
 * PLAN-0581 adds {@link JpaSpecificationExecutor}: the admin list endpoint takes
 * five optional filters ({@code q}/{@code role}/{@code status}/{@code
 * includeDeleted}/paging) and a Specification keeps the null-combinations out of
 * JPQL string concatenation.
 */
public interface UserRepository extends JpaRepository<User, UUID>, JpaSpecificationExecutor<User> {
    Optional<User> findByEmail(String email);
    boolean existsByEmail(String email);

    /** PLAN-0565 ruling #7: username is a unique account handle (login + member lookup). */
    Optional<User> findByUsername(String username);
    boolean existsByUsername(String username);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select u from User u where u.id = :id")
    Optional<User> findByIdForUpdate(UUID id);

    /**
     * PLAN-0580 I2 (as amended by PLAN-0581): the last-admin guard must count only
     * <b>usable</b> ADMINs. A DISABLED or soft-deleted ADMIN cannot log in, so it
     * must not act as the instance's remaining administrator — otherwise disabling
     * one ADMIN and demoting the other leaves zero usable admins.
     */
    long countByRoleAndStatusAndDeletedAtIsNull(UserRole role, UserStatus status);

    /** PLAN-0580 I2 (pre-0581 semantics), kept for callers that count every row. */
    long countByRole(UserRole role);
}
