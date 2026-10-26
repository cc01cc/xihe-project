package com.cc01cc.p.xihe.cp.provider;

import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.fasterxml.jackson.annotation.JsonInclude;
import tools.jackson.databind.JsonNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RequestParam;

import java.util.Map;
import java.util.List;

@RestController
@RequestMapping("/api/v1/provider-connections")
@PreAuthorize("hasAnyRole('USER', 'ADMIN')")
public class ProviderConnectionController {

    private static final Logger logger = LoggerFactory.getLogger(ProviderConnectionController.class);

    private final ProviderConnectionService connections;
    private final ProviderCatalogService catalog;

    public ProviderConnectionController(
            ProviderConnectionService connections, ProviderCatalogService catalog) {
        this.connections = connections;
        this.catalog = catalog;
    }

    @GetMapping
    public ResponseEntity<?> listConnections() {
        return ResponseEntity.ok(Map.of("connections", connections.listVisible()));
    }

    @PostMapping
    public ResponseEntity<?> create(@RequestBody ConnectionRequest request) {
        try {
            ResponseEntity<?> rejected = validateType(request, request.providerId());
            if (rejected != null) {
                return rejected;
            }
            var created = connections.create(request.toInput(), request.typeId(), request.typeVersion());
            return ResponseEntity.status(HttpStatus.CREATED).body(connections.view(created));
        } catch (ProviderConnectionService.KeyInvalidException e) {
            logger.warn("Provider connection create rejected errorCode={}", e.getMessage());
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "PROVIDER_CONNECTION_KEY_INVALID", e.getMessage());
        } catch (ProviderConnectionService.KeyConflictException e) {
            logger.warn("Provider connection create rejected errorCode={}", e.getMessage());
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.CONFLICT, "PROVIDER_CONNECTION_KEY_CONFLICT", e.getMessage());
        } catch (IllegalArgumentException e) {
            if (e instanceof com.cc01cc.p.xihe.cp.config.CpApiException domainFailure) {
                throw domainFailure;
            }
            logger.warn("Provider connection create rejected errorCode={}", e.getMessage());
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "PROVIDER_CONNECTION_INVALID", e.getMessage());
        }
    }

    @PatchMapping("/{connectionId}")
    public ResponseEntity<?> update(
            @PathVariable String connectionId,
            @RequestBody ConnectionRequest request) {
        try {
            ResponseEntity<?> rejected = validateType(request,
                    connections.requireVisible(connectionId).getProviderId());
            if (rejected != null) {
                return rejected;
            }
            com.fasterxml.jackson.databind.JsonNode ref = request.connectionDefaultTemplateRef() == null ? null
                    : new com.fasterxml.jackson.databind.ObjectMapper().valueToTree(request.connectionDefaultTemplateRef());
            var updated = connections.updateType(connectionId, request.toInput(), request.typeId(), request.typeVersion(),
                    request.expectedRevision(), ref, Boolean.TRUE.equals(request.confirmedTypeChange()));
            return ResponseEntity.ok(connections.view(updated));
        } catch (ProviderConnectionService.KeyInvalidException e) {
            logger.warn("Provider connection update rejected connectionId={} errorCode={}",
                    connectionId, e.getMessage());
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "PROVIDER_CONNECTION_KEY_INVALID", e.getMessage());
        } catch (ProviderConnectionService.KeyImmutableException e) {
            logger.warn("Provider connection update rejected connectionId={} errorCode={}",
                    connectionId, e.getMessage());
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.CONFLICT, "PROVIDER_CONNECTION_KEY_IMMUTABLE", e.getMessage());
        } catch (IllegalArgumentException e) {
            if (e instanceof com.cc01cc.p.xihe.cp.config.CpApiException domainFailure) {
                throw domainFailure;
            }
            logger.warn("Provider connection update rejected connectionId={} errorCode={}",
                    connectionId, e.getMessage());
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "PROVIDER_CONNECTION_INVALID", e.getMessage());
        }
    }

    @PostMapping("/{connectionId}/verify")
    public ResponseEntity<?> verify(@PathVariable String connectionId) {
        try {
            var verified = connections.verify(connectionId);
            return ResponseEntity.ok(Map.of(
                    "connection", connections.view(verified),
                    "models", List.of()));
        } catch (IllegalArgumentException e) {
            if (e instanceof com.cc01cc.p.xihe.cp.config.CpApiException domainFailure) {
                throw domainFailure;
            }
            logger.warn("Provider connection verify rejected connectionId={} errorCode={}",
                    connectionId, e.getMessage());
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "PROVIDER_CONNECTION_INVALID", e.getMessage());
        }
    }

    @GetMapping("/{connectionId}/api-type-change-impact")
    public ResponseEntity<?> impact(@PathVariable String connectionId, @RequestParam String apiTypeId,
                                    @RequestParam int version) {
        return ResponseEntity.ok(connections.typeImpact(connectionId, apiTypeId, version));
    }

    @GetMapping("/{connectionId}/delete-impact")
    public ResponseEntity<?> deleteImpact(@PathVariable String connectionId) {
        try {
            return ResponseEntity.ok(connections.deleteImpact(connectionId));
        } catch (IllegalArgumentException e) {
            if (e instanceof com.cc01cc.p.xihe.cp.config.CpApiException domainFailure) {
                throw domainFailure;
            }
            logger.warn("Provider connection delete impact rejected connectionId={} errorCode={}",
                    connectionId, e.getMessage());
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "PROVIDER_CONNECTION_INVALID", e.getMessage());
        }
    }

    @DeleteMapping("/{connectionId}")
    public ResponseEntity<?> delete(@PathVariable String connectionId) {
        try {
            connections.delete(connectionId);
            return ResponseEntity.noContent().build();
        } catch (ProviderConnectionService.SessionBlockedException e) {
            logger.warn("Provider connection delete blocked connectionId={} sessionCount={}",
                    e.getConnectionId(), e.getSessionCount());
            return ProblemDetailsHandler.problemResponse(HttpStatus.CONFLICT, "CONNECTION_IN_USE", e.getMessage(),
                    Map.of("sessionCount", e.getSessionCount(), "connectionId", e.getConnectionId()));
        } catch (IllegalArgumentException e) {
            if (e instanceof com.cc01cc.p.xihe.cp.config.CpApiException domainFailure) {
                throw domainFailure;
            }
            logger.warn("Provider connection delete rejected connectionId={} errorCode={}",
                    connectionId, e.getMessage());
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "PROVIDER_CONNECTION_INVALID", e.getMessage());
        }
    }

    private ResponseEntity<?> validateType(ConnectionRequest request, String providerId) {
        if (request.operation() != null && !request.operation().isMissingNode()) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST,
                    "PROVIDER_CONNECTION_INVALID", "Operation is read-only");
        }
        boolean hasId = request.apiTypeId() != null && !request.apiTypeId().isMissingNode();
        boolean hasVersion = request.apiTypeVersion() != null && !request.apiTypeVersion().isMissingNode();
        if (!hasId && !hasVersion) {
            return null;
        }
        if (!hasId || !hasVersion || !request.apiTypeId().isTextual()
                || !request.apiTypeVersion().isIntegralNumber()
                || !request.apiTypeVersion().canConvertToInt()) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST,
                    "INVALID_REQUEST", "Complete non-null API Type pair is required");
        }
        String id = request.apiTypeId().asText();
        int version = request.apiTypeVersion().asInt();
        try {
            catalog.supportedPair(providerId, id, version);
        } catch (IllegalArgumentException e) {
            if (e instanceof com.cc01cc.p.xihe.cp.config.CpApiException domainFailure) {
                throw domainFailure;
            }
            logger.warn("Provider connection Type rejected provider={}", providerId);
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST,
                    "PROVIDER_API_TYPE_UNSUPPORTED", "Unsupported provider API Type pair");
        }
        return null;
    }

    public record ConnectionRequest(
            String providerId,
            String label,
            String scope,
            @JsonInclude(JsonInclude.Include.NON_NULL) String apiKey,
            String baseUrl,
            String modelDiscovery,
            List<String> manualModels,
            Boolean enabled,
            JsonNode connectionKey,
            JsonNode apiTypeId,
            JsonNode apiTypeVersion,
            JsonNode operation,
            Long expectedRevision,
            Map<String, Object> connectionDefaultTemplateRef,
            Boolean confirmedTypeChange,
            String credentialId) {
        public ConnectionRequest(String providerId, String label, String scope, String apiKey, String baseUrl,
                                  String modelDiscovery, List<String> manualModels, Boolean enabled,
                                  JsonNode connectionKey, JsonNode apiTypeId, JsonNode apiTypeVersion, JsonNode operation) {
            this(providerId, label, scope, apiKey, baseUrl, modelDiscovery, manualModels, enabled,
                    connectionKey, apiTypeId, apiTypeVersion, operation, null, null, null, null);
        }

        String typeId() {
            return apiTypeId == null ? null : apiTypeId.asText();
        }

        Integer typeVersion() {
            return apiTypeVersion == null ? null : apiTypeVersion.asInt();
        }
        ProviderConnectionService.ConnectionInput toInput() {
            String key = null;
            if (connectionKey != null && !connectionKey.isMissingNode()) {
                if (connectionKey.isNull()) {
                    throw new ProviderConnectionService.KeyInvalidException(
                            "Connection key must not be null");
                }
                if (!connectionKey.isTextual()) {
                    throw new ProviderConnectionService.KeyInvalidException(
                            "Connection key must be a string");
                }
                key = connectionKey.asText();
            }
            return new ProviderConnectionService.ConnectionInput(
                    providerId, label, scope, apiKey, baseUrl, modelDiscovery, manualModels,
                    enabled, key, credentialId);
        }
    }
}
