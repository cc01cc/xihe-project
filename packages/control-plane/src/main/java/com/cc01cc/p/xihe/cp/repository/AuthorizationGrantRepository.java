package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Collection;
import java.util.List;
import java.util.UUID;

public interface AuthorizationGrantRepository extends JpaRepository<AuthorizationGrant, UUID> {

    boolean existsBySubjectTypeAndSubjectIdAndSource(String subjectType, UUID subjectId, String source);

    long countBySubjectTypeAndSubjectIdAndSource(String subjectType, UUID subjectId, String source);

    List<AuthorizationGrant> findBySubjectTypeAndSubjectId(String subjectType, UUID subjectId);

    List<AuthorizationGrant> findBySubjectTypeAndSubjectIdIn(String subjectType, List<UUID> subjectIds);

    void deleteBySubjectTypeAndSubjectId(String subjectType, UUID subjectId);

    /**
     * PLAN-0610 T1.6: the evaluation read. Only the union sources participate, and the scope
     * filter is applied in SQL so a workspace request can never see another workspace's
     * materialized rows:
     *
     * <ul>
     *   <li>{@code instance} rows always participate;</li>
     *   <li>{@code workspace} rows only when {@code scope_id} equals the request workspace;</li>
     *   <li>a {@code null} workspace argument therefore yields instance rows only.</li>
     * </ul>
     *
     * <p>The retired {@code default}/{@code direct} sources are excluded by construction: they
     * are not in the caller's source list, so a leftover V87 row is inert until V88 converts it
     * (or the caller deliberately keeps reading it).</p>
     */
    @Query("select g from AuthorizationGrant g "
            + "where g.subjectType = :subjectType and g.subjectId = :subjectId "
            + "and g.source in :sources "
            + "and (g.scopeType = 'instance' or (g.scopeType = 'workspace' and g.scopeId = :workspaceId))")
    List<AuthorizationGrant> findScopedGrants(@Param("subjectType") String subjectType,
                                              @Param("subjectId") UUID subjectId,
                                              @Param("sources") Collection<String> sources,
                                              @Param("workspaceId") UUID workspaceId);

    /**
     * PLAN-0610 materializer read: every row of one source for one subject, regardless of scope.
     * Used to reconcile the materialized atom set (the scope columns are part of the comparison).
     */
    List<AuthorizationGrant> findBySubjectTypeAndSubjectIdAndSource(String subjectType, UUID subjectId,
                                                                   String source);
}
