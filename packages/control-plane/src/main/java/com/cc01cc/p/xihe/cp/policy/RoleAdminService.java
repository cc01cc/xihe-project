package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.InstanceOwner;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.InstanceOwnerRepository;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
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
import java.util.Set;
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

    /**
     * BL-394: the database check constraint is the authority — V87
     * ({@code db/migration/V87__dynamic_access_roles.sql},
     * {@code CONSTRAINT ck_roles_name_format CHECK (name ~ '^[A-Z][A-Z0-9_]{1,63}$')}). This
     * pattern must stay byte-identical to it: the previous looser pattern accepted lowercase,
     * dot and hyphen names, so the INSERT violated the constraint and the API answered
     * 500 INTERNAL_ERROR instead of a field-level 400.
     */
    private static final Pattern ROLE_NAME = Pattern.compile("^[A-Z][A-Z0-9_]{1,63}$");
    private static final String RESOURCE_TYPE = "role";

    private final AccessRoleRepository roles;
    private final AccessRolePermissionRepository permissions;
    private final AccessRoleBindingRepository bindings;
    private final InstanceOwnerRepository owners;
    private final RoleGrantMaterializer materializer;
    private final AuditLogger audit;
    private final DbLockTimeout dbLockTimeout;
    private final GrantabilityGuard grantability;
    private final AgentBindingAtomPolicy agentAtomPolicy;
    private final AgentPrincipalRepository principals;

    public RoleAdminService(AccessRoleRepository roles,
                            AccessRolePermissionRepository permissions,
                            AccessRoleBindingRepository bindings,
                            InstanceOwnerRepository owners,
                            RoleGrantMaterializer materializer,
                            AuditLogger audit,
                            DbLockTimeout dbLockTimeout,
                            GrantabilityGuard grantability,
                            AgentBindingAtomPolicy agentAtomPolicy,
                            AgentPrincipalRepository principals) {
        this.roles = roles;
        this.permissions = permissions;
        this.bindings = bindings;
        this.owners = owners;
        this.materializer = materializer;
        this.audit = audit;
        this.dbLockTimeout = dbLockTimeout;
        this.grantability = grantability;
        this.agentAtomPolicy = agentAtomPolicy;
        this.principals = principals;
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

    /**
     * PLAN-0667 addendum (Lead ruling 2026-11-05, real-stack gap 1): the role candidates a caller
     * who may manage an agent's bindings is allowed to see.
     *
     * <p>Role <em>definitions</em> are instance-wide (see {@link com.cc01cc.p.xihe.cp.entity.AccessRole}:
     * scope lives on the binding, not on the role), so "workspace roles" cannot be filtered by an
     * ownership column. What can be filtered — and what the UI actually needs — is <b>bindability</b>:
     * a role carrying any {@code agentPrincipalForbidden} atom can never be bound to an agent, so
     * listing it would only produce a button that always answers 409. The result keeps the same view
     * shape and ordering as {@link #list()} (system roles first, then name).</p>
     */
    @Transactional(readOnly = true)
    public List<RoleAdminViews.RoleView> listAgentBindable() {
        Map<UUID, List<String>> atomsByRole = atomsByRole();
        List<AccessRole> all = roles.findAll();
        Map<UUID, Long> bindingCounts = new LinkedHashMap<>();
        for (AccessRole role : all) {
            bindingCounts.put(role.getId(), bindings.countByRoleId(role.getId()));
        }
        return all.stream()
                .filter(role -> PermissionAtomCatalog.canBindToAgentPrincipal(
                        atomsByRole.getOrDefault(role.getId(), List.of())))
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
        // PLAN-0673 M1 T1.2 (闸门②): a role definition may only contain atoms the caller holds in
        // ANY scope (binding re-checks at the concrete target scope). 403 PRIVILEGE_ESCALATION names
        // the offending atoms; the cap gate (BL-287) stays a separate 409.
        grantability.assertGrantable(new LinkedHashSet<>(atomNames), null);
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
        List<String> effectiveAtoms = currentAtoms;
        if (atomsRequested) {
            effectiveAtoms = requireAtoms(request.atoms());
            Set<String> added = new LinkedHashSet<>(effectiveAtoms);
            added.removeAll(currentAtoms);
            List<AccessRoleBinding> roleBindings = bindings.findByRoleId(roleId);
            // PLAN-0673 M1: the subset gate runs over EVERY binding scope of the role, not only
            // agent bindings — materializeRole() re-materialises every holder (users included), so
            // an atom the author holds only in workspace A must not land in workspace B or in the
            // instance through a user binding either. The agent-only filter below applies to the
            // forbidden/cap recheck, which is agent-specific.
            List<AccessScope> targetScopes = roleBindings.stream()
                    .map(binding -> AccessScope.WORKSPACE.equals(binding.getScopeType())
                            ? AccessScope.workspace(binding.getScopeId()) : AccessScope.instance())
                    .distinct().toList();
            List<AccessRolePermission> prospective = effectiveAtoms.stream().map(atom -> {
                PermissionAtomCatalog.Atom ref = PermissionAtomCatalog.atom(atom);
                return new AccessRolePermission(roleId, ref.name(), ref.canonicalResource());
            }).toList();
            List<AccessRolePermission> addedRows = prospective.stream()
                    .filter(row -> added.contains(row.actionClass())).toList();
            if (!addedRows.isEmpty()) {
                agentAtomPolicy.assertAddedRowsGrantableInEveryBindingScope(addedRows, targetScopes);
            }
            // Forbidden atoms are a property of the prospective definition, not of one binding:
            // evaluate once, before any principal lock, so the gate cannot depend on loop order.
            boolean boundToAgent = roleBindings.stream().anyMatch(binding ->
                    GrantPrincipalPathResolver.AGENT_PRINCIPAL.equals(binding.getSubjectType()));
            if (boundToAgent) {
                agentAtomPolicy.assertAgentBindable(prospective);
            }
            for (AccessRoleBinding binding : roleBindings) {
                if (!GrantPrincipalPathResolver.AGENT_PRINCIPAL.equals(binding.getSubjectType())) {
                    continue;
                }
                AgentPrincipal principal = principals.findByIdForUpdate(binding.getSubjectId())
                        .orElseThrow(() -> new CpApiException(HttpStatus.CONFLICT,
                                "AGENT_PRINCIPAL_NOT_FOUND", "Bound agent principal no longer exists"));
                agentAtomPolicy.assertWithinCap(principal.getId(), prospective,
                        AccessScope.WORKSPACE.equals(binding.getScopeType()) ? binding.getScopeId() : null);
            }
            AccessRole saved = roles.save(role);
            replaceAtoms(saved.getId(), effectiveAtoms);
        } else {
            roles.save(role);
        }
        AccessRole saved = role;
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
            // The detail names the offending field and prints the single source of truth (the V87
            // constraint), so a client can render a field-level error without parsing prose.
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_ROLE_NAME",
                    "name must match " + ROLE_NAME.pattern()
                            + " (V87 ck_roles_name_format)");
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
