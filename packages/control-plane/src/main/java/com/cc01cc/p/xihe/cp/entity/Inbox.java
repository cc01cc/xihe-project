package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;

import java.time.Instant;
import java.util.UUID;

/**
 * PLAN-0407 T2.6b on the PLAN-0408 V45 schema: one durable child-terminal
 * notice row for a parent Session (spec/session/derived-collaboration-inbox.md).
 *
 * <p>Frozen shape (PLAN-0408 tasks T1.1): seven columns, fixed
 * {@code type='child_terminal'}, unique {@code (to_session_id, type, ref)},
 * {@code payload_pointer} whitelisted to {@code sessionId/runId/state}. The row
 * never references a child Session/ChatRun with a foreign key, so parent
 * deletion clears its own rows through the {@code to_session_id} cascade while
 * the child lifecycle stays independent. CHECKs and the cascade live in
 * {@code V45__inbox.sql}; PostgreSQL is the schema gate.
 */
@Entity
@Table(name = "inbox", uniqueConstraints = @UniqueConstraint(
        name = "uq_inbox_session_type_ref", columnNames = {"to_session_id", "type", "ref"}))
public class Inbox {

    public static final String TYPE_CHILD_TERMINAL = "child_terminal";

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "to_session_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String toSessionId;

    @Column(name = "type", nullable = false, length = 64)
    private String type;

    @Column(name = "ref", nullable = false, columnDefinition = "uuid")
    @Convert(converter = UuidStringConverter.class)
    private String ref;

    @Column(name = "payload_pointer", columnDefinition = "jsonb", nullable = false)
    @org.hibernate.annotations.JdbcTypeCode(org.hibernate.type.SqlTypes.JSON)
    private String payloadPointer;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "injected_run_id")
    @Convert(converter = UuidStringConverter.class)
    private String injectedRunId;

    public Inbox() {
    }

    public Inbox(UUID id, String toSessionId, String type, String ref, String payloadPointer) {
        this.id = id;
        this.toSessionId = toSessionId;
        this.type = type;
        this.ref = ref;
        this.payloadPointer = payloadPointer;
    }

    @PrePersist
    protected void onCreate() {
        createdAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }

    public String getToSessionId() { return toSessionId; }
    public void setToSessionId(String toSessionId) { this.toSessionId = toSessionId; }

    public String getType() { return type; }
    public void setType(String type) { this.type = type; }

    public String getRef() { return ref; }
    public void setRef(String ref) { this.ref = ref; }

    public String getPayloadPointer() { return payloadPointer; }
    public void setPayloadPointer(String payloadPointer) { this.payloadPointer = payloadPointer; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public String getInjectedRunId() { return injectedRunId; }
    public void setInjectedRunId(String injectedRunId) { this.injectedRunId = injectedRunId; }
}
