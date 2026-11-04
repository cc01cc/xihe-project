package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

/**
 * PLAN-0623 R7: the read pointer of one participant.
 *
 * <p>0623 is <b>read-only</b> here: the server advances the pointer off the event stream, the
 * client-side reporting lands in 0624 with notifications. A pointer (not a counter) is used so the
 * unread count can always be recomputed from {@code context_events}.</p>
 */
@Entity
@Table(name = "session_participant_cursors")
public class SessionParticipantCursor {

    @Id
    @Column(name = "participant_id", nullable = false, updatable = false)
    private UUID participantId;

    @Column(name = "last_read_event_seq", nullable = false)
    private Long lastReadEventSeq;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public SessionParticipantCursor() {}

    /** PLAN-0660 T5.3: the pointer is the whole row — unread is derived, never stored (D66-07 / B-4). */
    public SessionParticipantCursor(UUID participantId, Long lastReadEventSeq) {
        this.participantId = participantId;
        this.lastReadEventSeq = lastReadEventSeq;
    }

    @PrePersist
    @PreUpdate
    protected void touch() {
        updatedAt = Instant.now();
    }

    public UUID getParticipantId() { return participantId; }
    public void setParticipantId(UUID participantId) { this.participantId = participantId; }

    public Long getLastReadEventSeq() { return lastReadEventSeq; }
    public void setLastReadEventSeq(Long lastReadEventSeq) { this.lastReadEventSeq = lastReadEventSeq; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
