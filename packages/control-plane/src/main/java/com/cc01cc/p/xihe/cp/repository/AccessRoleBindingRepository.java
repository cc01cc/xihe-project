package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Collection;
import java.util.List;
import java.util.UUID;

public interface AccessRoleBindingRepository extends JpaRepository<AccessRoleBinding, UUID> {

    List<AccessRoleBinding> findBySubjectTypeAndSubjectId(String subjectType, UUID subjectId);

    List<AccessRoleBinding> findBySubjectTypeAndSubjectIdAndScopeType(String subjectType, UUID subjectId,
                                                                     String scopeType);

    List<AccessRoleBinding> findByRoleId(UUID roleId);

    long countByRoleId(UUID roleId);

    List<AccessRoleBinding> findByRoleIdIn(Collection<UUID> roleIds);

    @Modifying
    @Query("delete from AccessRoleBinding b where b.subjectType = :subjectType and b.subjectId = :subjectId")
    void deleteBySubject(@Param("subjectType") String subjectType, @Param("subjectId") UUID subjectId);

    @Modifying
    @Query("delete from AccessRoleBinding b where b.roleId = :roleId")
    void deleteByRoleId(@Param("roleId") UUID roleId);
}
