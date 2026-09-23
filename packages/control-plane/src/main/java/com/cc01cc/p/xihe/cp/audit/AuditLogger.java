package com.cc01cc.p.xihe.cp.audit;

import com.cc01cc.p.xihe.cp.entity.AuditLog;
import com.cc01cc.p.xihe.cp.repository.AuditLogRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * AuditLogger records all MCP tool calls and policy decisions.
 * Persists operational audit records to JSONL and durable change records to the
 * existing audit_logs table; also keeps a bounded in-memory recent-records view.
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
    private final AuditLogRepository auditLogRepository;

    @Autowired
    public AuditLogger(@Value("${cp.audit.log-to-console:true}") boolean logToConsole,
            AuditLogRepository auditLogRepository) {
        this.logToConsole = logToConsole;
        this.auditLogRepository = auditLogRepository;
    }

    AuditLogger(boolean logToConsole) {
        this(logToConsole, null);
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

    /** Persists sensitive state changes in the existing audit_logs stream. */
    public void recordDurableChange(String actorUserId, String workspaceId, String action,
            String resourceType, String resourceId, String detail) {
        if (auditLogRepository == null) {
            throw new IllegalStateException("Durable audit repository is not configured");
        }
        String safeDetail = sanitize(detail);
        AuditLog entry = new AuditLog(action, resourceType);
        entry.setUserId(actorUserId);
        entry.setWorkspaceId(workspaceId);
        entry.setResourceId(resourceId);
        entry.setDetails(safeDetail);
        auditLogRepository.save(entry);

        auditLog.info("action={} | actor={} | workspace={} | resourceType={} | resourceId={} | detail={}",
                action, actorUserId, workspaceId, resourceType, resourceId, safeDetail);
        if (logToConsole) {
            logger.info("[AUDIT] action={} | actor={} | workspace={} | resourceType={} | resourceId={} | detail={}",
                    action, actorUserId, workspaceId, resourceType, resourceId, safeDetail);
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
