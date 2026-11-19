package com.cc01cc.p.xihe.cp.entity;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.IdClass;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

/**
 * PLAN-0679 (design D1) + task-103 (D-1869①): one provider request record per (run, provider step).
 *
 * <p>v1 stored a single write-once document per run; task-103 lifts the V132 B-6 reservation into
 * the primary key {@code (run_id, provider_step)} so a re-dispatched run keeps every step, and the
 * retry count becomes row count - 1.</p>
 *
 * <p><b>Verbatim bytes (user ruling 2026-11-19, DEV-004 6.5b):</b> {@code request_body} /
 * {@code response_body} / {@code error_body} are the raw wire bytes as captured by the Agent - not
 * redacted, not rewritten. {@code sha256} + byte count travel next to them so byte equality is
 * checkable. {@code providerAudit=off} leaves them NULL: never 0, never an empty string.</p>
 *
 * <p>Absence of a row is named by the read-side envelope as {@code not_captured}; a present row with
 * NULL bodies is named by {@code tier=off} - the two are different facts and are never merged.</p>
 */
@Entity
@Table(name = "chat_run_provider_requests")
@IdClass(ChatRunProviderRequestId.class)
public class ChatRunProviderRequest {

    /** v1 wrote exactly one document per run; per-step rows arrive with task-103. */
    public static final int V1_DISPATCH_ATTEMPT = 1;
    public static final int V1_PROVIDER_STEP = 1;

    /** Audit tier that captured the bodies ({@code full} / {@code metadata} / {@code off}). */
    public static final String TIER_FULL = "full";
    public static final String TIER_METADATA = "metadata";
    public static final String TIER_OFF = "off";

    @Id
    @Column(name = "run_id", columnDefinition = "uuid")
    private UUID runId;

    @Id
    @Column(name = "provider_step", nullable = false)
    private Integer providerStep = V1_PROVIDER_STEP;

    @Column(name = "dispatch_attempt", nullable = false)
    private Integer dispatchAttempt = V1_DISPATCH_ATTEMPT;

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

    /** Counts only ({@code {"human":1,...}}) - never message bodies. */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "role_histogram", nullable = false, columnDefinition = "jsonb")
    private JsonNode roleHistogram;

    /** Source summary (template id/version, slot fill state, component counts) - metadata only. */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "system_sources", nullable = false, columnDefinition = "jsonb")
    private JsonNode systemSources;

    /** The design 4.2 six-layer document, verbatim as the Agent produced it. */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "fingerprint", nullable = false, columnDefinition = "jsonb")
    private JsonNode fingerprint;

    /** {@code full} (bodies kept) / {@code metadata} (sha+counts only) / {@code off} (nothing). */
    @Column(name = "tier", nullable = false, length = 16)
    private String tier = TIER_METADATA;

    @Column(name = "http_status")
    private Integer httpStatus;

    @Column(name = "streamed")
    private Boolean streamed;

    /** Provider-reported finish/stop reason; NULL means the provider did not report one. */
    @Column(name = "finish_reason", length = 64)
    private String finishReason;

    /** Time to first byte, milliseconds. */
    @Column(name = "ttft_ms")
    private Integer ttftMs;

    @Column(name = "total_ms")
    private Integer totalMs;

    @Column(name = "request_sha256", length = 64)
    private String requestSha256;

    @Column(name = "request_bytes")
    private Long requestBytes;

    /** Verbatim request wire bytes; NULL when the tier did not keep bodies. */
    @JdbcTypeCode(SqlTypes.VARBINARY)
    @Column(name = "request_body", columnDefinition = "bytea")
    private byte[] requestBody;

    @Column(name = "response_sha256", length = 64)
    private String responseSha256;

    @Column(name = "response_bytes")
    private Long responseBytes;

    /** Verbatim response bytes (whole body or the raw SSE stream). */
    @JdbcTypeCode(SqlTypes.VARBINARY)
    @Column(name = "response_body", columnDefinition = "bytea")
    private byte[] responseBody;

    @Column(name = "error_sha256", length = 64)
    private String errorSha256;

    @Column(name = "error_bytes")
    private Long errorBytes;

    /** Verbatim provider error body (undecoded, as received). */
    @JdbcTypeCode(SqlTypes.VARBINARY)
    @Column(name = "error_body", columnDefinition = "bytea")
    private byte[] errorBody;

    /** Cache hit tokens; NULL when the provider reported none (0 would poison averages). */
    @Column(name = "cache_read_input_tokens")
    private Long cacheReadInputTokens;

    /** Cache write tokens; NULL when the provider reported none. */
    @Column(name = "cache_write_input_tokens")
    private Long cacheWriteInputTokens;

    /** Request parameter values as sent (model/stream/max_tokens/...), not hashed. */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "request_params", columnDefinition = "jsonb")
    private JsonNode requestParams;

    /** Rendered tool surface hash + count (schema text never stored as text). */
    @JdbcTypeCode(SqlTypes.JSON)
  
    @Column(name = "tool_surface", columnDefinition = "jsonb")
    private JsonNode toolSurface;

    /** The Agent's audit block for this attempt, verbatim (tier/status/timings/params/...). */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "provider_audit", nullable = false, columnDefinition = "jsonb")
    private JsonNode providerAudit;

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
    public Integer getProviderStep() { return providerStep; }
    public void setProviderStep(Integer providerStep) { this.providerStep = providerStep; }
    public Integer getDispatchAttempt() { return dispatchAttempt; }
    public void setDispatchAttempt(Integer dispatchAttempt) { this.dispatchAttempt = dispatchAttempt; }
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
    public String getTier() { return tier; }
    public void setTier(String tier) { this.tier = tier; }
    public Integer getHttpStatus() { return httpStatus; }
    public void setHttpStatus(Integer httpStatus) { this.httpStatus = httpStatus; }
    public Boolean getStreamed() { return streamed; }
    public void setStreamed(Boolean streamed) { this.streamed = streamed; }
    public String getFinishReason() { return finishReason; }
    public void setFinishReason(String finishReason) { this.finishReason = finishReason; }
    public Integer getTtftMs() { return ttftMs; }
    public void setTtftMs(Integer ttftMs) { this.ttftMs = ttftMs; }
    public Integer getTotalMs() { return totalMs; }
    public void setTotalMs(Integer totalMs) { this.totalMs = totalMs; }
    public String getRequestSha256() { return requestSha256; }
    public void setRequestSha256(String requestSha256) { this.requestSha256 = requestSha256; }
    public Long getRequestBytes() { return requestBytes; }
    public void setRequestBytes(Long requestBytes) { this.requestBytes = requestBytes; }
    public byte[] getRequestBody() { return requestBody; }
    public void setRequestBody(byte[] requestBody) { this.requestBody = requestBody; }
    public String getResponseSha256() { return responseSha256; }
    public void setResponseSha256(String responseSha256) { this.responseSha256 = responseSha256; }
    public Long getResponseBytes() { return responseBytes; }
    public void setResponseBytes(Long responseBytes) { this.responseBytes = responseBytes; }
    public byte[] getResponseBody() { return responseBody; }
    public void setResponseBody(byte[] responseBody) { this.responseBody = responseBody; }
    public String getErrorSha256() { return errorSha256; }
    public void setErrorSha256(String errorSha256) { this.errorSha256 = errorSha256; }
    public Long getErrorBytes() { return errorBytes; }
    public void setErrorBytes(Long errorBytes) { this.errorBytes = errorBytes; }
    public byte[] getErrorBody() { return errorBody; }
    public void setErrorBody(byte[] errorBody) { this.errorBody = errorBody; }
    public Long getCacheReadInputTokens() { return cacheReadInputTokens; }
    public void setCacheReadInputTokens(Long cacheReadInputTokens) { this.cacheReadInputTokens = cacheReadInputTokens; }
    public Long getCacheWriteInputTokens() { return cacheWriteInputTokens; }
    public void setCacheWriteInputTokens(Long cacheWriteInputTokens) { this.cacheWriteInputTokens = cacheWriteInputTokens; }
    public JsonNode getRequestParams() { return requestParams; }
    public void setRequestParams(JsonNode requestParams) { this.requestParams = requestParams; }
    public JsonNode getToolSurface() { return toolSurface; }
    public void setToolSurface(JsonNode toolSurface) { this.toolSurface = toolSurface; }
    public JsonNode getProviderAudit() { return providerAudit; }
    public void setProviderAudit(JsonNode providerAudit) { this.providerAudit = providerAudit; }
    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}