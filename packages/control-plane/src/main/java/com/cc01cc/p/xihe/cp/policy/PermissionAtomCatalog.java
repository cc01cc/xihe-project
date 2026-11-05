package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.springframework.http.HttpStatus;

import java.util.LinkedHashMap;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * PLAN-0610 T1.2/T1.15: the permission vocabulary of the access-role model.
 *
 * <p>Two kinds of atom exist and they are <b>not</b> interchangeable:</p>
 *
 * <ul>
 *   <li><b>Action atoms (17)</b> — the {@link ToolFaceRegistry#builtinActionClasses() built-in
 *       action classes}. They are the only atoms that may be materialized into
 *       {@code grants.permissions}; {@code GrantIntersectionEvaluator.PermissionAtom} throws for
 *       anything else, so a non-action atom inside a grant would fail every evaluation closed.</li>
 *   <li><b>Capability atoms (3)</b> — {@code instance:super}, {@code instance:admin},
 *       {@code workspace:admin}. They answer "is this subject an administrator", not "may this
 *       subject perform action X on resource Y". They are resolved from the bindings at
 *       authentication time by {@link AuthzContext} and are <b>never</b> written to
 *       {@code grants} (decision #23).</li>
 * </ul>
 *
 * <p>{@code scope_class} is the SSOT of this class (a {@code role_permissions} row stores the
 * atom name only, round-2 P1). Decision #27 collapses the vocabulary to exactly two classes:</p>
 *
 * <ul>
 *   <li>{@link #SCOPE_CLASS_INSTANCE} — bindable in the instance scope only: the instance
 *       capabilities plus the atoms that act on the instance itself (accounts, roles, templates,
 *       credentials).</li>
 *   <li>{@link #SCOPE_CLASS_BOTH} — bindable in either scope. This covers the file/exec/network
 *       atoms, the workspace-management atoms ({@code MANAGE_WORKSPACE_AGENTS},
 *       {@code CREATE_SCHEDULED_TASK}, {@code MANAGE_SCHEDULED_TASK}),
 *       {@code SPAWN_AGENT} and {@code workspace:admin}: an instance-scope binding of them means
 *       "in every workspace", which is the same shape as {@code workspace:admin(both)}.</li>
 *   <li><b>SPAWN_AGENT is workspace-executable, not instance-only</b> (2026-11-04 ruling, task-25):
 *       its effect is "create a child Session/Run inside the same workspace" and the authorization
 *       path resolves the <b>session's agent principal</b> grants, not the human's. Keeping it in
 *       {@link #INSTANCE_ONLY_ATOMS} blocked both the workspace binding
 *       ({@code 400 ROLE_SCOPE_MISMATCH}) and every agent principal
 *       ({@link #agentPrincipalForbiddenAtoms()} includes the instance-only set) — i.e. it made
 *       agent delegation impossible regardless of role. Instance-only stays for actions that act on
 *       the whole instance (accounts, roles, templates, credentials).</li>
 * </ul>
 *
 * <p>The remaining risk — an instance-level capability leaking down to one workspace — is guarded
 * by the {@code instance} class: a workspace binding that carries one is rejected at write time
 * with {@code 400 ROLE_SCOPE_MISMATCH}, never silently dropped (decision #12).</p>
 */
public final class PermissionAtomCatalog {

    public static final String SCOPE_CLASS_INSTANCE = "instance";
    public static final String SCOPE_CLASS_BOTH = "both";

    public static final String CAP_INSTANCE_SUPER = "instance:super";
    public static final String CAP_INSTANCE_ADMIN = "instance:admin";
    public static final String CAP_WORKSPACE_ADMIN = "workspace:admin";

    /** Authority prefix contract (round-2 P1-4): {@code hasAuthority("cap:instance:admin")}. */
    public static final String AUTHORITY_PREFIX = "cap:";

    /** Canonical resource pattern of a wildcard atom (mirrors the {@code permissions} shape). */
    public static final String WILDCARD = "*";

    public record Atom(String name, String scopeClass, boolean capability, String canonicalResource,
                       boolean agentPrincipalForbidden) {

        public boolean instanceOnly() {
            return SCOPE_CLASS_INSTANCE.equals(scopeClass);
        }

        /** Decision #27: instance scope accepts everything; workspace scope rejects instance-only. */
        public boolean bindableIn(String scopeType) {
            return AccessScope.INSTANCE.equals(scopeType) || !instanceOnly();
        }
    }

    /**
     * PLAN-0651 M2 (Lead ruling 2026-11-05): the <b>one</b> source of truth for "an agent principal
     * may never hold this atom" — instance-domain administration, credentials, account/template/role
     * and principal management, the three capability atoms, and the workspace-management faces.
     *
     * <p>The rule in one sentence: <b>instance-domain things are off limits to an agent; workspace
     * things are decided by the workspace owner through roles.</b> That is why N5–N9
     * ({@code MANAGE_SKILL_LIBRARY}, {@code MANAGE_PROVIDER_CONNECTIONS},
     * {@code USE_WORKSPACE_RUNTIME}, {@code MANAGE_WORKSPACE_RUNTIME},
     * {@code MANAGE_WORKSPACE_POLICY}) are deliberately <b>not</b> here: forbidding them made every
     * {@code WS_EDITOR} role unbindable to an agent and would also forbid an agent from running code
     * ({@code USE_WORKSPACE_RUNTIME}).</p>
     */
    private static final Set<String> AGENT_FORBIDDEN_ATOMS = Set.of(
            // instance-domain content / secret
            ToolFaceRegistry.ACTION_READ_INSTANCE_CONTENT,
            ToolFaceRegistry.ACTION_WRITE_INSTANCE_CONTENT,
            ToolFaceRegistry.ACTION_VIEW_SECRET_CONTENT,
            // credentials
            ToolFaceRegistry.ACTION_CREDENTIAL_USE,
            ToolFaceRegistry.ACTION_CREDENTIAL_REVEAL,
            ToolFaceRegistry.ACTION_CREDENTIAL_MANAGE,
            // accounts / templates / roles / principals
            ToolFaceRegistry.ACTION_CREATE_ACCOUNT,
            ToolFaceRegistry.ACTION_CREATE_TEMPLATE,
            ToolFaceRegistry.ACTION_MANAGE_ROLES,
            // PLAN-0673 M2 (D-166): an agent principal may never hold the human grant bypass.
            ToolFaceRegistry.ACTION_GRANT_ANY_ATOM,
            ToolFaceRegistry.ACTION_OWN_AGENT,
            ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS,
            // caps
            CAP_INSTANCE_SUPER,
            CAP_INSTANCE_ADMIN,
            CAP_WORKSPACE_ADMIN,
            // workspace management faces
            ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS,
            ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS);

    private static final List<String> ACTION_ATOM_NAMES = List.of(
            ToolFaceRegistry.ACTION_READ,
            ToolFaceRegistry.ACTION_WRITE,
            ToolFaceRegistry.ACTION_DELETE,
            ToolFaceRegistry.ACTION_EXEC,
            ToolFaceRegistry.ACTION_NETWORK,
            ToolFaceRegistry.ACTION_CREDENTIAL_USE,
            ToolFaceRegistry.ACTION_CREDENTIAL_REVEAL,
            ToolFaceRegistry.ACTION_CREDENTIAL_MANAGE,
            ToolFaceRegistry.ACTION_CREATE_ACCOUNT,
            ToolFaceRegistry.ACTION_CREATE_TEMPLATE,
            ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS,
            ToolFaceRegistry.ACTION_SPAWN_AGENT,
            ToolFaceRegistry.ACTION_CREATE_SCHEDULED_TASK,
            ToolFaceRegistry.ACTION_MANAGE_SCHEDULED_TASK,
            ToolFaceRegistry.ACTION_MANAGE_ROLES,
            // PLAN-0622 D8: user tier — create one's own PERSONAL agent principal.
            ToolFaceRegistry.ACTION_OWN_AGENT,
            // PLAN-0629 D29-24/34: the agent tool channel writing subject memory. Stored as an atom
            // and deliberately seeded into NO default role, which is the mechanical form of
            // "tool writes are denied by default". Scope class stays `both`: memory is isolated by
            // (principal, workspace), so a workspace-scoped grant is meaningful (an instance-scoped
            // one means "in every workspace", the same shape as workspace:admin).
            ToolFaceRegistry.ACTION_MEMORY_WRITE,
            // PLAN-0651 M1 (D51-26/D51-27): management atoms replacing the coarse
            // instance-administrator bypass on the agent-principal and member faces.
            ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS,
            ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS,
            // PLAN-0651 M2 T2.1 (D51-27): the P1 face atoms. 19 + 8 = 27 action atoms; the terminal
            // count 27 = the 17 original atoms + the 10 this plan adds (N1/N10 landed in M1).
            ToolFaceRegistry.ACTION_READ_INSTANCE_CONTENT,
            ToolFaceRegistry.ACTION_WRITE_INSTANCE_CONTENT,
            ToolFaceRegistry.ACTION_VIEW_SECRET_CONTENT,
            ToolFaceRegistry.ACTION_MANAGE_SKILL_LIBRARY,
            ToolFaceRegistry.ACTION_MANAGE_PROVIDER_CONNECTIONS,
            ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME,
            ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_RUNTIME,
            ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY,
            // PLAN-0673 M2 (D-166): the grant-side subset bypass. Instance-only, SUPER_ADMIN-only
            // default, audited on every use — never a role-name special case.
            ToolFaceRegistry.ACTION_GRANT_ANY_ATOM);

    private static final List<String> CAPABILITY_ATOM_NAMES = List.of(
            CAP_INSTANCE_SUPER, CAP_INSTANCE_ADMIN, CAP_WORKSPACE_ADMIN);

    /** Decision #27: the atoms that may only be bound in the instance scope. */
    private static final Set<String> INSTANCE_ONLY_ATOMS = Set.of(
            ToolFaceRegistry.ACTION_CREDENTIAL_USE,
            ToolFaceRegistry.ACTION_CREDENTIAL_REVEAL,
            ToolFaceRegistry.ACTION_CREDENTIAL_MANAGE,
            ToolFaceRegistry.ACTION_CREATE_ACCOUNT,
            ToolFaceRegistry.ACTION_CREATE_TEMPLATE,
            ToolFaceRegistry.ACTION_MANAGE_ROLES,
            // PLAN-0673 M2 (D-166): bypassing the subset rule is instance-wide authority.
            ToolFaceRegistry.ACTION_GRANT_ANY_ATOM,
            // PLAN-0622 D8: "create your own agent" is a user capability; a workspace-scoped
            // binding of it would be meaningless, so it is instance-bindable only.
            ToolFaceRegistry.ACTION_OWN_AGENT,
            // PLAN-0651 M1 (D51-26): instance-level agent-principal authority acts on the instance.
            ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS,
            // PLAN-0651 M2 T2.1: reading/writing instance content and revealing secrets all act on
            // the whole instance, so they stay instance-bindable only (decision #27).
            ToolFaceRegistry.ACTION_READ_INSTANCE_CONTENT,
            ToolFaceRegistry.ACTION_WRITE_INSTANCE_CONTENT,
            ToolFaceRegistry.ACTION_VIEW_SECRET_CONTENT,
            CAP_INSTANCE_SUPER,
            CAP_INSTANCE_ADMIN);

    private static final Map<String, Atom> ATOMS = buildAtoms();

    /**
     * PLAN-0651 D51-30: the <b>only</b> implication chain, and it is used <b>solely</b> by
     * {@code RequesterAuthority.mayGrantCapability} (the escalation check). It is deliberately NOT
     * applied to default sets: a built-in role receives N1–N10 through explicit seeds (greppable,
     * auditable), and a custom role never inherits anything implicitly.
     */
    private static final Map<String, Set<String>> IMPLIES = Map.of(
            CAP_INSTANCE_SUPER, Set.of(CAP_INSTANCE_ADMIN, CAP_WORKSPACE_ADMIN),
            CAP_INSTANCE_ADMIN, Set.of(CAP_WORKSPACE_ADMIN));

    /** True when holding {@code holder} also satisfies {@code target} in the grant-check sense. */
    public static boolean implies(String holder, String target) {
        return IMPLIES.getOrDefault(holder, Set.of()).contains(target);
    }

    /** The capability atoms whose holding implies {@code target} (empty when none). */
    public static Set<String> impliedHolders(String target) {
        return IMPLIES.entrySet().stream()
                .filter(entry -> entry.getValue().contains(target))
                .map(Map.Entry::getKey)
                .collect(java.util.stream.Collectors.toUnmodifiableSet());
    }

    private PermissionAtomCatalog() {
    }

    private static Map<String, Atom> buildAtoms() {
        Map<String, Atom> atoms = new LinkedHashMap<>();
        for (String name : ACTION_ATOM_NAMES) {
            atoms.put(name, new Atom(name, scopeClassOfName(name), false, actionResource(name),
                    AGENT_FORBIDDEN_ATOMS.contains(name)));
        }
        for (String name : CAPABILITY_ATOM_NAMES) {
            atoms.put(name, new Atom(name, scopeClassOfName(name), true, WILDCARD,
                    AGENT_FORBIDDEN_ATOMS.contains(name)));
        }
        return Map.copyOf(atoms);
    }

    private static String scopeClassOfName(String name) {
        return INSTANCE_ONLY_ATOMS.contains(name) ? SCOPE_CLASS_INSTANCE : SCOPE_CLASS_BOTH;
    }

    private static String actionResource(String actionClass) {
        return ToolFaceRegistry.isCredentialActionClass(actionClass)
                ? ToolFaceRegistry.CREDENTIAL_RESOURCE_WILDCARD
                : WILDCARD;
    }

    /** The 17 action atoms, in canonical order. */
    public static List<String> actionAtoms() {
        return ACTION_ATOM_NAMES;
    }

    /** The 3 capability atoms, in canonical order. */
    public static List<String> capabilityAtoms() {
        return CAPABILITY_ATOM_NAMES;
    }

    public static Set<String> allAtomNames() {
        return ATOMS.keySet();
    }

    /** The instance-only atom set of decision #27 (the write-time scope guard). */
    public static Set<String> instanceOnlyAtoms() {
        return INSTANCE_ONLY_ATOMS;
    }

    /**
     * PLAN-0629 (user ruling 2026-11-04): action classes an <b>agent principal</b> may never be
     * granted, because the agent is a grantee and not an administrator. The rule is atom-based, not
     * role-name based, so it keeps holding when a new role is invented from those atoms.
     *
     * <p>Derived from the vocabulary, never from a role list: every capability atom (they answer
     * "is this subject an administrator"), every instance-only atom (the instance management set),
     * plus the workspace-administration atoms — an agent may be managed by a workspace owner, it
     * must not manage the workspace or other subjects.</p>
     */
    public static Set<String> agentPrincipalForbiddenAtoms() {
        // Derived from the per-atom metadata below (single source of truth): an atom joins the set
        // by carrying the flag, never by a second hand-maintained list.
        java.util.LinkedHashSet<String> forbidden = new java.util.LinkedHashSet<>();
        for (Atom atom : ATOMS.values()) {
            if (atom.agentPrincipalForbidden()) {
                forbidden.add(atom.name());
            }
        }
        return Set.copyOf(forbidden);
    }

    /** True when a role made of these atoms may be bound to an agent principal. */
    public static boolean canBindToAgentPrincipal(Collection<String> roleAtomNames) {
        if (roleAtomNames == null || roleAtomNames.isEmpty()) {
            return true;
        }
        Set<String> forbidden = agentPrincipalForbiddenAtoms();
        for (String atomName : roleAtomNames) {
            if (forbidden.contains(atomName)) {
                return false;
            }
        }
        return true;
    }

    /** The first forbidden atom of a role, for a precise {@code detail} (never a silent refusal). */
    public static String firstForbiddenAgentPrincipalAtom(Collection<String> roleAtomNames) {
        if (roleAtomNames == null) {
            return null;
        }
        Set<String> forbidden = agentPrincipalForbiddenAtoms();
        for (String atomName : roleAtomNames) {
            if (forbidden.contains(atomName)) {
                return atomName;
            }
        }
        return null;
    }

    public static boolean isActionAtom(String name) {
        Atom atom = ATOMS.get(name);
        return atom != null && !atom.capability();
    }

    public static boolean isCapabilityAtom(String name) {
        Atom atom = ATOMS.get(name);
        return atom != null && atom.capability();
    }

    public static Atom atom(String name) {
        Atom atom = ATOMS.get(name);
        if (atom == null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "UNKNOWN_ACTION_CLASS",
                    "Unknown permission atom: " + name);
        }
        return atom;
    }

    public static String scopeClassOf(String name) {
        return atom(name).scopeClass();
    }

    /** Rejects (never silently drops) an atom that cannot live in the given binding scope. */
    public static void requireScopeCompatible(String atomName, String scopeType) {
        Atom atom = atom(atomName);
        if (!atom.bindableIn(scopeType)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "ROLE_SCOPE_MISMATCH",
                    "Atom " + atomName + " (scope_class=" + atom.scopeClass()
                            + ") cannot be bound in scope " + scopeType);
        }
    }

    /** Authority string for an instance-level capability: {@code cap:instance:admin}. */
    public static String authorityOf(String capability) {
        return AUTHORITY_PREFIX + capability;
    }
}
