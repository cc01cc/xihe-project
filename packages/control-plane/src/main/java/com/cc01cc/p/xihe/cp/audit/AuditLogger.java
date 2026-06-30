package com.cc01cc.p.xihe.cp.audit;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * AuditLogger records all MCP tool calls and policy decisions.
 * MVP: console + file stub. Future: ELK integration.
 */
@Component
public class AuditLogger {

    private static final Logger logger = LoggerFactory.getLogger(AuditLogger.class);

    private final Map<String, AuditRecord> recentRecords = new ConcurrentHashMap<>();
    private final boolean logToConsole;

    public AuditLogger(@Value("${cp.audit.log-to-console:true}") boolean logToConsole) {
        this.logToConsole = logToConsole;
    }

    public void record(String sessionId, String toolName, String action, String detail) {
        AuditRecord record = new AuditRecord(
            sessionId,
            toolName,
            action,
            detail,
            Instant.now()
        );
        recentRecords.put(sessionId + ":" + toolName + ":" + action, record);

        if (logToConsole) {
            logger.info(
                "[AUDIT] {} | session={} | tool={} | action={} | detail={}",
                record.timestamp(),
                sessionId,
                toolName,
                action,
                detail.length() > 100 ? detail.substring(0, 100) + "..." : detail
            );
        }
    }

    public Map<String, AuditRecord> getRecentRecords() {
        return recentRecords;
    }

    public record AuditRecord(
        String sessionId,
        String toolName,
        String action,
        String detail,
        Instant timestamp
    ) {}
}
