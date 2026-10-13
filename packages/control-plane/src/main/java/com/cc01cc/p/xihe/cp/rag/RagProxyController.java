package com.cc01cc.p.xihe.cp.rag;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.EmbeddingProfileService;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.provider.ProviderCredentialLeaseService;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0485 RAG proxy: owner/profile are derived from the authenticated
 * TenantContext, never from the request body (spec §RAG Route / Caller
 * Matrix). Each provider-touching operation receives its own resolved
 * profile and one-use embedding credential lease; stats/delete need only the
 * resolved partition and no lease. Failures keep stable RFC 9457 codes and
 * the original requestId; provider payloads never surface.
 */
@RestController
@RequestMapping("/api/v1/rag")
@PreAuthorize("hasAnyRole('USER', 'ADMIN')")
public class RagProxyController {

    private static final Logger logger = LoggerFactory.getLogger(RagProxyController.class);

    private final EmbeddingProfileService profiles;
    private final ObjectMapper objectMapper;
    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();
    private final String agentBaseUrl;
    private final String agentApiToken;

    public RagProxyController(
            EmbeddingProfileService profiles,
            ObjectMapper objectMapper,
            @Value("${cp.agent-base-url:http://localhost:12632}") String agentBaseUrl,
            @Value("${cp.agent-api-token:dev-token-not-secure}") String agentApiToken) {
        this.profiles = profiles;
        this.objectMapper = objectMapper;
        this.agentBaseUrl = agentBaseUrl.replaceAll("/+$", "");
        this.agentApiToken = agentApiToken;
    }

    public record SearchRequest(String query, Integer topK, Double minScore) {
    }

    @GetMapping("/stats")
    public ResponseEntity<Map<String, Object>> stats() {
        UUID userId = currentUserId();
        UUID workspaceId = currentWorkspaceId();
        EmbeddingProfileService.ResolvedProfile profile = profiles.resolve(userId, workspaceId);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("embeddingProfile", profiles.describe(profile));
        Map<String, Object> agentPayload = postAgent(
                "/internal/v1/agent/rag/stats", body, requestId(), true);
        return ResponseEntity.ok(agentPayload);
    }

    @PostMapping(value = "/ingest", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<Map<String, Object>> ingest(
            @RequestParam("file") MultipartFile file,
            @RequestParam(value = "chunkSize", required = false) Integer chunkSize,
            @RequestParam(value = "chunkOverlap", required = false) Integer chunkOverlap) {
        UUID userId = currentUserId();
        UUID workspaceId = currentWorkspaceId();
        EmbeddingProfileService.ResolvedProfile profile = profiles.resolve(userId, workspaceId);
        ProviderCredentialLeaseService.IssuedLease lease = profiles.issueLease(
                profile, userId.toString(), workspaceId == null ? null : workspaceId.toString(), null, null);
        String requestId = requestId();
        try {
            MultiValueMap<String, Object> body = new LinkedMultiValueMap<>();
            body.add("file", new ByteArrayResource(file.getBytes()) {
                @Override
                public String getFilename() {
                    return file.getOriginalFilename();
                }
            });
            if (chunkSize != null) {
                body.add("chunkSize", String.valueOf(chunkSize));
            }
            if (chunkOverlap != null) {
                body.add("chunkOverlap", String.valueOf(chunkOverlap));
            }
            body.add("embeddingProfile", objectMapper.writeValueAsString(profiles.describe(profile)));
            body.add("embeddingCredentialLease", lease.token());
            BoundaryResource multipart = new BoundaryResource(body);
            HttpRequest agentRequest = HttpRequest.newBuilder(URI.create(agentBaseUrl + "/internal/v1/agent/rag/ingest"))
                    .header("Authorization", "Bearer " + agentApiToken)
                    .header("Content-Type", multipart.contentType())
                    .header("Accept", "application/json")
                    // Correlate the Agent hop with this proxy request id.
                    .header("X-Request-Id", requestId)
                    .timeout(Duration.ofSeconds(120))
                    .POST(HttpRequest.BodyPublishers.ofByteArray(multipart.bytes()))
                    .build();
            HttpResponse<String> response = httpClient.send(agentRequest, HttpResponse.BodyHandlers.ofString());
            Map<String, Object> payload = objectMapper.readValue(
                    response.body(), new TypeReference<Map<String, Object>>() { });
            requireOk(response.statusCode(), payload, requestId);
            return ResponseEntity.ok(payload);
        } catch (CpApiException e) {
            throw e;
        } catch (Exception e) {
            logger.warn("RAG ingest proxy failed requestId={} errorType={}", requestId, e.getClass().getSimpleName());
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "EMBEDDING_PROVIDER_UNREACHABLE",
                    "RAG ingest is unavailable");
        }
    }

    @PostMapping("/search")
    public ResponseEntity<Map<String, Object>> search(@RequestBody SearchRequest request) {
        UUID userId = currentUserId();
        UUID workspaceId = currentWorkspaceId();
        if (request.query() == null || request.query().isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "query is required");
        }
        EmbeddingProfileService.ResolvedProfile profile = profiles.resolve(userId, workspaceId);
        ProviderCredentialLeaseService.IssuedLease lease = profiles.issueLease(
                profile, userId.toString(), workspaceId == null ? null : workspaceId.toString(), null, null);
        String requestId = requestId();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("query", request.query());
        if (request.topK() != null) {
            body.put("topK", request.topK());
        }
        if (request.minScore() != null) {
            body.put("minScore", request.minScore());
        }
        body.put("embeddingProfile", profiles.describe(profile));
        body.put("embeddingCredentialLease", lease.token());
        Map<String, Object> agentPayload = postAgent(
                "/internal/v1/agent/rag/search", body, requestId, true);
        return ResponseEntity.ok(agentPayload);
    }

    @DeleteMapping("/documents/{docId}")
    public ResponseEntity<Map<String, Object>> delete(@PathVariable String docId) {
        UUID userId = currentUserId();
        UUID workspaceId = currentWorkspaceId();
        if (docId == null || docId.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "docId is required");
        }
        EmbeddingProfileService.ResolvedProfile profile = profiles.resolve(userId, workspaceId);
        String requestId = requestId();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("embeddingProfile", profiles.describe(profile));
        Map<String, Object> agentPayload = postAgent(
                "/internal/v1/agent/rag/documents/" + docId + "/delete", body, requestId, true);
        return ResponseEntity.ok(agentPayload);
    }

    private Map<String, Object> postAgent(String path, Map<String, Object> body, String requestId, boolean mapErrors) {
        try {
            HttpRequest agentRequest = HttpRequest.newBuilder(URI.create(agentBaseUrl + path))
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .header("Authorization", "Bearer " + agentApiToken)
                    // Correlate the Agent hop with this proxy request id.
                    .header("X-Request-Id", requestId)
                    .timeout(Duration.ofSeconds(60))
                    .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(body)))
                    .build();
            HttpResponse<String> response = httpClient.send(agentRequest, HttpResponse.BodyHandlers.ofString());
            Map<String, Object> payload = objectMapper.readValue(
                    response.body(), new TypeReference<Map<String, Object>>() { });
            if (mapErrors) {
                return requireOk(response.statusCode(), payload, requestId);
            }
            return payload;
        } catch (CpApiException e) {
            throw e;
        } catch (Exception e) {
            logger.warn("RAG proxy call failed path={} requestId={} errorType={}", path, requestId,
                    e.getClass().getSimpleName());
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "EMBEDDING_PROVIDER_UNREACHABLE",
                    "RAG service is unavailable");
        }
    }

    private Map<String, Object> requireOk(int status, Map<String, Object> payload, String requestId) {
        if (status >= 200 && status < 300) {
            return payload;
        }
        String code = String.valueOf(payload.getOrDefault("code", "EMBEDDING_PROVIDER_UNREACHABLE"));
        HttpStatus http = status == 404 ? HttpStatus.NOT_FOUND
                : status == 409 ? HttpStatus.CONFLICT
                : status == 401 ? HttpStatus.UNAUTHORIZED
                : status == 403 ? HttpStatus.FORBIDDEN
                : status >= 500 ? HttpStatus.BAD_GATEWAY
                : HttpStatus.BAD_REQUEST;
        throw new CpApiException(http, code, "RAG operation failed", requestId);
    }

    private UUID currentUserId() {
        String value = TenantContext.getUserId();
        if (value == null || value.isBlank()) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED",
                    "Authentication is required");
        }
        return UUID.fromString(value);
    }

    private UUID currentWorkspaceId() {
        String value = TenantContext.getWorkspaceId();
        return value == null || value.isBlank() ? null : UUID.fromString(value);
    }

    private String requestId() {
        return UUID.randomUUID().toString();
    }

    /** Minimal multipart encoder for the agent ingest hop. */
    private static final class BoundaryResource {
        private final byte[] bytes;
        private final String contentType;

        BoundaryResource(MultiValueMap<String, Object> body) {
            String boundary = "xihe-rag-" + UUID.randomUUID().toString().replace("-", "");
            this.contentType = "multipart/form-data; boundary=" + boundary;
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            try {
                for (Map.Entry<String, java.util.List<Object>> entry : body.entrySet()) {
                    for (Object part : entry.getValue()) {
                        out.write(("--" + boundary + "\r\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
                        if (part instanceof ByteArrayResource file) {
                            out.write(("Content-Disposition: form-data; name=\"" + entry.getKey()
                                    + "\"; filename=\"" + file.getFilename() + "\"\r\n")
                                    .getBytes(java.nio.charset.StandardCharsets.UTF_8));
                            out.write("Content-Type: application/octet-stream\r\n\r\n".getBytes(
                                    java.nio.charset.StandardCharsets.UTF_8));
                            out.write(file.getByteArray());
                            out.write("\r\n".getBytes(java.nio.charset.StandardCharsets.UTF_8));
                        } else {
                            out.write(("Content-Disposition: form-data; name=\"" + entry.getKey()
                                    + "\"\r\n\r\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
                            out.write(String.valueOf(part).getBytes(java.nio.charset.StandardCharsets.UTF_8));
                            out.write("\r\n".getBytes(java.nio.charset.StandardCharsets.UTF_8));
                        }
                    }
                }
                out.write(("--" + boundary + "--\r\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
            } catch (java.io.IOException e) {
                throw new IllegalStateException("Multipart encoding failed", e);
            }
            this.bytes = out.toByteArray();
        }

        byte[] bytes() {
            return bytes;
        }

        String contentType() {
            return contentType;
        }
    }
}
