package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ConfigEntity;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.provider.ApiInputTypeService;
import com.cc01cc.p.xihe.cp.provider.ApiRequestValidator;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;
import com.cc01cc.p.xihe.cp.repository.ConfigAuditRepository;
import com.cc01cc.p.xihe.cp.entity.ConfigAuditEntity;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.persistence.EntityManager;
import jakarta.persistence.LockModeType;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;

/** API body revisions and binding maps using the existing scope config store. */
@Service
public class ApiRequestTemplateService {
    public static final String DOMAIN = "api-request-templates";
    private static final Set<String> KEYS = Set.of("templates", "connectionDefaultTemplates", "providerModelBindings");
    private final ConfigJpaRepository configs;
    private final ConfigAuditRepository audits;
    private final ProviderConnectionRepository connections;
    private final EntityManager em;
    private final ObjectMapper json;
    private final ApiInputTypeService types;
    private final ApiRequestValidator validator;
    private final org.springframework.beans.factory.ObjectProvider<WorkspaceService> workspaces;
    private final DbLockTimeout timeout;

    public ApiRequestTemplateService(ConfigJpaRepository configs, ConfigAuditRepository audits, ProviderConnectionRepository connections,
                                     EntityManager em, ObjectMapper json, ApiInputTypeService types,
                                     ApiRequestValidator validator, org.springframework.beans.factory.ObjectProvider<WorkspaceService> workspaces, DbLockTimeout timeout) {
        this.configs = configs;
        this.audits = audits;
        this.connections = connections;
        this.em = em;
        this.json = json;
        this.types = types;
        this.validator = validator;
        this.workspaces = workspaces;
        this.timeout = timeout;
    }

    public static CpApiException invalid(String message) {
        return new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", message);
    }

    public static CpApiException conflict(String code, String message) {
        return new CpApiException(HttpStatus.CONFLICT, code, message);
    }

    public static boolean admin() {
        var auth = SecurityContextHolder.getContext().getAuthentication();
        return auth != null && auth.getAuthorities().stream().anyMatch(a -> a.getAuthority().equals("ROLE_ADMIN"));
    }

    private void access(String layer, UUID user, UUID workspace, boolean write) {
        String actor = TenantContext.getUserId();
        if (actor == null) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authentication required");
        }
        switch (layer) {
            case "instance" -> {
                if (write && !admin()) {
                    throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "Instance writes require admin");
                }
            }
            case "user" -> {
                if (user == null || (!actor.equals(user.toString()) && !admin())) {
                    throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "User scope is not accessible");
                }
            }
            case "workspace" -> {
                if (workspace == null) {
                    throw invalid("workspaceId is required");
                }
                workspaces.getObject().requireAccessibleWorkspace(workspace.toString(), actor);
                if (write) {
                    // Reuse the workspace owner/admin mutation gate.
                    String role = TenantContext.getWorkspaceRole();
                    if (!admin() && !(workspace.toString().equals(TenantContext.getWorkspaceId())
                            && ("OWNER".equals(role) || "ADMIN".equals(role)))) {
                        throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "Workspace owner/admin required");
                    }
                }
            }
            default -> throw invalid("Unknown config layer");
        }
    }

    public Map<String, String> readLayer(String layer, UUID user, UUID workspace) {
        access(layer, user, workspace, false);
        Map<String, String> result = raw(layer, user, workspace);
        ArrayNode templates = array(result.getOrDefault("templates", "[]"));
        if (layer.equals("instance")) {
            if (!admin()) {
                result.clear();
                ArrayNode visible = json.createArrayNode();
                for (JsonNode template : templates) {
                    if (template.path("status").asText().equals("published")) {
                        visible.add(template);
                    }
                }
                templates = visible;
            }
            for (JsonNode builtin : builtins()) {
                boolean exists = false;
                for (JsonNode item : templates) {
                    exists |= item.path("id").equals(builtin.path("id"));
                }
                if (!exists) {
                    templates.add(builtin);
                }
            }
        }
        result.put("templates", write(templates));
        return result;
    }

    private List<ConfigEntity> rows(String layer, UUID user, UUID workspace) {
        return switch (layer) {
            case "instance" -> configs.findByLayerAndDomain(layer, DOMAIN);
            case "user" -> configs.findByUserIdAndDomain(user, DOMAIN);
            case "workspace" -> configs.findByWorkspaceIdAndDomain(workspace, DOMAIN);
            default -> throw invalid("Unknown config layer");
        };
    }

    private Map<String, String> raw(String layer, UUID user, UUID workspace) {
        Map<String, String> result = new LinkedHashMap<>();
        for (ConfigEntity row : rows(layer, user, workspace)) {
            result.put(row.getConfigKey(), row.getConfigValue());
        }
        return result;
    }

    @Transactional
    public void putLayer(String layer, Map<String, String> entries, String actor, UUID user, UUID workspace) {
        access(layer, user, workspace, true);
        if (entries == null || !KEYS.containsAll(entries.keySet())) {
            throw invalid("Unknown API Request Template config key");
        }
        timeout.apply();
        Set<String> locked = connectionIds(raw(layer, user, workspace));
        locked.addAll(connectionIds(entries));
        for (String id : locked.stream().sorted().toList()) {
            lockConnection(id);
        }
        lockScope(layer, user, workspace);
        Map<String, String> current = raw(layer, user, workspace);
        if (!locked.containsAll(connectionIds(current))) {
            throw conflict("CONNECTION_REVISION_CHANGED", "Bindings changed; refresh before saving");
        }
        Map<String, String> proposed = new LinkedHashMap<>(current);
        proposed.putAll(entries);
        ArrayNode old = array(current.getOrDefault("templates", "[]"));
        ArrayNode next = array(proposed.getOrDefault("templates", "[]"));
        validateTemplates(old, next);
        validateMaps(layer, user, workspace, proposed, next);
        for (Map.Entry<String, String> entry : entries.entrySet()) {
            save(layer, user, workspace, entry.getKey(), entry.getValue(), actor);
        }
    }

    private Set<String> connectionIds(Map<String, String> entries) {
        Set<String> ids = new TreeSet<>();
        for (String key : List.of("connectionDefaultTemplates", "providerModelBindings")) {
            object(entries.getOrDefault(key, "{}")).fieldNames().forEachRemaining(id -> {
                uuid(id);
                ids.add(id);
            });
        }
        return ids;
    }

    @Transactional
    public ProviderConnection lockConnection(String id) {
        timeout.apply();
        ProviderConnection connection = connections.findByIdForUpdate(UUID.fromString(id))
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "PROVIDER_CONNECTION_NOT_FOUND", "Connection not found"));
        em.refresh(connection);
        return connection;
    }

    private void lockScope(String layer, UUID user, UUID workspace) {
        // A transaction advisory lock also serializes the first insert of an absent config row.
        String owner = layer + ":" + (layer.equals("user") ? user : layer.equals("workspace") ? workspace : "instance") + ":" + DOMAIN;
        if (em.getEntityManagerFactory().getProperties().getOrDefault("hibernate.dialect", "").toString().contains("PostgreSQL")
                || em.getEntityManagerFactory().unwrap(org.hibernate.engine.spi.SessionFactoryImplementor.class).getJdbcServices().getDialect()
                instanceof org.hibernate.dialect.PostgreSQLDialect) {
            em.createNativeQuery("SELECT pg_advisory_xact_lock(hashtextextended(:owner, 0))")
                    .setParameter("owner", owner).getSingleResult();
        }
        for (ConfigEntity row : rows(layer, user, workspace).stream()
                .sorted(Comparator.comparing(ConfigEntity::getConfigKey)).toList()) {
            em.lock(row, LockModeType.PESSIMISTIC_WRITE);
            em.refresh(row);
        }
    }

    private void save(String layer, UUID user, UUID workspace, String key, String value, String actor) {
        ConfigEntity row = rows(layer, user, workspace).stream().filter(r -> r.getConfigKey().equals(key))
                .findFirst().orElseGet(() -> {
                    ConfigEntity created = new ConfigEntity();
                    created.setLayer(layer);
                    created.setUserId(layer.equals("user") ? user : null);
                    created.setWorkspaceId(layer.equals("workspace") ? workspace : null);
                    created.setDomain(DOMAIN);
                    created.setConfigKey(key);
                    return created;
                });
        String previous = row.getConfigValue();
        row.setConfigValue(value);
        row.setUpdatedBy(actor == null ? "internal-service" : actor);
        configs.saveAndFlush(row);
        ConfigAuditEntity audit = new ConfigAuditEntity();
        audit.setConfigId(row.getId().toString());
        audit.setLayer(layer);
        audit.setDomain(DOMAIN);
        audit.setConfigKey(key);
        audit.setOldValue(auditHash(previous));
        audit.setNewValue(auditHash(value));
        audit.setChangedBy(actor == null ? "internal-service" : actor);
        audits.save(audit);
    }

    private void validateTemplates(ArrayNode current, ArrayNode next) {
        Map<String, JsonNode> previous = new HashMap<>();
        for (JsonNode value : current) {
            previous.put(value.path("id").asText() + "@" + value.path("version").asInt(), value);
        }
        Set<String> seen = new HashSet<>();
        for (JsonNode value : next) {
            uuid(value.path("id").asText());
            for (JsonNode builtin : builtins()) {
                if (builtin.path("id").equals(value.path("id")) && !builtin.equals(value)) {
                    throw conflict("API_REQUEST_TEMPLATE_REVISION_IMMUTABLE", "Built-in templates are immutable");
                }
            }
            int version = value.path("version").asInt();
            String key = value.path("id").asText() + "@" + version;
            String type = value.path("apiTypeId").asText();
            int typeVersion = value.path("apiTypeVersion").asInt();
            String status = value.path("status").asText();
            if (!value.isObject() || !seen.add(key) || version < 1 || !value.path("bodySource").isTextual()
                    || !value.path("name").isTextual() || !Set.of("draft", "published").contains(status)
                    || !types.contains(type, typeVersion) || !"chat".equals(types.operation(type, typeVersion))) {
                throw invalid("Invalid API Request Template record");
            }
            for (JsonNode old : current) {
                if (old.path("id").equals(value.path("id"))
                        && (!old.path("apiTypeId").equals(value.path("apiTypeId"))
                        || !old.path("apiTypeVersion").equals(value.path("apiTypeVersion")))) {
                    throw invalid("Template API Type is immutable");
                }
            }
            if (status.equals("published") && !validator.validate(type, typeVersion, value.path("bodySource").asText()).valid()) {
                throw invalid("API Type validation failed; retain the source as a draft");
            }
            JsonNode old = previous.get(key);
            if (old != null && old.path("status").asText().equals("published") && !old.equals(value)) {
                throw conflict("API_REQUEST_TEMPLATE_REVISION_IMMUTABLE", "Published revisions cannot change");
            }
        }
        for (Map.Entry<String, JsonNode> old : previous.entrySet()) {
            if (old.getValue().path("status").asText().equals("published") && !seen.contains(old.getKey())) {
                throw conflict("API_REQUEST_TEMPLATE_REVISION_IMMUTABLE", "Published revisions cannot be deleted");
            }
        }
    }

    private void validateMaps(String layer, UUID user, UUID workspace, Map<String, String> entries, ArrayNode proposed) {
        UUID visibleWorkspace = workspace != null ? workspace : TenantContext.getWorkspaceId() == null ? null : uuid(TenantContext.getWorkspaceId());
        ObjectNode defaults = object(entries.getOrDefault("connectionDefaultTemplates", "{}"));
        ObjectNode overrides = object(entries.getOrDefault("providerModelBindings", "{}"));
        if (!layer.equals("user") && !overrides.isEmpty()) {
            throw invalid("Model overrides are user-scope only");
        }
        defaults.fields().forEachRemaining(entry -> {
            ProviderConnection connection = connections.findById(UUID.fromString(entry.getKey())).orElseThrow();
            String owner = layer.equals("user") ? String.valueOf(user) : String.valueOf(workspace);
            if (!connection.getOwnerType().equalsIgnoreCase(layer) || !connection.getOwnerId().equals(owner)) {
                throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "Default must be in Connection owner scope");
            }
            compatible(connection, resolveRef(entry.getValue(), user, visibleWorkspace, layer, proposed));
        });
        overrides.fields().forEachRemaining(entry -> {
            ProviderConnection connection = connections.findById(UUID.fromString(entry.getKey())).orElseThrow();
            requireVisible(connection, String.valueOf(user), workspace == null ? TenantContext.getWorkspaceId() : workspace.toString());
            if (!entry.getValue().isObject() || entry.getValue().isEmpty()) {
                throw invalid("Empty model override records are invalid; remove the entry to inherit");
            }
            entry.getValue().fields().forEachRemaining(model -> {
                if (model.getKey().isBlank()) {
                    throw invalid("Model is required");
                }
                compatible(connection, resolveRef(model.getValue(), user, visibleWorkspace, layer, proposed));
            });
        });
    }

    public void requireVisible(ProviderConnection connection, String user, String workspace) {
        if (!(connection.getOwnerType().equals("USER") && connection.getOwnerId().equals(user))
                && !(connection.getOwnerType().equals("WORKSPACE") && connection.getOwnerId().equals(workspace))) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "Connection is not accessible");
        }
    }

    private ObjectNode resolveRef(JsonNode ref, UUID user, UUID workspace, String proposedLayer, ArrayNode proposed) {
        if (!ref.isObject() || !ref.path("layer").isTextual() || !ref.path("templateId").isTextual()
                || !ref.path("version").isIntegralNumber() || ref.path("version").asInt() < 1) {
            throw invalid("A complete template ref is required");
        }
        String layer = ref.path("layer").asText();
        if (!Set.of("instance", "user", "workspace").contains(layer)
                || layer.equals("user") && user == null || layer.equals("workspace") && workspace == null) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "Template scope is not visible");
        }
        List<JsonNode> candidates = new ArrayList<>();
        if (layer.equals("instance")) {
            candidates.addAll(builtins());
        }
        ArrayNode stored = layer.equals(proposedLayer) ? proposed : array(raw(layer, user, workspace).getOrDefault("templates", "[]"));
        stored.forEach(candidates::add);
        return candidates.stream().filter(t -> t.path("id").asText().equals(ref.path("templateId").asText())
                        && t.path("version").asInt() == ref.path("version").asInt()
                        && t.path("status").asText().equals("published"))
                .map(t -> (ObjectNode) t.deepCopy()).findFirst()
                .orElseThrow(() -> conflict("API_TYPE_TEMPLATE_MISMATCH", "Published template is unavailable"));
    }

    private void compatible(ProviderConnection connection, JsonNode template) {
        if (!connection.getApiTypeId().equals(template.path("apiTypeId").asText())
                || connection.getApiTypeVersion() != template.path("apiTypeVersion").asInt()
                || !"chat".equals(types.operation(connection.getApiTypeId(), connection.getApiTypeVersion()))) {
            throw conflict("API_TYPE_TEMPLATE_MISMATCH", "Template and Connection API Type must match");
        }
    }

    public ObjectNode resolve(ProviderConnection connection, String model, UUID user, UUID workspace, JsonNode explicit) {
        JsonNode ref = explicit;
        String source = "explicit";
        if (ref == null) {
            ref = object(raw("user", user, null).getOrDefault("providerModelBindings", "{}"))
                    .path(connection.getId().toString()).get(model);
            source = "provider-model";
        }
        if (ref == null) {
            String layer = connection.getOwnerType().toLowerCase(java.util.Locale.ROOT);
            UUID owner = UUID.fromString(connection.getOwnerId());
            ref = object(raw(layer, layer.equals("user") ? owner : null, layer.equals("workspace") ? owner : null)
                    .getOrDefault("connectionDefaultTemplates", "{}")).get(connection.getId().toString());
            source = "connection-default";
        }
        if (ref == null) {
            ref = builtinRef(connection.getApiTypeId(), connection.getApiTypeVersion());
            source = "builtin-default";
        }
        ObjectNode template = resolveRef(ref, user, workspace, "", json.createArrayNode());
        compatible(connection, template);
        ObjectNode snapshot = json.createObjectNode();
        snapshot.setAll((ObjectNode) ref);
        snapshot.put("source", source);
        snapshot.set("template", template);
        snapshot.put("providerConnectionId", connection.getId().toString());
        snapshot.put("connectionRevision", connection.getRevision());
        snapshot.put("apiTypeId", connection.getApiTypeId());
        snapshot.put("apiTypeVersion", connection.getApiTypeVersion());
        snapshot.put("connectionKey", connection.getConnectionKey());
        snapshot.put("connectionScope", connection.getOwnerType());
        return snapshot;
    }

    public ObjectNode admissionSnapshot(Session session) {
        if (session.getContextTemplateLayer() == null || session.getContextTemplateId() == null
                || session.getContextTemplateVersion() == null || session.getProviderConnectionId() == null) {
            throw conflict("API_TYPE_REBIND_REQUIRED", "Explicit Session binding is required");
        }
        ProviderConnection connection = connections.findById(UUID.fromString(session.getProviderConnectionId())).orElseThrow();
        requireVisible(connection, session.getUserId(), session.getWorkspaceId());
        requireChat(connection);
        if (!Long.valueOf(connection.getRevision()).equals(session.getConnectionRevision())) {
            throw conflict("API_TYPE_REBIND_REQUIRED", "Connection changed; explicitly rebind the Session");
        }
        JsonNode ref = json.createObjectNode().put("layer", session.getContextTemplateLayer())
                .put("templateId", session.getContextTemplateId().toString()).put("version", session.getContextTemplateVersion());
        return resolve(connection, session.getModelName(), UUID.fromString(session.getUserId()),
                UUID.fromString(session.getWorkspaceId()), ref);
    }

    public JsonNode pinnedTemplate(Session session) {
        if (session.getContextTemplateLayer() == null || session.getContextTemplateId() == null
                || session.getContextTemplateVersion() == null) {
            return null;
        }
        return resolveRef(json.createObjectNode().put("layer", session.getContextTemplateLayer())
                        .put("templateId", session.getContextTemplateId().toString()).put("version", session.getContextTemplateVersion()),
                uuid(session.getUserId()), uuid(session.getWorkspaceId()), "", json.createArrayNode());
    }

    public void requireChat(ProviderConnection connection) {
        if (!"chat".equals(types.operation(connection.getApiTypeId(), connection.getApiTypeVersion()))) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "API_TYPE_OPERATION_MISMATCH", "Chat requires operation=chat");
        }
    }

    public List<ProviderConnection> effectiveConnections(String user, String workspace, String provider) {
        Map<String, ProviderConnection> slots = new LinkedHashMap<>();
        List<ProviderConnection> visible = new ArrayList<>(connections.findByOwnerTypeAndOwnerId("USER", user));
        if (workspace != null) {
            visible.addAll(connections.findByOwnerTypeAndOwnerId("WORKSPACE", workspace));
        }
        for (ProviderConnection connection : visible) {
            if (!connection.isEnabled() || !ProviderConnection.STATUS_READY.equals(connection.getStatus())
                    || !"chat".equals(types.operation(connection.getApiTypeId(), connection.getApiTypeVersion()))
                    || provider != null && !provider.equals(connection.getProviderId())) {
                continue;
            }
            slots.put(connection.getProviderId() + ":" + connection.getConnectionKey(), connection);
        }
        return List.copyOf(slots.values());
    }

    public void requireModel(ProviderConnection connection, String model) {
        if (model == null || model.isBlank()) {
            throw invalid("modelName is required");
        }
        if ("manual".equals(connection.getModelDiscovery())) {
            boolean found = false;
            for (JsonNode candidate : array(connection.getManualModels() == null ? "[]" : connection.getManualModels())) {
                found |= candidate.isTextual() && model.equals(candidate.asText());
            }
            if (!found) {
                throw invalid("Model is not registered under this Connection");
            }
        }
    }

    public ObjectNode builtinRef(String type, int version) {
        types.require(type, version);
        return json.createObjectNode().put("layer", "instance").put("templateId", builtinId(type, version).toString()).put("version", 1);
    }

    @Transactional
    public int changeConnectionDefault(ProviderConnection connection, JsonNode ref) {
        String layer = connection.getOwnerType().toLowerCase(java.util.Locale.ROOT);
        UUID owner = UUID.fromString(connection.getOwnerId());
        UUID user = layer.equals("user") ? owner : null;
        UUID workspace = layer.equals("workspace") ? owner : null;
        // Connection row is already locked by the mutation owner.
        List<ConfigEntity> overrides = configs.findByLayerAndDomain("user", DOMAIN).stream()
                .filter(r -> r.getConfigKey().equals("providerModelBindings"))
                .filter(r -> object(r.getConfigValue()).has(connection.getId().toString()))
                .sorted(Comparator.comparing(r -> r.getUserId().toString())).toList();
        Set<String> scopes = new TreeSet<>();
        scopes.add(layer + ":" + owner);
        for (ConfigEntity row : overrides) {
            scopes.add("user:" + row.getUserId());
        }
        for (String scope : scopes) {
            String[] parts = scope.split(":", 2);
            UUID scopeOwner = UUID.fromString(parts[1]);
            lockScope(parts[0], parts[0].equals("user") ? scopeOwner : null,
                    parts[0].equals("workspace") ? scopeOwner : null);
        }
        ObjectNode defaults = object(raw(layer, user, workspace).getOrDefault("connectionDefaultTemplates", "{}"));
        if (ref != null) {
            compatible(connection, resolveRef(ref, user, workspace, "", json.createArrayNode()));
            defaults.set(connection.getId().toString(), ref);
        } else {
            defaults.remove(connection.getId().toString());
        }
        save(layer, user, workspace, "connectionDefaultTemplates", write(defaults), TenantContext.getUserId());
        int removed = 0;
        for (ConfigEntity row : overrides) {
            em.refresh(row);
            ObjectNode bindings = object(row.getConfigValue());
            if (!bindings.path(connection.getId().toString()).isObject()) {
                continue;
            }
            ObjectNode models = (ObjectNode) bindings.path(connection.getId().toString());
            List<String> delete = new ArrayList<>();
            models.fields().forEachRemaining(entry -> {
                try {
                    compatible(connection, resolveRef(entry.getValue(), row.getUserId(), workspace, "", json.createArrayNode()));
                } catch (CpApiException mismatch) {
                    if (!mismatch.getCode().equals("API_TYPE_TEMPLATE_MISMATCH")) {
                        throw mismatch;
                    }
                    delete.add(entry.getKey());
                }
            });
            delete.forEach(models::remove);
            removed += delete.size();
            if (models.isEmpty()) {
                bindings.remove(connection.getId().toString());
            }
            save("user", row.getUserId(), null, "providerModelBindings", write(bindings), TenantContext.getUserId());
        }
        return removed;
    }

    public Map<String, Object> impact(ProviderConnection connection, String type, int version) {
        types.require(type, version);
        List<JsonNode> candidates = new ArrayList<>();
        for (JsonNode template : builtins()) {
            if (template.path("apiTypeId").asText().equals(type) && template.path("apiTypeVersion").asInt() == version) {
                candidates.add(json.createObjectNode().put("layer", "instance").put("templateId", template.path("id").asText())
                        .put("version", template.path("version").asInt()));
            }
        }
        String layer = connection.getOwnerType().toLowerCase(java.util.Locale.ROOT);
        UUID owner = UUID.fromString(connection.getOwnerId());
        for (JsonNode template : array(raw(layer, layer.equals("user") ? owner : null, layer.equals("workspace") ? owner : null)
                .getOrDefault("templates", "[]"))) {
            if (template.path("status").asText().equals("published") && template.path("apiTypeId").asText().equals(type)
                    && template.path("apiTypeVersion").asInt() == version) {
                candidates.add(json.createObjectNode().put("layer", layer).put("templateId", template.path("id").asText())
                        .put("version", template.path("version").asInt()));
            }
        }
        int count = 0;
        for (ConfigEntity row : configs.findByLayerAndDomain("user", DOMAIN)) {
            if (!row.getConfigKey().equals("providerModelBindings")) {
                continue;
            }
            for (JsonNode ref : object(row.getConfigValue()).path(connection.getId().toString())) {
                JsonNode template = resolveRef(ref, row.getUserId(), layer.equals("workspace") ? owner : null, "", json.createArrayNode());
                if (!template.path("apiTypeId").asText().equals(type) || template.path("apiTypeVersion").asInt() != version) {
                    count++;
                }
            }
        }
        return Map.of("connectionRevision", connection.getRevision(),
                "currentType", Map.of("apiTypeId", connection.getApiTypeId(), "apiTypeVersion", connection.getApiTypeVersion()),
                "targetType", Map.of("apiTypeId", type, "apiTypeVersion", version),
                "compatibleTemplates", candidates, "incompatibleOverrides", List.of(Map.of("scope", "user", "count", count)),
                "sessionRebindCount", connection.getApiTypeId().equals(type) && connection.getApiTypeVersion() == version ? 0L
                        : em.createQuery("select count(s) from Session s where s.providerConnectionId = :id", Long.class)
                        .setParameter("id", connection.getId().toString()).getSingleResult());
    }

    private UUID builtinId(String type, int version) {
        return UUID.nameUUIDFromBytes((DOMAIN + ":" + type + "@" + version).getBytes(StandardCharsets.UTF_8));
    }

    public List<JsonNode> builtins() {
        List<JsonNode> result = new ArrayList<>();
        for (Map<String, Object> type : types.list()) {
            if (!"chat".equals(type.get("operation"))) {
                continue;
            }
            String id = type.get("apiTypeId").toString();
            int version = ((Number) type.get("version")).intValue();
            String body;
            if (id.equals("mimo-responses")) {
                body = "{\"model\":\"${xh.model}\",\"input\":[\"${xh.conversation_history}\",{\"role\":\"user\",\"content\":\"${xh.user_input}\"}],\"instructions\":\"${xh.agent_instructions}\",\"tools\":[\"${xh.tools}\"],\"stream\":true}";
            } else if (id.equals("anthropic-messages")) {
                body = "{\"model\":\"${xh.model}\",\"system\":\"${xh.agent_instructions}\",\"messages\":[\"${xh.conversation_history}\",{\"role\":\"user\",\"content\":\"${xh.user_input}\"}],\"tools\":[\"${xh.tools}\"],\"max_tokens\":4096,\"stream\":true}";
            } else {
                body = "{\"model\":\"${xh.model}\",\"messages\":[{\"role\":\"system\",\"content\":\"${xh.agent_instructions}\"},\"${xh.conversation_history}\",{\"role\":\"user\",\"content\":\"${xh.user_input}\"}],\"tools\":[\"${xh.tools}\"],\"stream\":true}";
            }
            result.add(json.createObjectNode().put("id", builtinId(id, version).toString()).put("version", 1)
                    .put("name", id + " default").put("description", "Built-in API Request Template")
                    .put("apiTypeId", id).put("apiTypeVersion", version).put("bodySource", body).put("status", "published"));
        }
        return List.copyOf(result);
    }

    private JsonNode parse(String value) {
        try {
            return json.readTree(value);
        } catch (JsonProcessingException e) {
            throw invalid("Invalid config JSON");
        }
    }

    private static UUID uuid(String value) {
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            throw invalid("Identifier must be a UUID");
        }
    }

    private static String auditHash(String value) {
        if (value == null) {
            return "missing";
        }
        try {
            return "present:" + java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is required for config audit", e);
        }
    }

    private ObjectNode object(String value) {
        JsonNode parsed = parse(value);
        if (parsed == null || !parsed.isObject()) {
            throw invalid("Binding maps must be objects");
        }
        return (ObjectNode) parsed;
    }

    private ArrayNode array(String value) {
        JsonNode parsed = parse(value);
        if (parsed == null || !parsed.isArray()) {
            throw invalid("templates must be an array");
        }
        return (ArrayNode) parsed;
    }

    private String write(JsonNode value) {
        try {
            return json.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Unable to serialize API Request Template config", e);
        }
    }
}
