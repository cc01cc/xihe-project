package com.cc01cc.p.xihe.cp.auth;

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
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;


/**
 * PLAN-0470 #25: the auth entry orchestrates identity and default-Workspace
 * bootstrap. Register/login/refresh resolve or create the default Workspace
 * here (same transaction as user creation on register, so a Workspace failure
 * still rolls the registration back), then hand the resolved workspaceId to
 * {@link AuthService#issueTokens}; Auth itself no longer depends on Workspace.
 */
@RestController
    @RequestMapping("/api/v1/auth")
public class AuthController {

    private static final Logger logger = LoggerFactory.getLogger(AuthController.class);

    private final AuthService authService;
    private final WorkspaceService workspaceService;
    private final TransactionTemplate transactionTemplate;

    public AuthController(AuthService authService, WorkspaceService workspaceService,
                          PlatformTransactionManager transactionManager) {
        this.authService = authService;
        this.workspaceService = workspaceService;
        this.transactionTemplate = new TransactionTemplate(transactionManager);
    }

    @PostMapping("/register")
    public ResponseEntity<?> register(@Valid @RequestBody RegisterRequest request) {
        try {
            AuthResponse response = transactionTemplate.execute(status -> {
                User user = authService.registerUser(request);
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
}
