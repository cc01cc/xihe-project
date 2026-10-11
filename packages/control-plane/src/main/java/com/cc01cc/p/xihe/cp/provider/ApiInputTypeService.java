package com.cc01cc.p.xihe.cp.provider;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.core.type.TypeReference;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

@Service
public class ApiInputTypeService {

    private static final Logger logger = LoggerFactory.getLogger(ApiInputTypeService.class);
    private static final List<String> OPERATIONS = List.of("chat", "embedding");

    private final List<Map<String, Object>> definitions;

    public ApiInputTypeService(ObjectMapper objectMapper) {
        try (var input = new ClassPathResource("api-input-types/api-input-types.json").getInputStream()) {
            JsonNode root = objectMapper.readTree(input);
            if (!root.isArray()) {
                throw new IllegalStateException("API Type registry must be a JSON array");
            }
            List<Map<String, Object>> loaded = objectMapper.convertValue(
                    root, new TypeReference<List<Map<String, Object>>>() {});
            validate(loaded);
            definitions = loaded.stream().map(Map::copyOf).toList();
        } catch (IOException | RuntimeException e) {
            logger.error("API Type registry initialization failed", e);
            throw new IllegalStateException("API Type registry initialization failed", e);
        }
    }

    private void validate(List<Map<String, Object>> loaded) {
        java.util.Set<String> keys = new java.util.HashSet<>();
        for (Map<String, Object> definition : loaded) {
            String id = Objects.toString(definition.get("apiTypeId"), "");
            int version = definition.get("version") instanceof Integer integer ? integer : -1;
            String operation = Objects.toString(definition.get("operation"), "");
            if (id.isBlank() || version < 1 || !OPERATIONS.contains(operation)) {
                throw new IllegalStateException("Invalid API Type definition");
            }
            for (String field : List.of("method", "path", "requestShape", "responseShape", "streamShape", "requiredBaseSuffix")) {
                if (!(definition.get(field) instanceof String value) || value.isBlank()) {
                    throw new IllegalStateException("API Type missing contract field: " + field);
                }
            }
            if (!"POST".equals(definition.get("method"))
                    || !Objects.toString(definition.get("path"), "").startsWith("/")
                    || !Objects.toString(definition.get("requiredBaseSuffix"), "").startsWith("/")) {
                throw new IllegalStateException("Invalid API Type method/path/base suffix");
            }
            if (definition.values().stream().anyMatch(value -> !(value instanceof String)
                    && !(value instanceof Integer))) {
                throw new IllegalStateException("API Type contract fields must be immutable scalar values");
            }
            if (!keys.add(id + "@" + version)) {
                throw new IllegalStateException("Duplicate API Type id/version: " + id + "@" + version);
            }
        }
    }

    public List<Map<String, Object>> list() {
        return definitions;
    }

    public Optional<Map<String, Object>> find(String apiTypeId, int version) {
        return definitions.stream()
                .filter(definition -> apiTypeId.equals(definition.get("apiTypeId"))
                        && definition.get("version") instanceof Number number
                        && number.intValue() == version)
                .findFirst();
    }

    public Map<String, Object> require(String apiTypeId, int version) {
        return find(apiTypeId, version)
                .orElseThrow(() -> new IllegalArgumentException("Unsupported API Type: " + apiTypeId + "@" + version));
    }

    public boolean contains(String apiTypeId, int version) {
        return find(apiTypeId, version).isPresent();
    }

    public String operation(String apiTypeId, int version) {
        return Objects.toString(require(apiTypeId, version).get("operation"), "");
    }

    /** Static base-URL path prefix required by this API Type (e.g. `/v1`). */
    public String requiredBaseSuffix(String apiTypeId, int version) {
        return Objects.toString(require(apiTypeId, version).get("requiredBaseSuffix"), "");
    }
}
