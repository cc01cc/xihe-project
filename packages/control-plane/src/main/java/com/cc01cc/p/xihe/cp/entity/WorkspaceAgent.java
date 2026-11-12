package com.cc01cc.p.xihe.cp.entity;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.persistence.Column;
import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;

@Entity
@Table(name = "workspace_agents")
public class WorkspaceAgent {

    @EmbeddedId
    private WorkspaceAgentId id;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "permissions_snapshot", nullable = false, columnDefinition = "jsonb")
    private JsonNode permissionsSnapshot;

    /**
     * D-1109 (46A + 47A): provenance of {@link #permissionsSnapshot} — {@code explicit} when the
     * caller supplied the permission array ({@code []} = explicit zero cap), {@code baseline} when
     * it omitted the field and the cap was derived from the role baseline. Kept on the row so
     * "the field was forgotten" stays auditable apart from "inherit on purpose"; V161 owns the
     * column and its CHECK constraint.
     */
    @Column(name = "cap_source", nullable = false, length = 16)
    private String capSource = CAP_SOURCE_EXPLICIT;

    /** D-1109: the caller pinned the cap with an explicit array. */
    public static final String CAP_SOURCE_EXPLICIT = "explicit";
    /** D-1109: the cap was derived from the principal's role baseline in this workspace. */
    public static final String CAP_SOURCE_BASELINE = "baseline";

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public WorkspaceAgent() {}

    /** Legacy shape: a caller-supplied array, i.e. {@code cap_source='explicit'}. */
    public WorkspaceAgent(String principalId, String workspaceId, JsonNode permissionsSnapshot) {
        this(principalId, workspaceId, permissionsSnapshot, CAP_SOURCE_EXPLICIT);
    }

    public WorkspaceAgent(String principalId, String workspaceId, JsonNode permissionsSnapshot,
                          String capSource) {
        this.id = new WorkspaceAgentId(principalId, workspaceId);
        this.permissionsSnapshot = permissionsSnapshot;
        this.capSource = capSource;
    }

    @PrePersist
    protected void onCreate() {
        if (createdAt == null) {
            createdAt = Instant.now();
        }
    }

    public WorkspaceAgentId getId() { return id; }
    public void setId(WorkspaceAgentId id) { this.id = id; }

    public JsonNode getPermissionsSnapshot() { return permissionsSnapshot; }
    public void setPermissionsSnapshot(JsonNode permissionsSnapshot) { this.permissionsSnapshot = permissionsSnapshot; }

    public String getCapSource() { return capSource; }
    public void setCapSource(String capSource) { this.capSource = capSource; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}
