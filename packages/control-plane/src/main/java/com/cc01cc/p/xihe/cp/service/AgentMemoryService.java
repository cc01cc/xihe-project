package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentMemory;
import com.cc01cc.p.xihe.cp.repository.AgentMemoryRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0629 M1 (V99): the memory write/read service — dedupe, soft delete and provenance.
 *
 * <p>Scope of this class: the durable rules only. There is <b>no</b> API and no UI yet (M1-3). Two
 * families of writers exist and they never share an entry point:</p>
 * <ul>
 *   <li>{@link #remember(MemoryWrite)} — the three <b>explicit</b> channels ({@code tool|ui|cli}), whose
 *       write takes effect immediately ({@code status=active});</li>
 *   <li>{@link #rememberPassive(PassiveWrite)} — the M1-6 <b>system-side</b> channels
 *       ({@code passive.summary|passive.judge}), which can only ever produce
 *       {@code status=candidate} (D29-26/27). A candidate is invisible to injection and listing until
 *       an explicit channel writes the same assertion, which is the only promotion path.</li>
 * </ul>
 * <p>There is deliberately still no "silently effective" auto write: D29-24 rejected writes that take
 * effect on their own, and the DB pairs {@code origin LIKE 'passive.%'} with {@code status='candidate'}
 * so neither service nor future caller can bypass the pairing.</p>
 *
 * <p>Three mechanical guarantees, in order of authority:</p>
 * <ol>
 *   <li><b>Database</b> (V99): {@code active ⇔ non-passive origin}, {@code pinned_by ∈ ui|cli},
 *       {@code pinned ⇒ active}, the dedupe unique index and the content bound;</li>
 *   <li><b>This service</b>: the explicit path refuses passive origins and the passive path refuses
 *       explicit ones, the tool channel can never pin, {@code content_sha256} is computed from the
 *       normalised text and never taken from a caller;</li>
 *   <li><b>API layer (M1-3)</b>: {@code MEMORY_WRITE} authorization + approval gate, and the
 *       {@code source_ref} injection (run id / user id / command digest).</li>
 * </ol>
 *
 * <p>Not done here on purpose: the principal/workspace existence checks and the authorization of the
 * actor. They belong to the API layer, which is the only place that knows "who is asking, and in which
 * run"; the FK constraints still make a dangling write fail loudly instead of silently succeeding.</p>
 *
 * <p>User ruling 2026-11-04 (V107): memory is <b>subject-scoped</b>. A {@code workspaceId} still travels
 * with every call, but only as the <b>authorization and audit context</b> ("which workspace's grant
 * allowed this call, and where the audit row is filed") — it is no longer part of any storage key.
 * Hence the parameter name {@code authzWorkspaceId}: reading it as "the memory's workspace" is exactly
 * the bug this ruling removed.</p>
 */
@Service
public class AgentMemoryService {

    /** Audited actions (durable, resource type {@code agent_memory}). */
    public static final String AUDIT_CREATED = "memory_created";
    public static final String AUDIT_DEDUPE_HIT = "memory_dedupe_hit";
    /** M1-6: the only candidate → active transition, and it is driven by an explicit channel. */
    public static final String AUDIT_PROMOTED = "memory_promoted";
    public static final String AUDIT_DELETED = "memory_deleted";
    /** PLAN-0629 M1-5: in-place edit of an already visible assertion (content and/or pin). */
    public static final String AUDIT_UPDATED = "memory_updated";
    public static final String RESOURCE_TYPE = "agent_memory";

    /** Only these channels may set {@code pinned} (an agent tool must never pin its own memory). */
    private static final List<String> PIN_CHANNELS =
            List.of(AgentMemory.ORIGIN_UI, AgentMemory.ORIGIN_CLI);

    private final AgentMemoryRepository memories;
    private final AuditLogger auditLogger;
    private final ObjectMapper objectMapper;

    public AgentMemoryService(AgentMemoryRepository memories, AuditLogger auditLogger,
                              ObjectMapper objectMapper) {
        this.memories = memories;
        this.auditLogger = auditLogger;
        this.objectMapper = objectMapper;
    }

    /**
     * One write from one channel.
     *
     * @param origin the channel that produced the write ({@code tool|ui|cli}); the service derives
     *     {@code status} from it and refuses the passive values in v1
     * @param sourceRef the channel's own provenance ({@code tool=runId}, {@code ui=userId},
     *     {@code cli=command digest}). The API layer must inject it — never take it from a request body,
     *     and never let a model supply it through tool arguments
     * @param pinned only honoured for the {@code ui}/{@code cli} channels
     * @param actorId the audit actor (the agent principal for {@code tool}, the user otherwise)
     * @param authzWorkspaceId the workspace whose grant authorized this write; audit and authorization
     *     context only — the row itself is subject-scoped (V107)
     */
    public record MemoryWrite(UUID principalId, UUID authzWorkspaceId, String content,
                              String origin, String sourceRef, boolean pinned, String actorId) {}

    /**
     * One write from a <b>system-side</b> (passive) producer, PLAN-0629 M1-6 / D29-26.
     *
     * @param origin {@code passive.summary} or {@code passive.judge} only; the explicit channels have
     *     their own entry point ({@link #remember(MemoryWrite)}) so a caller cannot pick a channel
     * @param sourceRef the natural idempotency key of the producer
     *     ({@code passive.<mode>:<sessionId>:<compaction cursor>})
     * @param actorId the durable audit actor — a <b>user</b> id (the session owner whose session produced
     *     the write), because {@code audit_logs.user_id} is a user foreign key. The subject is not the
     *     actor of a system-side write, and its id would not satisfy the FK.
     * @param authzWorkspaceId the workspace whose context produced the write; audit context only (V107)
     */
    public record PassiveWrite(UUID principalId, UUID authzWorkspaceId, String content,
                               String origin, String sourceRef, String actorId) {}

    /**
     * Stores (or dedupe-hits) one assertion.
     *
     * <p>Dedupe semantics (Lead ruling 2026-11-02): a hit only refreshes {@code updated_at}. The stored
     * {@code source_ref} and {@code created_at} keep the <b>original</b> provenance — the same content
     * hash means the assertion did not change, and rewriting its origin would lose the real source. The
     * hit itself is still recorded durably ({@code memory_dedupe_hit} with the hitting channel).</p>
     *
     * <p>PLAN-0629 M1-6 adds the one exception, and it is not a passive path: when the hit row is a
     * <b>candidate</b>, an explicit channel writing the same assertion <b>promotes</b> it (status →
     * active, origin/source_ref → the explicit channel, audited as {@code memory_promoted}). Leaving it
     * a candidate would make an explicit write silently ineffective — the caller would get success while
     * the assertion never becomes visible. The candidate → active transition therefore exists, and this
     * is the only place it happens.</p>
     */
    @Transactional
    public AgentMemory remember(MemoryWrite write) {
        Objects.requireNonNull(write, "write");
        requireAuthzContext(write.principalId(), write.authzWorkspaceId());
        String origin = requireV1Origin(write.origin());
        String sourceRef = requireSourceRef(write.sourceRef());
        boolean pinned = write.pinned();
        if (pinned && !PIN_CHANNELS.contains(origin)) {
            throw invalid("pinned memory can only be set by the ui or cli channel; "
                    + "the agent tool must not pin its own memory");
        }
        String normalized = AgentMemoryNormalizer.normalize(write.content());
        if (normalized.isEmpty()) {
            throw invalid("memory content must contain at least one visible character");
        }
        if (normalized.length() > AgentMemory.MAX_CONTENT_LENGTH) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "MEMORY_CONTENT_TOO_LONG",
                    "memory content must be at most " + AgentMemory.MAX_CONTENT_LENGTH
                            + " characters after normalisation");
        }
        String hash = AgentMemoryNormalizer.sha256Hex(normalized);

        Optional<AgentMemory> existing = memories
                .findByPrincipalIdAndContentSha256AndDeletedAtIsNull(write.principalId(), hash);
        if (existing.isPresent()) {
            AgentMemory row = existing.get();
            if (AgentMemory.STATUS_CANDIDATE.equals(row.getStatus())) {
                return promote(row, write, origin, sourceRef, normalized, pinned);
            }
            // Keep created_at and source_ref: the assertion did not change (see the method Javadoc).
            row.setUpdatedAt(Instant.now());
            AgentMemory saved = memories.saveAndFlush(row);
            audit(AUDIT_DEDUPE_HIT, saved, write.actorId(), write.authzWorkspaceId(), origin, sourceRef);
            return saved;
        }

        AgentMemory memory = new AgentMemory();
        memory.setPrincipalId(write.principalId());
        memory.setContent(normalized);
        memory.setContentSha256(hash);
        memory.setOrigin(origin);
        memory.setSourceRef(sourceRef);
        // v1 writes only active rows; the DDL pairs status with origin so a passive write cannot
        // masquerade as active later (D29-26/27 stays a candidate-only path).
        memory.setStatus(AgentMemory.STATUS_ACTIVE);
        memory.setPinned(pinned);
        if (pinned) {
            memory.setPinnedBy(origin);
        }
        AgentMemory saved = memories.saveAndFlush(memory);
        audit(AUDIT_CREATED, saved, write.actorId(), write.authzWorkspaceId(), origin, sourceRef);
        return saved;
    }

    /**
     * Stores one <b>passive</b> assertion, PLAN-0629 M1-6 / D29-26/27: always a
     * {@code status=candidate}, never pinned, never injected.
     *
     * <p>Three outcomes, and only the first two are normal:</p>
     * <ul>
     *   <li>no live row with this content ⇒ a candidate is written ({@code memory_created});</li>
     *   <li>a candidate with this content exists ⇒ dedupe hit ({@code updated_at} refreshed only);</li>
     *   <li>an <b>active</b> row with this content exists ⇒ {@link Optional#empty()}: the assertion is
     *       already in effect, and a passive path must not touch an active row (not even its
     *       {@code updated_at}, which would reorder injection behind the user's back). The caller logs
     *       this as {@code skipped}/{@code already_active}.</li>
     * </ul>
     *
     * <p>Idempotency of "one write per session end" is <b>not</b> this method's job — the natural key is
     * {@code source_ref}, which the producer owns (see {@link #passiveAlreadyWritten}). The dedupe probe
     * here is the D29-32 content rule and stays as the second line of defence.</p>
     */
    @Transactional
    public Optional<AgentMemory> rememberPassive(PassiveWrite write) {
        Objects.requireNonNull(write, "write");
        requireAuthzContext(write.principalId(), write.authzWorkspaceId());
        String origin = requirePassiveOrigin(write.origin());
        String sourceRef = requireSourceRef(write.sourceRef());
        String normalized = AgentMemoryNormalizer.normalize(write.content());
        if (normalized.isEmpty()) {
            throw invalid("memory content must contain at least one visible character");
        }
        if (normalized.length() > AgentMemory.MAX_CONTENT_LENGTH) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "MEMORY_CONTENT_TOO_LONG",
                    "memory content must be at most " + AgentMemory.MAX_CONTENT_LENGTH
                            + " characters after normalisation");
        }
        String hash = AgentMemoryNormalizer.sha256Hex(normalized);

        Optional<AgentMemory> existing = memories
                .findByPrincipalIdAndContentSha256AndDeletedAtIsNull(write.principalId(), hash);
        if (existing.isPresent()) {
            AgentMemory row = existing.get();
            if (AgentMemory.STATUS_ACTIVE.equals(row.getStatus())) {
                return Optional.empty();
            }
            row.setUpdatedAt(Instant.now());
            AgentMemory saved = memories.saveAndFlush(row);
            audit(AUDIT_DEDUPE_HIT, saved, write.actorId(), write.authzWorkspaceId(), origin, sourceRef);
            return Optional.of(saved);
        }

        AgentMemory memory = new AgentMemory();
        memory.setPrincipalId(write.principalId());
        memory.setContent(normalized);
        memory.setContentSha256(hash);
        memory.setOrigin(origin);
        memory.setSourceRef(sourceRef);
        // D29-26/27: the passive path can only ever produce a candidate. The DDL enforces the pairing
        // (a passive origin with status='active' is rejected), so this line cannot drift alone.
        memory.setStatus(AgentMemory.STATUS_CANDIDATE);
        memory.setPinned(false);
        AgentMemory saved = memories.saveAndFlush(memory);
        audit(AUDIT_CREATED, saved, write.actorId(), origin, sourceRef);
        return Optional.of(saved);
    }

    /**
     * Has this passive write already landed? The natural key is {@code source_ref}
     * ({@code passive.<mode>:<sessionId>:<compaction cursor>}), so one session end writes at most once
     * even if the summary text differs between attempts.
     */
    @Transactional(readOnly = true)
    public boolean passiveAlreadyWritten(UUID principalId, UUID workspaceId, String sourceRef) {
        requireScope(principalId, workspaceId);
        return memories.existsByPrincipalIdAndWorkspaceIdAndSourceRefAndDeletedAtIsNull(
                principalId, workspaceId, requireSourceRef(sourceRef));
    }

    /** The only candidate → active transition: an explicit channel wrote the same assertion. */
    private AgentMemory promote(AgentMemory row, MemoryWrite write, String origin, String sourceRef,
                                String normalized, boolean pinned) {
        row.setStatus(AgentMemory.STATUS_ACTIVE);
        row.setContent(normalized);
        // The explicit channel now owns the provenance: a passive origin may never carry 'active'
        // (V99 CHECK), and the user's write is what makes the assertion true from now on.
        row.setOrigin(origin);
        row.setSourceRef(sourceRef);
        row.setPinned(pinned);
        row.setPinnedBy(pinned ? origin : null);
        row.setUpdatedAt(Instant.now());
        AgentMemory saved = memories.saveAndFlush(row);
        audit(AUDIT_PROMOTED, saved, write.actorId(), origin, sourceRef);
        return saved;
    }

    /**
     * Soft-deletes one assertion ("forget"). The row stays for the audit trail, the dedupe key stops
     * matching ({@code WHERE deleted_at IS NULL}), so the same content may be written again later.
     *
     * @throws CpApiException 404 {@code MEMORY_NOT_FOUND} when the id does not belong to this
     *     {@code (principal, workspace)} pair — a foreign id must be indistinguishable from a missing one
     */
    @Transactional
    public void forget(UUID principalId, UUID workspaceId, UUID memoryId, String actorId) {
        requireScope(principalId, workspaceId);
        Objects.requireNonNull(memoryId, "memoryId");
        AgentMemory memory = memories
                .findByIdAndPrincipalIdAndWorkspaceIdAndDeletedAtIsNull(memoryId, principalId, workspaceId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "MEMORY_NOT_FOUND",
                        "Memory entry not found"));
        memory.setDeletedAt(Instant.now());
        AgentMemory saved = memories.saveAndFlush(memory);
        ObjectNode detail = objectMapper.createObjectNode();
        detail.put("contentSha256", saved.getContentSha256());
        auditLogger.recordDurableChange(actorId, workspaceId.toString(), AUDIT_DELETED, RESOURCE_TYPE,
                saved.getId().toString(), detail.toString());
    }

    /**
     * One in-place edit from the API layer, PLAN-0629 M1-5: change the content and/or the pin of an
     * already <b>visible</b> assertion.
     *
     * <p>Parameters are nullable on purpose — {@code PATCH} semantics: {@code null} means "leave it
     * alone", so pinning without retyping the content cannot accidentally rewrite the hash.</p>
     *
     * <p>Why this is not {@link #remember(MemoryWrite)} again: a re-write of changed content would
     * create a second row and leave the old assertion in effect (injection would carry both). The row
     * keeps its identity (id, {@code created_at}, {@code origin}/{@code source_ref} provenance) and
     * only the assertion text changes — the audit trail of every edit is a separate
     * {@code memory_updated} record keyed by the same id.</p>
     *
     * <p>Editable means <b>live and active</b>. A {@code candidate} is invisible to listing and
     * injection (D29-26/27), so addressing one by id answers the same 404 as a missing id — this
     * service offers no invisible write path, and promotion stays the explicit-channel rule from
     * {@link #remember(MemoryWrite)}.</p>
     *
     * @throws CpApiException 400 when nothing would change or the content is invalid after
     *     normalisation; 404 {@code MEMORY_NOT_FOUND} for a foreign/deleted/candidate id; 409
     *     {@code MEMORY_DUPLICATE} when an edit would collide with another live assertion of the same
     *     subject (the dedupe index would otherwise reject the save as a bare 500)
     */
    @Transactional
    public AgentMemory update(MemoryUpdate update) {
        Objects.requireNonNull(update, "update");
        requireScope(update.principalId(), update.workspaceId());
        Objects.requireNonNull(update.memoryId(), "memoryId");
        if (update.content() == null && update.pinned() == null) {
            throw invalid("memory update must change content, pinned, or both");
        }
        AgentMemory memory = requireEditable(update.principalId(), update.workspaceId(),
                update.memoryId());
        if (update.content() != null) {
            String normalized = AgentMemoryNormalizer.normalize(update.content());
            if (normalized.isEmpty()) {
                throw invalid("memory content must contain at least one visible character");
            }
            if (normalized.length() > AgentMemory.MAX_CONTENT_LENGTH) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "MEMORY_CONTENT_TOO_LONG",
                        "memory content must be at most " + AgentMemory.MAX_CONTENT_LENGTH
                                + " characters after normalisation");
            }
            String hash = AgentMemoryNormalizer.sha256Hex(normalized);
            if (!hash.equals(memory.getContentSha256())) {
                // Same rule as remember(): the dedupe key is (principal, workspace, content_sha256)
                // since V106 dropped the type column — one sentence is one assertion.
                Optional<AgentMemory> collision = memories
                        .findByPrincipalIdAndWorkspaceIdAndContentSha256AndDeletedAtIsNull(
                                update.principalId(), update.workspaceId(), hash);
                if (collision.isPresent() && !collision.get().getId().equals(memory.getId())) {
                    throw new CpApiException(HttpStatus.CONFLICT, "MEMORY_DUPLICATE",
                            "An identical memory assertion already exists for this agent");
                }
                memory.setContent(normalized);
                memory.setContentSha256(hash);
            }
        }
        if (update.pinned() != null) {
            memory.setPinned(update.pinned());
            // V99: pinned/pinned_by are true/false together and pinned_by may only be ui|cli.
            memory.setPinnedBy(update.pinned() ? AgentMemory.ORIGIN_UI : null);
        }
        AgentMemory saved = memories.saveAndFlush(memory);
        auditUpdate(saved, update.actorId());
        return saved;
    }

    /** One edit from one channel; both fields nullable so a pin flip cannot rewrite the content. */
    public record MemoryUpdate(UUID principalId, UUID workspaceId, UUID memoryId, String content,
                               Boolean pinned, String actorId) {}

    /** Live + active, or the same 404 a missing id gets. */
    private AgentMemory requireEditable(UUID principalId, UUID workspaceId, UUID memoryId) {
        AgentMemory memory = memories
                .findByIdAndPrincipalIdAndWorkspaceIdAndDeletedAtIsNull(memoryId, principalId, workspaceId)
                .orElseThrow(AgentMemoryService::memoryNotFound);
        if (!AgentMemory.STATUS_ACTIVE.equals(memory.getStatus())) {
            throw memoryNotFound();
        }
        return memory;
    }

    private static CpApiException memoryNotFound() {
        return new CpApiException(HttpStatus.NOT_FOUND, "MEMORY_NOT_FOUND", "Memory entry not found");
    }

    private void auditUpdate(AgentMemory memory, String actorId) {
        // Same rule as every other memory audit record: hash + routing facts, never the text.
        ObjectNode detail = objectMapper.createObjectNode();
        detail.put("contentSha256", memory.getContentSha256());
        detail.put("pinned", memory.isPinned());
        auditLogger.recordDurableChange(actorId, memory.getWorkspaceId().toString(), AUDIT_UPDATED,
                RESOURCE_TYPE, memory.getId().toString(), detail.toString());
    }

    /** D29-34 injection read: active, live rows of one subject in one workspace, pinned first. */
    @Transactional(readOnly = true)
    public List<AgentMemory> activeMemories(UUID principalId, UUID workspaceId) {
        requireScope(principalId, workspaceId);
        return memories
                .findByPrincipalIdAndWorkspaceIdAndStatusAndDeletedAtIsNullOrderByPinnedDescUpdatedAtDesc(
                        principalId, workspaceId, AgentMemory.STATUS_ACTIVE);
    }

    /**
     * The API read face (PLAN-0629 M1-4/M1-5), with the Lead's 2026-11-03 archive ruling baked in.
     *
     * <p>{@code includeArchived=false} is exactly {@link #activeMemories}: what is in effect right now.
     * {@code true} additionally returns the soft-deleted rows so the UI can show an "归档" view — the
     * row is not gone (audit keeps it) and the dedupe key is free, so "归档" and "删除" are different
     * promises and the wire must let the UI tell them apart ({@code archived}/{@code deletedAt}).</p>
     *
     * <p>Candidates are never listed in either mode: D29-26/27 makes them invisible until an explicit
     * channel promotes them, and a hidden-but-listed row would be a second, accidental write path.</p>
     */
    @Transactional(readOnly = true)
    public List<AgentMemory> listMemories(UUID principalId, UUID workspaceId, MemoryStatus status) {
        requireScope(principalId, workspaceId);
        List<AgentMemory> rows = status == MemoryStatus.ACTIVE
                ? memories.findByPrincipalIdAndWorkspaceIdAndStatusAndDeletedAtIsNullOrderByPinnedDescUpdatedAtDesc(
                        principalId, workspaceId, AgentMemory.STATUS_ACTIVE)
                : memories.findByPrincipalIdAndWorkspaceIdAndStatusOrderByPinnedDescUpdatedAtDesc(
                        principalId, workspaceId, AgentMemory.STATUS_ACTIVE);
        if (status == MemoryStatus.ALL) {
            return rows;
        }
        if (status == MemoryStatus.ACTIVE) {
            return rows;
        }
        // RETIRED: the archived (soft-deleted) rows only. Filtered here rather than in a third finder —
        // the result set is already bounded by (subject, workspace), and one predicate keeps the
        // "archived == deleted_at IS NOT NULL" rule in exactly one place.
        return rows.stream().filter(row -> row.getDeletedAt() != null).toList();
    }

    /**
     * The read face's status filter (Lead ruling 2026-11-03: "删除" is an archive, and a soft delete
     * without a way to read it back looks like data loss).
     *
     * <p>Deliberately not a new stored status: {@code retired} is the existing V99
     * {@code deleted_at IS NOT NULL}, and {@code all} means both. Candidates are excluded by every
     * mode — they are invisible until an explicit channel promotes them (D29-26/27).</p>
     */
    public enum MemoryStatus {
        ACTIVE, RETIRED, ALL
    }

    private void audit(String action, AgentMemory memory, String actorId, String origin,
                       String sourceRef) {
        // Never log the raw assertion: audit keeps the hash + the routing facts, matching the
        // project-wide rule that untrusted content does not enter durable audit records.
        ObjectNode detail = objectMapper.createObjectNode();
        detail.put("contentSha256", memory.getContentSha256());
        detail.put("origin", origin);
        detail.put("sourceRef", sourceRef);
        auditLogger.recordDurableChange(actorId, memory.getWorkspaceId().toString(), action,
                RESOURCE_TYPE, memory.getId().toString(), detail.toString());
    }

    private static void requireScope(UUID principalId, UUID workspaceId) {
        if (principalId == null || workspaceId == null) {
            throw invalid("memory is isolated by (principal, workspace); both ids are required");
        }
    }


    private static String requireV1Origin(String origin) {
        if (origin == null || !AgentMemory.V1_WRITE_ORIGINS.contains(origin)) {
            // The passive values exist in the DDL for D29-26/27, but they have their own entry point
            // (rememberPassive) so the explicit write path can never be used to land a candidate.
            throw invalid("memory origin must be one of " + AgentMemory.V1_WRITE_ORIGINS
                    + "; passive memory writes are not available in v1");
        }
        return origin;
    }

    private static String requirePassiveOrigin(String origin) {
        if (origin == null || !AgentMemory.PASSIVE_WRITE_ORIGINS.contains(origin)) {
            throw invalid("passive memory origin must be one of " + AgentMemory.PASSIVE_WRITE_ORIGINS
                    + "; explicit channels use the explicit write path");
        }
        return origin;
    }

    private static String requireSourceRef(String sourceRef) {
        if (sourceRef == null || sourceRef.isBlank()
                || sourceRef.length() > AgentMemory.MAX_SOURCE_REF_LENGTH) {
            throw invalid("memory sourceRef must be 1.." + AgentMemory.MAX_SOURCE_REF_LENGTH
                    + " characters and is injected by the write channel");
        }
        return sourceRef;
    }

    private static CpApiException invalid(String detail) {
        return new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", detail);
    }
}
