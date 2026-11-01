package com.cc01cc.p.xihe.cp.auth;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;

import java.security.SecureRandom;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;


/**
 * PLAN-0470 #25: the auth entry orchestrates identity and default-Workspace
 * bootstrap. Register/login/refresh resolve or create the default Workspace
 * here (same transaction as user creation on register, so a Workspace failure
 * still rolls the registration back), then hand the resolved workspaceId to
 * {@link AuthService#issueTokens}; Auth itself no longer depends on Workspace.
 *
 * <p>PLAN-0526 adds the single-user local-mode entry: a loopback-only
 * {@code bootstrap-status}, {@code local-login} and {@code local-password-reset},
 * plus an optional password on register. All of it is gated by
 * {@link LocalModeService}.
 */
@RestController
    @RequestMapping("/api/v1/auth")
public class AuthController {

    private static final Logger logger = LoggerFactory.getLogger(AuthController.class);
    private static final SecureRandom SECURE_RANDOM = new SecureRandom();

    private final AuthService authService;
    private final WorkspaceService workspaceService;
    private final LocalModeService localModeService;
    private final LoginAttemptService loginAttemptService;
    private final ClientIpResolver clientIpResolver;
    private final TransactionTemplate transactionTemplate;
    private final com.cc01cc.p.xihe.cp.service.InstanceOwnershipService instanceOwnershipService;
    /**
     * PLAN-0610 W1c (round-3 P0-2): the local-mode first account must end the transaction holding
     * the instance-level {@code SUPER_ADMIN} binding (I1/I5), not a plain {@code ADMIN} tier.
     */
    private final com.cc01cc.p.xihe.cp.policy.GrantDefaultService grantDefaultService;
    /** PLAN-0581 §6: bootstrap env switch for public self-registration (default open). */
    private final RegistrationPolicy registrationPolicy;

    public AuthController(AuthService authService, WorkspaceService workspaceService,
                          LocalModeService localModeService,
                          LoginAttemptService loginAttemptService,
                          ClientIpResolver clientIpResolver,
                          com.cc01cc.p.xihe.cp.service.InstanceOwnershipService instanceOwnershipService,
                          com.cc01cc.p.xihe.cp.policy.GrantDefaultService grantDefaultService,
                          RegistrationPolicy registrationPolicy,
                          PlatformTransactionManager transactionManager) {
        this.authService = authService;
        this.workspaceService = workspaceService;
        this.localModeService = localModeService;
        this.loginAttemptService = loginAttemptService;
        this.clientIpResolver = clientIpResolver;
        this.instanceOwnershipService = instanceOwnershipService;
        this.grantDefaultService = grantDefaultService;
        this.registrationPolicy = registrationPolicy;
        this.transactionTemplate = new TransactionTemplate(transactionManager);
    }

    /** PLAN-0526: onboarding signal; always 200, never gated, exposes two booleans only. */
    @GetMapping("/bootstrap-status")
    public ResponseEntity<?> bootstrapStatus() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("initialized", authService.hasAnyUser());
        body.put("localMode", localModeService.enabled());
        return ResponseEntity.ok(body);
    }

    @PostMapping("/register")
    public ResponseEntity<?> register(@Valid @RequestBody RegisterRequest request,
                                      HttpServletRequest httpRequest) {
        try {
            ClientIpResolver.ResolvedClientIp clientIp =
                    clientIpResolver.resolveClientIp(httpRequest);
            loginAttemptService.checkAndRecordRegister(clientIp.raw(), clientIp.bucketKey());
        } catch (LoginThrottledException e) {
            return rateLimited(e);
        }
        // PLAN-0581 §6: the registration policy is evaluated AFTER the 0558 IP
        // throttle (a closed instance still throttles probes instead of handing out
        // an unthrottled 403 oracle) and BEFORE any user row exists. Local
        // single-user mode is exempt — otherwise a fresh instance with
        // XIHE_LOCAL_MODE=true plus a closed policy could never create its first
        // account (I5).
        if (!localModeService.enabled()) {
            registrationPolicy.requireOpen();
        }
        // PLAN-0526: local mode may omit the password (server generates an
        // unmemorized strong one); elsewhere the password stays mandatory (400).
        if (isBlank(request.getPassword())) {
            if (!localModeService.enabled()) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "password is required");
            }
            localModeService.requireLocalAccess(httpRequest);
            request.setPassword(generatePassword());
        }
        try {
            AuthResponse response = transactionTemplate.execute(status -> {
                User user = authService.registerUser(request);
                // PLAN-0580 decision #10: in local single-user mode the first (and
                // only) account is ADMIN, so it also becomes the instance owner in
                // the same transaction. Idempotent: an existing pointer stays.
                if (localModeService.enabled()) {
                    instanceOwnershipService.ensureAssigned(user, user.getId().toString());
                    // PLAN-0610 W1c (round-3 P0-2): the USER tier alone leaves an empty instance with
                    // no SUPER_ADMIN binding, and DataSeeder (the other seed site) returns early in
                    // local mode. Seeding here, in the same transaction and after the owner
                    // assignment (frozen lock order instance_owner → users row), is the only path
                    // that makes I1/I5 true on a fresh local instance. Idempotent and guarded
                    // against privilege resurrection. W4a: this is now the *only* elevation on the
                    // registration path — no role column write exists any more.
                    grantDefaultService.ensureInstanceSuperAdmin(user);
                }
                return withFirstWorkspace(user);
            });
            return ResponseEntity.status(HttpStatus.CREATED).body(response);
        } catch (CpApiException e) {
            throw e;
        } catch (IllegalArgumentException e) {
            logger.warn("Registration failed: {}", e.getMessage());
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Registration failed");
        }
    }

    @PostMapping("/login")
    public ResponseEntity<?> login(@Valid @RequestBody LoginRequest request,
                                   HttpServletRequest httpRequest) {
        String ip = clientIpResolver.resolve(httpRequest);
        LoginAttemptService.Lease lease = null;
        boolean throttled = !localModeService.enabled();
        try {
            if (throttled) {
                // PLAN-0565 ruling #7: the identifier (email or username) keys the lockout lease.
                lease = loginAttemptService.beginLogin(request.getIdentifier(), ip);
                if (!loginAttemptService.tryAcquireBcryptSlot()) {
                    throw new LoginThrottledException(1);
                }
            }
            try {
                User user = authService.authenticate(request);
                loginAttemptService.recordSuccess(lease);
                return ResponseEntity.ok(withFirstWorkspace(user));
            } finally {
                if (throttled) {
                    loginAttemptService.releaseBcryptSlot();
                }
            }
        } catch (LoginThrottledException e) {
            return rateLimited(e);
        } catch (InvalidCredentialsException e) {
            loginAttemptService.recordCredentialFailure(lease);
            // Usernames are public handles (ruling #7); only emails get masked.
            String identifier = request.getIdentifier();
            logger.warn("Login failed for {}: invalid credentials",
                    identifier != null && identifier.contains("@")
                            ? AuthLog.maskEmail(identifier) : identifier);
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_FAILED", "Invalid credentials");
        } catch (CpApiException e) {
            // Preserve domain statuses (for example USER_NOT_FOUND/429) instead of
            // collapsing them into 401 through the generic branch.
            throw e;
        } finally {
            loginAttemptService.release(lease);
        }
    }

    @PostMapping("/refresh")
    public ResponseEntity<?> refresh(@Valid @RequestBody RefreshRequest request,
                                     @RequestHeader(value = "X-Workspace-Id", required = false) String workspaceHeader) {
        try {
            User user = authService.verifyRefresh(request.getRefreshToken());
            // PLAN-0559: the access token is user-level; the optional header only
            // backfills the response workspaceId for clients that still read it.
            String workspaceId = workspaceHeader == null || workspaceHeader.isBlank()
                    ? firstWorkspaceId(user.getId().toString())
                    : workspaceService.requireContextWorkspace(
                            TenantContext.normalizeWorkspaceId(workspaceHeader), user.getId().toString());
            return ResponseEntity.ok(authService.issueTokens(user, workspaceId));
        } catch (CpApiException e) {
            // CpApiException extends IllegalArgumentException; preserve 400/403
            // instead of rewriting them into a 401 below.
            throw e;
        } catch (IllegalArgumentException e) {
            logger.warn("Token refresh failed: {}", e.getMessage());
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_FAILED", "Invalid or expired refresh token");
        }
    }

    /** PLAN-0526: passwordless re-entry for the single local user. */
    @PostMapping("/local-login")
    public ResponseEntity<?> localLogin(HttpServletRequest httpRequest) {
        localModeService.requireLocalAccess(httpRequest);
        User user = authService.requireSingleUser();
        // PLAN-0610 W1c (round-3 P0-2): repair a local instance created before the SUPER_ADMIN seed
        // existed (or whose seed transaction did not include it). Both calls are idempotent and the
        // seed is guarded, so a deliberately downgraded or disabled account is not re-promoted and a
        // login never widens privilege by itself.
        instanceOwnershipService.ensureAssigned(user, user.getId().toString());
        grantDefaultService.ensureInstanceSuperAdmin(user);
        return ResponseEntity.ok(withFirstWorkspace(user));
    }

    /** PLAN-0526: loopback-only password reset (no old password) for lockout recovery. */
    @PostMapping("/local-password-reset")
    public ResponseEntity<?> localPasswordReset(@Valid @RequestBody LocalPasswordResetRequest request,
                                                HttpServletRequest httpRequest) {
        localModeService.requireLocalAccess(httpRequest);
        User user = authService.requireSingleUser();
        authService.resetPassword(user, request.getNewPassword());
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/me")
    public ResponseEntity<?> me(Authentication authentication) {
        if (authentication == null || !authentication.isAuthenticated()) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authorization required");
        }
        String userId = authentication.getName();
        UserResponse response = authService.getCurrentUser(userId);
        return ResponseEntity.ok(response);
    }

    /** PLAN-0558: one 429 shape for account, IP, and concurrency throttles. */
    private static ResponseEntity<Map<String, Object>> rateLimited(LoginThrottledException exception) {
        return ProblemDetailsHandler.problemResponse(HttpStatus.TOO_MANY_REQUESTS,
                "AUTH_RATE_LIMITED", "Too many login attempts; retry later",
                Map.of("Retry-After", Integer.toString(exception.getRetryAfterSeconds()),
                        "Cache-Control", "no-store"),
                null);
    }

    /**
     * PLAN-0614 (blank start, decision #2): the entry-level response carries the account's first
     * active workspace, or {@code null} when the account has none yet.
     *
     * <p>Register/login/local-login/refresh all go through here, so a fresh account can authenticate
     * (201/200) while its first screen is empty; the user then creates the first workspace explicitly.
     * Nothing is created on the auth path any more (that was the BL-171 default workspace).</p>
     */
    private AuthResponse withFirstWorkspace(User user) {
        return authService.issueTokens(user, firstWorkspaceId(user.getId().toString()));
    }

    /** The account's first active workspace id, or {@code null} (read-only, never creates). */
    private String firstWorkspaceId(String userId) {
        return workspaceService.firstActiveWorkspace(userId)
                .map(workspace -> workspace.getId().toString())
                .orElse(null);
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    private static String generatePassword() {
        byte[] bytes = new byte[24];
        SECURE_RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }
}
