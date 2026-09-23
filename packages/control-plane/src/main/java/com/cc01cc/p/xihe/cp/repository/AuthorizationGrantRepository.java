package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.UUID;

public interface AuthorizationGrantRepository extends JpaRepository<AuthorizationGrant, UUID> {

    @Query("select g from AuthorizationGrant g where "
            + "(g.subjectType = 'user' and g.subjectId = :userId) or "
            + "(g.subjectType = 'agent' and g.subjectId in :agentSessionIds)")
    List<AuthorizationGrant> findForAuthorizationPath(
            @Param("userId") UUID userId,
            @Param("agentSessionIds") List<UUID> agentSessionIds);
}
