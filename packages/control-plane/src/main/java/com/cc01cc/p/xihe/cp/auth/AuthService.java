package com.cc01cc.p.xihe.cp.auth;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;

import java.util.UUID;

/**
 * PLAN-0470 #25: Auth is the base identity/token layer. Default-Workspace
 * orchestration moved to the entry layer ({@link AuthController}); this
 * service only authenticates, persists its own user rows, and issues tokens
 * for a workspaceId supplied by the caller.
 */
@Service
public class AuthService {

    private static final Logger logger = LoggerFactory.getLogger(AuthService.class);

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final JwtTokenProvider jwtTokenProvider;
    private final GrantDefaultService grantDefaultService;

    public AuthService(UserRepository userRepository, PasswordEncoder passwordEncoder,
                       JwtTokenProvider jwtTokenProvider, GrantDefaultService grantDefaultService) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.jwtTokenProvider = jwtTokenProvider;
        this.grantDefaultService = grantDefaultService;
    }

    /** Creates the user row and its default grants; returns the persisted user. */
    @Transactional
    public User registerUser(RegisterRequest request) {
        if (userRepository.existsByEmail(request.getEmail())) {
            throw new IllegalArgumentException("Email already registered");
        }

        User user = new User(
                request.getEmail(),
                passwordEncoder.encode(request.getPassword()),
                UserRole.USER,
                request.getName() != null ? request.getName() : request.getEmail().split("@")[0]
        );
        user = userRepository.save(user);
        grantDefaultService.ensureUserDefault(user);

        logger.info("User registered: id={} email={}", user.getId(), user.getEmail());
        return user;
    }

    /** Verifies credentials; returns the authenticated user without side effects. */
    public User authenticate(LoginRequest request) {
        User user = userRepository.findByEmail(request.getEmail())
                .orElseThrow(() -> new IllegalArgumentException("Invalid email or password"));

        if (!passwordEncoder.matches(request.getPassword(), user.getPasswordHash())) {
            throw new IllegalArgumentException("Invalid email or password");
        }

        logger.info("User logged in: id={} email={}", user.getId(), user.getEmail());
        return user;
    }

    /** Validates the refresh token and resolves its user; no token rotation here. */
    public User verifyRefresh(String refreshToken) {
        if (!jwtTokenProvider.validateRefreshToken(refreshToken)) {
            throw new IllegalArgumentException("Invalid or expired refresh token");
        }

        String userId = jwtTokenProvider.getUserIdFromRefreshToken(refreshToken);
        return userRepository.findById(UUID.fromString(userId))
                .orElseThrow(() -> new IllegalArgumentException("User not found"));
    }

    /** Pure token issuance for a caller-resolved workspace; no Workspace reads. */
    public AuthResponse issueTokens(User user, String workspaceId) {
        String accessToken = jwtTokenProvider.createAccessToken(
                user.getId().toString(), user.getEmail(), user.getRole().name(), workspaceId);
        String refreshToken = jwtTokenProvider.createRefreshToken(user.getId().toString());

        return new AuthResponse(accessToken, refreshToken, 900,
                UserResponse.from(user), workspaceId);
    }

    /**
     * PLAN-0470 #25/D2a: the narrow User-row lock operation for the default
     * Workspace bootstrap. Serializes concurrent first-login/register races for
     * the same account; the lock is held until the caller's transaction ends.
     */
    @Transactional
    public void lockAndConfirmUserExists(String userId) {
        userRepository.findByIdForUpdate(UUID.fromString(userId))
                .orElseThrow(() -> new CpApiException(
                        org.springframework.http.HttpStatus.NOT_FOUND, "USER_NOT_FOUND", "User not found"));
    }

    /** PLAN-0470 #22: narrow existence probe; callers keep their own error text. */
    public boolean userExists(UUID userId) {
        return userRepository.existsById(userId);
    }

    public UserResponse getCurrentUser(String userId) {
        User user = userRepository.findById(UUID.fromString(userId))
                .orElseThrow(() -> new IllegalArgumentException("User not found"));
        return UserResponse.from(user);
    }
}
