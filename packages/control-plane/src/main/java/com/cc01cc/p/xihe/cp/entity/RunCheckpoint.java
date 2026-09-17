package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;

import java.time.Instant;
import java.util.UUID;

/** CP projection of one Runtime-owned workspace checkpoint slice. */
@Entity
@Table(name = "run_checkpoints", uniqueConstraints = {
        @UniqueConstraint(name = "uq_run_checkpoints_workspace_slice",
                columnNames = {"workspace_id", "slice_ref"}),
        @UniqueConstraint(name = "uq_run_checkpoints_workspace_source_run",
                columnNames = {"workspace_id", "source_run_id"})
})
public class RunCheckpoint {

    /** Slice captured at a Run terminal transition. */
    public static final String STATE_CAPTURED = "captured";
    /** Slice captured at an abnormal Run terminal (status not succeeded/cancelled). */
    public static final String STATE_ABNORMAL_CAPTURED = "abnormal-captured";
    /** Capture failed; {@code unrollableReason} explains why. */
    public static final String STATE_DEGRADED = "degraded";
    /** Retention removed the slice; the row remains for audit. */
    public static final String STATE_EXPIRED = "expired";

    /** PLAN-0328 M3 (V23): no revert attempted yet. */
    public static final String REVERT_NONE = "none";
    /** Every listed item restored/deleted; no conflict and no failure. */
    public static final String REVERT_ROLLED_BACK = "rolled_back";
    /** Revert executed but conflicts were skipped and/or items failed. */
    public static final String REVERT_PARTIAL = "partial";
    /** Reserved: a revert attempt that restored nothing (currently unwritten). */
    public static final String REVERT_FAILED = "failed";

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "source_run_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String sourceRunId;

    @Column(name = "workspace_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String workspaceId;

    @Column(name = "source_session_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String sourceSessionId;

    @Column(name = "slice_ref", columnDefinition = "TEXT")
    private String sliceRef;

    @Column(name = "captured_at")
    private Instant capturedAt;

    @Column(name = "predecessor_ref", columnDefinition = "TEXT")
    private String predecessorRef;

    @Column(nullable = false, length = 32)
    private String state = STATE_CAPTURED;

    /** JSON text: changed paths relative to the predecessor slice. */
    @Column(name = "changed_files", nullable = false, columnDefinition = "TEXT")
    private String changedFiles = "[]";

    /** JSON text: nested repositories represented as opaque gitlinks. */
    @Column(name = "opaque_nested_repos", nullable = false, columnDefinition = "TEXT")
    private String opaqueNestedRepos = "[]";

    /** PLAN-0338: capture-failure reason (degraded rows only). */
    @Column(name = "unrollable_reason", length = 64)
    private String unrollableReason;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    /** Last revert outcome ({@link #REVERT_NONE} when never reverted). */
    @Column(name = "revert_state", nullable = false, length = 16)
    private String revertState = REVERT_NONE;

    /** Runtime audit ref written by the last revert; null when the write failed. */
    @Column(name = "revert_ref", columnDefinition = "TEXT")
    private String revertRef;

    /** JSON text: ledger summary of the last revert ({marker, counts, conflicts, ...}). */
    @Column(name = "revert_summary", columnDefinition = "TEXT")
    private String revertSummary;

    @Column(name = "reverted_at")
    private Instant revertedAt;

    @Column(name = "revert_attempt_count", nullable = false)
    private int revertAttemptCount;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public RunCheckpoint() {}

    @PrePersist
    protected void onCreate() {
        Instant now = Instant.now();
        if (createdAt == null) {
            createdAt = now;
        }
        if (updatedAt == null) {
            updatedAt = now;
        }
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public String getSourceRunId() { return sourceRunId; }
    public void setSourceRunId(String sourceRunId) { this.sourceRunId = sourceRunId; }
    public String getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(String workspaceId) { this.workspaceId = workspaceId; }
    public String getSourceSessionId() { return sourceSessionId; }
    public void setSourceSessionId(String sourceSessionId) { this.sourceSessionId = sourceSessionId; }
    public String getSliceRef() { return sliceRef; }
    public void setSliceRef(String sliceRef) { this.sliceRef = sliceRef; }
    public Instant getCapturedAt() { return capturedAt; }
    public void setCapturedAt(Instant capturedAt) { this.capturedAt = capturedAt; }
    public String getPredecessorRef() { return predecessorRef; }
    public void setPredecessorRef(String predecessorRef) { this.predecessorRef = predecessorRef; }
    public String getState() { return state; }
    public void setState(String state) { this.state = state; }
    public String getChangedFiles() { return changedFiles; }
    public void setChangedFiles(String changedFiles) { this.changedFiles = changedFiles; }
    public String getOpaqueNestedRepos() { return opaqueNestedRepos; }
    public void setOpaqueNestedRepos(String opaqueNestedRepos) { this.opaqueNestedRepos = opaqueNestedRepos; }
    public String getUnrollableReason() { return unrollableReason; }
    public void setUnrollableReason(String unrollableReason) { this.unrollableReason = unrollableReason; }
    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
    public String getRevertState() { return revertState; }
    public void setRevertState(String revertState) { this.revertState = revertState; }
    public String getRevertRef() { return revertRef; }
    public void setRevertRef(String revertRef) { this.revertRef = revertRef; }
    public String getRevertSummary() { return revertSummary; }
    public void setRevertSummary(String revertSummary) { this.revertSummary = revertSummary; }
    public Instant getRevertedAt() { return revertedAt; }
    public void setRevertedAt(Instant revertedAt) { this.revertedAt = revertedAt; }
    public int getRevertAttemptCount() { return revertAttemptCount; }
    public void setRevertAttemptCount(int revertAttemptCount) { this.revertAttemptCount = revertAttemptCount; }
    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
