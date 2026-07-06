package com.cc01cc.p.xihe.cp.context.entity;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "context_events")
public class ContextEvent {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id", length = 36)
    private UUID id;

    @Column(name = "session_id", nullable = false, length = 36)
    private String sessionId;

    @Column(name = "workspace_id", nullable = false, length = 36)
    private String workspaceId;

    @Column(name = "user_id", nullable = false, length = 36)
    private String userId;

    @Column(name = "event_type", nullable = false, length = 50)
    private String eventType;

    @Column(name = "sequence", nullable = false)
    private Long sequence;

    @Column(name = "payload", columnDefinition = "JSONB", nullable = false)
    private String payload;

    @Column(name = "correlation_id", length = 36)
    private String correlationId;

    @Column(name = "causation_id", length = 36)
    private String causationId;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public ContextEvent() {}

    public ContextEvent(String sessionId, String workspaceId, String userId,
                        String eventType, Long sequence, String payload) {
        this.sessionId = sessionId;
        this.workspaceId = workspaceId;
        this.userId = userId;
        this.eventType = eventType;
        this.sequence = sequence;
        this.payload = payload;
    }

    @PrePersist
    protected void onCreate() {
        createdAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }

    public String getSessionId() { return sessionId; }
    public void setSessionId(String sessionId) { this.sessionId = sessionId; }

    public String getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(String workspaceId) { this.workspaceId = workspaceId; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public String getEventType() { return eventType; }
    public void setEventType(String eventType) { this.eventType = eventType; }

    public Long getSequence() { return sequence; }
    public void setSequence(Long sequence) { this.sequence = sequence; }

    public String getPayload() { return payload; }
    public void setPayload(String payload) { this.payload = payload; }

    public String getCorrelationId() { return correlationId; }
    public void setCorrelationId(String correlationId) { this.correlationId = correlationId; }

    public String getCausationId() { return causationId; }
    public void setCausationId(String causationId) { this.causationId = causationId; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}
