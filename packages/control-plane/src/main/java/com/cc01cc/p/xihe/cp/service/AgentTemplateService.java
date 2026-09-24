package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.ConfigDomainSchema;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

@Service
public class AgentTemplateService {

    private static final Logger logger = LoggerFactory.getLogger(AgentTemplateService.class);
    private static final String DOMAIN = "agent-templates";

    private final ConfigService configService;
    private final ConfigDomainSchema schemaValidator;
    private final UserRepository userRepository;
    private final WorkspaceRepository workspaceRepository;
    private final WorkspaceUserRepository workspaceUserRepository;
    private final AuthorizationGrantRepository grantRepository;
    private final GrantIntersectionEvaluator evaluator;
    private final ObjectMapper objectMapper;

    public AgentTemplateService(ConfigService configService,
                                ConfigDomainSchema schemaValidator,
                                UserRepository userRepository,
                                WorkspaceRepository workspaceRepository,
                                WorkspaceUserRepository workspaceUserRepository,
                                AuthorizationGrantRepository grantRepository,
                                GrantIntersectionEvaluator evaluator,
                                ObjectMapper objectMapper) {
        this.configService = configService;
        this.schemaValidator = schemaValidator;
        this.userRepository = userRepository;
        this.workspaceRepository = workspaceRepository;
        this.workspaceUserRepository = workspaceUserRepository;
        this.grantRepository = grantRepository;
        this.evaluator = evaluator;
        this.objectMapper = objectMapper;
    }

    @Transactional(readOnly = true)
    public ResolvedTemplate resolveForCreation(String actorUserId, String workspaceId, String templateId) {
        UUID actorId = parseUuid(actorUserId, "INVALID_ACTOR");
        User actor = userRepository.findById(actorId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "USER_NOT_FOUND", "User not found"));
        UUID workspaceUuid = workspaceId == null || workspaceId.isBlank()
                ? null : parseUuid(workspaceId, "INVALID_WORKSPACE");
        if (workspaceUuid != null) {
            workspaceRepository.findByIdAndDeletedAtIsNull(workspaceUuid)
                    .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND,
                            "WORKSPACE_NOT_FOUND", "Workspace not found"));
            workspaceUserRepository.findByIdWorkspaceIdAndIdUserId(workspaceUuid, actorId)
                    .orElseThrow(() -> new CpApiException(HttpStatus.FORBIDDEN,
                            "WORKSPACE_ACCESS_DENIED", "Workspace membership is required"));
        }
        if (templateId == null || templateId.isBlank()) {
            return new ResolvedTemplate("default", defaultSnapshot(actorId));
        }
        parseUuid(templateId, "INVALID_TEMPLATE_ID");

        List<ConfigScope> readableScopes = new ArrayList<>();
        if (workspaceUuid != null) {
            readableScopes.add(new ConfigScope("workspace", null, workspaceUuid));
        }
        readableScopes.add(new ConfigScope("user", actorId, null));
        if (actor.getRole() == UserRole.ADMIN) {
            readableScopes.add(new ConfigScope("instance", null, null));
        }

        List<ResolvedTemplate> matches = new ArrayList<>();
        for (ConfigScope scope : readableScopes) {
            Map<String, String> entries = configService.layerEntries(
                    scope.layer(), DOMAIN, scope.userId(), scope.workspaceId());
            if (entries.isEmpty()) {
                continue;
            }
            ObjectNode config = parseLayer(scope, entries);
            String storedTemplateId = findTemplate(config, templateId, scope.layer());
            if (storedTemplateId != null) {
                matches.add(new ResolvedTemplate(scope.layer(), snapshotFromTemplate(config, storedTemplateId)));
            }
        }
        if (matches.isEmpty()) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "AGENT_TEMPLATE_NOT_FOUND",
                    "No readable Agent template matches the selected ID");
        }
        if (matches.size() != 1) {
            throw new CpApiException(HttpStatus.CONFLICT, "AGENT_TEMPLATE_ID_AMBIGUOUS",
                    "The selected Agent template ID appears in multiple readable config layers");
        }
        return matches.get(0);
    }

    private JsonNode defaultSnapshot(UUID creatorId) {
        Set<GrantIntersectionEvaluator.PermissionAtom> userPermissions = evaluator.union(
                grantRepository.findBySubjectTypeAndSubjectId(GrantPrincipalPathResolver.USER, creatorId));
        ObjectNode snapshot = objectMapper.createObjectNode();
        snapshot.putNull("templateId");
        snapshot.putNull("templateName");
        snapshot.putNull("roleId");
        snapshot.putNull("roleName");
        snapshot.set("permissions", toJson(userPermissions));
        return snapshot;
    }

    private ObjectNode parseLayer(ConfigScope scope, Map<String, String> entries) {
        ObjectNode config = objectMapper.createObjectNode();
        for (Map.Entry<String, String> entry : entries.entrySet()) {
            String raw = entry.getValue();
            String trimmed = raw == null ? "" : raw.trim();
            try {
                JsonNode value = trimmed.startsWith("{") || trimmed.startsWith("[")
                        ? objectMapper.readTree(trimmed) : objectMapper.getNodeFactory().textNode(raw);
                config.set(entry.getKey(), value);
            } catch (JsonProcessingException e) {
                logger.error("Invalid stored Agent template config JSON: layer={}, key={}, errorType={}",
                        scope.layer(), entry.getKey(), e.getClass().getSimpleName());
                throw new CpApiException(HttpStatus.CONFLICT, "AGENT_TEMPLATE_CONFIG_INVALID",
                        "Stored Agent template configuration is invalid", e);
            }
        }
        if (!config.has("roles")) {
            config.putArray("roles");
        }
        if (!config.has("templates")) {
            config.putArray("templates");
        }
        List<String> errors = schemaValidator.validate(DOMAIN, config);
        if (!errors.isEmpty()) {
            logger.error("Stored Agent template config failed schema validation: layer={}, errorCount={}",
                    scope.layer(), errors.size());
            throw new CpApiException(HttpStatus.CONFLICT, "AGENT_TEMPLATE_CONFIG_INVALID",
                    "Stored Agent template configuration is invalid");
        }
        return config;
    }

    private String findTemplate(ObjectNode config, String templateId, String layer) {
        ArrayNode templates = (ArrayNode) config.get("templates");
        String matchedId = null;
        for (JsonNode template : templates) {
            String id = text(template, "id");
            if (templateId.equals(id)) {
                if (matchedId != null) {
                    logger.error("Duplicate Agent template ID in config scope: layer={}", layer);
                    throw new CpApiException(HttpStatus.CONFLICT, "AGENT_TEMPLATE_CONFIG_INVALID",
                            "Stored Agent template IDs are not unique");
                }
                matchedId = id;
            }
        }
        return matchedId;
    }

    private JsonNode snapshotFromTemplate(ObjectNode config, String templateId) {
        ArrayNode templates = (ArrayNode) config.get("templates");
        JsonNode template = null;
        for (JsonNode candidate : templates) {
            if (templateId.equals(text(candidate, "id"))) {
                template = candidate;
                break;
            }
        }
        if (template == null) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "AGENT_TEMPLATE_NOT_FOUND", "Agent template not found");
        }

        String roleId = text(template, "roleId");
        parseUuid(roleId, "INVALID_TEMPLATE_ROLE_ID");
        ArrayNode roles = (ArrayNode) config.get("roles");
        JsonNode role = null;
        for (JsonNode candidate : roles) {
            if (roleId.equals(text(candidate, "id"))) {
                if (role != null) {
                    throw new CpApiException(HttpStatus.CONFLICT, "AGENT_TEMPLATE_CONFIG_INVALID",
                            "Template role ID is not unique in its config layer");
                }
                role = candidate;
            }
        }
        if (role == null) {
            throw new CpApiException(HttpStatus.CONFLICT, "AGENT_TEMPLATE_CONFIG_INVALID",
                    "Template role reference is missing from its config layer");
        }

        ObjectNode snapshot = objectMapper.createObjectNode();
        snapshot.put("templateId", templateId);
        snapshot.put("templateName", text(template, "name"));
        snapshot.put("roleId", roleId);
        snapshot.put("roleName", text(role, "name"));
        snapshot.put("description", text(template, "description"));
        snapshot.put("systemPrompt", text(template, "systemPrompt"));
        snapshot.put("toolMode", text(template, "toolMode"));
        copyTextIfPresent(template, snapshot, "provider");
        copyTextIfPresent(template, snapshot, "model");
        snapshot.set("permissions", role.get("permissions").deepCopy());
        return snapshot;
    }

    private ArrayNode toJson(Set<GrantIntersectionEvaluator.PermissionAtom> permissions) {
        ArrayNode result = objectMapper.createArrayNode();
        permissions.stream()
                .sorted(java.util.Comparator.comparing(GrantIntersectionEvaluator.PermissionAtom::actionClass)
                        .thenComparing(GrantIntersectionEvaluator.PermissionAtom::resource))
                .forEach(permission -> {
                    ObjectNode atom = objectMapper.createObjectNode();
                    atom.put("actionClass", permission.actionClass());
                    if (!"*".equals(permission.resource())) {
                        atom.put("resource", permission.resource());
                    }
                    result.add(atom);
                });
        return result;
    }

    private void copyTextIfPresent(JsonNode source, ObjectNode target, String field) {
        String value = text(source, field);
        if (value != null) {
            target.put(field, value);
        }
    }

    private String text(JsonNode node, String field) {
        JsonNode value = node.get(field);
        return value != null && value.isTextual() ? value.asText() : null;
    }

    private UUID parseUuid(String value, String errorCode) {
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException | NullPointerException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, errorCode, "A valid template/user UUID is required", e);
        }
    }

    public record ResolvedTemplate(String sourceLayer, JsonNode snapshot) {}
    private record ConfigScope(String layer, UUID userId, UUID workspaceId) {}
}
