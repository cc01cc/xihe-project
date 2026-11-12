package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.policy.RequesterAuthority;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ConfigEntity;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
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
    /**
     * BL-284: supplies the component manifest merged into the frozen admission snapshot. Resolved
     * lazily through a provider because ConfigService (needed by ContextTemplateService) already
     * depends back on this service — a direct field would close a Spring dependency cycle.
     */
    private final org.springframework.beans.factory.ObjectProvider<ContextTemplateService> contextTemplates;
    private final RequesterAuthority requesterAuthority;
    private final InstanceIdentityService instanceIdentity;

    public ApiRequestTemplateService(ConfigJpaRepository configs, ConfigAuditRepository audits, ProviderConnectionRepository connections,
                                     EntityManager em, ObjectMapper json, ApiInputTypeService types,
                                     ApiRequestValidator validator, org.springframework.beans.factory.ObjectProvider<WorkspaceService> workspaces, DbLockTimeout timeout,
                                     org.springframework.beans.factory.ObjectProvider<ContextTemplateService> contextTemplates,
                                     RequesterAuthority requesterAuthority,
                                      InstanceIdentityService instanceIdentity) {
        this.configs = configs;
        this.audits = audits;
        this.connections = connections;
        this.em = em;
        this.json = json;
        this.types = types;
        this.validator = validator;
        this.workspaces = workspaces;
        this.timeout = timeout;
        this.contextTemplates = contextTemplates;
        this.requesterAuthority = requesterAuthority;
        this.instanceIdentity = instanceIdentity;
    }

    public static CpApiException invalid(String message) {
        return new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", message);
    }

    public static CpApiException conflict(String code, String message) {
        return new CpApiException(HttpStatus.CONFLICT, code, message);
    }

    /**
     * PLAN-0651 M3 T3.1 (A23): the instance-layer read surface is the N2 atom,
     * {@code READ_INSTANCE_CONTENT}, evaluated at instance scope.
     */
    private boolean canReadInstanceContent() {
        return holdsInstanceAtom(ToolFaceRegistry.ACTION_READ_INSTANCE_CONTENT);
    }

    /**
     * PLAN-0651 M3 T3.1 (A23): the instance-layer write surface is the N3 atom,
     * {@code WRITE_INSTANCE_CONTENT}, evaluated at instance scope.
     */
    private boolean canWriteInstanceContent() {
        return holdsInstanceAtom(ToolFaceRegistry.ACTION_WRITE_INSTANCE_CONTENT);
    }

    /**
     * PLAN-0651 M3 T3.1 (A23): the cross-user / cross-workspace support bypass keeps the
     * privileged-operator meaning: either instance-content atom qualifies, so the built-in
     * ADMIN/SUPER_ADMIN roles keep today's reach while a custom role can be granted it explicitly.
     */
    private boolean canManageAnyTemplateLayer() {
        return canReadInstanceContent() || canWriteInstanceContent();
    }

    private boolean holdsInstanceAtom(String actionClass) {
        String actor = TenantContext.getUserId();
        if (actor == null) {
            return false;
        }
        try {
            return requesterAuthority.holdsActionAtom(UUID.fromString(actor), actionClass, null);
        } catch (IllegalArgumentException invalidActor) {
            return false;
        }
    }

    private void access(String layer, UUID user, UUID workspace, boolean write) {
        String actor = TenantContext.getUserId();
        if (actor == null) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authentication required");
        }
        switch (layer) {
            case "instance" -> {
                if (write && !canWriteInstanceContent()) {
                    throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "Instance writes require admin");
                }
            }
            case "user" -> {
                if (user == null || (!actor.equals(user.toString())
                        && !(write ? canWriteInstanceContent() : canReadInstanceContent()))) {
                    throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "User scope is not accessible");
                }
            }
            case "workspace" -> {
                if (workspace == null) {
                    throw invalid("workspaceId is required");
                }
                workspaces.getObject().requireAccessibleWorkspace(workspace.toString(), actor);
                if (write) {
                    // PLAN-0559: workspace-layer writes require EDITOR or OWNER.
                    String role = TenantContext.getWorkspaceRole();
                    if (!canManageAnyTemplateLayer() && !(workspace.toString().equals(TenantContext.getWorkspaceId())
                            && WorkspaceRole.canWrite(role))) {
                        throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "Workspace editor permission required");
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
            if (!canReadInstanceContent()) {
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
                // PLAN-0632 G-0: a built-in id now carries more than one immutable revision, so the
                // "already present?" test must be per (id, version). Dedupe by id alone would hide the
                // newer seed from the editor as soon as any client round-trips an older revision.
                boolean exists = false;
                for (JsonNode item : templates) {
                    exists |= item.path("id").equals(builtin.path("id"))
                            && item.path("version").asInt() == builtin.path("version").asInt();
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
        putLayer(layer, entries, actor, user, workspace, null);
    }

    /**
     * task-309: same write, tagged with the door whose atom gate authorized it. This domain writes the
     * same {@code config_audit} table as the main path with the same digest shape ({@link #auditHash}),
     * so it must carry the same source tag — otherwise "covered" would be true only for the domains
     * that happen to route through {@code ConfigService}.
     */
    @Transactional
    public void putLayer(String layer, Map<String, String> entries, String actor, UUID user, UUID workspace,
            String atomSource) {
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
            save(layer, user, workspace, entry.getKey(), entry.getValue(), actor, atomSource);
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
        save(layer, user, workspace, key, value, actor, null);
    }

    /** task-309: same write, tagged with the door whose atom gate authorized it (null = no gate). */
    private void save(String layer, UUID user, UUID workspace, String key, String value, String actor,
            String atomSource) {
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
        audit.setAtomSource(atomSource);
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
            String owner = layer.equals("user") ? String.valueOf(user)
                    : layer.equals("workspace") ? String.valueOf(workspace)
                    : instanceIdentity.ownerId();
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
        // D-922: an INSTANCE connection is consumable by any bound consumer; listing and writes
        // are gated separately by the instance:admin capability.
        if (ProviderConnection.OWNER_INSTANCE.equals(connection.getOwnerType())
                && instanceIdentity.isInstanceOwnerId(connection.getOwnerId())) {
            return;
        }
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
            String layer = ownerLayer(connection);
            UUID owner = ownerUuid(connection);
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
        mergeContextComponents(template, user, workspace);
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

    /**
     * BL-284: the admission snapshot freezes BOTH halves of the context:
     * <ul>
     *   <li>{@code bodySource} — the wire template, owned by the API request template;</li>
     *   <li>{@code components} — the component manifest, owned by the context template
     *       ({@code context-templates} domain, resolved workspace → user → instance → built-in).</li>
     * </ul>
     *
     * <p>The merge happens <b>here, at admission</b>, and the result is stored on the ChatRun, so the
     * same run always sees the same context (the fingerprint would be meaningless if the read side
     * stitched it together later).</p>
     *
     * <p><b>Merge rule (Lead ruling 2026-11-05, BL-284 follow-up):</b> the merged manifest is the
     * <b>union of component types</b>. When both sides declare the same type, the <b>API request
     * template's component wins</b> — it is the more specific artifact for that connection/session,
     * while the context template is the default provider. A duplicate of the same type <b>inside one
     * manifest</b> is illegal input and still fails with
     * {@code 409 CONTEXT_TEMPLATE_COMPONENTS_CONFLICT}.</p>
     */
    void mergeContextComponents(ObjectNode template, UUID user, UUID workspace) {
        ContextTemplateService.TemplateBinding contextBinding = contextTemplates.getObject().defaultBinding(user, workspace);
        JsonNode contextComponents = contextBinding.snapshot().path("template").path("components");
        if (!contextComponents.isArray() || contextComponents.isEmpty()) {
            return;
        }
        JsonNode existing = template.path("components");
        if (!existing.isArray() || existing.isEmpty()) {
            template.set("components", contextComponents.deepCopy());
            return;
        }
        template.set("components", mergeManifests(existing, contextComponents));
    }

    /**
     * Union by component type; the API request template wins on a shared type. Order is stable:
     * the context template's order first (shared types replaced in place), then API-only types in
     * their own order — so two equal inputs always produce the same snapshot.
     */
    private ArrayNode mergeManifests(JsonNode apiManifest, JsonNode contextManifest) {
        Map<String, JsonNode> apiByType = indexByType(apiManifest, "apiRequestTemplate");
        Map<String, JsonNode> contextByType = indexByType(contextManifest, "contextTemplate");
        ArrayNode merged = json.createArrayNode();
        for (JsonNode contextComponent : contextManifest) {
            String type = contextComponent.path("type").asText("");
            JsonNode chosen = apiByType.getOrDefault(type, contextComponent);
            merged.add(chosen.deepCopy());
        }
        for (Map.Entry<String, JsonNode> entry : apiByType.entrySet()) {
            if (!contextByType.containsKey(entry.getKey())) {
                merged.add(entry.getValue().deepCopy());
            }
        }
        return merged;
    }

    /** Rejects a manifest that declares the same component type twice (illegal input, not a conflict). */
    private Map<String, JsonNode> indexByType(JsonNode manifest, String side) {
        Map<String, JsonNode> byType = new LinkedHashMap<>();
        for (JsonNode component : manifest) {
            String type = component.path("type").asText("");
            JsonNode previous = byType.put(type, component);
            if (previous != null) {
                throw new CpApiException(HttpStatus.CONFLICT, "CONTEXT_TEMPLATE_COMPONENTS_CONFLICT",
                        "Duplicate component type in " + side + ": " + type);
            }
        }
        return byType;
    }

    /**
     * PLAN-0642 D42-05 / design §4.3: the model/connection bundle became <b>optional</b>.
     *
     * <ul>
     *   <li><b>Mandatory</b>: the context-template triple (the run's template + skills snapshot must
     *       be pinned). Missing ⇒ 409 {@code API_TYPE_REBIND_REQUIRED} with {@code reason=partial_binding}.</li>
     *   <li><b>Bound</b>: all four model/connection columns present ⇒ today's revision check stays
     *       fail-closed ({@code reason=connection_revision_changed}).</li>
     *   <li><b>Partially set</b> ⇒ 409 {@code API_TYPE_REBIND_REQUIRED} ({@code reason=partial_binding});
     *       a half-written bundle can never silently mean "unbound".</li>
     *   <li><b>Unbound</b>: the four columns are all empty ⇒ the model identity is resolved at run
     *       time by {@link com.cc01cc.p.xihe.cp.chat.ChatModelResolutionService}; admission only pins
     *       the stored context-template ref ({@code source=pinned}).</li>
     * </ul>
     */
    public ObjectNode admissionSnapshot(Session session) {
        if (session.getContextTemplateLayer() == null || session.getContextTemplateId() == null
                || session.getContextTemplateVersion() == null) {
            throw rebindRequired("Explicit Session binding is required", "partial_binding");
        }
        if (isModelBindingComplete(session)) {
            ProviderConnection connection = connections.findById(UUID.fromString(session.getProviderConnectionId())).orElseThrow();
            requireVisible(connection, session.getUserId(), session.getWorkspaceId());
            requireChat(connection);
            if (!Long.valueOf(connection.getRevision()).equals(session.getConnectionRevision())) {
                throw rebindRequired("Connection changed; explicitly rebind the Session",
                        "connection_revision_changed");
            }
            return resolve(connection, session.getModelName(), UUID.fromString(session.getUserId()),
                    session.getWorkspaceId() == null ? null : UUID.fromString(session.getWorkspaceId()),
                    sessionTemplateRef(session));
        }
        if (isModelBindingPartial(session)) {
            throw rebindRequired("Model/connection binding is incomplete; rebind or clear it",
                    "partial_binding");
        }
        return pinnedSnapshot(session);
    }

    /** D42-05: the explicit model/connection bundle is complete only when all four columns are set. */
    public static boolean isModelBindingComplete(Session session) {
        return hasText(session.getModelProvider()) && hasText(session.getModelName())
                && hasText(session.getProviderConnectionId()) && session.getConnectionRevision() != null;
    }

    /** D42-05: any-but-not-all four columns is a half-written bundle, never "unbound". */
    public static boolean isModelBindingPartial(Session session) {
        boolean any = hasText(session.getModelProvider()) || hasText(session.getModelName())
                || hasText(session.getProviderConnectionId()) || session.getConnectionRevision() != null;
        return any && !isModelBindingComplete(session);
    }

    private static boolean hasText(String value) {
        return value != null && !value.isBlank();
    }

    private static CpApiException rebindRequired(String message, String reason) {
        return conflict("API_TYPE_REBIND_REQUIRED", message).withExtra(Map.of("reason", reason));
    }

    private ObjectNode sessionTemplateRef(Session session) {
        return json.createObjectNode().put("layer", session.getContextTemplateLayer())
                .put("templateId", session.getContextTemplateId().toString())
                .put("version", session.getContextTemplateVersion());
    }

    /**
     * The unbound-Session snapshot: the context-template ref is already pinned on the Session, so
     * resolve it directly (no connection is needed to read the stored pin) and merge the context
     * components exactly like the bound path does.
     */
    private ObjectNode pinnedSnapshot(Session session) {
        UUID user = UUID.fromString(session.getUserId());
        UUID workspace = UUID.fromString(session.getWorkspaceId());
        ObjectNode ref = sessionTemplateRef(session);
        ObjectNode template = resolveRef(ref, user, workspace, "", json.createArrayNode());
        mergeContextComponents(template, user, workspace);
        ObjectNode snapshot = json.createObjectNode();
        snapshot.setAll(ref.deepCopy());
        snapshot.put("source", "pinned");
        snapshot.set("template", template);
        return snapshot;
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
        // D-922 (task-152 F1): the shared INSTANCE connection is only a last-resort fallback -
        // it is considered when no USER/WORKSPACE chat candidate exists for this provider.
        if (slots.isEmpty()) {
            for (ProviderConnection connection : connections.findByOwnerTypeAndOwnerId(
                    ProviderConnection.OWNER_INSTANCE, instanceIdentity.ownerId())) {
                if (!connection.isEnabled() || !ProviderConnection.STATUS_READY.equals(connection.getStatus())
                        || !"chat".equals(types.operation(connection.getApiTypeId(), connection.getApiTypeVersion()))
                        || provider != null && !provider.equals(connection.getProviderId())) {
                    continue;
                }
                slots.put(connection.getProviderId() + ":" + connection.getConnectionKey(), connection);
            }
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

    /**
     * The default pin for a connection that never chose a template: the CURRENT built-in revision,
     * i.e. revision 2 since PLAN-0632 Gate G-0 (it carries the {@code ${xh.skill_catalog}} /
     * {@code ${xh.agent_memory}} blocks). Revision 1 stays published and resolvable for Sessions and
     * connections that already pinned it — a published revision is never rewritten in place, so an
     * existing pin does not silently gain the new slots; only newly created Sessions get them.
     */
    public ObjectNode builtinRef(String type, int version) {
        types.require(type, version);
        return json.createObjectNode().put("layer", "instance").put("templateId", builtinId(type, version).toString()).put("version", 2);
    }

    @Transactional
    public int changeConnectionDefault(ProviderConnection connection, JsonNode ref) {
        String layer = ownerLayer(connection);
        UUID owner = ownerUuid(connection);
        UUID user = layer.equals("user") ? owner : null;
        UUID workspace = layer.equals("workspace") ? owner : null;
        // Connection row is already locked by the mutation owner.
        List<ConfigEntity> overrides = configs.findByLayerAndDomain("user", DOMAIN).stream()
                .filter(r -> r.getConfigKey().equals("providerModelBindings"))
                .filter(r -> object(r.getConfigValue()).has(connection.getId().toString()))
                .sorted(Comparator.comparing(r -> r.getUserId().toString())).toList();
        Set<String> scopes = new TreeSet<>();
        scopes.add(layer + ":" + (owner == null ? "instance" : owner));
        for (ConfigEntity row : overrides) {
            scopes.add("user:" + row.getUserId());
        }
        for (String scope : scopes) {
            String[] parts = scope.split(":", 2);
            if ("instance".equals(parts[0])) {
                lockScope("instance", null, null);
                continue;
            }
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
        String layer = ownerLayer(connection);
        UUID owner = ownerUuid(connection);
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
                        : sessionReferenceCount(connection.getId().toString()));
    }

    public long sessionReferenceCount(String connectionId) {
        return em.createQuery("select count(s) from Session s where s.providerConnectionId = :id", Long.class)
                .setParameter("id", connectionId).getSingleResult();
    }

    // ------------------------------------------------------------------
    // PLAN-0505: connection delete reference impact and cascade cleanup
    // ------------------------------------------------------------------

    /**
     * PLAN-0505 review fix (#6): single definition of "user-layer rows whose
     * {@code providerModelBindings} hold a non-empty entry for this
     * connection", shared by the preview and the cascade so the predicate,
     * lock set, removal set and audit counts cannot drift apart.
     */
    private List<ConfigEntity> bindingRows(String connectionId) {
        return configs.findByLayerAndDomain("user", DOMAIN).stream()
                .filter(r -> r.getConfigKey().equals("providerModelBindings"))
                .filter(r -> {
                    JsonNode bound = object(r.getConfigValue()).path(connectionId);
                    return bound.isObject() && !bound.isEmpty();
                })
                .sorted(Comparator.comparing(r -> r.getUserId().toString())).toList();
    }

    private ObjectNode ownerDefaultTemplates(ProviderConnection connection) {
        String layer = ownerLayer(connection);
        UUID owner = ownerUuid(connection);
        return object(raw(layer, layer.equals("user") ? owner : null,
                layer.equals("workspace") ? owner : null).getOrDefault("connectionDefaultTemplates", "{}"));
    }

    private String ownerLayer(ProviderConnection connection) {
        return connection.getOwnerType().toLowerCase(java.util.Locale.ROOT);
    }

    private UUID ownerUuid(ProviderConnection connection) {
        // D-922: INSTANCE rows carry the deployment instance id in owner_id; the instance config
        // layer has no per-owner id, so it resolves as (layer=instance, user=null, workspace=null).
        return ProviderConnection.OWNER_INSTANCE.equals(connection.getOwnerType())
                ? null : UUID.fromString(connection.getOwnerId());
    }

    /**
     * PLAN-0505 delete-impact preview (T2.1): counts of the config references
     * that a connection delete would cascade away. Read-only — no locks, no
     * writes; other users' binding contents are never exposed, only counts.
     */
    public Map<String, Object> deleteImpact(ProviderConnection connection) {
        List<ConfigEntity> overrides = bindingRows(connection.getId().toString());
        boolean defaultTemplateRef = ownerDefaultTemplates(connection)
                .has(connection.getId().toString());
        long sessionCount = sessionReferenceCount(connection.getId().toString());
        return Map.of("connectionId", connection.getId().toString(),
                "providerId", connection.getProviderId(),
                "connectionKey", connection.getConnectionKey(),
                "bindingCount", overrides.stream()
                        .mapToInt(r -> object(r.getConfigValue()).path(connection.getId().toString()).size()).sum(),
                "bindingUserScopes", overrides.size(),
                "defaultTemplateRef", defaultTemplateRef,
                "sessionCount", sessionCount,
                "blocked", sessionCount > 0);
    }

    /** Counts for the audit record of one delete cleanup run. */
    public record CleanupCounts(int removedBindings, boolean removedDefaultTemplate, int bindingScopes) {}

    /**
     * PLAN-0505 cascade cleanup (T2.2): removes this connection's entries from
     * every user layer {@code providerModelBindings} row (cross-user, I2), the
     * owner layer {@code connectionDefaultTemplates} entry, and returns the
     * counts for the audit record. Runs inside the caller's delete transaction;
     * the caller holds the connection row lock. Scopes are locked in lexical
     * order (I5, TreeSet precedent of {@code changeConnectionDefault}).
     * {@code templates} is never touched (I1).
     */
    public CleanupCounts cleanupReferences(ProviderConnection connection) {
        String connectionId = connection.getId().toString();
        List<ConfigEntity> overrides = bindingRows(connectionId);
        Set<String> scopes = new TreeSet<>();
        UUID connectionOwner = ownerUuid(connection);
        scopes.add(ownerLayer(connection) + ":" + (connectionOwner == null ? "instance" : connectionOwner));
        for (ConfigEntity row : overrides) {
            scopes.add("user:" + row.getUserId());
        }
        for (String scope : scopes) {
            String[] parts = scope.split(":", 2);
            if ("instance".equals(parts[0])) {
                lockScope("instance", null, null);
                continue;
            }
            UUID scopeOwner = UUID.fromString(parts[1]);
            lockScope(parts[0], parts[0].equals("user") ? scopeOwner : null,
                    parts[0].equals("workspace") ? scopeOwner : null);
        }
        int removedBindings = 0;
        for (ConfigEntity row : overrides) {
            em.refresh(row);
            ObjectNode bindings = object(row.getConfigValue());
            JsonNode bound = bindings.path(connectionId);
            if (!bound.isObject() || bound.isEmpty()) {
                continue;
            }
            removedBindings += bound.size();
            bindings.remove(connectionId);
            save("user", row.getUserId(), null, "providerModelBindings", write(bindings), TenantContext.getUserId());
        }
        boolean removedDefaultTemplate = false;
        String layer = ownerLayer(connection);
        UUID owner = ownerUuid(connection);
        ObjectNode defaults = ownerDefaultTemplates(connection);
        if (defaults.has(connectionId)) {
            defaults.remove(connectionId);
            save(layer, layer.equals("user") ? owner : null, layer.equals("workspace") ? owner : null,
                    "connectionDefaultTemplates", write(defaults), TenantContext.getUserId());
            removedDefaultTemplate = true;
        }
        return new CleanupCounts(removedBindings, removedDefaultTemplate, overrides.size());
    }

    private UUID builtinId(String type, int version) {
        return UUID.nameUUIDFromBytes((DOMAIN + ":" + type + "@" + version).getBytes(StandardCharsets.UTF_8));
    }

    /**
     * PLAN-0632 Gate G-0: one built-in seed per (chat apiType, revision). Revision 1 is FROZEN
     * byte-for-byte — it is what every Session/connection pinned before G-0 resolves to, so changing
     * it in place would silently rewrite a published revision (and break
     * {@code API_REQUEST_TEMPLATE_REVISION_IMMUTABLE} equality checks against stored copies).
     * Revision 2 is the current seed and carries the two context-block slots. Existing pins therefore
     * keep working unchanged and simply do not carry the new blocks — upgrading does NOT retro-fit a
     * slot into an already published template.
     */
    public List<JsonNode> builtins() {
        List<JsonNode> result = new ArrayList<>();
        for (Map<String, Object> type : types.list()) {
            if (!"chat".equals(type.get("operation"))) {
                continue;
            }
            String id = type.get("apiTypeId").toString();
            int version = ((Number) type.get("version")).intValue();
            result.add(builtin(id, version, 1, id + " default", legacyBody(id)));
            result.add(builtin(id, version, 2, id + " default v2", contextBody(id)));
        }
        return List.copyOf(result);
    }

    /** Revision 1 (frozen): the pre-G-0 seed, no context-block slots. */
    private String legacyBody(String id) {
        if (id.equals("mimo-responses")) {
            return "{\"model\":\"${xh.model}\",\"input\":[\"${xh.conversation_history}\",{\"role\":\"user\",\"content\":\"${xh.user_input}\"}],\"instructions\":\"${xh.agent_instructions}\",\"tools\":[\"${xh.tools}\"],\"stream\":true}";
        } else if (id.equals("anthropic-messages")) {
            return "{\"model\":\"${xh.model}\",\"system\":\"${xh.agent_instructions}\",\"messages\":[\"${xh.conversation_history}\",{\"role\":\"user\",\"content\":\"${xh.user_input}\"}],\"tools\":[\"${xh.tools}\"],\"max_tokens\":4096,\"stream\":true}";
        } else {
            return "{\"model\":\"${xh.model}\",\"messages\":[{\"role\":\"system\",\"content\":\"${xh.agent_instructions}\"},\"${xh.conversation_history}\",{\"role\":\"user\",\"content\":\"${xh.user_input}\"}],\"tools\":[\"${xh.tools}\"],\"stream\":true}";
        }
    }

    /**
     * Revision 2 (current seed): the same shapes with {@code ${xh.skill_catalog}} and
     * {@code ${xh.agent_memory}} appended to the instruction block.
     *
     * They are JOINED into the existing instruction string rather than emitted as their own messages
     * on purpose: both slots render empty until PLAN-0628/0629 land, and a provider message whose
     * content is the empty string is rejected by some upstreams, while trailing newlines are harmless.
     */
    private String contextBody(String id) {
        if (id.equals("mimo-responses")) {
            return "{\"model\":\"${xh.model}\",\"input\":[\"${xh.conversation_history}\",{\"role\":\"user\",\"content\":\"${xh.user_input}\"}],\"instructions\":\"${xh.agent_instructions}\\n\\n${xh.skill_catalog}\\n\\n${xh.agent_memory}\",\"tools\":[\"${xh.tools}\"],\"stream\":true}";
        } else if (id.equals("anthropic-messages")) {
            return "{\"model\":\"${xh.model}\",\"system\":\"${xh.agent_instructions}\\n\\n${xh.skill_catalog}\\n\\n${xh.agent_memory}\",\"messages\":[\"${xh.conversation_history}\",{\"role\":\"user\",\"content\":\"${xh.user_input}\"}],\"tools\":[\"${xh.tools}\"],\"max_tokens\":4096,\"stream\":true}";
        } else {
            return "{\"model\":\"${xh.model}\",\"messages\":[{\"role\":\"system\",\"content\":\"${xh.agent_instructions}\\n\\n${xh.skill_catalog}\\n\\n${xh.agent_memory}\"},\"${xh.conversation_history}\",{\"role\":\"user\",\"content\":\"${xh.user_input}\"}],\"tools\":[\"${xh.tools}\"],\"stream\":true}";
        }
    }

    private ObjectNode builtin(String id, int apiTypeVersion, int revision, String name, String body) {
        return json.createObjectNode().put("id", builtinId(id, apiTypeVersion).toString()).put("version", revision)
                .put("name", name).put("description", "Built-in API Request Template")
                .put("apiTypeId", id).put("apiTypeVersion", apiTypeVersion).put("bodySource", body).put("status", "published");
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



