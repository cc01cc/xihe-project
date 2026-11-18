package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.TeamTask;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * task-188 MVP⑤ S2 (V172): the team-task board rows.
 *
 * <p>Derived reads and CAS writes only — no @Lock pessimistic shapes (the board is advisory CAS,
 * bl-354). {@link #casUpdateStatus(UUID, long, String)} returns the affected-row count; the
 * service translates 0 into the precise conflict state instead of trusting the caller's view.</p>
 */
public interface TeamTaskRepository extends JpaRepository<TeamTask, UUID> {

    /** The whole board, tombstones included — the read face returns deleted rows and lets the
     *  caller filter (the established layer-filter discipline), ordered for stable display. */
    List<TeamTask> findByTeamRootSessionIdOrderByTaskNo(String teamRootSessionId);

    Optional<TeamTask> findByIdAndTeamRootSessionId(UUID id, String teamRootSessionId);

    long countByTeamRootSessionId(String teamRootSessionId);

    /**
     * Transition CAS: matches the row only when {@code expectedRevision} still equals the stored
     * one, bumps revision and stamps updated_at. Returns 1 on success, 0 on stale/missing.
     */
    @Modifying(clearAutomatically = true)
    @Query("UPDATE TeamTask t SET t.status = :toStatus, t.revision = t.revision + 1, "
            + "t.updatedAt = CURRENT_TIMESTAMP "
            + "WHERE t.id = :id AND t.revision = :expectedRevision")
    int casUpdateStatus(@Param("id") UUID id,
                        @Param("expectedRevision") long expectedRevision,
                        @Param("toStatus") String toStatus);

    /** Claim CAS: sets the owner (and its display name) on an unclaimed row; guarded by revision. */
    @Modifying(clearAutomatically = true)
    @Query("UPDATE TeamTask t SET t.ownerSessionId = :ownerSessionId, t.ownerName = :ownerName, "
            + "t.revision = t.revision + 1, t.updatedAt = CURRENT_TIMESTAMP "
            + "WHERE t.id = :id AND t.revision = :expectedRevision AND t.ownerSessionId IS NULL")
    int casClaim(@Param("id") UUID id,
                 @Param("expectedRevision") long expectedRevision,
                 @Param("ownerSessionId") String ownerSessionId,
                 @Param("ownerName") String ownerName);

    /** Reassign CAS: owner may move to another tree session or to null (unclaim); guarded by revision. */
    @Modifying(clearAutomatically = true)
    @Query("UPDATE TeamTask t SET t.ownerSessionId = :ownerSessionId, t.ownerName = :ownerName, "
            + "t.revision = t.revision + 1, t.updatedAt = CURRENT_TIMESTAMP "
            + "WHERE t.id = :id AND t.revision = :expectedRevision")
    int casReassign(@Param("id") UUID id,
                    @Param("expectedRevision") long expectedRevision,
                    @Param("ownerSessionId") String ownerSessionId,
                    @Param("ownerName") String ownerName);

    /**
     * Details CAS: null parameters keep the stored value (partial update); the JSON columns are
     * replaced whole when given. All guarded by revision.
     */
    @Modifying(clearAutomatically = true)
    @Query("UPDATE TeamTask t SET "
            + "t.subject = COALESCE(:subject, t.subject), "
            + "t.description = COALESCE(:description, t.description), "
            + "t.blockedBy = COALESCE(:blockedBy, t.blockedBy), "
            + "t.writeScopes = COALESCE(:writeScopes, t.writeScopes), "
            + "t.revision = t.revision + 1, t.updatedAt = CURRENT_TIMESTAMP "
            + "WHERE t.id = :id AND t.revision = :expectedRevision")
    int casUpdateDetails(@Param("id") UUID id,
                         @Param("expectedRevision") long expectedRevision,
                         @Param("subject") String subject,
                         @Param("description") String description,
                         @Param("blockedBy") com.fasterxml.jackson.databind.JsonNode blockedBy,
                         @Param("writeScopes") com.fasterxml.jackson.databind.JsonNode writeScopes);
}
