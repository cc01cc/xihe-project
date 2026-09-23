package com.cc01cc.p.xihe.cp.audit;

import com.cc01cc.p.xihe.cp.entity.AuditLog;
import com.cc01cc.p.xihe.cp.repository.AuditLogRepository;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

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

    @Test
    void record_redactsCredentialsAndRawArgumentsBeforeStorage() {
        logger.record("s1", "mcp", "request",
            "Authorization: Bearer bearer-secret Cookie=session-secret apiKey=api-secret "
                + "arguments={\"password\":\"raw-secret\"}");

        String detail = logger.getRecentRecords().get("s1:mcp:request").detail();
        assertFalse(detail.contains("bearer-secret"));
        assertFalse(detail.contains("session-secret"));
        assertFalse(detail.contains("api-secret"));
        assertFalse(detail.contains("raw-secret"));
        assertTrue(detail.contains("***redacted***"));
    }

    @Test
    void sanitize_preservesNonSensitiveAuditContext() {
        assertEquals("policy=allow reason=classified", AuditLogger.sanitize("policy=allow reason=classified"));
    }

    @Test
    void recordDurableChange_persistsSanitizedAuditRow() {
        AuditLogRepository repository = mock(AuditLogRepository.class);
        AuditLogger durableLogger = new AuditLogger(false, repository);

        durableLogger.recordDurableChange("actor-id", "workspace-id", "grant_changed",
                "grant", "grant-id", "source=direct apiKey=secret-value");

        ArgumentCaptor<AuditLog> captor = ArgumentCaptor.forClass(AuditLog.class);
        verify(repository).save(captor.capture());
        AuditLog row = captor.getValue();
        assertEquals("actor-id", row.getUserId());
        assertEquals("workspace-id", row.getWorkspaceId());
        assertEquals("grant_changed", row.getAction());
        assertEquals("grant", row.getResourceType());
        assertEquals("grant-id", row.getResourceId());
        assertFalse(row.getDetails().contains("secret-value"));
        assertTrue(row.getDetails().contains("***redacted***"));
    }
}
