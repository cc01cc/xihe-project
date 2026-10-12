package com.cc01cc.p.xihe.cp.provider;

import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.ProviderCredentialLease;
import com.cc01cc.p.xihe.cp.crypto.EnvelopeEncryptionService;
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

    @org.springframework.beans.factory.annotation.Autowired
    private com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService requestTemplates;

    private static final Duration DEFAULT_TTL = Duration.ofMinutes(5);

    private final ProviderCredentialLeaseRepository repository;
    private final ProviderConnectionRepository connectionRepository;
    private final ProviderConnectionService connectionService;
    private final ProviderCatalogService catalog;
    private final ApiInputTypeService apiTypes;
    private final ObjectMapper objectMapper;
    private final EnvelopeEncryptionService encryption;
    private final SecureRandom random = new SecureRandom();

    public ProviderCredentialLeaseService(
            ProviderCredentialLeaseRepository repository,
            ProviderConnectionRepository connectionRepository,
            ProviderConnectionService connectionService,
            ProviderCatalogService catalog,
            ApiInputTypeService apiTypes,
            ObjectMapper objectMapper,
            @Qualifier("providerCredentialEncryption") EnvelopeEncryptionService encryption) {
        this.repository = repository;
        this.connectionRepository = connectionRepository;
        this.connectionService = connectionService;
        this.catalog = catalog;
        this.apiTypes = apiTypes;
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
        return issue(userId, workspaceId, sessionId, runId, providerConnectionId,
                providerId, model, expectedRevision, DEFAULT_TTL);
    }

    /**
     * PLAN-0354 spec §3: callers with a shorter window (e.g. the summary hop,
     * bounded by summaryTimeoutMs ≤ 60s) pass an explicit TTL. The lease row
     * keeps its existing bindings (session/run/connection/provider/model);
     * no purpose column is added.
     */
    @Transactional
    public IssuedLease issue(
            String userId,
            String workspaceId,
            String sessionId,
            String runId,
            String providerConnectionId,
            String providerId,
            String model,
            Long expectedRevision,
            Duration ttl) {
        ProviderConnection connection = requestTemplates.lockConnection(providerConnectionId);
        if (expectedRevision != null && connection.getRevision() != expectedRevision) {
            throw com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService.conflict(
                    "STALE_PROVIDER_CONNECTION", "Provider connection revision is stale");
        }
        connectionService.requireUsableForOwner(providerConnectionId, userId, workspaceId);
        // PLAN-0485 round-4 item 4: the connection's API Type operation governs
        // lease validation instead of the presence of a runId. Chat admission
        // keeps its explicit chat gate; a Run-bound embedding lease (0416) and
        // an operation-scoped lease without a run (embedding test/RAG) both
        // validate against the connection's actual operation without a new
        // purpose column. Model applicability stays operation-aware.
        String operation = apiTypes.operation(connection.getApiTypeId(), connection.getApiTypeVersion());
        if ("chat".equals(operation)) {
            requestTemplates.requireModel(connection, model);
        }
        if (!connection.getProviderId().equals(providerId)) {
            throw new IllegalArgumentException("Provider connection does not match provider");
        }
        if (expectedRevision != null && connection.getRevision() != expectedRevision) {
            throw com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService.conflict(
                    "STALE_PROVIDER_CONNECTION", "Provider connection revision is stale");
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
        lease.setExpiresAt(Instant.now().plus(ttl == null ? DEFAULT_TTL : ttl));
        repository.save(lease);
        return new IssuedLease(token, lease.getExpiresAt());
    }

    @Transactional
    public CredentialGrant redeem(RedeemRequest request) {
        ProviderConnection connection = requestTemplates.lockConnection(request.providerConnectionId());
        ProviderCredentialLease lease = repository.findByLeaseHash(hash(request.lease()))
                .orElseThrow(() -> new IllegalArgumentException("Provider credential lease not found"));
        Instant now = Instant.now();
        if (lease.getExpiresAt().isBefore(now) || lease.getRevokedAt() != null || lease.getRedeemedAt() != null) {
            throw new IllegalArgumentException("Provider credential lease is no longer valid");
        }
        // A lease issued for catalog discovery carries no chat run (run_id NULL), so the run
        // binding is only enforced when the lease actually belongs to a run.
        if ((lease.getRunId() != null && !lease.getRunId().equals(request.runId()))
                || !lease.getProviderConnectionId().equals(request.providerConnectionId())
                || !lease.getProviderId().equals(request.providerId())
                || !lease.getModel().equals(request.model())) {
            throw new IllegalArgumentException("Provider credential lease binding mismatch");
        }
        requestTemplates.requireVisible(connection, lease.getUserId(), lease.getWorkspaceId());
        if (connection.getRevision() != request.connectionRevision()) {
            throw com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService.conflict(
                    "STALE_PROVIDER_CONNECTION", "Provider credential lease revision mismatch");
        }
        if (lease.getRunId() != null) {
            requestTemplates.requireModel(connection, request.model());
        }
        if (connection.getRevision() != request.connectionRevision()) {
            throw com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService.conflict(
                    "STALE_PROVIDER_CONNECTION", "Provider credential lease revision mismatch");
        }
        if (!connection.isEnabled() || !ProviderConnection.STATUS_READY.equals(connection.getStatus())) {
            throw new IllegalArgumentException("Provider connection is not ready");
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
        String operation = apiTypes.operation(connection.getApiTypeId(), connection.getApiTypeVersion());
        return new CredentialGrant(
                connection.getProviderId(), routeProvider, request.model(), connection.getBaseUrl(),
                apiKey, connection.getRevision(), connection.getModelDiscovery(), manualModels,
                connection.getConnectionKey(), connection.getApiTypeId(),
                connection.getApiTypeVersion(), operation);
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
            List<String> manualModels,
            String connectionKey,
            String apiTypeId,
            int apiTypeVersion,
            String operation) {}

    private List<String> parseManualModels(String raw) {
        if (raw == null || raw.isBlank()) {
            return List.of();
        }
        try {
            return objectMapper.readValue(raw, new TypeReference<List<String>>() {});
        } catch (Exception e) {
            throw new IllegalArgumentException("Manual model list is invalid", e);
        }
    }
}
