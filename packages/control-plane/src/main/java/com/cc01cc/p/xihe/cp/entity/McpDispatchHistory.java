package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

/**
 * Append-only transition history for the MCP execution domain (PLAN-0463 V49,
 * PLAN-0462 decision #8). Rows are never updated during an invocation's
 * lifetime; Session hard-delete removes its owned history. The sequence is
 * allocated per invocation inside the write transaction.
 */
@Entity
@Table(name = "mcp_dispatch_history")
public class McpDispatchHistory {

    public static final String EVENT_INVOCATION_OPENED = "invocation.opened";
    public static final String EVENT_ATTEMPT_STARTED = "attempt.started";
    public static final String EVENT_ATTEMPT_SUCCEEDED = "attempt.succeeded";
    public static final String EVENT_ATTEMPT_FAILED = "attempt.failed";
    public static final String EVENT_ATTEMPT_UNKNOWN = "attempt.unknown";
    public static final String EVENT_ATTEMPT_TIMED_OUT = "attempt.timed_out";
    public static final String EVENT_ATTEMPT_CANCELLED = "attempt.cancelled";
    public static final String EVENT_ATTEMPT_LATE_CONFIRMED = "attempt.late_confirmed";
    public static final String EVENT_INVOCATION_SETTLED = "invocation.settled";

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "invocation_id", nullable = false, columnDefinition = "uuid")
    private UUID invocationId;

    @Column(name = "attempt_id", columnDefinition = "uuid")
    private UUID attemptId;

    @Column(nullable = false)
    private Long sequence;

    @Column(name = "event_type", nullable = false, length = 48)
    private String eventType;

    @Column(name = "from_status", length = 24)
    private String fromStatus;

    @Column(name = "to_status", length = 24)
    private String toStatus;

    @Column(name = "actor_type", nullable = false, length = 16)
    private String actorType;

    /** Safe payload only (ids/flags); never raw arguments, prompts or secrets. */
    @Column(columnDefinition = "TEXT")
    private String payload;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public McpDispatchHistory() {}

    @PrePersist
    protected void onCreate() {
        createdAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public UUID getInvocationId() { return invocationId; }
    public void setInvocationId(UUID invocationId) { this.invocationId = invocationId; }
    public UUID getAttemptId() { return attemptId; }
    public void setAttemptId(UUID attemptId) { this.attemptId = attemptId; }
    public Long getSequence() { return sequence; }
    public void setSequence(Long sequence) { this.sequence = sequence; }
    public String getEventType() { return eventType; }
    public void setEventType(String eventType) { this.eventType = eventType; }
    public String getFromStatus() { return fromStatus; }
    public void setFromStatus(String fromStatus) { this.fromStatus = fromStatus; }
    public String getToStatus() { return toStatus; }
    public void setToStatus(String toStatus) { this.toStatus = toStatus; }
    public String getActorType() { return actorType; }
    public void setActorType(String actorType) { this.actorType = actorType; }
    public String getPayload() { return payload; }
    public void setPayload(String payload) { this.payload = payload; }
    public Instant getCreatedAt() { return createdAt; }
}
