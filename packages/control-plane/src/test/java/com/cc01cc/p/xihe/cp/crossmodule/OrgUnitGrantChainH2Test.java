package com.cc01cc.p.xihe.cp.crossmodule;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.repository.OrgUnitGrantRowsRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-911: the portable ancestor walk runs on the H2 lane, where the org-unit family only exists
 * through {@code h2-schema.sql}'s shim. The fixture and assertions are shared with
 * {@link OrgUnitGrantChainPgTest}; the two classes together are the "same rows, same chain"
 * judgement.
 */
class OrgUnitGrantChainH2Test extends AbstractH2Test {

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private OrgUnitGrantRowsRepository rows;

    @Test
    void sameFixtureReturnsTheRootFirstChainOnH2() {
        OrgUnitChainFixture.Seeded fixture = OrgUnitChainFixture.seed(jdbc, false);
        OrgUnitChainFixture.assertChain(
                rows.memberUnitChain("human", fixture.memberId()), fixture);
        OrgUnitChainFixture.assertBindings(
                rows.bindingsOnMemberChain("human", fixture.memberId()), fixture);
    }

    @Test
    void aMemberWithoutMembershipHasAnEmptyChain() {
        assertTrue(rows.memberUnitChain("human", UUID.randomUUID()).isEmpty(),
                "no membership row is a legal empty answer, not a failure");
        assertTrue(rows.bindingsOnMemberChain("agent_principal", UUID.randomUUID()).isEmpty());
    }
}
