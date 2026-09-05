package com.cc01cc.p.xihe.cp.telemetry;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.rolling.RollingFileAppender;
import ch.qos.logback.core.rolling.SizeAndTimeBasedRollingPolicy;
import ch.qos.logback.core.util.FileSize;
import com.cc01cc.p.xihe.cp.logging.RedactingLogstashEncoder;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/telemetry")
public class TelemetryController {

    private static final Logger telemetryLogger;
    private final String logDir;

    static {
        LoggerContext context = (LoggerContext) LoggerFactory.getILoggerFactory();
        telemetryLogger = context.getLogger("xihe.telemetry");
        telemetryLogger.setAdditive(false);

        RollingFileAppender<ILoggingEvent> appender = new RollingFileAppender<>();
        appender.setContext(context);
        appender.setName("TELEMETRY_FILE");
        appender.setFile(System.getProperty("XIHE_LOG_DIR", System.getenv().getOrDefault("XIHE_LOG_DIR", "logs")) + "/telemetry.log");

        SizeAndTimeBasedRollingPolicy<ILoggingEvent> policy = new SizeAndTimeBasedRollingPolicy<>();
        policy.setContext(context);
        policy.setParent(appender);
        policy.setFileNamePattern(System.getProperty("XIHE_LOG_DIR", System.getenv().getOrDefault("XIHE_LOG_DIR", "logs")) + "/telemetry.log.%d{yyyy-MM-dd}.%i.gz");
        policy.setMaxHistory(7);
        policy.setTotalSizeCap(FileSize.valueOf("500MB"));
        policy.setMaxFileSize(FileSize.valueOf("100MB"));
        policy.start();

        RedactingLogstashEncoder encoder = new RedactingLogstashEncoder();
        encoder.setContext(context);
        encoder.start();

        appender.setRollingPolicy(policy);
        appender.setEncoder(encoder);
        appender.start();
        telemetryLogger.addAppender(appender);
    }

    public TelemetryController(@Value("${XIHE_LOG_DIR:logs}") String logDir) {
        this.logDir = logDir;
    }

    @PostMapping("/logs")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<Map<String, String>> ingestAuth(@RequestBody TelemetryEntry.BatchRequest request) {
        writeEntries(request, "client");
        return ResponseEntity.ok(Map.of("status", "ok"));
    }

    private void writeEntries(TelemetryEntry.BatchRequest request, String source) {
        if (request.getEntries() == null || request.getEntries().isEmpty()) return;
        String deviceId = request.getDevice_id() != null ? request.getDevice_id() : "unknown";
        for (TelemetryEntry entry : request.getEntries()) {
            String msg = String.format(
                    "{\"timestamp\":%d,\"level\":\"%s\",\"source\":\"%s\",\"device_id\":\"%s\",\"message\":\"%s\"}",
                    entry.getTimestamp() > 0 ? entry.getTimestamp() : Instant.now().toEpochMilli(),
                    entry.getLevel() != null ? escapeJson(entry.getLevel()) : "info",
                    source,
                    escapeJson(deviceId),
                    entry.getMessage() != null ? escapeJson(entry.getMessage()) : ""
            );
            telemetryLogger.info(msg);
        }
    }

    private static String escapeJson(String value) {
        return value.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\t", "\\t");
    }
}
