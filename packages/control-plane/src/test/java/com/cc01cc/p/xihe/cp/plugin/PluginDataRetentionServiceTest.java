package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.plugin.kv.PluginKvRepository;
import com.cc01cc.p.xihe.cp.plugin.records.PluginRecordsRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * PLAN-0691 T3.2: the parts of the reclamation job that are arithmetic rather than SQL.
 *
 * <p>Deliberately not a Spring test. What is worth asserting here is the cutoff the grace period
 * produces, that each table is drained in bounded batches, and that an empty run stays out of the
 * audit stream — none of which needs a database, and all of which a real-PostgreSQL test would only
 * cover incidentally. The SQL itself (who counts as an orphan, which clock decides, what survives) is
 * asserted against PostgreSQL in {@code PluginUninstallRetentionTest}, because the statement is
 * PostgreSQL-specific ({@code ctid}, {@code jsonb}) and the H2 lane has no such tables.
 */
class PluginDataRetentionServiceTest {

    private PluginKvRepository kv;
    private PluginRecordsRepository records;
    private AuditLogger audit;

    @BeforeEach
    void setUp() {
        kv = mock(PluginKvRepository.class);
        records = mock(PluginRecordsRepository.class);
        audit = mock(AuditLogger.class);
    }

    private PluginDataRetentionService service(long graceHours, int batchSize, int maxBatches) {
        return new PluginDataRetentionService(kv, records, audit, graceHours, batchSize, maxBatches);
    }

    /** T3.2-A1: a short batch ends the loop; rows and batch counts are summed per table. */
    @Test
    void drainsBothPlanesUntilAShortBatch() {
        when(kv.deleteOrphanedBefore(any(), anyInt())).thenReturn(2, 0);
        when(records.deleteOrphanedBefore(any(), anyInt())).thenReturn(1);

        PluginDataRetentionService.PurgeReport report =
                service(168, 2, 20).purgeBefore(Instant.now());

        assertEquals(2, report.kvRows());
        assertEquals(1, report.recordsRows());
        assertEquals(3, report.batches());
        assertEquals(3, report.totalRows());
        assertFalse(report.capped());
        verify(kv, times(2)).deleteOrphanedBefore(any(), eq(2));
        verify(records, times(1)).deleteOrphanedBefore(any(), eq(2));
    }

    /**
     * T3.2-A2: a table that never returns a short batch stops at the per-run budget instead of
     * running forever, and the report says so rather than pretending the table is clean.
     */
    @Test
    void capsEachTableAtMaxBatches() {
        when(kv.deleteOrphanedBefore(any(), anyInt())).thenReturn(5);
        when(records.deleteOrphanedBefore(any(), anyInt())).thenReturn(5);

        PluginDataRetentionService.PurgeReport report =
                service(168, 5, 2).purgeBefore(Instant.now());

        assertEquals(10, report.kvRows());
        assertEquals(10, report.recordsRows());
        assertEquals(4, report.batches());
        assertTrue(report.capped());
        verify(kv, times(2)).deleteOrphanedBefore(any(), anyInt());
        verify(records, times(2)).deleteOrphanedBefore(any(), anyInt());
    }

    /** T3.2-A3: LC-6 says seven days, so the cutoff handed to the tables is now minus 168h. */
    @Test
    void scheduledPurgeUsesTheSevenDayGracePeriod() {
        when(kv.deleteOrphanedBefore(any(), anyInt())).thenReturn(0);
        when(records.deleteOrphanedBefore(any(), anyInt())).thenReturn(0);
        Instant before = Instant.now();
        service(168, 500, 20).scheduledPurge();
        Instant after = Instant.now();

        ArgumentCaptor<Instant> cutoff = ArgumentCaptor.forClass(Instant.class);
        verify(kv).deleteOrphanedBefore(cutoff.capture(), anyInt());
        Instant earliest = before.minus(168, ChronoUnit.HOURS);
        Instant latest = after.minus(168, ChronoUnit.HOURS);
        assertFalse(cutoff.getValue().isBefore(earliest));
        assertFalse(cutoff.getValue().isAfter(latest));
    }

    /** T3.2-A4: grace 0 is the "reap as soon as the binding is gone" switch, not a future cutoff. */
    @Test
    void zeroGracePeriodCutsOffAtNow() {
        when(kv.deleteOrphanedBefore(any(), anyInt())).thenReturn(0);
        when(records.deleteOrphanedBefore(any(), anyInt())).thenReturn(0);
        Instant before = Instant.now();
        service(0, 500, 20).scheduledPurge();
        Instant after = Instant.now();

        ArgumentCaptor<Instant> cutoff = ArgumentCaptor.forClass(Instant.class);
        verify(kv).deleteOrphanedBefore(cutoff.capture(), anyInt());
        assertFalse(cutoff.getValue().isBefore(before));
        // Tolerance instead of an exact instant: the point is "no grace", not clock equality.
        assertTrue(Duration.between(after, cutoff.getValue()).abs().getSeconds() < 5);
    }

    /** T3.2-A5: OBS-2 exists for runs that removed something; an hourly no-op must stay quiet. */
    @Test
    void auditsOnlyWhenRowsWereRemoved() {
        when(kv.deleteOrphanedBefore(any(), anyInt())).thenReturn(0);
        when(records.deleteOrphanedBefore(any(), anyInt())).thenReturn(0);
        service(168, 500, 20).scheduledPurge();
        verifyNoInteractions(audit);
        verify(audit, never()).recordDurableChange(any(), any(), any(), any(), any(), any());

        when(kv.deleteOrphanedBefore(any(), anyInt())).thenReturn(1);
        service(168, 500, 20).scheduledPurge();

        ArgumentCaptor<String> action = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> resourceType = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> detail = ArgumentCaptor.forClass(String.class);
        verify(audit).recordDurableChange(any(), any(), action.capture(), resourceType.capture(),
                any(), detail.capture());
        assertEquals(PluginDataRetentionService.ACTION_PURGE, action.getValue());
        assertEquals("plugin_binding", resourceType.getValue());
        assertTrue(detail.getValue().contains("kv=1"));
        assertTrue(detail.getValue().contains("graceHours=168"));
    }

    /** T3.2-A6: the three knobs fail closed on startup instead of silently changing the semantics. */
    @Test
    void rejectsInvalidConfiguration() {
        assertThrows(IllegalArgumentException.class, () -> service(-1, 500, 20));
        assertThrows(IllegalArgumentException.class, () -> service(168, 0, 20));
        assertThrows(IllegalArgumentException.class, () -> service(168, 500, 0));
    }
}
