package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.GrantPreset;
import com.cc01cc.p.xihe.cp.entity.GrantPresetAtom;
import com.cc01cc.p.xihe.cp.entity.GrantPresetBinding;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.InstanceOwner;
import com.cc01cc.p.xihe.cp.repository.GrantPresetBindingRepository;
import com.cc01cc.p.xihe.cp.repository.GrantPresetAtomRepository;
import com.cc01cc.p.xihe.cp.repository.GrantPresetRepository;
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
 * PLAN-0610 W3-2a: access-role definitions (design §3.5 {@code /api/v1/presets*}).
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
 *       PresetGrantMaterializer#materializePreset}</b> — an <b>explicit governance replay</b>
 *       face only (the 「重新对齐」 button), NOT an edit hook: task-933 / R39 retired the old
 *       automatic per-edit reconcile, because a preset is a READ-ONLY template (「改预设内容 ⇒
 *       已导入主体权限不变」). Editing a preset's atoms therefore reconciles NOTHING here; a
 *       holder's own rows (imported once via {@code source='assigned'} + {@code origin_preset_id})
 *       are untouched by this call.</li>
 *   <li><b>Authorization is not decided here</b>: the endpoint carries
 *       {@code @PreAuthorize("@requesterAuthority.holdsActionAtom('MANAGE_ROLES')")} — an action
 *       atom, so it is answered from the grant rows rather than from an authority (decision #23).</li>
 * </ul>
 *
 * <p>Lock order: {@code instance_owner} (the instance write mutex, same first lock as the user/admin
 * paths) → {@code roles} row → {@code users} rows (inside the materializer, ascending id order).</p>
 */
@Service
public class GrantPresetAdminService {

    private static final Logger logger = LoggerFactory.getLogger(GrantPresetAdminService.class);

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

    private final GrantPresetRepository roles;
    private final GrantPresetAtomRepository permissions;
    private final GrantPresetBindingRepository bindings;
    private final InstanceOwnerRepository owners;
    private final PresetGrantMaterializer materializer;
    private final AuditLogger audit;
    private final DbLockTimeout dbLockTimeout;
    private final GrantabilityGuard grantability;
    private final AgentBindingAtomPolicy agentAtomPolicy;
    private final AgentPrincipalRepository principals;
    private final GrantResourcePattern grantResources;

    public GrantPresetAdminService(GrantPresetRepository roles,
                            GrantPresetAtomRepository permissions,
                            GrantPresetBindingRepository bindings,
                            InstanceOwnerRepository owners,
                            PresetGrantMaterializer materializer,
                            AuditLogger audit,
                            DbLockTimeout dbLockTimeout,
                            GrantabilityGuard grantability,
                            AgentBindingAtomPolicy agentAtomPolicy,
                            AgentPrincipalRepository principals,
                            GrantResourcePattern grantResources) {
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
        this.grantResources = grantResources;
    }

    /** Default-locale overload (callers that do not carry a request locale). */
    @Transactional(readOnly = true)
    public GrantPresetAdminViews.CatalogView catalog() {
        return catalog(null);
    }

    /** {@code GET /api/v1/presets/catalog}: every action atom + capability atom with scope class. */
    @Transactional(readOnly = true)
    public GrantPresetAdminViews.CatalogView catalog(String locale) {
        List<GrantPresetAdminViews.AtomView> atoms = new ArrayList<>();
        // Order matters for the UI: action atoms first, then the capability atoms.
        for (String name : PermissionAtomCatalog.actionAtoms()) {
            atoms.add(GrantPresetAdminViews.AtomView.of(PermissionAtomCatalog.atom(name), locale));
        }
        for (String name : PermissionAtomCatalog.capabilityAtoms()) {
            atoms.add(GrantPresetAdminViews.AtomView.of(PermissionAtomCatalog.atom(name), locale));
        }
        // task-415 (RBAC P1-2): expose the seeded default grant sets next to the vocabulary, so the
        // page can show which built-in role a new atom lands in by default (and that instance:admin
        // is part of the fixed administrator set) instead of leaving that fact in the Java source.
        List<GrantPresetAdminViews.DefaultGrantView> defaultGrants = new ArrayList<>();
        for (SystemGrantPresetCatalog.PresetSeed seed : SystemGrantPresetCatalog.presetSeeds()) {
            defaultGrants.add(new GrantPresetAdminViews.DefaultGrantView(seed.name(), seed.displayName(),
                    seed.description(), seed.atoms().stream()
                            .map(SystemGrantPresetCatalog.AtomRef::actionClass).distinct().toList()));
        }
        return new GrantPresetAdminViews.CatalogView(atoms,
                List.of(AccessScope.INSTANCE, AccessScope.WORKSPACE), defaultGrants);
    }

    /** {@code GET /api/v1/presets}: every definition, system roles first, then by name. */
    @Transactional(readOnly = true)
    public List<GrantPresetAdminViews.RoleView> list() {
        Map<UUID, List<GrantPresetAtom>> permissionsByRole = permissionsByRole();
        List<GrantPreset> all = roles.findAll();
        Map<UUID, Long> bindingCounts = new LinkedHashMap<>();
        for (GrantPreset role : all) {
            bindingCounts.put(role.getId(), bindings.countByRoleId(role.getId()));
        }
        return all.stream()
                .sorted(Comparator.comparing(GrantPreset::isSystem).reversed()
                        .thenComparing(GrantPreset::getName))
                .map(role -> toView(role,
                        specsOf(permissionsByRole.getOrDefault(role.getId(), List.of())),
                        bindingCounts.getOrDefault(role.getId(), 0L)))
                .toList();
    }

    /**
     * PLAN-0667 addendum (Lead ruling 2026-11-05, real-stack gap 1): the role candidates a caller
     * who may manage an agent's bindings is allowed to see.
     *
     * <p>Role <em>definitions</em> are instance-wide (see {@link com.cc01cc.p.xihe.cp.entity.GrantPreset}:
     * scope lives on the binding, not on the role), so "workspace roles" cannot be filtered by an
     * ownership column. What can be filtered — and what the UI actually needs — is <b>bindability</b>:
     * a role carrying any {@code agentPrincipalForbidden} atom can never be bound to an agent, so
     * listing it would only produce a button that always answers 409. The result keeps the same view
     * shape and ordering as {@link #list()} (system roles first, then name).</p>
     */
    @Transactional(readOnly = true)
    public List<GrantPresetAdminViews.RoleView> listAgentBindable() {
        Map<UUID, List<GrantPresetAtom>> permissionsByRole = permissionsByRole();
        List<GrantPreset> all = roles.findAll();
        Map<UUID, Long> bindingCounts = new LinkedHashMap<>();
        for (GrantPreset role : all) {
            bindingCounts.put(role.getId(), bindings.countByRoleId(role.getId()));
        }
        return all.stream()
                .filter(role -> PermissionAtomCatalog.canBindToAgentPrincipal(actionClasses(
                        specsOf(permissionsByRole.getOrDefault(role.getId(), List.of())))))
                .sorted(Comparator.comparing(GrantPreset::isSystem).reversed()
                        .thenComparing(GrantPreset::getName))
                .map(role -> toView(role,
                        specsOf(permissionsByRole.getOrDefault(role.getId(), List.of())),
                        bindingCounts.getOrDefault(role.getId(), 0L)))
                .toList();
    }

    /** {@code POST /api/v1/presets}: a custom role with an explicit atom set. */
    @Transactional
    public GrantPresetAdminViews.RoleView create(GrantPresetAdminViews.RoleCreate request) {
        dbLockTimeout.apply();
        lockInstanceMutex();
        String name = requireName(request == null ? null : request.name());
        if (roles.existsByName(name)) {
            throw new CpApiException(HttpStatus.CONFLICT, "ROLE_NAME_EXISTS",
                    "A role with this name already exists");
        }
        List<AtomSpec> atoms = requireAtoms(request.atoms());
        // PLAN-0673 M1 T1.2 (闸门②): a role definition may only contain atoms the caller holds in
        // ANY scope (binding re-checks at the concrete target scope). 403 PRIVILEGE_ESCALATION names
        // the offending atoms; the cap gate (BL-287) stays a separate 409.
        grantability.assertGrantable(new LinkedHashSet<>(actionClasses(atoms)), null);
        String displayName = requireDisplayName(request.displayName(), name);
        GrantPreset role = new GrantPreset(UUID.randomUUID(), name, displayName,
                trimToNull(request.description()), false);
        GrantPreset saved = roles.save(role);
        for (AtomSpec atom : atoms) {
            permissions.save(new GrantPresetAtom(saved.getId(), atom.actionClass(),
                    atom.resourcePattern()));
        }
        audit.recordDurableChange(actorId(), null, "access_role_created", RESOURCE_TYPE,
                saved.getId().toString(), "name=" + name + " atoms=" + describe(atoms));
        logger.info("[POLICY] event=access_role_created role={} name={} atoms={}", saved.getId(), name,
                atoms.size());
        return toView(saved, atoms, 0L);
    }

    /**
     * {@code PATCH /api/v1/presets/{presetId}}: custom roles may change name/description/atoms; a system
     * role accepts <b>only</b> a display-name change (design §3.5), everything else is
     * {@code 409 SYSTEM_ROLE_IMMUTABLE}.
     */
    @Transactional
    public GrantPresetAdminViews.RoleView update(UUID roleId, GrantPresetAdminViews.PresetUpdate request) {
        if (request == null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "A role update body is required");
        }
        dbLockTimeout.apply();
        lockInstanceMutex();
        GrantPreset role = roles.findByIdForUpdate(roleId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "ROLE_NOT_FOUND",
                        "Role not found"));
        List<AtomSpec> currentAtoms = specsOf(permissions.findByIdRoleId(role.getId()));
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
            GrantPreset saved = roles.save(role);
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
        List<AtomSpec> effectiveAtoms = currentAtoms;
        if (atomsRequested) {
            effectiveAtoms = requireAtoms(request.atoms());
            Set<String> added = new LinkedHashSet<>();
            for (AtomSpec atom : effectiveAtoms) {
                added.add(atom.key());
            }
            for (AtomSpec atom : currentAtoms) {
                added.remove(atom.key());
            }
            List<GrantPresetBinding> roleBindings = bindings.findByRoleId(roleId);
            // PLAN-0673 M1: the subset gate runs over EVERY binding scope of the role, not only
            // agent bindings — materializePreset() re-materialises every holder (users included), so
            // an atom the author holds only in workspace A must not land in workspace B or in the
            // instance through a user binding either. The agent-only filter below applies to the
            // forbidden/cap recheck, which is agent-specific.
            List<AccessScope> targetScopes = roleBindings.stream()
                    .map(binding -> AccessScope.WORKSPACE.equals(binding.getScopeType())
                            ? AccessScope.workspace(binding.getScopeId()) : AccessScope.instance())
                    .distinct().toList();
            List<GrantPresetAtom> prospective = effectiveAtoms.stream()
                    .map(atom -> new GrantPresetAtom(roleId, atom.actionClass(),
                            atom.resourcePattern()))
                    .toList();
            List<GrantPresetAtom> addedRows = prospective.stream()
                    .filter(row -> added.contains(row.actionClass() + "@" + row.resourcePattern()))
                    .toList();
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
            for (GrantPresetBinding binding : roleBindings) {
                if (!GrantPrincipalPathResolver.AGENT_PRINCIPAL.equals(binding.getSubjectType())) {
                    continue;
                }
                AgentPrincipal principal = principals.findByIdForUpdate(binding.getSubjectId())
                        .orElseThrow(() -> new CpApiException(HttpStatus.CONFLICT,
                                "AGENT_PRINCIPAL_NOT_FOUND", "Bound agent principal no longer exists"));
                agentAtomPolicy.assertWithinCap(principal.getId(), prospective,
                        AccessScope.WORKSPACE.equals(binding.getScopeType()) ? binding.getScopeId() : null);
            }
            GrantPreset saved = roles.save(role);
            replaceAtoms(saved.getId(), effectiveAtoms);
        } else {
            roles.save(role);
        }
        GrantPreset saved = role;
        // task-933 / R39: the preset is a read-only template — an edit reconciles NOTHING (no
        // automatic materializePreset pass over the holders; the governance-replay face is the
        // 「重新对齐」 button's own call). The audit/measure line keeps counting HOLDERS, which is
        // now purely descriptive (how many subjects imported this template), not a side effect.
        long holders = bindings.countByRoleId(saved.getId());
        audit.recordDurableChange(actorId(), null, "access_role_updated", RESOURCE_TYPE,
                saved.getId().toString(), "name=" + saved.getName() + " atoms="
                        + describe(effectiveAtoms) + " holders=" + holders);
        logger.info("[POLICY] event=access_role_updated role={} atoms={} holders={} reconciled=false",
                saved.getId(), effectiveAtoms.size(), holders);
        return toView(saved, effectiveAtoms, bindings.countByRoleId(saved.getId()));
    }

    /** {@code DELETE /api/v1/presets/{presetId}}: no system role, no role that is still bound. */
    @Transactional
    public void delete(UUID roleId) {
        dbLockTimeout.apply();
        lockInstanceMutex();
        GrantPreset role = roles.findByIdForUpdate(roleId)
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

    private Map<UUID, List<GrantPresetAtom>> permissionsByRole() {
        Map<UUID, List<GrantPresetAtom>> byRole = new LinkedHashMap<>();
        for (GrantPresetAtom permission : permissions.findAll()) {
            byRole.computeIfAbsent(permission.roleId(), ignored -> new ArrayList<>())
                    .add(permission);
        }
        return byRole;
    }

    /**
     * One atom of a role, with the resource pattern it is stored under.
     *
     * <p>task-81: the pair has to travel together from the request to {@code grant_preset_atoms}. A
     * name-only carrier would silently write the canonical {@code *} and turn every narrowed atom
     * back into a wildcard — the exact state the C1 card exists to end.</p>
     */
    private record AtomSpec(String actionClass, String resourcePattern) {

        String key() {
            return actionClass + "@" + resourcePattern;
        }
    }

    private static List<AtomSpec> specsOf(List<GrantPresetAtom> rows) {
        return rows.stream()
                .map(row -> new AtomSpec(row.actionClass(), row.resourcePattern()))
                .sorted(Comparator.comparing(AtomSpec::actionClass)
                        .thenComparing(AtomSpec::resourcePattern))
                .toList();
    }

    private static List<String> actionClasses(List<AtomSpec> atoms) {
        return atoms.stream().map(AtomSpec::actionClass).toList();
    }

    private static String describe(List<AtomSpec> atoms) {
        return String.join(",", atoms.stream().map(AtomSpec::key).toList());
    }

    private void replaceAtoms(UUID roleId, List<AtomSpec> atoms) {
        permissions.deleteByIdRoleId(roleId);
        for (AtomSpec atom : atoms) {
            permissions.save(new GrantPresetAtom(roleId, atom.actionClass(),
                    atom.resourcePattern()));
        }
    }

    private GrantPresetAdminViews.RoleView toView(GrantPreset role, List<AtomSpec> atoms,
                                           long bindingCount) {
        // Stable order regardless of how the atoms were supplied: the UI diffs this list.
        List<GrantPresetAdminViews.AtomView> views = atoms.stream()
                .sorted(Comparator.comparing(AtomSpec::actionClass)
                        .thenComparing(AtomSpec::resourcePattern))
                .map(atom -> GrantPresetAdminViews.AtomView.of(PermissionAtomCatalog.atom(atom.actionClass()),
                        atom.resourcePattern(), PermissionAtomLabels.DEFAULT_LOCALE))
                .toList();
        return new GrantPresetAdminViews.RoleView(role.getId(), role.getName(), role.getDisplayName(),
                role.getDescription(), role.isSystem(), views, bindingCount);
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

    /**
     * Validates existence, resolves each atom's resource pattern and deduplicates; an empty set is
     * rejected (a role with no atoms is not a role).
     *
     * <p>task-81 (DSD-1485): an atom without a resource keeps the canonical pattern, so the old
     * {@code atoms:["read"]} contract is byte-identical; an atom <b>with</b> a resource is resolved by
     * {@link GrantResourcePattern} (400 {@code INVALID_GRANT_RESOURCE} on any unsupported form, 403
     * when the caller may not administer the target workspace's bindings). One role holds one pattern
     * per atom — {@code grant_preset_atoms}' primary key allows several rows, but two patterns for one
     * atom would make the editor's "what does this atom cover" answer ambiguous.</p>
     */
    private List<AtomSpec> requireAtoms(List<GrantPresetAdminViews.AtomInput> raw) {
        if (raw == null || raw.isEmpty()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_ROLE_ATOMS",
                    "at least one permission atom is required");
        }
        LinkedHashMap<String, AtomSpec> atoms = new LinkedHashMap<>();
        for (GrantPresetAdminViews.AtomInput input : raw) {
            if (input == null) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_ROLE_ATOMS",
                        "atom entries must not be null");
            }
            PermissionAtomCatalog.Atom atom = PermissionAtomCatalog.atom(
                    input.actionClass() == null ? null : input.actionClass().trim());
            String pattern = grantResources.resolve(atom, input.resource());
            AtomSpec previous = atoms.putIfAbsent(atom.name(), new AtomSpec(atom.name(), pattern));
            if (previous != null && !previous.resourcePattern().equals(pattern)) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, GrantResourcePattern.CODE_INVALID,
                        "atom " + atom.name() + " appears twice with different resource patterns ("
                                + previous.resourcePattern() + " vs " + pattern
                                + "); one role holds one resource pattern per atom");
            }
        }
        return List.copyOf(atoms.values());
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
