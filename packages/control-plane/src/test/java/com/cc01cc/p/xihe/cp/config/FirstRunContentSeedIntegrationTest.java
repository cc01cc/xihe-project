package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.policy.PathKey;
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
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-148 / DSD-1513: the first-run <b>content</b> seed on a real PostgreSQL database — one default
 * workspace, one instance provider connection, three Agent subjects and their org-unit placement —
 * plus the idempotency reading the card demands: the second start inserts nothing.
 *
 * <p>The class builds {@link FirstRunContentSeeder} by hand instead of flipping
 * {@code cp.bootstrap.seed-content} for the context: the gate is a constructor argument, so a hand-built
 * instance can run {@code true} (exercise every write), then {@code true} again (exercise every
 * idempotency key), then {@code auto} (exercise the emptiness gate) inside one test method — no test
 * method ordering, no per-method database reset.</p>
 *
 * <p>Counts are read with {@code count(*)} on the five tables the card names, and the applied Flyway
 * head is read from {@code flyway_schema_history} both times: "second start inserts nothing" has to be
 * a database reading, not a log line.</p>
 */
class FirstRunContentSeedIntegrationTest extends AbstractIntegrationTest {

    /** The runtime the seed probes; it answers {@code available:true} for a {@code windows-mxc} attach. */
    private static final FirstRunSeedProbeStub PROBE = FirstRunSeedProbeStub.reportingAvailability(true, "windows-mxc");

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

    /** The workspace root the seed must create; a plain absolute path, never the operator's data dir. */
    @TempDir
    Path workspaceRoot;

    @Test
    void aFirstStartSeedsEverythingAndASecondStartInsertsNothing() {
        User admin = users.findByEmail("admin@xihe.local")
                .orElseThrow(() -> new AssertionError("the seeded admin must exist: this lane runs"
                        + " cp.bootstrap.seed-admin=true"));
        String adminId = admin.getId().toString();

        // The emptiness gate is only honest if the instance really is empty for the three groups the
        // seeder owns; the org tree itself is a V181 fact and the admin already sits in its root.
        assertEquals(0, count("workspaces"), "the seeded admin branch must not pre-create a workspace");
        assertEquals(0, count("provider_connections"), "no provider connection before the content seed");
        assertEquals(0, count("agent_principals"), "no agent subject before the content seed");
        assertEquals(3, count("org_units"), "V181 leaves exactly the three-unit tree");
        assertEquals(1, count("org_unit_members"), "only the seeded admin is placed before the content seed");
        // task-835: read the migrated head instead of pinning a version. The lane runs at the
        // current schema head (V182 renamed the preset tables; V183 added the approve atom), so a
        // literal would go stale on every later migration while the V181 org-tree fact stays true.
        assertTrue(appliedMigrationHead() >= 181,
                "the V181 org tree must already be applied in this lane (head="
                        + appliedMigrationHead() + ")");
        int roleBindingsBefore = count("grant_preset_bindings");
        dumpReadings("baseline-before-content-seed");

        int headBeforeContentSeed = appliedMigrationHead();
        FirstRunContentSeeder first = seeder(FirstRunContentSeeder.MODE_TRUE);
        first.seed(admin);
        assertEquals(List.of(), first.lastRunWarnings(), "a first start on a healthy instance warns about nothing");

        assertEquals(1, count("workspaces"), "exactly one default workspace");
        assertEquals(1, count("provider_connections"), "exactly one instance provider connection");
        assertEquals(3, count("agent_principals"), "Lead + WorkerA + WorkerB");
        assertEquals(3, count("org_units"), "the content seed adds no org unit of its own");
        assertEquals(4, count("org_unit_members"), "the admin in the root plus the three subjects");
        assertEquals(headBeforeContentSeed, appliedMigrationHead(),
                "the content seed writes rows, never migrations");

        Workspace workspace = workspaces
                .findByCreateIdempotencyKeyAndDeletedAtIsNull(FirstRunContentSeeder.WORKSPACE_IDEMPOTENCY_KEY)
                .orElseThrow(() -> new AssertionError("the default workspace must carry the seed key"));
        assertEquals(FirstRunContentSeeder.WORKSPACE_NAME, workspace.getName());
        assertEquals(FirstRunContentSeeder.WORKSPACE_STORAGE_MODE, workspace.getStorageMode());
        assertEquals("windows-mxc", workspace.getExecutionMode(),
                "the seed names no backend: WorkspaceService derives the direct_attach default");
        assertEquals(PathKey.lexical(workspaceRoot.toString()), workspace.getHostPath(),
                "the stored host path is the lexical canonical form of the resolved root");
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM grant_preset_bindings b JOIN grant_presets r ON r.id = b.role_id"
                + " WHERE b.subject_type = 'user' AND b.subject_id = ?::uuid"
                + " AND b.scope_type = 'workspace' AND b.scope_id = ?::uuid AND r.name = 'WS_OWNER'",
                Integer.class, adminId, workspace.getId().toString()),
                "the seeded admin owns the seeded workspace");

        ProviderConnection connection = providerConnections
                .findByOwnerTypeAndOwnerIdAndProviderIdAndConnectionKey(ProviderConnection.OWNER_INSTANCE,
                        instanceIdentity.ownerId(), FirstRunContentSeeder.PROVIDER_ID,
                        FirstRunContentSeeder.CONNECTION_KEY)
                .orElseThrow(() -> new AssertionError("the instance provider connection should be seeded"));
        assertEquals(ProviderConnection.OWNER_INSTANCE, connection.getOwnerType());
        assertEquals(instanceIdentity.ownerId(), connection.getOwnerId(), "scoped to the instance identity");
        assertEquals(FirstRunContentSeeder.CONNECTION_LABEL, connection.getLabel());
        assertNull(connection.getCredentialId(), "ollama needs no credential, and a forged READY would need one");
        assertEquals(ProviderConnection.STATUS_UNVERIFIED, connection.getStatus(),
                "the seed leaves an explicit terminal state instead of the create() in-flight VERIFYING");

        List<AgentPrincipal> subjects = agentPrincipals.findByCreatedByUserId(adminId);
        assertEquals(Set.of(FirstRunContentSeeder.LEAD_NAME, "WorkerA", "WorkerB"),
                subjects.stream().map(AgentPrincipal::getName).collect(Collectors.toSet()));
        Map<String, AgentPrincipal> byName = subjects.stream()
                .collect(Collectors.toMap(AgentPrincipal::getName, subject -> subject));
        for (AgentPrincipal subject : subjects) {
            // task-18 J4: the catalog declares no model id for ollama (modelDiscovery=remote-models),
            // so the intent is left empty and reported as 待绑定 instead of a literal "llama3.2".
            assertNull(subject.getDefaultModelProvider(),
                    "no catalog-resolvable model id => the provider is left empty too");
            assertNull(subject.getDefaultModelName(),
                    "the seed must never write a model name nothing in the catalog declares");
        }
        assertTrue(first.lastModelIntentPending(),
                "the run must report the 待绑定 state instead of silently claiming a model");
        assertEquals(FirstRunContentSeeder.LEADERS_UNIT_ID,
                orgUnitMembers.findUnitOf(FirstRunContentSeeder.AGENT_MEMBER_KIND, byName.get("Lead").getId())
                        .orElseThrow(() -> new AssertionError("Lead must sit in the leaders unit")));
        for (String worker : List.of("WorkerA", "WorkerB")) {
            assertEquals(FirstRunContentSeeder.EXECUTION_UNIT_ID,
                    orgUnitMembers.findUnitOf(FirstRunContentSeeder.AGENT_MEMBER_KIND, byName.get(worker).getId())
                            .orElseThrow(() -> new AssertionError(worker + " must sit in the execution unit")));
        }
        int roleBindingsAfterFirst = count("grant_preset_bindings");
        assertTrue(roleBindingsAfterFirst > roleBindingsBefore, "materialising subjects writes role bindings");
        dumpReadings("after-first-start");

        // Second start: every write is keyed, so the reading must be identical row-for-row.
        FirstRunContentSeeder second = seeder(FirstRunContentSeeder.MODE_TRUE);
        second.seed(admin);
        assertEquals(List.of(), second.lastRunWarnings(), "a second start warns about nothing either");
        assertEquals(1, count("workspaces"), "second start inserts no workspace");
        assertEquals(1, count("provider_connections"), "second start inserts no provider connection");
        assertEquals(3, count("agent_principals"), "second start inserts no subject");
        assertEquals(3, count("org_units"), "second start inserts no org unit");
        assertEquals(4, count("org_unit_members"), "second start moves nobody");
        assertEquals(roleBindingsAfterFirst, count("grant_preset_bindings"), "second start inserts no role binding");
        assertEquals(headBeforeContentSeed, appliedMigrationHead(),
                "second start applies no migration");
        dumpReadings("after-second-start");

        // And the product default (auto) is a no-op on an instance that already has content.
        FirstRunContentSeeder auto = seeder(FirstRunContentSeeder.MODE_AUTO);
        auto.seed(admin);
        assertEquals(1, count("workspaces"), "auto must not touch a non-empty instance");
        assertEquals(1, count("provider_connections"), "auto must not touch a non-empty instance");
        assertEquals(3, count("agent_principals"), "auto must not touch a non-empty instance");
        assertEquals(4, count("org_unit_members"), "auto must not touch a non-empty instance");

        // DSD-1520 Q3: place() is an upsert, so an unconditional call would silently undo an operator's
        // move. Move Lead to the execution group behind the seeder's back, force the seed again, and the
        // row must still be where the operator put it.
        UUID leadId = byName.get("Lead").getId();
        jdbc.update("UPDATE org_unit_members SET org_unit_id = ? WHERE member_kind = ? AND member_id = ?",
                FirstRunContentSeeder.EXECUTION_UNIT_ID, FirstRunContentSeeder.AGENT_MEMBER_KIND, leadId);
        seeder(FirstRunContentSeeder.MODE_TRUE).seed(admin);
        assertEquals(FirstRunContentSeeder.EXECUTION_UNIT_ID,
                orgUnitMembers.findUnitOf(FirstRunContentSeeder.AGENT_MEMBER_KIND, leadId)
                        .orElseThrow(() -> new AssertionError("Lead must stay where the operator moved it")),
                "a re-run must not move a placed subject back: place() is an upsert, so the guard is the"
                        + " findUnitOf(...).isPresent() check, not the INSERT's own semantics");
        assertEquals(4, count("org_unit_members"), "no extra placement row appeared");
    }

    /**
     * Prints the five table counts and the applied migration head, so the evidence file can quote a
     * reading that came from the run instead of restating the assertions. {@code version} in
     * {@code flyway_schema_history} is TEXT, hence the {@code ::int} cast: a textual maximum would
     * answer {@code 99} for a chain that reached {@code 181}.
     */
    private void dumpReadings(String stage) {
        System.out.println("[seed-readings] stage=" + stage
                + " workspaces=" + count("workspaces")
                + " provider_connections=" + count("provider_connections")
                + " agent_principals=" + count("agent_principals")
                + " org_units=" + count("org_units")
                + " org_unit_members=" + count("org_unit_members")
                + " grant_preset_bindings=" + count("grant_preset_bindings")
                + " flyway_max_version=" + appliedMigrationHead());
    }

    /** Hand-built seeder: the gate and the root are constructor arguments, so the test owns them. */
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

    /** Flyway head as an integer: the version column is text, so text ordering would read 99 > 181. */
    private int appliedMigrationHead() {
        Integer head = jdbc.queryForObject("SELECT coalesce(max(version::int), 0) FROM flyway_schema_history"
                + " WHERE success AND version ~ '^[0-9]+$'", Integer.class);
        assertNotNull(head, "flyway_schema_history must be readable");
        return head;
    }
}
