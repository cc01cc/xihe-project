package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;

import java.time.Instant;
import java.util.UUID;

/**
 * PLAN-0410: one row per branch path segment inside a Session. Every Session
 * has exactly one root row ({@code parent_branch_id IS NULL}); child rows
 * carry a complete anchor (message/run/sequence) plus request idempotency per
 * field-matrix §1. Root/child partial uniques and CHECKs live in the V43
 * Flyway migration (PostgreSQL is the schema gate; H2 legacy tests only get
 * the JPA mapping).
 */
@Entity
@Table(name = "session_branches", uniqueConstraints = @UniqueConstraint(
        name = "uq_session_branches_session_id_id", columnNames = {"session_id", "id"}))
public class SessionBranch {

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "session_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String sessionId;

    @Column(name = "parent_branch_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String parentBranchId;

    @Column(name = "fork_point_message_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String forkPointMessageId;

    @Column(name = "fork_point_run_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String forkPointRunId;

    @Column(name = "fork_point_sequence")
    private Long forkPointSequence;

    @Column(name = "idempotency_key", length = 128)
    private String idempotencyKey;

    @Column(name = "request_hash", length = 64)
    private String requestHash;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public SessionBranch() {
    }

    public SessionBranch(UUID id, String sessionId) {
        this.id = id;
        this.sessionId = sessionId;
    }

    @PrePersist
    protected void onCreate() {
        createdAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }

    public String getSessionId() { return sessionId; }
    public void setSessionId(String sessionId) { this.sessionId = sessionId; }

    public String getParentBranchId() { return parentBranchId; }
    public void setParentBranchId(String parentBranchId) { this.parentBranchId = parentBranchId; }

    public String getForkPointMessageId() { return forkPointMessageId; }
    public void setForkPointMessageId(String forkPointMessageId) { this.forkPointMessageId = forkPointMessageId; }

    public String getForkPointRunId() { return forkPointRunId; }
    public void setForkPointRunId(String forkPointRunId) { this.forkPointRunId = forkPointRunId; }

    public Long getForkPointSequence() { return forkPointSequence; }
    public void setForkPointSequence(Long forkPointSequence) { this.forkPointSequence = forkPointSequence; }

    public String getIdempotencyKey() { return idempotencyKey; }
    public void setIdempotencyKey(String idempotencyKey) { this.idempotencyKey = idempotencyKey; }

    public String getRequestHash() { return requestHash; }
    public void setRequestHash(String requestHash) { this.requestHash = requestHash; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}
