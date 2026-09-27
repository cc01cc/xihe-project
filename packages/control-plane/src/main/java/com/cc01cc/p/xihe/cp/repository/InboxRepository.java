package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.Inbox;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.Repository;
import org.springframework.data.repository.query.Param;

import java.util.UUID;

/**
 * PLAN-0407 T2.6b / PLAN-0408: the single writer of Inbox rows.
 *
 * <p>{@link #upsertChildTerminal} runs inside the unified terminal transaction
 * (last write, after Session/Run/LedgerOperation/OperationItem locks per
 * design #45). The unique key {@code (to_session_id, type, ref)} plus the
 * conditional CAS upstream guarantee at most one row per child terminal; the
 * {@code ON CONFLICT} clause keeps a repeated attempt idempotent and never
 * touches {@code injected_run_id} or {@code created_at}. A failure here must
 * roll back ChatRun terminal status, {@code terminal_at}, the parent item
 * settlement and the waiting link in the same transaction.
 */
public interface InboxRepository extends Repository<Inbox, UUID> {

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
}
