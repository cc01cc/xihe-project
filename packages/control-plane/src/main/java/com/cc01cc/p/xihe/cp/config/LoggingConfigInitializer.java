package com.cc01cc.p.xihe.cp.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.boot.logging.LogLevel;
import org.springframework.boot.logging.LoggingSystem;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

@Component
public class LoggingConfigInitializer {

    private static final Logger log = LoggerFactory.getLogger(LoggingConfigInitializer.class);

    private final ConfigService configService;

    public LoggingConfigInitializer(ConfigService configService) {
        this.configService = configService;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void onReady() {
        applyConfiguredLevels();
    }

    /** PLAN-0307 T2.15: re-apply levels after a logging config write (hot reload). */
    @EventListener(LoggingConfigChangedEvent.class)
    public void onConfigChanged(LoggingConfigChangedEvent event) {
        try {
            applyConfiguredLevels();
            log.info("Log level re-applied after config change source={}", event.source());
        } catch (RuntimeException e) {
            // A log-level apply failure must never roll back the config write.
            log.warn("Failed to re-apply log levels after config change: {}", e.getMessage(), e);
        }
    }

    private void applyConfiguredLevels() {
        LoggingSystem loggingSystem = LoggingSystem.get(getClass().getClassLoader());

        // Legacy generic key first; the specific `levelCp` wins when both exist.
        String logLevel = configService.resolve("logging", "logLevel", null, null);
        if (logLevel != null && !logLevel.isEmpty()) {
            LogLevel parsed = parseLogLevel(logLevel);
            if (parsed != null) {
                loggingSystem.setLogLevel("com.cc01cc.p.xihe.cp", parsed);
                log.info("Log level set from ConfigService: logLevel={}", parsed);
            }
        }

        String levelCp = configService.resolve("logging", "levelCp", null, null);
        if (levelCp != null && !levelCp.isEmpty()) {
            LogLevel parsedCp = parseLogLevel(levelCp);
            if (parsedCp != null) {
                loggingSystem.setLogLevel("com.cc01cc.p.xihe.cp", parsedCp);
                log.info("Log level set from ConfigService: levelCp={}", parsedCp);
            }
        }
    }

    private static LogLevel parseLogLevel(String value) {
        return switch (value.toUpperCase()) {
            case "TRACE" -> LogLevel.TRACE;
            case "DEBUG" -> LogLevel.DEBUG;
            case "INFO"  -> LogLevel.INFO;
            case "WARN"  -> LogLevel.WARN;
            case "ERROR" -> LogLevel.ERROR;
            default -> null;
        };
    }
}
