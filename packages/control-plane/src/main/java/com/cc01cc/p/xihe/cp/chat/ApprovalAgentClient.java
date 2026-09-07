package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

@Component
public class ApprovalAgentClient {

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();
    private final ObjectMapper objectMapper;
    private final String agentBaseUrl;
    private final String agentApiToken;

    public ApprovalAgentClient(
            ObjectMapper objectMapper,
            @Value("${cp.agent-base-url:http://localhost:12632}") String agentBaseUrl,
            @Value("${cp.agent-api-token:dev-token-not-secure}") String agentApiToken) {
        this.objectMapper = objectMapper;
        this.agentBaseUrl = agentBaseUrl.replaceAll("/+$", "");
        this.agentApiToken = agentApiToken;
    }

    public Map<String, Object> respond(String requestId, boolean approved) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("requestId", requestId);
        body.put("approved", approved);
        return post("/internal/v1/agent/approval/respond", body);
    }

    public Map<String, Object> status(String requestId) {
        if (requestId == null || !requestId.matches("[A-Za-z0-9-]{1,128}")) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "requestId is invalid");
        }
        return get("/internal/v1/agent/approval/" + requestId);
    }

    private Map<String, Object> post(String path, Map<String, Object> body) {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(agentBaseUrl + path))
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .header("Authorization", "Bearer " + agentApiToken)
                    .timeout(Duration.ofSeconds(10))
                    .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(body)))
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            return parseResponse(response, "POST", path);
        } catch (CpApiException e) {
            throw e;
        } catch (Exception e) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_UNAVAILABLE", "Agent approval service is unavailable", e);
        }
    }

    private Map<String, Object> get(String path) {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(agentBaseUrl + path))
                    .header("Accept", "application/json")
                    .header("Authorization", "Bearer " + agentApiToken)
                    .timeout(Duration.ofSeconds(10))
                    .GET()
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            return parseResponse(response, "GET", path);
        } catch (CpApiException e) {
            throw e;
        } catch (Exception e) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_UNAVAILABLE", "Agent approval service is unavailable", e);
        }
    }

    private Map<String, Object> parseResponse(HttpResponse<String> response, String method, String path) throws Exception {
        Map<String, Object> payload = objectMapper.readValue(
                response.body(), new TypeReference<Map<String, Object>>() { });
        if (response.statusCode() == 404) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "APPROVAL_NOT_FOUND", "Approval request not found");
        }
        if (response.statusCode() == 409) {
            throw new CpApiException(HttpStatus.CONFLICT, "APPROVAL_DECISION_CONFLICT", "Approval decision conflicts with the existing decision");
        }
        if (response.statusCode() == 410) {
            throw new CpApiException(HttpStatus.GONE, "APPROVAL_EXPIRED", "Approval request expired");
        }
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_APPROVAL_FAILED",
                    "Agent approval request failed: " + method + " " + path);
        }
        return payload;
    }
}
