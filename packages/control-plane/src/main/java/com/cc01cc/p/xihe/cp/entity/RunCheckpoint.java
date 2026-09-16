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

/**
 * PLAN-0338: CP-side projection of a Run slice checkpoint owned by the Runtime
 * (shadow git). One row per {@code (run_id, workspace_id)}; the Runtime remains
 * authoritative for the slice refs themselves.
 *
 * <p>The CP row is the durable lifecycle record the terminal-transition hooks and
 * the startup recovery sweep work on. {@code changed_files} keeps the
 * capture-time change set as JSON text ({@code [{"status":"M","path":"a.txt"}]}).
 * The slice ref is stored in the legacy {@code end_ref} column until the
 * PLAN-0339 slice-table rebuild replaces this projection.</p>
 */
@Entity
@Table(name = "run_checkpoints", uniqueConstraints = @UniqueConstraint(
        name = "uq_run_checkpoints_run_workspace",
        columnNames = {"run_id", "workspace_id"}))
public class RunCheckpoint {

    /** Slice captured at the Run terminal transition (a no-change capture has no ref). */
    public static final String STATE_CAPTURED = "captured";
    /** Slice captured at an abnormal Run terminal (status not succeeded/cancelled). */
    public static final String STATE_ABNORMAL_CAPTURED = "abnormal-captured";
    /** Capture failed; {@code unrollableReason} explains why. */
    public static final String STATE_DEGRADED = "degraded";
    /** Retention removed the refs; the row remains for audit. */
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

    @Column(name = "run_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String runId;

    @Column(name = "workspace_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String workspaceId;

    @Column(nullable = false, length = 32)
    private String state = STATE_CAPTURED;

    /**
     * Legacy interval-model column; the slice model never writes it (kept for the
     * PLAN-0339 table rebuild).
     */
    @Column(name = "base_ref", columnDefinition = "TEXT")
    private String baseRef;

    /** PLAN-0338: the slice ref ({@code refs/xihe/slices/<epochMs>-<hash>}); null on no-change. */
    @Column(name = "end_ref", columnDefinition = "TEXT")
    private String endRef;

    @Column(name = "changed_files", columnDefinition = "TEXT")
    private String changedFiles;

    /** Legacy interval-model flag; the slice model never sets it. */
    @Column(name = "sealed_with_live_jobs", nullable = false)
    private boolean sealedWithLiveJobs;

    /** PLAN-0338: true when the captured Run ended abnormally. */
    @Column(name = "sealed_after_abnormal", nullable = false)
    private boolean sealedAfterAbnormal;

    /** PLAN-0338: capture-failure reason (degraded rows only). */
    @Column(name = "unrollable_reason", length = 64)
    private String unrollableReason;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    /** PLAN-0338: capture timestamp ({@code capturedAt}). */
    @Column(name = "sealed_at")
    private Instant sealedAt;

    /** PLAN-0328 M3 W2: last revert outcome ({@link #REVERT_NONE} when never reverted). */
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
    public String getRunId() { return runId; }
    public void setRunId(String runId) { this.runId = runId; }
    public String getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(String workspaceId) { this.workspaceId = workspaceId; }
    public String getState() { return state; }
    public void setState(String state) { this.state = state; }
    public String getBaseRef() { return baseRef; }
    public void setBaseRef(String baseRef) { this.baseRef = baseRef; }
    public String getEndRef() { return endRef; }
    public void setEndRef(String endRef) { this.endRef = endRef; }
    public String getChangedFiles() { return changedFiles; }
    public void setChangedFiles(String changedFiles) { this.changedFiles = changedFiles; }
    public boolean isSealedWithLiveJobs() { return sealedWithLiveJobs; }
    public void setSealedWithLiveJobs(boolean sealedWithLiveJobs) { this.sealedWithLiveJobs = sealedWithLiveJobs; }
    public boolean isSealedAfterAbnormal() { return sealedAfterAbnormal; }
    public void setSealedAfterAbnormal(boolean sealedAfterAbnormal) { this.sealedAfterAbnormal = sealedAfterAbnormal; }
    public String getUnrollableReason() { return unrollableReason; }
    public void setUnrollableReason(String unrollableReason) { this.unrollableReason = unrollableReason; }
    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
    public Instant getSealedAt() { return sealedAt; }
    public void setSealedAt(Instant sealedAt) { this.sealedAt = sealedAt; }
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
