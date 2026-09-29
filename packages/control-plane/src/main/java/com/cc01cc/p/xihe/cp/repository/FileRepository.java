package com.cc01cc.p.xihe.cp.repository;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import com.cc01cc.p.xihe.cp.entity.File;
import jakarta.persistence.LockModeType;

import java.time.Instant;
import java.util.UUID;
import java.util.List;
import java.util.Optional;

public interface FileRepository extends JpaRepository<File, UUID> {
    List<File> findByUserId(String userId);
    List<File> findByWorkspaceId(String workspaceId);
    List<File> findBySessionId(String sessionId);
    List<File> findBySessionIdOrderByCreatedAtAsc(String sessionId);
    List<File> findBySessionIdOrderByIdAsc(String sessionId);
    Optional<File> findByIdAndSessionId(UUID id, String sessionId);
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select f from File f where f.id = :id")
    Optional<File> findByIdForUpdate(@Param("id") UUID id);
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select f from File f where f.id = :id and f.sessionId = :sessionId")
    Optional<File> findByIdAndSessionIdForUpdate(@Param("id") UUID id, @Param("sessionId") String sessionId);
    List<File> findByMessageId(String messageId);
    List<File> findByMessageIdOrderByIdAsc(String messageId);
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select f from File f where f.messageId in :messageIds order by f.id")
    List<File> findByMessageIdsForUpdateOrderByIdAsc(@Param("messageIds") List<String> messageIds);
    List<File> findByMessageIdIsNullAndCreatedAtBefore(Instant createdAt);
    long deleteBySessionId(String sessionId);
}
