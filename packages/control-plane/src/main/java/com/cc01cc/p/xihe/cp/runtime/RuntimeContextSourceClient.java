package com.cc01cc.p.xihe.cp.runtime;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

import java.util.Map;
import java.util.Optional;

/** Fetches a workspace's AGENTS.md from the Runtime so CP no longer reads the host filesystem. */
@Component
public class RuntimeContextSourceClient {

    private static final Logger logger = LoggerFactory.getLogger(RuntimeContextSourceClient.class);

    private final RestTemplate restTemplate;
    private final String runtimeUrl;
    private final String serviceToken;

    public RuntimeContextSourceClient(RestTemplate restTemplate,
                                      @Value("${cp.mcp.runtime-url:http://localhost:12633}") String runtimeUrl,
                                      @Value("${cp.agent-api-token:dev-token-not-secure}") String serviceToken) {
        this.restTemplate = restTemplate;
        this.runtimeUrl = runtimeUrl;
        this.serviceToken = serviceToken;
    }

    public Optional<String> readAgents(String workspaceId) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            headers.setBearerAuth(serviceToken);
            Map<String, Object> body = Map.of("path", "AGENTS.md");
            var response = restTemplate.exchange(
                    runtimeUrl + "/internal/v1/runtime/workspaces/" + workspaceId + "/files/read",
                    org.springframework.http.HttpMethod.POST,
                    new HttpEntity<>(body, headers),
                    new org.springframework.core.ParameterizedTypeReference<Map<String, Object>>() { });
            if (!response.getStatusCode().is2xxSuccessful() || response.getBody() == null) {
                return Optional.empty();
            }
            Object content = response.getBody().get("content");
            return content == null ? Optional.empty() : Optional.of(content.toString());
        } catch (Exception e) {
            logger.warn("Runtime AGENTS.md read failed workspaceId={}: {}", workspaceId, e.getMessage());
            return Optional.empty();
        }
    }
}
