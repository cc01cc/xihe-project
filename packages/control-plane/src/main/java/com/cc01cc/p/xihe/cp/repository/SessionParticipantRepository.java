package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
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
}
