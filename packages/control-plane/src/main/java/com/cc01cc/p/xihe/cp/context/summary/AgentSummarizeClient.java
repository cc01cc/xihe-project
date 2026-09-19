package com.cc01cc.p.xihe.cp.context.summary;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;

/**
 * PLAN-0354 spec §8: CP → Agent summarize hop. The Agent is the only LLM holder
 * (PLAN-0341 boundary); this client carries the CP-issued short lease and an
 * explicit request timeout.
 *
 * <p>Transport failures are surfaced as {@link AgentSummarizeException} with a
 * coarse reason so the caller can map them onto the frozen {@code
 * fallbackReason} enum (timeout | agent_error). Request/response bodies are
 * never logged.
 */
@Component
public class AgentSummarizeClient {

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(2))
            .build();
    private final ObjectMapper objectMapper;

    @Value("${cp.agent-base-url:http://localhost:12632}")
    private String agentBaseUrl;

    @Value("${cp.agent-api-token:dev-token-not-secure}")
    private String agentApiToken;

    public AgentSummarizeClient(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    /** 200 response payload: the sectioned summary plus 0343-shaped usage. */
    public record Result(String summary, Map<String, Object> usage) {
    }

    /** reason = "timeout" | "agent_error" (spec §5 enum). */
    public static class AgentSummarizeException extends RuntimeException {
        private final String reason;

        public AgentSummarizeException(String reason, String message) {
            super(message);
            this.reason = reason;
        }

        public String reason() {
            return reason;
        }
    }

    public Result summarize(Map<String, Object> payload, long timeoutMs) {
        String url = stripTrailingSlash(agentBaseUrl) + "/internal/v1/agent/summarize";
        HttpRequest httpRequest;
        try {
            httpRequest = HttpRequest.newBuilder(URI.create(url))
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .header("Authorization", "Bearer " + agentApiToken)
                    .timeout(Duration.ofMillis(timeoutMs))
                    .POST(HttpRequest.BodyPublishers.ofString(
                            objectMapper.writeValueAsString(payload), StandardCharsets.UTF_8))
                    .build();
        } catch (Exception e) {
            throw new AgentSummarizeException("agent_error", "summarize request could not be built");
        }
        HttpResponse<String> response;
        try {
            response = httpClient.send(httpRequest, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (HttpTimeoutException e) {
            throw new AgentSummarizeException("timeout", "summarize request timed out after " + timeoutMs + "ms");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AgentSummarizeException("agent_error", "summarize request interrupted");
        } catch (IOException e) {
            throw new AgentSummarizeException("agent_error", "summarize transport failed: " + e.getClass().getSimpleName());
        }
        if (response.statusCode() >= 400) {
            throw new AgentSummarizeException("agent_error", "summarize upstream status " + response.statusCode());
        }
        try {
            JsonNode body = objectMapper.readTree(response.body());
            String summary = body.path("summary").asText("");
            Map<String, Object> usage = null;
            if (body.has("usage") && body.get("usage").isObject()) {
                usage = objectMapper.convertValue(body.get("usage"), new TypeReference<Map<String, Object>>() {});
            }
            return new Result(summary, usage);
        } catch (Exception e) {
            throw new AgentSummarizeException("agent_error", "summarize response was not parseable");
        }
    }

    private static String stripTrailingSlash(String value) {
        String v = value == null ? "" : value.trim();
        while (v.endsWith("/")) {
            v = v.substring(0, v.length() - 1);
        }
        return v;
    }
}
