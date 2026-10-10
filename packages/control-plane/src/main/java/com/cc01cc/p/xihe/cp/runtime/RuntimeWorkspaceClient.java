package com.cc01cc.p.xihe.cp.runtime;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestTemplate;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/** Thin client for the Runtime's targeted workspace status and cleanup routes. */
@Component
public class RuntimeWorkspaceClient {

    private static final Logger logger = LoggerFactory.getLogger(RuntimeWorkspaceClient.class);

    private final RestTemplate restTemplate;
    private final String runtimeUrl;
    private final String serviceToken;

    public RuntimeWorkspaceClient(RestTemplate restTemplate,
                                  @Value("${cp.mcp.runtime-url:http://localhost:12633}") String runtimeUrl,
                                  @Value("${cp.agent-api-token:dev-token-not-secure}") String serviceToken) {
        this.restTemplate = restTemplate;
        this.runtimeUrl = runtimeUrl;
        this.serviceToken = serviceToken;
    }

    /** Reads the Runtime-owned materialization status for one workspace. */
    public Optional<Map<String, Object>> fetchStatus(String workspaceId) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setAccept(java.util.List.of(MediaType.APPLICATION_JSON));
            headers.setBearerAuth(serviceToken);
            ResponseEntityWrap<Map<String, Object>> response = invoke(
                    restTemplate.exchange(
                            runtimeUrl + "/internal/v1/runtime/workspaces/" + workspaceId + "/status",
                            org.springframework.http.HttpMethod.GET,
                            new HttpEntity<>(headers),
                            new org.springframework.core.ParameterizedTypeReference<Map<String, Object>>() { }),
                    "fetchStatus");
            if (response.isNotFound() || response.body() == null) {
                return Optional.empty();
            }
            return Optional.of(response.body());
        } catch (Exception e) {
            logger.warn("Runtime status fetch failed workspaceId={} reason={}", workspaceId, e.getMessage());
            return Optional.empty();
        }
    }

    public boolean deleteSandbox(String workspaceId) {
        Map<String, String> body = new LinkedHashMap<>();
        body.put("workspaceId", workspaceId);
        return invokeBool("deleteSandbox", "/internal/v1/runtime/workspaces/delete", body);
    }

    /**
     * PLAN-0470: richer status outcome for the environment adapter — 404/null
     * is an explicit {@code unbound}, transport/unknown failure is
     * {@code unreachable}, everything else carries the Runtime body.
     */
    public record RuntimeStatusResult(Map<String, Object> body, boolean unbound, boolean unreachable) {}

    public RuntimeStatusResult fetchStatusDetailed(String workspaceId) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setAccept(java.util.List.of(MediaType.APPLICATION_JSON));
            headers.setBearerAuth(serviceToken);
            ResponseEntityWrap<Map<String, Object>> response = invoke(
                    restTemplate.exchange(
                            runtimeUrl + "/internal/v1/runtime/workspaces/" + workspaceId + "/status",
                            org.springframework.http.HttpMethod.GET,
                            new HttpEntity<>(headers),
                            new org.springframework.core.ParameterizedTypeReference<Map<String, Object>>() { }),
                    "fetchStatusDetailed");
            if (response.isNotFound() || response.body() == null) {
                return new RuntimeStatusResult(null, true, false);
            }
            return new RuntimeStatusResult(response.body(), false, false);
        } catch (HttpClientErrorException.NotFound e) {
            return new RuntimeStatusResult(null, true, false);
        } catch (Exception e) {
            logger.warn("Runtime status fetch failed workspaceId={} reason={}", workspaceId, e.getMessage());
            return new RuntimeStatusResult(null, false, true);
        }
    }

    /**
     * PLAN-0470: async materialize trigger. Runtime Problem {@code code/detail}
     * are preserved verbatim so callers can pass 409 conflicts through.
     */
    public record MaterializeResult(Integer httpStatus, Map<String, Object> body,
                                    String problemCode, String problemDetail, boolean unreachable) {}

    public MaterializeResult materialize(String workspaceId) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            headers.setBearerAuth(serviceToken);
            ResponseEntity<Map> response = restTemplate.postForEntity(
                    runtimeUrl + "/internal/v1/runtime/workspaces/" + workspaceId + "/materialize",
                    new HttpEntity<>(Map.of(), headers),
                    Map.class);
            if (!response.getStatusCode().is2xxSuccessful()) {
                logger.warn("Runtime materialize rejected workspaceId={} status={}",
                        workspaceId, response.getStatusCode());
                return new MaterializeResult(response.getStatusCode().value(), null,
                        "RUNTIME_REJECTED", "Runtime rejected the materialize request", false);
            }
            return new MaterializeResult(
                    response.getStatusCode().value(), response.getBody(), null, null, false);
        } catch (HttpClientErrorException e) {
            Map<String, Object> problem = e.getResponseBodyAs(Map.class);
            String code = problem != null && problem.get("code") instanceof String c
                    ? c
                    : "RUNTIME_ERROR";
            String detail = problem != null && problem.get("detail") instanceof String d
                    ? d
                    : e.getMessage();
            logger.warn("Runtime materialize problem workspaceId={} status={} code={}",
                    workspaceId, e.getStatusCode(), code);
            return new MaterializeResult(e.getStatusCode().value(), null, code, detail, false);
        } catch (Exception e) {
            logger.warn("Runtime materialize failed workspaceId={}: {}", workspaceId, e.getMessage());
            return new MaterializeResult(null, null, null, null, true);
        }
    }

    private boolean invokeBool(String op, String path, Map<String, String> body) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            headers.setBearerAuth(serviceToken);
            ResponseEntityWrap<Map<String, Object>> response = invoke(
                    restTemplate.exchange(
                            runtimeUrl + path,
                            org.springframework.http.HttpMethod.POST,
                            new HttpEntity<>(body, headers),
                            new org.springframework.core.ParameterizedTypeReference<Map<String, Object>>() { }),
                    op);
            return response.status() != null && response.status().is2xxSuccessful();
        } catch (Exception e) {
            logger.warn("Runtime {} failed path={} reason={}", op, path, e.getMessage());
            return false;
        }
    }

    private static <T> ResponseEntityWrap<T> invoke(
            org.springframework.http.ResponseEntity<T> responseEntity,
            String op) {
        if (responseEntity == null) {
            return new ResponseEntityWrap<>(null, null);
        }
        return new ResponseEntityWrap<>(responseEntity.getBody(), responseEntity.getStatusCode());
    }

    private record ResponseEntityWrap<T>(T body, org.springframework.http.HttpStatusCode status) {
        boolean isNotFound() {
            return status != null && status.value() == 404;
        }
    }
}
