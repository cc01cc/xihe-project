package com.cc01cc.p.xihe.cp.telemetry;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.rolling.RollingFileAppender;
import ch.qos.logback.core.rolling.SizeAndTimeBasedRollingPolicy;
import ch.qos.logback.core.util.FileSize;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.logging.RedactingLogstashEncoder;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Client telemetry ingress (PLAN-0522). The batch is validated, then written to
 * the local {@code {XIHE_LOG_DIR}/telemetry.log} sink; entries carrying an
 * explicit structured {@code eventId}/{@code eventType} are additionally
 * best-effort relayed to the shared TLM service when the instance
 * {@code logging.centralTelemetryEnabled} gate and the deployment
 * XIHE_TLM_URL/XIHE_TLM_INGEST_TOKEN are configured. {@code 200 {"status":"ok"}}
 * only acknowledges the local sink — never the central relay.
 */
@RestController
@RequestMapping("/api/v1/telemetry")
public class TelemetryController {

    static final int MAX_ENTRIES_PER_BATCH = 100;
    static final int MAX_MESSAGE_LENGTH = 8192;
    static final int MAX_EVENT_TYPE_LENGTH = 64;
    static final int MAX_EVENT_ID_LENGTH = 64;
    static final int MAX_ERROR_CODE_LENGTH = 128;
    static final int MAX_DIMENSION_LENGTH = 64;
    static final int MAX_LANG_LENGTH = 16;
    static final int MAX_BATCH_ID_LENGTH = 64;
    static final int MAX_DEVICE_ID_LENGTH = 64;
    static final String DEFAULT_DEVICE_ID = "unknown";
    private static final Set<String> LEVELS = Set.of("debug", "info", "warn", "error");
    private static final Set<String> RELEASE_CHANNELS = Set.of("stable", "beta", "dev");
    private static final Set<String> OS_FAMILIES =
            Set.of("windows", "macos", "linux", "ios", "android", "other");
    private static final Set<String> BROWSER_FAMILIES =
            Set.of("chrome", "edge", "firefox", "safari", "other");
    private static final Set<String> SCREEN_BUCKETS = Set.of("xs", "sm", "md", "lg", "xl");
    private static final Pattern EVENT_TYPE_PATTERN =
            Pattern.compile("^[a-z][a-z0-9_]*(\\.[a-z0-9_]+)+$");

    private static final Logger telemetryLogger;

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

    private final TelemetryRelayService telemetryRelay;
    private final ObjectMapper objectMapper;

    public TelemetryController(@Value("${XIHE_LOG_DIR:logs}") String logDir,
                               TelemetryRelayService telemetryRelay,
                               ObjectMapper objectMapper) {
        this.telemetryRelay = telemetryRelay;
        this.objectMapper = objectMapper;
    }

    @PostMapping("/logs")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> ingestAuth(@RequestBody TelemetryEntry.BatchRequest request) {
        ResponseEntity<?> invalid = validate(request);
        if (invalid != null) {
            return invalid;
        }
        writeEntries(request, "client");
        if (request.getEntries() != null && !request.getEntries().isEmpty()) {
            telemetryRelay.forward(request.getBatchId(), request.getEntries());
        }
        return ResponseEntity.ok(Map.of("status", "ok"));
    }

    /**
     * Server-side caps before any write/relay. An empty batch stays an accepted
     * no-op (unchanged legacy contract); violations fail the whole batch with a
     * Problem Details body and write nothing.
     */
    ResponseEntity<?> validate(TelemetryEntry.BatchRequest request) {
        if (request == null || request.getEntries() == null || request.getEntries().isEmpty()) {
            return null;
        }
        if (request.getBatchId() != null && request.getBatchId().length() > MAX_BATCH_ID_LENGTH) {
            return invalid("batchId is too long");
        }
        if (request.getDeviceId() != null && request.getDeviceId().length() > MAX_DEVICE_ID_LENGTH) {
            return invalid("deviceId is too long");
        }
        List<TelemetryEntry> entries = request.getEntries();
        if (entries.size() > MAX_ENTRIES_PER_BATCH) {
            return invalid("too many entries");
        }
        for (int i = 0; i < entries.size(); i++) {
            TelemetryEntry entry = entries.get(i);
            if (entry == null) {
                return invalid("entries[" + i + "] is required");
            }
            if (entry.getLevel() != null && !LEVELS.contains(entry.getLevel())) {
                return invalid("entries[" + i + "].level is invalid");
            }
            if (entry.getMessage() != null && entry.getMessage().length() > MAX_MESSAGE_LENGTH) {
                return invalid("entries[" + i + "].message is too long");
            }
            if (entry.getEventId() != null && entry.getEventId().length() > MAX_EVENT_ID_LENGTH) {
                return invalid("entries[" + i + "].eventId is too long");
            }
            if (entry.getEventType() != null
                    && (entry.getEventType().length() > MAX_EVENT_TYPE_LENGTH
                        || !EVENT_TYPE_PATTERN.matcher(entry.getEventType()).matches())) {
                return invalid("entries[" + i + "].eventType is invalid");
            }
            if (entry.getErrorCode() != null && entry.getErrorCode().length() > MAX_ERROR_CODE_LENGTH) {
                return invalid("entries[" + i + "].errorCode is too long");
            }
            if (tooLong(entry.getServiceVersion(), MAX_DIMENSION_LENGTH)) {
                return invalid("entries[" + i + "].serviceVersion is too long");
            }
            if (entry.getReleaseChannel() != null
                    && !RELEASE_CHANNELS.contains(entry.getReleaseChannel())) {
                return invalid("entries[" + i + "].releaseChannel is invalid");
            }
            if (entry.getOsFamily() != null && !OS_FAMILIES.contains(entry.getOsFamily())) {
                return invalid("entries[" + i + "].osFamily is invalid");
            }
            if (entry.getBrowserFamily() != null
                    && !BROWSER_FAMILIES.contains(entry.getBrowserFamily())) {
                return invalid("entries[" + i + "].browserFamily is invalid");
            }
            if (tooLong(entry.getLang(), MAX_LANG_LENGTH)) {
                return invalid("entries[" + i + "].lang is too long");
            }
            if (entry.getScreenBucket() != null
                    && !SCREEN_BUCKETS.contains(entry.getScreenBucket())) {
                return invalid("entries[" + i + "].screenBucket is invalid");
            }
            if (tooLong(entry.getAnonSessionId(), MAX_DIMENSION_LENGTH)) {
                return invalid("entries[" + i + "].anonSessionId is too long");
            }
        }
        return null;
    }

    private static boolean tooLong(String value, int max) {
        return value != null && value.length() > max;
    }

    private static ResponseEntity<?> invalid(String detail) {
        return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", detail);
    }

    private void writeEntries(TelemetryEntry.BatchRequest request, String source) {
        if (request.getEntries() == null || request.getEntries().isEmpty()) {
            return;
        }
        String deviceId = request.getDeviceId() != null ? request.getDeviceId() : DEFAULT_DEVICE_ID;
        for (TelemetryEntry entry : request.getEntries()) {
            Map<String, Object> record = new LinkedHashMap<>();
            record.put("timestamp", entry.getTimestamp() > 0 ? entry.getTimestamp() : Instant.now().toEpochMilli());
            record.put("level", entry.getLevel() != null ? entry.getLevel() : "info");
            record.put("source", source);
            record.put("deviceId", deviceId);
            record.put("message", entry.getMessage() != null ? entry.getMessage() : "");
            if (entry.getEventId() != null) {
                record.put("eventId", entry.getEventId());
            }
            if (entry.getEventType() != null) {
                record.put("eventType", entry.getEventType());
            }
            if (entry.getErrorCode() != null) {
                record.put("errorCode", entry.getErrorCode());
            }
            if (entry.getServiceVersion() != null) {
                record.put("serviceVersion", entry.getServiceVersion());
            }
            if (entry.getReleaseChannel() != null) {
                record.put("releaseChannel", entry.getReleaseChannel());
            }
            if (entry.getOsFamily() != null) {
                record.put("osFamily", entry.getOsFamily());
            }
            if (entry.getBrowserFamily() != null) {
                record.put("browserFamily", entry.getBrowserFamily());
            }
            if (entry.getLang() != null) {
                record.put("lang", entry.getLang());
            }
            if (entry.getScreenBucket() != null) {
                record.put("screenBucket", entry.getScreenBucket());
            }
            if (entry.getAnonSessionId() != null) {
                record.put("anonSessionId", entry.getAnonSessionId());
            }
            try {
                telemetryLogger.info(objectMapper.writeValueAsString(record));
            } catch (JsonProcessingException e) {
                telemetryLogger.warn("telemetry entry serialization failed");
            }
        }
    }
}
