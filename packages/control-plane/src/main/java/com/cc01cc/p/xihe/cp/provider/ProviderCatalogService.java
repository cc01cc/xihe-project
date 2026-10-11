package com.cc01cc.p.xihe.cp.provider;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.core.type.TypeReference;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

@Service
public class ProviderCatalogService {

    private static final Logger logger = LoggerFactory.getLogger(ProviderCatalogService.class);

    private final List<JsonNode> definitions;
    private final ObjectMapper objectMapper;
    private final ApiInputTypeService apiTypes;

    public ProviderCatalogService(ObjectMapper objectMapper, ApiInputTypeService apiTypes) {
        this.objectMapper = objectMapper;
        this.apiTypes = apiTypes;
        try (var input = new ClassPathResource("provider-catalog/providers.json").getInputStream()) {
            JsonNode root = objectMapper.readTree(input);
            if (!root.isArray()) {
                throw new IllegalStateException("Provider catalog must be a JSON array");
            }
            List<JsonNode> loaded = new ArrayList<>();
            root.forEach(loaded::add);
            definitions = List.copyOf(loaded);
            validate();
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
            for (JsonNode pair : supported) {
                String typeId = pair.path("apiTypeId").asText();
                int version = pair.path("version").asInt();
                if (!apiTypes.contains(typeId, version)) {
                    throw new IllegalStateException("Provider supported API Type is not registered: " + providerId);
                }
                if (typeId.equals(defaultId) && version == defaultVersion) {
                    defaultAllowed = true;
                }
            }
            if (!defaultAllowed) {
                throw new IllegalStateException("Provider default API Type is not supported: " + providerId);
            }
        }
    }

    public List<Map<String, Object>> list() {
        return definitions.stream()
                .map(definition -> objectMapper.convertValue(
                        definition, new TypeReference<Map<String, Object>>() {}))
                .toList();
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
