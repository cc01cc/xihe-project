package com.cc01cc.p.xihe.cp.repository;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;

import java.util.UUID;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import jakarta.persistence.LockModeType;
import com.cc01cc.p.xihe.cp.entity.User;

import java.util.Optional;

/**
 * PLAN-0581 adds {@link JpaSpecificationExecutor}: the admin list endpoint takes optional
 * filters ({@code q}/{@code status}/{@code includeDeleted}/paging) and a Specification keeps the
 * null-combinations out of JPQL string concatenation.
 *
 * <p>PLAN-0610 W4a: the {@code users.role} counters are gone — the instance tier is a role binding,
 * so "how many usable administrators are left" is a binding query
 * ({@code GrantDefaultService#countActiveInstanceAdmins}).</p>
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

}
