package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.GrantPresetBinding;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.GrantPresetBindingRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * task-996 / task-948 (R39 治理面): the HTTP face of 「与模板对比」 and 「重新对齐」.
 *
 * <p>This service deliberately contains <b>no</b> reconciliation logic. The comparison is the
 * read-side projection of {@link PresetGrantMaterializer#desiredByScopeAndOrigin} (the exact set a
 * replay writes) against the subject's {@code source='assigned'} rows, classified with the same
 * row identity the kernel uses: {@code (scope, atom, origin_preset_id)}. The write face delegates
 * to {@link PresetGrantMaterializer#materializeSubjectAndBumpIfChanged} so a governance replay can
 * never diverge from an import.</p>
 *
 * <p>Authorization is the caller's: the controller runs {@code MANAGE_ROLES} <b>before</b> the
 * subject id is parsed or resolved, and a workspace-scoped write additionally requires
 * {@code MANAGE_WORKSPACE_AGENTS} in each workspace the subject's rows touch. No role-name
 * branching exists here — the atoms are the whole decision.</p>
 */
@Service
public class PresetGovernanceService {

    /**
     * Sentinel for an unattributed row ({@code origin_preset_id = NULL}); mirrors
     * {@code PresetGrantMaterializer}'s private sentinel, exposed for the classifier. It can never
     * equal a persisted binding id.
     */
    static final UUID UNATTRIBUTED_ORIGIN = new UUID(0L, -1L);

    private static final Comparator<GrantIntersectionEvaluator.PermissionAtom> ATOM_ORDER =
            Comparator.comparing(GrantIntersectionEvaluator.PermissionAtom::actionClass)
                    .thenComparing(GrantIntersectionEvaluator.PermissionAtom::resource);

    private final GrantPresetBindingRepository bindingRepository;
    private final AuthorizationGrantRepository grantRepository;
    private final UserRepository userRepository;
    private final AgentPrincipalRepository agentPrincipalRepository;
    private final GrantIntersectionEvaluator evaluator;
    private final PresetGrantMaterializer materializer;
    private final RequesterAuthority requesterAuthority;

    public PresetGovernanceService(GrantPresetBindingRepository bindingRepository,
                                   AuthorizationGrantRepository grantRepository,
                                   UserRepository userRepository,
                                   AgentPrincipalRepository agentPrincipalRepository,
                                   GrantIntersectionEvaluator evaluator,
                                   PresetGrantMaterializer materializer,
                                   RequesterAuthority requesterAuthority) {
        this.bindingRepository = bindingRepository;
        this.grantRepository = grantRepository;
        this.userRepository = userRepository;
        this.agentPrincipalRepository = agentPrincipalRepository;
        this.evaluator = evaluator;
        this.materializer = materializer;
        this.requesterAuthority = requesterAuthority;
    }

    // ── authorization helpers (called by the controller, in this order) ──────

    /** Read face: the same atom that gates {@code /api/v1/bindings}. */
    public void requireReadAuthority() {
        requesterAuthority.requireManageRoles();
    }

    /** Write face: {@code MANAGE_ROLES} plus {@code MANAGE_WORKSPACE_AGENTS} per touched workspace. */
    public void requireRealignAuthority(String subjectType, UUID subjectId) {
        requesterAuthority.requireManageRoles();
        for (UUID workspaceId : workspaceScopesTouchedBy(subjectType, subjectId)) {
            requesterAuthority.requireWorkspaceBindingAuthority(workspaceId);
        }
    }

    /** {@code user} / {@code agent_principal} only; anything else is a 400, never an empty answer. */
    public String normalizeSubjectType(String raw) {
        String type = raw == null ? null : raw.trim();
        if (type == null || type.isEmpty()) {
            throw invalid("subjectType is required (user | agent_principal)");
        }
        if (!GrantPrincipalPathResolver.USER.equals(type)
                && !GrantPrincipalPathResolver.AGENT_PRINCIPAL.equals(type)) {
            throw invalid("unsupported subjectType: " + type);
        }
        return type;
    }

    public UUID parseSubjectId(String raw) {
        if (raw == null || raw.isBlank()) {
            throw invalid("subjectId is required");
        }
        try {
            return UUID.fromString(raw.trim());
        } catch (IllegalArgumentException e) {
            throw invalid("subjectId must be a UUID");
        }
    }

    /** Runs <b>after</b> authorization, so a refusal never reveals whether the subject exists. */
    public void requireKnownSubject(String subjectType, UUID subjectId) {
        boolean exists = GrantPrincipalPathResolver.USER.equals(subjectType)
                ? userRepository.existsById(subjectId)
                : agentPrincipalRepository.existsById(subjectId);
        if (!exists) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "SUBJECT_NOT_FOUND",
                    "No such " + subjectType + " subject");
        }
    }

    // ── read face ────────────────────────────────────────────────────────────

    /** Differences between the bound templates and the subject's current assigned rows. */
    public PresetGovernanceViews.CompareView compare(String subjectType, UUID subjectId,
                                                    UUID presetId) {
        List<GrantPresetBinding> bindings =
                bindingRepository.findBySubjectTypeAndSubjectId(subjectType, subjectId);
        if (presetId != null) {
            List<GrantPresetBinding> filtered = new ArrayList<>();
            for (GrantPresetBinding binding : bindings) {
                if (presetId.equals(binding.getRoleId())) {
                    filtered.add(binding);
                }
            }
            bindings = filtered;
        }
        Map<AccessScope, Map<GrantIntersectionEvaluator.PermissionAtom, Set<UUID>>> desired =
                materializer.desiredByScopeAndOrigin(bindings);
        List<AuthorizationGrant> current = grantRepository.findBySubjectTypeAndSubjectIdAndSource(
                subjectType, subjectId, PresetGrantMaterializer.SOURCE_ASSIGNED);
        return classifyDiff(evaluator, subjectType, subjectId, desired, current);
    }

    /**
     * The <b>only</b> classifier. Row identity, the NULL-origin protection and the
     * "only this group's atoms leave the table" rule are the ones
     * {@code PresetGrantMaterializer.reconcile} implements; a compare therefore reports exactly
     * what a realign would do.
     */
    static PresetGovernanceViews.CompareView classifyDiff(
            GrantIntersectionEvaluator evaluator, String subjectType, UUID subjectId,
            Map<AccessScope, Map<GrantIntersectionEvaluator.PermissionAtom, Set<UUID>>> desired,
            List<AuthorizationGrant> current) {

        // (scope, atom, origin-or-sentinel) -> row, exactly like reconcile().
        Map<AccessScope, Map<Map.Entry<GrantIntersectionEvaluator.PermissionAtom, UUID>,
                AuthorizationGrant>> existing = new LinkedHashMap<>();
        Map<AccessScope, List<PresetGovernanceViews.AtomView>> malformed =
                new LinkedHashMap<>();
        for (AuthorizationGrant grant : current) {
            AccessScope scope = PresetGrantMaterializer.scopeOfGrant(grant);
            Set<GrantIntersectionEvaluator.PermissionAtom> atoms =
                    evaluator.parseStored(grant.getPermissions());
            Map<Map.Entry<GrantIntersectionEvaluator.PermissionAtom, UUID>, AuthorizationGrant> byKey =
                    existing.computeIfAbsent(scope, ignored -> new LinkedHashMap<>());
            if (atoms.size() != 1) {
                // reconcile() deletes every malformed row: report it as an extra so the UI can
                // show "realign will repair this" instead of hiding a pending write.
                malformed.computeIfAbsent(scope, ignored -> new ArrayList<>())
                        .add(rawAtomView(grant));
                continue;
            }
            GrantIntersectionEvaluator.PermissionAtom atom = atoms.iterator().next();
            UUID origin = grant.getOriginPresetId() == null
                    ? UNATTRIBUTED_ORIGIN : grant.getOriginPresetId();
            byKey.put(Map.entry(atom, origin), grant);
        }

        Set<AccessScope> scopes = new LinkedHashSet<>();
        scopes.addAll(desired.keySet());
        scopes.addAll(existing.keySet());
        scopes.addAll(malformed.keySet());

        List<PresetGovernanceViews.ScopeDiffView> diffs = new ArrayList<>();
        int totalMissing = 0;
        int totalExtra = 0;
        int totalLocal = 0;
        int totalOverridden = 0;
        for (AccessScope scope : sortedScope(scopes)) {
            Map<GrantIntersectionEvaluator.PermissionAtom, Set<UUID>> wanted =
                    desired.getOrDefault(scope, Map.of());
            Map<Map.Entry<GrantIntersectionEvaluator.PermissionAtom, UUID>, AuthorizationGrant> rows =
                    existing.getOrDefault(scope, Map.of());

            // missing: desired (atom, group) with no current row.
            Map<GrantIntersectionEvaluator.PermissionAtom, List<UUID>> missing = new LinkedHashMap<>();
            for (Map.Entry<GrantIntersectionEvaluator.PermissionAtom, Set<UUID>> entry
                    : wanted.entrySet()) {
                for (UUID origin : entry.getValue()) {
                    if (!rows.containsKey(Map.entry(entry.getKey(), origin))) {
                        missing.computeIfAbsent(entry.getKey(), ignored -> new ArrayList<>())
                                .add(origin);
                    }
                }
            }
            // extra: attributed rows the owning group no longer carries + malformed rows.
            Map<GrantIntersectionEvaluator.PermissionAtom, List<UUID>> extra = new LinkedHashMap<>();
            Map<GrantIntersectionEvaluator.PermissionAtom, List<UUID>> localAdded = new LinkedHashMap<>();
            for (Map.Entry<Map.Entry<GrantIntersectionEvaluator.PermissionAtom, UUID>,
                    AuthorizationGrant> row : rows.entrySet()) {
                GrantIntersectionEvaluator.PermissionAtom atom = row.getKey().getKey();
                UUID origin = row.getKey().getValue();
                if (UNATTRIBUTED_ORIGIN.equals(origin)) {
                    // Local work: no group owns it, so no realign may delete it (R39).
                    localAdded.computeIfAbsent(atom, ignored -> new ArrayList<>()).add(null);
                    continue;
                }
                if (!wanted.getOrDefault(atom, Set.of()).contains(origin)) {
                    extra.computeIfAbsent(atom, ignored -> new ArrayList<>()).add(origin);
                }
            }
            List<PresetGovernanceViews.AtomView> malformedAtoms =
                    malformed.getOrDefault(scope, List.of());

            // overridden: a missing atom that the subject also holds locally in this scope.
            List<GrantIntersectionEvaluator.PermissionAtom> overridden = new ArrayList<>();
            for (GrantIntersectionEvaluator.PermissionAtom atom : missing.keySet()) {
                if (localAdded.containsKey(atom)) {
                    overridden.add(atom);
                }
            }

            List<PresetGovernanceViews.MissingAtomView> missingView = new ArrayList<>();
            for (Map.Entry<GrantIntersectionEvaluator.PermissionAtom, List<UUID>> entry
                    : sortedAtoms(missing).entrySet()) {
                List<UUID> origins = new ArrayList<>(entry.getValue());
                origins.sort(Comparator.comparing(UUID::toString));
                missingView.add(new PresetGovernanceViews.MissingAtomView(
                        entry.getKey().actionClass(), entry.getKey().resource(), origins));
            }
            List<PresetGovernanceViews.ExtraAtomView> extraView = new ArrayList<>();
            for (Map.Entry<GrantIntersectionEvaluator.PermissionAtom, List<UUID>> entry
                    : sortedAtoms(extra).entrySet()) {
                List<UUID> origins = entry.getValue();
                origins.sort(Comparator.comparing(
                        (UUID id) -> id == null ? "" : id.toString()));
                for (int i = 0; i < origins.size(); i++) {
                    extraView.add(new PresetGovernanceViews.ExtraAtomView(
                            entry.getKey().actionClass(), entry.getKey().resource(),
                            origins.get(i)));
                }
            }
            // Malformed rows carry no mappable atom identity; list them with their raw
            // actionClass/resource so the difference is visible, sorted after the attributed ones.
            List<PresetGovernanceViews.AtomView> sortedMalformed = new ArrayList<>(malformedAtoms);
            sortedMalformed.sort(Comparator
                    .comparing(PresetGovernanceViews.AtomView::actionClass)
                    .thenComparing(PresetGovernanceViews.AtomView::resource));
            for (PresetGovernanceViews.AtomView atom : sortedMalformed) {
                extraView.add(new PresetGovernanceViews.ExtraAtomView(
                        atom.actionClass(), atom.resource(), null));
            }
            List<PresetGovernanceViews.AtomView> localView = atomsOf(localAdded);
            List<PresetGovernanceViews.AtomView> overriddenView = new ArrayList<>();
            overridden.sort(ATOM_ORDER);
            for (GrantIntersectionEvaluator.PermissionAtom atom : overridden) {
                overriddenView.add(new PresetGovernanceViews.AtomView(
                        atom.actionClass(), atom.resource()));
            }

            totalMissing += missingView.size();
            totalExtra += extraView.size();
            totalLocal += localView.size();
            totalOverridden += overriddenView.size();
            diffs.add(new PresetGovernanceViews.ScopeDiffView(scope.type(), scope.id(),
                    missingView, extraView, localView, overriddenView,
                    missingView.isEmpty() && extraView.isEmpty()
                            && localView.isEmpty() && overriddenView.isEmpty()));
        }
        return new PresetGovernanceViews.CompareView(subjectType, subjectId, diffs,
                new PresetGovernanceViews.SummaryView(totalMissing, totalExtra, totalLocal,
                        totalOverridden, totalMissing > 0 || totalExtra > 0));
    }

    // ── write face ───────────────────────────────────────────────────────────

    /**
     * Replays every preset bound to the subject into its own import groups and bumps the user
     * epoch <b>only when</b> the set actually changed (a no-op realign must not log anybody out).
     */
    public PresetGovernanceViews.RealignView realign(String subjectType, UUID subjectId,
                                                     UUID actorUserId, String auditWorkspaceId) {
        PresetGrantMaterializer.Result result = materializer.materializeSubjectAndBumpIfChanged(
                subjectType, subjectId, actorUserId, auditWorkspaceId);
        return new PresetGovernanceViews.RealignView(result.created(), result.deleted(),
                result.changed(), result.scopes(), PresetGrantMaterializer.SOURCE_ASSIGNED);
    }

    /**
     * Workspaces whose rows this subject's realign may touch: its bound workspace scopes <b>and</b>
     * the scopes of its current assigned rows (a stale row whose binding is gone is still a write
     * in that workspace).
     */
    private Set<UUID> workspaceScopesTouchedBy(String subjectType, UUID subjectId) {
        Set<UUID> workspaceIds = new LinkedHashSet<>();
        for (GrantPresetBinding binding : bindingRepository
                .findBySubjectTypeAndSubjectId(subjectType, subjectId)) {
            if (AccessScope.WORKSPACE.equals(binding.getScopeType()) && binding.getScopeId() != null) {
                workspaceIds.add(binding.getScopeId());
            }
        }
        for (AuthorizationGrant grant : grantRepository.findBySubjectTypeAndSubjectIdAndSource(
                subjectType, subjectId, PresetGrantMaterializer.SOURCE_ASSIGNED)) {
            if (AccessScope.WORKSPACE.equals(grant.getScopeType()) && grant.getScopeId() != null) {
                workspaceIds.add(grant.getScopeId());
            }
        }
        return workspaceIds;
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private static Set<AccessScope> sortedScope(Set<AccessScope> scopes) {
        // Instance first, then workspace ids; a stable order keeps the wire diff reviewable.
        java.util.TreeSet<AccessScope> ordered = new java.util.TreeSet<>(
                Comparator.comparing((AccessScope scope) -> scope.isInstance() ? 0 : 1)
                        .thenComparing(scope -> scope.id() == null ? "" : scope.id().toString()));
        ordered.addAll(scopes);
        return ordered;
    }

    /** Best-effort display of a stored row the kernel cannot match (it deletes it on realign). */
    private static PresetGovernanceViews.AtomView rawAtomView(AuthorizationGrant grant) {
        if (grant.getPermissions() != null && grant.getPermissions().isArray()
                && !grant.getPermissions().isEmpty()) {
            com.fasterxml.jackson.databind.JsonNode first = grant.getPermissions().get(0);
            String actionClass = first.path("actionClass").asText("<malformed>");
            String resource = first.path("resource").asText("*");
            if (resource.isBlank()) {
                resource = "*";
            }
            return new PresetGovernanceViews.AtomView(actionClass, resource);
        }
        return new PresetGovernanceViews.AtomView("<malformed>", "*");
    }

    private static Map<GrantIntersectionEvaluator.PermissionAtom, List<UUID>> sortedAtoms(
            Map<GrantIntersectionEvaluator.PermissionAtom, List<UUID>> buckets) {
        Map<GrantIntersectionEvaluator.PermissionAtom, List<UUID>> ordered = new LinkedHashMap<>();
        buckets.keySet().stream().sorted(ATOM_ORDER)
                .forEach(atom -> ordered.put(atom, buckets.get(atom)));
        return ordered;
    }

    private static List<PresetGovernanceViews.AtomView> atomsOf(
            Map<GrantIntersectionEvaluator.PermissionAtom, List<UUID>> buckets) {
        List<PresetGovernanceViews.AtomView> view = new ArrayList<>();
        for (GrantIntersectionEvaluator.PermissionAtom atom : sortedAtoms(buckets).keySet()) {
            view.add(new PresetGovernanceViews.AtomView(atom.actionClass(), atom.resource()));
        }
        return view;
    }

    private static CpApiException invalid(String detail) {
        return new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", detail);
    }
}
