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
 * PLAN-0679 (design D1): the per-run final provider-request fingerprint.
 *
 * <p>Written once per run (SQL {@code INSERT ... ON CONFLICT (run_id) DO NOTHING}); a
 * context-overflow re-dispatch cannot replace the first document (design D2). Absence of a row is
 * named by the read-side envelope as {@code not_captured} — never re-encoded as
 * {@code disabled}/{@code error} (two-level model, design D5).</p>
 *
 * <p>Kept as a separate table rather than another {@code chat_runs} column (design D1): the row
 * carries the request metadata (apiType/model/counts/source summary) that would otherwise widen an
 * already-wide row, and v2 can grow to per-step rows without touching chat_runs (B-6).</p>
 */
@Entity
@Table(name = "chat_run_provider_requests")
public class ChatRunProviderRequest {

    /** v1 writes exactly one document per run; the columns stay explicit for the v2 per-step shape. */
    public static final int V1_DISPATCH_ATTEMPT = 1;
    public static final int V1_PROVIDER_STEP = 1;

    /**
     * The run this fingerprint belongs to; also the primary key (v1: one document per run).
     *
     * <p>Typed {@code UUID} like every other entity PK — {@code UuidStringConverter} is the
     * <b>non-PK</b> column convention (String attributes for API/SSE/JSON boundaries).</p>
     */
    @Id
    @Column(name = "run_id", columnDefinition = "uuid")
    private UUID runId;

    @Column(name = "dispatch_attempt", nullable = false)
    private Integer dispatchAttempt = V1_DISPATCH_ATTEMPT;

    @Column(name = "provider_step", nullable = false)
    private Integer providerStep = V1_PROVIDER_STEP;

    @Column(name = "api_type_id", nullable = false, length = 64)
    private String apiTypeId;

    @Column(name = "api_type_version")
    private Integer apiTypeVersion;

    /** The model actually dispatched (Agent-resolved, including any run-level override). */
    @Column(name = "model", nullable = false, length = 255)
    private String model;

    @Column(name = "message_count", nullable = false)
    private Integer messageCount;

    @Column(name = "tool_count", nullable = false)
    private Integer toolCount;

    @Column(name = "bytes_total", nullable = false)
    private Long bytesTotal;

    /** Counts only ({@code {"human":1,...}}) — never message bodies (design D5). */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "role_histogram", nullable = false, columnDefinition = "jsonb")
    private JsonNode roleHistogram;

    /** Source summary (template id/version, slot fill state, component counts) — metadata only. */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "system_sources", nullable = false, columnDefinition = "jsonb")
    private JsonNode systemSources;

    /** The design 4.2 six-layer document, verbatim as the Agent produced it. */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "fingerprint", nullable = false, columnDefinition = "jsonb")
    private JsonNode fingerprint;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public ChatRunProviderRequest() {}

    @PrePersist
    protected void onCreate() {
        if (createdAt == null) {
            createdAt = Instant.now();
        }
    }

    public UUID getRunId() { return runId; }
    public void setRunId(UUID runId) { this.runId = runId; }
    public Integer getDispatchAttempt() { return dispatchAttempt; }
    public void setDispatchAttempt(Integer dispatchAttempt) { this.dispatchAttempt = dispatchAttempt; }
    public Integer getProviderStep() { return providerStep; }
    public void setProviderStep(Integer providerStep) { this.providerStep = providerStep; }
    public String getApiTypeId() { return apiTypeId; }
    public void setApiTypeId(String apiTypeId) { this.apiTypeId = apiTypeId; }
    public Integer getApiTypeVersion() { return apiTypeVersion; }
    public void setApiTypeVersion(Integer apiTypeVersion) { this.apiTypeVersion = apiTypeVersion; }
    public String getModel() { return model; }
    public void setModel(String model) { this.model = model; }
    public Integer getMessageCount() { return messageCount; }
    public void setMessageCount(Integer messageCount) { this.messageCount = messageCount; }
    public Integer getToolCount() { return toolCount; }
    public void setToolCount(Integer toolCount) { this.toolCount = toolCount; }
    public Long getBytesTotal() { return bytesTotal; }
    public void setBytesTotal(Long bytesTotal) { this.bytesTotal = bytesTotal; }
    public JsonNode getRoleHistogram() { return roleHistogram; }
    public void setRoleHistogram(JsonNode roleHistogram) { this.roleHistogram = roleHistogram; }
    public JsonNode getSystemSources() { return systemSources; }
    public void setSystemSources(JsonNode systemSources) { this.systemSources = systemSources; }
    public JsonNode getFingerprint() { return fingerprint; }
    public void setFingerprint(JsonNode fingerprint) { this.fingerprint = fingerprint; }
    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}
