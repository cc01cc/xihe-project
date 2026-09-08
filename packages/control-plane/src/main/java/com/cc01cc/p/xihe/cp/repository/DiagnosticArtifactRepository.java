package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.DiagnosticArtifact;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface DiagnosticArtifactRepository extends JpaRepository<DiagnosticArtifact, UUID> {

    List<DiagnosticArtifact> findByOperationIdOrderByCreatedAtAsc(UUID operationId);

    List<DiagnosticArtifact> findByItemId(String itemId);

    List<DiagnosticArtifact> findByAttemptId(String attemptId);

    List<DiagnosticArtifact> findByDeletedAtIsNullAndExpiresAtBefore(java.time.Instant expiresAt);
}
