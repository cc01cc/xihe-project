package com.cc01cc.p.xihe.cp.provider;

import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.ProviderConnectionAudit;
import com.cc01cc.p.xihe.cp.entity.ProviderCredentialLease;
import com.cc01cc.p.xihe.cp.crypto.EnvelopeEncryptionService;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionAuditRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.core.type.TypeReference;
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
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;

@Service
public class ProviderConnectionService {

    private static final Logger logger = LoggerFactory.getLogger(ProviderConnectionService.class);
    private static final Duration VERIFY_TIMEOUT = Duration.ofSeconds(8);
    private static final Pattern CONNECTION_KEY_PATTERN =
            Pattern.compile("[a-z0-9]+(?:-[a-z0-9]+)*");
    private static final java.util.Set<String> MODEL_DISCOVERY_VALUES =
            java.util.Set.of("remote-models", "litellm-catalog", "curated", "manual");

    private final ProviderConnectionRepository repository;
    private final ProviderConnectionAuditRepository auditRepository;
    private final com.cc01cc.p.xihe.cp.repository.ProviderCredentialLeaseRepository leaseRepository;
    private final ProviderCatalogService catalog;
    private final ApiInputTypeService apiTypes;
    private final EnvelopeEncryptionService encryption;
    private final ObjectMapper objectMapper;
    private final com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService requestTemplates;
    // ConfigService field-injects ProviderConnectionService, so a constructor
    // dependency here would be an unresolvable cycle; ObjectProvider defers the
    // resolution to first use (same pattern as ApiRequestTemplateService in
    // ConfigService).
    private final org.springframework.beans.factory.ObjectProvider<com.cc01cc.p.xihe.cp.config.ConfigService> configService;
    private final HttpClient httpClient;

    public ProviderConnectionService(
            ProviderConnectionRepository repository,
            ProviderConnectionAuditRepository auditRepository,
            com.cc01cc.p.xihe.cp.repository.ProviderCredentialLeaseRepository leaseRepository,
            ProviderCatalogService catalog,
            ApiInputTypeService apiTypes,
            @Qualifier("providerCredentialEncryption") EnvelopeEncryptionService encryption,
            ObjectMapper objectMapper,
            com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService requestTemplates,
            org.springframework.beans.factory.ObjectProvider<com.cc01cc.p.xihe.cp.config.ConfigService> configService) {
        this.repository = repository;
        this.auditRepository = auditRepository;
        this.leaseRepository = leaseRepository;
        this.catalog = catalog;
        this.apiTypes = apiTypes;
        this.encryption = encryption;
        this.objectMapper = objectMapper;
        this.requestTemplates = requestTemplates;
        this.configService = configService;
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
        return connections;
    }

    /** Bounded config export projection; plaintext is populated only on the audited admin path. */
    public record ConfigExportView(UUID id, String providerId, String label, String ownerType,
                                   String ownerId, String baseUrl, String status, boolean enabled,
                                   String connectionKey, String apiTypeId, int apiTypeVersion,
                                   String modelDiscovery, String manualModels, String apiKey) {}

    /**
     * PLAN-0470: ConfigService consumes a provider-owned export projection, not
     * ProviderConnection entities. Credential plaintext is materialized only
     * when the caller's already-authorized export explicitly requests secrets.
     */
    @Transactional(readOnly = true)
    public List<ConfigExportView> listForConfigExport(boolean includeSecrets) {
        return repository.findAll().stream()
                .map(connection -> new ConfigExportView(
                        connection.getId(), connection.getProviderId(), connection.getLabel(),
                        connection.getOwnerType(), connection.getOwnerId(), connection.getBaseUrl(),
                        connection.getStatus(), connection.isEnabled(), connection.getConnectionKey(),
                        connection.getApiTypeId(), connection.getApiTypeVersion(),
                        connection.getModelDiscovery(), connection.getManualModels(),
                        includeSecrets ? decryptCredential(connection) : null))
                .toList();
    }

    /** PLAN-0470: connection count for the config export audit record. */
    @Transactional(readOnly = true)
    public long countForConfigExport() {
        return repository.count();
    }

    /**
     * PLAN-0504: ready connection lookup by logical key, consumed by the
     * llm-provider profile write validation and profile resolution (the
     * connection is identified by owner scope + provider + connectionKey; V57
     * unique constraint). Returns empty unless the connection is enabled and
     * READY.
     */
    @Transactional(readOnly = true)
    public Optional<ProviderConnection> findReadyByKey(String ownerType, String ownerId,
                                                       String provider, String connectionKey) {
        return repository.findByOwnerTypeAndOwnerIdAndProviderIdAndConnectionKey(
                        ownerType, ownerId, provider, connectionKey)
                .filter(connection -> connection.isEnabled()
                        && ProviderConnection.STATUS_READY.equals(connection.getStatus()));
    }

    @Transactional
    public ProviderConnection create(ConnectionInput input) {
        return create(input, null, null);
    }

    @Transactional
    public ProviderConnection create(ConnectionInput input, String apiTypeId, Integer apiTypeVersion) {
        String userId = requireUserId();
        String scope = normalizeScope(input.scope());
        String ownerId = resolveOwnerId(scope, userId);
        String connectionKey = requireConnectionKey(input.connectionKey());
        ProviderCatalogService.ApiTypeRef defaultType = catalog.defaultApiType(input.providerId());
        if (apiTypeId != null && apiTypeVersion != null) {
            catalog.supportedPair(input.providerId(), apiTypeId, apiTypeVersion);
            defaultType = new ProviderCatalogService.ApiTypeRef(apiTypeId, apiTypeVersion, apiTypes.operation(apiTypeId, apiTypeVersion));
        }
        JsonNode pair = catalog.supportedPair(input.providerId(), defaultType.apiTypeId(), defaultType.version());
        String baseUrl = normalizeBaseUrl(input.baseUrl(), pair);
        validateBaseUrl(baseUrl, defaultType.apiTypeId(), defaultType.version());
        String apiKey = blankToNull(input.apiKey());
        if (catalog.requiresCredential(input.providerId()) && apiKey == null) {
            throw new IllegalArgumentException("Provider requires an API key");
        }
        if (repository.findByOwnerTypeAndOwnerIdAndProviderIdAndConnectionKey(
                scope, ownerId, input.providerId(), connectionKey).isPresent()) {
            throw new KeyConflictException("A connection already exists for this provider, key and scope");
        }

        ProviderConnection connection = new ProviderConnection();
        connection.setId(UUID.randomUUID());
        connection.setOwnerType(scope);
        connection.setOwnerId(ownerId);
        connection.setProviderId(input.providerId());
        connection.setConnectionKey(connectionKey);
        connection.setApiTypeId(defaultType.apiTypeId());
        connection.setApiTypeVersion(defaultType.version());
        connection.setLabel(requireLabel(input.label()));
        connection.setBaseUrl(baseUrl);
        connection.setCredentialCiphertext(encryptCredential(connection, apiKey));
        connection.setEncryptionKeyVersion(encryption.currentVersion());
        connection.setEnabled(true);
        connection.setStatus(ProviderConnection.STATUS_VERIFYING);
        connection.setModelDiscovery(requireModelDiscovery(
                input.modelDiscovery() == null || input.modelDiscovery().isBlank()
                ? pair.path("modelDiscovery").asText("remote-models")
                : input.modelDiscovery()));
        connection.setManualModels(serializeModels(input.manualModels()));
        ProviderConnection saved = repository.save(connection);
        audit(saved, "CREATED", null, saved.getStatus());
        return saved;
    }

    @Transactional
    public ProviderConnection update(String id, ConnectionInput input) {
        ProviderConnection connection = requestTemplates.lockConnection(id);
        requireVisible(id);
        ensureCanManage(connection);
        if (input.connectionKey() != null
                && !input.connectionKey().equals(connection.getConnectionKey())) {
            throw new KeyImmutableException("Connection key cannot be changed");
        }
        if (input.label() != null) {
            connection.setLabel(requireLabel(input.label()));
        }
        if (input.baseUrl() != null) {
            String baseUrl = normalizeBaseUrl(input.baseUrl(), catalog.supportedPair(
                    connection.getProviderId(), connection.getApiTypeId(), connection.getApiTypeVersion()));
            validateBaseUrl(baseUrl, connection.getApiTypeId(), connection.getApiTypeVersion());
            connection.setBaseUrl(baseUrl);
        }
        if (input.modelDiscovery() != null && !input.modelDiscovery().isBlank()) {
            connection.setModelDiscovery(requireModelDiscovery(input.modelDiscovery()));
        }
        if (input.manualModels() != null) {
            connection.setManualModels(serializeModels(input.manualModels()));
        }
        String apiKey = blankToNull(input.apiKey());
        if (apiKey != null) {
            connection.setCredentialCiphertext(encryptCredential(connection, apiKey));
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
            if (apiKey != null) {
                builder.header("Authorization", "Bearer " + apiKey);
            }
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
        ProviderConnection connection = requestTemplates.lockConnection(id);
        requireVisible(id);
        ensureCanManage(connection);
        // PLAN-0505 I6: session references block the delete inside the same
        // transaction and connection lock as the cleanup below (no
        // check-then-act window against SessionService.bindProviderConnection,
        // which takes the same lock since this PLAN).
        long sessionCount = requestTemplates.sessionReferenceCount(connection.getId().toString());
        if (sessionCount > 0) {
            throw new SessionBlockedException(connection.getId().toString(), sessionCount);
        }
        var counts = requestTemplates.cleanupReferences(connection);
        int removedProfiles = configService.getObject().cleanupProfiles(
                connection.getProviderId(), connection.getConnectionKey(),
                connection.getOwnerType(), UUID.fromString(connection.getOwnerId()),
                TenantContext.getUserId());
        revokeLeases(connection.getId().toString());
        audit(connection, "DELETED", connection.getStatus(), "DELETED");
        logger.info("Provider connection deleted connectionId={} removedBindings={} removedDefaultTemplate={} "
                        + "bindingScopes={} removedProfiles={} sessionCount={}",
                connection.getId(), counts.removedBindings(), counts.removedDefaultTemplate(),
                counts.bindingScopes(), removedProfiles, sessionCount);
        repository.delete(connection);
    }

    /** PLAN-0505 I6: the delete is rejected while sessions reference the connection. */
    public static class SessionBlockedException extends RuntimeException {
        private final String connectionId;
        private final long sessionCount;

        public SessionBlockedException(String connectionId, long sessionCount) {
            super("Connection is referenced by " + sessionCount + " session(s); delete or rebind them first");
            this.connectionId = connectionId;
            this.sessionCount = sessionCount;
        }

        public String getConnectionId() {
            return connectionId;
        }

        public long getSessionCount() {
            return sessionCount;
        }
    }

    /** PLAN-0505 T2.1: read-only delete impact preview (no locks, no writes). */
    @Transactional(readOnly = true)
    public java.util.Map<String, Object> deleteImpact(String id) {
        ProviderConnection connection = requireVisible(id);
        ensureCanManage(connection);
        java.util.Map<String, Object> impact =
                new java.util.LinkedHashMap<>(requestTemplates.deleteImpact(connection));
        var profileHits = configService.getObject().profileImpact(
                connection.getProviderId(), connection.getConnectionKey(),
                connection.getOwnerType(), UUID.fromString(connection.getOwnerId()));
        impact.put("profileCount", profileHits.size());
        impact.put("profileScopes", profileHits.stream()
                .map(com.cc01cc.p.xihe.cp.config.ConfigService.ProfileHit::layer).distinct().toList());
        return impact;
    }

    private void revokeLeases(String connectionId) {
        Instant now = Instant.now();
        List<ProviderCredentialLease> leases =
                leaseRepository.findByProviderConnectionIdAndRedeemedAtIsNullAndRevokedAtIsNull(connectionId);
        for (ProviderCredentialLease lease : leases) {
            lease.setRevokedAt(now);
        }
        if (!leases.isEmpty()) {
            leaseRepository.saveAll(leases);
        }
    }

    public ProviderConnection requireVisible(String id) {
        ProviderConnection connection = repository.findById(UUID.fromString(id))
                .orElseThrow(() -> new IllegalArgumentException("Provider connection not found"));
        String userId = requireUserId();
        if (ProviderConnection.OWNER_USER.equals(connection.getOwnerType())
                && userId.equals(connection.getOwnerId())) {
            return connection;
        }
        if (ProviderConnection.OWNER_WORKSPACE.equals(connection.getOwnerType())
                && connection.getOwnerId().equals(TenantContext.getWorkspaceId())) {
            return connection;
        }
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
                && connection.getOwnerId().equals(workspaceId));
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
        throw new IllegalArgumentException("Provider connection owner type is not writable");
    }

    @Transactional(readOnly = true)
    public java.util.Map<String, Object> typeImpact(String id, String type, int version) {
        ProviderConnection connection = requireVisible(id);
        ensureCanManage(connection);
        catalog.supportedPair(connection.getProviderId(), type, version);
        return requestTemplates.impact(connection, type, version);
    }

    @Transactional
    public ProviderConnection updateType(String id, ConnectionInput input, String type, Integer version,
                                          Long expectedRevision, JsonNode defaultRef, boolean confirmed) {
        ProviderConnection connection = requestTemplates.lockConnection(id);
        requireVisible(id);
        ensureCanManage(connection);
        if (expectedRevision != null && connection.getRevision() != expectedRevision) {
            throw com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService.conflict("CONNECTION_REVISION_CHANGED", "Refresh the impact preview");
        }
        boolean changed = type != null && (!connection.getApiTypeId().equals(type) || connection.getApiTypeVersion() != version);
        if (changed && (expectedRevision == null || !confirmed || ("chat".equals(apiTypes.operation(type, version)) && defaultRef == null))) {
            throw com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService.invalid("Type change requires revision, confirmation and compatible default");
        }
        long previous = connection.getRevision();
        if (type != null) {
            catalog.supportedPair(connection.getProviderId(), type, version);
            connection.setApiTypeId(type);
            connection.setApiTypeVersion(version);
            validateBaseUrl(connection.getBaseUrl(), type, version);
        }
        repository.saveAndFlush(connection);
        if (defaultRef != null || changed) {
            requestTemplates.changeConnectionDefault(connection, defaultRef);
        }
        ProviderConnection updated = update(id, input);
        if (changed && updated.getRevision() == previous) {
            updated.setRevision(previous + 1);
        }
        return repository.saveAndFlush(updated);
    }

    private String resolveOwnerId(String scope, String userId) {
        if (ProviderConnection.OWNER_USER.equals(scope)) {
            return userId;
        }
        if (ProviderConnection.OWNER_WORKSPACE.equals(scope)) {
            String workspaceId = TenantContext.getWorkspaceId();
            String role = TenantContext.getWorkspaceRole();
            if (workspaceId == null || !("OWNER".equals(role) || "ADMIN".equals(role)
                    || "ADMIN".equals(TenantContext.getUserRole()))) {
                throw new IllegalArgumentException("Workspace administrator permission is required");
            }
            return workspaceId;
        }
        throw new IllegalArgumentException("Unsupported provider connection scope");
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

    private String requireConnectionKey(String value) {
        if (value == null || value.isBlank() || value.length() > 64
                || !CONNECTION_KEY_PATTERN.matcher(value).matches()) {
            throw new KeyInvalidException("Connection key must be a 1-64 character lowercase slug");
        }
        return value;
    }

    private String requireModelDiscovery(String value) {
        if (!MODEL_DISCOVERY_VALUES.contains(value)) {
            throw new IllegalArgumentException("Unsupported model discovery mode");
        }
        return value;
    }

    private String normalizeBaseUrl(String input, JsonNode definition) {
        if (input != null && !input.isBlank()) {
            return input.trim().replaceAll("/$", "");
        }
        JsonNode value = definition.get("defaultBaseUrl");
        return value == null || value.isNull() ? null : value.asText().replaceAll("/$", "");
    }

    private void validateBaseUrl(String value, String apiTypeId, int apiTypeVersion) {
        if (value == null || value.isBlank()) {
            return;
        }
        try {
            URI uri = URI.create(value);
            if (!("http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme()))) {
                throw new IllegalArgumentException("Base URL must use http or https");
            }
            if (uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null) {
                throw new IllegalArgumentException("Base URL must not contain credentials, query or fragment");
            }
            if (value.length() > 2048) {
                throw new IllegalArgumentException("Base URL is too long");
            }
            String requiredSuffix = apiTypes.requiredBaseSuffix(apiTypeId, apiTypeVersion);
            if (!requiredSuffix.isEmpty() && !value.endsWith(requiredSuffix)) {
                throw new IllegalArgumentException(
                        "Base URL must end with the API Type path prefix " + requiredSuffix);
            }
            // PLAN-0485 spec §API Type: the embedding type contract pins this
            // host (probe evidence: the workspace endpoint rejected the key).
            // This is a type-contract pin, not a generic policy — other types
            // keep legitimate custom endpoints.
            if ("dashscope-multimodal-embedding".equals(apiTypeId)) {
                String host = uri.getHost();
                if (host == null || !host.equalsIgnoreCase("dashscope.aliyuncs.com")) {
                    throw new IllegalArgumentException(
                            "This embedding API Type only supports the pinned dashscope.aliyuncs.com host");
                }
            }
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("Invalid provider Base URL", e);
        }
    }

    private String encryptCredential(ProviderConnection connection, String apiKey) {
        if (apiKey == null || apiKey.isBlank()) {
            return null;
        }
        return encryption.encrypt(apiKey, aad(connection));
    }

    private String decryptCredential(ProviderConnection connection) {
        if (connection.getCredentialCiphertext() == null || connection.getCredentialCiphertext().isBlank()) {
            return null;
        }
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
        entry.setCredentialPresent(connection.getCredentialCiphertext() != null
                && !connection.getCredentialCiphertext().isBlank());
        entry.setCredentialLast4(null);
        entry.setConnectionRevision(connection.getRevision());
        auditRepository.save(entry);
    }

    private String serializeModels(List<String> models) {
        if (models == null) {
            return null;
        }
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
        if (userId == null || userId.isBlank()) {
            throw new IllegalArgumentException("Authentication required");
        }
        return userId;
    }

    private String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    private ProviderConnectionView toView(ProviderConnection connection) {
        String operation = apiTypes.operation(connection.getApiTypeId(), connection.getApiTypeVersion());
        boolean hasKey = connection.getCredentialCiphertext() != null
                && !connection.getCredentialCiphertext().isBlank();
        return new ProviderConnectionView(
                connection.getId().toString(), connection.getProviderId(), connection.getLabel(),
                connection.getOwnerType(), connection.getOwnerId(), connection.getBaseUrl(),
                connection.getConnectionKey(), connection.getApiTypeId(), connection.getApiTypeVersion(),
                operation, hasKey, null, connection.isEnabled(), connection.getStatus(),
                connection.getLastVerifiedAt(), connection.getLastErrorCode(), connection.getRevision(),
                connection.getModelDiscovery(), readManualModels(connection));
    }

    private List<String> readManualModels(ProviderConnection connection) {
        String value = connection.getManualModels();
        if (value == null || value.isBlank()) {
            return List.of();
        }
        try {
            List<String> models = objectMapper.readValue(value, new TypeReference<List<String>>() {});
            if (models == null) {
                throw new IllegalStateException("Stored manual model list is invalid");
            }
            return models;
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            logger.warn("Manual model list read failed connectionId={} errorType={}",
                    connection.getId(), e.getClass().getSimpleName());
            throw new IllegalStateException("Stored manual model list is invalid", e);
        }
    }

    public record ConnectionInput(
            String providerId,
            String label,
            String scope,
            String apiKey,
            String baseUrl,
            String modelDiscovery,
            List<String> manualModels,
            Boolean enabled,
            String connectionKey) {
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
            String connectionKey,
            String apiTypeId,
            int apiTypeVersion,
            String operation,
            boolean hasKey,
            String maskedKey,
            boolean enabled,
            String status,
            Instant lastVerifiedAt,
            String lastErrorCode,
            long revision,
            String modelDiscovery,
            List<String> manualModels) {}

    public static final class KeyInvalidException extends IllegalArgumentException {
        public KeyInvalidException(String message) { super(message); }
    }

    public static final class KeyConflictException extends IllegalStateException {
        public KeyConflictException(String message) { super(message); }
    }

    public static final class KeyImmutableException extends IllegalStateException {
        public KeyImmutableException(String message) { super(message); }
    }
}
