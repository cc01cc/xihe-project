package com.cc01cc.p.xihe.cp.status;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import org.springframework.jdbc.core.JdbcTemplate;

import java.util.*;
import java.util.concurrent.*;

@RestController
public class StatusController {

    private static final Logger logger = LoggerFactory.getLogger(StatusController.class);

    private final JdbcTemplate jdbcTemplate;
    private final HealthMonitor healthMonitor;

    @Autowired
    public StatusController(JdbcTemplate jdbcTemplate, HealthMonitor healthMonitor) {
        this.jdbcTemplate = jdbcTemplate;
        this.healthMonitor = healthMonitor;
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/api/v1/status")
    public Map<String, Object> getStatus() {
        List<Map<String, Object>> services = new ArrayList<>();

        // CP (self)
        Map<String, Object> cpResult = new LinkedHashMap<>();
        cpResult.put("name", "Control Plane");
        cpResult.put("key", "cp");
        cpResult.put("status", "up");
        cpResult.put("responseMs", 0);
        services.add(cpResult);

        // Agent (from HealthMonitor cache)
        HealthMonitor.ServiceHealth agentHealth = healthMonitor.getAgentHealth();
        Map<String, Object> agentResult = new LinkedHashMap<>();
        agentResult.put("name", "Agent");
        agentResult.put("key", "agent");
        agentResult.put("status", agentHealth.status());
        agentResult.put("consecutiveFailures", agentHealth.consecutiveFailures());
        agentResult.put("circuitBreaker", healthMonitor.getAgentBreaker().getState().name());
        services.add(agentResult);

        // Runtime (from HealthMonitor cache)
        HealthMonitor.ServiceHealth runtimeHealth = healthMonitor.getRuntimeHealth();
        Map<String, Object> runtimeResult = new LinkedHashMap<>();
        runtimeResult.put("name", "Runtime");
        runtimeResult.put("key", "runtime");
        runtimeResult.put("status", runtimeHealth.status());
        runtimeResult.put("consecutiveFailures", runtimeHealth.consecutiveFailures());
        runtimeResult.put("circuitBreaker", healthMonitor.getRuntimeBreaker().getState().name());
        services.add(runtimeResult);

        // PostgreSQL
        services.add(checkPostgres());

        boolean allUp = services.stream()
            .allMatch(s -> "up".equals(s.get("status")));

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("status", allUp ? "healthy" : "degraded");
        result.put("timestamp", System.currentTimeMillis());
        result.put("services", services);
        return result;
    }

    private Map<String, Object> checkPostgres() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("name", "PostgreSQL");
        result.put("key", "postgres");
        try {
            long start = System.currentTimeMillis();
            jdbcTemplate.queryForObject("SELECT 1", Integer.class);
            long elapsed = System.currentTimeMillis() - start;
            result.put("status", "up");
            result.put("responseMs", elapsed);

            Map<String, Object> dbInfo = jdbcTemplate.queryForMap(
                "SELECT version() AS ver, current_database() AS db, " +
                "pg_size_pretty(pg_database_size(current_database())) AS sz");
            result.put("version", dbInfo.getOrDefault("ver", "unknown"));
            result.put("database", dbInfo.getOrDefault("db", "unknown"));
            result.put("size", dbInfo.getOrDefault("sz", "unknown"));

            Long connCount = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()",
                Long.class);
            result.put("connections", connCount != null ? connCount : 0);
        } catch (Exception e) {
            result.put("status", "down");
            result.put("errorCode", "DATABASE_UNAVAILABLE");
        }
        return result;
    }
}
