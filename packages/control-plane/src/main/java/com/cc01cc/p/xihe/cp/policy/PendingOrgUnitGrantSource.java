package com.cc01cc.p.xihe.cp.policy;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * PLAN-0773 M2-8b: the {@link OrgUnitGrantSource} that ships today — an <b>explicit placeholder</b>,
 * not an integration.
 *
 * <p>Its answer is empty because the truth is empty: {@code org_unit_role_bindings} is
 * {@code M1-9}'s table and has not been created yet, so no org-unit binding row exists anywhere.
 * Returning zero rows therefore reproduces today's behaviour exactly — the four evaluation reads
 * in {@link RequesterAuthority} see the same atom set they saw before this wiring landed — which is
 * what the equivalence regression proves instead of assumes.</p>
 *
 * <p><b>Why a placeholder instead of a reader.</b> A production reader must query
 * {@code org_unit_role_bindings}; written against a table that does not exist it would either fail
 * on every authorization read or carry a "does the table exist?" branch nobody can test here. The
 * honest move is to land the <b>calling side</b> now (one port, four read points, proven by tests
 * with a fixture source) and let the reader arrive with the table. The class is registered as a
 * {@code @Component} on purpose: it must be <b>visible</b> to whoever wires the real one, and a
 * missing bean would break the application context rather than silently skip the wiring.</p>
 *
 * <p><b>Registration (open item, deliberately loud).</b> Replacing this class is {@code M1-9}'s or
 * the follow-up card's job, not a side effect of creating a migration:</p>
 *
 * <ol>
 *   <li>read {@code org_units} + {@code org_unit_members} + {@code org_unit_role_bindings} for one
 *       {@link OrgUnitGrantExpander.MemberRef} (three reads, or one join plus one read);</li>
 *   <li>return {@link OrgUnitGrantExpander.Rows} with all three lists filled;</li>
 *   <li>keep it uncached ({@code M2-10a}) and keep unit-move semantics immediate.</li>
 * </ol>
 *
 * <p>Until that lands, the four read points are wired but fed nothing — stated here, in the class
 * that would have to change, rather than in a commit message nobody re-reads.</p>
 */
@Component
public class PendingOrgUnitGrantSource implements OrgUnitGrantSource {

    private static final Logger logger = LoggerFactory.getLogger(PendingOrgUnitGrantSource.class);

    /** Empty rows: no units, no memberships, no bindings. */
    private static final OrgUnitGrantExpander.Rows EMPTY =
            new OrgUnitGrantExpander.Rows(List.of(), List.of(), List.of());

    public PendingOrgUnitGrantSource() {
        logger.warn("[POLICY] event=org_unit_grant_source_pending table=org_unit_role_bindings"
                + " blockingItem=M1-9 note=read-points-are-wired-but-feed-nothing-until-the-table-lands");
    }

    @Override
    public OrgUnitGrantExpander.Rows rowsFor(OrgUnitGrantExpander.MemberRef member) {
        return EMPTY;
    }
}
