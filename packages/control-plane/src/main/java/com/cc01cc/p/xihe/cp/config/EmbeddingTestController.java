package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.provider.ProviderCredentialLeaseService;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0485 T2.3: embedding test action. The public body must stay empty —
 * owner/profile/credential/model values come only from the authenticated
 * TenantContext and the saved effective profile (round-4 item 2).
 */
@RestController
@RequestMapping("/api/v1/config/embedding")
@PreAuthorize("hasAnyRole('USER', 'ADMIN')")
public class EmbeddingTestController {

    private final EmbeddingProfileService profiles;
    private final com.cc01cc.p.xihe.cp.service.WorkspaceService workspaceService;
    private final ObjectMapper objectMapper;
    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();
    private final String agentBaseUrl;
    private final String agentApiToken;

    public EmbeddingTestController(
            EmbeddingProfileService profiles,
            com.cc01cc.p.xihe.cp.service.WorkspaceService workspaceService,
            ObjectMapper objectMapper,
            @Value("${cp.agent-base-url:http://localhost:12632}") String agentBaseUrl,
            @Value("${cp.agent-api-token:dev-token-not-secure}") String agentApiToken) {
        this.profiles = profiles;
        this.workspaceService = workspaceService;
        this.objectMapper = objectMapper;
        this.agentBaseUrl = agentBaseUrl.replaceAll("/+$", "");
        this.agentApiToken = agentApiToken;
    }

    /**
     * A client-supplied workspace must be authorized for the caller before it
     * is used for profile resolution (same rule as ConfigController).
     */
    private void requireWorkspaceAccess(String wsValue, String userIdValue) {
        if (wsValue != null && !wsValue.isBlank()) {
            workspaceService.requireAccessibleWorkspace(wsValue, userIdValue);
        }
    }

    /**
     * PLAN-0485 T2.2: read-only effective profile for the settings surface.
     * Returns the whole-unit layer profile and its scope, plus the resolved
     * non-secret owner view when a READY embedding connection matches. A pure
     * read never fails on missing profile/connection; it reports the explicit
     * conflict code instead so the UI can explain the state.
     */
    @GetMapping("/effective")
    public ResponseEntity<Map<String, Object>> effective(
            @RequestHeader(value = "X-Workspace-Id", required = false) String headerWorkspaceId,
            @RequestParam(value = "workspaceId", required = false) String queryWorkspaceId) {
        String userIdValue = TenantContext.getUserId();
        if (userIdValue == null || userIdValue.isBlank()) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED",
                    "Authentication is required");
        }
        UUID userId = UUID.fromString(userIdValue);
        String wsValue = headerWorkspaceId != null && !headerWorkspaceId.isBlank()
                ? headerWorkspaceId
                : queryWorkspaceId != null && !queryWorkspaceId.isBlank()
                        ? queryWorkspaceId
                        : TenantContext.getWorkspaceId();
        requireWorkspaceAccess(wsValue, userIdValue);
        UUID workspaceId = wsValue == null || wsValue.isBlank() ? null : UUID.fromString(wsValue);

        Map<String, Object> response = new LinkedHashMap<>();
        // The pinned V1 contract is served, not re-declared by the client.
        Map<String, Object> contract = new LinkedHashMap<>();
        contract.put("modelId", EmbeddingProfileService.FIXED_MODEL);
        contract.put("dimension", EmbeddingProfileService.FIXED_DIMENSION);
        response.put("contract", contract);
        EmbeddingProfileService.EffectiveProfile effective = profiles.effectiveProfile(userId, workspaceId);
        if (effective.profile() == null) {
            response.put("profile", null);
            response.put("profileScope", null);
            response.put("resolved", null);
            return ResponseEntity.ok(response);
        }
        Map<String, Object> unit = new LinkedHashMap<>();
        unit.put("providerId", effective.profile().providerId());
        unit.put("connectionKey", effective.profile().connectionKey());
        unit.put("model", effective.profile().model());
        response.put("profile", unit);
        response.put("profileScope", effective.profileScope());
        try {
            response.put("resolved", profiles.describe(profiles.resolve(userId, workspaceId)));
        } catch (CpApiException conflict) {
            response.put("resolved", null);
            response.put("code", conflict.getCode());
        }
        return ResponseEntity.ok(response);
    }

    @PostMapping("/test")
    public ResponseEntity<Map<String, Object>> test(
            @RequestBody(required = false) Map<String, Object> body,
            @RequestHeader(value = "X-Workspace-Id", required = false) String headerWorkspaceId) {
        if (body != null && !body.isEmpty()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "Embedding test takes no request body");
        }
        String userIdValue = TenantContext.getUserId();
        if (userIdValue == null || userIdValue.isBlank()) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED",
                    "Authentication is required");
        }
        UUID userId = UUID.fromString(userIdValue);
        String wsValue = headerWorkspaceId != null && !headerWorkspaceId.isBlank()
                ? headerWorkspaceId
                : TenantContext.getWorkspaceId();
        requireWorkspaceAccess(wsValue, userIdValue);
        UUID workspaceId = wsValue == null || wsValue.isBlank() ? null : UUID.fromString(wsValue);

        EmbeddingProfileService.ResolvedProfile profile = profiles.resolve(userId, workspaceId);
        String requestId = UUID.randomUUID().toString();
        ProviderCredentialLeaseService.IssuedLease lease =
                profiles.issueLease(profile, userIdValue, workspaceId == null ? null : workspaceId.toString(),
                        null, null);

        Map<String, Object> agentBody = new LinkedHashMap<>();
        agentBody.put("embeddingProfile", describe(profile));
        agentBody.put("embeddingCredentialLease", lease.token());
        agentBody.put("requestId", requestId);
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(agentBaseUrl + "/internal/v1/agent/rag/embedding/test"))
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .header("Authorization", "Bearer " + agentApiToken)
                    .timeout(Duration.ofSeconds(30))
                    .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(agentBody)))
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            Map<String, Object> payload = objectMapper.readValue(
                    response.body(), new TypeReference<Map<String, Object>>() { });
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                String code = String.valueOf(payload.getOrDefault("code", "EMBEDDING_PROVIDER_UNREACHABLE"));
                Map<String, Object> problem = new LinkedHashMap<>();
                problem.put("type", "https://xihe.dev/problems/" + code.toLowerCase(java.util.Locale.ROOT));
                problem.put("title", "Embedding test failed");
                problem.put("status", response.statusCode());
                problem.put("code", code);
                problem.put("detail", "The embedding provider request did not succeed");
                problem.put("requestId", requestId);
                return ResponseEntity.status(response.statusCode())
                        .contentType(org.springframework.http.MediaType.APPLICATION_PROBLEM_JSON)
                        .body(problem);
            }
            Map<String, Object> safe = new LinkedHashMap<>();
            safe.put("status", "ok");
            safe.put("model", profile.modelId());
            safe.put("dimension", profile.dimension());
            safe.put("requestId", requestId);
            return ResponseEntity.ok(safe);
        } catch (CpApiException e) {
            throw e;
        } catch (Exception e) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "EMBEDDING_PROVIDER_UNREACHABLE",
                    "Agent embedding test is unreachable", e);
        }
    }

    private Map<String, Object> describe(EmbeddingProfileService.ResolvedProfile profile) {
        return profiles.describe(profile);
    }
}
