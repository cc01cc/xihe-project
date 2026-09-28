package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.ConfigDomainSchema;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import com.cc01cc.p.xihe.cp.policy.PolicyRequest;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.policy.ToolShape;
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
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
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
    private final AuditLogger auditLogger;

    public AgentTemplateService(ConfigService configService,
                                ConfigDomainSchema schemaValidator,
                                UserRepository userRepository,
                                WorkspaceRepository workspaceRepository,
                                WorkspaceUserRepository workspaceUserRepository,
                                AuthorizationGrantRepository grantRepository,
                                GrantIntersectionEvaluator evaluator,
                                ObjectMapper objectMapper,
                                AuditLogger auditLogger) {
        this.configService = configService;
        this.schemaValidator = schemaValidator;
        this.userRepository = userRepository;
        this.workspaceRepository = workspaceRepository;
        this.workspaceUserRepository = workspaceUserRepository;
        this.grantRepository = grantRepository;
        this.evaluator = evaluator;
        this.objectMapper = objectMapper;
        this.auditLogger = auditLogger;
    }

    @Transactional(readOnly = true)
    public ResolvedTemplate resolveForCreation(String actorUserId, String workspaceId, String templateId) {
        UUID actorId = parseUuid(actorUserId, "INVALID_ACTOR");
        User actor = userRepository.findById(actorId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "USER_NOT_FOUND", "User not found"));
        UUID workspaceUuid = workspaceId == null || workspaceId.isBlank()
                ? null : parseUuid(workspaceId, "INVALID_WORKSPACE");
        requireReadableWorkspace(actorId, workspaceUuid);
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
            ObjectNode config = loadLayerConfig(scope);
            if (config == null) {
                continue;
            }
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

    /**
     * PLAN-0374 T3.1a read route: returns the raw templates[] entries of exactly one
     * caller-readable config layer. Layer visibility reuses the resolveForCreation
     * layer loading and permission semantics (instance=ADMIN, user=self,
     * workspace=member); no merged-effective or cross-layer view is produced.
     */
    @Transactional(readOnly = true)
    public TemplateListView listForCaller(String actorUserId, String layer, UUID workspaceId) {
        UUID actorId = parseUuid(actorUserId, "INVALID_ACTOR");
        User actor = userRepository.findById(actorId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "USER_NOT_FOUND", "User not found"));
        ConfigScope scope;
        if (layer == null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "layer must be one of instance, user, workspace");
        }
        switch (layer) {
            case "instance" -> {
                if (actor.getRole() != UserRole.ADMIN) {
                    logger.warn("Denied non-ADMIN Agent template instance layer read: actor={}", actorId);
                    throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                            "Instance Agent templates are readable by ADMIN only");
                }
                scope = new ConfigScope("instance", null, null);
            }
            case "user" -> scope = new ConfigScope("user", actorId, null);
            case "workspace" -> {
                if (workspaceId == null) {
                    throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                            "workspaceId is required for the workspace layer");
                }
                requireReadableWorkspace(actorId, workspaceId);
                scope = new ConfigScope("workspace", null, workspaceId);
            }
            default -> throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "layer must be one of instance, user, workspace");
        }
        ObjectNode config = loadLayerConfig(scope);
        ArrayNode templates = config == null
                ? objectMapper.createArrayNode() : listTemplates(config, scope.layer());
        return new TemplateListView(scope.layer(), scope.workspaceId(), templates);
    }

    @Transactional
    public int putConfigLayer(String actorUserId, String layer, UUID userId, UUID workspaceId,
                              Map<String, String> entries) {
        UUID actorId = parseUuid(actorUserId, "INVALID_ACTOR");
        User actor = loadActor(actorId);
        requireLayerWrite(actor, layer, userId, workspaceId);

        Map<String, String> before = configService.layerEntries(layer, DOMAIN, userId, workspaceId);
        Map<String, String> merged = new LinkedHashMap<>(before);
        merged.putAll(entries);
        ConfigScope scope = new ConfigScope(layer, userId, workspaceId);
        ObjectNode parsed = parseLayer(scope, merged);
        validateRoleIds(parsed, layer);
        listTemplates(parsed, layer);
        requireRolePermissionsWithinUserGrants(actorId, workspaceId, parsed);

        Map<String, String> changed = changedEntries(before, entries);
        if (!changed.isEmpty()) {
            configService.putLayer(layer, DOMAIN, changed, actorId.toString(), userId, workspaceId);
        }
        auditConfigChange(actorId, layer, userId, workspaceId, before, merged, changed.keySet());
        return changed.size();
    }

    @Transactional
    public ConfigService.ImportReport importConfig(String actorUserId, String jsoncContent) {
        Map<String, String> importedEntries = configService.importDomainEntries(jsoncContent, DOMAIN)
                .orElse(null);
        if (importedEntries == null) {
            return configService.importJsonc(jsoncContent, "instance", null, null);
        }

        UUID actorId = parseUuid(actorUserId, "INVALID_ACTOR");
        User actor = loadActor(actorId);
        requireLayerWrite(actor, "instance", null, null);
        Map<String, String> before = configService.layerEntries("instance", DOMAIN, null, null);
        Map<String, String> merged = new LinkedHashMap<>(before);
        merged.putAll(importedEntries);
        ConfigScope scope = new ConfigScope("instance", null, null);
        ObjectNode parsed = parseLayer(scope, merged);
        validateRoleIds(parsed, "instance");
        listTemplates(parsed, "instance");
        requireRolePermissionsWithinUserGrants(actorId, null, parsed);

        Map<String, String> changed = changedEntries(before, importedEntries);
        ConfigService.ImportReport report = configService.importJsonc(
                jsoncContent, "instance", null, null, actorId.toString());
        auditConfigChange(actorId, "instance", null, null, before, merged, changed.keySet());
        return report;
    }

    private User loadActor(UUID actorId) {
        return userRepository.findById(actorId)
                .orElseThrow(() -> new ConfigService.ConfigAccessException("Template writer is unavailable"));
    }

    private void requireLayerWrite(User actor, String layer, UUID userId, UUID workspaceId) {
        UUID actorId = actor.getId();
        String actionResource = "*";
        switch (layer) {
            case "instance" -> {
                if (actor.getRole() != UserRole.ADMIN || userId != null || workspaceId != null) {
                    throw new ConfigService.ConfigAccessException("Instance template write is not allowed");
                }
            }
            case "user" -> {
                if (!actorId.equals(userId) || workspaceId != null) {
                    throw new ConfigService.ConfigAccessException("User template write must target the caller");
                }
            }
            case "workspace" -> {
                if (userId != null || workspaceId == null) {
                    throw new ConfigService.ConfigAccessException("Workspace template scope is invalid");
                }
                requireReadableWorkspace(actorId, workspaceId);
                actionResource = workspaceId.toString();
                requireUserAction(actorId, workspaceId, ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS,
                        actionResource);
            }
            default -> throw new ConfigService.ConfigAccessException("Template layer is not writable");
        }
        requireUserAction(actorId, workspaceId, ToolFaceRegistry.ACTION_CREATE_TEMPLATE, actionResource);
    }

    private void requireUserAction(UUID actorId, UUID workspaceId, String actionClass, String resource) {
        try {
            Set<GrantIntersectionEvaluator.PermissionAtom> permissions = evaluator.union(
                    grantRepository.findBySubjectTypeAndSubjectId(GrantPrincipalPathResolver.USER, actorId));
            PolicyRequest request = new PolicyRequest("config.agent-templates.write", List.of(actionClass),
                    List.of(resource), ToolShape.STRUCTURED, actorId.toString(),
                    workspaceId == null ? null : workspaceId.toString(), null);
            if (!evaluator.allows(request, List.of(permissions))) {
                throw new ConfigService.ConfigAccessException("Template write grant is required");
            }
        } catch (ConfigService.ConfigAccessException e) {
            throw e;
        } catch (RuntimeException e) {
            logger.error("Agent template grant evaluation failed closed: actor={}, action={}, errorType={}",
                    actorId, actionClass, e.getClass().getSimpleName());
            throw new ConfigService.ConfigAccessException("Template write grant could not be verified");
        }
    }

    private void requireRolePermissionsWithinUserGrants(UUID actorId, UUID workspaceId, ObjectNode config) {
        Set<GrantIntersectionEvaluator.PermissionAtom> actorPermissions;
        try {
            actorPermissions = evaluator.union(
                    grantRepository.findBySubjectTypeAndSubjectId(GrantPrincipalPathResolver.USER, actorId));
        } catch (RuntimeException e) {
            logger.error("Agent template writer grants failed closed: actor={}, errorType={}",
                    actorId, e.getClass().getSimpleName());
            throw new ConfigService.ConfigAccessException("Template writer permissions could not be verified");
        }
        ArrayNode roles = (ArrayNode) config.get("roles");
        for (JsonNode role : roles) {
            JsonNode rolePermissions = role.get("permissions");
            if (rolePermissions == null || !rolePermissions.isArray()) {
                throw new IllegalArgumentException("Role permissions must be an atom array");
            }
            for (JsonNode atom : rolePermissions) {
                JsonNode resourceNode = atom.get("resource");
                if (resourceNode != null && resourceNode.isTextual() && resourceNode.asText().isBlank()) {
                    throw new IllegalArgumentException("Permission resource must not be blank");
                }
            }
            Set<GrantIntersectionEvaluator.PermissionAtom> requested = evaluator.parse(rolePermissions);
            for (GrantIntersectionEvaluator.PermissionAtom permission : requested) {
                PolicyRequest request = new PolicyRequest("config.agent-templates.role", List.of(permission.actionClass()),
                        List.of(permission.resource()), ToolShape.STRUCTURED, actorId.toString(),
                        workspaceId == null ? null : workspaceId.toString(), null);
                if (!evaluator.allows(request, List.of(actorPermissions))) {
                    logger.warn("Denied Agent role permission beyond writer grants: actor={}, roleId={}",
                            actorId, text(role, "id"));
                    throw new ConfigService.ConfigAccessException(
                            "Role permissions must be within the template writer's current grants");
                }
            }
        }
    }

    private void validateRoleIds(ObjectNode config, String layer) {
        Set<String> roleIds = new HashSet<>();
        for (JsonNode role : (ArrayNode) config.get("roles")) {
            String roleId = text(role, "id");
            if (roleId == null || !roleIds.add(roleId)) {
                logger.error("Duplicate or missing Agent template role ID: layer={}", layer);
                throw new CpApiException(HttpStatus.CONFLICT, "AGENT_TEMPLATE_CONFIG_INVALID",
                        "Stored Agent template role IDs are not unique");
            }
        }
    }

    private Map<String, String> changedEntries(Map<String, String> before, Map<String, String> requested) {
        Map<String, String> changed = new LinkedHashMap<>();
        requested.forEach((key, value) -> {
            if (!Objects.equals(before.get(key), value)) {
                changed.put(key, value);
            }
        });
        return changed;
    }

    private void auditConfigChange(UUID actorId, String layer, UUID userId, UUID workspaceId,
                                   Map<String, String> before, Map<String, String> after,
                                   Set<String> changedKeys) {
        ArrayNode keys = objectMapper.createArrayNode();
        changedKeys.stream().sorted().forEach(keys::add);
        ObjectNode details = objectMapper.createObjectNode();
        details.put("authorizationAction", ToolFaceRegistry.ACTION_CREATE_TEMPLATE);
        details.put("layer", layer);
        details.set("changedKeys", keys);
        details.set("permissionDiff", rolePermissionDiff(before, after, layer, userId, workspaceId));
        String scopeId = switch (layer) {
            case "instance" -> "instance";
            case "user" -> userId.toString();
            case "workspace" -> workspaceId.toString();
            default -> throw new IllegalArgumentException("Unknown config layer: " + layer);
        };
        auditLogger.recordDurableChange(actorId.toString(),
                workspaceId == null ? null : workspaceId.toString(),
                "agent_template_config_updated", "agent_template_config", scopeId, details.toString());

        Map<String, JsonNode> oldTemplates = templateIndex(before, layer, userId, workspaceId);
        Map<String, JsonNode> newTemplates = templateIndex(after, layer, userId, workspaceId);
        for (Map.Entry<String, JsonNode> entry : newTemplates.entrySet()) {
            JsonNode oldTemplate = oldTemplates.get(entry.getKey());
            if (oldTemplate != null && oldTemplate.equals(entry.getValue())) {
                continue;
            }
            String action = oldTemplate == null ? "agent_template_created" : "agent_template_updated";
            JsonNode role = findRole(after, layer, userId, workspaceId, text(entry.getValue(), "roleId"));
            ObjectNode templateDetails = objectMapper.createObjectNode();
            templateDetails.put("authorizationAction", ToolFaceRegistry.ACTION_CREATE_TEMPLATE);
            templateDetails.put("layer", layer);
            templateDetails.set("changedKeys", keys.deepCopy());
            templateDetails.put("templateId", entry.getKey());
            templateDetails.put("roleId", text(entry.getValue(), "roleId"));
            if (role != null) {
                templateDetails.set("permissionDiff", role.path("permissions").deepCopy());
            }
            auditLogger.recordDurableChange(actorId.toString(),
                    workspaceId == null ? null : workspaceId.toString(),
                    action, "agent_template", entry.getKey(), templateDetails.toString());
        }
        for (String templateId : oldTemplates.keySet()) {
            if (!newTemplates.containsKey(templateId)) {
                ObjectNode deleted = objectMapper.createObjectNode();
                deleted.put("authorizationAction", ToolFaceRegistry.ACTION_CREATE_TEMPLATE);
                deleted.put("layer", layer);
                deleted.set("changedKeys", keys.deepCopy());
                deleted.put("templateId", templateId);
                auditLogger.recordDurableChange(actorId.toString(),
                        workspaceId == null ? null : workspaceId.toString(),
                        "agent_template_deleted", "agent_template", templateId, deleted.toString());
            }
        }
    }

    private ArrayNode rolePermissionDiff(Map<String, String> before, Map<String, String> after,
                                         String layer, UUID userId, UUID workspaceId) {
        Map<String, JsonNode> oldRoles = roleIndex(before, layer, userId, workspaceId);
        Map<String, JsonNode> newRoles = roleIndex(after, layer, userId, workspaceId);
        Set<String> roleIds = new HashSet<>(oldRoles.keySet());
        roleIds.addAll(newRoles.keySet());
        ArrayNode differences = objectMapper.createArrayNode();
        roleIds.stream().sorted().forEach(roleId -> {
            JsonNode oldRole = oldRoles.get(roleId);
            JsonNode newRole = newRoles.get(roleId);
            JsonNode oldPermissions = oldRole == null ? null : oldRole.get("permissions");
            JsonNode newPermissions = newRole == null ? null : newRole.get("permissions");
            if (!Objects.equals(oldPermissions, newPermissions)) {
                ObjectNode diff = differences.addObject();
                diff.put("roleId", roleId);
                if (oldPermissions == null) diff.putNull("before");
                else diff.set("before", oldPermissions.deepCopy());
                if (newPermissions == null) diff.putNull("after");
                else diff.set("after", newPermissions.deepCopy());
            }
        });
        return differences;
    }

    private Map<String, JsonNode> roleIndex(Map<String, String> entries, String layer,
                                           UUID userId, UUID workspaceId) {
        try {
            ObjectNode config = parseLayer(new ConfigScope(layer, userId, workspaceId), entries);
            Map<String, JsonNode> result = new LinkedHashMap<>();
            for (JsonNode role : (ArrayNode) config.get("roles")) {
                result.put(text(role, "id"), role);
            }
            return result;
        } catch (RuntimeException e) {
            return Map.of();
        }
    }

    private Map<String, JsonNode> templateIndex(Map<String, String> entries, String layer,
                                                UUID userId, UUID workspaceId) {
        try {
            ObjectNode config = parseLayer(new ConfigScope(layer, userId, workspaceId), entries);
            ArrayNode templates = listTemplates(config, layer);
            Map<String, JsonNode> result = new LinkedHashMap<>();
            for (JsonNode template : templates) {
                result.put(text(template, "id"), template);
            }
            return result;
        } catch (RuntimeException e) {
            return Map.of();
        }
    }

    private JsonNode findRole(Map<String, String> entries, String layer,
                              UUID userId, UUID workspaceId, String roleId) {
        if (roleId == null) {
            return null;
        }
        try {
            ObjectNode config = parseLayer(new ConfigScope(layer, userId, workspaceId), entries);
            for (JsonNode role : (ArrayNode) config.get("roles")) {
                if (roleId.equals(text(role, "id"))) {
                    return role;
                }
            }
        } catch (RuntimeException e) {
            logger.error("Unable to resolve Agent template role for audit: layer={}, roleId={}, errorType={}",
                    layer, roleId, e.getClass().getSimpleName());
        }
        return null;
    }

    private void requireReadableWorkspace(UUID actorId, UUID workspaceUuid) {
        if (workspaceUuid == null) {
            return;
        }
        workspaceRepository.findByIdAndDeletedAtIsNull(workspaceUuid)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND,
                        "WORKSPACE_NOT_FOUND", "Workspace not found"));
        workspaceUserRepository.findByIdWorkspaceIdAndIdUserId(workspaceUuid, actorId)
                .orElseThrow(() -> new CpApiException(HttpStatus.FORBIDDEN,
                        "WORKSPACE_ACCESS_DENIED", "Workspace membership is required"));
    }

    /** Raw single-layer load with the same fail-closed schema validation as resolveForCreation. */
    private ObjectNode loadLayerConfig(ConfigScope scope) {
        Map<String, String> entries = configService.layerEntries(
                scope.layer(), DOMAIN, scope.userId(), scope.workspaceId());
        if (entries.isEmpty()) {
            return null;
        }
        return parseLayer(scope, entries);
    }

    /** Validates the layer's templates[] entries without merging or picking another layer. */
    private ArrayNode listTemplates(ObjectNode config, String layer) {
        ArrayNode templates = (ArrayNode) config.get("templates");
        ArrayNode roles = (ArrayNode) config.get("roles");
        Set<String> seenTemplateIds = new HashSet<>();
        for (JsonNode template : templates) {
            String templateId = text(template, "id");
            if (!seenTemplateIds.add(templateId)) {
                logger.error("Duplicate Agent template ID in config scope: layer={}", layer);
                throw new CpApiException(HttpStatus.CONFLICT, "AGENT_TEMPLATE_CONFIG_INVALID",
                        "Stored Agent template IDs are not unique");
            }
            String roleId = text(template, "roleId");
            parseUuid(roleId, "INVALID_TEMPLATE_ROLE_ID");
            int roleMatches = 0;
            for (JsonNode role : roles) {
                if (roleId.equals(text(role, "id"))) {
                    roleMatches++;
                }
            }
            if (roleMatches == 0) {
                logger.error("Missing Agent template role reference: layer={}, roleId={}", layer, roleId);
                throw new CpApiException(HttpStatus.CONFLICT, "AGENT_TEMPLATE_CONFIG_INVALID",
                        "Template role reference is missing from its config layer");
            }
            if (roleMatches > 1) {
                logger.error("Duplicate Agent template role ID in config scope: layer={}, roleId={}",
                        layer, roleId);
                throw new CpApiException(HttpStatus.CONFLICT, "AGENT_TEMPLATE_CONFIG_INVALID",
                        "Template role ID is not unique in its config layer");
            }
        }
        return templates.deepCopy();
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
    public record TemplateListView(String layer, UUID workspaceId, ArrayNode templates) {}
    private record ConfigScope(String layer, UUID userId, UUID workspaceId) {}
}
