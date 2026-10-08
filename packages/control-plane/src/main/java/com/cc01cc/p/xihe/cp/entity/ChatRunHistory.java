package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

/**
 * PLAN-0464 T1.3 (decision #8): append-only transition history for one ChatRun.
 *
 * <p>Rows are never updated or deleted individually; the sequence is allocated
 * per run inside the writer transaction while the run row is locked. The four
 * {@code event_type} values are the four writers this plan routes through the
 * table: {@code terminal} (relay stream), {@code cancel} (cancellation settle),
 * {@code recovery} (CP restart / stale reconciliation) and {@code restore}
 * (live-approval recovery).</p>
 */
@Entity
@Table(name = "chat_run_history")
public class ChatRunHistory {

    public static final String EVENT_TERMINAL = "terminal";
    public static final String EVENT_CANCEL = "cancel";
    public static final String EVENT_RECOVERY = "recovery";
    public static final String EVENT_RESTORE = "restore";

    public static final String SOURCE_STREAM = "stream";
    public static final String SOURCE_CANCELLATION = "cancellation";
    public static final String SOURCE_RECONCILIATION = "reconciliation";
    public static final String SOURCE_RECOVERY = "recovery";

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "run_id", nullable = false, columnDefinition = "uuid")
    private UUID runId;

    @Column(name = "session_id", nullable = false, columnDefinition = "uuid")
    private UUID sessionId;

    @Column(nullable = false)
    private Long sequence;

    @Column(name = "event_type", nullable = false, length = 24)
    private String eventType;

    @Column(nullable = false, length = 24)
    private String source;

    @Column(name = "actor_type", nullable = false, length = 16)
    private String actorType;

    @Column(name = "from_status", length = 24)
    private String fromStatus;

    @Column(name = "to_status", nullable = false, length = 24)
    private String toStatus;

    @Column(name = "terminal_outcome", length = 24)
    private String terminalOutcome;

    @Column(name = "error_code", length = 64)
    private String errorCode;

    /** Safe payload only (ids/flags); never raw prompts, arguments or secrets. */
    @Column(columnDefinition = "TEXT")
    private String payload;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public ChatRunHistory() {}

    @PrePersist
    protected void onCreate() {
        createdAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public UUID getRunId() { return runId; }
    public void setRunId(UUID runId) { this.runId = runId; }
    public UUID getSessionId() { return sessionId; }
    public void setSessionId(UUID sessionId) { this.sessionId = sessionId; }
    public Long getSequence() { return sequence; }
    public void setSequence(Long sequence) { this.sequence = sequence; }
    public String getEventType() { return eventType; }
    public void setEventType(String eventType) { this.eventType = eventType; }
    public String getSource() { return source; }
    public void setSource(String source) { this.source = source; }
    public String getActorType() { return actorType; }
    public void setActorType(String actorType) { this.actorType = actorType; }
    public String getFromStatus() { return fromStatus; }
    public void setFromStatus(String fromStatus) { this.fromStatus = fromStatus; }
    public String getToStatus() { return toStatus; }
    public void setToStatus(String toStatus) { this.toStatus = toStatus; }
    public String getTerminalOutcome() { return terminalOutcome; }
    public void setTerminalOutcome(String terminalOutcome) { this.terminalOutcome = terminalOutcome; }
    public String getErrorCode() { return errorCode; }
    public void setErrorCode(String errorCode) { this.errorCode = errorCode; }
    public String getPayload() { return payload; }
    public void setPayload(String payload) { this.payload = payload; }
    public Instant getCreatedAt() { return createdAt; }
}
