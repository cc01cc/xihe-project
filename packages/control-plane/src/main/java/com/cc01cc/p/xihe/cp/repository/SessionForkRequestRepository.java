package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.SessionForkRequest;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface SessionForkRequestRepository extends JpaRepository<SessionForkRequest, UUID> {

    Optional<SessionForkRequest> findBySourceSessionIdAndIdempotencyKey(
            UUID sourceSessionId, String idempotencyKey);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select r from SessionForkRequest r where r.sourceSessionId = :sourceSessionId "
            + "and r.idempotencyKey = :idempotencyKey")
    Optional<SessionForkRequest> findBySourceSessionIdAndIdempotencyKeyForUpdate(
            @Param("sourceSessionId") UUID sourceSessionId,
            @Param("idempotencyKey") String idempotencyKey);

    boolean existsBySourceSessionIdAndState(UUID sourceSessionId, String state);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select r from SessionForkRequest r where r.childSessionId = :childSessionId")
    Optional<SessionForkRequest> findByChildSessionIdForUpdate(@Param("childSessionId") UUID childSessionId);

    @Query(value = "select * from session_fork_requests "
            + "where (state = 'copying' and updated_at < :copyingBefore) "
            + "or (state = 'cleanup_pending' and updated_at < :cleanupBefore) "
            + "order by updated_at asc limit :batchSize for update skip locked",
            nativeQuery = true)
    List<SessionForkRequest> lockRecoverableRows(
            @Param("copyingBefore") Instant copyingBefore,
            @Param("cleanupBefore") Instant cleanupBefore,
            @Param("batchSize") int batchSize);
}
