package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.SessionBranch;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;
import java.util.UUID;

@Repository
public interface SessionBranchRepository extends JpaRepository<SessionBranch, UUID> {

    Optional<SessionBranch> findBySessionIdAndParentBranchIdIsNull(String sessionId);
}
