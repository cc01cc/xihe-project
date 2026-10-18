package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

/**
 * PLAN-0528: CP-owned durable record for Run-scoped Guidance (in-run Steering).
 *
 * <p>Frozen contract: {@code spec/cp-guidance-contract.md} (PLAN-0528) and the
 * parent contract in PLAN-0468. Separate from Message, Follow-up Queue and the
 * EventStore. {@code sourceKind} is fail-closed to {@code user} at the DB level
 * (CHECK constraint); guard submission requires a new migration plus a
 * Security-track ruling.
 */
@Entity
@Table(name = "chat_run_guidance")
public class ChatRunGuidance {

    public static final String SOURCE_USER = "user";

    public static final String STATUS_PENDING = "pending";
    public static final String STATUS_CONSUMED = "consumed";
    public static final String STATUS_TERMINAL_EXPIRED = "terminal_expired";

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "session_id", nullable = false, columnDefinition = "uuid")
    private UUID sessionId;

    @Column(name = "run_id", nullable = false, columnDefinition = "uuid")
    private UUID runId;

    @Column(name = "branch_id", nullable = false, columnDefinition = "uuid")
    private UUID branchId;

    @Column(name = "source_kind", nullable = false, length = 16)
    private String sourceKind = SOURCE_USER;

    @Column(name = "author_principal_id", nullable = false, columnDefinition = "uuid")
    private UUID authorPrincipalId;

    @Column(name = "body_markdown", nullable = false, columnDefinition = "text")
    private String bodyMarkdown;

    @Column(name = "sequence", nullable = false)
    private long sequence;

    @Column(name = "status", nullable = false, length = 24)
    private String status = STATUS_PENDING;

    @Column(name = "idempotency_key", nullable = false, length = 128)
    private String idempotencyKey;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Column(name = "consumed_at")
    private Instant consumedAt;

    @Column(name = "terminal_expired_at")
    private Instant terminalExpiredAt;

    public ChatRunGuidance() {
    }

    public ChatRunGuidance(UUID id, UUID sessionId, UUID runId, UUID branchId, UUID authorPrincipalId,
                           String bodyMarkdown, long sequence, String idempotencyKey) {
        this.id = id;
        this.sessionId = sessionId;
        this.runId = runId;
        this.branchId = branchId;
        this.authorPrincipalId = authorPrincipalId;
        this.bodyMarkdown = bodyMarkdown;
        this.sequence = sequence;
        this.idempotencyKey = idempotencyKey;
    }

    /** Explicit timestamp fill so the value is readable before flush (controller response). */
    public void markCreatedNow() {
        Instant now = Instant.now();
        if (createdAt == null) {
            createdAt = now;
        }
        if (updatedAt == null) {
            updatedAt = now;
        }
    }

    @PrePersist
    void prePersist() {
        markCreatedNow();
    }

    @PreUpdate
    void preUpdate() {
        updatedAt = Instant.now();
    }

    /** Transition pending → consumed. Idempotent: re-consume keeps the first consumedAt. */
    public boolean markConsumed() {
        if (STATUS_CONSUMED.equals(status)) {
            return false;
        }
        if (!STATUS_PENDING.equals(status)) {
            throw new IllegalStateException("guidance " + id + " is not pending: " + status);
        }
        status = STATUS_CONSUMED;
        consumedAt = Instant.now();
        return true;
    }

    /** Transition pending → terminal_expired. Terminal states are final. */
    public boolean markTerminalExpired() {
        if (STATUS_TERMINAL_EXPIRED.equals(status)) {
            return false;
        }
        if (!STATUS_PENDING.equals(status)) {
            throw new IllegalStateException("guidance " + id + " is not pending: " + status);
        }
        status = STATUS_TERMINAL_EXPIRED;
        terminalExpiredAt = Instant.now();
        return true;
    }

    public UUID getId() { return id; }

    public UUID getSessionId() { return sessionId; }

    public UUID getRunId() { return runId; }

    public UUID getBranchId() { return branchId; }

    public String getSourceKind() { return sourceKind; }

    public UUID getAuthorPrincipalId() { return authorPrincipalId; }

    public String getBodyMarkdown() { return bodyMarkdown; }

    public long getSequence() { return sequence; }

    public String getStatus() { return status; }

    public String getIdempotencyKey() { return idempotencyKey; }

    public Instant getCreatedAt() { return createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }

    public Instant getConsumedAt() { return consumedAt; }

    public Instant getTerminalExpiredAt() { return terminalExpiredAt; }
}
