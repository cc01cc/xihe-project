package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0610 T1.2: the built-in access-role catalog.
 *
 * <p>V87 seeds these rows for PostgreSQL; this class is the same catalog expressed in code so a
 * schema built from the entities (the H2 test profile, where Flyway is disabled) is seeded too,
 * and so `scope_class` stays in {@link PermissionAtomCatalog} (round-2 P1). The two sides must
 * agree: {@code DynamicAccessRoleMigrationTest} asserts the migrated rows equal
 * {@link #roleSeeds()}, which turns any drift into a failing test instead of a silent split.</p>
 *
 * <p>Ids are fixed constants shared with V87 so the bootstrap is idempotent and cross-checkable.</p>
 */
@Component
public class SystemAccessRoleCatalog {

    private static final Logger logger = LoggerFactory.getLogger(SystemAccessRoleCatalog.class);

    public static final UUID SUPER_ADMIN_ID = UUID.fromString("00000000-0000-4000-8000-000000000001");
    public static final UUID ADMIN_ID = UUID.fromString("00000000-0000-4000-8000-000000000002");
    public static final UUID USER_ID = UUID.fromString("00000000-0000-4000-8000-000000000003");
    public static final UUID WS_OWNER_ID = UUID.fromString("00000000-0000-4000-8000-000000000004");
    public static final UUID WS_EDITOR_ID = UUID.fromString("00000000-0000-4000-8000-000000000005");
    public static final UUID WS_VIEWER_ID = UUID.fromString("00000000-0000-4000-8000-000000000006");
    /** 2026-11-04 ruling (task-25): the non-administrative delegation role for agent principals. */
    public static final UUID AGENT_DELEGATOR_ID = UUID.fromString("00000000-0000-4000-8000-000000000007");
    /**
     * D-174 (user ruling): the default instance role bound to a freshly created agent principal.
     * Originally "human USER minus {@code CREATE_OWN_AGENT}"; BL-312 (user ruling 2026-11-09)
     * removed that atom from the vocabulary entirely, so AGENT_USER is now simply the base set.
     * Human USER stays untouched apart from the same atom removal; migration V127 rebinds the
     * legacy agent seed bindings (stack-1: 40 rows).
     */
    public static final UUID AGENT_USER_ID = UUID.fromString("00000000-0000-4000-8000-000000000008");

    public static final String SUPER_ADMIN = "SUPER_ADMIN";
    public static final String ADMIN = "ADMIN";
    public static final String USER = "USER";
    public static final String WS_OWNER = "WS_OWNER";
    public static final String WS_EDITOR = "WS_EDITOR";
    public static final String WS_VIEWER = "WS_VIEWER";
    public static final String AGENT_DELEGATOR = "AGENT_DELEGATOR";
    /** D-174: agent default instance role (the base set; BL-312 removed CREATE_OWN_AGENT). */
    public static final String AGENT_USER = "AGENT_USER";

    /** The three instance-level system roles, used to keep one tier binding per user. */
    public static final List<String> INSTANCE_TIER_ROLES = List.of(SUPER_ADMIN, ADMIN, USER);

    public record AtomRef(String actionClass, String resourcePattern) {

        static AtomRef wildcard(String actionClass) {
            return new AtomRef(actionClass,
                    ToolFaceRegistry.isCredentialActionClass(actionClass)
                            ? ToolFaceRegistry.CREDENTIAL_RESOURCE_WILDCARD
                            : PermissionAtomCatalog.WILDCARD);
        }
    }

    public record RoleSeed(UUID id, String name, String displayName, String description, List<AtomRef> atoms) {
    }

    private static final List<AtomRef> CREDENTIAL_ATOMS = List.of(
            AtomRef.wildcard(ToolFaceRegistry.ACTION_CREDENTIAL_USE),
            AtomRef.wildcard(ToolFaceRegistry.ACTION_CREDENTIAL_REVEAL),
            AtomRef.wildcard(ToolFaceRegistry.ACTION_CREDENTIAL_MANAGE));

    private static final List<AtomRef> BASE_ATOMS = List.of(
            AtomRef.wildcard(ToolFaceRegistry.ACTION_READ),
            AtomRef.wildcard(ToolFaceRegistry.ACTION_WRITE),
            AtomRef.wildcard(ToolFaceRegistry.ACTION_DELETE),
            AtomRef.wildcard(ToolFaceRegistry.ACTION_EXEC),
            AtomRef.wildcard(ToolFaceRegistry.ACTION_NETWORK),
            // PLAN-0691 T1.3 (M1) spec B-4: invoking an already-bound BUILTIN plugin is part of the
            // base set every non-viewer account/agent carries. It is deliberately in BASE_ATOMS and
            // not per role, because "builtin ⇒ default set" must be one expression; a third-party
            // plugin gets no default at all (explicit grant only), which is expressed by the atom
            // being the only plugin atom an agent may hold (AGENT_FORBIDDEN_ATOMS excludes it).
            // WS_VIEWER stays out on purpose: invocation executes a tool face, and a read-only role
            // must not be able to run one.
            AtomRef.wildcard(ToolFaceRegistry.ACTION_PLUGIN_INVOKE));

    /**
     * The registration default set. PLAN-0750 M1 (G1 = (1a), user ruling 2026-11-10) restores the
     * own-agent creation atom — with the new user-level semantics: owner = the actor and no
     * Workspace binding is produced. It is deliberately ONE atom, independent of
     * MANAGE_WORKSPACE_AGENTS (workspace tier) and CREATE_ACCOUNT (instance tier): creating for
     * someone else still needs those, and the three are never alias-merged (design #3/#7).
     *
     * <p>ADMIN and SUPER_ADMIN derive from this list (ADMIN {@code concat(USER_DEFAULT_ATOMS, …)},
     * SUPER_ADMIN from {@link #superAdminAtoms()}), so they inherit the atom without a second
     * literal — one expression, no "role missing an atom" hole. AGENT_USER is the bare
     * {@link #BASE_ATOMS} and therefore never carries it (agent-principal-forbidden).</p>
     */
    private static final List<AtomRef> USER_DEFAULT_ATOMS = concat(BASE_ATOMS,
            List.of(
                    // PLAN-0750 M1: an ordinary account may create its own user-level principal.
                    AtomRef.wildcard(ToolFaceRegistry.ACTION_CREATE_OWN_AGENT),
                    // BL-345 (user ruling 2026-11-06): every registered account may write the
                    // memory of a principal it owns. MEMORY_WRITE (any subject) is NOT here.
                    AtomRef.wildcard(ToolFaceRegistry.ACTION_MEMORY_WRITE_SELF)));

    private final AccessRoleRepository roleRepository;
    private final AccessRolePermissionRepository permissionRepository;

    public SystemAccessRoleCatalog(AccessRoleRepository roleRepository,
                                   AccessRolePermissionRepository permissionRepository) {
        this.roleRepository = roleRepository;
        this.permissionRepository = permissionRepository;
    }

    /** The built-in catalog: 3 instance roles (SUPER_ADMIN/ADMIN/USER) + 3 workspace roles. */
    public static List<RoleSeed> roleSeeds() {
        return List.of(
                new RoleSeed(SUPER_ADMIN_ID, SUPER_ADMIN, "Super Administrator",
                        "Instance scope: every action atom plus every capability atom. Immutable.",
                        superAdminAtoms()),
                new RoleSeed(ADMIN_ID, ADMIN, "Administrator",
                        "Instance scope: the user default set plus the three credential atoms, "
                                + "instance:admin, workspace:admin, the PLAN-0651 management "
                                + "atoms (agent principals, workspace members) and MANAGE_ROLES "
                                + "(PLAN-0673 D-168: ADMIN may delegate role management, bounded by "
                                + "the subset rule).",
                        concat(USER_DEFAULT_ATOMS, CREDENTIAL_ATOMS,
                                List.of(AtomRef.wildcard(PermissionAtomCatalog.CAP_INSTANCE_ADMIN),
                                        AtomRef.wildcard(PermissionAtomCatalog.CAP_WORKSPACE_ADMIN),
                                        // PLAN-0673 M3 (D-168, migration V125): ADMIN administers
                                        // roles/bindings, but only within its own atom set (the
                                        // subset guard answers 403 PRIVILEGE_ESCALATION otherwise).
                                        AtomRef.wildcard(ToolFaceRegistry.ACTION_MANAGE_ROLES),
                                        // PLAN-0691 T1.3 (M1) spec B-4: the instance-administrator
                                        // fixed set gains plugin administration and binding. Both are
                                        // agent-forbidden and ADMIN is not an agent-bindable role, so
                                        // BL-349's constraint is untouched. PLUGIN_DATA stays out: no
                                        // human default at all (the data plane belongs to a binding).
                                        AtomRef.wildcard(ToolFaceRegistry.ACTION_PLUGIN_MANAGE),
                                        AtomRef.wildcard(ToolFaceRegistry.ACTION_PLUGIN_BIND),
                                        // D-928 / PLAN-0766 (task-158 contract): the workspace-default
                                        // layer write atom sits in the fixed instance-administrator
                                        // set; the matching seed rows land in Flyway V153.
                                        AtomRef.wildcard(
                                                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_DEFAULT_CONFIG),
                                        AtomRef.wildcard(
                                                ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS),
                                        AtomRef.wildcard(
                                                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS),
                                        // PLAN-0651 M2 T2.1: every P1 atom is in the fixed
                                        // instance-administrator set (D51-27 default grant set).
                                        AtomRef.wildcard(
                                                ToolFaceRegistry.ACTION_READ_INSTANCE_CONTENT),
                                        AtomRef.wildcard(
                                                ToolFaceRegistry.ACTION_WRITE_INSTANCE_CONTENT),
                                        AtomRef.wildcard(
                                                ToolFaceRegistry.ACTION_VIEW_SECRET_CONTENT),
                                        AtomRef.wildcard(
                                                ToolFaceRegistry.ACTION_MANAGE_SKILL_LIBRARY),
                                        AtomRef.wildcard(
                                                ToolFaceRegistry.ACTION_MANAGE_PROVIDER_CONNECTIONS),
                                        AtomRef.wildcard(
                                                ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME),
                                        AtomRef.wildcard(
                                                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_RUNTIME),
                                        AtomRef.wildcard(
                                                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY)))),
                new RoleSeed(USER_ID, USER, "User",
                        "Instance scope: the registration minimal set "
                                + "(read/write/delete/exec/network + PLUGIN_INVOKE) plus the "
                                + "own-agent create atom (PLAN-0750 M1) and the own-principal "
                                + "memory atom.",
                        USER_DEFAULT_ATOMS),
                new RoleSeed(WS_OWNER_ID, WS_OWNER, "Workspace Owner",
                        "Workspace scope: editor actions plus workspace agent management "
                                + "and workspace:admin.",
                        concat(List.of(
                                        AtomRef.wildcard(ToolFaceRegistry.ACTION_READ),
                                        AtomRef.wildcard(ToolFaceRegistry.ACTION_WRITE),
                                        AtomRef.wildcard(ToolFaceRegistry.ACTION_DELETE),
                                        AtomRef.wildcard(ToolFaceRegistry.ACTION_EXEC)),
                                List.of(AtomRef.wildcard(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS),
                                        AtomRef.wildcard(PermissionAtomCatalog.CAP_WORKSPACE_ADMIN),
                                        // BL-345 (user ruling 2026-11-06, B): workspace administrators
                                        // write ANY subject's memory; MEMORY_WRITE implies the self face.
                                        // BL-349 (P0): WS_* roles are bindable to agent principals, so they
                                        // must NOT carry the agent-forbidden self atom — the human USER /
                                        // ADMIN roles provide "write my own" instead.
                                        AtomRef.wildcard(ToolFaceRegistry.ACTION_MEMORY_WRITE),
                                        // PLAN-0691 T1.3 (M1): the owner may invoke bound builtin
                                        // plugins. PLUGIN_BIND is NOT here on purpose — it is
                                        // agent-forbidden and this role is agent-bindable (BL-349),
                                        // so binding stays an instance-administrator act in M1.
                                        AtomRef.wildcard(
                                                ToolFaceRegistry.ACTION_PLUGIN_INVOKE),
                                        // PLAN-0651 M2 T2.1: owner manages skills, providers, runtime
                                        // and workspace policy; N10 (members) stays unassigned by
                                        // ruling D51-26.
                                        AtomRef.wildcard(
                                                ToolFaceRegistry.ACTION_MANAGE_SKILL_LIBRARY),
                                        AtomRef.wildcard(
                                                ToolFaceRegistry.ACTION_MANAGE_PROVIDER_CONNECTIONS),
                                        AtomRef.wildcard(
                                                ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME),
                                        AtomRef.wildcard(
                                                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_RUNTIME),
                                        AtomRef.wildcard(
                                                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY)))),
                new RoleSeed(WS_EDITOR_ID, WS_EDITOR, "Workspace Editor",
                        "Workspace scope: read/write/delete/exec.",
                        List.of(
                                AtomRef.wildcard(ToolFaceRegistry.ACTION_READ),
                                AtomRef.wildcard(ToolFaceRegistry.ACTION_WRITE),
                                AtomRef.wildcard(ToolFaceRegistry.ACTION_DELETE),
                                AtomRef.wildcard(ToolFaceRegistry.ACTION_EXEC),
                                // PLAN-0651 M2 T2.1: editors manage providers, runtime use and
                                // workspace policy; skills stay owner-level and N10 stays unassigned.
                                AtomRef.wildcard(
                                        ToolFaceRegistry.ACTION_MANAGE_PROVIDER_CONNECTIONS),
                                AtomRef.wildcard(ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME),
                                // BL-349: no MEMORY_WRITE_SELF here — WS_* is agent-bindable and the
                                // atom is agent-forbidden; the human USER role carries the self face.
                                // PLAN-0691 T1.3 (M1): PLUGIN_INVOKE is not agent-forbidden, so an
                                // editor may invoke bound builtin plugins; PLUGIN_BIND stays out for
                                // the same BL-349 reason (see WS_OWNER).
                                AtomRef.wildcard(ToolFaceRegistry.ACTION_PLUGIN_INVOKE),
                                AtomRef.wildcard(
                                        ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY))),
                new RoleSeed(WS_VIEWER_ID, WS_VIEWER, "Workspace Viewer",
                        "Workspace scope: read only.",
                        List.of(AtomRef.wildcard(ToolFaceRegistry.ACTION_READ),
                                // BL-349: WS_VIEWER is agent-bindable too; the self atom lives on the
                                // human USER role, never on a workspace role.
                                // PLAN-0651 M2 T2.1: a viewer may use the workspace runtime (read the
                                // environment snapshot) but never manage it.
                                AtomRef.wildcard(
                                        ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME))),
                // 2026-11-04 ruling (task-25): SPAWN_AGENT is a workspace-scoped action atom, so a
                // non-administrative role can carry it and an agent principal may be bound to it.
                // Single atom on purpose: delegation grants nothing else (no MANAGE_* atoms, no
                // instance capability), and it is never granted by default — a workspace owner or
                // instance admin hands it out explicitly.
                new RoleSeed(AGENT_DELEGATOR_ID, AGENT_DELEGATOR, "Agent Delegator",
                        "Workspace scope: delegate by creating child Sessions/Runs inside the same "
                                + "workspace. Intended for agent principals; bound explicitly.",
                        List.of(AtomRef.wildcard(ToolFaceRegistry.ACTION_SPAWN_AGENT))),
                // D-174 (user ruling 2026-11-05): the agent's default INSTANCE role — the base set.
                // Originally "human USER minus CREATE_OWN_AGENT" (agent-principal-forbidden);
                // BL-312 (2026-11-09) removed that atom from the vocabulary entirely, so the two
                // roles now differ only by the human MEMORY_WRITE_SELF atom.
                // Migration V127 rebinds legacy agent seed bindings (stack-1 measured 40) to it.
                new RoleSeed(AGENT_USER_ID, AGENT_USER, "Agent User (default)",
                        "Instance scope: read/write/delete/exec/network + PLUGIN_INVOKE — the "
                                + "agent default base set (BL-312 removed CREATE_OWN_AGENT).",
                        BASE_ATOMS));
    }

    private static List<AtomRef> superAdminAtoms() {
        List<AtomRef> atoms = new java.util.ArrayList<>();
        PermissionAtomCatalog.actionAtoms().forEach(name -> atoms.add(AtomRef.wildcard(name)));
        PermissionAtomCatalog.capabilityAtoms().forEach(name -> atoms.add(AtomRef.wildcard(name)));
        return List.copyOf(atoms);
    }

    @SafeVarargs
    private static List<AtomRef> concat(List<AtomRef>... parts) {
        List<AtomRef> merged = new java.util.ArrayList<>();
        for (List<AtomRef> part : parts) {
            merged.addAll(part);
        }
        return List.copyOf(merged);
    }

    public Optional<UUID> roleIdByName(String name) {
        return roleRepository.findByName(name).map(AccessRole::getId);
    }

    /**
     * Idempotent bootstrap of the built-in catalog. Missing roles/atoms are inserted; existing
     * system rows are left untouched (V87 is the canonical writer on PostgreSQL).
     */
    @Transactional
    public void ensureSeeded() {
        int insertedRoles = 0;
        int insertedAtoms = 0;
        for (RoleSeed seed : roleSeeds()) {
            AccessRole role = roleRepository.findByName(seed.name()).orElse(null);
            if (role == null) {
                role = roleRepository.save(new AccessRole(seed.id(), seed.name(), seed.displayName(),
                        seed.description(), true));
                insertedRoles++;
            }
            UUID roleId = role.getId();
            java.util.Set<String> existing = new java.util.HashSet<>();
            permissionRepository.findByIdRoleId(roleId).forEach(row ->
                    existing.add(row.actionClass() + "|" + row.resourcePattern()));
            for (AtomRef atom : seed.atoms()) {
                if (existing.add(atom.actionClass() + "|" + atom.resourcePattern())) {
                    permissionRepository.save(new AccessRolePermission(roleId,
                            atom.actionClass(), atom.resourcePattern()));
                    insertedAtoms++;
                }
            }
        }
        if (insertedRoles > 0 || insertedAtoms > 0) {
            logger.info("[POLICY] event=system_access_role_catalog_seeded roles={} atoms={}",
                    insertedRoles, insertedAtoms);
        }
    }
}
