package com.cc01cc.p.xihe.cp.policy;

import java.util.List;

/**
 * PLAN-0773 M2-8b: the {@link OrgUnitGrants} every pre-existing test should use — <b>no rows</b>,
 * so the four read points behave exactly as they did before the wiring.
 *
 * <p>Tests that construct {@link RequesterAuthority} by hand need <i>something</i> for the fourth
 * argument. Two wrong options are tempting and both hide regressions: passing a mock
 * {@code OrgUnitGrants} (learns nothing, and NPEs when a site is not stubbed) or passing
 * {@code null} (only fails when the expanded path runs, i.e. in the one test that matters). This
 * fixture makes the choice explicit and greppable: a test that wants org-unit behaviour builds its
 * own source (as {@link RequesterAuthorityOrgUnitGrantsTest} does) instead of using this.</p>
 */
public final class OrgUnitGrantsTestFixture {

    private OrgUnitGrantsTestFixture() {
    }

    /** Grants that expand nothing: no units, no memberships, no bindings. */
    public static OrgUnitGrants withoutRows() {
        return new OrgUnitGrants(new OrgUnitGrantExpander(),
                member -> new OrgUnitGrantExpander.Rows(List.of(), List.of(), List.of()));
    }
}
