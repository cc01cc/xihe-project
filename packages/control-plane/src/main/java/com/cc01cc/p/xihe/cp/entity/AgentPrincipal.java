package com.cc01cc.p.xihe.cp.entity;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "agent_principals")
public class AgentPrincipal {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "name", nullable = false, columnDefinition = "TEXT")
    private String name;

    @Column(name = "template_id", columnDefinition = "TEXT")
    private String templateId;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "template_snapshot", columnDefinition = "jsonb")
    private JsonNode templateSnapshot;

    @Column(name = "created_by_user_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String createdByUserId;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "disabled_at")
    private Instant disabledAt;

    /** PLAN-0625 (V95): USER = human-created; SYSTEM_PRESET = builtin guard preset. */
    public static final String ORIGIN_USER = "USER";
    public static final String ORIGIN_SYSTEM_PRESET = "SYSTEM_PRESET";

    /**
     * task-173 (V170, user ruling 40C / D-1532 ⑤; Lead ruling D-1540): <b>who owns this principal</b> —
     * an axis of its own, deliberately not merged with {@link #origin} (which axis says how the row came
     * to exist: user-created vs builtin preset).
     *
     * <ul>
     *   <li>{@code USER} — created through {@code /api/v1/agent-principals}; its creator and, later, a
     *       workspace that binds it manage it.</li>
     *   <li>{@code INSTANCE} — created through {@code /api/v1/instance/agent-principals}: a platform
     *       agent of this deployment. Only the {@code MANAGE_AGENT_PRINCIPALS} atom manages it
     *       (evaluated at the atom layer — never a role name), and the user prefix must not even list
     *       it.</li>
     * </ul>
     *
     * <p>There is no {@code UNKNOWN} value: "cannot be determined" is a migration-time refusal
     * (V170 raises), never a state a row may live in — that would be the fail-open D-1533 removed. The
     * column has no DEFAULT either: a forgotten write has to fail loudly, because a default would
     * silently mislabel one of the two doors (see V170's header).</p>
     */
    public static final String OWNERSHIP_USER = "USER";
    public static final String OWNERSHIP_INSTANCE = "INSTANCE";
    /** PLAN-0625 task-92: the guard template seeded in the instance agent-templates config (V95/V98). */
    public static final String BUILTIN_GUARD_PRESET_TEMPLATE_ID = "00000000-0000-4000-8000-0000000000a2";

    @jakarta.persistence.Column(name = "origin", nullable = false, length = 16)
    private String origin = ORIGIN_USER;

    /** PLAN-0625 (V95): the agent-templates preset id; null for user principals. */
    @jakarta.persistence.Column(name = "preset_id")
    private String presetId;

    /** PLAN-0625 (V96): hook subscriptions — runtime single-read surface for the approval gate. */
    @org.hibernate.annotations.JdbcTypeCode(org.hibernate.type.SqlTypes.JSON)
    @jakarta.persistence.Column(name = "hooks", columnDefinition = "jsonb")
    private com.fasterxml.jackson.databind.JsonNode hooks;

    /**
     * PLAN-0629 M1 (D29-21 / D23-20): the subject's memory policy document
     * {@code {"memory":{"enabled":false,"writeMode":"off","types":["profile","fact"]}}}.
     *
     * <p>D23-20 keeps this on the subject instead of the {@code context-policy} config domain, and V92
     * created the nullable {@code jsonb} column — this field is its first writer and first reader.
     * {@code null} = no policy (memory off). Shape validation has a single write-side gate:
     * {@code policy.ContextPolicyValidator}.</p>
     */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "context_policy", columnDefinition = "jsonb")
    private JsonNode contextPolicy;

    /**
     * PLAN-0630 M1: the subject's delegation budget {@code {"maxCount":8,"maxDepth":3}} (V100).
     *
     * <p>Same shape decision as {@link #contextPolicy} (D23-20): the budget is a property of the
     * subject, so it is a column here rather than a key in a config domain. {@code null} = code
     * defaults, and only the <b>root</b> subject's document is read (a sub-agent's own limits are inert
     * while it acts as a subagent). Shape validation has a single gate:
     * {@code policy.DelegationPolicyValidator}.</p>
     */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "delegation_policy", columnDefinition = "jsonb")
    private JsonNode delegationPolicy;

    /** Only ever set for {@code PERSONAL}; the DB CHECK constraint keeps the two in sync. */
    @Column(name = "owner_user_id", columnDefinition = "uuid")
    private UUID ownerUserId;

    /**
     * task-173 (V170): {@link #OWNERSHIP_USER} or {@link #OWNERSHIP_INSTANCE}. NOT NULL in the schema
     * and written explicitly by both creation doors.
     *
     * <p><b>No default lives here — on purpose</b> (Lead ruling on task-173). V170 adds no database
     * {@code DEFAULT}, so a forgotten write fails loudly; a Java field initializer would turn that
     * loud failure back into a silent {@code USER} label, which is exactly the fail-open that
     * {@code D-1533} forbids. The single production writer
     * ({@code AgentPrincipalService.createPrincipal(...)}) takes the ownership as a <b>required</b>
     * argument, and test fixtures name their intent through
     * {@code support.TestAgentPrincipals.newUserAgentPrincipal()} /
     * {@code newInstanceAgentPrincipal()} instead of relying on a default.</p>
     */
    @Column(name = "ownership", nullable = false, length = 16)
    private String ownership;

    /** Model intent only — the principal never holds a provider connection (resolved at run time). */
    @Column(name = "default_model_provider", columnDefinition = "TEXT")
    private String defaultModelProvider;

    @Column(name = "default_model_name", columnDefinition = "TEXT")
    private String defaultModelName;

    /** {@code [{provider,model}]} or null = unrestricted. */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "allowed_models", columnDefinition = "jsonb")
    private JsonNode allowedModels;

    public AgentPrincipal() {}

    @PrePersist
    protected void onCreate() {
        if (id == null) {
            id = UUID.randomUUID();
        }
        if (createdAt == null) {
            createdAt = Instant.now();
        }
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getTemplateId() { return templateId; }
    public void setTemplateId(String templateId) { this.templateId = templateId; }

    public JsonNode getTemplateSnapshot() { return templateSnapshot; }
    public void setTemplateSnapshot(JsonNode templateSnapshot) { this.templateSnapshot = templateSnapshot; }

    public String getCreatedByUserId() { return createdByUserId; }
    public void setCreatedByUserId(String createdByUserId) { this.createdByUserId = createdByUserId; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getDisabledAt() { return disabledAt; }
    public void setDisabledAt(Instant disabledAt) { this.disabledAt = disabledAt; }

    public String getOrigin() { return origin; }
    public void setOrigin(String origin) { this.origin = origin; }
    public String getPresetId() { return presetId; }
    public void setPresetId(String presetId) { this.presetId = presetId; }
    public com.fasterxml.jackson.databind.JsonNode getHooks() { return hooks; }
    public void setHooks(com.fasterxml.jackson.databind.JsonNode hooks) { this.hooks = hooks; }
    public JsonNode getContextPolicy() { return contextPolicy; }
    public void setContextPolicy(JsonNode contextPolicy) { this.contextPolicy = contextPolicy; }
    public JsonNode getDelegationPolicy() { return delegationPolicy; }
    public void setDelegationPolicy(JsonNode delegationPolicy) { this.delegationPolicy = delegationPolicy; }

    public UUID getOwnerUserId() { return ownerUserId; }
    public void setOwnerUserId(UUID ownerUserId) { this.ownerUserId = ownerUserId; }

    public String getOwnership() { return ownership; }
    public void setOwnership(String ownership) { this.ownership = ownership; }

    /** True for a platform agent of this deployment (V170). */
    public boolean isInstanceOwned() { return OWNERSHIP_INSTANCE.equals(ownership); }

    public String getDefaultModelProvider() { return defaultModelProvider; }
    public void setDefaultModelProvider(String defaultModelProvider) {
        this.defaultModelProvider = defaultModelProvider;
    }

    public String getDefaultModelName() { return defaultModelName; }
    public void setDefaultModelName(String defaultModelName) { this.defaultModelName = defaultModelName; }

    public JsonNode getAllowedModels() { return allowedModels; }
    public void setAllowedModels(JsonNode allowedModels) { this.allowedModels = allowedModels; }
}
