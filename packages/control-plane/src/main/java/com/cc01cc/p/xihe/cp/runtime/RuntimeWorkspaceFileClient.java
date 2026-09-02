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

/**
 * CP-only proxy for reading workspace files through the Runtime. CP never
 * opens WorkspaceStorage directly.
 */
@Component
public class RuntimeWorkspaceFileClient {

    private static final Logger logger = LoggerFactory.getLogger(RuntimeWorkspaceFileClient.class);

    private final RestTemplate restTemplate;
    private final String runtimeUrl;
    private final String serviceToken;

    public RuntimeWorkspaceFileClient(RestTemplate restTemplate,
                                       @Value("${cp.mcp.runtime-url:http://localhost:12633}") String runtimeUrl,
                                       @Value("${cp.agent-api-token:dev-token-not-secure}") String serviceToken) {
        this.restTemplate = restTemplate;
        this.runtimeUrl = runtimeUrl;
        this.serviceToken = serviceToken;
    }

    public Optional<String> readText(String workspaceId, String path) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            headers.setBearerAuth(serviceToken);
            Map<String, Object> body = Map.of("path", path);
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
            logger.warn("Runtime file read failed workspaceId={} path={}: {}",
                    workspaceId, path, e.getMessage());
            return Optional.empty();
        }
    }

    public boolean writeBinary(String workspaceId, String path, byte[] data) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_OCTET_STREAM);
            headers.setBearerAuth(serviceToken);
            var response = restTemplate.exchange(
                    runtimeUrl + "/internal/v1/runtime/workspaces/" + workspaceId
                            + "/files/write/" + org.springframework.web.util.UriUtils.encodePathSegment(
                                    path, java.nio.charset.StandardCharsets.UTF_8),
                    org.springframework.http.HttpMethod.POST,
                    new HttpEntity<>(data, headers),
                    new org.springframework.core.ParameterizedTypeReference<Map<String, Object>>() { });
            return response.getStatusCode().is2xxSuccessful();
        } catch (Exception e) {
            logger.warn("Runtime file write failed workspaceId={} path={}: {}",
                    workspaceId, path, e.getMessage());
            return false;
        }
    }

    public boolean deleteFile(String workspaceId, String path) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            headers.setBearerAuth(serviceToken);
            Map<String, Object> body = Map.of("path", path);
            var response = restTemplate.exchange(
                    runtimeUrl + "/internal/v1/runtime/workspaces/" + workspaceId + "/files/delete",
                    org.springframework.http.HttpMethod.POST,
                    new HttpEntity<>(body, headers),
                    new org.springframework.core.ParameterizedTypeReference<Map<String, Object>>() { });
            return response.getStatusCode().is2xxSuccessful();
        } catch (Exception e) {
            logger.warn("Runtime file delete failed workspaceId={} path={}: {}",
                    workspaceId, path, e.getMessage());
            return false;
        }
    }
}
