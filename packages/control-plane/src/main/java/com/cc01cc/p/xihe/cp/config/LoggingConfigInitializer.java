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
        String levelCp = configService.resolve("logging", "levelCp", null, null);
        if (levelCp != null && !levelCp.isEmpty()) {
            LogLevel logLevel = parseLogLevel(levelCp);
            if (logLevel != null) {
                LoggingSystem loggingSystem = LoggingSystem.get(getClass().getClassLoader());
                loggingSystem.setLogLevel("com.cc01cc.p.xihe.cp", logLevel);
                log.info("Log level set from ConfigService: levelCp={}", logLevel);
            }
        }

        String logLevel = configService.resolve("logging", "logLevel", null, null);
        if (logLevel != null && !logLevel.isEmpty()) {
            LogLevel parsed = parseLogLevel(logLevel);
            if (parsed != null) {
                LoggingSystem loggingSystem = LoggingSystem.get(getClass().getClassLoader());
                loggingSystem.setLogLevel("com.cc01cc.p.xihe.cp", parsed);
                log.info("Log level set from ConfigService: logLevel={}", parsed);
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
