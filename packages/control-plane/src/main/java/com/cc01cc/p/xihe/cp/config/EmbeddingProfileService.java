package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.entity.ConfigEntity;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.provider.ApiInputTypeService;
import com.cc01cc.p.xihe.cp.provider.ProviderCredentialLeaseService;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0485: embedding profile resolution.
 *
 * A layer profile is one complete unit of exactly providerId + connectionKey +
 * model (round-4 item 1); layers never merge fields and a partial profile fails
 * closed. Workspace overrides User as a whole; both absent resolves to nothing.
 * `XIHE_EMBEDDING_MODEL` stays env-first, but only the V1 model is compatible
 * (round-4 item 1 and design §Configuration Migration).
 */
@Service
public class EmbeddingProfileService {

    public static final String DOMAIN = "embedding";
    static final String FIXED_MODEL = "tongyi-embedding-vision-flash-2026-03-06";
    static final int FIXED_DIMENSION = 768;
    static final String EMBEDDING_TYPE_ID = "dashscope-multimodal-embedding";
    static final int EMBEDDING_TYPE_VERSION = 1;

    private final ConfigJpaRepository configs;
    private final ProviderConnectionRepository connections;
    private final EnvOverlayRegistry envOverlay;
    private final ApiInputTypeService apiTypes;
    private final ObjectMapper json;

    /** Validated, complete single-layer profile as stored under one config key. */
    public record LayerProfile(String providerId, String connectionKey, String model) {
    }

    /** Non-secret resolved profile handed to Agent and the UI (spec §Resolved Profile). */
    public record ResolvedProfile(
            UUID workspaceId,
            UUID userId,
            String connectionOwnerType,
            String connectionOwnerId,
            String providerConnectionId,
            String providerId,
            String connectionKey,
            long connectionRevision,
            String apiTypeId,
            int apiTypeVersion,
            String modelId,
            int dimension,
            String profileScope,
            String connectionOwnerScope,
            String modelSource) {
    }

    /**
     * Parse and validate one layer's `profile` config value. Empty/absent means
     * the layer inherits; anything present must be the complete three-field unit.
     */
    public LayerProfile parseProfile(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        JsonNode node;
        try {
            node = json.readTree(raw);
        } catch (Exception e) {
            throw new CpApiException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "INVALID_REQUEST", "Embedding profile is not valid JSON");
        }
        if (node == null || !node.isObject()) {
            throw invalidProfile();
        }
        String providerId = node.path("providerId").asText(null);
        String connectionKey = node.path("connectionKey").asText(null);
        String model = node.path("model").asText(null);
        if (isBlank(providerId) || isBlank(connectionKey) || isBlank(model)) {
            throw invalidProfile();
        }
        if (node.size() != 3) {
            throw invalidProfile();
        }
        if (!FIXED_MODEL.equals(model)) {
            throw new CpApiException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "EMBEDDING_MODEL_UNSUPPORTED", "Embedding model is not supported");
        }
        return new LayerProfile(providerId, connectionKey, model);
    }

    /** Effective whole-layer profile: workspace wins whole, else user; no merge. */
    public EffectiveProfile effectiveProfile(UUID userId, UUID workspaceId) {
        LayerProfile workspace = workspaceId == null
                ? null : readLayer("workspace", workspaceId);
        if (workspace != null) {
            return checkEnv(new EffectiveProfile(workspace, "workspace"));
        }
        LayerProfile user = userId == null ? null : readLayer("user", userId);
        if (user != null) {
            return checkEnv(new EffectiveProfile(user, "user"));
        }
        return checkEnv(new EffectiveProfile(null, null));
    }

    public record EffectiveProfile(LayerProfile profile, String profileScope) {
    }

    /**
     * Resolve the effective profile to a concrete usable embedding connection
     * using the 0439 owner rules: same-key Workspace record wins when usable,
     * otherwise the same-key User record; other keys are never considered.
     */
    public ResolvedProfile resolve(UUID userId, UUID workspaceId) {
        EffectiveProfile effective = effectiveProfile(userId, workspaceId);
        if (effective.profile() == null) {
            throw new CpApiException(org.springframework.http.HttpStatus.CONFLICT,
                    "EMBEDDING_PROFILE_REQUIRED", "No embedding profile is configured");
        }
        LayerProfile profile = effective.profile();
        ProviderConnection workspaceConnection = workspaceId == null ? null : findOwningConnection(
                "WORKSPACE", workspaceId.toString(), profile);
        ProviderConnection connection = workspaceConnection != null
                ? workspaceConnection
                : findOwningConnection("USER", userId.toString(), profile);
        if (connection == null) {
            throw new CpApiException(org.springframework.http.HttpStatus.CONFLICT,
                    "EMBEDDING_PROFILE_CONFLICT", "No usable embedding connection matches the profile");
        }
        if (!FIXED_MODEL.equals(profile.model())) {
            throw new CpApiException(org.springframework.http.HttpStatus.CONFLICT,
                    "EMBEDDING_MODEL_UNSUPPORTED", "Embedding model is not supported");
        }
        if (!EMBEDDING_TYPE_ID.equals(connection.getApiTypeId())
                || connection.getApiTypeVersion() != EMBEDDING_TYPE_VERSION) {
            throw new CpApiException(org.springframework.http.HttpStatus.CONFLICT,
                    "EMBEDDING_PROFILE_CONFLICT", "Connection API Type is not the embedding type");
        }
        return new ResolvedProfile(
                workspaceId,
                userId,
                connection.getOwnerType(),
                connection.getOwnerId(),
                connection.getId().toString(),
                connection.getProviderId(),
                connection.getConnectionKey(),
                connection.getRevision(),
                connection.getApiTypeId(),
                connection.getApiTypeVersion(),
                profile.model(),
                FIXED_DIMENSION,
                effective.profileScope(),
                connection.getOwnerType().toLowerCase(java.util.Locale.ROOT),
                "profile");
    }

    /** Issue the embedding credential lease for a resolved profile. */
    public ProviderCredentialLeaseService.IssuedLease issueLease(
            ResolvedProfile profile,
            String userId,
            String workspaceId,
            String sessionId,
            String runId) {
        return leaseService.issue(userId, workspaceId, sessionId, runId,
                profile.providerConnectionId(), profile.providerId(), profile.modelId(),
                profile.connectionRevision());
    }

    private final com.cc01cc.p.xihe.cp.provider.ProviderCredentialLeaseService leaseService;

    public EmbeddingProfileService(ConfigJpaRepository configs,
                                   ProviderConnectionRepository connections,
                                   EnvOverlayRegistry envOverlay,
                                   ApiInputTypeService apiTypes,
                                   com.cc01cc.p.xihe.cp.provider.ProviderCredentialLeaseService leaseService,
                                   ObjectMapper json) {
        this.configs = configs;
        this.connections = connections;
        this.envOverlay = envOverlay;
        this.apiTypes = apiTypes;
        this.leaseService = leaseService;
        this.json = json;
    }

    private LayerProfile readLayer(String layer, UUID ownerId) {
        Optional<ConfigEntity> entity;
        if ("workspace".equals(layer)) {
            entity = configs.findByWorkspaceIdAndDomainAndConfigKey(ownerId, DOMAIN, "profile");
        } else {
            entity = configs.findByUserIdAndDomainAndConfigKey(ownerId, DOMAIN, "profile");
        }
        String raw = entity.map(ConfigEntity::getConfigValue).orElse(null);
        if (raw == null) {
            // Legacy key shapes are not accepted; only the whole-profile key exists.
            return null;
        }
        return parseProfile(raw);
    }

    private ProviderConnection findOwningConnection(String ownerType, String ownerId, LayerProfile profile) {
        ProviderConnection connection = connections
                .findByOwnerTypeAndOwnerIdAndProviderIdAndConnectionKey(
                        ownerType, ownerId, profile.providerId(), profile.connectionKey())
                .orElse(null);
        if (connection == null || !connection.isEnabled()
                || !ProviderConnection.STATUS_READY.equals(connection.getStatus())) {
            return null;
        }
        return connection;
    }

    private EffectiveProfile checkEnv(EffectiveProfile effective) {
        Map<String, String> overrides = envOverlay.activeOverrides(DOMAIN);
        String envModel = overrides.get("model");
        if (envModel == null) {
            return effective;
        }
        if (effective.profile() != null && !FIXED_MODEL.equals(effective.profile().model())) {
            throw conflictEnv();
        }
        if (!FIXED_MODEL.equals(envModel)) {
            throw conflictEnv();
        }
        return effective;
    }

    private CpApiException conflictEnv() {
        return new CpApiException(org.springframework.http.HttpStatus.CONFLICT,
                "EMBEDDING_PROFILE_CONFLICT",
                "XIHE_EMBEDDING_MODEL does not match the supported embedding model");
    }

    private CpApiException invalidProfile() {
        return new CpApiException(org.springframework.http.HttpStatus.BAD_REQUEST,
                "INVALID_REQUEST",
                "Embedding profile must be a complete providerId/connectionKey/model unit");
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    /** Sanitized view for the settings UI and test endpoint (spec §Settings). */
    public Map<String, Object> describe(ResolvedProfile profile) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("providerId", profile.providerId());
        view.put("connectionKey", profile.connectionKey());
        view.put("providerConnectionId", profile.providerConnectionId());
        view.put("connectionOwnerScope", profile.connectionOwnerScope());
        view.put("connectionRevision", profile.connectionRevision());
        view.put("modelId", profile.modelId());
        view.put("dimension", profile.dimension());
        view.put("profileScope", profile.profileScope());
        view.put("modelSource", profile.modelSource());
        return view;
    }

    /** Whole-layer write validator shared by PUT/import/delete (round-4 item 1). */
    public String validateLayerValue(String layer, String value) {
        LayerProfile parsed = parseProfile(value);
        return parsed == null ? null : json.valueToTree(parsed).toString();
    }

    public List<String> profileKeys() {
        return List.of("profile");
    }
}
