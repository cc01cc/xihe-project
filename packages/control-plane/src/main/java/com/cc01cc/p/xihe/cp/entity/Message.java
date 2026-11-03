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

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    /** V110: {@code user} (default, rendered in the conversation) or {@code internal} (pipeline only). */
    @Column(name = "visibility", nullable = false, length = 16)
    private String visibility = VISIBILITY_USER;

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

    public String getVisibility() { return visibility; }
    public void setVisibility(String visibility) { this.visibility = visibility; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}
