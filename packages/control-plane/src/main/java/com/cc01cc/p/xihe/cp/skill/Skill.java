package com.cc01cc.p.xihe.cp.skill;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

/**
 * PLAN-0628 M1 (V101): one imported skill definition.
 *
 * <p><b>Definition scope is part of the definition</b> (D28-14 + README frozen #4 "双存"): the same
 * {@code name} may exist once in the instance library, once per workspace, and once per user (the
 * personal layer added by V156). The DB enforces it with {@code uq_skills_qualified_name UNIQUE
 * NULLS NOT DISTINCT (name, definition_scope_type, definition_scope_id, definition_scope_user_id)}
 * — the instance rows' NULL scope ids must collide, which is exactly the {@code role_bindings} trap
 * from V87:53-55; and the fourth column is what keeps two users' same-named personal rows apart.</p>
 *
 * <p>Server-computed fields, never read from a request body (V99 discipline): {@link #bodyTokensEst},
 * {@link #oversize}, {@link #contentHash}, {@link #version}. {@link #attachments} is a
 * <b>manifest only</b> (D28-21): paths, sizes and hashes — the bytes stay in the source tree.</p>
 *
 * <p>The jsonb column is held as a Jackson-2 node <b>internally</b> (same as
 * {@code AgentPrincipal.templateSnapshot}); it must never reach a response — wire types project it
 * into {@link SkillAttachmentView} (PLAN-0633 C1).</p>
 */
@Entity
@Table(name = "skills")
public class Skill {

    /** D28-14 vocabulary; mirrors the V156 CHECK on {@code definition_scope_type}. */
    public static final String DEFINITION_SCOPE_INSTANCE = "instance";
    public static final String DEFINITION_SCOPE_WORKSPACE = "workspace";
    /**
     * D-1019 / V156: the personal layer. Its owner is the authenticated caller and lives in
     * {@code definition_scope_user_id}; {@code definition_scope_id} stays NULL for these rows (it
     * keeps its V101 foreign key to {@code workspaces}).
     */
    public static final String DEFINITION_SCOPE_USER = "user";

    /** D28-16 frozen numbers; the DDL enforces them, these constants keep callers in sync. */
    public static final int MAX_NAME_LENGTH = 64;
    public static final int MAX_DESCRIPTION_LENGTH = 1024;
    public static final int MAX_BODY_BYTES = 262_144;
    /** D28-15: at or above this estimate the row is <b>marked</b>, never rejected. */
    public static final int OVERSIZE_TOKENS = 5000;

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "name", nullable = false, columnDefinition = "TEXT")
    private String name;

    @Column(name = "definition_scope_type", nullable = false, length = 16)
    private String definitionScopeType;

    /** NULL for the instance library; a workspace id for a workspace-private library. */
    @Column(name = "definition_scope_id", columnDefinition = "uuid")
    private UUID definitionScopeId;

    /**
     * The owner of a personal ({@code type=user}) definition; NULL for instance and workspace rows.
     * Two columns rather than one polymorphic id because {@code definition_scope_id} keeps its V101
     * foreign key to {@code workspaces} (D-1019: value = referential integrity, not cascade cleanup
     * — {@code created_by_user_id}'s RESTRICT already decides who may delete a creator).
     */
    @Column(name = "definition_scope_user_id", columnDefinition = "uuid")
    private UUID definitionScopeUserId;

    @Column(name = "description", nullable = false, columnDefinition = "TEXT")
    private String description;

    /** SKILL.md body with the frontmatter block removed (M2 injects it verbatim). */
    @Column(name = "body", nullable = false, columnDefinition = "TEXT")
    private String body;

    @Column(name = "body_tokens_est", nullable = false)
    private int bodyTokensEst;

    @Column(name = "oversize", nullable = false)
    private boolean oversize;

    /** Manifest only — see {@link SkillAttachmentView}. */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "attachments", nullable = false, columnDefinition = "jsonb")
    private JsonNode attachments;

    @Column(name = "trusted", nullable = false)
    private boolean trusted;

    @Column(name = "source_path", nullable = false, columnDefinition = "TEXT")
    private String sourcePath;

    @Column(name = "content_hash", nullable = false, length = 64)
    private String contentHash;

    @Column(name = "version", nullable = false)
    private int version = 1;

    @Column(name = "created_by_user_id", nullable = false, columnDefinition = "uuid")
    private UUID createdByUserId;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public Skill() {}

    @PrePersist
    protected void onCreate() {
        if (id == null) {
            id = UUID.randomUUID();
        }
        Instant now = Instant.now();
        if (createdAt == null) {
            createdAt = now;
        }
        if (updatedAt == null) {
            updatedAt = now;
        }
    }

    /** Any content change bumps {@link #version} explicitly; this only tracks freshness. */
    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now();
    }

    public UUID getId() { return id; }

    public void setId(UUID id) { this.id = id; }

    public String getName() { return name; }

    public void setName(String name) { this.name = name; }

    public String getDefinitionScopeType() { return definitionScopeType; }

    public void setDefinitionScopeType(String definitionScopeType) {
        this.definitionScopeType = definitionScopeType;
    }

    public UUID getDefinitionScopeId() { return definitionScopeId; }

    public void setDefinitionScopeId(UUID definitionScopeId) { this.definitionScopeId = definitionScopeId; }

    public UUID getDefinitionScopeUserId() { return definitionScopeUserId; }

    public void setDefinitionScopeUserId(UUID definitionScopeUserId) {
        this.definitionScopeUserId = definitionScopeUserId;
    }

    /** True when the row belongs to the personal layer (one owner, never bindable). */
    public boolean isPersonal() { return DEFINITION_SCOPE_USER.equals(definitionScopeType); }

    public String getDescription() { return description; }

    public void setDescription(String description) { this.description = description; }

    public String getBody() { return body; }

    public void setBody(String body) { this.body = body; }

    public int getBodyTokensEst() { return bodyTokensEst; }

    public void setBodyTokensEst(int bodyTokensEst) { this.bodyTokensEst = bodyTokensEst; }

    public boolean isOversize() { return oversize; }

    public void setOversize(boolean oversize) { this.oversize = oversize; }

    public JsonNode getAttachments() { return attachments; }

    public void setAttachments(JsonNode attachments) { this.attachments = attachments; }

    public boolean isTrusted() { return trusted; }

    public void setTrusted(boolean trusted) { this.trusted = trusted; }

    public String getSourcePath() { return sourcePath; }

    public void setSourcePath(String sourcePath) { this.sourcePath = sourcePath; }

    public String getContentHash() { return contentHash; }

    public void setContentHash(String contentHash) { this.contentHash = contentHash; }

    public int getVersion() { return version; }

    public void setVersion(int version) { this.version = version; }

    public UUID getCreatedByUserId() { return createdByUserId; }

    public void setCreatedByUserId(UUID createdByUserId) { this.createdByUserId = createdByUserId; }

    public Instant getCreatedAt() { return createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
}
