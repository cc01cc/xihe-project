package com.cc01cc.p.xihe.cp.provider;

import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.fasterxml.jackson.annotation.JsonInclude;
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

import java.util.Map;
import java.util.List;

@RestController
@RequestMapping("/api/v1/provider-connections")
@PreAuthorize("hasAnyRole('USER', 'ADMIN')")
public class ProviderConnectionController {

    private static final Logger logger = LoggerFactory.getLogger(ProviderConnectionController.class);

    private final ProviderConnectionService connections;

    public ProviderConnectionController(
            ProviderConnectionService connections) {
        this.connections = connections;
    }

    @GetMapping
    public ResponseEntity<?> listConnections() {
        return ResponseEntity.ok(Map.of("connections", connections.listVisible()));
    }

    @PostMapping
    public ResponseEntity<?> create(@RequestBody ConnectionRequest request) {
        try {
            var created = connections.create(request.toInput());
            return ResponseEntity.status(HttpStatus.CREATED).body(connections.view(created));
        } catch (IllegalArgumentException e) {
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
            var updated = connections.update(connectionId, request.toInput());
            return ResponseEntity.ok(connections.view(updated));
        } catch (IllegalArgumentException e) {
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
            logger.warn("Provider connection verify rejected connectionId={} errorCode={}",
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
        } catch (IllegalArgumentException e) {
            logger.warn("Provider connection delete rejected connectionId={} errorCode={}",
                    connectionId, e.getMessage());
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "PROVIDER_CONNECTION_INVALID", e.getMessage());
        }
    }

    public record ConnectionRequest(
            String providerId,
            String label,
            String scope,
            @JsonInclude(JsonInclude.Include.NON_NULL) String apiKey,
            String baseUrl,
            String modelDiscovery,
            List<String> manualModels,
            Boolean enabled) {
        ProviderConnectionService.ConnectionInput toInput() {
            return new ProviderConnectionService.ConnectionInput(
                    providerId, label, scope, apiKey, baseUrl, modelDiscovery, manualModels, enabled);
        }
    }
}
