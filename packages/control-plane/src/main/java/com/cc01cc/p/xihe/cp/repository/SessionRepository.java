package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.Session;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface SessionRepository extends JpaRepository<Session, UUID> {
    List<Session> findByUserIdAndArchivedFalseOrderByCreatedAtDesc(String userId);
    List<Session> findByWorkspaceIdAndArchivedFalseOrderByCreatedAtDesc(String workspaceId);
    List<Session> findByWorkspaceIdAndUserIdAndArchivedFalseOrderByCreatedAtDesc(
            String workspaceId, String userId);

    /**
     * PLAN-0668 D1/D5: the read-face list — owned sessions plus sessions where the caller is an
     * enabled HUMAN participant. Managers are deliberately absent (D1b: no content read), and the
     * roster guard remains the only manager-facing read.
     */
    @Query("""
            select s from Session s
             where s.workspaceId = :workspaceId
               and s.archived = false
               and (s.userId = :userId
                    or exists (select p.id from SessionParticipant p
                                where p.sessionId = s.id
                                  and p.principalKind = 'HUMAN'
                                  and p.principalId = :actorId
                                  and p.disabledAt is null))
             order by s.createdAt desc
            """)
    List<Session> findReadableByWorkspaceIdAndActor(@Param("workspaceId") String workspaceId,
                                                    @Param("userId") String userId,
                                                    @Param("actorId") UUID actorId);

    /**
     * D-1236 (task-390): the workspace-less read face. Same D1/D5 rule as
     * {@link #findReadableByWorkspaceIdAndActor} (owner OR enabled HUMAN participant, managers
     * absent, archived excluded) with the workspace predicate replaced by {@code workspaceId is null}.
     * Serves the V145 partial index idx_sessions_user_active_no_workspace
     * (user_id, archived, created_at DESC) WHERE workspace_id IS NULL — the legacy composite index
     * cannot serve NULL rows (V145:21-24).
     */
    @Query("""
            select s from Session s
             where s.workspaceId is null
               and s.archived = false
               and (s.userId = :userId
                    or exists (select p.id from SessionParticipant p
                                where p.sessionId = s.id
                                  and p.principalKind = 'HUMAN'
                                  and p.principalId = :actorId
                                  and p.disabledAt is null))
             order by s.createdAt desc
            """)
    List<Session> findReadableWorkspacelessByActor(@Param("userId") String userId,
                                                   @Param("actorId") UUID actorId);
    Optional<Session> findByIdAndUserIdAndWorkspaceIdAndArchivedFalse(
            UUID id, String userId, String workspaceId);

    /**
     * PLAN-0346 (gap E): pessimistic lock used to serialize per-Session
     * context_events sequence allocation while allowing other Sessions to proceed.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select s from Session s where s.id = :id")
    Optional<Session> findByIdForUpdate(@Param("id") UUID id);

    /**
     * PLAN-0407 T2.5：停止传播的派生边查询。调用方必须固定 kind=spawn——
     * fork Session 不入传播链（design #5/#14），由谓词而不是调用点约定保证。
     */
    List<Session> findBySpawnedFromRunIdAndKind(UUID spawnedFromRunId, String kind);

    List<Session> findBySpawnedFromSessionIdAndKind(UUID spawnedFromSessionId, String kind);

    /** PLAN-0646 MVP: the thread's sessions, oldest first (bounded by the caller's page). */
    List<Session> findByConversationThreadIdOrderByCreatedAtAsc(UUID conversationThreadId);
}
