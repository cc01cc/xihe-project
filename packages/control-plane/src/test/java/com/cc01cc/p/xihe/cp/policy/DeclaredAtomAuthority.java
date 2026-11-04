package com.cc01cc.p.xihe.cp.policy;

import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0651 T1.4 test fake: a {@link RequesterAuthority} that answers
 * {@link #holdsActionAtom(UUID, String, UUID)} from an <b>explicitly declared</b> atom set and
 * denies everything else.
 *
 * <p>Why a fake instead of {@code mock(...)+thenReturn(true)}: the real service reads the
 * materialized {@code MANAGE_AGENT_PRINCIPALS} atom (N1). A blanket {@code true} would silently
 * turn "an instance administrator passes" back into an unconditional shortcut and stop asking
 * <em>which atom</em> a management operation needs. Here a test must name the atom, so the
 * assertion documents the authorization fact it stands on.</p>
 *
 * <p><b>Coverage contract (Lead ruling ④):</b> this fake may only be used where the real semantic
 * is covered by an integration test that materializes the seeded role. For the agent-principal
 * surface that is {@code AgentPrincipalScopeContractTest} / {@code AgentPrincipalVisibilityContractTest}
 * / {@code AgentPrincipalHooksHttpTest} / {@code AgentPrincipalContextPolicyHttpTest} (they run
 * against a real Spring context and the seeded ADMIN/SUPER_ADMIN roles). Scope is ignored on
 * purpose: the fake models "the subject holds this atom", which is what the call sites ask.</p>
 */
public final class DeclaredAtomAuthority extends RequesterAuthority {

    private final Set<String> declared;

    /** Denies every atom unless it is declared here. */
    public DeclaredAtomAuthority(String... atoms) {
        super(null, null, null);
        this.declared = Set.of(atoms);
    }

    @Override
    public boolean holdsActionAtom(UUID subjectId, String actionClass, UUID workspaceId) {
        return subjectId != null && actionClass != null && declared.contains(actionClass);
    }

    /**
     * PLAN-0651 T1.5-A1: {@code AgentPrincipalService.requireUserAction} now delegates to the shared
     * kernel entry {@link RequesterAuthority#allowsForUser} (same {@code findScopedGrants} +
     * {@code evaluator.allows} sequence, moved so the two implementations cannot drift). The fake
     * declares the atoms, so the equivalent answer here is "every requested action class is
     * declared" — its resources are {@code *} by construction, and the real resource/shape matching
     * is covered by the real-context contract tests named in the class javadoc.
     */
    @Override
    public boolean allowsForUser(PolicyRequest request, UUID scopeWorkspaceId) {
        if (request == null || request.userId() == null || request.actionClasses().isEmpty()) {
            return false;
        }
        return request.actionClasses().stream().allMatch(declared::contains);
    }
}
