package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.provider.ProviderCatalogService;
import com.cc01cc.p.xihe.cp.provider.ProviderConnectionService;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.OrgUnitMemberRepository;
import com.cc01cc.p.xihe.cp.repository.OrgUnitReadRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.cc01cc.p.xihe.cp.service.InstanceIdentityService;
import com.cc01cc.p.xihe.cp.service.InstanceOwnershipService;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-148 / DSD-1513 degradation path: a runtime that answers the direct-attach capability probe with
 * {@code available:false} must not cost the rest of the seed, and the missing workspace must be filled
 * in later without duplicating anything.
 *
 * <p>This is the card's "attached behaviour change" in test form. {@code preflightDirectAttach} returns
 * normally when the runtime is reachable but cannot serve the requested attach, and
 * {@link WorkspaceService#createWorkspace} would turn that same answer into a 503 — inside
 * {@code DataSeeder}'s transaction a 503 raised mid-run marks it rollback-only and the whole boot dies of
 * {@code UnexpectedRollbackException}. So the seed reads the answer first, warns, and creates no
 * workspace: the other three groups still land, and the boot still succeeds.</p>
 *
 * <p>The single test method flips the stub's answer and runs the seeder a second time, which is also the
 * only honest way to show "backfill" is not "duplicate": the workspace appears, the counts that were
 * already right stay put.</p>
 */
class FirstRunContentSeedBackfillIntegrationTest extends AbstractIntegrationTest {

    /** Answers {@code available:false}; the test flips it mid-run once the runtime "starts". */
    private static final FirstRunSeedProbeStub PROBE =
            FirstRunSeedProbeStub.reportingAvailability(false, "windows-mxc");

    @DynamicPropertySource
    static void runtimeProbeUrl(DynamicPropertyRegistry registry) {
        registry.add("cp.mcp.runtime-url", PROBE::baseUrl);
    }

    @AfterAll
    static void stopProbe() {
        PROBE.stop();
    }

    @Autowired
    private UserRepository users;
    @Autowired
    private WorkspaceRepository workspaces;
    @Autowired
    private WorkspaceService workspaceService;
    @Autowired
    private ProviderConnectionService providerConnectionService;
    @Autowired
    private ProviderConnectionRepository providerConnections;
    @Autowired
    private AgentPrincipalService agentPrincipalService;
    @Autowired
    private AgentPrincipalRepository agentPrincipals;
    @Autowired
    private OrgUnitReadRepository orgUnits;
    @Autowired
    private OrgUnitMemberRepository orgUnitMembers;
    @Autowired
    private InstanceIdentityService instanceIdentity;
    @Autowired
    private InstanceOwnershipService instanceOwnership;
    @Autowired
    private Environment environment;
    @Autowired
    private ProviderCatalogService providerCatalog;
    @Autowired
    private JdbcTemplate jdbc;

    @TempDir
    Path workspaceRoot;

    @Test
    void anUnavailableRuntimeSkipsOnlyTheWorkspaceAndTheNextStartBackfillsIt() {
        User admin = users.findByEmail("admin@xihe.local")
                .orElseThrow(() -> new AssertionError("the seeded admin must exist: this lane runs"
                        + " cp.bootstrap.seed-admin=true"));
        assertEquals(0, count("workspaces"), "the instance starts without a workspace");

        FirstRunContentSeeder degraded = seeder(FirstRunContentSeeder.MODE_TRUE);
        // The reading that matters most: this call does not throw. A caught failure after a write would
        // have marked DataSeeder's transaction rollback-only, and the boot would fail later, elsewhere.
        degraded.seed(admin);

        assertEquals(0, count("workspaces"), "available=false must leave no workspace row behind");
        assertEquals(1, count("provider_connections"), "the connection does not depend on the workspace");
        assertEquals(3, count("agent_principals"), "the subjects do not depend on the workspace either");
        assertEquals(4, count("org_unit_members"), "the admin plus the three placed subjects");
        List<String> warnings = degraded.lastRunWarnings();
        assertEquals(1, warnings.size(), "exactly one degradation warning, got: " + warnings);
        assertTrue(warnings.get(0).contains("available=false"),
                "the warning has to name the runtime answer, got: " + warnings.get(0));
        assertTrue(warnings.get(0).contains("direct-attach"),
                "and the capability it asked the runtime about, got: " + warnings.get(0));

        // The runtime comes up: the workspace is the only thing missing, and the keyed writes below it
        // must all be no-ops.
        PROBE.answerAvailable(true);
        FirstRunContentSeeder healthy = seeder(FirstRunContentSeeder.MODE_TRUE);
        healthy.seed(admin);
        assertEquals(List.of(), healthy.lastRunWarnings(), "nothing is left to warn about");

        assertEquals(1, count("workspaces"), "the next start backfills the one missing group");
        assertEquals(1, count("provider_connections"), "backfill does not duplicate the connection");
        assertEquals(3, count("agent_principals"), "backfill does not duplicate the subjects");
        assertEquals(3, count("org_units"), "backfill adds no org unit");
        assertEquals(4, count("org_unit_members"), "backfill does not move anybody");
        assertTrue(workspaces.findByCreateIdempotencyKeyAndDeletedAtIsNull(
                FirstRunContentSeeder.WORKSPACE_IDEMPOTENCY_KEY).isPresent(),
                "the backfilled workspace carries the seed idempotency key");
    }

    private FirstRunContentSeeder seeder(String mode) {
        return new FirstRunContentSeeder(workspaceService, workspaces, providerConnectionService,
                providerConnections, agentPrincipalService, agentPrincipals, orgUnits, orgUnitMembers,
                instanceIdentity, instanceOwnership, environment,
                "jdbc:postgresql://127.0.0.1:1/xihe-unused-only-for-the-postgres-predicate", mode,
                workspaceRoot.toString(), providerCatalog);
    }

    private int count(String table) {
        Integer rows = jdbc.queryForObject("SELECT count(*) FROM " + table, Integer.class);
        assertNotNull(rows, "count(*) must never be null for " + table);
        return rows;
    }
}
