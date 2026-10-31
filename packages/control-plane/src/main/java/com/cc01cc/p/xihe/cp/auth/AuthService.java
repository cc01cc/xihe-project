package com.cc01cc.p.xihe.cp.auth;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.http.HttpStatus;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;

import java.util.List;
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
    private final String dummyPasswordHash;

    public AuthService(UserRepository userRepository, PasswordEncoder passwordEncoder,
                       JwtTokenProvider jwtTokenProvider, GrantDefaultService grantDefaultService) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.jwtTokenProvider = jwtTokenProvider;
        this.grantDefaultService = grantDefaultService;
        // PLAN-0558: unknown accounts must cost one BCrypt verification too, so
        // response timing cannot distinguish "no such user" from a wrong password.
        this.dummyPasswordHash = passwordEncoder.encode(UUID.randomUUID().toString());
    }

    /** Creates the user row and its default grants; returns the persisted user. */
    @Transactional
    public User registerUser(RegisterRequest request) {
        return registerUser(request, false);
    }

    /**
     * Creates the user row and its default grants; returns the persisted user.
     * PLAN-0526: local single-user registration grants the ADMIN role so the
     * single-machine user has full capability.
     * PLAN-0565 ruling #7: username is required and unique (letter-first);
     * a caller-supplied value is validated (400 USERNAME_INVALID / 409
     * USERNAME_TAKEN), a blank one is derived from the email local part with
     * automatic numeric de-duplication.
     */
    @Transactional
    public User registerUser(RegisterRequest request, boolean adminRole) {
        if (userRepository.existsByEmail(request.getEmail())) {
            throw new IllegalArgumentException("Email already registered");
        }

        String username = resolveUsername(request.getUsername(), request.getEmail());
        User user = new User(
                request.getEmail(),
                passwordEncoder.encode(request.getPassword()),
                adminRole ? UserRole.ADMIN : UserRole.USER,
                request.getName() != null ? request.getName() : request.getEmail().split("@")[0],
                username
        );
        user = userRepository.save(user);
        grantDefaultService.ensureUserDefault(user);

        logger.info("User registered: id={} email={} username={} role={}", user.getId(),
                AuthLog.maskEmail(user.getEmail()), user.getUsername(), user.getRole());
        return user;
    }

    /** PLAN-0565 ruling #7: explicit usernames are validated; blank ones are derived. */
    private String resolveUsername(String requested, String email) {
        if (requested != null && !requested.isBlank()) {
            String candidate = requested.trim();
            if (!candidate.matches("^[a-z][a-z0-9]{0,31}$")) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "USERNAME_INVALID",
                        "Username must be 1-32 lowercase letters/digits and start with a letter");
            }
            if (userRepository.existsByUsername(candidate)) {
                throw new CpApiException(HttpStatus.CONFLICT, "USERNAME_TAKEN",
                        "Username already taken");
            }
            return candidate;
        }

        String base = User.defaultUsernameFromEmail(email);
        String candidate = base;
        int n = 1;
        while (userRepository.existsByUsername(candidate)) {
            n++;
            String suffix = Integer.toString(n);
            candidate = base.length() + suffix.length() > 32
                    ? base.substring(0, 32 - suffix.length()) + suffix
                    : base + suffix;
        }
        return candidate;
    }

    /**
     * Verifies credentials; returns the authenticated user without side effects.
     * PLAN-0558: unknown accounts still perform one BCrypt match (dummy hash),
     * and the failure type is credential-only so callers can count it for lockout
     * without catching workspace/token failures by mistake.
     * PLAN-0565 ruling #7: identifier matches email (contains '@') or username.
     */
    public User authenticate(LoginRequest request) {
        String identifier = request.getIdentifier();
        User user = (identifier != null && identifier.contains("@")
                ? userRepository.findByEmail(identifier)
                : userRepository.findByUsername(identifier))
                .orElse(null);
        if (user == null) {
            passwordEncoder.matches(request.getPassword(), dummyPasswordHash);
            throw new InvalidCredentialsException("Invalid email or password");
        }

        if (!passwordEncoder.matches(request.getPassword(), user.getPasswordHash())) {
            throw new InvalidCredentialsException("Invalid email or password");
        }

        logger.info("User logged in: id={} email={}", user.getId(), AuthLog.maskEmail(user.getEmail()));
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
        // PLAN-0580: the access token stamps the current epoch; a role change bumps
        // users.token_version so this token stops authenticating on its next use.
        String accessToken = jwtTokenProvider.createAccessToken(
                user.getId().toString(), user.getEmail(), user.getRole().name(), user.getTokenVersion());
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

    /** PLAN-0526: whether the instance has any user (onboarding bootstrap signal). */
    public boolean hasAnyUser() {
        return userRepository.count() > 0;
    }

    /**
     * PLAN-0526 I2: resolve the single login-able user for local mode. Any role
     * (including ADMIN) is allowed; only a count other than exactly one is
     * rejected, so local mode never guesses a target.
     */
    @Transactional(readOnly = true)
    public User requireSingleUser() {
        List<User> users = userRepository.findAll();
        if (users.size() != 1) {
            throw new CpApiException(HttpStatus.CONFLICT, "LOCAL_SINGLE_USER_REQUIRED",
                    "Local mode requires exactly one user");
        }
        return users.get(0);
    }

    /** PLAN-0526: local-mode password reset (loopback-gated by the caller). */
    @Transactional
    public void resetPassword(User user, String rawPassword) {
        user.setPasswordHash(passwordEncoder.encode(rawPassword));
        userRepository.save(user);
        logger.info("Local-mode password reset: id={} email={}", user.getId(),
                AuthLog.maskEmail(user.getEmail()));
    }

    /**
     * PLAN-0497 T3.1 (0497 design §方案 3, decision #3): the step-up primitive —
     * re-verifies the caller's login password against the stored hash without
     * issuing tokens or writing login audit. Callers own throttling and audit.
     */
    public boolean verifyPassword(UUID userId, String rawPassword) {
        if (rawPassword == null || rawPassword.isBlank()) {
            return false;
        }
        return userRepository.findById(userId)
                .map(user -> passwordEncoder.matches(rawPassword, user.getPasswordHash()))
                .orElse(false);
    }

    public UserResponse getCurrentUser(String userId) {
        User user = userRepository.findById(UUID.fromString(userId))
                .orElseThrow(() -> new IllegalArgumentException("User not found"));
        return UserResponse.from(user);
    }
}
