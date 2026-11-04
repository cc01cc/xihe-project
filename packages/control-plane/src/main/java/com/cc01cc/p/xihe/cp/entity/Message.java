package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "messages")
public class Message {

    /**
     * PLAN-0630 M5b / D3: the wake pipeline hands the woken agent its instruction through the Run's
     * user Message, which used to render in the conversation stream. {@code visibility} is the
     * explicit channel for that distinction — the alternative (marker prefixes on {@code content})
     * was rejected because every read path would have to re-parse untrusted text.
     */
    public static final String VISIBILITY_USER = "user";
    public static final String VISIBILITY_INTERNAL = "internal";

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "session_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String sessionId;

    @Column(name = "run_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String runId;

    /** PLAN-0410 T1.3: durable branch binding (V43 NOT NULL). */
    @Column(name = "branch_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String branchId;


    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private MessageRole role;

    @Column(columnDefinition = "TEXT", nullable = false)
    private String content;

    @Column(name = "attachments", columnDefinition = "TEXT")
    private String attachments;

    /** PLAN-0572 D1=A: bounded tool-call snapshot for this assistant Message (JSONB). */
    @Column(name = "tool_calls", columnDefinition = "jsonb")
    @org.hibernate.annotations.JdbcTypeCode(org.hibernate.type.SqlTypes.JSON)
    private String toolCalls;

    /**
     * PLAN-0665 D3 (V120): the composer's TO / CC audience for this user Message, as JSONB
     * ({@code {"to":[...],"cc":[...]}} of participant ids). Nullable — Messages written before V120
     * (and internal Wake prompts) simply have no delivery record. This is the durable carrier that
     * ends BL-239 (the audience used to live only in the client's local send-state).
     */
    @Column(name = "delivery", columnDefinition = "jsonb")
    @org.hibernate.annotations.JdbcTypeCode(org.hibernate.type.SqlTypes.JSON)
    private String delivery;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    /** V110: {@code user} (default, rendered in the conversation) or {@code internal} (pipeline only). */
    @Column(name = "visibility", nullable = false, length = 16)
    private String visibility = VISIBILITY_USER;

    /**
     * PLAN-0669 M1 (V121): durable actor attribution — the session participant that produced this
     * Message. Assistant rows carry the Run's responder participant (resolved once at the single
     * assistant-write point); user rows stay NULL in v1 because the composer's {@code asParticipantId}
     * is a target identity (PRIMARY is an AGENT participant), not the author. Rows written before
     * V121 also keep NULL: "no attribution" renders no badge, never "unknown" (DEV-032: no UUID on wire).
     */
    @Column(name = "participant_id", columnDefinition = "uuid")
    private UUID participantId;

    public Message() {}

    public Message(String sessionId, MessageRole role, String content) {
        this.sessionId = sessionId;
        this.role = role;
        this.content = content;
    }

    @PrePersist
    protected void onCreate() {
        createdAt = Instant.now();
        if (branchId == null || branchId.isBlank()) {
            branchId = RootBranchBinder.ensureRootBranchId(sessionId);
        }
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }

    public String getSessionId() { return sessionId; }
    public void setSessionId(String sessionId) { this.sessionId = sessionId; }

    public String getRunId() { return runId; }
    public void setRunId(String runId) { this.runId = runId; }

    public String getBranchId() { return branchId; }
    public void setBranchId(String branchId) { this.branchId = branchId; }


    public MessageRole getRole() { return role; }
    public void setRole(MessageRole role) { this.role = role; }

    public String getContent() { return content; }
    public void setContent(String content) { this.content = content; }

    public String getAttachments() { return attachments; }
    public void setAttachments(String attachments) { this.attachments = attachments; }

    public String getToolCalls() { return toolCalls; }
    public void setToolCalls(String toolCalls) { this.toolCalls = toolCalls; }

    public String getDelivery() { return delivery; }
    public void setDelivery(String delivery) { this.delivery = delivery; }

    /** PLAN-0669 M1: the participant that produced this Message; {@code null} = no attribution. */
    public UUID getParticipantId() { return participantId; }
    public void setParticipantId(UUID participantId) { this.participantId = participantId; }

    public String getVisibility() { return visibility; }
    public void setVisibility(String visibility) { this.visibility = visibility; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}
