package com.cc01cc.p.xihe.cp.runtime;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.cc01cc.p.xihe.cp.entity.WorkspaceImport;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

@Component
public class RuntimeWorkspaceImportClient {
    private static final Logger logger = LoggerFactory.getLogger(RuntimeWorkspaceImportClient.class);

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;
    private final String runtimeUrl;
    private final String serviceToken;

    public RuntimeWorkspaceImportClient(
            RestTemplate restTemplate,
            ObjectMapper objectMapper,
            @Value("${cp.mcp.runtime-url:http://localhost:12633}") String runtimeUrl,
            @Value("${cp.agent-api-token:dev-token-not-secure}") String serviceToken) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
        this.runtimeUrl = runtimeUrl;
        this.serviceToken = serviceToken;
    }

    public Optional<Map<String, Object>> start(WorkspaceImport record) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("sourcePath", record.getSourcePath());
        try {
            body.put("excludeRules", objectMapper.readValue(
                    record.getExcludeRules(), new TypeReference<java.util.List<String>>() { }));
        } catch (Exception error) {
            logger.warn("Invalid import exclude rules importId={} reason={}", record.getId(), error.getMessage());
            body.put("excludeRules", java.util.List.of());
        }
        return post("/internal/v1/runtime/workspaces/" + record.getWorkspaceId() + "/imports", body);
    }

    public Optional<Map<String, Object>> status(String workspaceId, String importId) {
        try {
            HttpHeaders headers = headers();
            return Optional.ofNullable(restTemplate.exchange(
                    runtimeUrl + "/internal/v1/runtime/workspaces/" + workspaceId + "/imports/" + importId,
                    org.springframework.http.HttpMethod.GET,
                    new HttpEntity<>(headers),
                    new ParameterizedTypeReference<Map<String, Object>>() { }).getBody());
        } catch (Exception error) {
            logger.warn("Runtime import status unavailable workspaceId={} importId={} reason={}", workspaceId, importId, error.getMessage());
            return Optional.empty();
        }
    }

    public Optional<Map<String, Object>> cancel(String workspaceId, String importId) {
        return post("/internal/v1/runtime/workspaces/" + workspaceId + "/imports/" + importId + "/cancel", Map.of());
    }

    public Optional<Map<String, Object>> listSourceDirectory(String path) {
        return post("/internal/v1/runtime/source-directory", Map.of("path", path));
    }

    private Optional<Map<String, Object>> post(String path, Map<String, Object> body) {
        try {
            return Optional.ofNullable(restTemplate.exchange(
                    runtimeUrl + path,
                    org.springframework.http.HttpMethod.POST,
                    new HttpEntity<>(body, headers()),
                    new ParameterizedTypeReference<Map<String, Object>>() { }).getBody());
        } catch (Exception error) {
            logger.warn("Runtime import request unavailable path={} reason={}", path, error.getMessage());
            return Optional.empty();
        }
    }

    private HttpHeaders headers() {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(serviceToken);
        return headers;
    }
}
