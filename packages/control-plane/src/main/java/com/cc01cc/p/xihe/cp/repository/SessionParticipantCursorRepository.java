package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.SessionParticipantCursor;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Collection;
import java.util.List;
import java.util.UUID;

public interface SessionParticipantCursorRepository
        extends JpaRepository<SessionParticipantCursor, UUID> {

    List<SessionParticipantCursor> findByParticipantIdIn(Collection<UUID> participantIds);
}
