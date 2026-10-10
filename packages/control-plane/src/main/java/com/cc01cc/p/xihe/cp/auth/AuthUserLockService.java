package com.cc01cc.p.xihe.cp.auth;

import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0470 (T3.2): the auth-domain User row-lock seam. Holds the User row
 * lock inside the caller's transaction (Policy default-grant idempotency)
 * and returns the locked row so the caller can read its role.
 *
 * <p>Purpose-built leaf so {@code GrantDefaultService} can serialize concurrent
 * default-grant creation for the same User without injecting {@code UserRepository}
 * directly or depending on the heavyweight {@code AuthService} (which already
 * depends on {@code GrantDefaultService.ensureUserDefault} — reusing it would form a
 * constructor cycle). The User canonical writer stays inside the auth domain.</p>
 */
@Service
public class AuthUserLockService {

    private final UserRepository userRepository;

    public AuthUserLockService(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    /**
     * Acquire {@code SELECT ... FOR UPDATE} on the User row and return it so the
     * caller can read the role within the same transaction. Empty when absent.
     */
    @Transactional
    public Optional<User> lockAndFind(UUID userId) {
        return userRepository.findByIdForUpdate(userId);
    }
}
