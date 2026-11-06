package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.ChatRunProviderRequest;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.UUID;

/**
 * PLAN-0679 (design D1/D2): write-once persistence of the per-run provider-request fingerprint.
 *
 * <p>Reads are by primary key only ({@code run_id}), so the inherited {@code findById} is the whole
 * read surface — the diff caller already holds both run ids.</p>
 */
public interface ChatRunProviderRequestRepository
        extends JpaRepository<ChatRunProviderRequest, UUID> {

    /**
     * Record the fingerprint exactly once.
     *
     * <p>{@code ON CONFLICT (run_id) DO NOTHING} is the durable write-once guard: the Agent emits one
     * {@code provider_request_fingerprint} event per run, but a context-overflow re-dispatch
     * re-enters the first provider step and would emit a second event for the same run. The first
     * document wins (design D2 / PLAN-0666 D3 precedent). Returns the number of inserted rows so the
     * caller can log a no-op without treating it as an error.</p>
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    @Query(value = "INSERT INTO chat_run_provider_requests "
            + "(run_id, dispatch_attempt, provider_step, api_type_id, api_type_version, model, "
            + "message_count, tool_count, bytes_total, role_histogram, system_sources, fingerprint, "
            + "created_at) "
            + "VALUES (CAST(:runId AS UUID), :dispatchAttempt, :providerStep, :apiTypeId, "
            + ":apiTypeVersion, :model, :messageCount, :toolCount, :bytesTotal, "
            + "CAST(:roleHistogram AS jsonb), CAST(:systemSources AS jsonb), "
            + "CAST(:fingerprint AS jsonb), :createdAt) "
            + "ON CONFLICT (run_id) DO NOTHING",
            nativeQuery = true)
    int insertOnce(@Param("runId") UUID runId,
                   @Param("dispatchAttempt") int dispatchAttempt,
                   @Param("providerStep") int providerStep,
                   @Param("apiTypeId") String apiTypeId,
                   @Param("apiTypeVersion") Integer apiTypeVersion,
                   @Param("model") String model,
                   @Param("messageCount") int messageCount,
                   @Param("toolCount") int toolCount,
                   @Param("bytesTotal") long bytesTotal,
                   @Param("roleHistogram") String roleHistogram,
                   @Param("systemSources") String systemSources,
                   @Param("fingerprint") String fingerprint,
                   @Param("createdAt") Instant createdAt);
}
