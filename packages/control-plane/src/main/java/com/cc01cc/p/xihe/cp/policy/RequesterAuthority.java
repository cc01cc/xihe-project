package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0610 W3-2a: <b>action-atom</b> gates for the role/binding administration surface.
 *
 * <p>This is the counterpart of {@link AuthzContext}: that class answers capability questions
 * ({@code cap:instance:admin}) because capability atoms become Spring authorities (decision #23 /
 * R2-5), while action atoms ({@code read}, {@code MANAGE_ROLES}, ...) never leave the grant table —
 * they are answered from the materialized {@code source='preset'} rows through the same scoped read
 * the evaluation kernel uses ({@link AuthorizationGrantRepository#findScopedGrants}). A Spring
 * expression such as {@code @PreAuthorize("@requesterAuthority.holdsActionAtom('MANAGE_ROLES')")}
 * is therefore the honest way to put the design's {@code MANAGE_ROLES} gate on an endpoint: adding
 * a fourth capability atom for it would contradict decision #23, and {@code hasAuthority('…')}
 * cannot express an action atom.</p>
 *
 * <p>Scope follows the evaluation kernel exactly: instance rows always participate, workspace rows
 * only for the workspace being addressed (design #11, explicit and non-inheriting).</p>
 */
@Component
public class RequesterAuthority {

    private static final Logger logger = LoggerFactory.getLogger(RequesterAuthority.class);

    private final AuthorizationGrantRepository grantRepository;
    private final GrantIntersectionEvaluator evaluator;
    private final AuthzContext authzContext;
    private final OrgUnitGrants orgUnitGrants;

    public RequesterAuthority(AuthorizationGrantRepository grantRepository,
                              GrantIntersectionEvaluator evaluator,
                              AuthzContext authzContext,
                              OrgUnitGrants orgUnitGrants) {
        this.grantRepository = grantRepository;
        this.evaluator = evaluator;
        this.authzContext = authzContext;
        this.orgUnitGrants = orgUnitGrants;
    }

    /**
     * PLAN-0773 M2-8b: the scoped rows <b>plus</b> whatever the subject holds through its org units.
     *
     * <p>Every evaluation read goes through this one method, so "did we wire this site?" is a grep
     * for <b>one</b> name rather than an audit of four call shapes ({@code tasks.md:106}: forgetting
     * one site means silently granting less, which no test of the other three would catch). The
     * org-unit rows are in-memory {@code AuthorizationGrant}s with {@code scopeType='instance'} and
     * are unioned here, never persisted.</p>
     *
     * <p>Adding rows cannot widen a decision beyond what the same role would grant through a
     * binding: {@code M2-8c}'s whitelist limits org-unit roles to governance atoms, and the
     * expansion drops anything else ({@link OrgUnitGovernancePolicy#filterGovernanceRoles}). The
     * union is taken on the evaluator's own atom type, so resource matching stays in one place.</p>
     */
     private List<AuthorizationGrant> withOrgUnitGrants(String principalType, UUID subjectId,
                                                       List<AuthorizationGrant> scopedGrants) {
        return OrgUnitGrants.merge(scopedGrants, orgUnitGrants.forPrincipal(principalType, subjectId));
    }

    /** The request's subject id, or {@code null} when the request has no authenticated user. */
    public UUID currentSubjectId() {
        return parse(TenantContext.getUserId());
    }

    /**
     * True when the <em>current request subject</em> holds the action atom at instance scope.
     * This is the SpEL entry point used by the role/binding controllers.
     */
    public boolean holdsActionAtom(String actionClass) {
        UUID subjectId = currentSubjectId();
        return subjectId != null && holdsActionAtom(subjectId, actionClass, null);
    }

    /**
     * Capability atoms are answered by the capability kernel (decision #23), not by the grant
     * table. This is the SpEL/service entry point for {@code cap:instance:admin} checks.
     */
    public boolean holdsCapabilityAtom(String atom) {
        UUID subjectId = currentSubjectId();
        return subjectId != null && authzContext.capabilitiesFor(subjectId)
                .holdsCapability(AtomNames.capability(atom), null);
    }

    /**
     * task-869 L4: the <b>throwing</b> twin of {@link #holdsActionAtom(String)} for
     * {@code @PreAuthorize} gates.
     *
     * <p>Why not keep the boolean expression: Spring's {@code AccessDeniedException} carries no
     * atom, so the problem response could only say "FORBIDDEN" — the caller had no way to learn
     * <i>which</i> atom was missing or at which level. This method refuses with
     * {@code 403 code=FORBIDDEN} plus {@code missingAtom}/{@code missingLevel} taken from
     * {@link GrantIntersectionEvaluator.GrantExplanation} — the same kernel {@code /explain} and
     * real tool calls use, so the two cannot answer differently.</p>
     *
     * <p>The boolean method stays for call sites that make a <i>non-refusing</i> decision (e.g.
     * "show the hostPath or not"); only gates that must terminate the request use this one.</p>
     */
    public boolean requireActionAtom(String actionClass) {
        if (holdsActionAtom(actionClass)) {
            return true;
        }
        throw actionAtomDenied(actionClass);
    }

    /**
     * task-869 L4: throwing twin of {@link #holdsCapabilityAtom(String)}. A capability refusal has
     * no grant levels, so the level is {@code -1} and the reason names the capability vocabulary.
     */
    public boolean requireCapabilityAtom(String atom) {
        if (holdsCapabilityAtom(atom)) {
            return true;
        }
        String canonical = AtomNames.capability(atom);
        Map<String, Object> miss = missingAtom(-1, null, canonical, "*", "capability_not_held");
        throw denial(canonical, miss, -1);
    }

    private CpApiException actionAtomDenied(String actionClass) {
        String canonical = AtomNames.action(actionClass);
        if (ToolFaceRegistry.isCredentialActionClass(canonical)) {
            // A credential gate needs a concrete credential:<uuid> to be explained (PolicyRequest
            // rejects credential:* / *), and the gate itself is evaluated per concrete object
            // elsewhere. Say exactly that instead of inventing a resource.
            return denial(canonical, missingAtom(-1, null, canonical, null,
                    "credential_use_requires_concrete_resource"), -1);
        }
        String resource = ResourceNamespaces.canonicalResourceFor(canonical);
        try {
            UUID workspaceId = parse(TenantContext.getWorkspaceId());
            PolicyRequest request = new PolicyRequest("authorization.deny", List.of(canonical),
                    List.of(resource), ToolShape.OPAQUE, TenantContext.getUserId(),
                    TenantContext.getWorkspaceId(), null);
            GrantIntersectionEvaluator.GrantExplanation explanation =
                    explainForUser(request, workspaceId);
            if (explanation.allowed()) {
                // The atom is held, so this refusal did not come from the grant table. Naming the
                // held atom again would be a false explanation; name the split instead.
                return denial(canonical, missingAtom(-1, null, canonical, resource,
                        "denied_by_gate_outside_grant_atoms"), -1);
            }
            GrantIntersectionEvaluator.MissingLevel miss = explanation.missingAtom();
            Map<String, Object> row = miss == null
                    ? missingAtom(-1, null, canonical, resource, "not_evaluated")
                    : missingAtom(miss.level(), miss.levelLabel(), miss.actionClass(),
                            miss.resource(), miss.reason());
            return denial(canonical, row, explanation.deepestMissingLevel());
        } catch (RuntimeException unavailable) {
            logger.warn("[AUTH] action_atom_deny_explanation_unavailable atom={} reason={}",
                    canonical, unavailable.getClass().getSimpleName());
            return denial(canonical, missingAtom(-1, null, canonical, resource,
                    "explanation_unavailable"), -1);
        }
    }

    private static CpApiException denial(String atom, Map<String, Object> missingAtom, int missingLevel) {
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("missingAtom", missingAtom);
        extra.put("missingLevel", missingLevel);
        return new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                "Access denied: missing " + atom).withExtra(extra);
    }

    private static Map<String, Object> missingAtom(int level, String levelLabel, String actionClass,
                                                   String resource, String reason) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("level", level);
        row.put("levelLabel", levelLabel);
        row.put("actionClass", actionClass);
        row.put("resource", resource);
        row.put("reason", reason);
        return row;
    }

    /** True when the subject's effective atoms for {@code workspaceId} contain the atom. */
    public boolean holdsActionAtom(UUID subjectId, String actionClass, UUID workspaceId) {
        if (subjectId == null || actionClass == null) {
            return false;
        }
        return actionAtoms(subjectId, workspaceId).contains(AtomNames.action(actionClass));
    }

    /**
     * PLAN-0651 T1.5 (A1, Lead-approved): the <b>shared kernel entry</b> for a user-driven policy
     * decision — the same "read the scoped grant rows, then let the evaluator decide" sequence that
     * {@code AgentPrincipalService#requireUserAction} used to implement locally.
     *
     * <p>Why this exists: the two implementations were only <i>accidentally</i> identical (same
     * {@code findScopedGrants} call, same {@link GrantSources#EVALUATION_SOURCES}) and would drift
     * apart. Consolidating them removes the duplicate, but the evaluation itself must not change:
     * {@link GrantIntersectionEvaluator#allows} applies resource matching
     * ({@code LayeredPolicyResolver.matches}: {@code *} / {@code credential:*} wildcards) and shape
     * constraints, which a plain {@code holdsActionAtom} set-contains does <b>not</b> — so this
     * method deliberately keeps {@code allows}.</p>
     *
     * <p>{@code scopeWorkspaceId} is passed separately on purpose: the caller's {@link PolicyRequest}
     * may carry a null workspace (it feeds shape/resource matching only), while the grant read has
     * always been scoped by an explicit parameter. Deriving the scope from the request instead would
     * silently change which grant rows participate.</p>
     *
     * <p>No {@code @Transactional(REQUIRES_NEW)} here (Lead constraint 1): the caller's transaction
     * visibility must stay exactly as before.</p>
     */
    public boolean allowsForUser(PolicyRequest request, UUID scopeWorkspaceId) {
        return explainForUser(request, scopeWorkspaceId).allowed();
    }

    /**
     * DSD-1497 (task-125): the user path <b>with its trail</b>. {@link #allowsForUser} returns this
     * result's {@code allowed()} bit instead of keeping a second copy of the sequence — the scoped
     * row read, the org-unit union and the kernel call are shared, so the explanation of a user-path
     * decision cannot drift from the decision.
     *
     * <p>The single level is labelled {@code user-grants}: the user path intersects exactly one
     * principal (the requesting user), which is why {@code scopeWorkspaceId} is a parameter here and
     * not derived from the request (design #11: instance rows always participate, workspace rows
     * only for the addressed workspace).</p>
     */
    public GrantIntersectionEvaluator.GrantExplanation explainForUser(PolicyRequest request,
                                                                     UUID scopeWorkspaceId) {
        if (request == null || request.userId() == null) {
            return GrantIntersectionEvaluator.GrantExplanation.deniedBeforeEvaluation(
                    GrantIntersectionEvaluator.REASON_NO_SUBJECT);
        }
        UUID subjectId = UUID.fromString(request.userId());
        List<GrantIntersectionEvaluator.GrantAtom> atoms = evaluator.unionAttributed(
                withOrgUnitGrants(GrantPrincipalPathResolver.USER, subjectId,
                        grantRepository.findScopedGrants(GrantPrincipalPathResolver.USER, subjectId,
                                GrantSources.EVALUATION_SOURCES, scopeWorkspaceId)));
        return evaluator.explain(request, List.of(
                new GrantIntersectionEvaluator.PrincipalLevel("user-grants", atoms)));
    }

    /**
     * The subject's effective action atoms for one request scope: instance rows plus (when a
     * workspace is addressed) that workspace's rows. Retired sources are excluded through
     * {@link GrantSources#EVALUATION_SOURCES}.
     */
    public Set<String> actionAtoms(UUID subjectId, UUID workspaceId) {
        if (subjectId == null) {
            return Set.of();
        }
        Set<GrantIntersectionEvaluator.PermissionAtom> atoms;
        try {
            atoms = evaluator.union(withOrgUnitGrants(AuthzContext.SUBJECT_USER, subjectId,
                    grantRepository.findScopedGrants(AuthzContext.SUBJECT_USER,
                            subjectId, GrantSources.EVALUATION_SOURCES, workspaceId)));
        } catch (RuntimeException e) {
            // task-213 (fail-closed, Lead ruling A): an unreadable grant store must never widen
            // authority, and it must not masquerade as "the subject holds nothing" either - a 403
            // would blame the caller for a server-side failure. Refuse with a 500 that names the
            // failure type so the real cause stays visible in the response and the log.
            throw evaluationUnavailable("action_atom_evaluation_failed", subjectId, workspaceId, e);
        }
        Set<String> names = new LinkedHashSet<>();
        atoms.forEach(atom -> names.add(atom.actionClass()));
        return Set.copyOf(names);
    }

    /**
     * BL-345: which grant <b>sources</b> currently carry {@code actionClass} for this subject at the
     * evaluator's scope. The audit detail uses this so a memory-write decision can say where its atom
     * came from ({@code role} for a catalog grant, {@code direct} for an explicit grant, ...) instead
     * of an opaque "allowed".
     */
    public Set<String> atomSources(UUID subjectId, String actionClass, UUID workspaceId) {
        // Kept as the degrade-by-default view (Lead ruling A: the audit-only faces may not start
        // failing writes). Callers that must tell "no source" from "could not look" use
        // {@link #atomSourceLookup}, which carries the three-state status instead of flattening it.
        return atomSourceLookup(subjectId, actionClass, workspaceId).sources();
    }

    /**
     * task-213: the three-state atom-source lookup. {@code atomSources} used to fold "the grant
     * store could not be read" into the same empty set that means "the subject holds the atom from
     * no source", so a missing table/column turned into a {@code source=none} deny audit line and a
     * 403 escalation refusal. This variant keeps the degrade (an audit face must not fail a write)
     * but the caller can now see <b>which</b> of the three situations it got:
     *
     * <ul>
     *   <li>{@link AtomSourceStatus#PRESENT} — rows carried the atom; {@code sources} is non-empty;</li>
     *   <li>{@link AtomSourceStatus#NONE} — the lookup succeeded and no row carried it;</li>
     *   <li>{@link AtomSourceStatus#UNAVAILABLE} — the lookup <b>failed</b>; {@code failureType} holds
     *       the exception simple name and {@code sources} is empty.</li>
     * </ul>
     */
    public AtomSourceLookup atomSourceLookup(UUID subjectId, String actionClass, UUID workspaceId) {
        if (subjectId == null || actionClass == null) {
            return AtomSourceLookup.none();
        }
        LinkedHashSet<String> sources = new LinkedHashSet<>();
        try {
            // task-835: the lookup name may arrive bare (face/caller vocabulary) while a stored
            // grant row carries the canonical `action:` spelling. Compare canonical on both sides,
            // otherwise a healthy store answers "none" for a held atom.
            String wanted = AtomNames.action(actionClass);
            for (AuthorizationGrant grant : withOrgUnitGrants(AuthzContext.SUBJECT_USER, subjectId,
                    grantRepository.findScopedGrants(AuthzContext.SUBJECT_USER,
                            subjectId, GrantSources.EVALUATION_SOURCES, workspaceId))) {
                if (grant.getPermissions() == null) {
                    continue;
                }
                for (com.fasterxml.jackson.databind.JsonNode permission : grant.getPermissions()) {
                    String stored = permission.path("actionClass").asText();
                    if (wanted.equals(AtomNames.action(AtomNames.bare(stored)))) {
                        sources.add(grant.getSource());
                        break;
                    }
                }
            }
        } catch (RuntimeException e) {
            logger.warn("[POLICY] event=workspace_atom_source_lookup_failed subject={} atom={} failureType={} status=unavailable",
                    subjectId, actionClass, e.getClass().getSimpleName());
            return AtomSourceLookup.unavailable(e.getClass().getSimpleName());
        }
        return sources.isEmpty() ? AtomSourceLookup.none() : AtomSourceLookup.present(Set.copyOf(sources));
    }

    /**
     * PLAN-0651 T1.5 (proposal B, Lead-approved 2026-11-06): one WARN line per denied
     * action-atom authority decision — {@code [POLICY] event=action_atom_denied}, the canonical
     * deny audit stream (T1.5-proposals.md B2/B3). Every field is a closed vocabulary: the atom
     * is a {@link PermissionAtomCatalog} name (or {@code -} when the denial is not a catalog
     * decision), subject and workspace are uuids ({@code -} when absent), and {@code source}
     * lists the {@link GrantSources#EVALUATION_SOURCES} rows carrying the atom — {@code none}
     * when the subject holds it from no source at all, the "why was this denied" key. No names,
     * emails, resource strings or content fragments (B4): a denial stays at the atom layer and
     * never goes to {@code audit_logs}.
     */
    public void logActionAtomDenied(String atom, UUID subjectId, UUID workspaceId) {
        String catalogAtom = PermissionAtomCatalog.isActionAtom(atom)
                || PermissionAtomCatalog.isCapabilityAtom(atom)
                ? (PermissionAtomCatalog.isCapabilityAtom(atom)
                        ? AtomNames.capability(atom) : AtomNames.action(atom))
                : "-";
        AtomSourceLookup lookup = atomSourceLookup(subjectId, catalogAtom, workspaceId);
        // Deterministic log output: atomSourceLookup's set is an unordered Set.copyOf view, sort first.
        String joined = lookup.sources().stream().sorted()
                .collect(java.util.stream.Collectors.joining(","));
        logger.warn("[POLICY] event=action_atom_denied atom={} subject={} workspaceId={} source={}",
                catalogAtom, subjectId == null ? "-" : subjectId,
                workspaceId == null ? "-" : workspaceId,
                lookup.sourceField(joined));
    }

    /** Canonical action/resource rows at the evaluator's exact scope, retaining resource bounds. */
    public Set<GrantIntersectionEvaluator.PermissionAtom> actionPermissions(UUID subjectId,
                                                                            UUID workspaceId) {
        if (subjectId == null) {
            return Set.of();
        }
        try {
            return evaluator.union(withOrgUnitGrants(AuthzContext.SUBJECT_USER, subjectId,
                    grantRepository.findScopedGrants(AuthzContext.SUBJECT_USER,
                            subjectId, GrantSources.EVALUATION_SOURCES, workspaceId)));
        } catch (RuntimeException e) {
            // task-213 (Lead ruling A): this was the swallow that made task-202's 27 reds look like
            // "the caller holds nothing" at GrantabilityGuard (403 "Cannot grant atoms the caller does
            // not hold"). It now surfaces as an identifiable 500 instead of a permissions verdict.
            throw evaluationUnavailable("tool_permission_evaluation_failed", subjectId, workspaceId, e);
        }
    }

    /**
     * W3-2a {@code MANAGE_ROLES} gate as a service call, for the paths whose decision needs the
     * resource row first (for example a workspace-scoped binding write).
     */
    public void requireManageRoles() {
        if (!holdsActionAtom(ToolFaceRegistry.ACTION_MANAGE_ROLES)) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "MANAGE_ROLES is required to administer access roles");
        }
    }

    /**
     * W3-2a: a workspace-scope binding write additionally requires
     * {@code MANAGE_WORKSPACE_AGENTS} <b>in that workspace</b> (design §3.5). An instance-scope
     * binding of that atom covers every workspace (decision #27), a workspace binding covers its
     * own workspace only.
     */
    public void requireWorkspaceBindingAuthority(UUID workspaceId) {
        UUID subjectId = currentSubjectId();
        if (subjectId == null
                || !holdsActionAtom(subjectId, ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS,
                workspaceId)) {
            logger.warn("[POLICY] event=binding_write_denied workspaceId={} reason=no_manage_workspace_agents",
                    workspaceId);
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "MANAGE_WORKSPACE_AGENTS is required to administer this workspace's bindings");
        }
    }

    /**
     * Escalation check (design §5 {@code 403 PRIVILEGE_ESCALATION}): every atom of the roles being
     * bound must already be held by the caller in the same scope. Action atoms are compared against
     * the scoped grant union; capability atoms against {@link AuthzContext}, which is where they
     * live. A denied target atom is logged through {@link #logActionAtomDenied} (PLAN-0651 T1.5
     * proposal B).
     */
    public void requireMayGrant(Set<String> requestedAtoms, UUID workspaceId) {
        UUID subjectId = currentSubjectId();
        if (subjectId == null) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "Authentication required");
        }
        Set<String> held = actionAtoms(subjectId, workspaceId);
        AuthzContext.Capabilities capabilities = authzContext.capabilitiesFor(subjectId);
        for (String atom : requestedAtoms) {
            boolean allowed = PermissionAtomCatalog.isCapabilityAtom(atom)
                    ? mayGrantCapability(capabilities, atom, workspaceId)
                    : held.contains(atom);
            if (!allowed) {
                logActionAtomDenied(atom, subjectId, workspaceId);
                throw new CpApiException(HttpStatus.FORBIDDEN, "PRIVILEGE_ESCALATION",
                        "Cannot grant an atom the caller does not hold: " + atom);
            }
        }
    }

    /**
     * PLAN-0651 T1.2 (D51-30): the escalation check is now <b>atom-based</b>. The caller may grant a
     * capability atom when it holds that atom in the addressed scope, or when a held atom
     * <b>implies</b> it per {@link PermissionAtomCatalog#impliedHolders(String)} — one implication
     * chain only (`instance:super ⇒ instance:admin ⇒ workspace:admin`), and it lives here in the
     * grant-validation path, never as an implicit grant in the default sets.
     */
    private static boolean mayGrantCapability(AuthzContext.Capabilities capabilities, String atom,
                                              UUID workspaceId) {
        if (capabilities.holdsCapability(atom, workspaceId)) {
            return true;
        }
        for (String holder : PermissionAtomCatalog.impliedHolders(atom)) {
            if (capabilities.holdsCapability(holder, workspaceId)) {
                return true;
            }
        }
        return false;
    }

    /** The caller holds {@code MANAGE_ROLES}; used by unit tests and callers outside SpEL. */
    public boolean canManageRoles() {
        return holdsActionAtom(ToolFaceRegistry.ACTION_MANAGE_ROLES);
    }

    /**
     * task-213: the stable problem code for "the authorization store could not be read". The
     * decision is fail-closed <b>and</b> identifiable: 500 (a server-side failure, never the
     * caller's permissions) with a code that says so, instead of the old empty-set ⇒ 403 disguise.
     */
    public static final String POLICY_EVALUATION_FAILED = "POLICY_EVALUATION_FAILED";

    /**
     * task-213: build the {@code 500 POLICY_EVALUATION_FAILED} refusal for an unreadable grant
     * store. One shape for every evaluation read so the wire response, the problem code and the
     * log line cannot drift apart ({@code event=…} keeps each site distinguishable).
     */
    private CpApiException evaluationUnavailable(String event, UUID subjectId, UUID workspaceId,
                                                 RuntimeException cause) {
        logger.error("[POLICY] event={} subject={} workspaceId={} failureType={} decision=fail-closed status=500",
                event, subjectId, workspaceId, cause.getClass().getSimpleName(), cause);
        return new CpApiException(HttpStatus.INTERNAL_SERVER_ERROR, POLICY_EVALUATION_FAILED,
                "Authorization could not be evaluated (" + cause.getClass().getSimpleName()
                        + "); the request is refused (fail-closed)", cause);
    }

    /** task-213: which of the three situations an atom-source lookup ended in. */
    public enum AtomSourceStatus {
        /** Rows carried the atom; the source set is non-empty. */
        PRESENT,
        /** The lookup succeeded and no row carried the atom. */
        NONE,
        /** The lookup failed; the degrade returned an empty set that must not be read as "none". */
        UNAVAILABLE
    }

    /**
     * task-213: the three-state result of {@link #atomSourceLookup}. {@code failureType} is the
     * exception simple name when {@link AtomSourceStatus#UNAVAILABLE}, otherwise {@code "-"}.
     */
    public record AtomSourceLookup(Set<String> sources, AtomSourceStatus status, String failureType) {

        static AtomSourceLookup present(Set<String> sources) {
            return new AtomSourceLookup(sources, AtomSourceStatus.PRESENT, "-");
        }

        static AtomSourceLookup none() {
            return new AtomSourceLookup(Set.of(), AtomSourceStatus.NONE, "-");
        }

        static AtomSourceLookup unavailable(String failureType) {
            return new AtomSourceLookup(Set.of(), AtomSourceStatus.UNAVAILABLE, failureType);
        }

        /** The deny-log {@code source=} field: {@code none} / {@code unavailable} / {@code a,b}. */
        public String sourceField(String joinedSources) {
            return switch (status) {
                case UNAVAILABLE -> "unavailable";
                case NONE -> "none";
                case PRESENT -> joinedSources;
            };
        }
    }

    private static UUID parse(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value.trim());
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
