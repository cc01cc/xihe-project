package com.cc01cc.p.xihe.cp.status;

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
    private Consumer<String> onServiceRecovered = null;

    @Value("${cp.agent-url:http://localhost:12632/internal/v1/agent/chat}")
    private String agentUrl;

    @Value("${cp.runtime-url:http://localhost:12633/internal/v1/runtime/workspaces/default/mcp}")
    private String runtimeUrl;

    public HealthMonitor() {
        this.httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3))
            .build();
        this.agentBreaker = new CircuitBreaker("agent", 3, Duration.ofSeconds(30));
        this.runtimeBreaker = new CircuitBreaker("runtime", 3, Duration.ofSeconds(30));
    }

    @Scheduled(fixedDelay = 10000, initialDelay = 5000)
    public void pollHealth() {
        pollService("agent", agentUrl.replaceAll("/internal/v1/agent/chat$", "") + "/internal/v1/agent/health", agentBreaker);
        pollService("runtime", runtimeUrl.replaceAll("/internal/v1/runtime/workspaces/.*", "") + "/health", runtimeBreaker);
    }

    private void pollService(String serviceName, String healthUrl, CircuitBreaker breaker) {
        String previousStatus = healthCache.getOrDefault(serviceName, new ServiceHealth("unknown", 0, 0)).status();
        boolean alive = checkEndpoint(healthUrl);
        long responseMs = alive ? 1 : 0;

        if (alive) {
            breaker.recordSuccess();
        } else {
            breaker.recordFailure();
        }

        String currentStatus = alive ? "up" : "down";
        int consecutiveFailures = breaker.failureCount();

        ServiceHealth prev = healthCache.getOrDefault(serviceName, new ServiceHealth("unknown", 0, 0));
        ServiceHealth current = new ServiceHealth(currentStatus, consecutiveFailures, responseMs);
        healthCache.put(serviceName, current);

        if (!previousStatus.equals(currentStatus)) {
            logger.info("[LIFECYCLE] service=cp event={}HealthChange from={} to={} consecutiveFailures={}",
                capitalize(serviceName), previousStatus, currentStatus, consecutiveFailures);
            if ("up".equals(currentStatus) && onServiceRecovered != null) {
                onServiceRecovered.accept(serviceName);
            }
        }
    }

    private boolean checkEndpoint(String url) {
        try {
            HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(3))
                .GET()
                .build();
            HttpResponse<String> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
            return resp.statusCode() < 400;
        } catch (Exception e) {
            logger.debug("Health check failed for {}: {}", url, e.getMessage());
            return false;
        }
    }

    public ServiceHealth getAgentHealth() {
        return healthCache.getOrDefault("agent", new ServiceHealth("unknown", 0, 0));
    }

    public ServiceHealth getRuntimeHealth() {
        return healthCache.getOrDefault("runtime", new ServiceHealth("unknown", 0, 0));
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

    public record ServiceHealth(String status, int consecutiveFailures, long responseMs) {}
}
