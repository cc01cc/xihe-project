package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.ChatRunProviderRequest;
import com.cc01cc.p.xihe.cp.entity.ChatRunProviderRequestId;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * PLAN-0679 T2.1 + task-103 (D-1869①): per-(run, provider step) records.
 *
 * <p>{@code insertStep} is the only writer. It is idempotent on the natural key
 * {@code (run_id, provider_step)} - an SSE replay of the same step re-writes nothing, and a
 * re-dispatched step lands as its own row instead of silently overwriting step 1.</p>
 */
public interface ChatRunProviderRequestRepository
        extends JpaRepository<ChatRunProviderRequest, ChatRunProviderRequestId> {

    /** Every captured step of one run, in provider order (a retry is rows[1..], count - 1). */
    List<ChatRunProviderRequest> findByRunIdOrderByProviderStepAsc(UUID runId);

    @Modifying
    @Query(value = """
            INSERT INTO chat_run_provider_requests (
                run_id, provider_step, dispatch_attempt, api_type_id, api_type_version, model,
                message_count, tool_count, bytes_total, role_histogram, system_sources, fingerprint,
                created_at, tier, http_status, streamed, finish_reason, ttft_ms, total_ms,
                request_sha256, request_bytes, request_body, response_sha256, response_bytes, response_body,
                error_sha256, error_bytes, error_body, cache_read_input_tokens, cache_write_input_tokens,
                request_params, tool_surface, provider_audit)
            VALUES (
                :runId, :providerStep, :dispatchAttempt, :apiTypeId, :apiTypeVersion, :model,
                :messageCount, :toolCount, :bytesTotal,
                CAST(:roleHistogram AS jsonb), CAST(:systemSources AS jsonb), CAST(:fingerprint AS jsonb),
                :createdAt, :tier, :httpStatus, :streamed, :finishReason, :ttftMs, :totalMs,
                :requestSha256, :requestBytes, CAST(:requestBody AS bytea),
                :responseSha256, :responseBytes, CAST(:responseBody AS bytea),
                :errorSha256, :errorBytes, CAST(:errorBody AS bytea),
                :cacheReadInputTokens, :cacheWriteInputTokens,
                CAST(:requestParams AS jsonb), CAST(:toolSurface AS jsonb), CAST(:providerAudit AS jsonb))
            ON CONFLICT (run_id, provider_step) DO NOTHING
            """, nativeQuery = true)
    int insertStep(
            @Param("runId") UUID runId,
            @Param("providerStep") int providerStep,
            @Param("dispatchAttempt") int dispatchAttempt,
            @Param("apiTypeId") String apiTypeId,
            @Param("apiTypeVersion") Integer apiTypeVersion,
            @Param("model") String model,
            @Param("messageCount") int messageCount,
            @Param("toolCount") int toolCount,
            @Param("bytesTotal") long bytesTotal,
            @Param("roleHistogram") String roleHistogram,
            @Param("systemSources") String systemSources,
            @Param("fingerprint") String fingerprint,
            @Param("createdAt") Instant createdAt,
            @Param("tier") String tier,
            @Param("httpStatus") Integer httpStatus,
            @Param("streamed") Boolean streamed,
            @Param("finishReason") String finishReason,
            @Param("ttftMs") Integer ttftMs,
            @Param("totalMs") Integer totalMs,
            @Param("requestSha256") String requestSha256,
            @Param("requestBytes") Long requestBytes,
            @Param("requestBody") byte[] requestBody,
            @Param("responseSha256") String responseSha256,
            @Param("responseBytes") Long responseBytes,
            @Param("responseBody") byte[] responseBody,
            @Param("errorSha256") String errorSha256,
            @Param("errorBytes") Long errorBytes,
            @Param("errorBody") byte[] errorBody,
            @Param("cacheReadInputTokens") Long cacheReadInputTokens,
            @Param("cacheWriteInputTokens") Long cacheWriteInputTokens,
            @Param("requestParams") String requestParams,
            @Param("toolSurface") String toolSurface,
            @Param("providerAudit") String providerAudit);
}