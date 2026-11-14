package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.stereotype.Component;

import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/** Evaluates canonical permission atoms by unioning one principal's grants, then intersecting a path. */
@Component
public class GrantIntersectionEvaluator {

    private static final Set<String> ACTION_CLASSES = ToolFaceRegistry.builtinActionClasses();

    public record PermissionAtom(String actionClass, String resource) {
        public PermissionAtom {
            if (!ACTION_CLASSES.contains(actionClass)) {
                throw new IllegalArgumentException("Unknown actionClass: " + actionClass);
            }
            if (resource == null || resource.isBlank()) {
                resource = "*";
            }
            // PLAN-0496 #2 (I1): credential atoms carry only the canonical resource forms —
            // credential:<uuid> or credential:*; the bare '*' / partial globs are not allowed.
            if (ToolFaceRegistry.isCredentialActionClass(actionClass)
                    && !ToolFaceRegistry.isCanonicalCredentialResource(resource)) {
                throw new IllegalArgumentException(
                        "credential resource must be credential:* or credential:<uuid>: " + resource);
            }
        }
    }

    /** Parses an array of {actionClass, resource?} atoms. Missing resource means wildcard. */
    public Set<PermissionAtom> parse(JsonNode permissions) {
        if (permissions == null || !permissions.isArray()) {
            throw new IllegalArgumentException("permissions must be an atom array");
        }
        Set<PermissionAtom> atoms = new LinkedHashSet<>();
        for (JsonNode atom : permissions) {
            if (!atom.isObject()) {
                throw new IllegalArgumentException("permission atom must be an object");
            }
            atom.fieldNames().forEachRemaining(field -> {
                if (!"actionClass".equals(field) && !"resource".equals(field)) {
                    throw new IllegalArgumentException("Unknown permission atom field: " + field);
                }
            });
            JsonNode actionClass = atom.get("actionClass");
            JsonNode resource = atom.get("resource");
            if (actionClass == null || !actionClass.isTextual()
                    || (resource != null && !resource.isTextual())) {
                throw new IllegalArgumentException("permission atom requires string actionClass/resource fields");
            }
            atoms.add(new PermissionAtom(actionClass.asText(), resource == null ? "*" : resource.asText()));
        }
        return Set.copyOf(atoms);
    }

    /** Grant sources add permissions to one principal; source labels do not create precedence. */
    public Set<PermissionAtom> union(Collection<AuthorizationGrant> grants) {
        if (grants == null || grants.isEmpty()) {
            return Set.of();
        }
        Set<PermissionAtom> result = new LinkedHashSet<>();
        for (AuthorizationGrant grant : grants) {
            if (grant == null) {
                throw new IllegalArgumentException("grant must not be null");
            }
            result.addAll(parse(grant.getPermissions()));
        }
        return Set.copyOf(result);
    }

    /** task-521 seam: id -> root scope. Default null => fs: keys fall back (test wiring only). */
    private java.util.function.Function<String, ResourceIdentity.RootScope> scopeResolver = id -> null;

    /** task-521: inject the root-scope resolver (pure-function tests / future wiring). */
    public void useScopeResolver(java.util.function.Function<String, ResourceIdentity.RootScope> resolver) {
        this.scopeResolver = resolver == null ? id -> null : resolver;
    }

    /**
     * Q-d: when both sides are {@code fs:} declaration keys, resolve them to {@code phys:} and
     * compare THERE (never as strings, 501 §10.4 #7). Anything else uses the shared matcher.
     */
    public boolean matchesResource(String grantResource, String requestResource, ToolShape shape) {
        Boolean physical = ResourceIdentity.matchesDeclaration(grantResource, requestResource, scopeResolver);
        if (physical != null) {
            return physical;
        }
        return LayeredPolicyResolver.matches(grantResource, requestResource, shape);
    }

    /** Every requested atom must be granted by every principal in the operation path. */
    public boolean allows(PolicyRequest request, List<Set<PermissionAtom>> principalPath) {
        if (request == null || request.actionClasses().isEmpty() || request.resources().isEmpty()
                || principalPath == null || principalPath.isEmpty()) {
            return false;
        }
        for (String actionClass : request.actionClasses()) {
            if (!ACTION_CLASSES.contains(actionClass)) {
                return false;
            }
            for (String resource : request.resources()) {
                if (resource == null || resource.isBlank()) {
                    return false;
                }
                for (Set<PermissionAtom> principalPermissions : principalPath) {
                    if (principalPermissions == null || principalPermissions.stream().noneMatch(atom ->
                            atom.actionClass().equals(actionClass)
                                    && matchesResource(atom.resource(), resource, request.shape()))) {
                        return false;
                    }
                }
            }
        }
        return true;
    }
}
