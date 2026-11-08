package com.cc01cc.p.xihe.cp.entity;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "chat_runs", uniqueConstraints = @UniqueConstraint(
        name = "uk_chat_runs_user_session_idempotency",
        columnNames = {"user_id", "session_id", "idempotency_key"}))
public class ChatRun {

    public static final String ORIGIN_USER_SUBMISSION = "user_submission";
    public static final String ORIGIN_SPAWN = "spawn";
    /** PLAN-0489 决策 #7: idle-session scheduled wakeup carrier (V59). */
    public static final String ORIGIN_SCHEDULED = "scheduled";

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    /** R1 (PLAN-0623): the responder of this run — the participant who answered (V92 column). */
    @Column(name = "agent_principal_id", columnDefinition = "uuid")
    private UUID agentPrincipalId;

    /** PLAN-0624 V93 G-24: who triggered this run; DB default 'user' for legacy rows. */
    @jakarta.persistence.Column(name = "trigger_source", nullable = false)
    private String triggerSource = "user";
    @Column(name = "session_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String sessionId;

    /** PLAN-0410 T1.3: durable branch binding (V43 NOT NULL, immutable). */
    @Column(name = "branch_id", nullable = false, length = 36, updatable = false)
    @Convert(converter = UuidStringConverter.class)
    private String branchId;


    @Column(name = "user_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String userId;

    @Column(name = "workspace_id", nullable = true, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String workspaceId;

    @Column(name = "idempotency_key", nullable = false, length = 128)
    private String idempotencyKey;

    @Column(name = "request_hash", nullable = false, length = 64)
    private String requestHash;

    @Column(name = "origin", nullable = false, length = 24)
    private String origin = ORIGIN_USER_SUBMISSION;

    @Column(length = 50)
    private String provider;

    @Column(length = 100)
    private String model;

    @Column(name = "provider_connection_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String providerConnectionId;

    @Column(name = "connection_revision")
    private Long connectionRevision;

    @Column(name = "tool_mode", nullable = false, length = 20)
    private String toolMode = "none";

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "context_template_snapshot", nullable = false, columnDefinition = "jsonb")
    private JsonNode contextTemplateSnapshot = JsonNodeFactory.instance.objectNode();

    /**
     * PLAN-0628 M2a (D28-35): the skills listing frozen when this run was admitted.
     *
     * <p>An empty object means <b>not captured</b> (a run created before M2a, D28-40), not "no
     * skills" — the latter is {@code {"status":"empty"}}. Dispatch renders from this column only
     * (D28-39), so mutating bindings later cannot change what this run's model sees.</p>
     */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "skills_snapshot", nullable = false, columnDefinition = "jsonb")
    private JsonNode skillsSnapshot = JsonNodeFactory.instance.objectNode();

    /**
     * PLAN-0691 T1.6b (V143, design S4 / D-62): the session plugin catalog frozen when this run was
     * admitted.
     *
     * <p>Same shape discipline as {@link #skillsSnapshot}: an empty object means <b>not captured</b>
     * (plugin feature off, or a run created before T1.6b), never "this run has no plugins" — the
     * latter is {@code {"catalogVersion":0,"items":[]}}. Attach/detach takes effect next turn
     * (D-62), so the set this run was admitted with is the set its tool face keeps; the T2.1
     * {@code /api/v1/mcp} {@code tools/list} filter reads this column rather than the live
     * attachment rows, which is why capture and the Run insert share one admission transaction.</p>
     *
     * <p>Written once at admission; a continuation child inherits the parent document verbatim
     * (same "a binding added while the parent ran must not appear here" rule as D28-39 ②).</p>
     */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "plugin_snapshot", nullable = false, columnDefinition = "jsonb")
    private JsonNode pluginSnapshot = JsonNodeFactory.instance.objectNode();

    /**
     * PLAN-0666 M1b (BL-269): layered context fingerprint of the FIRST dispatch.
     *
     * <p>Nullable on purpose: rows written before the plan and runs that never dispatched have no
     * document, and the read API names that absence explicitly (`pre_plan` / `not_dispatched`)
     * instead of faking a state (two-level model, spec §可观测性). Write-once is enforced in SQL
     * (`context_fingerprint IS NULL` guard), so a context-overflow re-dispatch cannot replace it.</p>
     */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "context_fingerprint", columnDefinition = "jsonb")
    private JsonNode contextFingerprint;

    /**
     * PLAN-0670 M2c / BL-293: the Agent's inbound truncation marker for this run, in the same wire
     * shape as the terminal {@code done.agentContextTruncation} object ({@code Truncation.to_wire()}:
     * dropped/kept messages+bytes, limits, strategy).
     *
     * <p>Nullable on purpose: {@code NULL} means "this run did not truncate" (never an empty object or
     * all-zero stats). Written once at the terminal transition from the SAME parsed done payload that
     * is relayed to the UI — the audit value must equal the SSE value, not a re-derivation.
     */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "context_truncation", columnDefinition = "jsonb")
    private JsonNode contextTruncation;

    @Column(name = "user_message_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String userMessageId;

    @Column(name = "assistant_message_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String assistantMessageId;

    @Column(nullable = false, length = 24)
    private String status;

    @Column(name = "terminal_at")
    private Instant terminalAt;

    @Column(name = "terminal_outcome", length = 24)
    private String terminalOutcome;

    @Column(name = "error_code", length = 64)
    private String errorCode;

    @Column(name = "error_detail", columnDefinition = "TEXT")
    private String errorDetail;

    @Column(name = "token_count", nullable = false)
    private int tokenCount;

    @Column(name = "assistant_chars", nullable = false)
    private int assistantChars;

    @Column(name = "lease_owner", length = 80)
    private String leaseOwner;

    @Column(name = "lease_expires_at")
    private Instant leaseExpiresAt;

    /**
     * PLAN-0464 T2.1 (V52): the spawn waiting link lives on the child run row —
     * which parent run it waits for and which parent tool call the wait belongs
     * to. Nullable: pre-V52 rows are never backfilled (design 风险画像).
     */
    @Column(name = "waiting_on_run_id", columnDefinition = "uuid")
    @Convert(converter = UuidStringConverter.class)
    private String waitingOnRunId;

    @Column(name = "waiting_tool_call_id", columnDefinition = "uuid")
    @Convert(converter = UuidStringConverter.class)
    private String waitingToolCallId;

    /**
     * PLAN-0630 M2 (V105): the durable wake edge — which run's output woke this run.
     * Written only for {@code trigger_source ∈ {chain, judge}} wake runs (same transaction as the
     * run row); NULL = root. Spawn rows never write it — their parent already lives on
     * {@link #waitingOnRunId} (D30-01: one fact, one column), and user/schedule wakes are roots.
     */
    @Column(name = "parent_run_id", columnDefinition = "uuid")
    @Convert(converter = UuidStringConverter.class)
    private String parentRunId;

    /** PLAN-0510: controlled continuation provenance; null on ordinary Runs. */
    @Column(name = "continuation_source_run_id", columnDefinition = "uuid")
    @Convert(converter = UuidStringConverter.class)
    private String continuationSourceRunId;

    @Column(name = "continuation_lineage_id", columnDefinition = "uuid")
    @Convert(converter = UuidStringConverter.class)
    private String continuationLineageId;

    @Column(name = "continuation_thread_id", columnDefinition = "uuid")
    @Convert(converter = UuidStringConverter.class)
    private String continuationThreadId;

    @Column(name = "continuation_checkpoint_id", length = 128)
    private String continuationCheckpointId;

    @Column(name = "continuation_event_sequence")
    private Long continuationEventSequence;

    @Column(name = "continuation_mode", length = 32)
    private String continuationMode;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public ChatRun() {}

    public ChatRun(String id, String sessionId, String userId, String workspaceId,
                   String idempotencyKey, String requestHash, String provider,
                   String model, String toolMode, String status) {
        this.id = UUID.fromString(id);
        this.sessionId = sessionId;
        this.userId = userId;
        this.workspaceId = workspaceId;
        this.idempotencyKey = idempotencyKey;
        this.requestHash = requestHash;
        this.provider = provider;
        this.model = model;
        this.toolMode = toolMode == null || toolMode.isBlank() ? "none" : toolMode;
        this.status = status;
    }

    public UUID getAgentPrincipalId() { return agentPrincipalId; }
    public void setAgentPrincipalId(UUID agentPrincipalId) { this.agentPrincipalId = agentPrincipalId; }
    public String getTriggerSource() { return triggerSource; }
    public void setTriggerSource(String triggerSource) { this.triggerSource = triggerSource; }
    @PrePersist
    protected void onCreate() {
        ensureContextTemplateSnapshot();
        ensureSkillsSnapshot();
        ensurePluginSnapshot();
        Instant now = Instant.now();
        createdAt = now;
        updatedAt = now;
        if (branchId == null || branchId.isBlank()) {
            branchId = RootBranchBinder.ensureRootBranchId(sessionId);
        }
    }

    @PreUpdate
    protected void onUpdate() {
        // Defensive: detached-merge re-saves must never null the snapshot
        // (column is NOT NULL DEFAULT '{}'; merge copies detached nulls).
        ensureContextTemplateSnapshot();
        ensureSkillsSnapshot();
        ensurePluginSnapshot();
        updatedAt = Instant.now();
    }

    private void ensureContextTemplateSnapshot() {
        if (contextTemplateSnapshot == null) {
            contextTemplateSnapshot = JsonNodeFactory.instance.objectNode();
        }
    }

    private void ensureSkillsSnapshot() {
        if (skillsSnapshot == null) {
            skillsSnapshot = JsonNodeFactory.instance.objectNode();
        }
    }

    private void ensurePluginSnapshot() {
        if (pluginSnapshot == null) {
            pluginSnapshot = JsonNodeFactory.instance.objectNode();
        }
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public String getSessionId() { return sessionId; }
    public void setSessionId(String sessionId) { this.sessionId = sessionId; }
    public String getBranchId() { return branchId; }
    public void setBranchId(String branchId) { this.branchId = branchId; }
    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }
    public String getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(String workspaceId) { this.workspaceId = workspaceId; }
    public String getIdempotencyKey() { return idempotencyKey; }
    public void setIdempotencyKey(String idempotencyKey) { this.idempotencyKey = idempotencyKey; }
    public String getRequestHash() { return requestHash; }
    public void setRequestHash(String requestHash) { this.requestHash = requestHash; }
    public String getOrigin() { return origin; }
    public void setOrigin(String origin) { this.origin = origin; }
    public String getProvider() { return provider; }
    public void setProvider(String provider) { this.provider = provider; }
    public String getModel() { return model; }
    public void setModel(String model) { this.model = model; }
    public String getProviderConnectionId() { return providerConnectionId; }
    public void setProviderConnectionId(String providerConnectionId) { this.providerConnectionId = providerConnectionId; }
    public Long getConnectionRevision() { return connectionRevision; }
    public void setConnectionRevision(Long connectionRevision) { this.connectionRevision = connectionRevision; }
    public String getToolMode() { return toolMode; }
    public void setToolMode(String toolMode) { this.toolMode = toolMode; }

    public JsonNode getContextTemplateSnapshot() { return contextTemplateSnapshot; }
    public void setContextTemplateSnapshot(JsonNode contextTemplateSnapshot) {
        this.contextTemplateSnapshot = contextTemplateSnapshot == null
                ? JsonNodeFactory.instance.objectNode() : contextTemplateSnapshot.deepCopy();
    }
    public JsonNode getSkillsSnapshot() { return skillsSnapshot; }
    public void setSkillsSnapshot(JsonNode skillsSnapshot) {
        this.skillsSnapshot = skillsSnapshot == null
                ? JsonNodeFactory.instance.objectNode() : skillsSnapshot.deepCopy();
    }
    public JsonNode getPluginSnapshot() { return pluginSnapshot; }
    public void setPluginSnapshot(JsonNode pluginSnapshot) {
        this.pluginSnapshot = pluginSnapshot == null
                ? JsonNodeFactory.instance.objectNode() : pluginSnapshot.deepCopy();
    }
    public JsonNode getContextFingerprint() { return contextFingerprint; }
    public void setContextFingerprint(JsonNode contextFingerprint) {
        this.contextFingerprint = contextFingerprint == null ? null : contextFingerprint.deepCopy();
    }
    public JsonNode getContextTruncation() { return contextTruncation; }
    public void setContextTruncation(JsonNode contextTruncation) {
        this.contextTruncation = contextTruncation == null ? null : contextTruncation.deepCopy();
    }
    public String getUserMessageId() { return userMessageId; }
    public void setUserMessageId(String userMessageId) { this.userMessageId = userMessageId; }
    public String getAssistantMessageId() { return assistantMessageId; }
    public void setAssistantMessageId(String assistantMessageId) { this.assistantMessageId = assistantMessageId; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public Instant getTerminalAt() { return terminalAt; }
    public void setTerminalAt(Instant terminalAt) { this.terminalAt = terminalAt; }
    public String getTerminalOutcome() { return terminalOutcome; }
    public void setTerminalOutcome(String terminalOutcome) { this.terminalOutcome = terminalOutcome; }
    public String getErrorCode() { return errorCode; }
    public void setErrorCode(String errorCode) { this.errorCode = errorCode; }
    public String getErrorDetail() { return errorDetail; }
    public void setErrorDetail(String errorDetail) { this.errorDetail = errorDetail; }
    public int getTokenCount() { return tokenCount; }
    public void setTokenCount(int tokenCount) { this.tokenCount = tokenCount; }
    public int getAssistantChars() { return assistantChars; }
    public void setAssistantChars(int assistantChars) { this.assistantChars = assistantChars; }
    public String getLeaseOwner() { return leaseOwner; }
    public void setLeaseOwner(String leaseOwner) { this.leaseOwner = leaseOwner; }
    public Instant getLeaseExpiresAt() { return leaseExpiresAt; }
    public void setLeaseExpiresAt(Instant leaseExpiresAt) { this.leaseExpiresAt = leaseExpiresAt; }
    public String getWaitingOnRunId() { return waitingOnRunId; }
    public void setWaitingOnRunId(String waitingOnRunId) { this.waitingOnRunId = waitingOnRunId; }
    public String getWaitingToolCallId() { return waitingToolCallId; }
    public void setWaitingToolCallId(String waitingToolCallId) { this.waitingToolCallId = waitingToolCallId; }
    public String getParentRunId() { return parentRunId; }
    public void setParentRunId(String parentRunId) { this.parentRunId = parentRunId; }
    public String getContinuationSourceRunId() { return continuationSourceRunId; }
    public void setContinuationSourceRunId(String continuationSourceRunId) {
        this.continuationSourceRunId = continuationSourceRunId;
    }
    public String getContinuationLineageId() { return continuationLineageId; }
    public void setContinuationLineageId(String continuationLineageId) {
        this.continuationLineageId = continuationLineageId;
    }
    public String getContinuationThreadId() { return continuationThreadId; }
    public void setContinuationThreadId(String continuationThreadId) {
        this.continuationThreadId = continuationThreadId;
    }
    public String getContinuationCheckpointId() { return continuationCheckpointId; }
    public void setContinuationCheckpointId(String continuationCheckpointId) {
        this.continuationCheckpointId = continuationCheckpointId;
    }
    public Long getContinuationEventSequence() { return continuationEventSequence; }
    public void setContinuationEventSequence(Long continuationEventSequence) {
        this.continuationEventSequence = continuationEventSequence;
    }
    public String getContinuationMode() { return continuationMode; }
    public void setContinuationMode(String continuationMode) { this.continuationMode = continuationMode; }
    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
