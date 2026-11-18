package com.cc01cc.p.xihe.cp.entity;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import jakarta.persistence.Column;
import jakarta.persistence.Convert;
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
 * task-188 MVP⑤ S2: one row of the shared team-task board (V172).
 *
 * <p>One board per tree — the board key is the tree's root session
 * ({@code team_root_session_id}), established by {@code DelegationChainWalker} the moment the
 * first row is written. The stored root is the write-time snapshot; reads recompute the root
 * anyway (a row written before any spawn's root is itself). Lifecycle is an advisory CAS:
 * {@code status} moves pending → in_progress → completed (deleted is the advisory tombstone)
 * guarded by {@code expectedRevision == revision}; there is deliberately no claim lease or
 * expiry (bl-354: no leased claim shape). {@code blocked_by} / {@code write_scopes} are advisory
 * arrays and never gate transitions; {@code write_scope_warnings} is DERIVED at read time and
 * intentionally not stored. {@code revision} is monotonic (+1 per successful mutation); readers
 * see it but never gate on it.</p>
 */
@Entity
@Table(name = "team_tasks")
public class TeamTask {

    public static final String STATUS_PENDING = "pending";
    public static final String STATUS_IN_PROGRESS = "in_progress";
    public static final String STATUS_COMPLETED = "completed";
    public static final String STATUS_DELETED = "deleted";

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    /** Per-board atomic sequence; displayed as task-<taskNo>. */
    @Column(name = "task_no", nullable = false)
    private long taskNo;

    @Column(nullable = false, length = 200)
    private String subject;

    @Column(columnDefinition = "TEXT")
    private String description;

    @Column(nullable = false, length = 16)
    private String status = STATUS_PENDING;

    /** Advisory owner; null = unclaimed. A reassign may name any descendant session of the board root. */
    @Column(name = "owner_session_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String ownerSessionId;

    @Column(name = "owner_name", length = 64)
    private String ownerName;

    /** Advisory dependency ids; never gate transitions. */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "blocked_by", nullable = false, columnDefinition = "jsonb")
    private JsonNode blockedBy = JsonNodeFactory.instance.arrayNode();

    /** Advisory workspace-relative write scopes; warnings are derived at read time, not stored. */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "write_scopes", nullable = false, columnDefinition = "jsonb")
    private JsonNode writeScopes = JsonNodeFactory.instance.arrayNode();

    @Column(name = "created_by_session_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String createdBySessionId;

    @Column(name = "created_by_participant_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String createdByParticipantId;

    /** Write-time snapshot of the board root; reads recompute via DelegationChainWalker. */
    @Column(name = "team_root_session_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String teamRootSessionId;

    @Column(name = "workspace_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String workspaceId;

    /** Advisory CAS revision: monotonic +1 on every successful mutation. */
    @Column(nullable = false)
    private long revision = 0;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected TeamTask() {}

    public static TeamTask create() {
        TeamTask row = new TeamTask();
        // Assigned eagerly (not only in @PrePersist) so callers outside a JPA persistence context —
        // unit tests, the service's audit line — see the real id immediately.
        row.id = UUID.randomUUID();
        return row;
    }

    @PrePersist
    protected void onCreate() {
        if (id == null) {
            id = UUID.randomUUID();
        }
        if (blockedBy == null) {
            blockedBy = JsonNodeFactory.instance.arrayNode();
        }
        if (writeScopes == null) {
            writeScopes = JsonNodeFactory.instance.arrayNode();
        }
        Instant now = Instant.now();
        if (createdAt == null) {
            createdAt = now;
        }
        updatedAt = now;
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public long getTaskNo() { return taskNo; }
    public void setTaskNo(long taskNo) { this.taskNo = taskNo; }
    public String getSubject() { return subject; }
    public void setSubject(String subject) { this.subject = subject; }
    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public String getOwnerSessionId() { return ownerSessionId; }
    public void setOwnerSessionId(String ownerSessionId) { this.ownerSessionId = ownerSessionId; }
    public String getOwnerName() { return ownerName; }
    public void setOwnerName(String ownerName) { this.ownerName = ownerName; }
    public JsonNode getBlockedBy() { return blockedBy; }
    public void setBlockedBy(JsonNode blockedBy) {
        this.blockedBy = blockedBy == null ? JsonNodeFactory.instance.arrayNode() : blockedBy.deepCopy();
    }
    public JsonNode getWriteScopes() { return writeScopes; }
    public void setWriteScopes(JsonNode writeScopes) {
        this.writeScopes = writeScopes == null ? JsonNodeFactory.instance.arrayNode() : writeScopes.deepCopy();
    }
    public String getCreatedBySessionId() { return createdBySessionId; }
    public void setCreatedBySessionId(String createdBySessionId) { this.createdBySessionId = createdBySessionId; }
    public String getCreatedByParticipantId() { return createdByParticipantId; }
    public void setCreatedByParticipantId(String createdByParticipantId) {
        this.createdByParticipantId = createdByParticipantId;
    }
    public String getTeamRootSessionId() { return teamRootSessionId; }
    public void setTeamRootSessionId(String teamRootSessionId) { this.teamRootSessionId = teamRootSessionId; }
    public String getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(String workspaceId) { this.workspaceId = workspaceId; }
    public long getRevision() { return revision; }
    public void setRevision(long revision) { this.revision = revision; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
