package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

/**
 * PLAN-0464 T1.5 (decision #8): append-only流转记录 for one approval request.
 *
 * <p>Covers {@code requested → dispatching → decided / expired /
 * dispatch_unknown}. Rows are never updated; the sequence is allocated
 * per request inside the transaction that already locked/updated the
 * {@code approval_requests} row.</p>
 */
@Entity
@Table(name = "approval_history")
public class ApprovalHistory {

    public static final String EVENT_REQUESTED = "requested";
    public static final String EVENT_DISPATCHING = "dispatching";
    public static final String EVENT_DECIDED = "decided";
    public static final String EVENT_EXPIRED = "expired";
    public static final String EVENT_DISPATCH_UNKNOWN = "dispatch_unknown";

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "request_id", nullable = false, columnDefinition = "uuid")
    private UUID requestId;

    @Column(name = "run_id", columnDefinition = "uuid")
    private UUID runId;

    @Column(name = "session_id", columnDefinition = "uuid")
    private UUID sessionId;

    @Column(nullable = false)
    private Long sequence;

    @Column(name = "event_type", nullable = false, length = 32)
    private String eventType;

    @Column(name = "from_state", length = 24)
    private String fromState;

    @Column(name = "to_state", nullable = false, length = 24)
    private String toState;

    private Boolean approved;

    @Column(name = "decision_kind", length = 48)
    private String decisionKind;

    @Column(name = "actor_type", nullable = false, length = 16)
    private String actorType;

    /** Safe payload only (ids/flags/tool name); never raw arguments or secrets. */
    @Column(columnDefinition = "TEXT")
    private String payload;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public ApprovalHistory() {}

    @PrePersist
    protected void onCreate() {
        createdAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public UUID getRequestId() { return requestId; }
    public void setRequestId(UUID requestId) { this.requestId = requestId; }
    public UUID getRunId() { return runId; }
    public void setRunId(UUID runId) { this.runId = runId; }
    public UUID getSessionId() { return sessionId; }
    public void setSessionId(UUID sessionId) { this.sessionId = sessionId; }
    public Long getSequence() { return sequence; }
    public void setSequence(Long sequence) { this.sequence = sequence; }
    public String getEventType() { return eventType; }
    public void setEventType(String eventType) { this.eventType = eventType; }
    public String getFromState() { return fromState; }
    public void setFromState(String fromState) { this.fromState = fromState; }
    public String getToState() { return toState; }
    public void setToState(String toState) { this.toState = toState; }
    public Boolean getApproved() { return approved; }
    public void setApproved(Boolean approved) { this.approved = approved; }
    public String getDecisionKind() { return decisionKind; }
    public void setDecisionKind(String decisionKind) { this.decisionKind = decisionKind; }
    public String getActorType() { return actorType; }
    public void setActorType(String actorType) { this.actorType = actorType; }
    public String getPayload() { return payload; }
    public void setPayload(String payload) { this.payload = payload; }
    public Instant getCreatedAt() { return createdAt; }
}
