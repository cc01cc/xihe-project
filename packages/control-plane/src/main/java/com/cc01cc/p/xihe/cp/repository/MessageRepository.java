package com.cc01cc.p.xihe.cp.repository;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.UUID;
import com.cc01cc.p.xihe.cp.entity.Message;

import java.util.List;

public interface MessageRepository extends JpaRepository<Message, UUID> {
    boolean existsBySessionId(String sessionId);

    /**
     * BL-279: session-wide message count for the export precheck. Backed by
     * {@code idx_messages_session_id}; deliberately counts every branch/visibility row because the
     * export cap protects CP memory *before* any message is materialised (see
     * {@code SessionExportController}).
     */
    long countBySessionId(String sessionId);

    List<Message> findBySessionIdOrderByCreatedAtAsc(String sessionId);
    long deleteBySessionId(String sessionId);

    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(value = "UPDATE messages SET run_id = NULL WHERE run_id IN "
            + "(SELECT id FROM chat_runs WHERE session_id = CAST(:sessionId AS UUID))",
            nativeQuery = true)
    int clearRunReferencesToSession(@Param("sessionId") String sessionId);
}
