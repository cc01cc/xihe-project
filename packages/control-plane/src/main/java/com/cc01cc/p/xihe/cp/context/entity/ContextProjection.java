package com.cc01cc.p.xihe.cp.context.entity;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "context_projections")
public class ContextProjection {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id", length = 36)
    private UUID id;

    @Column(name = "session_id", nullable = false, unique = true, length = 36)
    private String sessionId;

    @Column(name = "workspace_id", nullable = false, length = 36)
    private String workspaceId;

    @Column(name = "user_id", nullable = false, length = 36)
    private String userId;

    @Column(name = "projection_type", nullable = false, length = 50)
    private String projectionType = "agent_context";

    @Column(name = "latest_sequence", nullable = false)
    private Long latestSequence = 0L;

    @Column(name = "payload", columnDefinition = "JSONB", nullable = false)
    private String payload;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public ContextProjection() {}

    public ContextProjection(String sessionId, String workspaceId, String userId,
                             String payload) {
        this.sessionId = sessionId;
        this.workspaceId = workspaceId;
        this.userId = userId;
        this.payload = payload;
    }

    @PrePersist
    protected void onCreate() {
        createdAt = Instant.now();
        updatedAt = Instant.now();
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }

    public String getSessionId() { return sessionId; }
    public void setSessionId(String sessionId) { this.sessionId = sessionId; }

    public String getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(String workspaceId) { this.workspaceId = workspaceId; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public String getProjectionType() { return projectionType; }
    public void setProjectionType(String projectionType) { this.projectionType = projectionType; }

    public Long getLatestSequence() { return latestSequence; }
    public void setLatestSequence(Long latestSequence) { this.latestSequence = latestSequence; }

    public String getPayload() { return payload; }
    public void setPayload(String payload) { this.payload = payload; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
