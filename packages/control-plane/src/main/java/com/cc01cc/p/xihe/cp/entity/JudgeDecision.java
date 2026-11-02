package com.cc01cc.p.xihe.cp.entity;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

/**
 * PLAN-0624 M0/M1: one row of the {@code judge_decisions} audit table (G-15).
 *
 * <p>One row per judge invocation, <b>including failures</b> (Q2 is fail-closed — a refusal that
 * leaves no row is undiagnosable). For failed / timed-out / throttled rows there is no judge
 * output, so {@code verdict} carries the explicit non-speak placeholder {@code {"speak":false}};
 * the success path stores the judge's raw output untouched.</p>
 */
@Entity
@Table(name = "judge_decisions")
public class JudgeDecision {

    public static final String OUTCOME_SUCCEEDED = "succeeded";
    public static final String OUTCOME_FAILED = "failed";
    public static final String OUTCOME_TIMEOUT = "timeout";
    public static final String OUTCOME_THROTTLED = "throttled";

    @Id
    private UUID id;

    @Column(name = "session_id", nullable = false, updatable = false)
    private UUID sessionId;

    @Column(name = "run_id", updatable = false)
    private UUID runId;

    @Column(name = "participant_id", nullable = false, updatable = false)
    private UUID participantId;

    @Column(name = "trigger_source", nullable = false, updatable = false)
    private String triggerSource;

    /** Window description only (seq ranges + summary reference) — never raw messages. */
    @Column(name = "input_window", nullable = false, updatable = false)
    private String inputWindow;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "verdict", nullable = false, updatable = false, columnDefinition = "jsonb")
    private JsonNode verdict;

    @Column(name = "model_provider", nullable = false, updatable = false)
    private String modelProvider;

    @Column(name = "model_name", nullable = false, updatable = false)
    private String modelName;

    @Column(name = "latency_ms", nullable = false, updatable = false)
    private Integer latencyMs;

    @Column(name = "prompt_tokens", updatable = false)
    private Long promptTokens;

    @Column(name = "completion_tokens", updatable = false)
    private Long completionTokens;

    @Column(name = "outcome", nullable = false, updatable = false)
    private String outcome;

    /** Desanitized reason only — no raw prompt/response bodies (telemetry hygiene). */
    @Column(name = "error", updatable = false)
    private String error;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public JudgeDecision() {}

    public JudgeDecision(UUID sessionId, UUID runId, UUID participantId, String triggerSource,
                         String inputWindow, JsonNode verdict, String modelProvider,
                         String modelName, Integer latencyMs, Long promptTokens,
                         Long completionTokens, String outcome, String error) {
        this.id = UUID.randomUUID();
        this.sessionId = sessionId;
        this.runId = runId;
        this.participantId = participantId;
        this.triggerSource = triggerSource;
        this.inputWindow = inputWindow;
        this.verdict = verdict;
        this.modelProvider = modelProvider;
        this.modelName = modelName;
        this.latencyMs = latencyMs;
        this.promptTokens = promptTokens;
        this.completionTokens = completionTokens;
        this.outcome = outcome;
        this.error = error;
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

    public UUID getId() { return id; }
    public UUID getSessionId() { return sessionId; }
    public UUID getRunId() { return runId; }
    public UUID getParticipantId() { return participantId; }
    public String getTriggerSource() { return triggerSource; }
    public String getInputWindow() { return inputWindow; }
    public JsonNode getVerdict() { return verdict; }
    public String getModelProvider() { return modelProvider; }
    public String getModelName() { return modelName; }
    public Integer getLatencyMs() { return latencyMs; }
    public Long getPromptTokens() { return promptTokens; }
    public Long getCompletionTokens() { return completionTokens; }
    public String getOutcome() { return outcome; }
    public String getError() { return error; }
    public Instant getCreatedAt() { return createdAt; }
}
