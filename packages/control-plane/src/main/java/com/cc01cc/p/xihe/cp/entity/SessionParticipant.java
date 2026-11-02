package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

/**
 * PLAN-0623 R2: one row per conversation participant.
 *
 * <p>The reference to the principal is <b>polymorphic</b> ({@code principal_kind} +
 * {@code principal_id}) and carries no foreign key — the same shape as
 * {@code role_bindings(subject_type, subject_id)} (V87). A HUMAN participant points at
 * {@code users.id}, an AGENT participant at {@code agent_principals.id}; the database cannot
 * enforce that with a single FK, so the service layer validates the referenced row exists.</p>
 *
 * <p>R4: {@code orderIndex} is a monotonically increasing integer (10, 20, 30 …) with gaps left by
 * removals and never renumbered — callers must order by it, never by list position.</p>
 *
 * <p>Deliberately absent: a cap snapshot. The cap is resolved live via
 * {@code resolveCapFor(principalId, workspaceId)} (Lead ruling 2026-11-02).</p>
 */
@Entity
@Table(name = "session_participants")
public class SessionParticipant {

    public static final String KIND_HUMAN = "HUMAN";
    public static final String KIND_AGENT = "AGENT";

    public static final String ROLE_PRIMARY = "PRIMARY";
    public static final String ROLE_MEMBER = "MEMBER";
    public static final String ROLE_GUARD = "GUARD";

    public static final String WAKE_ALL_MESSAGES = "ALL_MESSAGES";
    public static final String WAKE_MENTION = "MENTION";
    // PLAN-0624 M2 (V93 widened the CHECK; the constant arrives with the scheduler).
    public static final String WAKE_SCHEDULE = "SCHEDULE";

    public static final String RESPOND_ALWAYS = "ALWAYS";
    public static final String RESPOND_WHEN_MENTIONED = "WHEN_MENTIONED";
    public static final String RESPOND_JUDGE = "JUDGE";
    public static final String RESPOND_MUTED = "MUTED";

    @Id
    private UUID id;

    @Column(name = "session_id", nullable = false, updatable = false)
    private UUID sessionId;

    @Column(name = "principal_kind", nullable = false, updatable = false)
    private String principalKind;

    @Column(name = "principal_id", nullable = false, updatable = false)
    private UUID principalId;

    @Column(name = "role", nullable = false)
    private String role;

    @Column(name = "order_index", nullable = false, updatable = false)
    private Integer orderIndex;

    @Column(name = "wake_policy", nullable = false)
    private String wakePolicy;

    @Column(name = "respond_policy", nullable = false)
    private String respondPolicy;

    /** PLAN-0624 M2 (V93): per-participant schedule parameters; required when wake=SCHEDULE. */
    @org.hibernate.annotations.JdbcTypeCode(org.hibernate.type.SqlTypes.JSON)
    @jakarta.persistence.Column(name = "wake_config", columnDefinition = "jsonb")
    private com.fasterxml.jackson.databind.JsonNode wakeConfig;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "disabled_at")
    private Instant disabledAt;

    public SessionParticipant() {}

    public SessionParticipant(UUID sessionId, String principalKind, UUID principalId, String role,
                              Integer orderIndex, String wakePolicy, String respondPolicy) {
        this.id = UUID.randomUUID();
        this.sessionId = sessionId;
        this.principalKind = principalKind;
        this.principalId = principalId;
        this.role = role;
        this.orderIndex = orderIndex;
        this.wakePolicy = wakePolicy;
        this.respondPolicy = respondPolicy;
    }

    @PrePersist
    protected void onCreate() {
        if (id == null) {
            id = UUID.randomUUID();
        }
        if (createdAt == null) {
            createdAt = Instant.now();
        }
    }

    public boolean isPrimary() {
        return ROLE_PRIMARY.equals(role);
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }

    public UUID getSessionId() { return sessionId; }
    public void setSessionId(UUID sessionId) { this.sessionId = sessionId; }

    public String getPrincipalKind() { return principalKind; }
    public void setPrincipalKind(String principalKind) { this.principalKind = principalKind; }

    public UUID getPrincipalId() { return principalId; }
    public void setPrincipalId(UUID principalId) { this.principalId = principalId; }

    public String getRole() { return role; }
    public void setRole(String role) { this.role = role; }

    public Integer getOrderIndex() { return orderIndex; }
    public void setOrderIndex(Integer orderIndex) { this.orderIndex = orderIndex; }

    public String getWakePolicy() { return wakePolicy; }
    public void setWakePolicy(String wakePolicy) { this.wakePolicy = wakePolicy; }

    public String getRespondPolicy() { return respondPolicy; }
    public com.fasterxml.jackson.databind.JsonNode getWakeConfig() { return wakeConfig; }
    public void setWakeConfig(com.fasterxml.jackson.databind.JsonNode wakeConfig) { this.wakeConfig = wakeConfig; }
    public void setRespondPolicy(String respondPolicy) { this.respondPolicy = respondPolicy; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getDisabledAt() { return disabledAt; }
    public void setDisabledAt(Instant disabledAt) { this.disabledAt = disabledAt; }
}
