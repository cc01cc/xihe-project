package com.cc01cc.p.xihe.cp.policy;

import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;

import java.util.LinkedHashSet;
import java.util.Optional;
import java.util.Set;

/**
 * PLAN-0610 W1b (design §12 R2-5): the single {@code cap:<atom>} authority vocabulary.
 *
 * <p>Authorities are the only place a "role" name is allowed to survive: the authentication chain
 * turns the subject's capability bindings into {@code cap:...} authorities
 * ({@link AuthzContext}), and every method-body decision reads a capability, never
 * {@code ROLE_ADMIN} or {@code TenantContext.getUserRole()}. {@code ROLE_<role>} and
 * {@code ROLE_INTERNAL_SERVICE} remain as <b>compatibility</b> authorities only:</p>
 *
 * <ul>
 *   <li>{@code ROLE_INTERNAL_SERVICE} still guards {@code /internal/v1/**} and the nine
 *       {@code @PreAuthorize("hasRole('INTERNAL_SERVICE')")} endpoints (service authentication is
 *       not user authorization — R2-5 keeps it untouched);</li>
 *   <li>{@code ROLE_USER}/{@code ROLE_ADMIN} stay until W1b-2 rewrites the 121
 *       {@code @PreAuthorize} expressions; no decision in this wave may use them.</li>
 * </ul>
 *
 * <p>Workspace-scoped capability ({@code workspace:admin}) is deliberately <b>not</b> an
 * authority — it depends on the request workspace — and is answered by
 * {@link AuthzContext#canWorkspaceAdmin(java.util.UUID)}, not here.</p>
 */
public final class CapabilityAuthorities {

    /** {@code hasAuthority('cap:instance:admin')} — instance administration. */
    public static final String CAP_INSTANCE_ADMIN =
            PermissionAtomCatalog.authorityOf(PermissionAtomCatalog.CAP_INSTANCE_ADMIN);

    /** {@code cap:instance:super} — the built-in SUPER_ADMIN capability. */
    public static final String CAP_INSTANCE_SUPER =
            PermissionAtomCatalog.authorityOf(PermissionAtomCatalog.CAP_INSTANCE_SUPER);

    /** Service identity capability; mirrors {@link #LEGACY_ROLE_INTERNAL_SERVICE}. */
    public static final String CAP_INTERNAL_SERVICE = PermissionAtomCatalog.AUTHORITY_PREFIX
            + "internal_service";

    /** Compatibility authority for {@code /internal/**} and the nine internal annotations. */
    public static final String LEGACY_ROLE_INTERNAL_SERVICE = "ROLE_INTERNAL_SERVICE";

    private CapabilityAuthorities() {
    }

    /** Every {@code cap:} authority granted to the given authentication. */
    public static Set<String> capabilities(Authentication authentication) {
        if (authentication == null) {
            return Set.of();
        }
        Set<String> capabilities = new LinkedHashSet<>();
        for (GrantedAuthority authority : authentication.getAuthorities()) {
            String name = authority.getAuthority();
            if (name != null && name.startsWith(PermissionAtomCatalog.AUTHORITY_PREFIX)) {
                capabilities.add(name);
            }
        }
        return Set.copyOf(capabilities);
    }

    public static boolean hasCapability(Authentication authentication, String capability) {
        if (authentication == null || capability == null) {
            return false;
        }
        for (GrantedAuthority authority : authentication.getAuthorities()) {
            if (capability.equals(authority.getAuthority())) {
                return true;
            }
        }
        return false;
    }

    /** Current-request variant of {@link #hasCapability(Authentication, String)}. */
    public static boolean hasCapability(String capability) {
        return hasCapability(currentAuthentication(), capability);
    }

    /** Instance administration, derived from the binding-backed capability only. */
    public static boolean isInstanceAdmin(Authentication authentication) {
        return hasCapability(authentication, CAP_INSTANCE_ADMIN);
    }

    public static boolean isInstanceAdmin() {
        return isInstanceAdmin(currentAuthentication());
    }

    public static boolean isInstanceSuper(Authentication authentication) {
        return hasCapability(authentication, CAP_INSTANCE_SUPER);
    }

    public static boolean isInternalService(Authentication authentication) {
        return hasCapability(authentication, CAP_INTERNAL_SERVICE)
                || hasCapability(authentication, LEGACY_ROLE_INTERNAL_SERVICE);
    }

    private static Authentication currentAuthentication() {
        return Optional.ofNullable(SecurityContextHolder.getContext().getAuthentication())
                .orElse(null);
    }
}
