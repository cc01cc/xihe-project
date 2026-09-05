package com.cc01cc.p.xihe.cp.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;

@Component
public class HealthMonitor {

    private static final Logger logger = LoggerFactory.getLogger(HealthMonitor.class);

    private final HttpClient httpClient;
    private final CircuitBreaker agentBreaker;
    private final CircuitBreaker runtimeBreaker;
    private final Map<String, ServiceHealth> healthCache = new ConcurrentHashMap<>();
    private final ObjectMapper objectMapper;
    private Consumer<String> onServiceRecovered = null;

    @Value("${cp.agent-url:http://localhost:12632/internal/v1/agent/chat}")
    private String agentUrl;

    @Value("${cp.runtime-url:http://localhost:12633/internal/v1/runtime/workspaces/default/mcp}")
    private String runtimeUrl;

    public HealthMonitor() {
        this.httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3))
            .build();
        this.objectMapper = new ObjectMapper();
        this.agentBreaker = new CircuitBreaker("agent", 3, Duration.ofSeconds(30));
        this.runtimeBreaker = new CircuitBreaker("runtime", 3, Duration.ofSeconds(30));
    }

    @Scheduled(fixedDelay = 10000, initialDelay = 5000)
    public void pollHealth() {
        pollService("agent", agentUrl.replaceAll("/internal/v1/agent/chat$", "") + "/internal/v1/agent/health", agentBreaker);
        pollService("runtime", runtimeUrl.replaceAll("/internal/v1/runtime/workspaces/.*", "") + "/health", runtimeBreaker);
    }

    private void pollService(String serviceName, String healthUrl, CircuitBreaker breaker) {
        ServiceHealth prev = healthCache.getOrDefault(serviceName, new ServiceHealth("unknown", 0, 0));
        String previousStatus = prev.status();
        HealthProbe probe = checkEndpoint(healthUrl);
        boolean alive = probe.alive();
        long responseMs = probe.responseMs();

        if (alive) {
            breaker.recordSuccess();
        } else {
            breaker.recordFailure();
        }

        String currentStatus = alive ? "up" : "down";
        int consecutiveFailures = breaker.failureCount();

        String llmReady = alive ? probe.llmReady() : prev.llmReady();
        String configRevision = alive ? probe.configRevision() : prev.configRevision();
        String verifiedAt = alive ? probe.verifiedAt() : prev.verifiedAt();
        ServiceHealth current = new ServiceHealth(
            currentStatus,
            consecutiveFailures,
            responseMs,
            probe.liveness(),
            llmReady,
            configRevision,
            verifiedAt
        );
        healthCache.put(serviceName, current);

        if (!previousStatus.equals(currentStatus)) {
            logger.info("[LIFECYCLE] service=cp event={}HealthChange from={} to={} liveness={} llmReady={} consecutiveFailures={}",
                capitalize(serviceName), previousStatus, currentStatus, current.liveness(), current.llmReady(), consecutiveFailures);
            if ("up".equals(currentStatus) && onServiceRecovered != null) {
                onServiceRecovered.accept(serviceName);
            }
        }
    }

    private HealthProbe checkEndpoint(String url) {
        long start = System.nanoTime();
        try {
            HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(3))
                .GET()
                .build();
            HttpResponse<String> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
            long responseMs = Duration.ofNanos(System.nanoTime() - start).toMillis();
            if (resp.statusCode() >= 400) {
                return new HealthProbe(false, responseMs, "down", "unknown", "", null);
            }
            return parseProbe(resp.body(), responseMs);
        } catch (Exception e) {
            logger.debug("Health check failed for {}: {}", url, e.getMessage());
            long responseMs = Duration.ofNanos(System.nanoTime() - start).toMillis();
            return new HealthProbe(false, responseMs, "down", "unknown", "", null);
        }
    }

    private HealthProbe parseProbe(String body, long responseMs) {
        try {
            JsonNode root = objectMapper.readTree(body);
            String liveness = text(root, "liveness", "up").toLowerCase();
            String llmReady = text(root, "llmReady", null);
            if (llmReady == null && root != null && root.has("llm")) {
                llmReady = text(root.get("llm"), "readiness", "unknown");
            }
            String revision = text(root, "configRevision", "");
            String verifiedAt = text(root, "verifiedAt", null);
            return new HealthProbe(true, responseMs, liveness, llmReady == null ? "unknown" : llmReady,
                revision, verifiedAt);
        } catch (Exception e) {
            logger.warn("Health response is not valid JSON: {}", e.getMessage());
            return new HealthProbe(true, responseMs, "up", "unknown", "", null);
        }
    }

    private String text(JsonNode node, String field, String fallback) {
        if (node == null || !node.hasNonNull(field)) {
            return fallback;
        }
        return node.get(field).asText(fallback);
    }

    public ServiceHealth getAgentHealth() {
        return healthCache.getOrDefault("agent", new ServiceHealth("unknown", 0, 0));
    }

    public ServiceHealth getRuntimeHealth() {
        return healthCache.getOrDefault("runtime", new ServiceHealth("unknown", 0, 0));
    }

    public String getAgentLlmReady() {
        return getAgentHealth().llmReady();
    }

    public boolean isAgentLlmReady() {
        return "ready".equals(getAgentLlmReady());
    }

    public CircuitBreaker getAgentBreaker() {
        return agentBreaker;
    }

    public CircuitBreaker getRuntimeBreaker() {
        return runtimeBreaker;
    }

    public void setOnServiceRecovered(Consumer<String> callback) {
        this.onServiceRecovered = callback;
    }

    private String capitalize(String s) {
        return s.substring(0, 1).toUpperCase() + s.substring(1);
    }

    private record HealthProbe(
        boolean alive,
        long responseMs,
        String liveness,
        String llmReady,
        String configRevision,
        String verifiedAt
    ) {}

    public record ServiceHealth(
        String status,
        int consecutiveFailures,
        long responseMs,
        String liveness,
        String llmReady,
        String configRevision,
        String verifiedAt
    ) {
        public ServiceHealth(String status, int consecutiveFailures, long responseMs) {
            this(status, consecutiveFailures, responseMs, status, "unknown", "", null);
        }
    }
}
