package com.cc01cc.p.xihe.cp.context.repository;

import com.cc01cc.p.xihe.cp.context.entity.ContextProjection;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;
import java.util.UUID;

@Repository
public interface ContextProjectionRepository extends JpaRepository<ContextProjection, UUID> {

    Optional<ContextProjection> findBySessionId(String sessionId);

    Optional<ContextProjection> findBySessionIdAndProjectionType(String sessionId, String projectionType);
}
