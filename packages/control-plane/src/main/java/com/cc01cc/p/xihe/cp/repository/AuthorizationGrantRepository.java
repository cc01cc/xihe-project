package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface AuthorizationGrantRepository extends JpaRepository<AuthorizationGrant, UUID> {

    boolean existsBySubjectTypeAndSubjectIdAndSource(String subjectType, UUID subjectId, String source);

    long countBySubjectTypeAndSubjectIdAndSource(String subjectType, UUID subjectId, String source);

    List<AuthorizationGrant> findBySubjectTypeAndSubjectId(String subjectType, UUID subjectId);

    List<AuthorizationGrant> findBySubjectTypeAndSubjectIdIn(String subjectType, List<UUID> subjectIds);

    void deleteBySubjectTypeAndSubjectId(String subjectType, UUID subjectId);
}
