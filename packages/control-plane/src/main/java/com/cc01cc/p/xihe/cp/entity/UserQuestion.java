package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

/**
 * PLAN-0660 M5-B / T5.8 (V128): one durable "the agent is waiting for an answer" row.
 *
 * <p>Frozen shape: PLAN-0648 design.md §6 (merged into PLAN-0660 by D66-12) and the checklist
 * rebuilt in {@code spec/session/user-channel.md} §6. The table is the only durable fact about a
 * question; the Agent owns the wait deadline and CP owns the state.</p>
 *
 * <p>State machine (implemented in T5.9, not here): {@code pending -> answered} (only the
 * addressee, CAS) / {@code pending -> expired} (deadline or terminal run) / {@code pending ->
 * cancelled} (run cancelled, session deleted). Terminal states never roll back.</p>
 *
 * <p>Minimisation (hard rule, spec §5.2): {@link #getPrompt()} and {@link #getAnswer()} are
 * untrusted text. They must never be written to logs, audit rows, problem detail or an SSE payload —
 * only the question id and the length may leave CP. The columns are also deliberately unindexed so
 * the body can never become a searchable surface.</p>
 *
 * <p>Deliberately absent: {@code workspace_id} (a session may have none since PLAN-0647; the
 * workspace is one join away) and any stored {@code pendingCount} (the projection count and the
 * unread badge are derived values, never a second source of truth).</p>
 */
@Entity
@Table(name = "user_questions")
public class UserQuestion {

    public static final String STATE_PENDING = "pending";
    public static final String STATE_ANSWERED = "answered";
    public static final String STATE_EXPIRED = "expired";
    public static final String STATE_CANCELLED = "cancelled";

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "session_id", nullable = false, updatable = false)
    private UUID sessionId;

    @Column(name = "run_id", nullable = false, updatable = false)
    private UUID runId;

    /** The agent participant that asked on the run's behalf; null when the caller has none. */
    @Column(name = "asked_by_participant_id", updatable = false)
    private UUID askedByParticipantId;

    /** The only principal allowed to answer (and the only one that may be pushed a hint). */
    @Column(name = "addressee_user_id", nullable = false, updatable = false)
    private UUID addresseeUserId;

    /** Question body: untrusted, never logged, never indexed, never sent over SSE. */
    @Column(name = "prompt", nullable = false, columnDefinition = "TEXT")
    private String prompt;

    @Column(name = "state", nullable = false, columnDefinition = "TEXT")
    private String state;

    /** Null for {@code ask} (blocking wait); the {@code askTimed} deadline otherwise. */
    @Column(name = "expires_at")
    private Instant expiresAt;

    /** Answer body: untrusted, set by the {@code pending -> answered} transition only. */
    @Column(name = "answer", columnDefinition = "TEXT")
    private String answer;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    /** When the hint was handed to the user channel; null = never delivered yet. */
    @Column(name = "first_delivered_at")
    private Instant firstDeliveredAt;

    /** When the row reached a terminal state; null = still pending. */
    @Column(name = "settled_at")
    private Instant settledAt;

    public UserQuestion() {}

    /** Creates a {@code pending} row; the id and timestamps are stamped on persist. */
    public UserQuestion(UUID sessionId, UUID runId, UUID askedByParticipantId, UUID addresseeUserId,
                        String prompt, Instant expiresAt) {
        this.sessionId = sessionId;
        this.runId = runId;
        this.askedByParticipantId = askedByParticipantId;
        this.addresseeUserId = addresseeUserId;
        this.prompt = prompt;
        this.state = STATE_PENDING;
        this.expiresAt = expiresAt;
    }

    @PrePersist
    protected void onCreate() {
        if (id == null) {
            id = UUID.randomUUID();
        }
        if (createdAt == null) {
            createdAt = Instant.now();
        }
    }

    public boolean isPending() {
        return STATE_PENDING.equals(state);
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }

    public UUID getSessionId() { return sessionId; }
    public void setSessionId(UUID sessionId) { this.sessionId = sessionId; }

    public UUID getRunId() { return runId; }
    public void setRunId(UUID runId) { this.runId = runId; }

    public UUID getAskedByParticipantId() { return askedByParticipantId; }
    public void setAskedByParticipantId(UUID askedByParticipantId) {
        this.askedByParticipantId = askedByParticipantId;
    }

    public UUID getAddresseeUserId() { return addresseeUserId; }
    public void setAddresseeUserId(UUID addresseeUserId) { this.addresseeUserId = addresseeUserId; }

    public String getPrompt() { return prompt; }
    public void setPrompt(String prompt) { this.prompt = prompt; }

    public String getState() { return state; }
    public void setState(String state) { this.state = state; }

    public Instant getExpiresAt() { return expiresAt; }
    public void setExpiresAt(Instant expiresAt) { this.expiresAt = expiresAt; }

    public String getAnswer() { return answer; }
    public void setAnswer(String answer) { this.answer = answer; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getFirstDeliveredAt() { return firstDeliveredAt; }
    public void setFirstDeliveredAt(Instant firstDeliveredAt) {
        this.firstDeliveredAt = firstDeliveredAt;
    }

    public Instant getSettledAt() { return settledAt; }
    public void setSettledAt(Instant settledAt) { this.settledAt = settledAt; }
}
