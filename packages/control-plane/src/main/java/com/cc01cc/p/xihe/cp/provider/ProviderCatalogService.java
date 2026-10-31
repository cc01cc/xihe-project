package com.cc01cc.p.xihe.cp.provider;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.core.type.TypeReference;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

@Service
public class ProviderCatalogService {

    private static final Logger logger = LoggerFactory.getLogger(ProviderCatalogService.class);

    private final List<JsonNode> definitions;
    private final Set<String> providerIds;
    private final ObjectMapper objectMapper;
    private final ApiInputTypeService apiTypes;

    @Autowired
    public ProviderCatalogService(ObjectMapper objectMapper, ApiInputTypeService apiTypes) {
        this(objectMapper, apiTypes, new ClassPathResource("provider-catalog/providers.json"));
    }

    /** PLAN-0591 T1.2: test-only seam; production wiring keeps the classpath catalog. */
    ProviderCatalogService(ObjectMapper objectMapper, ApiInputTypeService apiTypes, Resource catalogResource) {
        this.objectMapper = objectMapper;
        this.apiTypes = apiTypes;
        try (var input = catalogResource.getInputStream()) {
            JsonNode root = objectMapper.readTree(input);
            if (!root.isArray()) {
                throw new IllegalStateException("Provider catalog must be a JSON array");
            }
            List<JsonNode> loaded = new ArrayList<>();
            root.forEach(loaded::add);
            definitions = List.copyOf(loaded);
            validate();
            providerIds = definitions.stream()
                    .map(definition -> definition.path("id").asText())
                    .collect(Collectors.toUnmodifiableSet());
        } catch (IOException | RuntimeException e) {
            logger.error("Provider catalog initialization failed", e);
            throw new IllegalStateException("Provider catalog initialization failed", e);
        }
    }

    private void validate() {
        for (JsonNode definition : definitions) {
            String providerId = definition.path("id").asText();
            JsonNode supported = definition.get("supportedApiTypes");
            JsonNode defaultType = definition.get("defaultApiType");
            if (!supported.isArray() || supported.isEmpty() || defaultType == null || !defaultType.isObject()) {
                throw new IllegalStateException("Provider catalog entry lacks API Type pairs: " + providerId);
            }
            String defaultId = defaultType.path("apiTypeId").asText();
            int defaultVersion = defaultType.path("version").asInt();
            if (!apiTypes.contains(defaultId, defaultVersion)) {
                throw new IllegalStateException("Provider default API Type is not registered: " + providerId);
            }
            boolean defaultAllowed = false;
            int declared = 0;
            boolean anyTools = false;
            boolean allTools = true;
            int visionDeclared = 0;
            boolean anyVision = false;
            boolean allVision = true;
            for (JsonNode pair : supported) {
                String typeId = pair.path("apiTypeId").asText();
                int version = pair.path("version").asInt();
                if (!apiTypes.contains(typeId, version)) {
                    throw new IllegalStateException("Provider supported API Type is not registered: " + providerId);
                }
                if (typeId.equals(defaultId) && version == defaultVersion) {
                    defaultAllowed = true;
                }
                JsonNode capability = pair.get("capability");
                if (capability == null || capability.isNull()) {
                    logger.warn("Provider capability missing; treated as unsupported provider={} apiType={}@{}",
                            providerId, typeId, version);
                    allTools = false;
                    allVision = false;
                    continue;
                }
                if (!capability.isObject()) {
                    throw new IllegalStateException("Provider capability must be an object: " + providerId);
                }
                JsonNode tools = capability.get("tools");
                if (tools == null || tools.isNull()) {
                    logger.warn("Provider capability.tools missing; treated as unsupported provider={} apiType={}@{}",
                            providerId, typeId, version);
                    allTools = false;
                } else if (!tools.isBoolean()) {
                    throw new IllegalStateException("Provider capability.tools must be boolean: " + providerId);
                } else {
                    declared++;
                    anyTools |= tools.asBoolean();
                    allTools &= tools.asBoolean();
                }
                // PLAN-0605: per-API-Type vision capability. Missing = unsupported (fail-closed);
                // provider-level `supports.vision` is only a declaration and may stay true while the
                // per-pair value is still "待证" (verified=false), so equality is not enforced.
                JsonNode vision = capability.get("vision");
                if (vision == null || vision.isNull()) {
                    logger.warn("Provider capability.vision missing; treated as unsupported provider={} apiType={}@{}",
                            providerId, typeId, version);
                    allVision = false;
                } else if (!vision.isBoolean()) {
                    throw new IllegalStateException("Provider capability.vision must be boolean: " + providerId);
                } else {
                    visionDeclared++;
                    anyVision |= vision.asBoolean();
                    allVision &= vision.asBoolean();
                }
            }
            if (!defaultAllowed) {
                throw new IllegalStateException("Provider default API Type is not supported: " + providerId);
            }
            if (declared == supported.size()) {
                JsonNode supports = definition.get("supports");
                JsonNode supportsTools = supports == null ? null : supports.get("tools");
                if (supportsTools != null && supportsTools.isBoolean() && supportsTools.asBoolean() != anyTools) {
                    throw new IllegalStateException(
                            "Provider supports.tools disagrees with capabilities: " + providerId);
                }
                JsonNode partial = supports == null ? null : supports.get("toolsPartial");
                boolean expectedPartial = anyTools && !allTools;
                if (partial != null && partial.isBoolean() && partial.asBoolean() != expectedPartial) {
                    throw new IllegalStateException(
                            "Provider supports.toolsPartial disagrees with capabilities: " + providerId);
                }
                if (visionDeclared == supported.size()) {
                    JsonNode visionPartial = supports == null ? null : supports.get("visionPartial");
                    boolean expectedVisionPartial = anyVision && !allVision;
                    if (visionPartial != null && visionPartial.isBoolean()
                            && visionPartial.asBoolean() != expectedVisionPartial) {
                        throw new IllegalStateException(
                                "Provider supports.visionPartial disagrees with capabilities: " + providerId);
                    }
                    JsonNode supportsVision = supports == null ? null : supports.get("vision");
                    if (supportsVision != null && supportsVision.isBoolean() && supportsVision.asBoolean()
                            && !anyVision) {
                        logger.warn("Provider supports.vision=true but no apiType is verified vision-capable yet "
                                + "(待证) provider={}", providerId);
                    }
                } else if (visionDeclared > 0) {
                    logger.warn("Provider capability.vision partially declared; aggregate check skipped provider={} "
                            + "declared={}/{}", providerId, visionDeclared, supported.size());
                }
            } else if (declared > 0) {
                logger.warn("Provider capability.tools partially declared; aggregate check skipped provider={} declared={}/{}",
                        providerId, declared, supported.size());
            }
        }
    }

    public List<Map<String, Object>> list() {
        return definitions.stream()
                .map(definition -> objectMapper.convertValue(
                        definition, new TypeReference<Map<String, Object>>() {}))
                .toList();
    }

    /**
     * PLAN-0503 T1.1: the catalog id set is the single source for provider
     * acceptance in config validation (replaces the legacy inline whitelist).
     */
    public Set<String> providerIds() {
        return providerIds;
    }

    public JsonNode require(String providerId) {
        return definitions.stream()
                .filter(definition -> providerId.equals(definition.path("id").asText()))
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Unsupported provider: " + providerId));
    }

    public String defaultBaseUrl(String providerId) {
        ApiTypeRef type = defaultApiType(providerId);
        JsonNode value = supportedPair(providerId, type.apiTypeId(), type.version()).get("defaultBaseUrl");
        return value == null || value.isNull() ? null : value.asText();
    }

    public JsonNode supportedPair(String providerId, String apiTypeId, int version) {
        JsonNode definition = require(providerId);
        for (JsonNode pair : definition.path("supportedApiTypes")) {
            if (apiTypeId.equals(pair.path("apiTypeId").asText())
                    && version == pair.path("version").asInt()) {
                var resolved = ((com.fasterxml.jackson.databind.node.ObjectNode) pair).deepCopy();
                for (String field : List.of("defaultBaseUrl", "modelDiscovery")) {
                    if (!pair.has(field) && definition.has(field)) {
                        resolved.set(field, definition.get(field));
                    }
                }
                return resolved;
            }
        }
        throw new IllegalArgumentException("Unsupported provider API Type pair: " + providerId);
    }

    /**
     * PLAN-0591: the single capability decision source. Missing/explicit-null
     * {@code capability.tools} is treated as unsupported at runtime.
     */
    public boolean toolsSupported(String providerId, String apiTypeId, int version) {
        JsonNode tools = supportedPair(providerId, apiTypeId, version).path("capability").get("tools");
        return tools != null && tools.isBoolean() && tools.asBoolean();
    }

    /**
     * PLAN-0605: the single vision decision source, mirroring {@link #toolsSupported}.
     * Missing/explicit-null {@code capability.vision} is treated as unsupported at
     * runtime; provider-level {@code supports.vision} is a declaration only.
     */
    public boolean visionSupported(String providerId, String apiTypeId, int version) {
        JsonNode vision = supportedPair(providerId, apiTypeId, version).path("capability").get("vision");
        return vision != null && vision.isBoolean() && vision.asBoolean();
    }

    public boolean requiresCredential(String providerId) {
        return require(providerId).path("credential").path("required").asBoolean(true);
    }

    public String adapter(String providerId) {
        return require(providerId).path("adapter").asText();
    }

    public ApiTypeRef defaultApiType(String providerId) {
        JsonNode value = require(providerId).path("defaultApiType");
        String apiTypeId = value.path("apiTypeId").asText();
        int version = value.path("version").asInt();
        apiTypes.require(apiTypeId, version);
        return new ApiTypeRef(apiTypeId, version, apiTypes.operation(apiTypeId, version));
    }

    public record ApiTypeRef(String apiTypeId, int version, String operation) {}
}
