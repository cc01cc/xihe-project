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
 * Persists to a dedicated audit JSONL file (logback logger "AUDIT") and keeps
 * a bounded in-memory recent-records view. Future: DB/ELK integration.
 */
@Component
public class AuditLogger {

    private static final Logger logger = LoggerFactory.getLogger(AuditLogger.class);
    private static final Logger auditLog = LoggerFactory.getLogger("AUDIT");
    private static final int MAX_RECENT_RECORDS = 1000;

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
        if (recentRecords.size() >= MAX_RECENT_RECORDS) {
            recentRecords.keySet().stream().findAny().ifPresent(recentRecords::remove);
        }
        recentRecords.put(sessionId + ":" + toolName + ":" + action, record);

        String truncatedDetail = detail != null && detail.length() > 100
            ? detail.substring(0, 100) + "..."
            : detail;
        // Persistent audit trail (file appender, survives restarts)
        auditLog.info(
            "session={} | tool={} | action={} | detail={}",
            sessionId,
            toolName,
            action,
            truncatedDetail
        );

        if (logToConsole) {
            logger.info(
                "[AUDIT] {} | session={} | tool={} | action={} | detail={}",
                record.timestamp(),
                sessionId,
                toolName,
                action,
                truncatedDetail
            );
        }
    }

    public Map<String, AuditRecord> getRecentRecords() {
        return recentRecords;
    }

    /**
     * PLAN-0307 T2.25: management-plane config export audit. Records actor,
     * time (logger timestamp), whether secrets were included and how many
     * connections were carried — never the response body or key material.
     */
    public void recordConfigExport(String actor, String layer, boolean includeSecrets, long connectionCount) {
        auditLog.info(
            "action=config_export | actor={} | layer={} | includeSecrets={} | connections={}",
            actor,
            layer,
            includeSecrets,
            connectionCount
        );
        if (logToConsole) {
            logger.info(
                "[AUDIT] action=config_export | actor={} | layer={} | includeSecrets={} | connections={}",
                actor,
                layer,
                includeSecrets,
                connectionCount
            );
        }
    }

    public record AuditRecord(
        String sessionId,
        String toolName,
        String action,
        String detail,
        Instant timestamp
    ) {}
}
