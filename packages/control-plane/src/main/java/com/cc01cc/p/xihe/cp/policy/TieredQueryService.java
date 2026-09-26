package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/**
 * Tier-1 / Tier-2 query kernel (PLAN-0407 T3.1, spec §5, design #2/#5 [d2] evaluation-kernel
 * uniqueness — PLAN-0408 tools reuse this API instead of building a second one).
 *
 * <p><b>Tier-1</b> — status metadata {@code {sessionId, runId, state, at}} with no content fields:
 * reachable strictly <b>downward</b> along the provenance chain (the requester session is the
 * target itself or one of its ancestors) inside the same workspace, <b>without any grant check</b>
 * — a parent seeing child real-time status is the legitimate use of the reference edge
 * (design #2). Reverse (target is an ancestor of the requester), out-of-chain, cross-workspace,
 * dangling and cyclic provenance all fail closed with 403.</p>
 *
 * <p><b>Tier-2</b> — content access decision: the same chain rules apply first, then the single
 * authorization kernel {@link GrantAuthorizationService#allows} must allow reading the target
 * session's content (principal grants ∩ binding cap ∩ session caps). Without an explicit grant
 * the answer is 403. Workspace-file content is not served through this API — it keeps flowing
 * through the existing workspace file channel (spec §5 "或走 workspace 文件").</p>
 *
 * <p>Callers authenticate with the internal service Bearer ({@code /internal/v1/**}); the
 * requester/target session IDs are supplied by the caller's own principal resolution — this
 * service never trusts a request-body identity for authorization beyond those IDs.</p>
 */
@Service
public class TieredQueryService {

    private static final String TOOL_SESSION_CONTENT = "session_content_read";

    private final SessionRepository sessionRepository;
    private final ChatRunRepository chatRunRepository;
    private final GrantAuthorizationService grantAuthorizationService;

    public TieredQueryService(SessionRepository sessionRepository,
                              ChatRunRepository chatRunRepository,
                              GrantAuthorizationService grantAuthorizationService) {
        this.sessionRepository = sessionRepository;
        this.chatRunRepository = chatRunRepository;
        this.grantAuthorizationService = grantAuthorizationService;
    }

    /** Tier-1 response — exactly the spec §5 field set, never any content field. */
    public record Tier1Status(String sessionId, String runId, String state, Instant at) {}

    /** Tier-2 response — a decision only; content is read by the caller's own channel. */
    public record Tier2Access(boolean allowed) {}

    public Tier1Status tier1Status(String requesterSessionId, String targetSessionId) {
        Session requester = requireSession(requesterSessionId, "requesterSessionId");
        Session target = requireSession(targetSessionId, "targetSessionId");
        requireDownwardChain(requester, target);
        ChatRun run = chatRunRepository
                .findFirstBySessionIdOrderByCreatedAtDescIdDesc(target.getId().toString())
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "NOT_FOUND",
                        "Target session has no run"));
        Instant at = run.getUpdatedAt() != null ? run.getUpdatedAt() : run.getCreatedAt();
        return new Tier1Status(target.getId().toString(), run.getId().toString(), run.getStatus(), at);
    }

    public Tier2Access tier2Access(String requesterSessionId, String targetSessionId) {
        Session requester = requireSession(requesterSessionId, "requesterSessionId");
        Session target = requireSession(targetSessionId, "targetSessionId");
        requireDownwardChain(requester, target);
        PolicyRequest request = new PolicyRequest(
                TOOL_SESSION_CONTENT,
                List.of(ToolFaceRegistry.ACTION_READ),
                List.of(target.getId().toString()),
                ToolShape.STRUCTURED,
                requester.getUserId(),
                requester.getWorkspaceId(),
                requester.getId().toString());
        if (!grantAuthorizationService.allows(request)) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "Tier-2 content read requires an explicit grant");
        }
        return new Tier2Access(true);
    }

    private Session requireSession(String rawId, String parameter) {
        UUID id;
        try {
            id = UUID.fromString(rawId);
        } catch (RuntimeException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    parameter + " must be a UUID");
        }
        return sessionRepository.findById(id).orElseThrow(() -> new CpApiException(
                HttpStatus.NOT_FOUND, "NOT_FOUND", "Session not found"));
    }

    /**
     * Walks the target's provenance upward looking for the requester: reaching the requester means
     * the target is the requester itself or a descendant (single downward direction). Reaching a
     * root without finding it, a workspace mismatch, a dangling/cyclic/malformed lineage and any
     * other inconsistency deny fail-closed (403), mirroring the strictness of
     * {@link GrantPrincipalPathResolver}.
     */
    private void requireDownwardChain(Session requester, Session target) {
        if (!Objects.equals(requester.getWorkspaceId(), target.getWorkspaceId())) {
            throw chainDenied("cross-workspace query");
        }
        Set<UUID> visited = new HashSet<>();
        Session cursor = target;
        while (true) {
            if (cursor.getId().equals(requester.getId())) {
                return;
            }
            if (!visited.add(cursor.getId())) {
                throw chainDenied("cyclic provenance");
            }
            UUID parentId = cursor.getSpawnedFromSessionId();
            UUID parentRunId = cursor.getSpawnedFromRunId();
            Instant spawnedAt = cursor.getSpawnedAt();
            String kind = cursor.getKind();
            boolean hasParentInfo = parentId != null || parentRunId != null || spawnedAt != null;
            if (kind == null && !hasParentInfo) {
                throw chainDenied("target is not on the requester's chain");
            }
            if (kind == null) {
                throw chainDenied("malformed provenance");
            }
            if (!Session.KIND_SPAWN.equals(kind) && !Session.KIND_FORK.equals(kind)) {
                throw chainDenied("malformed provenance kind");
            }
            if (parentId == null || parentRunId == null || spawnedAt == null) {
                throw chainDenied("incomplete provenance");
            }
            cursor = sessionRepository.findById(parentId).orElseThrow(
                    () -> chainDenied("dangling provenance"));
        }
    }

    private static CpApiException chainDenied(String reason) {
        return new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                "Tiered query chain access denied: " + reason);
    }
}
