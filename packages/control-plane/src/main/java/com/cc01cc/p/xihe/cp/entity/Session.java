package com.cc01cc.p.xihe.cp.entity;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.persistence.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "sessions")
public class Session {

    public static final String KIND_SPAWN = "spawn";
    public static final String KIND_FORK = "fork";

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "workspace_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String workspaceId;

    @Column(name = "user_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String userId;

    @Column(name = "agent_principal_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String agentPrincipalId;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "agent_permissions_snapshot", columnDefinition = "jsonb")
    private JsonNode agentPermissionsSnapshot;

    @Column(length = 255)
    private String title;

    @Column(name = "model_provider", length = 50)
    private String modelProvider;

    @Column(name = "model_name", length = 100)
    private String modelName;

    @Column(name = "provider_connection_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String providerConnectionId;

    @Column(name = "connection_revision")
    private Long connectionRevision;

    @Column(name = "spawned_from_session_id", columnDefinition = "uuid")
    private UUID spawnedFromSessionId;

    @Column(name = "spawned_from_run_id", columnDefinition = "uuid")
    private UUID spawnedFromRunId;

    @Column(name = "spawned_at")
    private Instant spawnedAt;

    @Column(name = "kind", length = 16)
    private String kind;

    /**
     * PLAN-0337: session-scoped approval mode. {@code null} inherits the workspace
     * {@code approval-policy.mode}; only {@code manual} / {@code auto} may be stored (V24 CHECK).
     */
    @Column(name = "approval_mode", length = 16)
    private String approvalMode;

    @Column(nullable = false)
    private boolean archived;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public Session() {}

    public Session(String workspaceId, String userId, String title) {
        this.workspaceId = workspaceId;
        this.userId = userId;
        this.title = title;
    }

    @PrePersist
    protected void onCreate() {
        createdAt = Instant.now();
        updatedAt = Instant.now();
    }

    /**
     * PLAN-0410 spec §7: the Session root Branch must exist in the same CP
     * transaction as the Session row — one hook covers every Session creation
     * entry (create/import/upload/ledger/spawn).
     */
    @PostPersist
    protected void onCreated() {
        if (id != null) {
            RootBranchBinder.ensureRootBranchId(id.toString());
        }
    }


    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }

    public String getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(String workspaceId) { this.workspaceId = workspaceId; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public String getAgentPrincipalId() { return agentPrincipalId; }
    public void setAgentPrincipalId(String agentPrincipalId) { this.agentPrincipalId = agentPrincipalId; }

    public JsonNode getAgentPermissionsSnapshot() { return agentPermissionsSnapshot; }
    public void setAgentPermissionsSnapshot(JsonNode agentPermissionsSnapshot) {
        this.agentPermissionsSnapshot = agentPermissionsSnapshot;
    }

    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }

    public String getModelProvider() { return modelProvider; }
    public void setModelProvider(String modelProvider) { this.modelProvider = modelProvider; }

    public String getModelName() { return modelName; }
    public void setModelName(String modelName) { this.modelName = modelName; }

    public String getProviderConnectionId() { return providerConnectionId; }
    public void setProviderConnectionId(String providerConnectionId) { this.providerConnectionId = providerConnectionId; }

    public Long getConnectionRevision() { return connectionRevision; }
    public void setConnectionRevision(Long connectionRevision) { this.connectionRevision = connectionRevision; }

    public UUID getSpawnedFromSessionId() { return spawnedFromSessionId; }
    public void setSpawnedFromSessionId(UUID spawnedFromSessionId) { this.spawnedFromSessionId = spawnedFromSessionId; }

    public UUID getSpawnedFromRunId() { return spawnedFromRunId; }
    public void setSpawnedFromRunId(UUID spawnedFromRunId) { this.spawnedFromRunId = spawnedFromRunId; }

    public Instant getSpawnedAt() { return spawnedAt; }
    public void setSpawnedAt(Instant spawnedAt) { this.spawnedAt = spawnedAt; }
    public String getKind() { return kind; }
    public void setKind(String kind) { this.kind = kind; }

    public String getApprovalMode() { return approvalMode; }
    public void setApprovalMode(String approvalMode) { this.approvalMode = approvalMode; }

    public boolean isArchived() { return archived; }
    public void setArchived(boolean archived) { this.archived = archived; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
