package com.cc01cc.p.xihe.cp.oauth;

import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;

@RestController
public class OAuthController {

    private static final Logger logger = LoggerFactory.getLogger(OAuthController.class);

    private final OAuthCredentialService service;

    public OAuthController(OAuthCredentialService service) {
        this.service = service;
    }

    @PostMapping("/api/v1/oauth/sessions")
    public ResponseEntity<?> start(Authentication authentication, @RequestBody StartRequest request) {
        try {
            String userId = requireAuthentication(authentication);
            OAuthCredentialService.AuthorizationStart start = service.start(new OAuthCredentialService.StartRequest(
                    userId,
                    required(request.workspaceId(), "workspaceId"),
                    required(request.serverId(), "serverId"),
                    required(request.remoteEndpoint(), "remoteEndpoint"),
                    required(request.clientId(), "clientId"),
                    required(request.authorizationEndpoint(), "authorizationEndpoint"),
                    required(request.tokenEndpoint(), "tokenEndpoint"),
                    required(request.redirectUri(), "redirectUri"),
                    required(request.scope(), "scope")));
            return ResponseEntity.ok(Map.of(
                    "state", start.state(),
                    "codeChallenge", start.codeChallenge(),
                    "authorizationUrl", start.authorizationUrl(),
                    "expiresAtMillis", start.expiresAtMillis()));
        } catch (IllegalArgumentException e) {
            logger.warn("OAuth session start rejected: {}", e.getMessage());
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "OAuth session request is invalid");
        }
    }

    @GetMapping("/api/v1/oauth/callback")
    public ResponseEntity<?> callback(@RequestParam String state, @RequestParam String code) {
        try {
            service.complete(state, code);
            return ResponseEntity.ok(Map.of("status", "authorized"));
        } catch (IllegalArgumentException e) {
            logger.warn("OAuth callback rejected: {}", e.getMessage());
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "OAuth callback is invalid");
        }
    }

    @PostMapping("/api/v1/oauth/revoke")
    public ResponseEntity<?> revoke(Authentication authentication, @RequestBody BindingRequest request) {
        try {
            String userId = requireAuthentication(authentication);
            boolean revoked = service.revoke(userId, required(request.workspaceId(), "workspaceId"), required(request.serverId(), "serverId"));
            if (!revoked) {
                return ProblemDetailsHandler.problemResponse(HttpStatus.NOT_FOUND, "OAUTH_CREDENTIAL_NOT_FOUND", "OAuth credential not found");
            }
            return ResponseEntity.ok(Map.of("status", "revoked"));
        } catch (IllegalArgumentException e) {
            logger.warn("OAuth revoke rejected: {}", e.getMessage());
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "OAuth revoke request is invalid");
        }
    }

    @PostMapping("/internal/v1/oauth/token")
    public ResponseEntity<?> token(Authentication authentication, @RequestBody BindingRequest request) {
        if (authentication == null || !authentication.isAuthenticated()
                || !authentication.getAuthorities().stream().anyMatch(a -> "ROLE_INTERNAL_SERVICE".equals(a.getAuthority()))) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.FORBIDDEN, "FORBIDDEN", "Internal service authorization required");
        }
        try {
            OAuthCredentialService.AccessGrant grant = service.issueAccessToken(
                    required(request.userId(), "userId"),
                    required(request.workspaceId(), "workspaceId"),
                    required(request.serverId(), "serverId"),
                    required(request.scope(), "scope"));
            return ResponseEntity.ok(Map.of(
                    "access_token", grant.accessToken(),
                    "token_type", "Bearer",
                    "expires_in", grant.expiresIn(),
                    "scope", grant.scope()));
        } catch (IllegalArgumentException e) {
            logger.warn("OAuth token broker rejected: {}", e.getMessage());
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED, "OAUTH_TOKEN_UNAVAILABLE", "OAuth token unavailable");
        }
    }

    private static String requireAuthentication(Authentication authentication) {
        if (authentication == null || !authentication.isAuthenticated()
                || authentication.getName() == null || authentication.getName().isBlank()) {
            throw new IllegalArgumentException("Not authenticated");
        }
        return authentication.getName();
    }

    private static String required(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " must not be blank");
        return value;
    }

    public record StartRequest(String workspaceId, String serverId, String remoteEndpoint, String clientId,
                               String authorizationEndpoint, String tokenEndpoint,
                               String redirectUri, String scope) {}

    public record BindingRequest(String userId, String workspaceId, String serverId, String scope) {}
}
