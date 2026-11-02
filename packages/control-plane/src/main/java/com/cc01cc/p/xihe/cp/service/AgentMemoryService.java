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
 */
@Service
public class AgentMemoryService {

    /** Audited actions (durable, resource type {@code agent_memory}). */
    public static final String AUDIT_CREATED = "memory_created";
    public static final String AUDIT_DEDUPE_HIT = "memory_dedupe_hit";
    /** M1-6: the only candidate → active transition, and it is driven by an explicit channel. */
    public static final String AUDIT_PROMOTED = "memory_promoted";
    public static final String AUDIT_DELETED = "memory_deleted";
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
     */
    public record MemoryWrite(UUID principalId, UUID workspaceId, String type, String content,
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
     */
    public record PassiveWrite(UUID principalId, UUID workspaceId, String type, String content,
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
        requireScope(write.principalId(), write.workspaceId());
        String type = requireType(write.type());
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
                .findByPrincipalIdAndWorkspaceIdAndTypeAndContentSha256AndDeletedAtIsNull(
                        write.principalId(), write.workspaceId(), type, hash);
        if (existing.isPresent()) {
            AgentMemory row = existing.get();
            if (AgentMemory.STATUS_CANDIDATE.equals(row.getStatus())) {
                return promote(row, write, origin, sourceRef, normalized, pinned);
            }
            // Keep created_at and source_ref: the assertion did not change (see the method Javadoc).
            row.setUpdatedAt(Instant.now());
            AgentMemory saved = memories.saveAndFlush(row);
            audit(AUDIT_DEDUPE_HIT, saved, write.actorId(), origin, sourceRef);
            return saved;
        }

        AgentMemory memory = new AgentMemory();
        memory.setPrincipalId(write.principalId());
        memory.setWorkspaceId(write.workspaceId());
        memory.setType(type);
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
        audit(AUDIT_CREATED, saved, write.actorId(), origin, sourceRef);
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
        requireScope(write.principalId(), write.workspaceId());
        String type = requireType(write.type());
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
                .findByPrincipalIdAndWorkspaceIdAndTypeAndContentSha256AndDeletedAtIsNull(
                        write.principalId(), write.workspaceId(), type, hash);
        if (existing.isPresent()) {
            AgentMemory row = existing.get();
            if (AgentMemory.STATUS_ACTIVE.equals(row.getStatus())) {
                return Optional.empty();
            }
            row.setUpdatedAt(Instant.now());
            AgentMemory saved = memories.saveAndFlush(row);
            audit(AUDIT_DEDUPE_HIT, saved, write.actorId(), origin, sourceRef);
            return Optional.of(saved);
        }

        AgentMemory memory = new AgentMemory();
        memory.setPrincipalId(write.principalId());
        memory.setWorkspaceId(write.workspaceId());
        memory.setType(type);
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
        detail.put("type", saved.getType());
        auditLogger.recordDurableChange(actorId, workspaceId.toString(), AUDIT_DELETED, RESOURCE_TYPE,
                saved.getId().toString(), detail.toString());
    }

    /** D29-34 injection read: active, live rows of one subject in one workspace, pinned first. */
    @Transactional(readOnly = true)
    public List<AgentMemory> activeMemories(UUID principalId, UUID workspaceId) {
        requireScope(principalId, workspaceId);
        return memories
                .findByPrincipalIdAndWorkspaceIdAndStatusAndDeletedAtIsNullOrderByPinnedDescUpdatedAtDesc(
                        principalId, workspaceId, AgentMemory.STATUS_ACTIVE);
    }

    private void audit(String action, AgentMemory memory, String actorId, String origin,
                       String sourceRef) {
        // Never log the raw assertion: audit keeps the hash + the routing facts, matching the
        // project-wide rule that untrusted content does not enter durable audit records.
        ObjectNode detail = objectMapper.createObjectNode();
        detail.put("contentSha256", memory.getContentSha256());
        detail.put("type", memory.getType());
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

    private static String requireType(String type) {
        if (type == null || !AgentMemory.TYPES.contains(type)) {
            throw invalid("memory type must be one of " + AgentMemory.TYPES);
        }
        return type;
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
