package com.cc01cc.p.xihe.cp.provider;

import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.ProviderConnectionAudit;
import com.cc01cc.p.xihe.cp.entity.ProviderCredentialLease;
import com.cc01cc.p.xihe.cp.oauth.EnvelopeEncryptionService;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionAuditRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

@Service
public class ProviderConnectionService {

    private static final Logger logger = LoggerFactory.getLogger(ProviderConnectionService.class);
    private static final String SYSTEM_OWNER = "system";
    private static final Duration VERIFY_TIMEOUT = Duration.ofSeconds(8);

    private final ProviderConnectionRepository repository;
    private final ProviderConnectionAuditRepository auditRepository;
    private final com.cc01cc.p.xihe.cp.repository.ProviderCredentialLeaseRepository leaseRepository;
    private final ProviderCatalogService catalog;
    private final EnvelopeEncryptionService encryption;
    private final ObjectMapper objectMapper;
    private final HttpClient httpClient;

    public ProviderConnectionService(
            ProviderConnectionRepository repository,
            ProviderConnectionAuditRepository auditRepository,
            com.cc01cc.p.xihe.cp.repository.ProviderCredentialLeaseRepository leaseRepository,
            ProviderCatalogService catalog,
            @Qualifier("providerCredentialEncryption") EnvelopeEncryptionService encryption,
            ObjectMapper objectMapper) {
        this.repository = repository;
        this.auditRepository = auditRepository;
        this.leaseRepository = leaseRepository;
        this.catalog = catalog;
        this.encryption = encryption;
        this.objectMapper = objectMapper;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }

    @Transactional(readOnly = true)
    public List<ProviderConnectionView> listVisible() {
        return listVisibleEntities().stream().map(this::toView).toList();
    }

    @Transactional(readOnly = true)
    public List<ProviderConnection> listVisibleEntities() {
        String userId = requireUserId();
        List<ProviderConnection> connections = new ArrayList<>();
        connections.addAll(repository.findByOwnerTypeAndOwnerId(ProviderConnection.OWNER_USER, userId));
        String workspaceId = TenantContext.getWorkspaceId();
        if (workspaceId != null && !workspaceId.isBlank()) {
            connections.addAll(repository.findByOwnerTypeAndOwnerId(
                    ProviderConnection.OWNER_WORKSPACE, workspaceId));
        }
        connections.addAll(repository.findByOwnerTypeAndOwnerId(
                ProviderConnection.OWNER_SYSTEM, SYSTEM_OWNER));
        return connections;
    }

    @Transactional
    public ProviderConnection create(ConnectionInput input) {
        String userId = requireUserId();
        String scope = normalizeScope(input.scope());
        String ownerId = resolveOwnerId(scope, userId);
        JsonNode definition = catalog.require(input.providerId());
        String baseUrl = normalizeBaseUrl(input.baseUrl(), definition);
        validateBaseUrl(baseUrl);
        String apiKey = blankToNull(input.apiKey());
        if (catalog.requiresCredential(input.providerId()) && apiKey == null) {
            throw new IllegalArgumentException("Provider requires an API key");
        }
        if (repository.findByOwnerTypeAndOwnerIdAndProviderId(scope, ownerId, input.providerId()).isPresent()) {
            throw new IllegalArgumentException("A connection already exists for this provider and scope");
        }

        ProviderConnection connection = new ProviderConnection();
        connection.setId(UUID.randomUUID());
        connection.setOwnerType(scope);
        connection.setOwnerId(ownerId);
        connection.setProviderId(input.providerId());
        connection.setLabel(requireLabel(input.label()));
        connection.setBaseUrl(baseUrl);
        connection.setCredentialCiphertext(encryptCredential(connection, apiKey));
        connection.setEncryptionKeyVersion(encryption.currentVersion());
        connection.setEnabled(true);
        connection.setStatus(ProviderConnection.STATUS_VERIFYING);
        connection.setModelDiscovery(input.modelDiscovery() == null || input.modelDiscovery().isBlank()
                ? definition.path("modelDiscovery").asText("remote-models")
                : input.modelDiscovery());
        connection.setManualModels(serializeModels(input.manualModels()));
        ProviderConnection saved = repository.save(connection);
        audit(saved, "CREATED", null, saved.getStatus());
        return saved;
    }

    @Transactional
    public ProviderConnection update(String id, ConnectionInput input) {
        ProviderConnection connection = requireVisible(id);
        ensureCanManage(connection);
        if (input.label() != null) connection.setLabel(requireLabel(input.label()));
        if (input.baseUrl() != null) {
            String baseUrl = normalizeBaseUrl(input.baseUrl(), catalog.require(connection.getProviderId()));
            validateBaseUrl(baseUrl);
            connection.setBaseUrl(baseUrl);
        }
        if (input.modelDiscovery() != null && !input.modelDiscovery().isBlank()) {
            connection.setModelDiscovery(input.modelDiscovery());
        }
        if (input.manualModels() != null) connection.setManualModels(serializeModels(input.manualModels()));
        String apiKey = blankToNull(input.apiKey());
        if (apiKey != null) {
            connection.setCredentialCiphertext(encryptCredential(connection, apiKey));
            // PLAN-0307 T2.24 (review P1-7): keep the stored key version in sync
            // with the ciphertext produced by the active key.
            connection.setEncryptionKeyVersion(encryption.currentVersion());
        }
        if (input.hasChanges()) {
            connection.setRevision(connection.getRevision() + 1);
            if (Boolean.FALSE.equals(input.enabled())) {
                connection.setEnabled(false);
                connection.setStatus(ProviderConnection.STATUS_DISABLED);
            } else {
                connection.setEnabled(true);
                connection.setStatus(ProviderConnection.STATUS_VERIFYING);
            }
            connection.setLastErrorCode(null);
            connection.setLastVerifiedAt(null);
        }
        ProviderConnection saved = repository.save(connection);
        audit(saved, "UPDATED", null, saved.getStatus());
        return saved;
    }

    @Transactional
    public ProviderConnection verify(String id) {
        ProviderConnection connection = requireVisible(id);
        ensureCanManage(connection);
        String previousStatus = connection.getStatus();
        connection.setStatus(ProviderConnection.STATUS_VERIFYING);
        connection.setLastErrorCode(null);
        repository.save(connection);

        if ("manual".equals(connection.getModelDiscovery())) {
            if (connection.getManualModels() == null || connection.getManualModels().isBlank()) {
                return markVerificationFailure(connection, "LLM_MODEL_CATALOG_INVALID", previousStatus);
            }
            return markReady(connection, previousStatus);
        }

        String apiKey = decryptCredential(connection);
        String baseUrl = connection.getBaseUrl();
        if (baseUrl == null || baseUrl.isBlank()) {
            return markVerificationFailure(connection, "LLM_PROVIDER_BASE_URL_MISSING", previousStatus);
        }
        try {
            HttpRequest.Builder builder = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl.replaceAll("/$", "") + "/models"))
                    .timeout(VERIFY_TIMEOUT)
                    .header("Accept", "application/json")
                    .GET();
            if (apiKey != null) builder.header("Authorization", "Bearer " + apiKey);
            HttpResponse<String> response = httpClient.send(builder.build(), HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() == 401 || response.statusCode() == 403) {
                return markVerificationFailure(connection, "LLM_CREDENTIALS_INVALID", previousStatus);
            }
            if (response.statusCode() >= 400) {
                return markVerificationFailure(connection, "LLM_PROVIDER_UNREACHABLE", previousStatus);
            }
            JsonNode body = objectMapper.readTree(response.body());
            if (body == null || !body.path("data").isArray()) {
                return markVerificationFailure(connection, "LLM_MODEL_CATALOG_INVALID", previousStatus);
            }
            return markReady(connection, previousStatus);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return markVerificationFailure(connection, "LLM_PROVIDER_INTERRUPTED", previousStatus);
        } catch (Exception e) {
            logger.warn("Provider verification failed provider={} connectionId={} errorType={}",
                    connection.getProviderId(), connection.getId(), e.getClass().getSimpleName());
            return markVerificationFailure(connection, "LLM_PROVIDER_UNREACHABLE", previousStatus);
        }
    }

    @Transactional
    public void delete(String id) {
        ProviderConnection connection = requireVisible(id);
        ensureCanManage(connection);
        revokeLeases(connection.getId().toString());
        audit(connection, "DELETED", connection.getStatus(), "DELETED");
        repository.delete(connection);
    }

    private void revokeLeases(String connectionId) {
        Instant now = Instant.now();
        List<ProviderCredentialLease> leases =
                leaseRepository.findByProviderConnectionIdAndRedeemedAtIsNullAndRevokedAtIsNull(connectionId);
        for (ProviderCredentialLease lease : leases) lease.setRevokedAt(now);
        if (!leases.isEmpty()) leaseRepository.saveAll(leases);
    }

    public ProviderConnection requireVisible(String id) {
        ProviderConnection connection = repository.findById(UUID.fromString(id))
                .orElseThrow(() -> new IllegalArgumentException("Provider connection not found"));
        String userId = requireUserId();
        if (ProviderConnection.OWNER_USER.equals(connection.getOwnerType())
                && userId.equals(connection.getOwnerId())) return connection;
        if (ProviderConnection.OWNER_WORKSPACE.equals(connection.getOwnerType())
                && connection.getOwnerId().equals(TenantContext.getWorkspaceId())) return connection;
        if (ProviderConnection.OWNER_SYSTEM.equals(connection.getOwnerType())) return connection;
        throw new IllegalArgumentException("Provider connection is not accessible");
    }

    public ProviderConnection requireUsable(String id) {
        ProviderConnection connection = requireVisible(id);
        if (!connection.isEnabled() || !ProviderConnection.STATUS_READY.equals(connection.getStatus())) {
            throw new IllegalArgumentException("Provider connection is not ready");
        }
        return connection;
    }

    public ProviderConnection requireUsableForOwner(String id, String userId, String workspaceId) {
        ProviderConnection connection = repository.findById(UUID.fromString(id))
                .orElseThrow(() -> new IllegalArgumentException("Provider connection not found"));
        boolean visible = (ProviderConnection.OWNER_USER.equals(connection.getOwnerType())
                && connection.getOwnerId().equals(userId))
                || (ProviderConnection.OWNER_WORKSPACE.equals(connection.getOwnerType())
                && connection.getOwnerId().equals(workspaceId))
                || ProviderConnection.OWNER_SYSTEM.equals(connection.getOwnerType());
        if (!visible || !connection.isEnabled() || !ProviderConnection.STATUS_READY.equals(connection.getStatus())) {
            throw new IllegalArgumentException("Provider connection is not ready or not accessible");
        }
        return connection;
    }

    public ProviderConnectionView view(ProviderConnection connection) {
        return toView(connection);
    }

    private void ensureCanManage(ProviderConnection connection) {
        if (ProviderConnection.OWNER_USER.equals(connection.getOwnerType())) {
            if (!requireUserId().equals(connection.getOwnerId())) {
                throw new IllegalArgumentException("Provider connection is not writable");
            }
            return;
        }
        if (ProviderConnection.OWNER_WORKSPACE.equals(connection.getOwnerType())) {
            String role = TenantContext.getWorkspaceRole();
            if (!connection.getOwnerId().equals(TenantContext.getWorkspaceId())
                    || !("OWNER".equals(role) || "ADMIN".equals(role)
                    || "ADMIN".equals(TenantContext.getUserRole()))) {
                throw new IllegalArgumentException("Workspace provider connection is not writable");
            }
            return;
        }
        if (!"ADMIN".equals(TenantContext.getUserRole())) {
            throw new IllegalArgumentException("System provider connection is not writable");
        }
    }

    private String resolveOwnerId(String scope, String userId) {
        if (ProviderConnection.OWNER_USER.equals(scope)) return userId;
        if (ProviderConnection.OWNER_WORKSPACE.equals(scope)) {
            String workspaceId = TenantContext.getWorkspaceId();
            String role = TenantContext.getWorkspaceRole();
            if (workspaceId == null || !("OWNER".equals(role) || "ADMIN".equals(role)
                    || "ADMIN".equals(TenantContext.getUserRole()))) {
                throw new IllegalArgumentException("Workspace administrator permission is required");
            }
            return workspaceId;
        }
        throw new IllegalArgumentException("System provider connections are not created through this endpoint");
    }

    private String normalizeScope(String scope) {
        String normalized = scope == null || scope.isBlank()
                ? ProviderConnection.OWNER_USER : scope.trim().toUpperCase(Locale.ROOT);
        if (!ProviderConnection.OWNER_USER.equals(normalized)
                && !ProviderConnection.OWNER_WORKSPACE.equals(normalized)) {
            throw new IllegalArgumentException("Unsupported provider connection scope");
        }
        return normalized;
    }

    private String normalizeBaseUrl(String input, JsonNode definition) {
        if (input != null && !input.isBlank()) return input.trim().replaceAll("/$", "");
        JsonNode value = definition.get("defaultBaseUrl");
        return value == null || value.isNull() ? null : value.asText().replaceAll("/$", "");
    }

    private void validateBaseUrl(String value) {
        if (value == null || value.isBlank()) return;
        try {
            URI uri = URI.create(value);
            if (!("http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme()))) {
                throw new IllegalArgumentException("Base URL must use http or https");
            }
            if (uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null) {
                throw new IllegalArgumentException("Base URL must not contain credentials, query or fragment");
            }
            if (value.length() > 2048) throw new IllegalArgumentException("Base URL is too long");
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("Invalid provider Base URL", e);
        }
    }

    private String encryptCredential(ProviderConnection connection, String apiKey) {
        if (apiKey == null || apiKey.isBlank()) return null;
        return encryption.encrypt(apiKey, aad(connection));
    }

    private String decryptCredential(ProviderConnection connection) {
        if (connection.getCredentialCiphertext() == null || connection.getCredentialCiphertext().isBlank()) return null;
        return encryption.decrypt(connection.getCredentialCiphertext(), aad(connection));
    }

    private String aad(ProviderConnection connection) {
        return connection.getProviderId() + "|" + connection.getOwnerType() + "|"
                + connection.getOwnerId() + "|" + connection.getId();
    }

    private ProviderConnection markReady(ProviderConnection connection, String previousStatus) {
        connection.setStatus(ProviderConnection.STATUS_READY);
        connection.setLastVerifiedAt(Instant.now());
        connection.setLastErrorCode(null);
        ProviderConnection saved = repository.save(connection);
        audit(saved, "VERIFIED", previousStatus, saved.getStatus());
        return saved;
    }

    private ProviderConnection markVerificationFailure(
            ProviderConnection connection, String code, String previousStatus) {
        connection.setStatus(code.endsWith("CREDENTIALS_INVALID")
                ? ProviderConnection.STATUS_INVALID_CREDENTIALS
                : ProviderConnection.STATUS_UNREACHABLE);
        connection.setLastErrorCode(code);
        ProviderConnection saved = repository.save(connection);
        audit(saved, "VERIFY_FAILED", previousStatus, saved.getStatus());
        return saved;
    }

    private void audit(ProviderConnection connection, String action, String fromStatus, String toStatus) {
        ProviderConnectionAudit entry = new ProviderConnectionAudit();
        entry.setId(UUID.randomUUID());
        entry.setProviderConnectionId(connection.getId().toString());
        entry.setOwnerType(connection.getOwnerType());
        entry.setOwnerId(connection.getOwnerId());
        entry.setProviderId(connection.getProviderId());
        entry.setAction(action);
        String changedBy = TenantContext.getUserId();
        entry.setChangedBy(changedBy == null || changedBy.isBlank() ? "internal-service" : changedBy);
        entry.setFromStatus(fromStatus);
        entry.setToStatus(toStatus);
        String credential = decryptCredential(connection);
        entry.setCredentialPresent(credential != null && !credential.isBlank());
        entry.setCredentialLast4(credential == null || credential.length() < 4
                ? null : credential.substring(credential.length() - 4));
        entry.setConnectionRevision(connection.getRevision());
        auditRepository.save(entry);
    }

    private String serializeModels(List<String> models) {
        if (models == null) return null;
        try {
            return objectMapper.writeValueAsString(models);
        } catch (Exception e) {
            throw new IllegalArgumentException("Manual model list is invalid", e);
        }
    }

    private String requireLabel(String value) {
        if (value == null || value.isBlank() || value.length() > 128) {
            throw new IllegalArgumentException("Connection label is required");
        }
        return value.trim();
    }

    private String requireUserId() {
        String userId = TenantContext.getUserId();
        if (userId == null || userId.isBlank()) throw new IllegalArgumentException("Authentication required");
        return userId;
    }

    private String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    private ProviderConnectionView toView(ProviderConnection connection) {
        String masked = null;
        String credential = decryptCredential(connection);
        if (credential != null && !credential.isBlank()) {
            masked = credential.length() <= 4 ? "****" : "****" + credential.substring(credential.length() - 4);
        }
        return new ProviderConnectionView(
                connection.getId().toString(), connection.getProviderId(), connection.getLabel(),
                connection.getOwnerType(), connection.getOwnerId(), connection.getBaseUrl(),
                credential != null, masked, connection.isEnabled(), connection.getStatus(),
                connection.getLastVerifiedAt(), connection.getLastErrorCode(), connection.getRevision());
    }

    public record ConnectionInput(
            String providerId,
            String label,
            String scope,
            String apiKey,
            String baseUrl,
            String modelDiscovery,
            List<String> manualModels,
            Boolean enabled) {
        public boolean hasChanges() {
            return label != null || apiKey != null || baseUrl != null
                    || modelDiscovery != null || manualModels != null || enabled != null;
        }
    }

    public record ProviderConnectionView(
            String id,
            String providerId,
            String label,
            String scope,
            String ownerId,
            String baseUrl,
            boolean hasKey,
            String maskedKey,
            boolean enabled,
            String status,
            Instant lastVerifiedAt,
            String lastErrorCode,
            long revision) {}
}
