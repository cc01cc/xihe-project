package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.config.WorkspaceWriteGuard;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.service.ContextTemplateService;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

/**
 * PLAN-0608 C′ (decision #8/#9): the single decision point for "which workspace
 * owns a new session". Both entry surfaces —
 * {@code POST /api/v1/sessions} and
 * {@code POST /api/v1/workspaces/{workspaceId}/sessions} — funnel through
 * {@link SessionWorkspaceResolver} here, so the ownership rule exists exactly
 * once (I1).
 *
 * <p>B-narrow (decision #3) is scoped to <b>session creation only</b>: other
 * tenant consumers (policy, workspace files, chat attachments) keep the legacy
 * fallback untouched.
 */
@Service
public class SessionCreationService {

    private static final Logger logger = LoggerFactory.getLogger(SessionCreationService.class);

    /** Everything the session row needs, resolved by the calling controller. */
    public record Params(String title, String modelProvider, String modelName,
                         String providerConnectionId, String agentPrincipalId,
                         ContextTemplateService.TemplateSelection templateSelection) {}

    private final SessionService sessionService;
    private final WorkspaceService workspaceService;

    public SessionCreationService(SessionService sessionService, WorkspaceService workspaceService) {
        this.sessionService = sessionService;
        this.workspaceService = workspaceService;
    }

    /**
     * @param pathWorkspaceId   raw {@code {workspaceId}} path variable (path form), else null
     * @param headerWorkspaceId raw {@code X-Workspace-Id} header value, else null
     */
    public Session create(String userId, String pathWorkspaceId, String headerWorkspaceId, Params params) {
        return create(userId, pathWorkspaceId, headerWorkspaceId, null, params);
    }

    /**
     * PLAN-0647 MVP (D-678 #1): the body may carry an explicit {@code workspaceId}; when path,
     * header <b>and</b> body all agree that no workspace is named, this creates a workspace-less
     * session instead of falling back to the interceptor's "first active workspace" (D47-05).
     *
     * @param bodyWorkspaceId raw body {@code workspaceId} (absent and null are equivalent), else null
     */
    public Session create(String userId, String pathWorkspaceId, String headerWorkspaceId,
                          String bodyWorkspaceId, Params params) {
        if (userId == null || userId.isBlank()) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED",
                    "Authentication required");
        }
        // Malformed explicit ids are a client error (400 INVALID_WORKSPACE_ID), never a 500.
        String pathWorkspace = TenantContext.normalizeWorkspaceId(pathWorkspaceId);
        String headerWorkspace = TenantContext.normalizeWorkspaceId(headerWorkspaceId);
        String bodyWorkspace = TenantContext.normalizeWorkspaceId(bodyWorkspaceId);

        if (pathWorkspace == null && headerWorkspace == null && bodyWorkspace == null) {
            // PLAN-0647 D-678/D-687: genuinely no workspace — do not resolve the interceptor fallback.
            Session session = sessionService.createAgentSession(userId, null,
                    params == null ? null : params.title(),
                    params == null ? null : params.modelProvider(),
                    params == null ? null : params.modelName(),
                    params == null ? null : params.providerConnectionId(),
                    params == null ? null : params.agentPrincipalId(),
                    params == null ? null : params.templateSelection());
            logger.info("[LIFECYCLE] service=cp event=session_created sessionId={} workspaceId=null source=workspaceless",
                    session.getId());
            return session;
        }

        if ((bodyWorkspace != null && pathWorkspace != null
                && !bodyWorkspace.equalsIgnoreCase(pathWorkspace))
                || (bodyWorkspace != null && headerWorkspace != null
                && !bodyWorkspace.equalsIgnoreCase(headerWorkspace))) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "WORKSPACE_CONTEXT_CONFLICT",
                    "The body workspaceId conflicts with another workspace input; send only one of them");
        }
        String explicitWorkspace = bodyWorkspace != null ? bodyWorkspace : pathWorkspace;
        int memberWorkspaceCount = (explicitWorkspace == null && headerWorkspace == null)
                ? workspaceService.countActiveMemberWorkspaces(userId)
                : -1;
        SessionWorkspaceResolver.Resolution resolution = SessionWorkspaceResolver.resolve(
                explicitWorkspace, headerWorkspace, memberWorkspaceCount,
                TenantContext.getWorkspaceId(), TenantContext.getWorkspaceSource());

        switch (resolution.outcome()) {
            case CONFLICT -> throw new CpApiException(HttpStatus.BAD_REQUEST, "WORKSPACE_CONTEXT_CONFLICT",
                    "X-Workspace-Id conflicts with the workspace in the path; send only one of them");
            case REQUIRED -> throw new CpApiException(HttpStatus.CONFLICT, "WORKSPACE_CONTEXT_REQUIRED",
                    "This account belongs to multiple workspaces; create the session under an explicit workspace"
                            + " (POST /api/v1/workspaces/{workspaceId}/sessions or X-Workspace-Id)");
            default -> {
                // USE
            }
        }

        String workspaceId = resolution.workspaceId();
        if (explicitWorkspace != null) {
            // The header surface was already membership-checked by the interceptor; the path/body
            // surfaces are new, so they are checked here with the same gate + write role.
            workspaceService.requireContextWorkspace(explicitWorkspace, userId);
            String pathRole = workspaceService.resolveWorkspaceRole(explicitWorkspace, userId);
            if (!WorkspaceWriteGuard.allows(pathRole, WorkspaceWriteGuard.Requirement.WRITE)) {
                throw new CpApiException(HttpStatus.FORBIDDEN, "WORKSPACE_READ_ONLY",
                        "Viewer cannot modify this workspace");
            }
            workspaceId = explicitWorkspace;
        }

        // PLAN-0618 M1 (BL-178): a session on the frozen docker backend is refused before any row is
        // written, with the same 503 BACKEND_DISABLED the other workspace operations return.
        sessionService.requireBackendUsableWorkspace(workspaceId);

        Session session = sessionService.createAgentSession(userId, workspaceId,
                params == null ? null : params.title(),
                params == null ? null : params.modelProvider(),
                params == null ? null : params.modelName(),
                params == null ? null : params.providerConnectionId(),
                params == null ? null : params.agentPrincipalId(),
                params == null ? null : params.templateSelection());
        logger.info("[LIFECYCLE] service=cp event=session_created sessionId={} workspaceId={} source={}",
                session.getId(), workspaceId, resolution.source());
        return session;
    }}

