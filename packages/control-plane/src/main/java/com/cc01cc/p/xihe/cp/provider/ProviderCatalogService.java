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

    public ProviderCatalogService(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
        try (var input = new ClassPathResource("provider-catalog/providers.json").getInputStream()) {
            JsonNode root = objectMapper.readTree(input);
            if (!root.isArray()) {
                throw new IllegalStateException("Provider catalog must be a JSON array");
            }
            List<JsonNode> loaded = new ArrayList<>();
            root.forEach(loaded::add);
            definitions = List.copyOf(loaded);
        } catch (IOException | RuntimeException e) {
            logger.error("Provider catalog initialization failed", e);
            throw new IllegalStateException("Provider catalog initialization failed", e);
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
        JsonNode value = require(providerId).get("defaultBaseUrl");
        return value == null || value.isNull() ? null : value.asText();
    }

    public boolean requiresCredential(String providerId) {
        return require(providerId).path("credential").path("required").asBoolean(true);
    }

    public String adapter(String providerId) {
        return require(providerId).path("adapter").asText();
    }
}
