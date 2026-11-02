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
 * <p>Scope of this class: the durable rules only. There is <b>no</b> API and no UI yet (M1-3), and
 * there is deliberately <b>no automatic write path</b> (D29-24 rejected "summarise on session end /
 * every N rounds"): the only callers are the three explicit channels, and each one hands over the
 * channel ({@code origin}) plus that channel's own provenance ({@code sourceRef}).</p>
 *
 * <p>Three mechanical guarantees, in order of authority:</p>
 * <ol>
 *   <li><b>Database</b> (V99): {@code active ⇔ non-passive origin}, {@code pinned_by ∈ ui|cli},
 *       {@code pinned ⇒ active}, the dedupe unique index and the content bound;</li>
 *   <li><b>This service</b>: v1 refuses passive origins entirely, refuses to let the tool channel pin,
 *       computes {@code content_sha256} from the normalised text and never takes a hash from a caller;</li>
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
     * Stores (or dedupe-hits) one assertion.
     *
     * <p>Dedupe semantics (Lead ruling 2026-11-02): a hit only refreshes {@code updated_at}. The stored
     * {@code source_ref} and {@code created_at} keep the <b>original</b> provenance — the same content
     * hash means the assertion did not change, and rewriting its origin would lose the real source. The
     * hit itself is still recorded durably ({@code memory_dedupe_hit} with the hitting channel).</p>
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
            // The passive values exist in the DDL for D29-26/27, but v1 has no passive producer.
            throw invalid("memory origin must be one of " + AgentMemory.V1_WRITE_ORIGINS
                    + "; passive memory writes are not available in v1");
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
