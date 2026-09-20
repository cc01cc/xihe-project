package com.cc01cc.p.xihe.cp.audit;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

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
    private static final Pattern BEARER = Pattern.compile("(?i)(Bearer\\s+)[^\\s,;]+");
    private static final Pattern SENSITIVE_ASSIGNMENT = Pattern.compile(
        "(?i)(authorization|cookie|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|password|arguments?|raw[_-]?arguments?)"
            + "(\\s*[:=]\\s*)(\\\"(?:\\\\.|[^\\\"])*\\\"|'(?:\\\\.|[^'])*'|\\{[^{}]*\\}|\\[[^\\[\\]]*\\]|[^\\s,;}]+)"
    );

    private final Map<String, AuditRecord> recentRecords = new ConcurrentHashMap<>();
    private final boolean logToConsole;

    public AuditLogger(@Value("${cp.audit.log-to-console:true}") boolean logToConsole) {
        this.logToConsole = logToConsole;
    }

    public void record(String sessionId, String toolName, String action, String detail) {
        String safeDetail = sanitize(detail);
        AuditRecord record = new AuditRecord(
            sessionId,
            toolName,
            action,
            safeDetail,
            Instant.now()
        );
        if (recentRecords.size() >= MAX_RECENT_RECORDS) {
            recentRecords.keySet().stream().findAny().ifPresent(recentRecords::remove);
        }
        recentRecords.put(sessionId + ":" + toolName + ":" + action, record);

        String truncatedDetail = safeDetail != null && safeDetail.length() > 100
            ? safeDetail.substring(0, 100) + "..."
            : safeDetail;
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

    /** Redacts credentials and raw request material before memory or log serialization. */
    static String sanitize(String detail) {
        if (detail == null) {
            return null;
        }
        String bearerSafe = BEARER.matcher(detail).replaceAll("$1***redacted***");
        return SENSITIVE_ASSIGNMENT.matcher(bearerSafe).replaceAll("$1$2***redacted***");
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
