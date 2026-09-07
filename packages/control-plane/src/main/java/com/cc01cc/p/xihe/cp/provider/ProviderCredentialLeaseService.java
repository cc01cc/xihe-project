package com.cc01cc.p.xihe.cp.provider;

import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.ProviderCredentialLease;
import com.cc01cc.p.xihe.cp.oauth.EnvelopeEncryptionService;
import com.cc01cc.p.xihe.cp.repository.ProviderCredentialLeaseRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.UUID;

@Service
public class ProviderCredentialLeaseService {

    private static final Duration DEFAULT_TTL = Duration.ofMinutes(5);

    private final ProviderCredentialLeaseRepository repository;
    private final ProviderConnectionRepository connectionRepository;
    private final ProviderConnectionService connectionService;
    private final ProviderCatalogService catalog;
    private final ObjectMapper objectMapper;
    private final EnvelopeEncryptionService encryption;
    private final SecureRandom random = new SecureRandom();

    public ProviderCredentialLeaseService(
            ProviderCredentialLeaseRepository repository,
            ProviderConnectionRepository connectionRepository,
            ProviderConnectionService connectionService,
            ProviderCatalogService catalog,
            ObjectMapper objectMapper,
            @Qualifier("providerCredentialEncryption") EnvelopeEncryptionService encryption) {
        this.repository = repository;
        this.connectionRepository = connectionRepository;
        this.connectionService = connectionService;
        this.catalog = catalog;
        this.objectMapper = objectMapper;
        this.encryption = encryption;
    }

    @Transactional
    public IssuedLease issue(
            String userId,
            String workspaceId,
            String sessionId,
            String runId,
            String providerConnectionId,
            String providerId,
            String model) {
        return issue(userId, workspaceId, sessionId, runId, providerConnectionId, providerId, model, null);
    }

    @Transactional
    public IssuedLease issue(
            String userId,
            String workspaceId,
            String sessionId,
            String runId,
            String providerConnectionId,
            String providerId,
            String model,
            Long expectedRevision) {
        ProviderConnection connection = connectionService.requireUsableForOwner(
                providerConnectionId, userId, workspaceId);
        if (!connection.getProviderId().equals(providerId)) {
            throw new IllegalArgumentException("Provider connection does not match provider");
        }
        if (expectedRevision != null && connection.getRevision() != expectedRevision) {
            throw new IllegalArgumentException("Provider connection revision is stale");
        }
        String token = "pl_" + randomToken();
        ProviderCredentialLease lease = new ProviderCredentialLease();
        lease.setId(UUID.randomUUID());
        lease.setLeaseHash(hash(token));
        lease.setProviderConnectionId(connection.getId().toString());
        lease.setUserId(userId);
        lease.setWorkspaceId(workspaceId);
        lease.setSessionId(sessionId);
        lease.setRunId(runId);
        lease.setProviderId(providerId);
        lease.setModel(model);
        lease.setExpiresAt(Instant.now().plus(DEFAULT_TTL));
        repository.save(lease);
        return new IssuedLease(token, lease.getExpiresAt());
    }

    @Transactional
    public CredentialGrant redeem(RedeemRequest request) {
        ProviderCredentialLease lease = repository.findByLeaseHash(hash(request.lease()))
                .orElseThrow(() -> new IllegalArgumentException("Provider credential lease not found"));
        Instant now = Instant.now();
        if (lease.getExpiresAt().isBefore(now) || lease.getRevokedAt() != null || lease.getRedeemedAt() != null) {
            throw new IllegalArgumentException("Provider credential lease is no longer valid");
        }
        if (!lease.getRunId().equals(request.runId())
                || !lease.getProviderConnectionId().equals(request.providerConnectionId())
                || !lease.getProviderId().equals(request.providerId())
                || !lease.getModel().equals(request.model())) {
            throw new IllegalArgumentException("Provider credential lease binding mismatch");
        }
        ProviderConnection connection = connectionRepository.findById(UUID.fromString(lease.getProviderConnectionId()))
                .orElseThrow(() -> new IllegalArgumentException("Provider connection not found"));
        if (!connection.isEnabled() || !ProviderConnection.STATUS_READY.equals(connection.getStatus())) {
            throw new IllegalArgumentException("Provider connection is not ready");
        }
        if (connection.getRevision() != request.connectionRevision()) {
            throw new IllegalArgumentException("Provider credential lease revision mismatch");
        }
        lease.setRedeemedAt(now);
        repository.save(lease);
        String apiKey = connection.getCredentialCiphertext() == null
                ? null
                : encryption.decrypt(connection.getCredentialCiphertext(),
                connection.getProviderId() + "|" + connection.getOwnerType() + "|"
                        + connection.getOwnerId() + "|" + connection.getId());
        String routeProvider = catalog.require(connection.getProviderId())
                .path("litellmProvider").asText(connection.getProviderId());
        List<String> manualModels = parseManualModels(connection.getManualModels());
        return new CredentialGrant(
                connection.getProviderId(), routeProvider, request.model(), connection.getBaseUrl(),
                apiKey, connection.getRevision(), connection.getModelDiscovery(), manualModels);
    }

    private String randomToken() {
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private String hash(String token) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(token.getBytes(StandardCharsets.UTF_8));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(digest);
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }

    public record IssuedLease(String token, Instant expiresAt) {}

    public record RedeemRequest(
            String lease,
            String runId,
            String providerConnectionId,
            String providerId,
            String model,
            long connectionRevision) {}

    public record CredentialGrant(
            String provider,
            String routeProvider,
            String model,
            String baseUrl,
            String apiKey,
            long connectionRevision,
            String modelDiscovery,
            List<String> manualModels) {}

    private List<String> parseManualModels(String raw) {
        if (raw == null || raw.isBlank()) return List.of();
        try {
            return objectMapper.readValue(raw, new TypeReference<List<String>>() {});
        } catch (Exception e) {
            throw new IllegalArgumentException("Manual model list is invalid", e);
        }
    }
}
