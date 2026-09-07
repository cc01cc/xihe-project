package com.cc01cc.p.xihe.cp.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.provider.ProviderCatalogService;
import com.cc01cc.p.xihe.cp.provider.ProviderConnectionService;
import com.cc01cc.p.xihe.cp.provider.ProviderCredentialLeaseService;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

@RestController
public class ModelsProxyController {

    private static final Logger logger = LoggerFactory.getLogger(ModelsProxyController.class);

    private final HttpClient httpClient;
    private final ObjectMapper objectMapper;
    private final ProviderConnectionService connectionService;
    private final ProviderCredentialLeaseService leaseService;
    private final ProviderCatalogService catalogService;

    @Value("${cp.agent-base-url:http://localhost:12632}")
    private String agentBaseUrl;

    @Value("${cp.agent-api-token:dev-token-not-secure}")
    private String agentApiToken;

    public ModelsProxyController(
            ObjectMapper objectMapper,
            ProviderConnectionService connectionService,
            ProviderCredentialLeaseService leaseService,
            ProviderCatalogService catalogService) {
        this.httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
        this.objectMapper = objectMapper;
        this.connectionService = connectionService;
        this.leaseService = leaseService;
        this.catalogService = catalogService;
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/api/v1/models")
    public ResponseEntity<?> listModels() {
        try {
            String targetUrl = agentBaseUrl + "/internal/v1/agent/models";
            List<Map<String, Object>> descriptors = scopedDescriptors();
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

    private List<Map<String, Object>> scopedDescriptors() {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || userId.isBlank()) return List.of();

        String catalogRunId = UUID.randomUUID().toString();
        List<Map<String, Object>> descriptors = new ArrayList<>();
        Set<String> seenProviders = new HashSet<>();
        for (ProviderConnection connection : connectionService.listVisibleEntities()) {
            if (!connection.isEnabled()
                    || !ProviderConnection.STATUS_READY.equals(connection.getStatus())
                    || !seenProviders.add(connection.getProviderId())) {
                continue;
            }
            ProviderCredentialLeaseService.IssuedLease lease = leaseService.issue(
                    userId, workspaceId, null, catalogRunId,
                    connection.getId().toString(), connection.getProviderId(), "*");
            Map<String, Object> descriptor = new LinkedHashMap<>();
            descriptor.put("lease", lease.token());
            descriptor.put("runId", catalogRunId);
            descriptor.put("connectionId", connection.getId());
            descriptor.put("providerId", connection.getProviderId());
            descriptor.put("scope", connection.getOwnerType());
            descriptor.put("connectionRevision", connection.getRevision());
            descriptor.put("displayName", catalogService.require(connection.getProviderId())
                    .path("displayName").asText(connection.getProviderId()));
            descriptors.add(descriptor);
        }
        return descriptors;
    }
}
