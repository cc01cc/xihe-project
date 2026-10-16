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
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
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
    private final TransactionTemplate transactionTemplate;

    public AuthController(AuthService authService, WorkspaceService workspaceService,
                          LocalModeService localModeService,
                          PlatformTransactionManager transactionManager) {
        this.authService = authService;
        this.workspaceService = workspaceService;
        this.localModeService = localModeService;
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
                User user = authService.registerUser(request, localModeService.enabled());
                return withDefaultWorkspace(user);
            });
            return ResponseEntity.status(HttpStatus.CREATED).body(response);
        } catch (IllegalArgumentException e) {
            logger.warn("Registration failed: {}", e.getMessage());
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Registration failed");
        }
    }

    @PostMapping("/login")
    public ResponseEntity<?> login(@Valid @RequestBody LoginRequest request) {
        try {
            User user = authService.authenticate(request);
            AuthResponse response = withDefaultWorkspace(user);
            return ResponseEntity.ok(response);
        } catch (IllegalArgumentException e) {
            logger.warn("Login failed for {}: {}", request.getEmail(), e.getMessage());
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_FAILED", "Invalid credentials");
        }
    }

    @PostMapping("/refresh")
    public ResponseEntity<?> refresh(@Valid @RequestBody RefreshRequest request) {
        try {
            User user = authService.verifyRefresh(request.getRefreshToken());
            AuthResponse response = withDefaultWorkspace(user);
            return ResponseEntity.ok(response);
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
        return ResponseEntity.ok(withDefaultWorkspace(user));
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

    /** Entry-level default-Workspace bootstrap shared by register/login/refresh. */
    private AuthResponse withDefaultWorkspace(User user) {
        String workspaceId = workspaceService
                .getOrCreateDefaultWorkspace(user.getId().toString()).getId().toString();
        return authService.issueTokens(user, workspaceId);
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
