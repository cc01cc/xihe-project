package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.UserRole;
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

    public static final String SUPER_ADMIN = "SUPER_ADMIN";
    public static final String ADMIN = "ADMIN";
    public static final String USER = "USER";
    public static final String WS_OWNER = "WS_OWNER";
    public static final String WS_EDITOR = "WS_EDITOR";
    public static final String WS_VIEWER = "WS_VIEWER";

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
            AtomRef.wildcard(ToolFaceRegistry.ACTION_NETWORK));

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
                        "Instance scope: the default action set plus the three credential atoms "
                                + "and instance:admin.",
                        concat(BASE_ATOMS, CREDENTIAL_ATOMS,
                                List.of(AtomRef.wildcard(PermissionAtomCatalog.CAP_INSTANCE_ADMIN)))),
                new RoleSeed(USER_ID, USER, "User",
                        "Instance scope: the registration minimal set "
                                + "(read/write/delete/exec/network).",
                        BASE_ATOMS),
                new RoleSeed(WS_OWNER_ID, WS_OWNER, "Workspace Owner",
                        "Workspace scope: editor actions plus workspace agent management "
                                + "and workspace:admin.",
                        concat(List.of(
                                        AtomRef.wildcard(ToolFaceRegistry.ACTION_READ),
                                        AtomRef.wildcard(ToolFaceRegistry.ACTION_WRITE),
                                        AtomRef.wildcard(ToolFaceRegistry.ACTION_DELETE),
                                        AtomRef.wildcard(ToolFaceRegistry.ACTION_EXEC)),
                                List.of(AtomRef.wildcard(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS),
                                        AtomRef.wildcard(PermissionAtomCatalog.CAP_WORKSPACE_ADMIN)))),
                new RoleSeed(WS_EDITOR_ID, WS_EDITOR, "Workspace Editor",
                        "Workspace scope: read/write/delete/exec.",
                        List.of(
                                AtomRef.wildcard(ToolFaceRegistry.ACTION_READ),
                                AtomRef.wildcard(ToolFaceRegistry.ACTION_WRITE),
                                AtomRef.wildcard(ToolFaceRegistry.ACTION_DELETE),
                                AtomRef.wildcard(ToolFaceRegistry.ACTION_EXEC))),
                new RoleSeed(WS_VIEWER_ID, WS_VIEWER, "Workspace Viewer",
                        "Workspace scope: read only.",
                        List.of(AtomRef.wildcard(ToolFaceRegistry.ACTION_READ))));
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

    /** Legacy instance tier of a {@code users.role} value — the W1a bridge until V88 binds it. */
    public static String instanceTierRoleName(UserRole role) {
        return switch (role) {
            case ADMIN -> ADMIN;
            case USER -> USER;
        };
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
