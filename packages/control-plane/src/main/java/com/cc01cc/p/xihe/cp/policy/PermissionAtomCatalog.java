package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.springframework.http.HttpStatus;

import java.util.LinkedHashMap;
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
 *       agent spawning, credentials).</li>
 *   <li>{@link #SCOPE_CLASS_BOTH} — bindable in either scope. This covers the file/exec/network
 *       atoms, the workspace-management atoms ({@code MANAGE_WORKSPACE_AGENTS},
 *       {@code CREATE_SCHEDULED_TASK}, {@code MANAGE_SCHEDULED_TASK}) and
 *       {@code workspace:admin}: an instance-scope binding of them means "in every workspace",
 *       which is the same shape as {@code workspace:admin(both)}.</li>
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

    public record Atom(String name, String scopeClass, boolean capability, String canonicalResource) {

        public boolean instanceOnly() {
            return SCOPE_CLASS_INSTANCE.equals(scopeClass);
        }

        /** Decision #27: instance scope accepts everything; workspace scope rejects instance-only. */
        public boolean bindableIn(String scopeType) {
            return AccessScope.INSTANCE.equals(scopeType) || !instanceOnly();
        }
    }

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
            ToolFaceRegistry.ACTION_MEMORY_WRITE);

    private static final List<String> CAPABILITY_ATOM_NAMES = List.of(
            CAP_INSTANCE_SUPER, CAP_INSTANCE_ADMIN, CAP_WORKSPACE_ADMIN);

    /** Decision #27: the atoms that may only be bound in the instance scope. */
    private static final Set<String> INSTANCE_ONLY_ATOMS = Set.of(
            ToolFaceRegistry.ACTION_CREDENTIAL_USE,
            ToolFaceRegistry.ACTION_CREDENTIAL_REVEAL,
            ToolFaceRegistry.ACTION_CREDENTIAL_MANAGE,
            ToolFaceRegistry.ACTION_CREATE_ACCOUNT,
            ToolFaceRegistry.ACTION_CREATE_TEMPLATE,
            ToolFaceRegistry.ACTION_SPAWN_AGENT,
            ToolFaceRegistry.ACTION_MANAGE_ROLES,
            // PLAN-0622 D8: "create your own agent" is a user capability; a workspace-scoped
            // binding of it would be meaningless, so it is instance-bindable only.
            ToolFaceRegistry.ACTION_OWN_AGENT,
            CAP_INSTANCE_SUPER,
            CAP_INSTANCE_ADMIN);

    private static final Map<String, Atom> ATOMS = buildAtoms();

    private PermissionAtomCatalog() {
    }

    private static Map<String, Atom> buildAtoms() {
        Map<String, Atom> atoms = new LinkedHashMap<>();
        for (String name : ACTION_ATOM_NAMES) {
            atoms.put(name, new Atom(name, scopeClassOfName(name), false, actionResource(name)));
        }
        for (String name : CAPABILITY_ATOM_NAMES) {
            atoms.put(name, new Atom(name, scopeClassOfName(name), true, WILDCARD));
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
