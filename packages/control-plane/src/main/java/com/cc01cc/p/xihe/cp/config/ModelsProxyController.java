package com.cc01cc.p.xihe.cp.config;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.cc01cc.p.xihe.cp.provider.ProviderModelDescriptorService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.List;

@RestController
public class ModelsProxyController {

    private static final Logger logger = LoggerFactory.getLogger(ModelsProxyController.class);

    /** PLAN-0557/BL-109: stable dependency code for the model catalog proxy. */
    private static final String AGENT_UNAVAILABLE_CODE = "AGENT_UNAVAILABLE";
    private static final String AGENT_DEPENDENCY = "agent";

    private final HttpClient httpClient;
    private final ObjectMapper objectMapper;
    // PLAN-0470: descriptor assembly (connections + leases + display names) is
    // a provider use case; this adapter only proxies HTTP to the Agent.
    private final ProviderModelDescriptorService descriptorService;

    @Value("${cp.agent-base-url:http://localhost:12632}")
    private String agentBaseUrl;

    @Value("${cp.agent-api-token:dev-token-not-secure}")
    private String agentApiToken;

    public ModelsProxyController(
            ObjectMapper objectMapper,
            ProviderModelDescriptorService descriptorService) {
        this.httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
        this.objectMapper = objectMapper;
        this.descriptorService = descriptorService;
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/api/v1/models")
    public ResponseEntity<?> listModels() {
        // PLAN-0557: descriptor assembly failures are local CP problems, not Agent outages.
        List<Map<String, Object>> descriptors = descriptorService.scopedModelDescriptors(
                TenantContext.getUserId(), TenantContext.getWorkspaceId());
        String requestBody = null;
        if (!descriptors.isEmpty()) {
            try {
                requestBody = objectMapper.writeValueAsString(Map.of("connections", descriptors));
            } catch (JsonProcessingException e) {
                logger.error("Models proxy request serialization failed", e);
                return ProblemDetailsHandler.problemResponse(HttpStatus.INTERNAL_SERVER_ERROR,
                        "INTERNAL_ERROR", "Request serialization failed");
            }
        }

        try {
            String targetUrl = agentBaseUrl + "/internal/v1/agent/models";
            HttpRequest.Builder requestBuilder = HttpRequest.newBuilder(URI.create(targetUrl))
                .header(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
                .header("Authorization", "Bearer " + agentApiToken)
                .timeout(Duration.ofSeconds(30));
            if (requestBody == null) {
                requestBuilder.GET();
            } else {
                requestBuilder.header(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
                    .POST(HttpRequest.BodyPublishers.ofString(requestBody));
            }

            HttpResponse<String> response = httpClient.send(
                requestBuilder.build(), HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() >= 400) {
                ResponseEntity<Map<String, Object>> failure = classifyUpstreamStatus(response.statusCode());
                logger.error("Models proxy: Agent returned status={} dependency={} reason={}",
                        response.statusCode(), AGENT_DEPENDENCY, failure.getBody().get("reason"));
                return failure;
            }

            Object body = objectMapper.readValue(response.body(), Object.class);
            return ResponseEntity.ok(body);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            logger.error("Models proxy interrupted", e);
            return dependencyProblem("unreachable", true);
        } catch (HttpTimeoutException e) {
            logger.error("Models proxy timed out", e);
            return dependencyProblem("timeout", true);
        } catch (JsonProcessingException e) {
            // The Agent answered, but not with a JSON body we can consume.
            logger.error("Models proxy response body is not JSON", e);
            return dependencyProblem("upstream_error", true);
        } catch (IOException e) {
            logger.error("Models proxy transport failed: {}", e.getClass().getSimpleName(), e);
            return dependencyProblem("unreachable", true);
        }
    }

    private static ResponseEntity<Map<String, Object>> classifyUpstreamStatus(int status) {
        if (status == 401 || status == 403) {
            return dependencyProblem("auth_failed", false);
        }
        if (status == 408 || status == 504) {
            return dependencyProblem("timeout", true);
        }
        return dependencyProblem("upstream_error", status >= 500);
    }

    private static ResponseEntity<Map<String, Object>> dependencyProblem(String reason, boolean retryable) {
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("dependency", AGENT_DEPENDENCY);
        extra.put("reason", reason);
        extra.put("retryable", retryable);
        return ProblemDetailsHandler.problemResponse(
                HttpStatus.SERVICE_UNAVAILABLE, AGENT_UNAVAILABLE_CODE, dependencyDetail(reason), extra);
    }

    private static String dependencyDetail(String reason) {
        return switch (reason) {
            case "timeout" -> "Agent service did not respond in time; retry shortly";
            case "auth_failed" -> "Internal service credential was rejected by the agent; contact the administrator";
            default -> "Agent service is unavailable; retry after the service starts";
        };
    }
}
