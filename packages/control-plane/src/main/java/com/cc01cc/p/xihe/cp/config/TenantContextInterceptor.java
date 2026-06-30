package com.cc01cc.p.xihe.cp.config;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;

@Component
public class TenantContextInterceptor implements HandlerInterceptor {

    private final JwtTokenProvider jwtTokenProvider;
    private final WorkspaceService workspaceService;

    public TenantContextInterceptor(JwtTokenProvider jwtTokenProvider,
                                    WorkspaceService workspaceService) {
        this.jwtTokenProvider = jwtTokenProvider;
        this.workspaceService = workspaceService;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        String authHeader = request.getHeader("Authorization");
        if (authHeader != null && authHeader.startsWith("Bearer ")) {
            String token = authHeader.substring(7);
            if (jwtTokenProvider.validateToken(token)) {
                String userId = jwtTokenProvider.getUserIdFromToken(token);
                TenantContext.setUserId(userId);
                TenantContext.setUserRole(jwtTokenProvider.getRoleFromToken(token));
                String workspaceId = jwtTokenProvider.getWorkspaceIdFromToken(token);
                if (workspaceId != null) {
                    TenantContext.setWorkspaceId(workspaceId);
                    String path = workspaceService.resolveStoragePath(workspaceId);
                    if (path != null) {
                        TenantContext.setWorkspacePath(path);
                    }
                    String wsRole = workspaceService.resolveWorkspaceRole(workspaceId, userId);
                    if (wsRole != null) {
                        TenantContext.setWorkspaceRole(wsRole);
                    }
                }
            }
        }
        return true;
    }

    @Override
    public void afterCompletion(HttpServletRequest request, HttpServletResponse response, Object handler, Exception ex) {
        TenantContext.clear();
    }
}
