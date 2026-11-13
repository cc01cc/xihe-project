package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.UUID;

/**
 * PLAN-0773 M2-8b: the one place the evaluation path turns "who is this subject" into
 * "the governance grants this subject holds through its org units".
 *
 * <p>Four read points in {@link RequesterAuthority} used to answer from materialized
 * {@code grants} rows alone. They now all call {@link #forPrincipal} and union the result, so the
 * subject's org-unit grants are part of the same answer as its role bindings. The point of putting
 * this in one class instead of four inline calls is the failure mode {@code tasks.md:106} names:
 * <b> forgetting one site means silently granting less</b> (a 403 for somebody who should pass),
 * which no test of the other three would notice.</p>
 *
 * <p><b>Judgement comes from {@link OrgUnitGovernancePolicy}, via the expander.</b> Rows whose role
 * carries a non-governance atom are dropped here exactly as on the write side — one predicate,
 * two entry points ({@code M2-8c}). This class adds no whitelist of its own.</p>
 *
 * <p><b>No caching</b> ({@code M2-10a}): every call re-reads both the membership and the bindings,
 * so moving a member changes authority on the next evaluation. A {@code @Cacheable} here — or a
 * static map for "hot" subjects — would break that guarantee and reintroduce the stale-answer class
 * of bug the plan forbids.</p>
 */
@Component
public class OrgUnitGrants {

    private static final Logger logger = LoggerFactory.getLogger(OrgUnitGrants.class);

    private final OrgUnitGrantExpander expander;
    private final OrgUnitGrantSource source;

    public OrgUnitGrants(OrgUnitGrantExpander expander, OrgUnitGrantSource source) {
        this.expander = expander;
        this.source = source;
    }

    /**
     * Expanded grants for a grant vocabulary principal ({@code user} / {@code agent_principal}).
     *
     * <p>A caller with no subject, or a principal vocabulary this class does not know, gets nothing
     * — <b>fewer</b> grants, never more. It logs the unknown vocabulary instead of throwing: an
     * unknown principal must not turn every authorization read into a 500, but it must also not be
     * silent ({@code [POLICY] event=org_unit_grants_unknown_principal}).</p>
     *
     * @param principalType {@code GrantPrincipalPathResolver.USER} or {@code .AGENT_PRINCIPAL}
     * @param subjectId     the principal's id; {@code null} yields an empty result
     * @return expanded rows, in memory (never persisted); empty when the member holds nothing
     */
    public Collection<AuthorizationGrant> forPrincipal(String principalType, UUID subjectId) {
        if (subjectId == null) {
            return List.of();
        }
        String memberKind = memberKindOf(principalType);
        if (memberKind == null) {
            logger.warn("[POLICY] event=org_unit_grants_unknown_principal principalType={} subject={}",
                    principalType, subjectId);
            return List.of();
        }
        OrgUnitGrantExpander.MemberRef member = new OrgUnitGrantExpander.MemberRef(memberKind, subjectId);
        return expander.expand(member, source.rowsFor(member));
    }

    /**
     * The one merge implementation for every read point: scoped rows plus expanded rows, scoped
     * first (order is irrelevant to the union, but keeping it stable makes failure output readable).
     *
     * <p>Returns the scoped list itself when there is nothing to add — a no-op must stay a no-op
     * (allocation is not the point, <i>"did the wiring change anything?"</i> is: with no org-unit
     * rows, the answer passed to the evaluator is the very same list as before the wiring).</p>
     */
    public static List<AuthorizationGrant> merge(List<AuthorizationGrant> scoped,
                                                Collection<AuthorizationGrant> expanded) {
        if (expanded.isEmpty()) {
            return scoped;
        }
        List<AuthorizationGrant> merged = new ArrayList<>(scoped.size() + expanded.size());
        merged.addAll(scoped);
        merged.addAll(expanded);
        return merged;
    }

    /**
     * grant vocabulary → {@code org_unit_members.member_kind} ({@code V164} CHECK vocabulary).
     *
     * <p>The two vocabularies differ on purpose: {@code grants.subject_type} says {@code user}
     * because that is who the token belongs to, while a membership row says {@code human} because
     * it answers "which kind of account is this". Mapping in one place keeps that translation from
     * being re-derived (wrongly) at each call site.</p>
     *
     * @return the member kind, or {@code null} when the principal vocabulary is not an org-unit one
     */
    static String memberKindOf(String principalType) {
        if (GrantPrincipalPathResolver.USER.equals(principalType)) {
            return OrgUnitGrantExpander.MEMBER_HUMAN;
        }
        if (GrantPrincipalPathResolver.AGENT_PRINCIPAL.equals(principalType)) {
            return OrgUnitGrantExpander.MEMBER_AGENT_PRINCIPAL;
        }
        return null;
    }
}
