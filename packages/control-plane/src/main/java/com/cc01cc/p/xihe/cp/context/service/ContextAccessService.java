package com.cc01cc.p.xihe.cp.context.service;

import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

@Service
public class ContextAccessService {

    private final SessionRepository sessionRepository;
    private final WorkspaceUserRepository workspaceUserRepository;

    public ContextAccessService(SessionRepository sessionRepository,
                                WorkspaceUserRepository workspaceUserRepository) {
        this.sessionRepository = sessionRepository;
        this.workspaceUserRepository = workspaceUserRepository;
    }

    public boolean verifyAccess(String sessionId) {
        String userId = resolveUserId(sessionId);
        String workspaceId = resolveWorkspaceId(sessionId);
        if (userId == null || workspaceId == null) {
            return false;
        }
        // Workspace membership is required. Session ownership is not verified here
        // because the session may be created concurrently by the Agent module.
        return workspaceUserRepository
                .findByIdWorkspaceIdAndIdUserId(UUID.fromString(workspaceId), UUID.fromString(userId))
                .isPresent();
    }

    public String resolveUserId(String sessionId) {
        String tokenUserId = TenantContext.getUserId();
        if (tokenUserId != null) {
            return tokenUserId;
        }
        // Internal service calls carry no JWT; resolve from the Session row.
        // No implicit default: unknown session means no user context.
        return sessionRepository.findById(UUID.fromString(sessionId)).map(s -> s.getUserId()).orElse(null);
    }

    public String resolveWorkspaceId(String sessionId) {
        String tokenWorkspaceId = TenantContext.getWorkspaceId();
        if (tokenWorkspaceId != null) {
            return tokenWorkspaceId;
        }
        // No silent "default" workspace fallback; unknown session fails access check.
        return sessionRepository.findById(UUID.fromString(sessionId)).map(s -> s.getWorkspaceId()).orElse(null);
    }

    public HttpStatus checkPublicAccess(String userId, String workspaceId, String sessionId) {
        if (userId == null || workspaceId == null) {
            return HttpStatus.UNAUTHORIZED;
        }
        var session = sessionRepository.findById(UUID.fromString(sessionId)).orElse(null);
        if (session == null
                || !userId.equals(session.getUserId())
                || !workspaceId.equals(session.getWorkspaceId())) {
            return HttpStatus.NOT_FOUND;
        }
        return workspaceUserRepository
                .findByIdWorkspaceIdAndIdUserId(UUID.fromString(workspaceId), UUID.fromString(userId))
                .isPresent() ? HttpStatus.OK : HttpStatus.FORBIDDEN;
    }
}
