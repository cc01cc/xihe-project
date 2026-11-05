package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
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
    private final AccessRoleBindingRepository bindings;
    private final AuditLogger audit;
    private final TransactionTemplate denialAuditTransaction;

    public GrantabilityGuard(RequesterAuthority requester,
                             AuthzContext authzContext,
                             AccessRoleBindingRepository bindings,
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
     * request <b>wider</b> than the rows materialised from {@code role_permissions} — a legitimate
     * holder of {@code (credential_use, credential:*)} was then denied by the very
     * "concrete-does-not-cover-wildcard" rule this fix introduced (the {@code *} here was a
     * conversion artefact, not a real wildcard request). Unknown names keep the wildcard shape so
     * they still fail the subset judgement with 403 instead of turning into a 400.</p>
     */
    private static String canonicalResourceOf(String name) {
        try {
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
            for (AccessRoleBinding binding : bindings.findBySubjectTypeAndSubjectIdAndScopeType(
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
        for (AccessRoleBinding binding : bindings.findBySubjectTypeAndSubjectIdAndScopeType(
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
