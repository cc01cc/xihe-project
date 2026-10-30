package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.springframework.http.HttpStatus;

import java.util.List;
import java.util.UUID;

/**
 * PLAN-0585: the closed set of user-level action classes the administrator grant surface may write.
 *
 * <p>The surface is deliberately narrow (design decision #4): only {@code CREATE_ACCOUNT} and
 * {@code MANAGE_WORKSPACE_AGENTS}. {@code CREATE_TEMPLATE} keeps its own (missing) write path and
 * is rejected here as unmanageable; anything outside {@link ToolFaceRegistry#builtinActionClasses()}
 * is an unknown class. The three opt-in actions stay independent — nothing here aliases them, and
 * nothing here is added to {@link GrantDefaultService}'s default sets.</p>
 *
 * <p>Resource shape is fixed by how the authorization kernel asks the question
 * ({@code AgentPrincipalService.requireUserAction}): {@code CREATE_ACCOUNT} is always requested with
 * resource {@code "*"} (instance wide), while {@code MANAGE_WORKSPACE_AGENTS} is requested with a
 * concrete workspace id. A narrow or a wildcard resource for the wrong action would be stored but
 * never match, so both are rejected at the write edge.</p>
 */
public final class PrincipalGrantActionCatalog {

    /** Grant row source written by this surface; uniqueness per subject is enforced by V65. */
    public static final String SOURCE_DIRECT = "direct";

    /** Grant row read state; {@code grants.ck_grants_read_state} only allows unread/read. */
    public static final String READ_STATE_READ = "read";

    private static final String WILDCARD = "*";

    private static final List<String> MANAGEABLE_ACTION_CLASSES = List.of(
            ToolFaceRegistry.ACTION_CREATE_ACCOUNT,
            ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS);

    private PrincipalGrantActionCatalog() {}

    /** The manageable action classes, in the canonical order the read view returns them. */
    public static List<String> manageableActionClasses() {
        return MANAGEABLE_ACTION_CLASSES;
    }

    public static boolean manageable(String actionClass) {
        return MANAGEABLE_ACTION_CLASSES.contains(actionClass);
    }

    /**
     * Validates one requested {@code {actionClass, resource?}} atom and returns its canonical form.
     *
     * @throws CpApiException 400 {@code UNKNOWN_ACTION_CLASS} for a class outside the vocabulary,
     *     400 {@code UNMANAGEABLE_ACTION_CLASS} for a known class this surface must not write,
     *     400 {@code INVALID_GRANT_RESOURCE} for a resource that cannot ever be matched
     */
    public static GrantIntersectionEvaluator.PermissionAtom requireManageable(String actionClass,
            String resource) {
        if (actionClass == null || actionClass.isBlank()) {
            throw invalidAtom("actionClass is required");
        }
        if (!ToolFaceRegistry.builtinActionClasses().contains(actionClass)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "UNKNOWN_ACTION_CLASS",
                    "Unknown actionClass");
        }
        if (!manageable(actionClass)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "UNMANAGEABLE_ACTION_CLASS",
                    "This actionClass cannot be granted through this surface");
        }
        return new GrantIntersectionEvaluator.PermissionAtom(actionClass,
                canonicalResource(actionClass, resource));
    }

    private static String canonicalResource(String actionClass, String resource) {
        String trimmed = resource == null ? "" : resource.trim();
        if (ToolFaceRegistry.ACTION_CREATE_ACCOUNT.equals(actionClass)) {
            if (trimmed.isEmpty() || WILDCARD.equals(trimmed)) {
                return WILDCARD;
            }
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_GRANT_RESOURCE",
                    "CREATE_ACCOUNT is instance wide and only accepts resource '*'");
        }
        if (trimmed.isEmpty() || WILDCARD.equals(trimmed)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_GRANT_RESOURCE",
                    "MANAGE_WORKSPACE_AGENTS requires a concrete workspace UUID, not '*'");
        }
        try {
            UUID workspaceId = UUID.fromString(trimmed);
            // Reject the shorthand spellings UUID#fromString tolerates (e.g. "1-2-3-4-5").
            if (!workspaceId.toString().equalsIgnoreCase(trimmed)) {
                throw invalidWorkspaceResource();
            }
            return workspaceId.toString();
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_GRANT_RESOURCE",
                    "MANAGE_WORKSPACE_AGENTS resource must be a workspace UUID", e);
        }
    }

    private static CpApiException invalidWorkspaceResource() {
        return new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_GRANT_RESOURCE",
                "MANAGE_WORKSPACE_AGENTS resource must be a workspace UUID");
    }

    private static CpApiException invalidAtom(String detail) {
        return new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", detail);
    }
}
