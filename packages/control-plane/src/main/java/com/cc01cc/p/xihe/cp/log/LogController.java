package com.cc01cc.p.xihe.cp.log;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
public class LogController {

    private static final Logger logger = LoggerFactory.getLogger("xihe.ui");

    @PostMapping("/api/v1/logs")
    public ResponseEntity<Map<String, String>> ingest(@RequestBody LogEntry.BatchRequest request) {
        if (request.getEntries() == null || request.getEntries().isEmpty()) {
            return ResponseEntity.ok(Map.of("status", "ok"));
        }
        for (LogEntry entry : request.getEntries()) {
            String level = entry.getLevel() != null ? entry.getLevel().toLowerCase() : "info";
            String msg = "[UI] " + (entry.getMessage() != null ? entry.getMessage() : "");
            switch (level) {
                case "debug" -> logger.debug(msg);
                case "warn"  -> logger.warn(msg);
                case "error" -> logger.error(msg);
                default      -> logger.info(msg);
            }
        }
        return ResponseEntity.ok(Map.of("status", "ok"));
    }
}
