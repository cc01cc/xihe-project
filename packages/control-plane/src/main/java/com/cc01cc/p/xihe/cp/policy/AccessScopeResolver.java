package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

import java.util.UUID;

/**
 * PLAN-0610 T1.4: resolves the request scope for grant evaluation and binding writes.
 *
 * <p><b>Trusted inputs only</b> (design #8, "不信任请求参数"):</p>
 *
 * <ul>
 *   <li>the effective workspace that {@code TenantContextInterceptor} already resolved and
 *       member-validated for this request ({@code TenantContext#getWorkspaceId()});</li>
 *   <li>a workspace id taken from the <em>route or the resource row</em>, which is accepted only
 *       after an independent membership check — a caller cannot widen its own scope by putting a
 *       foreign workspace id in the path, a query parameter or a header.</li>
 * </ul>
 *
 * <p>A client-supplied {@code scope}/{@code scopeId} value is never used as a source; if it
 * contradicts the resolved scope the request is rejected ({@code 400 INVALID_SCOPE}) instead of
 * silently honouring one side.</p>
 *
 * <p>Instance-level administrators are <em>not</em> handled here: a plain workspace scope is a
 * statement about "which rows participate", and {@link AuthzContext#canWorkspaceAdmin} answers
 * the separate "may this subject act on that workspace" question.</p>
 */
@Component
public class AccessScopeResolver {

    private static final Logger logger = LoggerFactory.getLogger(AccessScopeResolver.class);

    private final WorkspaceRepository workspaceRepository;
    private final WorkspaceUserRepository workspaceUserRepository;

    public AccessScopeResolver(WorkspaceRepository workspaceRepository,
                               WorkspaceUserRepository workspaceUserRepository) {
        this.workspaceRepository = workspaceRepository;
        this.workspaceUserRepository = workspaceUserRepository;
    }

    /** The scope of the current request: the tenant-resolved workspace, else instance. */
    public AccessScope resolveRequestScope() {
        String workspaceId = TenantContext.getWorkspaceId();
        if (workspaceId == null || workspaceId.isBlank()) {
            return AccessScope.instance();
        }
        return AccessScope.workspace(parseWorkspaceId(workspaceId));
    }

    /**
     * Scope of a route path segment ({@code /api/v1/workspaces/{workspaceId}/...}). The id is
     * never trusted as a scope by itself: the caller must be a member of that workspace.
     */
    public AccessScope resolveRouteScope(String routeWorkspaceId) {
        return resolveMemberWorkspaceScope(routeWorkspaceId, "route");
    }

    /**
     * Scope of the workspace that owns the resource being addressed (session owner workspace,
     * workspace agent binding, ...). Same rule as {@link #resolveRouteScope(String)}.
     */
    public AccessScope resolveResourceScope(String ownerWorkspaceId) {
        return resolveMemberWorkspaceScope(ownerWorkspaceId, "resource");
    }

    private AccessScope resolveMemberWorkspaceScope(String rawWorkspaceId, String origin) {
        // Malformed ids surface as 400 INVALID_WORKSPACE_ID from the shared tenant helper.
        String normalized = TenantContext.normalizeWorkspaceId(rawWorkspaceId);
        if (normalized == null) {
            return resolveRequestScope();
        }
        String userId = TenantContext.getUserId();
        if (userId == null || userId.isBlank()) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "WORKSPACE_FORBIDDEN",
                    "Workspace access denied");
        }
        UUID workspaceId = parseWorkspaceId(normalized);
        UUID userUuid;
        try {
            userUuid = UUID.fromString(userId);
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "WORKSPACE_FORBIDDEN",
                    "Workspace access denied");
        }
        boolean active = workspaceRepository.findByIdAndDeletedAtIsNull(workspaceId).isPresent();
        boolean member = workspaceUserRepository
                .findByIdWorkspaceIdAndIdUserId(workspaceId, userUuid).isPresent();
        if (!active || !member) {
            logger.warn("[POLICY] event=scope_resolution_denied origin={} reason=not_member", origin);
            throw new CpApiException(HttpStatus.FORBIDDEN, "WORKSPACE_FORBIDDEN",
                    "Workspace access denied");
        }
        return AccessScope.workspace(workspaceId);
    }

    /**
     * Rejects a client-supplied scope that contradicts the resolved one. Absent values are fine
     * (they are simply not a source). This is the "do not trust request parameters" gate for the
     * W3 binding API, which denormalizes {@code scope} for readability only.
     */
    public void requireClientScopeConsistent(AccessScope resolved, String requestedScopeType,
                                             String requestedScopeId) {
        if (requestedScopeType == null || requestedScopeType.isBlank()) {
            return;
        }
        String expectedType = resolved.type();
        String expectedId = resolved.isInstance() ? null : resolved.id().toString();
        String requestedId;
        try {
            requestedId = TenantContext.normalizeWorkspaceId(requestedScopeId);
        } catch (CpApiException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_SCOPE",
                    "scopeId must be a workspace UUID");
        }
        boolean typeMatches = expectedType.equals(requestedScopeType.trim());
        boolean idMatches = resolved.isInstance() ? requestedId == null
                : requestedId != null && requestedId.equalsIgnoreCase(expectedId);
        if (!typeMatches || !idMatches) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_SCOPE",
                    "The requested scope does not match the resolved request scope");
        }
    }

    private static UUID parseWorkspaceId(String workspaceId) {
        try {
            return UUID.fromString(workspaceId);
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_SCOPE",
                    "scopeId must be a workspace UUID");
        }
    }
}
