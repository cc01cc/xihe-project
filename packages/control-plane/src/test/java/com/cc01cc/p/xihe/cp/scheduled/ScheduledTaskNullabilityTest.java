package com.cc01cc.p.xihe.cp.scheduled;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * D-1706 ③ / task-56: what actually happens to a {@code scheduled_tasks} row whose
 * {@code next_fire_at} is NULL.
 *
 * <p>This class exists because "make the column nullable" on its own is a <b>silent failure</b>, not
 * a neutral schema change. The claim statement is
 * {@code ... where t.id = :id and t.status = 'scheduled' and t.nextFireAt = :expectedNextFire}
 * ({@code ScheduledTaskRepository#claimToFiring}). For a NULL row the parameter is NULL too, so SQL
 * three-valued logic makes {@code NULL = NULL} evaluate to <b>UNKNOWN</b> — the WHERE clause is not
 * satisfied, the UPDATE affects <b>0 rows</b>, and <b>nothing raises an error</b>.
 * {@code ScheduledTaskScanService} reads 0 as "the row was changed by a concurrent path" and
 * continues. The composed behaviour is therefore "quietly never fires".
 *
 * <p>So the null path is not asserted as a happy path here: it is asserted as an <b>explicit
 * negative</b>. If a future change makes {@code claimToFiring} succeed on a null row (for example by
 * relaxing the CAS to an {@code OR nextFireAt IS NULL} predicate), this class goes red and the
 * author has to think about the event-trigger claim semantics instead of inheriting them.
 *
 * <p>Three readings, all against the real repository/JPQL (not a hand-written SQL copy):
 * <ol>
 *   <li><b>Claim is impossible</b> — {@code claimToFiring} returns 0 and the row stays
 *       {@code scheduled};</li>
 *   <li><b>Discovery is impossible</b> — the due scan query returns no row, and neither does the
 *       overdue sweep, so a null row cannot be picked up or marked missed;</li>
 *   <li><b>Quota still counts it</b> — the quota is status-based, so a null row keeps occupying an
 *       active slot. A future rewrite to a fire-time-based count would silently hand out extra rows
 *       and would be caught here.</li>
 * </ol>
 */
class ScheduledTaskNullabilityTest extends AbstractH2Test {

    @Autowired
    private ScheduledTaskRepository repository;

    /**
     * The H2 lane keeps one database per <i>class</i> (the AFTER_CLASS {@code @DirtiesContext} in
     * {@code AbstractH2Test} is deliberate — see its comment), so methods in this class would otherwise
     * see each other's rows. The due-scan assertion below is a "how many rows are discovered" count,
     * which is exactly the shape that silently passes or fails on leftovers, so the table is emptied
     * first instead of relying on method order.
     */
    @BeforeEach
    void clearScheduledTasks() {
        repository.deleteAll();
    }

    /** A row that is legal except for the missing fire instant (D-1706 ③ shape). */
    private ScheduledTask nullFireRow() {
        ScheduledTask task = new ScheduledTask();
        task.setWorkspaceId(UUID.randomUUID());
        task.setUserId(UUID.randomUUID());
        task.setTriggerKind(ScheduledTask.TRIGGER_INTERVAL);
        task.setIntervalSeconds(60);
        task.setTimezone("UTC");
        task.setTargetKind(ScheduledTask.TARGET_SESSION_WAKEUP);
        task.setTargetSessionId(UUID.randomUUID());
        task.setPrompt("event-triggered row: no scheduled instant");
        task.setStatus(ScheduledTask.STATUS_SCHEDULED);
        task.setNextFireAt(null);
        return repository.saveAndFlush(task);
    }

    @Test
    void null_next_fire_at_row_exists_and_persists_as_null() {
        ScheduledTask saved = nullFireRow();
        assertNotNull(saved.getId(), "a null next_fire_at row is insertable (V171 relaxed NOT NULL)");
        assertNull(repository.findById(saved.getId()).orElseThrow().getNextFireAt(),
                "the null instant survives the round trip as NULL, not as a placeholder value");
    }

    /**
     * The core assertion of this class (Lead's追加 (ii)): the existing claim statement cannot claim a
     * null row, and the failure is silent — 0 rows, still {@code scheduled}, no exception.
     */
    @Test
    void claimToFiring_affects_zero_rows_for_a_null_next_fire_at() {
        ScheduledTask saved = nullFireRow();

        int claimed = repository.claimToFiring(saved.getId(), null);

        assertEquals(0, claimed,
                "claimToFiring MUST affect 0 rows when next_fire_at is NULL: 'NULL = NULL' is UNKNOWN "
                        + "in SQL, so this CAS can never match. Stage two must add its own claim "
                        + "statement instead of reusing this one.");
        assertEquals(ScheduledTask.STATUS_SCHEDULED,
                repository.findById(saved.getId()).orElseThrow().getStatus(),
                "the 0-row CAS leaves the row scheduled — the scan sees a lost race, not an error");
    }

    /**
     * Negative control: a non-null row <b>is</b> claimable, so the reading above is about NULL rather
     * than about the repository being broken.
     *
     * <p>The expected value is read back from the database, not reused from the fixture: the CAS
     * compares by equality, and a {@code TIMESTAMPTZ} round trip truncates {@link Instant}'s nanos, so
     * passing the in-memory value would fail for a precision mismatch that has nothing to do with the
     * claim logic. Reading it back also documents why the null case is the only structural one.</p>
     */
    @Test
    void claimToFiring_still_claims_a_non_null_next_fire_at() {
        ScheduledTask timed = nullFireRow();
        Instant fireAt = Instant.now().minus(1, ChronoUnit.MINUTES);
        timed.setNextFireAt(fireAt);
        repository.saveAndFlush(timed);

        Instant persisted = repository.findById(timed.getId()).orElseThrow().getNextFireAt();
        assertEquals(1, repository.claimToFiring(timed.getId(), persisted),
                "a time-triggered row is still claimable — the null result above is specific to NULL");
    }

    /** Null rows are invisible to both time-based sweeps: discovery and overdue marking. */
    @Test
    void null_next_fire_at_row_is_invisible_to_the_time_based_scans() {
        ScheduledTask saved = nullFireRow();
        Instant roughlyNow = Instant.now().plus(1, ChronoUnit.MINUTES);

        List<ScheduledTask> due = repository.findByStatusAndNextFireAtBeforeOrderByNextFireAtAsc(
                ScheduledTask.STATUS_SCHEDULED, roughlyNow);
        int overdue = repository.markOverdueMissed(ScheduledTask.STATUS_SCHEDULED, roughlyNow,
                ScheduledTask.REASON_OVERDUE_GRACE, Instant.now());

        assertEquals(0, due.size(), "the due scan must not discover a null next_fire_at row");
        assertEquals(0, overdue, "the overdue sweep must not mark a null next_fire_at row missed");
        assertEquals(ScheduledTask.STATUS_SCHEDULED,
                repository.findById(saved.getId()).orElseThrow().getStatus(),
                "an event row stays scheduled: 'no expected instant' is not 'overdue'");
    }

    /** Quota is status-based, so a null row still occupies its active slot. */
    @Test
    void quota_counting_includes_null_next_fire_at_rows() {
        ScheduledTask saved = nullFireRow();
        UUID workspaceId = saved.getWorkspaceId();
        UUID userId = saved.getUserId();

        long workspaceActive = repository.countByWorkspaceIdAndStatusIn(
                workspaceId, ScheduledTaskApiService.ACTIVE_STATUSES);
        long principalActive = repository.countByWorkspaceIdAndUserIdAndStatusIn(
                workspaceId, userId, ScheduledTaskApiService.ACTIVE_STATUSES);

        assertEquals(1, workspaceActive,
                "a null next_fire_at row still counts against the Workspace quota — a fire-time-based "
                        + "count would let a workspace exceed its cap and would be caught here");
        assertEquals(1, principalActive,
                "and it still counts against the principal quota");
    }
}
