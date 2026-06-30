package com.cc01cc.p.xihe.cp.audit;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class AuditLoggerTest {

    private final AuditLogger logger = new AuditLogger(false);

    @Test
    void record_storesEntryInRecentRecords() {
        logger.record("session-1", "read_file", "policy_check", "allowed");
        var records = logger.getRecentRecords();
        assertEquals(1, records.size());
        assertTrue(records.containsKey("session-1:read_file:policy_check"));
    }

    @Test
    void record_storesMultipleEntries() {
        logger.record("s1", "tool_a", "start", "ok");
        logger.record("s1", "tool_b", "start", "ok");
        assertEquals(2, logger.getRecentRecords().size());
    }

    @Test
    void record_overwritesDuplicateKey() {
        logger.record("s1", "t1", "action", "first");
        logger.record("s1", "t1", "action", "second");
        var records = logger.getRecentRecords();
        assertEquals(1, records.size());
        assertEquals("second", records.get("s1:t1:action").detail());
    }

    @Test
    void getRecentRecords_returnsEmptyMapInitially() {
        assertTrue(logger.getRecentRecords().isEmpty());
    }

    @Test
    void auditRecord_holdsAllFields() {
        var record = new AuditLogger.AuditRecord("s1", "tool", "action", "detail", null);
        assertEquals("s1", record.sessionId());
        assertEquals("tool", record.toolName());
        assertEquals("action", record.action());
        assertEquals("detail", record.detail());
    }
}
