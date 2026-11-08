package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.plugin.kv.PluginKvRepository;
import com.cc01cc.p.xihe.cp.plugin.records.PluginRecordsRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.temporal.ChronoUnit;

/**
 * PLAN-0691 T3.2 (DP-6a / LC-6 / V6): the grace-period reclamation job for the plugin data planes.
 *
 * <p><b>Why a job and not a foreign key.</b> Uninstall deletes the binding row physically (SEC-2: no
 * {@code removed} tombstone) while V6 requires {@code plugin_kv} / {@code plugin_records} rows to
 * survive a grace period, so the two data planes cannot be tied to {@code plugin_bindings} by a
 * foreign key: {@code ON DELETE CASCADE} would destroy user data on uninstall and delete the rows V6
 * says must still be there, while {@code RESTRICT} would refuse the uninstall and the
 * {@code uq_plugin_bindings_workspace_plugin} slot would stay blocked for the seven days the orphan
 * rows live. DP-6a therefore keeps {@code binding_id} as a plain column and puts the grace semantics
 * on <b>orphan rows outliving their binding</b>. This class is the reader that eventually reaps them,
 * and it is the only place where that rule is executable code.
 *
 * <p><b>The two data planes are not judged the same way, on purpose.</b> This is the fact most likely
 * to be re-derived incorrectly later, so it is written down here rather than inferred from two SQL
 * files:
 * <ul>
 *   <li>{@code plugin_kv} has an explicit {@code orphaned_at} column (V141) whose intended writer is
 *       the binding-delete path of T1.4 — that path is not delivered yet, so <b>nothing in the tree
 *       writes the column</b> and the statement below reads
 *       {@code COALESCE(orphaned_at, updated_at)}, exactly DP-6a's documented fallback. Its partial
 *       index {@code idx_plugin_kv_orphaned_at} therefore cannot serve this predicate today.</li>
 *   <li>{@code plugin_records} has <b>no</b> {@code orphaned_at} column: V142 deliberately did not add
 *       one because DP-2 does not declare it and a second clock must not exist before a writer does.
 *       The grace period there reads {@code updated_at} only — the fallback made unconditional.</li>
 * </ul>
 * Consequence, stated instead of hidden: the clock is "last written at" (or the explicit stamp when a
 * future lane adds one), not "binding deleted at". LC-6 names the binding-deletion moment as the start
 * of the clock; with no stamper the two moments differ, so a binding deleted long after its last write
 * is reaped sooner than seven days. Closing that gap means writing {@code orphaned_at} on binding
 * deletion (T1.4's path), not changing this job. Both statements are otherwise identical: a row is
 * orphaned when its {@code binding_id} is absent from {@code plugin_bindings} <b>and</b> it is older
 * than the cutoff.
 *
 * <p><b>What it must never do.</b> No {@code CASCADE}, no unbounded {@code DELETE}, and no ledger
 * reclamation: {@code plugin_index_declarations} is permanent (DP-3 / LC-6), so it is not passed in
 * here at all. Work is bounded twice — {@code batch-size} rows per statement and {@code max-batches}
 * statements per table per run — so a backlog costs several runs instead of one long table scan.
 *
 * <p><b>Known gap, not claimed as done.</b> V141's comment also promises that <i>expired</i>
 * {@code plugin_kv} rows ({@code expires_at}) are recycled hourly. That is not implemented here: an
 * expired row is already invisible (API-1) and deleting it would change the {@code version} a fresh
 * write starts from, which is a separate decision. This job reaps orphans only.
 *
 * <p><b>Gating and the time seam.</b> The bean is conditional on {@code cp.plugin.enabled} for the same
 * reason the plugin controllers are (D-66) plus one of its own: the two tables only exist where
 * Flyway ran, and the H2 lane creates them for no JPA entity, so an ungated hourly job would fail on
 * every H2 context. {@link #purgeBefore(Instant)} takes the cutoff as an argument instead of reading a
 * clock bean, which lets tests prove both the grace arithmetic and the SQL without sleeping.
 */
@Service
@ConditionalOnProperty(name = "cp.plugin.enabled", havingValue = "true")
public class PluginDataRetentionService {

    private static final Logger log = LoggerFactory.getLogger(PluginDataRetentionService.class);

    /** LC-6: the grace period is seven days, spelled in the unit this class computes with. */
    static final long DEFAULT_GRACE_HOURS = 7L * 24L;

    static final int DEFAULT_BATCH_SIZE = 500;
    static final int DEFAULT_MAX_BATCHES = 20;

    /** OBS-2 vocabulary: the durable action of this job. */
    static final String ACTION_PURGE = "plugin.purge";

    private final PluginKvRepository kvRepository;
    private final PluginRecordsRepository recordsRepository;
    private final AuditLogger auditLogger;
    private final long graceHours;
    private final int batchSize;
    private final int maxBatches;

    public PluginDataRetentionService(PluginKvRepository kvRepository,
            PluginRecordsRepository recordsRepository, AuditLogger auditLogger,
            @Value("${cp.plugin.retention.grace-hours:168}") long graceHours,
            @Value("${cp.plugin.retention.batch-size:500}") int batchSize,
            @Value("${cp.plugin.retention.max-batches:20}") int maxBatches) {
        // Fail-fast instead of clamping: a negative grace would delete rows younger than the grace
        // period (the opposite of LC-6) and a zero batch would make a run a no-op forever.
        if (graceHours < 0) {
            throw new IllegalArgumentException(
                    "cp.plugin.retention.grace-hours must be >= 0, got " + graceHours);
        }
        if (batchSize < 1) {
            throw new IllegalArgumentException(
                    "cp.plugin.retention.batch-size must be >= 1, got " + batchSize);
        }
        if (maxBatches < 1) {
            throw new IllegalArgumentException(
                    "cp.plugin.retention.max-batches must be >= 1, got " + maxBatches);
        }
        this.kvRepository = kvRepository;
        this.recordsRepository = recordsRepository;
        this.auditLogger = auditLogger;
        this.graceHours = graceHours;
        this.batchSize = batchSize;
        this.maxBatches = maxBatches;
    }

    /**
     * Hourly entry point: computes the cutoff from the configured grace period and delegates.
     *
     * <p>The audit entry is written by {@link #purgeBefore(Instant)} rather than here, so that every
     * deletion — including one driven through the seam — is accounted for. A row for every empty
     * hourly run would add twenty-four "nothing happened" lines a day and bury the runs that mattered,
     * so the empty case stays silent (OBS-2 names the action, not a heartbeat).
     */
    @Scheduled(fixedRateString = "${cp.plugin.retention.interval-ms:3600000}")
    public void scheduledPurge() {
        purgeBefore(Instant.now().minus(graceHours, ChronoUnit.HOURS));
    }

    /**
     * Reaps orphaned rows older than {@code cutoff} from both data planes, in bounded batches, and
     * audits the run when it removed something.
     *
     * @return what this call deleted; {@code capped} means at least one table still had a full batch
     *         when the per-run budget ran out
     */
    public PurgeReport purgeBefore(Instant cutoff) {
        Drain kv = drain(kvRepository::deleteOrphanedBefore, cutoff);
        Drain records = drain(recordsRepository::deleteOrphanedBefore, cutoff);
        PurgeReport report = new PurgeReport(kv.rows(), records.rows(),
                kv.batches() + records.batches(), kv.capped() || records.capped());
        if (report.totalRows() == 0) {
            log.debug("plugin data purge found nothing older than {}", cutoff);
            return report;
        }
        if (report.capped()) {
            log.warn("plugin data purge hit the batch budget ({} batches per table);"
                    + " remaining orphans wait for the next run", maxBatches);
        }
        log.info("plugin data purge removed kv={} records={} batches={} cutoff={}",
                report.kvRows(), report.recordsRows(), report.batches(), cutoff);
        auditLogger.recordDurableChange(null, null, ACTION_PURGE, "plugin_binding", null,
                "kv=" + report.kvRows() + " records=" + report.recordsRows()
                        + " graceHours=" + graceHours + " cutoff=" + cutoff);
        return report;
    }

    private Drain drain(Batch batch, Instant cutoff) {
        int rows = 0;
        int batches = 0;
        while (batches < maxBatches) {
            int deleted = batch.delete(cutoff, batchSize);
            rows += deleted;
            batches++;
            if (deleted < batchSize) {
                // A short batch means the table is drained as of this cutoff; no second count query.
                return new Drain(rows, batches, false);
            }
        }
        return new Drain(rows, batches, true);
    }

    /** What one {@link #purgeBefore(Instant)} run removed. */
    public record PurgeReport(int kvRows, int recordsRows, int batches, boolean capped) {

        public int totalRows() {
            return kvRows + recordsRows;
        }
    }

    /** One table's batch statement, so both data planes go through the same budget loop. */
    @FunctionalInterface
    private interface Batch {

        int delete(Instant cutoff, int limit);
    }

    private record Drain(int rows, int batches, boolean capped) {
    }
}
