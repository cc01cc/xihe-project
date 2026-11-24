package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.policy.PathKey;
import com.cc01cc.p.xihe.cp.policy.PresetGrantMaterializer;
import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.provider.ProviderCatalogService;
import com.cc01cc.p.xihe.cp.provider.ProviderConnectionService;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.GrantPresetBindingRepository;
import com.cc01cc.p.xihe.cp.repository.GrantPresetRepository;
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
 * workspace, the declared instance-layer connection set, three Agent subjects and their org-unit
 * placement — plus the idempotency reading the card demands: the second start inserts nothing.
 *
 * <p>task-963: the connection assertions are derived from
 * {@link FirstRunContentSeeder#SEED_CONNECTIONS} (the product's declared first-run default set) and
 * cross-checked against the provider catalog, never written as a literal provider-name array; the
 * retired single-Ollama default is pinned as an <b>absence</b> instead.</p>
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
    /** task-932: the seeder now writes the instance default agent set through the real config face. */
    @Autowired
    private com.cc01cc.p.xihe.cp.config.ConfigService configService;
    /** task-994: the instance exec grant writes one binding row and materializes it in transaction. */
    @Autowired
    private GrantPresetBindingRepository presetBindings;
    @Autowired
    private GrantPresetRepository presets;
    @Autowired
    private PresetGrantMaterializer grantMaterializer;
    @Autowired
    private AuditLogger audit;
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
        // task-963: the expected set comes from the seeder's declared default set, so the next
        // default-set adjustment does not redden this class (the old "1 connection / ollama" literals
        // did exactly that after task-944).
        assertEquals(FirstRunContentSeeder.SEED_CONNECTIONS.size(), count("provider_connections"),
                "the first run creates exactly the declared instance-layer default set");
        assertEquals(seedProviderIds(), instanceProviderIds(),
                "the instance-layer connection set equals the declared first-run default set");
        assertTrue(providerCatalog.providerIds().containsAll(seedProviderIds()),
                "the seed set may only name providers the catalog declares; seed=" + seedProviderIds());
        assertEquals(0, countWhere("provider_connections", "provider_id = 'ollama'"),
                "a fresh install must not seed the retired single Ollama default");
        assertEquals(3, count("agent_principals"), "Lead + WorkerA + WorkerB");
        // task-994: a fresh install grants instance-scope WS_RUNNER (exec reach) to the Lead only.
        // This is the DB reading behind the "default surface stays minimal" ruling — Workers must
        // not be executable by default, and the row must be deletable (is_seed=false).
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM grant_preset_bindings b"
                + " JOIN grant_presets r ON r.id = b.role_id"
                + " WHERE b.subject_type = 'agent_principal' AND b.scope_type = 'instance'"
                + " AND r.name = 'WS_RUNNER'", Integer.class),
                "exactly one instance exec grant after the first run");
        assertEquals(List.of("Lead"), jdbc.queryForList("SELECT p.name FROM grant_preset_bindings b"
                + " JOIN grant_presets r ON r.id = b.role_id"
                + " JOIN agent_principals p ON p.id = b.subject_id"
                + " WHERE b.subject_type = 'agent_principal' AND b.scope_type = 'instance'"
                + " AND r.name = 'WS_RUNNER' ORDER BY 1", String.class),
                "the Lead is the only seeded subject with exec reach");
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM grant_preset_bindings b"
                + " JOIN grant_presets r ON r.id = b.role_id"
                + " WHERE b.subject_type = 'agent_principal' AND b.scope_type = 'instance'"
                + " AND r.name = 'WS_RUNNER' AND b.is_seed = TRUE", Integer.class),
                "the exec grant must be reversible: the instance-admin switch owns it, so is_seed=false");
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

        // task-963: every declared entry must land with catalog-derived fields — a row may not name a
        // provider, base URL, or API type pair the catalog does not declare.
        for (FirstRunContentSeeder.SeedConnection spec : FirstRunContentSeeder.SEED_CONNECTIONS) {
            ProviderConnection connection = providerConnections
                    .findByOwnerTypeAndOwnerIdAndProviderIdAndConnectionKey(ProviderConnection.OWNER_INSTANCE,
                            instanceIdentity.ownerId(), spec.providerId(), FirstRunContentSeeder.CONNECTION_KEY)
                    .orElseThrow(() -> new AssertionError("the declared connection " + spec.providerId()
                            + " must be seeded"));
            assertEquals(ProviderConnection.OWNER_INSTANCE, connection.getOwnerType());
            assertEquals(instanceIdentity.ownerId(), connection.getOwnerId(), "scoped to the instance identity");
            assertEquals(spec.label(), connection.getLabel(), "the label comes from the declared seed entry");
            assertEquals(ProviderConnection.STATUS_UNVERIFIED, connection.getStatus(),
                    "the seed leaves an explicit terminal state instead of the create() in-flight VERIFYING");
            assertNull(connection.getCredentialId(),
                    "a credential-less seeded connection must stay " + ProviderConnection.STATUS_UNVERIFIED
                            + "; a forged READY would need one");
            assertEquals(providerCatalog.defaultBaseUrl(spec.providerId()), connection.getBaseUrl(),
                    "the base URL is catalog-derived, never a seed literal");
            ProviderCatalogService.ApiTypeRef type = providerCatalog.defaultApiType(spec.providerId());
            assertEquals(type.apiTypeId(), connection.getApiTypeId(), "the API type pair is catalog-derived");
            assertEquals(type.version(), connection.getApiTypeVersion(), "the API type pair is catalog-derived");
            assertEquals(providerCatalog.supportedPair(spec.providerId(), type.apiTypeId(), type.version())
                            .path("modelDiscovery").asText("remote-models"), connection.getModelDiscovery(),
                    "model discovery is catalog-derived, never a seed literal");
        }

        List<AgentPrincipal> subjects = agentPrincipals.findByCreatedByUserId(adminId);
        assertEquals(Set.of(FirstRunContentSeeder.LEAD_NAME, "WorkerA", "WorkerB"),
                subjects.stream().map(AgentPrincipal::getName).collect(Collectors.toSet()));
        Map<String, AgentPrincipal> byName = subjects.stream()
                .collect(Collectors.toMap(AgentPrincipal::getName, subject -> subject));
        for (AgentPrincipal subject : subjects) {
            // task-18 J4 / task-963: the shipped catalog declares no model ids for the seeded providers
            // (they are modelDiscovery=remote-models), so the intent stays empty and is reported as
            // 待绑定 instead of a literal model name nothing can resolve.
            assertNull(subject.getDefaultModelProvider(),
                    "no catalog-resolvable model id => the provider is left empty too");
            assertNull(subject.getDefaultModelName(),
                    "the seed must never write a model name nothing in the catalog declares");
        }
        // The 待绑定 expectation above is only honest while the catalog declares no model id for the
        // provider the intent is taken from (the first entry of the seed set). Asserting it from the
        // catalog keeps the premise visible instead of hiding it in a comment.
        String intentProvider = FirstRunContentSeeder.SEED_CONNECTIONS.get(0).providerId();
        assertTrue(FirstRunSeedModelIntent.modelIds(providerCatalog.require(intentProvider)).isEmpty(),
                "the 待绑定 reading presumes the catalog declares no model id for " + intentProvider
                        + "; update this class's model-intent expectation when that changes");
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

        // task-932 (D-1922 / 根源1): the default agent SET is materialized onto the seeded workspace
        // through the ordinary create path (not written by the seed itself), so a fresh install no
        // longer answers「此工作区尚未绑定智能体」 the first time a session is created there.
        assertEquals(3, count("workspace_agents"),
                "the seeded workspace must carry one baseline binding per seeded subject");
        assertEquals(List.of(byName.get("Lead").getId().toString(),
                        byName.get("WorkerA").getId().toString(),
                        byName.get("WorkerB").getId().toString()).stream().sorted().toList(),
                jdbc.queryForList("SELECT principal_id::text FROM workspace_agents WHERE workspace_id = ?::uuid"
                                + " AND cap_source = 'baseline' ORDER BY 1", String.class,
                        workspace.getId().toString()),
                "every binding is baseline and every seeded subject is present");
        String seededDefaultSet = configService.layerEntries("instance", "agent-runtime", null, null)
                .get("defaultParticipants");
        assertNotNull(seededDefaultSet, "the instance default agent set must be seeded");
        assertTrue(seededDefaultSet.contains(byName.get("Lead").getId().toString())
                        && seededDefaultSet.contains(byName.get("WorkerA").getId().toString())
                        && seededDefaultSet.contains(byName.get("WorkerB").getId().toString()),
                "the default set names all three seeded subjects: " + seededDefaultSet);
        assertTrue(seededDefaultSet.indexOf(byName.get("Lead").getId().toString())
                        < seededDefaultSet.indexOf(byName.get("WorkerA").getId().toString()),
                "Lead is listed first, matching the order seedSubjects creates them in");
        dumpReadings("after-first-start");

        // Second start: every write is keyed, so the reading must be identical row-for-row.
        FirstRunContentSeeder second = seeder(FirstRunContentSeeder.MODE_TRUE);
        second.seed(admin);
        assertEquals(List.of(), second.lastRunWarnings(), "a second start warns about nothing either");
        assertEquals(1, count("workspaces"), "second start inserts no workspace");
        assertEquals(FirstRunContentSeeder.SEED_CONNECTIONS.size(), count("provider_connections"),
                "second start inserts no provider connection");
        assertEquals(3, count("agent_principals"), "second start inserts no subject");
        assertEquals(3, count("workspace_agents"), "second start inserts no default binding");
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
        assertEquals(FirstRunContentSeeder.SEED_CONNECTIONS.size(), count("provider_connections"),
                "auto must not touch a non-empty instance");
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

        // task-932 reverse proof on the seed path: changing the instance default AFTER the seeded
        // workspace exists must leave its local rows untouched (materialization is forward-only).
        configService.putLayer("instance", "agent-runtime",
                Map.of("defaultParticipants", "[{\"principalKind\":\"AGENT\",\"principalId\":\""
                        + byName.get("WorkerA").getId() + "\"}]"), "admin", null, null);
        seeder(FirstRunContentSeeder.MODE_TRUE).seed(admin);
        assertEquals(3, count("workspace_agents"),
                "an upper-layer default edit must never rewrite an existing workspace");
        assertEquals(List.of(byName.get("Lead").getId().toString(),
                        byName.get("WorkerA").getId().toString(),
                        byName.get("WorkerB").getId().toString()).stream().sorted().toList(),
                jdbc.queryForList("SELECT principal_id::text FROM workspace_agents WHERE workspace_id = ?::uuid"
                                + " ORDER BY 1", String.class, workspace.getId().toString()),
                "the three original bindings are still the only ones");
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
                workspaceRoot.toString(), providerCatalog, configService,
                presetBindings, presets, grantMaterializer, audit);
    }

    private int count(String table) {
        Integer rows = jdbc.queryForObject("SELECT count(*) FROM " + table, Integer.class);
        assertNotNull(rows, "count(*) must never be null for " + table);
        return rows;
    }

    /** task-963: the declared first-run default set, not a literal provider-name array. */
    private static Set<String> seedProviderIds() {
        return FirstRunContentSeeder.SEED_CONNECTIONS.stream()
                .map(FirstRunContentSeeder.SeedConnection::providerId)
                .collect(Collectors.toSet());
    }

    /** Every instance-layer connection currently in the database, in the same key space as the seed set. */
    private Set<String> instanceProviderIds() {
        return jdbc.queryForList("SELECT provider_id FROM provider_connections WHERE owner_type = ?",
                String.class, ProviderConnection.OWNER_INSTANCE).stream().collect(Collectors.toSet());
    }

    private int countWhere(String table, String predicate) {
        Integer rows = jdbc.queryForObject("SELECT count(*) FROM " + table + " WHERE " + predicate, Integer.class);
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
