package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.TestPropertySource;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T3.2: uninstall leaves data in place, and only the grace-period job removes it
 * (spec/data-plane.md DP-6a, LC-6, V6; verify.md V6 names this class).
 *
 * <p>Cases are labelled E1–E5. What each one is <i>for</i>, and what it excludes:
 * <ul>
 *   <li><b>E1 grace keeps data</b> — after the real {@code PluginCatalogService.uninstall} path (which
 *       physically deletes the binding row and every plugin version first), the {@code plugin_kv} and
 *       {@code plugin_records} rows are <b>still there</b> and the production entry point
 *       ({@code scheduledPurge()}, i.e. the configured seven-day grace) removes nothing of them. This
 *       is V6's first half; it excludes any grace-expiry behaviour (E2).</li>
 *   <li><b>E2 expiry reaps data, not audit or ledger</b> — with the rows aged past seven days the same
 *       predicate removes both data rows, leaves {@code plugin_index_declarations} untouched
 *       (DP-3/LC-6), leaves the lifecycle audit rows readable, and writes exactly one
 *       {@code plugin.purge} entry (OBS-2) whose detail carries the counts. It excludes "does the
 *       scheduler fire hourly" — that is Spring's contract; the run is invoked directly instead of
 *       waiting for a clock.</li>
 *   <li><b>E3 live binding protects</b> — thirty-day-old rows whose binding still exists are never
 *       touched: age alone is not orphanhood (DP-6a needs both). This is the assertion that fails if
 *       someone "simplifies" the statement into a pure cutoff delete.</li>
 *   <li><b>E4 the two planes are judged differently</b> — on {@code plugin_kv} a fresh
 *       {@code orphaned_at} overrides a stale {@code updated_at} and a stale {@code orphaned_at}
 *       overrides a fresh {@code updated_at}; on {@code plugin_records}, which has no such column by
 *       V142's decision, the same {@code updated_at} is the only clock. Two KV rows that differ
 *       <b>only</b> in which clock they carry therefore end up on opposite sides of one purge.</li>
 *   <li><b>E5 bounded batches</b> — with {@code batch-size=2} and {@code max-batches=1} (this class's
 *       configuration) three orphans take two runs, the first reports {@code capped}, and a third run
 *       over the now-clean tables deletes nothing and writes no new {@code plugin.purge} row
 *       (idempotence; OBS-2 names the action, not a heartbeat).</li>
 * </ul>
 *
 * <p><b>Why every case starts from an empty orphan set.</b> The class shares one migrated database
 * and the job's counts are global by nature, so each case that asserts a count first calls
 * {@link #drainOrphans()} — a bounded loop of purge runs with "everything is old enough" cutoffs —
 * instead of hoping no earlier case left a row behind. Cases then assert on their own binding ids,
 * which is the only thing they can honestly claim.
 *
 * <p><b>Deliberately not asserted here</b>: that uninstall is refused while a binding exists
 * (D-65③/409, covered by the catalog tests) and that {@code orphaned_at} is stamped when a binding is
 * deleted — nothing in the tree writes that column yet (see {@code PluginDataRetentionService}), so
 * E4 seeds it directly. The lifecycle audit rows are asserted by action and resource id only: this
 * test drives the services without a user, so {@code user_id}/{@code workspace_id} are null by
 * construction and the actor plumbing is not what V6 asks about.
 */
@TestPropertySource(properties = {
        "cp.plugin.enabled=true",
        "cp.plugin.advisory-lock=false",
        "cp.plugin.retention.batch-size=2",
        "cp.plugin.retention.max-batches=1"
})
class PluginUninstallRetentionTest extends AbstractIntegrationTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** One temp package root for the whole class; each test installs a manifest with a fresh id. */
    private static final Path PACKAGE_ROOT = createPackageRoot();

    @DynamicPropertySource
    static void packageRoot(DynamicPropertyRegistry registry) {
        registry.add("cp.plugin.package-root", () -> PACKAGE_ROOT.toString());
    }

    @Autowired
    private PluginCatalogService catalog;

    @Autowired
    private PluginDataRetentionService retention;

    @Autowired
    private JdbcTemplate jdbc;

    // ------------------------------------------------------------------ E1

    @Test
    void uninstallKeepsDataThroughTheGracePeriod() {
        Fixture fixture = uninstalledPlugin();

        // The production entry point, not a hand-computed cutoff: this is the seven-day grace.
        retention.scheduledPurge();

        assertEquals(1, count("plugin_kv", fixture.bindingId()));
        assertEquals(1, count("plugin_records", fixture.bindingId()));
        assertEquals(1, count("plugin_index_declarations", fixture.bindingId()));
        assertEquals(List.of("plugin.install", "plugin.disable", "plugin.uninstall"),
                lifecycleActions(fixture.pluginId()));
    }

    // ------------------------------------------------------------------ E2

    @Test
    void expiredOrphansAreReapedButAuditAndLedgerStay() {
        drainOrphans();
        Fixture fixture = uninstalledPlugin();
        ageData(fixture.bindingId(), Instant.now().minus(8, ChronoUnit.DAYS));
        int auditsBefore = countPurgeAudits();

        PluginDataRetentionService.PurgeReport report =
                retention.purgeBefore(Instant.now().minus(7, ChronoUnit.DAYS));

        assertEquals(1, report.kvRows());
        assertEquals(1, report.recordsRows());
        assertEquals(0, count("plugin_kv", fixture.bindingId()));
        assertEquals(0, count("plugin_records", fixture.bindingId()));
        assertEquals(1, count("plugin_index_declarations", fixture.bindingId()));
        assertEquals(List.of("plugin.install", "plugin.disable", "plugin.uninstall"),
                lifecycleActions(fixture.pluginId()));
        List<String> details = purgeAuditsBetween(auditsBefore);
        assertEquals(1, details.size(), details.toString());
        assertTrue(details.get(0).contains("kv=1"), details.get(0));
        assertTrue(details.get(0).contains("records=1"), details.get(0));
        assertTrue(details.get(0).contains("graceHours=168"), details.get(0));
    }

    // ------------------------------------------------------------------ E3

    @Test
    void liveBindingsAreNeverReapedHoweverOldTheDataIs() {
        Fixture fixture = installedPlugin();
        ageData(fixture.bindingId(), Instant.now().minus(30, ChronoUnit.DAYS));

        // "Everything is old enough": only the missing binding can still protect these rows.
        retention.purgeBefore(Instant.now());

        assertEquals(1, count("plugin_kv", fixture.bindingId()));
        assertEquals(1, count("plugin_records", fixture.bindingId()));
    }

    // ------------------------------------------------------------------ E4

    @Test
    void kvUsesTheExplicitOrphanClockAndRecordsFallsBackToUpdatedAt() {
        drainOrphans();
        UUID workspaceId = seedWorkspace();
        UUID kvSurvives = seedOrphanKv(workspaceId, Instant.now().minus(30, ChronoUnit.DAYS),
                Instant.now());
        UUID kvReaped = seedOrphanKv(workspaceId, Instant.now(),
                Instant.now().minus(30, ChronoUnit.DAYS));
        // Same two-row contrast on the plane without an orphaned_at column: V142 gives it one clock.
        UUID recordsAged = seedOrphanRecords(workspaceId, Instant.now().minus(30, ChronoUnit.DAYS));

        PluginDataRetentionService.PurgeReport report =
                retention.purgeBefore(Instant.now().minus(1, ChronoUnit.HOURS));

        assertEquals(1, report.kvRows());
        assertEquals(1, report.recordsRows());
        assertEquals(1, count("plugin_kv", kvSurvives),
                "a fresh orphaned_at must pin the row past the grace period");
        assertEquals(0, count("plugin_kv", kvReaped),
                "a stale orphaned_at must decide even when updated_at is fresh");
        assertEquals(0, count("plugin_records", recordsAged),
                "plugin_records has no orphaned_at, so updated_at is its only clock");
    }

    // ------------------------------------------------------------------ E5

    @Test
    void threeOrphansTakeTwoBoundedRunsAndTheCleanRunIsSilent() {
        drainOrphans();
        UUID workspaceId = seedWorkspace();
        for (int i = 0; i < 3; i++) {
            seedOrphanKv(workspaceId, Instant.now().minus(30, ChronoUnit.DAYS), null);
        }
        for (int i = 0; i < 3; i++) {
            seedOrphanRecords(workspaceId, Instant.now().minus(30, ChronoUnit.DAYS));
        }

        PluginDataRetentionService.PurgeReport first = retention.purgeBefore(Instant.now());
        assertEquals(2, first.kvRows());
        assertEquals(2, first.recordsRows());
        assertTrue(first.capped(), "a full batch with the budget exhausted must report capped");

        PluginDataRetentionService.PurgeReport second = retention.purgeBefore(Instant.now());
        assertEquals(1, second.kvRows());
        assertEquals(1, second.recordsRows());
        assertFalse(second.capped(), "the short batch proves both tables drained");

        int auditsBefore = countPurgeAudits();
        PluginDataRetentionService.PurgeReport third = retention.purgeBefore(Instant.now());
        assertEquals(0, third.totalRows());
        assertEquals(0, purgeAuditsBetween(auditsBefore).size(),
                "a no-op run must not audit");
    }

    // ------------------------------------------------------------------ fixtures

    /** Plugin id, digest and workspace of one installed-and-uninstalled plugin. */
    private record Fixture(String pluginId, String digest, UUID workspaceId, UUID bindingId) {
    }

    /** A plugin that is installed, disabled and uninstalled, with one binding's worth of data left. */
    private Fixture uninstalledPlugin() {
        Fixture fixture = installedPlugin();
        jdbc.update("DELETE FROM plugin_bindings WHERE id = ?", fixture.bindingId());
        catalog.uninstall(fixture.pluginId(), null, fixture.workspaceId().toString());
        return fixture;
    }

    /** A plugin installed through the product path plus a disabled binding holding one row per table. */
    private Fixture installedPlugin() {
        UUID workspaceId = seedWorkspace();
        String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 8);
        String pluginId = "official.retention-" + suffix;
        writePackage(pluginId);
        Plugin plugin = catalog.install("official/retention-" + suffix, null,
                workspaceId.toString());
        catalog.setEnabled(pluginId, false, null, workspaceId.toString());
        UUID bindingId = seedBinding(plugin, workspaceId);
        insertKv(bindingId, Instant.now(), null);
        insertRecords(bindingId, Instant.now());
        jdbc.update("INSERT INTO plugin_index_declarations (binding_id, collection, index_name,"
                        + " fields, state, applied_at) VALUES (?, 'docs', 'idx_a', ARRAY['a'],"
                        + " 'applied', NOW())",
                bindingId);
        return new Fixture(plugin.getId(), plugin.getDigest(), workspaceId, bindingId);
    }

    private UUID seedWorkspace() {
        UUID workspaceId = UUID.randomUUID();
        jdbc.update("INSERT INTO workspaces (id, name) VALUES (?, ?)", workspaceId,
                "retention-ws-" + workspaceId);
        return workspaceId;
    }

    /** A binding row for an already installed plugin version (SQL, exactly what attach leaves). */
    private UUID seedBinding(Plugin plugin, UUID workspaceId) {
        UUID bindingId = UUID.randomUUID();
        jdbc.update("INSERT INTO plugin_bindings (id, plugin_id, digest, version, workspace_id,"
                        + " state) VALUES (?, ?, ?, ?, ?, 'disabled')",
                bindingId, plugin.getId(), plugin.getDigest(), plugin.getVersion(), workspaceId);
        return bindingId;
    }

    /** An orphan {@code plugin_kv} row: the binding it names does not exist (DP-6a: no FK). */
    private UUID seedOrphanKv(UUID workspaceId, Instant updatedAt, Instant orphanedAt) {
        UUID bindingId = UUID.randomUUID();
        insertKv(bindingId, updatedAt, orphanedAt);
        return bindingId;
    }

    /** An orphan {@code plugin_records} row (one clock only, by V142's design). */
    private UUID seedOrphanRecords(UUID workspaceId, Instant updatedAt) {
        UUID bindingId = UUID.randomUUID();
        insertRecords(bindingId, updatedAt);
        return bindingId;
    }

    private void insertKv(UUID bindingId, Instant updatedAt, Instant orphanedAt) {
        jdbc.update("INSERT INTO plugin_kv (binding_id, namespace, key, value, orphaned_at,"
                        + " updated_at) VALUES (?, 'docs', 'k', '{}'::jsonb, ?, ?)",
                bindingId, timestamp(orphanedAt), timestamp(updatedAt));
    }

    private void insertRecords(UUID bindingId, Instant updatedAt) {
        jdbc.update("INSERT INTO plugin_records (binding_id, collection, id, doc, updated_at)"
                        + " VALUES (?, 'docs', 'r1', '{\"a\":1}'::jsonb, ?)",
                bindingId, timestamp(updatedAt));
    }

    private void ageData(UUID bindingId, Instant at) {
        jdbc.update("UPDATE plugin_kv SET updated_at = ? WHERE binding_id = ?",
                timestamp(at), bindingId);
        jdbc.update("UPDATE plugin_records SET updated_at = ? WHERE binding_id = ?",
                timestamp(at), bindingId);
    }

    /**
     * Removes every orphan the job could ever take, so a following count is deterministic.
     *
     * <p>Uses a cutoff of "now", which makes age irrelevant and leaves only the orphan predicate. The
     * bound exists so a broken predicate fails the test instead of hanging it.
     */
    private void drainOrphans() {
        for (int run = 0; run < 50; run++) {
            if (retention.purgeBefore(Instant.now()).totalRows() == 0) {
                return;
            }
        }
        throw new IllegalStateException("orphan drain did not converge");
    }

    private int count(String table, UUID bindingId) {
        Integer rows = jdbc.queryForObject(
                "SELECT COUNT(*) FROM " + table + " WHERE binding_id = ?", Integer.class, bindingId);
        return rows == null ? 0 : rows;
    }

    private List<String> lifecycleActions(String pluginId) {
        return jdbc.queryForList("SELECT action FROM audit_logs WHERE resource_id = ?"
                + " ORDER BY created_at, action", String.class, pluginId);
    }

    private int countPurgeAudits() {
        Integer rows = jdbc.queryForObject(
                "SELECT COUNT(*) FROM audit_logs WHERE action = 'plugin.purge'",
                Integer.class);
        return rows == null ? 0 : rows;
    }

    /**
     * PLAN-0739: returns the details of every purge audit written after the caller read
     * {@code countPurgeAudits()}. Reads the full action window and slices in memory instead of
     * comparing two clocks, so a no-op assertion cannot pick up an earlier run's audit.
     */
    private List<String> purgeAuditsBetween(int before) {
        List<String> details = jdbc.queryForList(
                "SELECT details FROM audit_logs WHERE action = 'plugin.purge'"
                        + " ORDER BY created_at, id", String.class);
        return details.size() > before ? details.subList(before, details.size()) : List.of();
    }

    private static OffsetDateTime timestamp(Instant instant) {
        return instant == null ? null : OffsetDateTime.ofInstant(instant, ZoneOffset.UTC);
    }

    private static Path createPackageRoot() {
        try {
            return Files.createTempDirectory("xihe-plugin-retention-");
        } catch (IOException e) {
            throw new IllegalStateException("cannot create the plugin package root", e);
        }
    }

    /** Writes a valid builtin manifest under {@code official/retention-<suffix>/}. */
    private static void writePackage(String pluginId) {
        String suffix = pluginId.substring("official.retention-".length());
        Path directory = PACKAGE_ROOT.resolve("official/retention-" + suffix);
        try {
            Files.createDirectories(directory);
            ObjectNode node = MAPPER.createObjectNode();
            node.put("manifestVersion", "1");
            node.put("id", pluginId);
            node.put("version", "1.0.0");
            node.put("source", "builtin");
            node.put("title", pluginId);
            node.putObject("runtime").put("kind", "mcp-http")
                    .put("endpoint", "https://plugins.example.test/mcp");
            node.putArray("actions").addObject().put("name", "demo.echo")
                    .put("actionClass", "read");
            node.putArray("requestedAtoms").add("plugin:invoke");
            node.putObject("compatibility").put("xhApi", "1.4");
            node.put("digest", PluginManifestValidator.computeDigest(node));
            Files.writeString(directory.resolve("manifest.json"),
                    MAPPER.writeValueAsString(node), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException("cannot write plugin fixture " + pluginId, e);
        }
    }
}
