package com.cc01cc.p.xihe.cp.skill;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * PLAN-0628 M1 (V101): one skill binding, expressed on the <b>two axes</b> of D28-14 — exactly the
 * {@code role_bindings} shape (V87:40-61), not a single four-value enum.
 *
 * <p>{@code (subject_type × scope_type)} yields four combinations to a client; the fifth
 * "instance-wide shared" tier is deliberately <b>not</b> in v1 (no {@code subject_type='instance'}
 * and no nullable {@code subject_id} — the CHECK rejects both):</p>
 *
 * <table border="1">
 *   <caption>2×2 semantics (README D28-14; also in DEV-014)</caption>
 *   <tr><th>subject</th><th>scope</th><th>meaning</th></tr>
 *   <tr><td>{@code user}</td><td>{@code instance}</td><td>that user, in every workspace it may run
 *       in</td></tr>
 *   <tr><td>{@code user}</td><td>{@code workspace}</td><td>that user, only inside that workspace
 *       (the extra tier D28-14 gains over a single enum)</td></tr>
 *   <tr><td>{@code agent_principal}</td><td>{@code instance}</td><td>that subject, every
 *       workspace</td></tr>
 *   <tr><td>{@code agent_principal}</td><td>{@code workspace}</td><td>that subject, only that
 *       workspace</td></tr>
 * </table>
 *
 * <p>{@code uq_skill_bindings UNIQUE NULLS NOT DISTINCT (skill_id, subject_type, subject_id,
 * scope_type, scope_id)} makes a duplicate binding impossible — including the instance tier where
 * {@code scope_id} is NULL (the V87 round-2 P0 precedent).</p>
 */
@Entity
@Table(name = "skill_bindings")
public class SkillBinding {

    /** Same vocabulary as {@code role_bindings} (V87:43,49); mirrors the V101 CHECK. */
    public static final String SUBJECT_USER = "user";
    public static final String SUBJECT_AGENT_PRINCIPAL = "agent_principal";
    public static final List<String> SUBJECT_TYPES = List.of(SUBJECT_USER, SUBJECT_AGENT_PRINCIPAL);

    public static final String SCOPE_INSTANCE = "instance";
    public static final String SCOPE_WORKSPACE = "workspace";
    public static final List<String> SCOPE_TYPES = List.of(SCOPE_INSTANCE, SCOPE_WORKSPACE);

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "skill_id", nullable = false, columnDefinition = "uuid")
    private UUID skillId;

    @Column(name = "subject_type", nullable = false, length = 24)
    private String subjectType;

    /** Never NULL: the "everyone shares it" tier is out of scope for v1 (see class javadoc). */
    @Column(name = "subject_id", nullable = false, columnDefinition = "uuid")
    private UUID subjectId;

    @Column(name = "scope_type", nullable = false, length = 16)
    private String scopeType;

    /** NULL only for {@code scope_type='instance'} (CHECK-enforced biconditional). */
    @Column(name = "scope_id", columnDefinition = "uuid")
    private UUID scopeId;

    @Column(name = "created_by_user_id", nullable = false, columnDefinition = "uuid")
    private UUID createdByUserId;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public SkillBinding() {}

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

    public UUID getSkillId() { return skillId; }

    public void setSkillId(UUID skillId) { this.skillId = skillId; }

    public String getSubjectType() { return subjectType; }

    public void setSubjectType(String subjectType) { this.subjectType = subjectType; }

    public UUID getSubjectId() { return subjectId; }

    public void setSubjectId(UUID subjectId) { this.subjectId = subjectId; }

    public String getScopeType() { return scopeType; }

    public void setScopeType(String scopeType) { this.scopeType = scopeType; }

    public UUID getScopeId() { return scopeId; }

    public void setScopeId(UUID scopeId) { this.scopeId = scopeId; }

    public UUID getCreatedByUserId() { return createdByUserId; }

    public void setCreatedByUserId(UUID createdByUserId) { this.createdByUserId = createdByUserId; }

    public Instant getCreatedAt() { return createdAt; }
}
