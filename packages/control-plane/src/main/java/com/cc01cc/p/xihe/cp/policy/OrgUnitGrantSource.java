package com.cc01cc.p.xihe.cp.policy;

/**
 * PLAN-0773 M2-8b: where {@link OrgUnitGrants} gets its {@link OrgUnitGrantExpander.Rows} from.
 *
 * <p>This is a port, not an implementation: the evaluation path asks it for one member's rows and
 * does not care whether they come from three JDBC reads (production), from a fixture (tests), or
 * from the placeholder that ships today. The split exists because <b>the query and the decision
 * have different blockers</b>: the decision ({@link OrgUnitGrantExpander}) has been testable since
 * {@code M2-8a} without a database, while a production reader needs {@code org_unit_role_bindings}
 * — {@code M1-9}'s table, which does not exist yet.</p>
 *
 * <p><b>No caching, ever</b> ({@code M2-10a}): the caller invokes this on every evaluation. A
 * member who is moved between units must change authority immediately, and a cached row set would
 * keep last week's answer. Implementations must not memoize, and must not hold rows in a static
 * map.</p>
 */
public interface OrgUnitGrantSource {

    /**
     * The rows needed to expand one member: its units, the memberships that identify it, and the
     * role bindings on those units. An empty result is a legal answer (not a failure) — it means
     * "this member holds nothing through org units", which the expander turns into zero grants.
     *
     * @param member the subject, in {@code org_unit_members} vocabulary
     * @return rows for that member; never {@code null}
     */
    OrgUnitGrantExpander.Rows rowsFor(OrgUnitGrantExpander.MemberRef member);
}
