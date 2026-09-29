package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.SessionBranch;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface SessionBranchRepository extends JpaRepository<SessionBranch, UUID> {

    Optional<SessionBranch> findBySessionIdAndParentBranchIdIsNull(String sessionId);

    Optional<SessionBranch> findBySessionIdAndIdempotencyKey(String sessionId, String idempotencyKey);

    List<SessionBranch> findBySessionIdOrderByCreatedAtAscIdAsc(String sessionId);

    /**
     * Session DELETE must remove branch rows before messages: child branches hold
     * an ON DELETE RESTRICT anchor FK to messages (V43), so message-first deletion
     * fails with an FK violation as soon as a non-root branch exists. A single
     * bulk statement lets the branch self-CFK / messages / chat_runs /
     * context_events / context_projections cascades resolve at end of statement.
     */
    @Modifying
    @Query("delete from SessionBranch b where b.sessionId = :sessionId")
    void deleteAllBySessionId(@Param("sessionId") String sessionId);
}
