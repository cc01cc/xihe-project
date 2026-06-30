package com.cc01cc.p.xihe.cp.status;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;

@RestController
public class StatusController {

    private static final Logger logger = LoggerFactory.getLogger(StatusController.class);

    private final JdbcTemplate jdbcTemplate;
    private final HttpClient httpClient;
    private final ExecutorService executor = Executors.newFixedThreadPool(4);

    @Value("${cp.agent-url:http://agent:8000/chat}")
    private String agentUrl;

    @Value("${cp.runtime-url:http://runtime:8001/mcp}")
    private String runtimeUrl;

    @Autowired
    public StatusController(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
        this.httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3))
            .build();
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/status")
    public Map<String, Object> getStatus() {
        List<Future<Map<String, Object>>> futures = new ArrayList<>();

        futures.add(executor.submit(this::checkCp));
        futures.add(executor.submit(this::checkAgent));
        futures.add(executor.submit(this::checkRuntime));
        futures.add(executor.submit(this::checkPostgres));

        List<Map<String, Object>> services = new ArrayList<>();
        for (Future<Map<String, Object>> f : futures) {
            try {
                services.add(f.get(5, TimeUnit.SECONDS));
            } catch (Exception e) {
                Map<String, Object> err = new LinkedHashMap<>();
                err.put("name", "unknown");
                err.put("key", "unknown");
                err.put("status", "unreachable");
                err.put("error", e.getMessage() != null ? e.getMessage() : "Timeout");
                services.add(err);
            }
        }

        boolean allUp = services.stream()
            .allMatch(s -> "up".equals(s.get("status")));

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("status", allUp ? "healthy" : "degraded");
        result.put("timestamp", System.currentTimeMillis());
        result.put("services", services);
        return result;
    }

    private Map<String, Object> checkCp() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("name", "Control Plane");
        result.put("key", "cp");
        result.put("status", "up");
        result.put("responseMs", 0);
        result.put("port", 8080);
        return result;
    }

    private Map<String, Object> checkAgent() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("name", "Agent");
        result.put("key", "agent");
        String baseUrl = agentUrl.replaceAll("/chat$", "");
        try {
            long start = System.currentTimeMillis();
            HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + "/health"))
                .timeout(Duration.ofSeconds(3))
                .GET()
                .build();
            HttpResponse<String> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
            long elapsed = System.currentTimeMillis() - start;
            result.put("status", resp.statusCode() < 400 ? "up" : "down");
            result.put("responseMs", elapsed);
            result.put("url", baseUrl);
            if (resp.statusCode() < 400) {
                result.put("details", resp.body());
            }
        } catch (Exception e) {
            result.put("status", "down");
            result.put("error", e.getMessage() != null ? e.getMessage() : "Connection refused");
            result.put("url", baseUrl);
        }
        return result;
    }

    private Map<String, Object> checkRuntime() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("name", "Runtime");
        result.put("key", "runtime");
        String baseUrl = runtimeUrl.replaceAll("/mcp$", "");
        try {
            long start = System.currentTimeMillis();
            HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + "/health"))
                .timeout(Duration.ofSeconds(3))
                .GET()
                .build();
            HttpResponse<String> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
            long elapsed = System.currentTimeMillis() - start;
            result.put("status", resp.statusCode() < 400 ? "up" : "down");
            result.put("responseMs", elapsed);
            result.put("url", baseUrl);
        } catch (Exception e) {
            result.put("status", "down");
            result.put("error", e.getMessage() != null ? e.getMessage() : "Connection refused");
            result.put("url", baseUrl);
        }
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
            result.put("error", e.getMessage() != null ? e.getMessage() : "Connection refused");
        }
        return result;
    }
}
