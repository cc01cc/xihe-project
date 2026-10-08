package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.Inbox;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.Repository;
import org.springframework.data.repository.query.Param;

import java.util.UUID;
import java.util.List;

/**
 * PLAN-0407 T2.6b / PLAN-0408: Inbox terminal-notice upsert and parent-Run claim.
 *
 * <p>{@link #upsertChildTerminal} runs inside the unified terminal transaction
 * (last write, after Session/Run locks per design #45). The unique key
 * {@code (to_session_id, type, ref)} plus the
 * conditional CAS upstream guarantee at most one row per child terminal; the
 * {@code ON CONFLICT} clause keeps a repeated attempt idempotent and never
 * touches {@code injected_run_id} or {@code created_at}. A failure here must
 * roll back ChatRun terminal status, {@code terminal_at}, the parent item
 * settlement and the waiting link in the same transaction.
 */
public interface InboxRepository extends Repository<Inbox, UUID> {

    List<Inbox> findByToSessionIdAndTypeOrderByCreatedAtAscIdAsc(String toSessionId, String type);

    @Modifying
    @Query(value = """
            INSERT INTO inbox (id, to_session_id, type, ref, payload_pointer, created_at, injected_run_id)
            VALUES (:id, :toSessionId, 'child_terminal', :ref, CAST(:payloadPointer AS jsonb), NOW(), NULL)
            ON CONFLICT (to_session_id, type, ref)
            DO UPDATE SET payload_pointer = EXCLUDED.payload_pointer
            """, nativeQuery = true)
    int upsertChildTerminal(@Param("id") UUID id,
                            @Param("toSessionId") UUID toSessionId,
                            @Param("ref") UUID ref,
                            @Param("payloadPointer") String payloadPointer);

    /**
     * Claims every pending notice for a newly-created parent Run. The UPDATE
     * itself locks matching rows; ChatSubmissionService calls it last in the
     * same Session-first create transaction, after the durable ChatRun and user
     * Message exist. Existing claims are never reassigned to a later Run.
     */
    @Modifying
    @Query(value = """
            UPDATE inbox
            SET injected_run_id = :runId
            WHERE to_session_id = :sessionId
              AND type = 'child_terminal'
              AND injected_run_id IS NULL
            """, nativeQuery = true)
    int claimPendingForRun(@Param("sessionId") UUID sessionId, @Param("runId") UUID runId);
}
