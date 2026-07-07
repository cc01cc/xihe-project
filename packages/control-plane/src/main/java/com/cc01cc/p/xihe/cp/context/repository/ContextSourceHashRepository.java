package com.cc01cc.p.xihe.cp.context.repository;

import com.cc01cc.p.xihe.cp.context.entity.ContextSourceHash;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;
import java.util.UUID;

@Repository
public interface ContextSourceHashRepository extends JpaRepository<ContextSourceHash, UUID> {

    Optional<ContextSourceHash> findByWorkspaceIdAndSourceKey(String workspaceId, String sourceKey);
}
