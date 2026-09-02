package com.cc01cc.p.xihe.cp.repository;

import org.springframework.data.jpa.repository.JpaRepository;
import com.cc01cc.p.xihe.cp.entity.File;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

public interface FileRepository extends JpaRepository<File, String> {
    List<File> findByUserId(String userId);
    List<File> findByWorkspaceId(String workspaceId);
    List<File> findBySessionId(String sessionId);
    List<File> findBySessionIdOrderByCreatedAtAsc(String sessionId);
    Optional<File> findByIdAndSessionId(String id, String sessionId);
    List<File> findByMessageId(String messageId);
    List<File> findByMessageIdIsNullAndCreatedAtBefore(Instant createdAt);
    long deleteBySessionId(String sessionId);
}
