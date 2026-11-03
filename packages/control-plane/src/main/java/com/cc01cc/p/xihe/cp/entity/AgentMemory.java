package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * PLAN-0629 M1 (V99) + user ruling 2026-11-04 (V107): one durable memory assertion of an agent
 * subject.
 *
 * <p>Scoped to the <b>subject</b> ({@code principal_id}) only: the same agent principal shares one
 * memory set across every workspace it is bound to, so a memory can never leak to another principal
 * but is deliberately not partitioned per workspace. The workspace survives in the API as the
 * <b>authorization context</b> of a write/read request, never as a column here.</p>
 *
 * <p>Why this entity carries so many constants: the v1 vocabulary is frozen (D29-25 / D29-31..34) and
 * the database enforces it too (V99 CHECKs). Keeping the names here means the service, the tests and a
 * future API all cite one place instead of scattering string literals that could drift from the DDL.</p>
 *
 * <p>Not modelled on purpose: {@code content_sha256} is written by {@code AgentMemoryService} from
 * {@code AgentMemoryNormalizer} — no caller may supply it; {@code status} pairs mechanically with
 * {@code origin} (active ⇔ non-passive); {@code pinned_by} can only be {@code ui}/{@code cli}.</p>
 */
@Entity
@Table(name = "agent_memories")
public class AgentMemory {

    /**
     * The three v1 write channels. There is deliberately no {@code auto} value (D29-24).
     *
     * <p>PLAN-0629 M1-5 (user ruling 2026-11-03): the {@code profile}/{@code fact} classification is
     * gone — V106 drops the column, so a memory row is just an assertion. The type vocabulary below is
     * kept <b>only</b> for the frozen context-policy document ({@code memory.types}), which the
     * passive writer still consults; storage no longer has a type.</p>
     */
    public static final String ORIGIN_TOOL = "tool";
    public static final String ORIGIN_UI = "ui";
    public static final String ORIGIN_CLI = "cli";
    /** PLAN-0629 M1-6 (D29-26/27): the two system-side channels; they may only ever be candidates. */
    public static final String ORIGIN_PASSIVE_SUMMARY = "passive.summary";
    public static final String ORIGIN_PASSIVE_JUDGE = "passive.judge";
    public static final List<String> V1_WRITE_ORIGINS = List.of(ORIGIN_TOOL, ORIGIN_UI, ORIGIN_CLI);
    public static final List<String> PASSIVE_WRITE_ORIGINS =
            List.of(ORIGIN_PASSIVE_SUMMARY, ORIGIN_PASSIVE_JUDGE);

    public static final String STATUS_ACTIVE = "active";
    public static final String STATUS_CANDIDATE = "candidate";

    /** D29-33: bounded content (limits the injection surface and the token cost). */
    public static final int MAX_CONTENT_LENGTH = 8000;
    /** D29-19: the provenance reference (runId / userId / command digest). */
    public static final int MAX_SOURCE_REF_LENGTH = 256;

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "principal_id", nullable = false, columnDefinition = "uuid")
    private UUID principalId;

    /** Normalised content (single normalizer); the DDL enforces 1..8000 characters. */
    @Column(name = "content", nullable = false, columnDefinition = "TEXT")
    private String content;

    /** lowercase hex SHA-256 of the normalised content — server-computed, never from a client. */
    @Column(name = "content_sha256", nullable = false, length = 64)
    private String contentSha256;

    @Column(name = "origin", nullable = false, length = 32)
    private String origin;

    @Column(name = "source_ref", nullable = false, length = 256)
    private String sourceRef;

    @Column(name = "status", nullable = false, length = 16)
    private String status = STATUS_ACTIVE;

    @Column(name = "pinned", nullable = false)
    private boolean pinned;

    /** {@code ui} or {@code cli} only; null exactly when {@code pinned} is false (V99 CHECK). */
    @Column(name = "pinned_by", length = 16)
    private String pinnedBy;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    /** Soft delete (B1 ruling): "forget" hides the row, audit keeps the trace. */
    @Column(name = "deleted_at")
    private Instant deletedAt;

    public AgentMemory() {}

    @PrePersist
    protected void onCreate() {
        if (id == null) {
            id = UUID.randomUUID();
        }
        Instant now = Instant.now();
        if (createdAt == null) {
            createdAt = now;
        }
        if (updatedAt == null) {
            updatedAt = now;
        }
    }

    /** A dedupe hit only refreshes {@code updated_at}; provenance stays at the original write. */
    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }

    public UUID getPrincipalId() { return principalId; }
    public void setPrincipalId(UUID principalId) { this.principalId = principalId; }

    public String getContent() { return content; }
    public void setContent(String content) { this.content = content; }

    public String getContentSha256() { return contentSha256; }
    public void setContentSha256(String contentSha256) { this.contentSha256 = contentSha256; }

    public String getOrigin() { return origin; }
    public void setOrigin(String origin) { this.origin = origin; }

    public String getSourceRef() { return sourceRef; }
    public void setSourceRef(String sourceRef) { this.sourceRef = sourceRef; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public boolean isPinned() { return pinned; }
    public void setPinned(boolean pinned) { this.pinned = pinned; }

    public String getPinnedBy() { return pinnedBy; }
    public void setPinnedBy(String pinnedBy) { this.pinnedBy = pinnedBy; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }

    public Instant getDeletedAt() { return deletedAt; }
    public void setDeletedAt(Instant deletedAt) { this.deletedAt = deletedAt; }
}
