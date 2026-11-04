package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.InstanceOwner;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.InstanceOwnerRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * PLAN-0610 W3-2a: access-role definitions (design §3.5 {@code /api/v1/roles*}).
 *
 * <p>Responsibilities and boundaries:</p>
 *
 * <ul>
 *   <li><b>Catalog</b> is a projection of {@link PermissionAtomCatalog} — the design's single
 *       source of truth (R2-10). This class never carries its own atom table; adding an atom to the
 *       catalog automatically appears in the API and in the write-time scope validator.</li>
 *   <li><b>System roles are immutable</b> except their display name ({@code 409
 *       SYSTEM_ROLE_IMMUTABLE}); a role that still has bindings cannot be deleted ({@code 409
 *       ROLE_IN_USE}).</li>
 *   <li><b>Atom changes are materialized in the same transaction</b> through {@link
 *       RoleGrantMaterializer#materializeRole}, which reconciles every holder's {@code source='role'}
 *       rows, invalidates the capability cache twice (immediate + after completion) and bumps the
 *       epoch of each holder whose set actually changed (I4, R2-19/R2-20).</li>
 *   <li><b>Authorization is not decided here</b>: the endpoint carries
 *       {@code @PreAuthorize("@requesterAuthority.holdsActionAtom('MANAGE_ROLES')")} — an action
 *       atom, so it is answered from the grant rows rather than from an authority (decision #23).</li>
 * </ul>
 *
 * <p>Lock order: {@code instance_owner} (the instance write mutex, same first lock as the user/admin
 * paths) → {@code roles} row → {@code users} rows (inside the materializer, ascending id order).</p>
 */
@Service
public class RoleAdminService {

    private static final Logger logger = LoggerFactory.getLogger(RoleAdminService.class);

    private static final Pattern ROLE_NAME = Pattern.compile("^[A-Za-z][A-Za-z0-9_.:-]{1,63}$");
    private static final String RESOURCE_TYPE = "role";

    private final AccessRoleRepository roles;
    private final AccessRolePermissionRepository permissions;
    private final AccessRoleBindingRepository bindings;
    private final InstanceOwnerRepository owners;
    private final RoleGrantMaterializer materializer;
    private final AuditLogger audit;
    private final DbLockTimeout dbLockTimeout;

    public RoleAdminService(AccessRoleRepository roles,
                            AccessRolePermissionRepository permissions,
                            AccessRoleBindingRepository bindings,
                            InstanceOwnerRepository owners,
                            RoleGrantMaterializer materializer,
                            AuditLogger audit,
                            DbLockTimeout dbLockTimeout) {
        this.roles = roles;
        this.permissions = permissions;
        this.bindings = bindings;
        this.owners = owners;
        this.materializer = materializer;
        this.audit = audit;
        this.dbLockTimeout = dbLockTimeout;
    }

    /** Default-locale overload (callers that do not carry a request locale). */
    @Transactional(readOnly = true)
    public RoleAdminViews.CatalogView catalog() {
        return catalog(null);
    }

    /** {@code GET /api/v1/roles/catalog}: every action atom + capability atom with scope class. */
    @Transactional(readOnly = true)
    public RoleAdminViews.CatalogView catalog(String locale) {
        List<RoleAdminViews.AtomView> atoms = new ArrayList<>();
        // Order matters for the UI: action atoms first, then the capability atoms.
        for (String name : PermissionAtomCatalog.actionAtoms()) {
            atoms.add(RoleAdminViews.AtomView.of(PermissionAtomCatalog.atom(name), locale));
        }
        for (String name : PermissionAtomCatalog.capabilityAtoms()) {
            atoms.add(RoleAdminViews.AtomView.of(PermissionAtomCatalog.atom(name), locale));
        }
        return new RoleAdminViews.CatalogView(atoms,
                List.of(AccessScope.INSTANCE, AccessScope.WORKSPACE));
    }

    /** {@code GET /api/v1/roles}: every definition, system roles first, then by name. */
    @Transactional(readOnly = true)
    public List<RoleAdminViews.RoleView> list() {
        Map<UUID, List<String>> atomsByRole = atomsByRole();
        List<AccessRole> all = roles.findAll();
        Map<UUID, Long> bindingCounts = new LinkedHashMap<>();
        for (AccessRole role : all) {
            bindingCounts.put(role.getId(), bindings.countByRoleId(role.getId()));
        }
        return all.stream()
                .sorted(Comparator.comparing(AccessRole::isSystem).reversed()
                        .thenComparing(AccessRole::getName))
                .map(role -> toView(role, atomsByRole.getOrDefault(role.getId(), List.of()),
                        bindingCounts.getOrDefault(role.getId(), 0L)))
                .toList();
    }

    /** {@code POST /api/v1/roles}: a custom role with an explicit atom set. */
    @Transactional
    public RoleAdminViews.RoleView create(RoleAdminViews.RoleCreate request) {
        dbLockTimeout.apply();
        lockInstanceMutex();
        String name = requireName(request == null ? null : request.name());
        if (roles.existsByName(name)) {
            throw new CpApiException(HttpStatus.CONFLICT, "ROLE_NAME_EXISTS",
                    "A role with this name already exists");
        }
        List<String> atomNames = requireAtoms(request.atoms());
        String displayName = requireDisplayName(request.displayName(), name);
        AccessRole role = new AccessRole(UUID.randomUUID(), name, displayName,
                trimToNull(request.description()), false);
        AccessRole saved = roles.save(role);
        for (String atom : atomNames) {
            PermissionAtomCatalog.Atom atomRef = PermissionAtomCatalog.atom(atom);
            permissions.save(new AccessRolePermission(saved.getId(), atomRef.name(),
                    atomRef.canonicalResource()));
        }
        audit.recordDurableChange(actorId(), null, "access_role_created", RESOURCE_TYPE,
                saved.getId().toString(), "name=" + name + " atoms=" + String.join(",", atomNames));
        logger.info("[POLICY] event=access_role_created role={} name={} atoms={}", saved.getId(), name,
                atomNames.size());
        return toView(saved, atomNames, 0L);
    }

    /**
     * {@code PATCH /api/v1/roles/{roleId}}: custom roles may change name/description/atoms; a system
     * role accepts <b>only</b> a display-name change (design §3.5), everything else is
     * {@code 409 SYSTEM_ROLE_IMMUTABLE}.
     */
    @Transactional
    public RoleAdminViews.RoleView update(UUID roleId, RoleAdminViews.RoleUpdate request) {
        if (request == null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "A role update body is required");
        }
        dbLockTimeout.apply();
        lockInstanceMutex();
        AccessRole role = roles.findByIdForUpdate(roleId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "ROLE_NOT_FOUND",
                        "Role not found"));
        List<String> currentAtoms = permissions.findByIdRoleId(role.getId()).stream()
                .map(AccessRolePermission::actionClass)
                .sorted()
                .toList();
        boolean atomsRequested = request.atoms() != null;
        boolean nameRequested = request.name() != null;
        boolean descriptionRequested = request.description() != null;
        if (role.isSystem()) {
            if (atomsRequested || nameRequested || descriptionRequested) {
                throw new CpApiException(HttpStatus.CONFLICT, "SYSTEM_ROLE_IMMUTABLE",
                        "A system role can only change its display name");
            }
            String displayName = requireDisplayName(request.displayName(), role.getName());
            role.setDisplayName(displayName);
            AccessRole saved = roles.save(role);
            audit.recordDurableChange(actorId(), null, "access_role_updated", RESOURCE_TYPE,
                    saved.getId().toString(), "name=" + saved.getName() + " displayName-only");
            return toView(saved, currentAtoms, bindings.countByRoleId(saved.getId()));
        }

        if (nameRequested) {
            String name = requireName(request.name());
            if (!name.equals(role.getName()) && roles.existsByName(name)) {
                throw new CpApiException(HttpStatus.CONFLICT, "ROLE_NAME_EXISTS",
                        "A role with this name already exists");
            }
            role.setName(name);
        }
        if (request.displayName() != null) {
            role.setDisplayName(requireDisplayName(request.displayName(), role.getName()));
        }
        if (descriptionRequested) {
            role.setDescription(trimToNull(request.description()));
        }
        AccessRole saved = roles.save(role);

        List<String> effectiveAtoms = currentAtoms;
        if (atomsRequested) {
            effectiveAtoms = requireAtoms(request.atoms());
            replaceAtoms(saved.getId(), effectiveAtoms);
        }
        int materialized = materializer.materializeRole(saved.getId(), actorUuid(), null);
        audit.recordDurableChange(actorId(), null, "access_role_updated", RESOURCE_TYPE,
                saved.getId().toString(), "name=" + saved.getName() + " atoms="
                        + String.join(",", effectiveAtoms) + " holders=" + materialized);
        logger.info("[POLICY] event=access_role_updated role={} atoms={} holders={}", saved.getId(),
                effectiveAtoms.size(), materialized);
        return toView(saved, effectiveAtoms, bindings.countByRoleId(saved.getId()));
    }

    /** {@code DELETE /api/v1/roles/{roleId}}: no system role, no role that is still bound. */
    @Transactional
    public void delete(UUID roleId) {
        dbLockTimeout.apply();
        lockInstanceMutex();
        AccessRole role = roles.findByIdForUpdate(roleId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "ROLE_NOT_FOUND",
                        "Role not found"));
        if (role.isSystem()) {
            throw new CpApiException(HttpStatus.CONFLICT, "SYSTEM_ROLE_IMMUTABLE",
                    "A system role cannot be deleted");
        }
        long bound = bindings.countByRoleId(role.getId());
        if (bound > 0) {
            throw new CpApiException(HttpStatus.CONFLICT, "ROLE_IN_USE",
                    "The role is still bound to " + bound + " subject(s)");
        }
        permissions.deleteByIdRoleId(role.getId());
        roles.delete(role);
        audit.recordDurableChange(actorId(), null, "access_role_deleted", RESOURCE_TYPE,
                roleId.toString(), "name=" + role.getName());
        logger.info("[POLICY] event=access_role_deleted role={} name={}", roleId, role.getName());
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private Map<UUID, List<String>> atomsByRole() {
        Map<UUID, List<String>> atomsByRole = new LinkedHashMap<>();
        for (AccessRolePermission permission : permissions.findAll()) {
            atomsByRole.computeIfAbsent(permission.roleId(), ignored -> new ArrayList<>())
                    .add(permission.actionClass());
        }
        atomsByRole.values().forEach(atoms -> atoms.sort(Comparator.naturalOrder()));
        return atomsByRole;
    }

    private void replaceAtoms(UUID roleId, List<String> atomNames) {
        permissions.deleteByIdRoleId(roleId);
        for (String atom : atomNames) {
            PermissionAtomCatalog.Atom atomRef = PermissionAtomCatalog.atom(atom);
            permissions.save(new AccessRolePermission(roleId, atomRef.name(),
                    atomRef.canonicalResource()));
        }
    }

    private RoleAdminViews.RoleView toView(AccessRole role, List<String> atomNames, long bindingCount) {
        // Stable order regardless of how the atoms were supplied: the UI diffs this list.
        List<RoleAdminViews.AtomView> atoms = atomNames.stream()
                .sorted(java.util.Comparator.naturalOrder())
                .map(name -> RoleAdminViews.AtomView.of(PermissionAtomCatalog.atom(name),
                        PermissionAtomLabels.DEFAULT_LOCALE))
                .toList();
        return new RoleAdminViews.RoleView(role.getId(), role.getName(), role.getDisplayName(),
                role.getDescription(), role.isSystem(), atoms, bindingCount);
    }

    /**
     * The instance write mutex (same singleton row as {@code UserRoleService} /
     * {@code InstanceOwnershipService}), acquired before the role row so concurrent role edits and
     * user-tier edits serialize instead of deadlocking.
     */
    private void lockInstanceMutex() {
        owners.lockSingleton().orElseGet(() -> {
            logger.warn("instance_owner singleton row missing; role writes proceed without the"
                    + " instance mutex (H2 profile)");
            return owners.save(new InstanceOwner());
        });
    }

    private static String requireName(String raw) {
        String name = raw == null ? null : raw.trim();
        if (name == null || !ROLE_NAME.matcher(name).matches()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_ROLE_NAME",
                    "name must match " + ROLE_NAME.pattern());
        }
        return name;
    }

    private static String requireDisplayName(String raw, String fallback) {
        String displayName = raw == null ? fallback : raw.trim();
        if (displayName.isEmpty() || displayName.length() > 200) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_ROLE_NAME",
                    "displayName must be 1..200 characters");
        }
        return displayName;
    }

    /** Validates existence and deduplicates; an empty set is rejected (a role with no atoms is not). */
    private static List<String> requireAtoms(List<String> raw) {
        if (raw == null || raw.isEmpty()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_ROLE_ATOMS",
                    "at least one permission atom is required");
        }
        LinkedHashSet<String> atoms = new LinkedHashSet<>();
        for (String atom : raw) {
            atoms.add(PermissionAtomCatalog.atom(atom == null ? null : atom.trim()).name());
        }
        return List.copyOf(atoms);
    }

    private static String trimToNull(String raw) {
        if (raw == null) {
            return null;
        }
        String trimmed = raw.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private static String actorId() {
        return com.cc01cc.p.xihe.cp.config.TenantContext.getUserId();
    }

    private static UUID actorUuid() {
        String actor = actorId();
        return actor == null ? null : UUID.fromString(actor);
    }
}


