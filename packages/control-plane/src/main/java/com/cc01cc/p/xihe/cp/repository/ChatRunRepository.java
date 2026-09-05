package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.util.Optional;

public interface ChatRunRepository extends JpaRepository<ChatRun, String> {

    Optional<ChatRun> findByUserIdAndSessionIdAndIdempotencyKey(
            String userId, String sessionId, String idempotencyKey);

    @Modifying
    @Transactional
    @Query("update ChatRun r set r.status = :status, r.terminalOutcome = :outcome, "
            + "r.errorCode = :errorCode, r.errorDetail = :errorDetail, "
            + "r.tokenCount = :tokenCount, r.assistantChars = :assistantChars "
            + "where r.id = :id and r.status in :expectedStatuses")
    int transition(
            @Param("id") String id,
            @Param("expectedStatuses") java.util.Collection<String> expectedStatuses,
            @Param("status") String status,
            @Param("outcome") String outcome,
            @Param("errorCode") String errorCode,
            @Param("errorDetail") String errorDetail,
            @Param("tokenCount") int tokenCount,
            @Param("assistantChars") int assistantChars);
}
