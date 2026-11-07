package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

public interface SessionParticipantRepository extends JpaRepository<SessionParticipant, UUID> {

    List<SessionParticipant> findBySessionIdOrderByOrderIndexAsc(UUID sessionId);

    Optional<SessionParticipant> findByIdAndSessionId(UUID id, UUID sessionId);

    boolean existsBySessionIdAndPrincipalKindAndPrincipalId(UUID sessionId, String principalKind,
                                                            UUID principalId);

    boolean existsBySessionIdAndRole(UUID sessionId, String role);

    /** R4: the next participant sits at MAX(order_index) + 10; 0 (no rows) means the first is 10. */
    @Query("select coalesce(max(p.orderIndex), 0) from SessionParticipant p where p.sessionId = :sessionId")
    Integer maxOrderIndex(@Param("sessionId") UUID sessionId);

    /** Visibility: an invited HUMAN participant may read the session list (D23-08). */
    boolean existsBySessionIdAndPrincipalKindAndPrincipalIdAndDisabledAtIsNull(UUID sessionId,
                                                                              String principalKind,
                                                                              UUID principalId);

    /**
     * PLAN-0669 D2: the participant row for a (session, principal) pair — the write side resolves a
     * Message's durable attribution through it. Empty when no row exists (never invent one).
     */
    Optional<SessionParticipant> findFirstBySessionIdAndPrincipalId(UUID sessionId, UUID principalId);

    /**
     * PLAN-0689 A2c: the roster rows of the given Sessions in one role.
     *
     * <p>This is the single read entry behind every principal that used to be read off the
     * {@code sessions.agent_principal_id} column — the chat views, the monitor aggregate, the
     * authorization path view and the {@code session_wakeup} gate all resolve the PRIMARY row via
     * {@link #primaryPrincipalId(UUID)} / {@link #primaryPrincipalIds(Collection)}. A Session with
     * no matching row is simply absent from the result; each call site owns the absence policy
     * (nullable display field vs fail-closed gate), so no exception is raised here.</p>
     */
    List<SessionParticipant> findBySessionIdInAndRoleOrderByOrderIndexAsc(Collection<UUID> sessionIds, String role);

    /** PLAN-0689 A2c: sessionId → PRIMARY principalId; Sessions without one are absent from the map. */
    default Map<UUID, UUID> primaryPrincipalIds(Collection<UUID> sessionIds) {
        if (sessionIds == null || sessionIds.isEmpty()) {
            return Map.of();
        }
        List<SessionParticipant> primaries =
                findBySessionIdInAndRoleOrderByOrderIndexAsc(sessionIds, SessionParticipant.ROLE_PRIMARY);
        Map<UUID, UUID> bySessionId = new HashMap<>();
        for (SessionParticipant participant : primaries) {
            UUID principalId = participant.getPrincipalId();
            if (principalId != null) {
                bySessionId.putIfAbsent(participant.getSessionId(), principalId);
            }
        }
        return bySessionId;
    }

    /**
     * PLAN-0689 A2c: the PRIMARY principal of one Session. Empty means "no PRIMARY row" (or a row
     * whose {@code principalId} is null — treated exactly like a missing row, never fabricated).
     */
    default Optional<UUID> primaryPrincipalId(UUID sessionId) {
        if (sessionId == null) {
            return Optional.empty();
        }
        return Optional.ofNullable(primaryPrincipalIds(List.of(sessionId)).get(sessionId));
    }
}
