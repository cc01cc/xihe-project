package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "session_fork_requests", uniqueConstraints = {
        @UniqueConstraint(name = "uq_session_fork_requests_source_key",
                columnNames = {"source_session_id", "idempotency_key"})
})
public class SessionForkRequest {

    public static final String COPYING = "copying";
    public static final String CLEANUP_PENDING = "cleanup_pending";
    public static final String RETRYABLE = "retryable";
    public static final String COMPLETED = "completed";

    @Id
    @Column(name = "child_session_id", nullable = false, columnDefinition = "uuid")
    private UUID childSessionId;

    @Column(name = "source_session_id", nullable = false, columnDefinition = "uuid")
    private UUID sourceSessionId;

    @Column(name = "idempotency_key", nullable = false, length = 128)
    private String idempotencyKey;

    @Column(name = "request_hash", nullable = false, length = 64)
    private String requestHash;

    @Column(name = "state", nullable = false, length = 24)
    private String state;

    @Column(name = "cleanup_ref", nullable = false, columnDefinition = "text")
    private String cleanupRef;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Column(name = "last_error_code", length = 128)
    private String lastErrorCode;

    protected SessionForkRequest() {}

    public SessionForkRequest(UUID childSessionId, UUID sourceSessionId,
                              String idempotencyKey, String requestHash, String cleanupRef) {
        this.childSessionId = childSessionId;
        this.sourceSessionId = sourceSessionId;
        this.idempotencyKey = idempotencyKey;
        this.requestHash = requestHash;
        this.cleanupRef = cleanupRef;
        this.state = COPYING;
    }

    @PrePersist
    protected void onCreate() {
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

    public UUID getChildSessionId() { return childSessionId; }
    public UUID getSourceSessionId() { return sourceSessionId; }
    public String getIdempotencyKey() { return idempotencyKey; }
    public String getRequestHash() { return requestHash; }
    public String getState() { return state; }
    public String getCleanupRef() { return cleanupRef; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public String getLastErrorCode() { return lastErrorCode; }

    public void setState(String state) { this.state = state; }
    public void setLastErrorCode(String lastErrorCode) { this.lastErrorCode = lastErrorCode; }
}
