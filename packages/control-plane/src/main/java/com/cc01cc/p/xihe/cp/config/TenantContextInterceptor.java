package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0559: resolve the request workspace from {@code X-Workspace-Id}.
 *
 * <p>Precedence is header → legacy access-token claim → the caller's first
 * active membership. A present header is never silently overridden by the
 * legacy claim. Every resolved workspace must be active and owned/membered by
 * the caller; failures terminate the request with the frozen 400/403 problem
 * shapes. The access token itself is user-level (no workspace claim) for newly
 * issued tokens; the claim path exists only for the transition window.</p>
 */
@Component
public class TenantContextInterceptor implements HandlerInterceptor {

    private static final Logger logger = LoggerFactory.getLogger(TenantContextInterceptor.class);

    private final JwtTokenProvider jwtTokenProvider;
    private final WorkspaceService workspaceService;
    private final ObjectMapper objectMapper;

    public TenantContextInterceptor(JwtTokenProvider jwtTokenProvider,
                                    WorkspaceService workspaceService,
                                    ObjectMapper objectMapper) {
        this.jwtTokenProvider = jwtTokenProvider;
        this.workspaceService = workspaceService;
        this.objectMapper = objectMapper;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler)
            throws IOException {
        String authHeader = request.getHeader("Authorization");
        if (authHeader == null || !authHeader.startsWith("Bearer ")) {
            return true;
        }
        String token = authHeader.substring(7);
        if (!jwtTokenProvider.validateToken(token)) {
            return true;
        }

        String userId = jwtTokenProvider.getUserIdFromToken(token);
        TenantContext.setUserId(userId);
        TenantContext.setUserRole(jwtTokenProvider.getRoleFromToken(token));

        if (isTenantExempt(request.getRequestURI())) {
            return true;
        }

        String headerWorkspaceId = request.getHeader("X-Workspace-Id");
        if (headerWorkspaceId != null && !headerWorkspaceId.isBlank()) {
            try {
                String workspaceId = TenantContext.normalizeWorkspaceId(headerWorkspaceId);
                if (!workspaceService.isWorkspaceMember(workspaceId, userId)) {
                    return reject(response, HttpStatus.FORBIDDEN, "WORKSPACE_FORBIDDEN",
                            "Workspace access denied");
                }
                applyWorkspace(workspaceId, userId, "header");
                return enforceWorkspaceRole(request, response);
            } catch (CpApiException e) {
                return reject(response, e.getStatus(), e.getCode(), e.getMessage());
            }
        }

        String legacyClaimWorkspaceId = jwtTokenProvider.getWorkspaceIdFromToken(token);
        if (legacyClaimWorkspaceId != null && !legacyClaimWorkspaceId.isBlank()) {
            try {
                String workspaceId = TenantContext.normalizeWorkspaceId(legacyClaimWorkspaceId);
                if (!workspaceService.isWorkspaceMember(workspaceId, userId)) {
                    return reject(response, HttpStatus.FORBIDDEN, "WORKSPACE_FORBIDDEN",
                            "Workspace access denied");
                }
                applyWorkspace(workspaceId, userId, "claim");
                return enforceWorkspaceRole(request, response);
            } catch (CpApiException e) {
                // A malformed legacy claim is a credential problem, not a client
                // input problem; keep it a 403 and never fall back silently.
                return reject(response, HttpStatus.FORBIDDEN, "WORKSPACE_FORBIDDEN",
                        "Workspace access denied");
            }
        }

        Optional<Workspace> fallback;
        try {
            fallback = workspaceService.findCurrentWorkspace(userId);
        } catch (IllegalArgumentException e) {
            // Non-UUID subjects (tests/legacy service tokens) simply have no
            // workspace context; tenant-required controllers return 401.
            fallback = Optional.empty();
        }
        if (fallback.isPresent()) {
            applyWorkspace(fallback.get().getId().toString(), userId, "default");
            return enforceWorkspaceRole(request, response);
        }
        return true;
    }

    private boolean enforceWorkspaceRole(HttpServletRequest request, HttpServletResponse response)
            throws IOException {
        WorkspaceWriteGuard.Requirement requirement =
                WorkspaceWriteGuard.requirement(request.getMethod(), request.getRequestURI());
        String role = TenantContext.getWorkspaceRole();
        if (WorkspaceWriteGuard.allows(role, requirement)) {
            return true;
        }
        if (requirement == WorkspaceWriteGuard.Requirement.WRITE && "VIEWER".equals(role)) {
            return reject(response, HttpStatus.FORBIDDEN, "WORKSPACE_READ_ONLY",
                    "Viewer cannot modify this workspace");
        }
        return reject(response, HttpStatus.FORBIDDEN, "WORKSPACE_FORBIDDEN",
                "Workspace access denied");
    }

    private void applyWorkspace(String workspaceId, String userId, String source) {
        TenantContext.setWorkspaceId(workspaceId);
        String workspaceRole = workspaceService.resolveWorkspaceRole(workspaceId, userId);
        if (workspaceRole != null) {
            TenantContext.setWorkspaceRole(workspaceRole);
        }
        logger.debug("[TENANT] workspace_resolved workspaceId={} source={}", workspaceId, source);
    }

    private boolean isTenantExempt(String uri) {
        return uri == null
                || uri.startsWith("/internal/v1/")
                || uri.startsWith("/api/v1/auth/")
                || uri.equals("/api/v1/auth")
                || uri.startsWith("/api/v1/health");
    }

    private boolean reject(HttpServletResponse response, HttpStatus status,
                           String code, String detail) throws IOException {
        String requestId = UUID.randomUUID().toString();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", "https://xihe.dev/problems/" + code.toLowerCase().replace('_', '-'));
        body.put("title", status.getReasonPhrase());
        body.put("status", status.value());
        body.put("code", code);
        body.put("detail", detail);
        body.put("requestId", requestId);

        response.setStatus(status.value());
        response.setContentType("application/problem+json");
        response.setCharacterEncoding(java.nio.charset.StandardCharsets.UTF_8.name());
        response.setHeader("X-Request-Id", requestId);
        response.getWriter().write(objectMapper.writeValueAsString(body));
        return false;
    }

    @Override
    public void afterCompletion(HttpServletRequest request, HttpServletResponse response,
                                Object handler, Exception ex) {
        TenantContext.clear();
    }
}
