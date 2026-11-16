package com.cc01cc.p.xihe.cp.scheduled;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

/**
 * PLAN-0489 T1.2（contract: PLAN-0486 spec/scheduled-task.md v3.4 §1）：
 * user/agent 可见的定时触发器（delay_once + cron）。
 *
 * <p>{@code firing} 是 CAS 认领占位（0486 B3）：同一任务同一时刻至多一行在途；
 * {@code missed_count} 承载 E1 停摆语义（连续 missed 轮次，用户处置清零）；
 * {@code timezone} 为创建时快照，不可编辑（D3-A）；{@code agentPrincipalId}
 * 为创建者归属（V60，非空 = agent 创建，FK ON DELETE SET NULL）。</p>
 */
@Entity
@Table(name = "scheduled_tasks")
public class ScheduledTask {

    public static final String TRIGGER_DELAY_ONCE = "delay_once";
    public static final String TRIGGER_CRON = "cron";
    public static final String TARGET_SESSION_WAKEUP = "session_wakeup";
    public static final String TARGET_JOB_DISPATCH = "job_dispatch";
    public static final String STATUS_SCHEDULED = "scheduled";
    public static final String STATUS_FIRING = "firing";
    public static final String STATUS_MISSED = "missed";
    public static final String STATUS_EXPIRED = "expired";
    public static final String STATUS_CANCELLED = "cancelled";
    public static final String STATUS_COMPLETED = "completed";
    public static final String REASON_TARGET_GONE = "target_gone";
    public static final String REASON_DISPATCH_FAILED = "dispatch_failed";
    public static final String REASON_OVERDUE_GRACE = "overdue_grace";
    // PLAN-0624 M2 (D24-05..11): the wake-schedule projection vocabulary.
    public static final String TRIGGER_INTERVAL = "interval";
    public static final String TARGET_PARTICIPANT_WAKE = "participant_wake";
    public static final String ORIGIN_USER = "user";
    public static final String ORIGIN_SYSTEM = "system";

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "workspace_id", nullable = false, columnDefinition = "uuid")
    private UUID workspaceId;

    @Column(name = "user_id", nullable = false, columnDefinition = "uuid")
    private UUID userId;

    @Column(name = "agent_principal_id", columnDefinition = "uuid")
    private UUID agentPrincipalId;

    @Column(name = "trigger_kind", nullable = false, length = 16)
    private String triggerKind;

    @Column(name = "origin", nullable = false, length = 16)
    private String origin = ORIGIN_USER;

    @Column(name = "cron_expr", length = 120)
    private String cronExpr;

    @Column(name = "interval_seconds")
    private Integer intervalSeconds;

    @Column(nullable = false, length = 64)
    private String timezone;

    @Column(name = "target_kind", nullable = false, length = 24)
    private String targetKind;

    @Column(name = "target_session_id", columnDefinition = "uuid")
    private UUID targetSessionId;

    @Column(columnDefinition = "TEXT")
    private String prompt;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "payload", columnDefinition = "jsonb")
    private JsonNode payload;

    @Column(nullable = false, length = 16)
    private String status = STATUS_SCHEDULED;

    /**
     * D-1706 ③ / stage-two prerequisite: nullable. A time-triggered row always carries a fire
     * instant; an <b>event-triggered</b> row has none (the event decides when it fires), and a
     * {@code NULL} here is the honest representation rather than a placeholder instant that would
     * look schedulable. Two consequences are load-bearing, and both are pinned by tests rather than
     * left to convention:
     *
     * <ul>
     *   <li>Every scan predicate compares with {@code <} / {@code =} ({@code
     *       ScheduledTaskRepository}), and SQL three-valued logic makes both UNKNOWN for a NULL
     *       operand ⇒ null rows are never discovered, never claimed and never marked overdue. That
     *       is "quietly never fires" for the claim path ({@code
     *       ScheduledTaskRepository#claimToFiring}), not an error — so
     *       {@code ScheduledTaskNullabilityTest} asserts the claim returns 0 rows instead of letting
     *       stage two discover it.</li>
     *   <li>Quota counting is status-based ({@code countByWorkspaceIdAnd…StatusIn}), so null rows
     *       still occupy an active slot — asserted by the same test class so a future rewrite to a
     *       fire-time-based count cannot silently hand out extra rows.</li>
     * </ul>
     */
    @Column(name = "next_fire_at")
    private Instant nextFireAt;

    @Column(name = "expires_at")
    private Instant expiresAt;

    @Column(name = "missed_count", nullable = false)
    private int missedCount;

    @Column(name = "last_missed_at")
    private Instant lastMissedAt;

    @Column(name = "missed_reason", length = 64)
    private String missedReason;

    @Column(name = "last_run_id", columnDefinition = "uuid")
    private UUID lastRunId;

    @Column(name = "cancel_reason", length = 64)
    private String cancelReason;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected ScheduledTask() {}

    @PrePersist
    protected void onCreate() {
        if (id == null) {
            id = UUID.randomUUID();
        }
        Instant now = Instant.now();
        if (createdAt == null) {
            createdAt = now;
        }
        updatedAt = now;
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now();
    }

    public Integer getIntervalSeconds() { return intervalSeconds; }
    public void setIntervalSeconds(Integer intervalSeconds) { this.intervalSeconds = intervalSeconds; }
    public String getOrigin() { return origin; }
    public void setOrigin(String origin) { this.origin = origin; }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public UUID getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(UUID workspaceId) { this.workspaceId = workspaceId; }
    public UUID getUserId() { return userId; }
    public void setUserId(UUID userId) { this.userId = userId; }
    public UUID getAgentPrincipalId() { return agentPrincipalId; }
    public void setAgentPrincipalId(UUID agentPrincipalId) { this.agentPrincipalId = agentPrincipalId; }
    public String getTriggerKind() { return triggerKind; }
    public void setTriggerKind(String triggerKind) { this.triggerKind = triggerKind; }
    public String getCronExpr() { return cronExpr; }
    public void setCronExpr(String cronExpr) { this.cronExpr = cronExpr; }
    public String getTimezone() { return timezone; }
    public void setTimezone(String timezone) { this.timezone = timezone; }
    public String getTargetKind() { return targetKind; }
    public void setTargetKind(String targetKind) { this.targetKind = targetKind; }
    public UUID getTargetSessionId() { return targetSessionId; }
    public void setTargetSessionId(UUID targetSessionId) { this.targetSessionId = targetSessionId; }
    public String getPrompt() { return prompt; }
    public void setPrompt(String prompt) { this.prompt = prompt; }
    public JsonNode getPayload() { return payload; }
    public void setPayload(JsonNode payload) { this.payload = payload; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public Instant getNextFireAt() { return nextFireAt; }
    public void setNextFireAt(Instant nextFireAt) { this.nextFireAt = nextFireAt; }
    public Instant getExpiresAt() { return expiresAt; }
    public void setExpiresAt(Instant expiresAt) { this.expiresAt = expiresAt; }
    public int getMissedCount() { return missedCount; }
    public void setMissedCount(int missedCount) { this.missedCount = missedCount; }
    public Instant getLastMissedAt() { return lastMissedAt; }
    public void setLastMissedAt(Instant lastMissedAt) { this.lastMissedAt = lastMissedAt; }
    public String getMissedReason() { return missedReason; }
    public void setMissedReason(String missedReason) { this.missedReason = missedReason; }
    public UUID getLastRunId() { return lastRunId; }
    public void setLastRunId(UUID lastRunId) { this.lastRunId = lastRunId; }
    public String getCancelReason() { return cancelReason; }
    public void setCancelReason(String cancelReason) { this.cancelReason = cancelReason; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
