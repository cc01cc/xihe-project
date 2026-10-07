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

@Entity
@Table(name = "session_follow_up_items")
public class SessionFollowUpItem {

    public static final String STATUS_QUEUED = "queued";
    public static final String STATUS_PAUSED = "paused";
    public static final String STATUS_ADMITTED = "admitted";
    public static final String STATUS_COMPLETED = "completed";
    public static final String STATUS_WITHDRAWN = "withdrawn";
    public static final String PAUSE_PARENT_CANCELLED = "parent_cancelled";
    public static final String PAUSE_PARENT_AMBIGUOUS = "parent_ambiguous";
    public static final String PAUSE_CHILD_CANCELLED = "child_cancelled";
    public static final String PAUSE_CHILD_AMBIGUOUS = "child_ambiguous";
    public static final String PAUSE_BRANCH_UNAVAILABLE = "branch_unavailable";
    public static final String PAUSE_ATTACHMENT_UNAVAILABLE = "attachment_unavailable";
    public static final String PAUSE_SESSION_BINDING_STALE = "session_binding_stale";
    public static final String PAUSE_CHILD_MISSING = "child_missing";

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "session_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String sessionId;

    @Column(name = "queue_sequence", nullable = false)
    private long queueSequence;

    @Column(name = "idempotency_key", nullable = false, length = 128)
    private String idempotencyKey;

    @Column(name = "request_hash", nullable = false, length = 64)
    private String requestHash;

    @Column(columnDefinition = "TEXT")
    private String content;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "attachment_refs", nullable = false, columnDefinition = "jsonb")
    private JsonNode attachmentRefs = JsonNodeFactory.instance.arrayNode();

    @Column(name = "branch_id", nullable = false, columnDefinition = "uuid")
    private UUID branchId;

    @Column(name = "tool_mode", nullable = false, length = 20)
    private String toolMode = "none";

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "tool_timeouts", nullable = false, columnDefinition = "jsonb")
    private JsonNode toolTimeouts = JsonNodeFactory.instance.objectNode();

    @Column(length = 50)
    private String provider;

    @Column(length = 100)
    private String model;

    @Column(nullable = false, length = 16)
    private String status = STATUS_QUEUED;

    @Column(name = "pause_reason", length = 64)
    private String pauseReason;

    @Column(name = "anchor_run_id", columnDefinition = "uuid")
    private UUID anchorRunId;

    @Column(name = "pause_run_id", columnDefinition = "uuid")
    private UUID pauseRunId;

    @Column(name = "child_run_id", columnDefinition = "uuid")
    private UUID childRunId;

    @Column(name = "child_message_id", columnDefinition = "uuid")
    private UUID childMessageId;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Column(name = "admitted_at")
    private Instant admittedAt;

    @Column(name = "completed_at")
    private Instant completedAt;

    @Column(name = "withdrawn_at")
    private Instant withdrawnAt;

    protected SessionFollowUpItem() {}

    public static SessionFollowUpItem create() {
        return new SessionFollowUpItem();
    }

    @PrePersist
    protected void onCreate() {
        if (id == null) {
            id = UUID.randomUUID();
        }
        if (attachmentRefs == null) {
            attachmentRefs = JsonNodeFactory.instance.arrayNode();
        }
        if (toolTimeouts == null) {
            toolTimeouts = JsonNodeFactory.instance.objectNode();
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
    public String getSessionId() { return sessionId; }
    public void setSessionId(String sessionId) { this.sessionId = sessionId; }
    public long getQueueSequence() { return queueSequence; }
    public void setQueueSequence(long queueSequence) { this.queueSequence = queueSequence; }
    public String getIdempotencyKey() { return idempotencyKey; }
    public void setIdempotencyKey(String idempotencyKey) { this.idempotencyKey = idempotencyKey; }
    public String getRequestHash() { return requestHash; }
    public void setRequestHash(String requestHash) { this.requestHash = requestHash; }
    public String getContent() { return content; }
    public void setContent(String content) { this.content = content; }
    public JsonNode getAttachmentRefs() { return attachmentRefs; }
    public void setAttachmentRefs(JsonNode attachmentRefs) {
        this.attachmentRefs = attachmentRefs == null
                ? JsonNodeFactory.instance.arrayNode() : attachmentRefs.deepCopy();
    }
    public UUID getBranchId() { return branchId; }
    public void setBranchId(UUID branchId) { this.branchId = branchId; }
    public String getToolMode() { return toolMode; }
    public void setToolMode(String toolMode) { this.toolMode = toolMode; }
    public JsonNode getToolTimeouts() { return toolTimeouts; }
    public void setToolTimeouts(JsonNode toolTimeouts) {
        this.toolTimeouts = toolTimeouts == null
                ? JsonNodeFactory.instance.objectNode() : toolTimeouts.deepCopy();
    }
    public String getProvider() { return provider; }
    public void setProvider(String provider) { this.provider = provider; }
    public String getModel() { return model; }
    public void setModel(String model) { this.model = model; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public String getPauseReason() { return pauseReason; }
    public void setPauseReason(String pauseReason) { this.pauseReason = pauseReason; }
    public UUID getAnchorRunId() { return anchorRunId; }
    public void setAnchorRunId(UUID anchorRunId) { this.anchorRunId = anchorRunId; }
    public UUID getPauseRunId() { return pauseRunId; }
    public void setPauseRunId(UUID pauseRunId) { this.pauseRunId = pauseRunId; }
    public UUID getChildRunId() { return childRunId; }
    public void setChildRunId(UUID childRunId) { this.childRunId = childRunId; }
    public UUID getChildMessageId() { return childMessageId; }
    public void setChildMessageId(UUID childMessageId) { this.childMessageId = childMessageId; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public Instant getAdmittedAt() { return admittedAt; }
    public void setAdmittedAt(Instant admittedAt) { this.admittedAt = admittedAt; }
    public Instant getCompletedAt() { return completedAt; }
    public void setCompletedAt(Instant completedAt) { this.completedAt = completedAt; }
    public Instant getWithdrawnAt() { return withdrawnAt; }
    public void setWithdrawnAt(Instant withdrawnAt) { this.withdrawnAt = withdrawnAt; }
}
