package com.cc01cc.p.xihe.cp.config;

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

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.List;

@RestController
public class ModelsProxyController {

    private static final Logger logger = LoggerFactory.getLogger(ModelsProxyController.class);

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
        try {
            String targetUrl = agentBaseUrl + "/internal/v1/agent/models";
            List<Map<String, Object>> descriptors = descriptorService.scopedModelDescriptors(
                    TenantContext.getUserId(), TenantContext.getWorkspaceId());
            HttpRequest.Builder requestBuilder = HttpRequest.newBuilder(URI.create(targetUrl))
                .header(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
                .header("Authorization", "Bearer " + agentApiToken)
                .timeout(Duration.ofSeconds(30));
            if (descriptors.isEmpty()) {
                requestBuilder.GET();
            } else {
                requestBuilder.header(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
                    .POST(HttpRequest.BodyPublishers.ofString(
                            objectMapper.writeValueAsString(Map.of("connections", descriptors))));
            }
            HttpRequest request = requestBuilder.build();

            HttpResponse<String> response = httpClient.send(
                request, HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() >= 400) {
                logger.error("Models proxy: Agent returned {}", response.statusCode());
                return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_GATEWAY, "AGENT_UNAVAILABLE", "Agent model service unavailable");
            }

            Object body = objectMapper.readValue(response.body(), Object.class);
            return ResponseEntity.ok(body);
        } catch (Exception e) {
            logger.error("Models proxy failed", e);
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_GATEWAY, "AGENT_UNAVAILABLE", "Agent model service unavailable");
        }
    }
}
