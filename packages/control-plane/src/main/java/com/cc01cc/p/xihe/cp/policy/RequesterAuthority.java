package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

import java.util.LinkedHashSet;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0610 W3-2a: <b>action-atom</b> gates for the role/binding administration surface.
 *
 * <p>This is the counterpart of {@link AuthzContext}: that class answers capability questions
 * ({@code cap:instance:admin}) because capability atoms become Spring authorities (decision #23 /
 * R2-5), while action atoms ({@code read}, {@code MANAGE_ROLES}, ...) never leave the grant table —
 * they are answered from the materialized {@code source='role'} rows through the same scoped read
 * the evaluation kernel uses ({@link AuthorizationGrantRepository#findScopedGrants}). A Spring
 * expression such as {@code @PreAuthorize("@requesterAuthority.holdsActionAtom('MANAGE_ROLES')")}
 * is therefore the honest way to put the design's {@code MANAGE_ROLES} gate on an endpoint: adding
 * a fourth capability atom for it would contradict decision #23, and {@code hasAuthority('…')}
 * cannot express an action atom.</p>
 *
 * <p>Scope follows the evaluation kernel exactly: instance rows always participate, workspace rows
 * only for the workspace being addressed (design #11, explicit and non-inheriting).</p>
 */
@Component
public class RequesterAuthority {

    private static final Logger logger = LoggerFactory.getLogger(RequesterAuthority.class);

    private final AuthorizationGrantRepository grantRepository;
    private final GrantIntersectionEvaluator evaluator;
    private final AuthzContext authzContext;

    public RequesterAuthority(AuthorizationGrantRepository grantRepository,
                              GrantIntersectionEvaluator evaluator,
                              AuthzContext authzContext) {
        this.grantRepository = grantRepository;
        this.evaluator = evaluator;
        this.authzContext = authzContext;
    }

    /** The request's subject id, or {@code null} when the request has no authenticated user. */
    public UUID currentSubjectId() {
        return parse(TenantContext.getUserId());
    }

    /**
     * True when the <em>current request subject</em> holds the action atom at instance scope.
     * This is the SpEL entry point used by the role/binding controllers.
     */
    public boolean holdsActionAtom(String actionClass) {
        UUID subjectId = currentSubjectId();
        return subjectId != null && holdsActionAtom(subjectId, actionClass, null);
    }

    /** True when the subject's effective atoms for {@code workspaceId} contain the atom. */
    public boolean holdsActionAtom(UUID subjectId, String actionClass, UUID workspaceId) {
        if (subjectId == null || actionClass == null) {
            return false;
        }
        return actionAtoms(subjectId, workspaceId).contains(actionClass);
    }

    /**
     * The subject's effective action atoms for one request scope: instance rows plus (when a
     * workspace is addressed) that workspace's rows. Retired sources are excluded through
     * {@link GrantSources#EVALUATION_SOURCES}.
     */
    public Set<String> actionAtoms(UUID subjectId, UUID workspaceId) {
        if (subjectId == null) {
            return Set.of();
        }
        Set<GrantIntersectionEvaluator.PermissionAtom> atoms;
        try {
            atoms = evaluator.union(grantRepository.findScopedGrants(AuthzContext.SUBJECT_USER,
                    subjectId, GrantSources.EVALUATION_SOURCES, workspaceId));
        } catch (RuntimeException e) {
            // Fail closed: an unreadable/!canonical grant row must never widen authority.
            logger.error("[POLICY] event=action_atom_evaluation_failed subject={} workspaceId={}"
                    + " failureType={}", subjectId, workspaceId, e.getClass().getSimpleName(), e);
            return Set.of();
        }
        Set<String> names = new LinkedHashSet<>();
        atoms.forEach(atom -> names.add(atom.actionClass()));
        return Set.copyOf(names);
    }

    /**
     * W3-2a {@code MANAGE_ROLES} gate as a service call, for the paths whose decision needs the
     * resource row first (for example a workspace-scoped binding write).
     */
    public void requireManageRoles() {
        if (!holdsActionAtom(ToolFaceRegistry.ACTION_MANAGE_ROLES)) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "MANAGE_ROLES is required to administer access roles");
        }
    }

    /**
     * W3-2a: a workspace-scope binding write additionally requires
     * {@code MANAGE_WORKSPACE_AGENTS} <b>in that workspace</b> (design §3.5). An instance-scope
     * binding of that atom covers every workspace (decision #27), a workspace binding covers its
     * own workspace only.
     */
    public void requireWorkspaceBindingAuthority(UUID workspaceId) {
        UUID subjectId = currentSubjectId();
        if (subjectId == null
                || !holdsActionAtom(subjectId, ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS,
                workspaceId)) {
            logger.warn("[POLICY] event=binding_write_denied workspaceId={} reason=no_manage_workspace_agents",
                    workspaceId);
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "MANAGE_WORKSPACE_AGENTS is required to administer this workspace's bindings");
        }
    }

    /**
     * Escalation check (design §5 {@code 403 PRIVILEGE_ESCALATION}): every atom of the roles being
     * bound must already be held by the caller in the same scope. Action atoms are compared against
     * the scoped grant union; capability atoms against {@link AuthzContext}, which is where they
     * live.
     */
    public void requireMayGrant(Set<String> requestedAtoms, UUID workspaceId) {
        UUID subjectId = currentSubjectId();
        if (subjectId == null) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "Authentication required");
        }
        Set<String> held = actionAtoms(subjectId, workspaceId);
        AuthzContext.Capabilities capabilities = authzContext.capabilitiesFor(subjectId);
        for (String atom : requestedAtoms) {
            boolean allowed = PermissionAtomCatalog.isCapabilityAtom(atom)
                    ? mayGrantCapability(capabilities, atom, workspaceId)
                    : held.contains(atom);
            if (!allowed) {
                logger.warn("[POLICY] event=binding_write_denied atom={} workspaceId={}"
                        + " reason=privilege_escalation", atom, workspaceId);
                throw new CpApiException(HttpStatus.FORBIDDEN, "PRIVILEGE_ESCALATION",
                        "Cannot grant an atom the caller does not hold: " + atom);
            }
        }
    }

    private static boolean mayGrantCapability(AuthzContext.Capabilities capabilities, String atom,
                                              UUID workspaceId) {
        return switch (atom) {
            case PermissionAtomCatalog.CAP_INSTANCE_SUPER -> capabilities.isInstanceSuper();
            case PermissionAtomCatalog.CAP_INSTANCE_ADMIN ->
                    capabilities.isInstanceAdmin() || capabilities.isInstanceSuper();
            case PermissionAtomCatalog.CAP_WORKSPACE_ADMIN -> workspaceId == null
                    ? capabilities.isInstanceAdmin() || capabilities.isInstanceSuper()
                    || capabilities.workspaceAdminAll()
                    : capabilities.canWorkspaceAdmin(workspaceId)
                    || capabilities.isInstanceAdmin() || capabilities.isInstanceSuper();
            default -> false;
        };
    }

    /** The caller holds {@code MANAGE_ROLES}; used by unit tests and callers outside SpEL. */
    public boolean canManageRoles() {
        return holdsActionAtom(ToolFaceRegistry.ACTION_MANAGE_ROLES);
    }

    private static UUID parse(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value.trim());
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
