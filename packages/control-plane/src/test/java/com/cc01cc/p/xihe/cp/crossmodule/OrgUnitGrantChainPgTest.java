package com.cc01cc.p.xihe.cp.crossmodule;

import com.cc01cc.p.xihe.cp.repository.OrgUnitGrantRowsRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-911: the PostgreSQL half of the parity judgement. Same fixture rows as
 * {@link OrgUnitGrantChainH2Test}, but the {@code path} column is a real {@code ltree}; the
 * {@code WITH RECURSIVE} walk and {@code CAST(path AS VARCHAR)} must return the identical chain.
 */
class OrgUnitGrantChainPgTest extends AbstractWireMockPgTest {

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private OrgUnitGrantRowsRepository rows;

    @Test
    void sameFixtureReturnsTheRootFirstChainOnPostgres() {
        OrgUnitChainFixture.Seeded fixture = OrgUnitChainFixture.seed(jdbc, true);
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
