package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.SessionFollowUpItem;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface SessionFollowUpItemRepository extends JpaRepository<SessionFollowUpItem, UUID> {

    List<String> OUTSTANDING_STATUSES = List.of(
            SessionFollowUpItem.STATUS_QUEUED,
            SessionFollowUpItem.STATUS_PAUSED,
            SessionFollowUpItem.STATUS_ADMITTED);

    Optional<SessionFollowUpItem> findBySessionIdAndIdempotencyKey(String sessionId, String idempotencyKey);

    long countBySessionIdAndStatusIn(String sessionId, Collection<String> statuses);

    List<SessionFollowUpItem> findBySessionIdAndStatusInOrderByQueueSequenceAsc(
            String sessionId, Collection<String> statuses);

    Optional<SessionFollowUpItem> findFirstBySessionIdAndStatusInOrderByQueueSequenceAsc(
            String sessionId, Collection<String> statuses);

    @Query("select distinct i.sessionId from SessionFollowUpItem i "
            + "where i.status = 'queued' and not exists ("
            + "select earlier.id from SessionFollowUpItem earlier "
            + "where earlier.sessionId = i.sessionId and earlier.queueSequence < i.queueSequence "
            + "and earlier.status in :outstandingStatuses) order by i.sessionId")
    List<String> findDistinctQueuedHeadSessionIds(
            @Param("outstandingStatuses") Collection<String> outstandingStatuses);

    @Query("select distinct i.sessionId from SessionFollowUpItem i "
            + "where i.status = 'admitted' and (i.childRunId is null or not exists ("
            + "select r.id from ChatRun r where r.id = i.childRunId)) order by i.sessionId")
    List<String> findDistinctSessionsWithMissingAdmittedChild();

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select i from SessionFollowUpItem i where i.sessionId = :sessionId "
            + "and i.status = 'admitted' and (i.childRunId is null or not exists ("
            + "select r.id from ChatRun r where r.id = i.childRunId)) order by i.queueSequence")
    List<SessionFollowUpItem> findAdmittedItemsWithMissingChildForUpdate(
            @Param("sessionId") String sessionId);

    @Query("select coalesce(max(i.queueSequence), 0) from SessionFollowUpItem i where i.sessionId = :sessionId")
    long findMaxQueueSequence(@Param("sessionId") String sessionId);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select i from SessionFollowUpItem i where i.sessionId = :sessionId and i.id = :itemId")
    Optional<SessionFollowUpItem> findBySessionIdAndIdForUpdate(
            @Param("sessionId") String sessionId, @Param("itemId") UUID itemId);
}
