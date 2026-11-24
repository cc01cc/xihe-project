package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.GrantPresetBinding;
import com.cc01cc.p.xihe.cp.repository.GrantPresetBindingRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0673 M1: the <b>single</b> grant-side guard ("闸门②"). Every write path that grants access
 * roles or role bindings must call {@link #assertGrantable(Set, AccessScope)} from its service
 * layer; controllers keep only the authentication/atom gate ({@code MANAGE_ROLES}) and never decide
 * subset questions themselves.
 *
 * <p>Two-layer judgement (design §6):</p>
 * <ul>
 *   <li><b>Role definition</b> ({@code scope == null}): the role's atoms must be a subset of what
 *       the caller holds in <b>any</b> scope. A definition is inert until bound; the binding path
 *       re-checks at the concrete scope.</li>
 *   <li><b>Binding</b> ({@code scope != null}): the atoms must be a subset of what the caller holds
 *       in <b>that target scope</b> — instance rows always participate, workspace rows only for the
 *       addressed workspace (instance ⊇ workspace, never the reverse).</li>
 * </ul>
 *
 * <p><b>Agent templates are the one documented exception</b> (task-971): materializing an agent
 * preset is not "granting" in the human sense — the caller instantiates a platform-managed template
 * whose atoms the platform, not the caller, decides (a human deliberately does not hold
 * {@code action:clone}; an agent preset does, per D-1935). That path uses the named
 * {@link #assertAgentTemplateGrantable(Set, AccessScope)} instead of the subset question: the atom
 * must be one an agent may hold at all, and the caller must hold the agent-tier authority for the
 * target scope. Human-to-human grants and role definitions keep {@link #assertGrantable} verbatim.</p>
 *
 * <p>Refusal shape: <b>403 {@code PRIVILEGE_ESCALATION}</b> with the offending atoms named. The
 * {@code cap} gate (BL-287) stays a separate <b>409</b> — this guard never answers 409.</p>
 *
 * <p><b>M2 hook (D-166, do not implement here):</b> a caller holding {@code GRANT_ANY_ATOM} at
 * instance scope bypasses the subset check, and every bypass use must be audited. The TODO below is
 * the reserved seam so M2 only fills the branch.</p>
 */
@Service
public class GrantabilityGuard {

    private static final Logger logger = LoggerFactory.getLogger(GrantabilityGuard.class);

    private final RequesterAuthority requester;
    private final AuthzContext authzContext;
    private final GrantPresetBindingRepository bindings;
    private final AuditLogger audit;
    private final TransactionTemplate denialAuditTransaction;

    public GrantabilityGuard(RequesterAuthority requester,
                             AuthzContext authzContext,
                             GrantPresetBindingRepository bindings,
                             AuditLogger audit,
                             PlatformTransactionManager transactionManager) {
        this.requester = requester;
        this.authzContext = authzContext;
        this.bindings = bindings;
        this.audit = audit;
        // Denials abort the caller's transaction; persist the denial row independently so the
        // rejection is auditable after the rollback.
        this.denialAuditTransaction = new TransactionTemplate(transactionManager);
        this.denialAuditTransaction.setPropagationBehavior(
                TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    }

    /**
     * The one entry: assert the current caller may grant {@code atoms}.
     *
     * @param atoms requested action/capability atoms
     * @param scope {@code null} for a role <b>definition</b> (any-scope judgement); the target
     *     {@link AccessScope} for a <b>binding</b> (target-scope judgement)
     */
    public void assertGrantable(Set<String> atoms, AccessScope scope) {
        Set<String> requestedNames = atoms == null ? Set.of() : new LinkedHashSet<>(atoms);
        if (requestedNames.stream().anyMatch(PermissionAtomCatalog::isCapabilityAtom)) {
            UUID subjectId = requester.currentSubjectId();
            if (subjectId == null) {
                throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "Authentication required");
            }
            List<String> exceeding = scope == null
                    ? exceedingInAnyScope(subjectId, requestedNames)
                    : exceedingInScope(subjectId, requestedNames, scope);
            if (requester.holdsActionAtom(subjectId, ToolFaceRegistry.ACTION_GRANT_ANY_ATOM, null)) {
                auditBypass(subjectId, requestedNames, exceeding, scope);
                return;
            }
            if (!exceeding.isEmpty()) {
                auditDenied(subjectId, requestedNames, exceeding, scope);
                throw new CpApiException(HttpStatus.FORBIDDEN, "PRIVILEGE_ESCALATION",
                        "Cannot grant atoms the caller does not hold: " + String.join(",", exceeding));
            }
            auditAllowed(subjectId, requestedNames, scope);
            return;
        }
        assertGrantableRows(atoms == null ? Set.of() : atoms.stream()
                .map(name -> new GrantIntersectionEvaluator.PermissionAtom(name,
                        canonicalResourceOf(name)))
                .collect(java.util.stream.Collectors.toCollection(LinkedHashSet::new)), scope);
    }

    /**
     * The resource a name-path request really carries: the catalog's canonical resource for that
     * atom ({@code *} for ordinary actions, {@code credential:*} for the credential family).
     *
     * <p>PLAN-0673: the name path used a literal {@code "*"}, which made every credential atom
     * request <b>wider</b> than the rows materialised from {@code grant_preset_atoms} — a legitimate
     * holder of {@code (credential_use, credential:*)} was then denied by the very
     * "concrete-does-not-cover-wildcard" rule this fix introduced (the {@code *} here was a
     * conversion artefact, not a real wildcard request). Unknown names keep the wildcard shape so
     * they still fail the subset judgement with 403 instead of turning into a 400.</p>
     */
    private static String canonicalResourceOf(String name) {
        try {
            // task-830: canonical resources (including `credential:*`) come from the atom catalog,
            // which derives them through ResourceNamespaces — one registry, not a second copy here.
            return PermissionAtomCatalog.atom(name).canonicalResource();
        } catch (RuntimeException unknownAtom) {
            return "*";
        }
    }

    /** Resource-aware variant used when canonical role rows are materialized into a binding scope. */
    public void assertGrantableRows(Set<GrantIntersectionEvaluator.PermissionAtom> requestedRows,
                                   AccessScope scope) {
        UUID subjectId = requester.currentSubjectId();
        if (subjectId == null) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "Authentication required");
        }
        Set<GrantIntersectionEvaluator.PermissionAtom> requested = requestedRows == null
                ? Set.of() : new LinkedHashSet<>(requestedRows);
        // PLAN-0673 M2 / D-166: the single bypass. It is an ATOM, never a role-name check; every use
        // is audited with the exact list of atoms the caller does not hold ("bypassed what").
        if (requester.holdsActionAtom(subjectId, ToolFaceRegistry.ACTION_GRANT_ANY_ATOM, null)) {
            List<String> skipped = exceedingRows(subjectId, requested, scope);
            auditBypass(subjectId, atomRows(requested), skipped, scope);
            return;
        }
        List<String> exceeding = exceedingRows(subjectId, requested, scope);
        if (!exceeding.isEmpty()) {
            auditDenied(subjectId, atomRows(requested), exceeding, scope);
            throw new CpApiException(HttpStatus.FORBIDDEN, "PRIVILEGE_ESCALATION",
                    "Cannot grant atoms the caller does not hold: " + String.join(",", exceeding));
        }
        auditAllowed(subjectId, atomRows(requested), scope);
    }

    /**
     * task-971: the <b>agent-template</b> write judgement — the deliberate counterpart of
     * {@link #assertGrantable} for one specific write shape.
     *
     * <p>Why the subset rule does not belong here: when a human creates an agent, it is not handing
     * itself (or another human) any atom; it is instantiating a managed template. The platform
     * decides which atoms an agent may carry (D-1935: agents clone by default, humans do not), so
     * "the caller does not hold {@code action:clone}" is not an escalation signal — it is the design.
     * Asking the subset question there refused the whole "member creates their own agent" flow
     * (task-971: {@code 403 PRIVILEGE_ESCALATION action:clone@*}).</p>
     *
     * <p>The two questions that <b>do</b> govern this write, in order:</p>
     * <ol>
     *   <li><b>may an agent hold the atom at all</b> — the catalog's agent-forbidden projection
     *       ({@link PermissionAtomCatalog#agentPrincipalForbiddenAtoms()}); a role definition or agent
     *       preset that carries an instance-administration atom is refused here as a {@code 409}, so
     *       the widening can never carry one across;</li>
     *   <li><b>may the caller administer this agent tier</b> —
     *       {@code CREATE_OWN_AGENT} / {@code MANAGE_AGENT_PRINCIPALS} at the instance scope,
     *       {@code MANAGE_WORKSPACE_AGENTS} in the target workspace (N1 covers every scope).</li>
     * </ol>
     *
     * <p>{@code GRANT_ANY_ATOM} keeps its single bypass in this path too, audited with the atoms it
     * skipped — the bypass is a distinct mechanism and must stay visible in the audit trail.</p>
     *
     * <p>Refusal shape: {@code 403 PRIVILEGE_ESCALATION} names the atoms the caller does not hold
     * (the subset list, kept for the established refusal surface) plus the missing agent-tier
     * authority; the agent-forbidden gate is the existing {@code 409}
     * {@code AGENT_PRINCIPAL_FORBIDDEN_ATOMS}.</p>
     *
     * @param atoms atoms of the template/role being materialized (canonical names)
     * @param scope the binding scope the template is materialized at ({@code null} = instance)
     */
    public void assertAgentTemplateGrantable(Set<String> atoms, AccessScope scope) {
        Set<String> requested = atoms == null ? Set.of() : new LinkedHashSet<>(atoms);
        UUID subjectId = requester.currentSubjectId();
        if (subjectId == null) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "Authentication required");
        }
        String forbidden = PermissionAtomCatalog.firstForbiddenAgentPrincipalAtom(requested);
        if (forbidden != null) {
            auditDenied(subjectId, requested, List.of(forbidden), scope);
            throw new CpApiException(HttpStatus.CONFLICT, "AGENT_PRINCIPAL_FORBIDDEN_ATOMS",
                    "atoms an agent principal may never hold: " + forbidden);
        }
        if (requester.holdsActionAtom(subjectId, ToolFaceRegistry.ACTION_GRANT_ANY_ATOM, null)) {
            auditBypass(subjectId, requested, subsetMissing(subjectId, requested, scope), scope);
            return;
        }
        if (!holdsAgentTierAuthority(subjectId, scope)) {
            List<String> missing = subsetMissing(subjectId, requested, scope);
            auditDenied(subjectId, requested, missing, scope);
            throw new CpApiException(HttpStatus.FORBIDDEN, "PRIVILEGE_ESCALATION",
                    "Cannot grant atoms the caller does not hold: " + String.join(",", missing)
                            + " (agent template materialization requires CREATE_OWN_AGENT,"
                            + " MANAGE_AGENT_PRINCIPALS or MANAGE_WORKSPACE_AGENTS in this scope)");
        }
        auditAllowed(subjectId, requested, scope);
    }

    /** The atoms of {@code requested} the caller does not hold at {@code scope} (subset list). */
    private List<String> subsetMissing(UUID subjectId, Set<String> requested, AccessScope scope) {
        return scope == null
                ? exceedingInAnyScope(subjectId, requested)
                : exceedingInScope(subjectId, requested, scope);
    }

    /**
     * The agent-tier authority the materialization runs under: instance create (own agent or N1) or
     * the workspace agent-management atom (N1 covers every scope). Never a role-name test.
     */
    private boolean holdsAgentTierAuthority(UUID subjectId, AccessScope scope) {
        if (requester.holdsActionAtom(subjectId, ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS, null)) {
            return true;
        }
        if (scope == null || scope.isInstance()) {
            return requester.holdsActionAtom(subjectId, ToolFaceRegistry.ACTION_CREATE_OWN_AGENT, null);
        }
        return requester.holdsActionAtom(subjectId, ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS,
                scope.id());
    }

    private List<String> exceedingRows(UUID subjectId,
            Set<GrantIntersectionEvaluator.PermissionAtom> requested, AccessScope scope) {
        if (scope == null) {
            // Definition judgement: "held anywhere" = instance ∪ every workspace the caller is bound
            // in — but compared as action+RESOURCE rows, not names. A caller holding only
            // `read@file1` must not be able to define a role carrying the catalog's `read@*` row,
            // otherwise the definition itself is the escalation (PLAN-0673 resource granularity).
            // Capability atoms keep the capability-projection branch.
            AuthzContext.Capabilities capabilities = authzContext.capabilitiesFor(subjectId);
            List<UUID> scopes = new ArrayList<>();
            scopes.add(null);
            for (GrantPresetBinding binding : bindings.findBySubjectTypeAndSubjectIdAndScopeType(
                    AuthzContext.SUBJECT_USER, subjectId, AccessScope.WORKSPACE)) {
                scopes.add(binding.getScopeId());
            }
            List<String> denied = new ArrayList<>();
            for (GrantIntersectionEvaluator.PermissionAtom atom : requested) {
                boolean allowed = scopes.stream().anyMatch(workspaceId -> heldCovers(
                        requester.actionPermissions(subjectId, workspaceId), capabilities,
                        workspaceId, atom));
                if (!allowed) {
                    denied.add(atom.actionClass() + "@" + atom.resource());
                }
            }
            return denied;
        }
        Set<GrantIntersectionEvaluator.PermissionAtom> held = requester.actionPermissions(subjectId, scope.id());
        AuthzContext.Capabilities capabilities = authzContext.capabilitiesFor(subjectId);
        List<String> denied = new ArrayList<>();
        for (GrantIntersectionEvaluator.PermissionAtom atom : requested) {
            if (!heldCovers(held, capabilities, scope.id(), atom)) {
                denied.add(atom.actionClass() + "@" + atom.resource());
            }
        }
        return denied;
    }

    /**
     * Does one held grant set cover the requested action+resource row?
     *
     * <p>{@code held} is the caller's row set at exactly {@code workspaceId} ({@code null} =
     * instance). Coverage is directional: a held <b>wildcard</b> covers a concrete request, a held
     * <b>concrete</b> resource never covers {@code *} — that direction is the whole point of the
     * PLAN-0673 fix. Capability atoms are answered from the capability projection instead of rows.
     */
    private boolean heldCovers(Set<GrantIntersectionEvaluator.PermissionAtom> held,
            AuthzContext.Capabilities capabilities, UUID workspaceId,
            GrantIntersectionEvaluator.PermissionAtom atom) {
        if (PermissionAtomCatalog.isCapabilityAtom(atom.actionClass())) {
            return capabilityHeld(capabilities, atom.actionClass(), workspaceId);
        }
        if ("*".equals(atom.resource())) {
            return held.contains(atom);
        }
        return held.stream().anyMatch(grant -> grant.actionClass().equals(atom.actionClass())
                && !ResourceNamespaces.mcpChannelRequiresExplicitGrant(
                        grant.resource(), atom.resource())
                && (grant.resource().equals(atom.resource())
                || LayeredPolicyResolver.matches(grant.resource(), atom.resource(), ToolShape.OPAQUE)));
    }

    private static Set<String> atomNames(Set<GrantIntersectionEvaluator.PermissionAtom> atoms) {
        return atoms.stream().map(GrantIntersectionEvaluator.PermissionAtom::actionClass)
                .collect(java.util.stream.Collectors.toCollection(LinkedHashSet::new));
    }

    private static Set<String> atomRows(Set<GrantIntersectionEvaluator.PermissionAtom> atoms) {
        return atoms.stream().map(atom -> atom.actionClass() + "@" + atom.resource())
                .collect(java.util.stream.Collectors.toCollection(LinkedHashSet::new));
    }

    private List<String> exceedingInScope(UUID subjectId, Set<String> requested, AccessScope scope) {
        Set<String> held = requester.actionAtoms(subjectId, scope.id());
        AuthzContext.Capabilities capabilities = authzContext.capabilitiesFor(subjectId);
        List<String> exceeding = new ArrayList<>();
        for (String atom : requested) {
            boolean allowed = PermissionAtomCatalog.isCapabilityAtom(atom)
                    ? capabilityHeld(capabilities, atom, scope.id())
                    : held.contains(atom);
            if (!allowed) {
                exceeding.add(atom);
            }
        }
        return exceeding;
    }

    /** Definition judgement: "held anywhere" = instance ∪ every workspace the caller is bound in. */
    private List<String> exceedingInAnyScope(UUID subjectId, Set<String> requested) {
        Set<String> held = new LinkedHashSet<>(requester.actionAtoms(subjectId, null));
        List<UUID> workspaceIds = new ArrayList<>();
        for (GrantPresetBinding binding : bindings.findBySubjectTypeAndSubjectIdAndScopeType(
                AuthzContext.SUBJECT_USER, subjectId, AccessScope.WORKSPACE)) {
            workspaceIds.add(binding.getScopeId());
            held.addAll(requester.actionAtoms(subjectId, binding.getScopeId()));
        }
        AuthzContext.Capabilities capabilities = authzContext.capabilitiesFor(subjectId);
        List<String> exceeding = new ArrayList<>();
        for (String atom : requested) {
            boolean allowed;
            if (PermissionAtomCatalog.isCapabilityAtom(atom)) {
                allowed = capabilityHeld(capabilities, atom, null)
                        || workspaceIds.stream().anyMatch(workspaceId ->
                        capabilityHeld(capabilities, atom, workspaceId));
            } else {
                allowed = held.contains(atom);
            }
            if (!allowed) {
                exceeding.add(atom);
            }
        }
        return exceeding;
    }

    private static boolean capabilityHeld(AuthzContext.Capabilities capabilities, String atom,
                                          UUID workspaceId) {
        if (capabilities.holdsCapability(atom, workspaceId)) {
            return true;
        }
        // PLAN-0651 D51-30: the single implication chain is honoured on the grant path only.
        for (String holder : PermissionAtomCatalog.impliedHolders(atom)) {
            if (capabilities.holdsCapability(holder, workspaceId)) {
                return true;
            }
        }
        return false;
    }

    private void auditAllowed(UUID subjectId, Set<String> atoms, AccessScope scope) {
        audit.recordDurableChange(subjectId.toString(), scopeId(scope), "role_grant_guard_allowed",
                "role_grant", auditResourceId(scope), detail(atoms, scope, false));
    }

    private void auditBypass(UUID subjectId, Set<String> requested, List<String> skipped,
                             AccessScope scope) {
        logger.warn("[POLICY] event=role_grant_guard_bypassed actor={} scope={} atoms={} skipped={}",
                subjectId, scopeKey(scope), requested, skipped);
        audit.recordDurableChange(subjectId.toString(), scopeId(scope), "role_grant_guard_bypassed",
                "role_grant", auditResourceId(scope),
                detail(requested, scope, true) + " skipped=" + skipped);
    }

    private void auditDenied(UUID subjectId, Set<String> requested, List<String> exceeding,
                             AccessScope scope) {
        logger.warn("[POLICY] event=role_grant_guard_denied actor={} scope={} atoms={} exceeding={}",
                subjectId, scopeKey(scope), requested, exceeding);
        try {
            denialAuditTransaction.executeWithoutResult(status ->
                    audit.recordDurableChange(subjectId.toString(), scopeId(scope),
                            "role_grant_guard_denied", "role_grant", auditResourceId(scope),
                            detail(requested, scope, false) + " exceeding=" + exceeding));
        } catch (RuntimeException auditFailure) {
            // The rejection itself must not be masked by an audit outage; the WARN line above is the
            // fallback trace (same convention as the policy-denied log path).
            logger.error("[POLICY] event=role_grant_guard_audit_failed actor={} scope={}",
                    subjectId, scopeKey(scope), auditFailure);
        }
    }

    private static String detail(Set<String> atoms, AccessScope scope, boolean bypass) {
        return "scope=" + scopeKey(scope) + " atoms=" + String.join(",", atoms)
                + " bypass=" + bypass;
    }

    private static String scopeKey(AccessScope scope) {
        return scope == null ? "definition" : scope.toString();
    }

    /** {@code audit_logs.resource_id} is varchar(36): uuid for a workspace, short labels otherwise. */
    private static String auditResourceId(AccessScope scope) {
        if (scope == null) {
            return "definition";
        }
        return scope.isInstance() ? "instance" : scope.id().toString();
    }

    private static String scopeId(AccessScope scope) {
        return scope == null || scope.isInstance() ? null : scope.id().toString();
    }
}
