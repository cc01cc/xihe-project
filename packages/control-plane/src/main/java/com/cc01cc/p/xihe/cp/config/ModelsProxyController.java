package com.cc01cc.p.xihe.cp.config;

import com.fasterxml.jackson.databind.ObjectMapper;
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

@RestController
public class ModelsProxyController {

    private static final Logger logger = LoggerFactory.getLogger(ModelsProxyController.class);

    private final HttpClient httpClient;
    private final ObjectMapper objectMapper;

    @Value("${cp.agent-base-url:http://localhost:12632}")
    private String agentBaseUrl;

    @Value("${cp.agent-api-token:dev-token-not-secure}")
    private String agentApiToken;

    public ModelsProxyController(ObjectMapper objectMapper) {
        this.httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
        this.objectMapper = objectMapper;
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/models")
    public ResponseEntity<?> listModels() {
        try {
            String targetUrl = agentBaseUrl + "/v1/models";
            HttpRequest request = HttpRequest.newBuilder(URI.create(targetUrl))
                .header(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
                .header("Authorization", "Bearer " + agentApiToken)
                .timeout(Duration.ofSeconds(30))
                .GET()
                .build();

            HttpResponse<String> response = httpClient.send(
                request, HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() >= 400) {
                logger.error("Models proxy: Agent returned {}", response.statusCode());
                return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                    .body(Map.of("error", "Agent request failed: HTTP " + response.statusCode()));
            }

            Object body = objectMapper.readValue(response.body(), Object.class);
            return ResponseEntity.ok(body);
        } catch (Exception e) {
            logger.error("Models proxy failed", e);
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                .body(Map.of("error", "Models proxy failed: " + e.getMessage()));
        }
    }
}
