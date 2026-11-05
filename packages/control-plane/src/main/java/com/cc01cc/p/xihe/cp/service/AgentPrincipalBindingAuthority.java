package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.policy.RequesterAuthority;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

import java.util.UUID;

/**
 * PLAN-0667: the single authorization entry point for the agent-principal binding surfaces
 * (roles + skills).
 *
 * <p>Exactly two tiers, no bypass: {@code MANAGE_AGENT_PRINCIPALS} (N1, instance tier) or
 * {@code MANAGE_WORKSPACE_AGENTS} evaluated in a workspace. The optional {@code workspaceId} is an
 * <b>authorization context only</b> (same pattern as the V107 memory face); a binding's storage key
 * comes from its own {@code scopeType}/{@code scopeId}, never from this parameter.</p>
 *
 * <p>Everything that both controllers must agree on lives here — the tier evaluation, the
 * "actor != subject" rule, the instance-tier visibility rule and the workspace visibility lookup —
 * so a future tweak cannot land on one surface only. {@code BindingController} (user bindings,
 * PLAN-0610) is deliberately not routed through this class: it keeps its own user-only contract.</p>
 */
@Component
public class AgentPrincipalBindingAuthority {

    private final RequesterAuthority requesterAuthority;
    private final AgentPrincipalService agentPrincipalService;
    private final AgentPrincipalRepository agentPrincipalRepository;

    public AgentPrincipalBindingAuthority(RequesterAuthority requesterAuthority,
                                          AgentPrincipalService agentPrincipalService,
                                          AgentPrincipalRepository agentPrincipalRepository) {
        this.requesterAuthority = requesterAuthority;
        this.agentPrincipalService = agentPrincipalService;
        this.agentPrincipalRepository = agentPrincipalRepository;
    }

    /** The resolved caller, after the two-tier atom gate and the visibility check. */
    public record Caller(String actorUserId, UUID actorUuid, UUID principalId, UUID workspaceId,
                         boolean instanceTier) {
        public String auditWorkspaceId() {
            return workspaceId == null ? null : workspaceId.toString();
        }
    }

    public Caller require(String principalIdValue, String workspaceIdValue) {
        String actor = TenantContext.getUserId();
        if (actor == null || actor.isBlank()) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED",
                    "Authentication required");
        }
        UUID actorUuid = parseUuid(actor, "Authentication required");
        UUID principal = parseUuid(principalIdValue, "A valid principal id is required");
        UUID workspace = resolveAuthorizingWorkspace(workspaceIdValue);
        boolean instanceTier = requesterAuthority.holdsActionAtom(
                ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS);
        boolean workspaceTier = workspace != null && requesterAuthority.holdsActionAtom(actorUuid,
                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS, workspace);
        if (!instanceTier && !workspaceTier) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "MANAGE_AGENT_PRINCIPALS or MANAGE_WORKSPACE_AGENTS in the authorizing workspace is required");
        }
        if (actorUuid.equals(principal)) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "an agent principal cannot administer its own bindings");
        }
        requireVisible(actor, principal, workspace, instanceTier);
        return new Caller(actor, actorUuid, principal, workspace, instanceTier);
    }

    /** True when the caller may act in that workspace (used for row-scope decisions on delete). */
    /**
     * BL-351: the authorizing workspace may arrive as {@code X-Workspace-Id} (preferred, resolved by
     * {@link com.cc01cc.p.xihe.cp.config.TenantContextInterceptor}) or as the legacy {@code ?workspaceId}
     * query parameter. Header wins; a conflicting pair is a client error (400), never a silent pick —
     * the two values name different authorization scopes, so choosing one could broaden authority.
     */
    private static UUID resolveAuthorizingWorkspace(String workspaceIdValue) {
        String header = "header".equals(TenantContext.getWorkspaceSource())
                ? TenantContext.getWorkspaceId() : null;
        String query = isBlank(workspaceIdValue) ? null : workspaceIdValue.trim();
        if (header != null && query != null && !header.equalsIgnoreCase(query)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "WORKSPACE_CONTEXT_CONFLICT",
                    "X-Workspace-Id conflicts with ?workspaceId; send only one of them");
        }
        String effective = header != null ? header : query;
        return effective == null ? null : parseUuid(effective, "A valid workspaceId is required");
    }

    public boolean canManageWorkspace(UUID actorUuid, UUID workspaceId) {
        return requesterAuthority.holdsActionAtom(actorUuid,
                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS, workspaceId);
    }

    /** Instance tier: the principal must exist and be enabled. Workspace tier: it must be visible. */
    private void requireVisible(String actor, UUID principal, UUID workspace, boolean instanceTier) {
        if (workspace == null) {
            if (!instanceTier) {
                throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                        "a workspace-scoped authority needs the authorizing workspaceId");
            }
            requireActivePrincipal(principal);
            return;
        }
        boolean visible = agentPrincipalService.listWorkspaceAgents(actor, workspace).stream()
                .anyMatch(view -> principal.equals(view.principalId()));
        if (!visible) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "AGENT_PRINCIPAL_NOT_FOUND",
                    "Agent principal not found");
        }
    }

    /** Shared 404 shape: missing and disabled are indistinguishable on purpose. */
    public AgentPrincipal requireActivePrincipal(UUID principalId) {
        AgentPrincipal principal = agentPrincipalRepository.findById(principalId)
                .orElseThrow(AgentPrincipalBindingAuthority::principalNotFound);
        if (principal.getDisabledAt() != null) {
            throw principalNotFound();
        }
        return principal;
    }

    public static UUID parseUuid(Object raw, String message) {
        if (!(raw instanceof String value) || value.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", message);
        }
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", message, e);
        }
    }

    private static CpApiException principalNotFound() {
        return new CpApiException(HttpStatus.NOT_FOUND, "AGENT_PRINCIPAL_NOT_FOUND",
                "Agent principal not found");
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}