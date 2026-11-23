package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import com.cc01cc.p.xihe.cp.provider.ProviderCatalogService;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.TestPropertySource;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-18 J1/J5: the first-run content seed must land on the <b>real first-install path</b> — an
 * empty instance whose first account is created by the onboarding
 * {@code POST /api/v1/auth/register} — and not only through {@code DataSeeder}'s seeded-admin branch.
 *
 * <p>Why this is the decisive reading: the context runs with the <b>shipped defaults</b>
 * ({@code cp.bootstrap.seed-admin=false}) and the content gate at {@code auto}, so {@code DataSeeder}
 * returns before its content line ({@code DataSeeder:133-139}). {@code admin@xihe.local} must be
 * absent, and the only thing that can have written the workspace/connection/subject rows is the
 * trigger bound to the real register request ({@link FirstRunContentSeedRequestFilter} ->
 * {@link FirstRunContentSeedTrigger}).</p>
 *
 * <p>D-1912 (task-725) supersedes the old "fresh onboarding account is USER tier only" premise:
 * the first account now claims {@code instance_owner} and receives SUPER_ADMIN <b>before</b> the
 * first-run content trigger runs. The seeder's owner gate therefore passes and the declared
 * instance-layer default set must be created; every row stays credential-less and {@code UNVERIFIED}
 * and is never claimed as a verified provider (task-963).</p>
 *
 * <p>The three readings J5 asks for are in one method, in the card's order: the full first install,
 * the second login/registration inserting nothing, and the catalog-empty model intent staying
 * "待绑定" ({@code provider}/{@code model} both null instead of a literal {@code llama3.2}).</p>
 */
@TestPropertySource(properties = {
        "cp.bootstrap.seed-admin=false",
        "cp.bootstrap.seed-content=auto"
})
class FirstRunContentSeedOnboardingIntegrationTest extends AbstractIntegrationTest {

    static {
        // task-752: this class owns the "empty instance" premise. A reusable class may have installed
        // a JVM-level snapshotSource (startup seeds) earlier in the same fork; ignore it for this class
        // so the database is cloned from the Flyway-only template instead of the seeded snapshot.
        TestDatabaseProvider.beginTemplateOnlyIsolation();
    }

    /** The runtime the direct-attach probe talks to; answers {@code available:true}. */
    private static final FirstRunSeedProbeStub PROBE =
            FirstRunSeedProbeStub.reportingAvailability(true, "windows-mxc");

    /** An absolute, disposable workspace root: never the operator's real data directory. */
    private static final Path WORKSPACE_ROOT = tempRoot();

    private static Path tempRoot() {
        try {
            return Files.createTempDirectory("xihe-onboarding-seed-");
        } catch (IOException failure) {
            throw new UncheckedIOException("cannot create the seed workspace root", failure);
        }
    }

    @DynamicPropertySource
    static void runtimeProbe(DynamicPropertyRegistry registry) {
        registry.add("cp.mcp.runtime-url", PROBE::baseUrl);
        registry.add("cp.bootstrap.seed-workspace-root", () -> WORKSPACE_ROOT.toString());
    }

    @AfterAll
    static void stopProbe() {
        try {
            PROBE.stop();
        } finally {
            TestDatabaseProvider.endTemplateOnlyIsolation();
        }
    }

    @Autowired
    private UserRepository users;
    @Autowired
    private WorkspaceRepository workspaces;
    @Autowired
    private AgentPrincipalRepository agentPrincipals;
    @Autowired
    private FirstRunContentSeeder seeder;
    @Autowired
    private FirstRunContentSeedTrigger trigger;
    @Autowired
    private JdbcTemplate jdbc;
    @Autowired
    private ProviderCatalogService providerCatalog;

    @Test
    void onboardingRegistrationSeedsTheContentGroupOnceInTheShippedDefault() {
        // ── baseline: the product default really is "no account, no content" ──────────────────────
        assertEquals(0, count("users"), "cp.bootstrap.seed-admin=false must start with zero accounts");
        assertTrue(users.findByEmail("admin@xihe.local").isEmpty(),
                "the convenience admin must not exist: otherwise this lane is the seed-admin branch");
        assertEquals(0, count("workspaces"), "no workspace before the first run");
        assertEquals(0, count("provider_connections"), "no provider connection before the first run");
        assertEquals(0, count("agent_principals"), "no subject before the first run");
        dumpReadings("baseline");

        // ── the real product path: the onboarding UI's register call ─────────────────────────────
        ResponseEntity<String> registered = restTemplate.postForEntity(url("/api/v1/auth/register"),
                Map.of("email", "first-admin@xihe.test", "password", "first-run-pass-1A",
                        "name", "First Admin"),
                String.class);
        assertEquals(HttpStatus.CREATED, registered.getStatusCode(),
                "the onboarding registration itself must succeed; got: " + registered.getBody());

        // The trigger runs after the response on the server thread; wait on the database reading.
        awaitSeeded();

        User first = users.findByEmail("first-admin@xihe.test")
                .orElseThrow(() -> new AssertionError("the onboarding account must be persisted"));
        assertEquals(1, count("users"), "exactly the onboarding account; the seeded admin never ran");
        assertTrue(users.findByEmail("admin@xihe.local").isEmpty(),
                "DataSeeder's seed-admin branch is off on this lane, so it cannot be the writer");

        assertEquals(1, count("workspaces"), "the first-install path seeds the default workspace");
        Workspace workspace = workspaces
                .findByCreateIdempotencyKeyAndDeletedAtIsNull(FirstRunContentSeeder.WORKSPACE_IDEMPOTENCY_KEY)
                .orElseThrow(() -> new AssertionError("the workspace must carry the seed idempotency key"));
        assertEquals(FirstRunContentSeeder.WORKSPACE_NAME, workspace.getName());
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM grant_preset_bindings b JOIN grant_presets r ON r.id = b.role_id"
                        + " WHERE b.subject_type = 'user' AND b.subject_id = ?::uuid"
                        + " AND b.scope_type = 'workspace' AND b.scope_id = ?::uuid AND r.name = 'WS_OWNER'",
                Integer.class, first.getId().toString(), workspace.getId().toString()),
                "the onboarding account owns the workspace it got by default");

        // D-1912 (task-725): the first account claims instance_owner + SUPER_ADMIN on registration,
        // so by the time the content trigger runs the owner gate passes. task-963: the expected count
        // is the seeder's declared default set, not a literal; every row must remain credential-less /
        // UNVERIFIED (no forged READY), and each provider must resolve in the catalog.
        assertEquals(FirstRunContentSeeder.SEED_CONNECTIONS.size(), count("provider_connections"),
                "the first account is the instance owner, so the declared instance default set is created");
        assertFalse(seeder.lastRunWarnings().stream().anyMatch(w -> w.contains("no owner yet")),
                "the owner gate must not skip anymore under D-1912; got: " + seeder.lastRunWarnings());
        List<Map<String, Object>> seededConnections = jdbc.queryForList(
                "SELECT owner_type, provider_id, connection_key, status, credential_id"
                        + " FROM provider_connections ORDER BY provider_id");
        assertEquals(seedProviderIds(), seededConnections.stream()
                        .map(row -> (String) row.get("provider_id")).collect(Collectors.toSet()),
                "the instance-layer connections equal the declared first-run default set");
        assertEquals(0, seededConnections.stream().filter(row -> "ollama".equals(row.get("provider_id"))).count(),
                "a fresh install must not seed the retired single Ollama default");
        for (Map<String, Object> seededConnection : seededConnections) {
            assertEquals(ProviderConnection.OWNER_INSTANCE, seededConnection.get("owner_type"));
            assertEquals("default", seededConnection.get("connection_key"));
            assertEquals(ProviderConnection.STATUS_UNVERIFIED, seededConnection.get("status"),
                    "a credential-less seeded connection must stay UNVERIFIED, never READY");
            assertNull(seededConnection.get("credential_id"),
                    "the seeded " + seededConnection.get("provider_id") + " connection carries no credential");
            assertTrue(providerCatalog.providerIds().contains((String) seededConnection.get("provider_id")),
                    "every seeded provider must exist in the catalog, got: " + seededConnection.get("provider_id"));
        }

        List<AgentPrincipal> subjects = agentPrincipals.findByCreatedByUserId(first.getId().toString());
        assertEquals(Set.of(FirstRunContentSeeder.LEAD_NAME, "WorkerA", "WorkerB"),
                subjects.stream().map(AgentPrincipal::getName).collect(Collectors.toSet()),
                "the three first-run subjects are created by the onboarding account");
        for (AgentPrincipal subject : subjects) {
            assertEquals(first.getId().toString(), subject.getCreatedByUserId());
            // J4 / J5 reading 3: the shipped catalog declares no model ids for the seeded providers
            // (they are remote-models), so the intent must stay empty and be labelled 待绑定.
            assertNull(subject.getDefaultModelProvider(), "no catalog-resolvable model => provider empty");
            assertNull(subject.getDefaultModelName(), "no catalog-resolvable model => model empty");
        }
        assertTrue(seeder.lastModelIntentPending(),
                "the 待绑定 state must be reported by the run, not claimed as a bound model");
        assertEquals(3, count("org_units"), "the seed adds no org unit of its own");
        assertEquals(3, count("org_unit_members"), "the three subjects are placed in the V181 tree");
        dumpReadings("after-onboarding-register");

        // ── reading 2: a second product call inserts nothing ─────────────────────────────────────
        ResponseEntity<String> login = restTemplate.postForEntity(url("/api/v1/auth/login"),
                Map.of("identifier", "first-admin@xihe.test", "password", "first-run-pass-1A"),
                String.class);
        assertEquals(HttpStatus.OK, login.getStatusCode(), "the fresh account can log in");
        restTemplate.getForEntity(url("/api/v1/auth/bootstrap-status"), String.class);
        ResponseEntity<String> secondRegistration = restTemplate.postForEntity(url("/api/v1/auth/register"),
                Map.of("email", "second-user@xihe.test", "password", "second-pass-1A", "name", "Second"),
                String.class);
        assertEquals(HttpStatus.CREATED, secondRegistration.getStatusCode());

        assertEquals(2, count("users"), "the second account exists");
        assertEquals(1, count("workspaces"), "a second account/login seeds no second workspace");
        assertEquals(3, count("agent_principals"), "and no second set of subjects");
        assertEquals(FirstRunContentSeeder.SEED_CONNECTIONS.size(), count("provider_connections"),
                "a second account/login adds no second connection");
        assertEquals(FirstRunContentSeeder.SEED_CONNECTIONS.size(),
                jdbc.queryForObject("SELECT count(*) FROM provider_connections"
                        + " WHERE owner_type = 'INSTANCE' AND connection_key = 'default'",
                Integer.class),
                "there must be exactly the declared default instance connections, never a duplicate");
        assertEquals(FirstRunContentSeeder.SEED_CONNECTIONS.size(),
                jdbc.queryForObject("SELECT count(DISTINCT provider_id) FROM provider_connections"
                        + " WHERE owner_type = 'INSTANCE' AND connection_key = 'default'", Integer.class),
                "a provider may be seeded at most once under the default key");
        assertEquals(3, count("org_unit_members"), "nobody was moved by the repeat");
        assertFalse(trigger.retryPending(), "the first attempt succeeded, so no retry is owed");
        dumpReadings("after-second-account");
    }

    /** Poll the database — the trigger runs after the response is already on the wire. */
    private void awaitSeeded() {
        long deadline = System.nanoTime() + 30_000_000_000L;
        while (System.nanoTime() < deadline) {
            if (count("workspaces") == 1 && count("agent_principals") == 3) {
                return;
            }
            try {
                Thread.sleep(50);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new AssertionError("interrupted while waiting for the first-run seed", interrupted);
            }
        }
        throw new AssertionError("the onboarding path did not seed within 30s; readings: "
                + "workspaces=" + count("workspaces") + " agent_principals=" + count("agent_principals")
                + " warnings=" + seeder.lastRunWarnings());
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

    private void dumpReadings(String stage) {
        System.out.println("[seed-readings] stage=" + stage
                + " users=" + count("users")
                + " workspaces=" + count("workspaces")
                + " provider_connections=" + count("provider_connections")
                + " agent_principals=" + count("agent_principals")
                + " org_units=" + count("org_units")
                + " org_unit_members=" + count("org_unit_members")
                + " pendingModelIntent=" + seeder.lastModelIntentPending()
                + " warnings=" + seeder.lastRunWarnings());
    }
}
