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

import java.util.LinkedHashMap;
import java.util.Map;


/**
 * PLAN-0470 #25: the auth entry orchestrates identity bootstrap. Since
 * PLAN-0614, register/login/refresh never create a Workspace; they resolve the
 * account's first active workspace and hand its id to
 * {@link AuthService#issueTokens} (null when there is none), so Auth itself no
 * longer depends on Workspace.
 *
 * <p>PLAN-0758 (D-787) removes the retired single-user local-mode entry
 * ({@code local-login} / {@code local-password-reset}); {@code bootstrap-status}
 * stays as the onboarding signal and now reports {@code initialized} only.
 */
@RestController
    @RequestMapping("/api/v1/auth")
public class AuthController {

    private static final Logger logger = LoggerFactory.getLogger(AuthController.class);

    private final AuthService authService;
    private final WorkspaceService workspaceService;
    private final LoginAttemptService loginAttemptService;
    private final ClientIpResolver clientIpResolver;
    private final TransactionTemplate transactionTemplate;
    /** PLAN-0581 §6: bootstrap env switch for public self-registration (default open). */
    private final RegistrationPolicy registrationPolicy;

    public AuthController(AuthService authService, WorkspaceService workspaceService,
                          LoginAttemptService loginAttemptService,
                          ClientIpResolver clientIpResolver,
                          RegistrationPolicy registrationPolicy,
                          PlatformTransactionManager transactionManager) {
        this.authService = authService;
        this.workspaceService = workspaceService;
        this.loginAttemptService = loginAttemptService;
        this.clientIpResolver = clientIpResolver;
        this.registrationPolicy = registrationPolicy;
        this.transactionTemplate = new TransactionTemplate(transactionManager);
    }

    /**
     * Onboarding signal; always 200, never gated, exposes one boolean only.
     *
     * <p>PLAN-0758: the retired local-mode flag was removed with D-787. {@code initialized}
     * remains the sole onboarding discriminator (the UI entry resolution reads it), so the
     * endpoint keeps its shape minus the flag.
     */
    @GetMapping("/bootstrap-status")
    public ResponseEntity<?> bootstrapStatus() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("initialized", authService.hasAnyUser());
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
        // an unthrottled 403 oracle) and BEFORE any user row exists.
        registrationPolicy.requireOpen();
        // The password is mandatory on every registration path (PLAN-0758 removed
        // the local-mode omission that used to generate a server-side password).
        if (isBlank(request.getPassword())) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "password is required");
        }
        try {
            AuthResponse response = transactionTemplate.execute(status -> {
                User user = authService.registerUser(request);
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
        try {
            // PLAN-0565 ruling #7: the identifier (email or username) keys the lockout lease.
            lease = loginAttemptService.beginLogin(request.getIdentifier(), ip);
            if (!loginAttemptService.tryAcquireBcryptSlot()) {
                throw new LoginThrottledException(1);
            }
            try {
                User user = authService.authenticate(request);
                loginAttemptService.recordSuccess(lease);
                return ResponseEntity.ok(withFirstWorkspace(user));
            } finally {
                loginAttemptService.releaseBcryptSlot();
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
     * <p>Register/login/refresh all go through here, so a fresh account can authenticate
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
}
