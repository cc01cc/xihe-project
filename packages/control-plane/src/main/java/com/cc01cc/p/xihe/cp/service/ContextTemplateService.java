package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.ConfigDomainSchema;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Resolves immutable, layer-scoped Context Template revisions. */
@Service
public class ContextTemplateService {

    public static final String DOMAIN = "context-templates";
    public static final UUID BUILTIN_TEMPLATE_ID = UUID.fromString("00000000-0000-4000-8000-000000000001");
    private static final UUID BUILTIN_PROMPT_COMPONENT = UUID.fromString("00000000-0000-4000-8000-000000000011");
    private static final UUID BUILTIN_HISTORY_COMPONENT = UUID.fromString("00000000-0000-4000-8000-000000000012");
    private static final Pattern COMPONENT_MARKER = Pattern.compile("\\{\\{component:([0-9a-fA-F-]{36})}}");

    private final ConfigService configService;
    private final ConfigDomainSchema schema;
    private final ObjectMapper objectMapper;

    public ContextTemplateService(ConfigService configService, ConfigDomainSchema schema,
                                  ObjectMapper objectMapper) {
        this.configService = configService;
        this.schema = schema;
        this.objectMapper = objectMapper;
    }

    public Map<String, String> readLayer(String layer, UUID userId, UUID workspaceId) {
        requireLayer(layer);
        Map<String, String> stored = configService.layerEntries(layer, DOMAIN, userId, workspaceId);
        if ("instance".equals(layer) && stored.isEmpty()) {
            return builtinEntries();
        }
        return normalizedEntries(stored);
    }

    @Transactional
    public void putLayer(String layer, Map<String, String> entries, String changedBy,
                         UUID userId, UUID workspaceId) {
        requireLayer(layer);
        if (entries == null) {
            throw invalid("Configuration body is required");
        }
        Map<String, String> stored = configService.layerEntries(layer, DOMAIN, userId, workspaceId);
        ObjectNode proposed = parseEntries(entries);
        ObjectNode current = parseEntries(stored);
        normalize(proposed);
        normalize(current);

        List<String> schemaErrors = schema.validate(DOMAIN, proposed);
        if (!schemaErrors.isEmpty()) {
            throw invalid("Invalid context template configuration: " + String.join("; ", schemaErrors));
        }
        validateLayerShape(layer, proposed);
        // Append-only conflict must be reported before per-set structural checks:
        // a dropped historical revision is a 409 immutability violation, not a
        // fresh invalid proposal.
        validateAppendOnly(current.path("templates"), proposed.path("templates"));
        validateTemplateSet(proposed);
        validateReferences(layer, proposed);

        Map<String, String> serialized = new LinkedHashMap<>();
        serialized.put("templates", writeJson(proposed.path("templates")));
        for (String key : List.of("defaultTemplate", "userDefault", "providerModelDefaults")) {
            if (proposed.has(key)) {
                serialized.put(key, writeJson(proposed.path(key)));
            } else {
                configService.deleteKey(layer, DOMAIN, key, changedBy, userId, workspaceId);
            }
        }
        configService.putLayer(layer, DOMAIN, serialized, changedBy, userId, workspaceId);
    }

    public TemplateBinding resolveForSession(String userId, String workspaceId, String provider,
                                             String model, TemplateSelection explicit) {
        UUID user = uuid(userId, "userId");
        UUID workspace = uuid(workspaceId, "workspaceId");
        if (explicit != null) {
            return binding(explicit.layer(), explicit.templateId(), explicit.version(), "explicit", user, workspace);
        }

        ObjectNode userConfig = parseEntries(configService.layerEntries("user", DOMAIN, user, workspace));
        JsonNode providerDefaults = userConfig.path("providerModelDefaults");
        if (providerDefaults.isArray()) {
            for (JsonNode candidate : providerDefaults) {
                if (same(candidate.path("provider").asText(), provider)
                        && same(candidate.path("model").asText(), model)) {
                    return binding("user", candidate.path("templateId").asText(),
                            candidate.path("version").asInt(), "provider-model", user, workspace);
                }
            }
        }
        JsonNode userDefault = userConfig.get("userDefault");
        if (userDefault != null && userDefault.isObject()) {
            return binding(userDefault.path("layer").asText(), userDefault.path("templateId").asText(),
                    userDefault.path("version").asInt(), "user-default", user, workspace);
        }

        ObjectNode instanceConfig = parseEntries(configService.layerEntries("instance", DOMAIN, null, null));
        JsonNode instanceDefault = instanceConfig.get("defaultTemplate");
        if (instanceDefault != null && instanceDefault.isObject()) {
            return binding("instance", instanceDefault.path("templateId").asText(),
                    instanceDefault.path("version").asInt(), "instance-default", user, workspace);
        }
        return binding("instance", BUILTIN_TEMPLATE_ID.toString(), 1, "builtin-default", user, workspace);
    }

    public TemplateBinding binding(String layer, String templateId, int version, String source,
                                   UUID userId, UUID workspaceId) {
        requireLayer(layer);
        UUID templateUuid = uuid(templateId, "templateId");
        if (version < 1) {
            throw invalid("template version must be positive");
        }
        ObjectNode template = findTemplateOrNull(layer, templateUuid.toString(), version, userId, workspaceId);
        if (template == null && "instance".equals(layer)
                && BUILTIN_TEMPLATE_ID.equals(templateUuid) && version == 1) {
            // Built-in default remains resolvable even after an instance-layer
            // write replaces the stored instance template set.
            template = builtinTemplate();
        }
        if (template == null) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "CONTEXT_TEMPLATE_NOT_FOUND",
                    "The selected context template revision does not exist in the requested layer");
        }
        ObjectNode snapshot = objectMapper.createObjectNode();
        snapshot.put("layer", layer);
        snapshot.put("templateId", templateUuid.toString());
        snapshot.put("version", version);
        snapshot.put("source", source);
        snapshot.set("template", template);
        return new TemplateBinding(layer, templateUuid.toString(), version, snapshot);
    }

    public ObjectNode resolveSnapshot(String layer, String templateId, int version,
                                      String userId, String workspaceId) {
        return binding(layer, templateId, version, "session-binding",
                uuid(userId, "userId"), uuid(workspaceId, "workspaceId")).snapshot();
    }

    private ObjectNode findTemplateOrNull(String layer, String templateId, int version,
                                          UUID userId, UUID workspaceId) {
        Map<String, String> entries = readLayer(layer, userId, workspaceId);
        ObjectNode config = parseEntries(entries);
        for (JsonNode template : config.path("templates")) {
            if (templateId.equalsIgnoreCase(template.path("id").asText())
                    && version == template.path("version").asInt()) {
                return (ObjectNode) template.deepCopy();
            }
        }
        return null;
    }

    private void validateReferences(String layer, ObjectNode config) {
        if (config.has("userDefault")) {
            JsonNode ref = config.path("userDefault");
            if (!"user".equals(layer) || !"user".equals(ref.path("layer").asText())) {
                throw invalid("userDefault must reference a template in the user layer");
            }
            requireRefIn(config, ref);
        }
        if (config.has("defaultTemplate")) {
            JsonNode ref = config.path("defaultTemplate");
            if (!"instance".equals(layer) || !"instance".equals(ref.path("layer").asText())) {
                throw invalid("defaultTemplate is only valid in the instance layer");
            }
            requireRefIn(config, ref);
        }
        JsonNode providerDefaults = config.path("providerModelDefaults");
        if (providerDefaults.isArray()) {
            Set<String> pairs = new HashSet<>();
            for (JsonNode item : providerDefaults) {
                String provider = item.path("provider").asText();
                String model = item.path("model").asText();
                if (!pairs.add(provider + "\u0000" + model)) {
                    throw invalid("providerModelDefaults contains a duplicate provider/model pair");
                }
                if (!"user".equals(layer)) {
                    throw invalid("providerModelDefaults is only valid in the user layer");
                }
                requireRefIn(config, item);
            }
        }
    }

    private void requireRefIn(ObjectNode config, JsonNode ref) {
        String id = ref.path("templateId").asText();
        int version = ref.path("version").asInt();
        boolean found = false;
        for (JsonNode template : config.path("templates")) {
            if (id.equalsIgnoreCase(template.path("id").asText())
                    && version == template.path("version").asInt()) {
                found = true;
                break;
            }
        }
        if (!found) {
            throw invalid("A template default must reference an immutable revision in the same layer");
        }
    }

    private void validateLayerShape(String layer, ObjectNode config) {
        if ("workspace".equals(layer)
                && (config.has("defaultTemplate") || config.has("userDefault")
                || (config.path("providerModelDefaults").isArray()
                && !config.path("providerModelDefaults").isEmpty()))) {
            throw invalid("Workspace templates may be explicitly bound, but cannot define defaults in v1");
        }
        if ("user".equals(layer) && config.has("defaultTemplate")) {
            throw invalid("defaultTemplate is reserved for the instance layer");
        }
        if ("instance".equals(layer)
                && (config.has("userDefault") || config.has("providerModelDefaults"))) {
            throw invalid("Instance templates may define only defaultTemplate");
        }
    }

    private void validateTemplateSet(ObjectNode config) {
        Map<String, JsonNode> versions = new HashMap<>();
        Map<String, Integer> latest = new HashMap<>();
        for (JsonNode template : config.path("templates")) {
            String id = template.path("id").asText().toLowerCase();
            int version = template.path("version").asInt();
            String key = id + ":" + version;
            if (versions.putIfAbsent(key, template) != null) {
                throw invalid("A template revision may appear only once");
            }
            latest.merge(id, version, Math::max);
            Set<String> componentIds = new HashSet<>();
            for (JsonNode component : template.path("components")) {
                String componentId = component.path("instanceId").asText().toLowerCase();
                if (!componentIds.add(componentId)) {
                    throw invalid("Component instanceId values must be unique within a template revision");
                }
            }
            validateMarkers(template.path("document").asText(), componentIds);
        }
        for (String id : latest.keySet()) {
            int max = latest.get(id);
            for (int version = 1; version <= max; version++) {
                if (!versions.containsKey(id + ":" + version)) {
                    throw invalid("Template revision numbers must be contiguous from 1");
                }
            }
        }
    }

    private void validateAppendOnly(JsonNode currentTemplates, JsonNode proposedTemplates) {
        Map<String, JsonNode> oldRevisions = revisions(currentTemplates);
        Map<String, Integer> oldLatest = latestVersions(currentTemplates);
        Map<String, Integer> newLatest = latestVersions(proposedTemplates);
        Map<String, JsonNode> newRevisions = revisions(proposedTemplates);
        for (Map.Entry<String, JsonNode> old : oldRevisions.entrySet()) {
            JsonNode retained = newRevisions.get(old.getKey());
            if (!old.getValue().equals(retained)) {
                throw new CpApiException(HttpStatus.CONFLICT, "CONTEXT_TEMPLATE_REVISION_IMMUTABLE",
                        "Existing context template revisions cannot be changed or deleted");
            }
        }
        for (Map.Entry<String, Integer> latest : newLatest.entrySet()) {
            int previous = oldLatest.getOrDefault(latest.getKey(), 0);
            if (latest.getValue() > previous && latest.getValue() != previous + 1) {
                throw invalid("A template update must append exactly the next revision");
            }
        }
    }

    private Map<String, JsonNode> revisions(JsonNode templates) {
        Map<String, JsonNode> result = new HashMap<>();
        if (templates.isArray()) {
            for (JsonNode template : templates) {
                result.put(template.path("id").asText().toLowerCase() + ":" + template.path("version").asInt(),
                        template);
            }
        }
        return result;
    }

    private Map<String, Integer> latestVersions(JsonNode templates) {
        Map<String, Integer> result = new HashMap<>();
        if (templates.isArray()) {
            for (JsonNode template : templates) {
                result.merge(template.path("id").asText().toLowerCase(),
                        template.path("version").asInt(), Math::max);
            }
        }
        return result;
    }

    private void validateMarkers(String document, Set<String> componentIds) {
        Matcher matcher = COMPONENT_MARKER.matcher(document);
        while (matcher.find()) {
            if (!componentIds.contains(matcher.group(1).toLowerCase())) {
                throw invalid("Template document references an unknown component instance");
            }
        }
        if (matcher.replaceAll("").contains("{{component:")) {
            throw invalid("Component marker must use {{component:<instanceId>}} syntax");
        }
    }

    private ObjectNode parseEntries(Map<String, String> entries) {
        ObjectNode root = objectMapper.createObjectNode();
        if (entries == null) {
            return root;
        }
        entries.forEach((key, value) -> {
            try {
                root.set(key, objectMapper.readTree(value));
            } catch (JsonProcessingException e) {
                root.put(key, value);
            }
        });
        return root;
    }

    private void normalize(ObjectNode root) {
        if (!root.has("templates")) {
            root.set("templates", objectMapper.createArrayNode());
        }
    }

    private Map<String, String> normalizedEntries(Map<String, String> entries) {
        Map<String, String> result = new LinkedHashMap<>(entries);
        result.putIfAbsent("templates", "[]");
        return result;
    }

    private Map<String, String> builtinEntries() {
        try {
            ObjectNode ref = objectMapper.createObjectNode().put("layer", "instance")
                    .put("templateId", BUILTIN_TEMPLATE_ID.toString()).put("version", 1);
            return Map.of("templates", objectMapper.writeValueAsString(
                            objectMapper.createArrayNode().add(builtinTemplate())),
                    "defaultTemplate", objectMapper.writeValueAsString(ref));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Unable to serialize built-in context template", e);
        }
    }

    private ObjectNode builtinTemplate() {
        try {
            ObjectNode template = objectMapper.createObjectNode();
            template.put("id", BUILTIN_TEMPLATE_ID.toString());
            template.put("version", 1);
            template.put("name", "默认上下文");
            template.put("description", "平台内置上下文模板");
            template.put("document", "{{component:" + BUILTIN_PROMPT_COMPONENT + "}}\n\n{{component:"
                    + BUILTIN_HISTORY_COMPONENT + "}}");
            ArrayNode components = objectMapper.createArrayNode();
            ObjectNode prompt = components.addObject();
            prompt.put("instanceId", BUILTIN_PROMPT_COMPONENT.toString());
            prompt.put("type", "system_prompt");
            prompt.put("enabled", true);
            prompt.set("config", objectMapper.createObjectNode().put("source", "system")
                    .put("includeAgentPrompt", true));
            ObjectNode history = components.addObject();
            history.put("instanceId", BUILTIN_HISTORY_COMPONENT.toString());
            history.put("type", "conversation_history");
            history.put("enabled", true);
            history.set("config", objectMapper.createObjectNode().put("selection", "recent")
                    .put("maxTurns", 20).put("maxTokens", 32000).put("includeCompaction", true));
            template.set("components", components);
            return template;
        } catch (RuntimeException e) {
            throw new IllegalStateException("Unable to build built-in context template", e);
        }
    }

    private String writeJson(JsonNode value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Unable to serialize context template config", e);
        }
    }

    private static void requireLayer(String layer) {
        if (!List.of("instance", "user", "workspace").contains(layer)) {
            throw invalid("layer must be instance, user or workspace");
        }
    }

    private static boolean same(String left, String right) {
        return right != null && left.equalsIgnoreCase(right.trim());
    }

    private static UUID uuid(String value, String field) {
        try {
            return UUID.fromString(value);
        } catch (RuntimeException e) {
            throw invalid(field + " must be a UUID");
        }
    }

    private static CpApiException invalid(String detail) {
        return new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_CONTEXT_TEMPLATE", detail);
    }

    public record TemplateSelection(String layer, String templateId, int version) {}

    public record TemplateBinding(String layer, String templateId, int version, ObjectNode snapshot) {}
}
